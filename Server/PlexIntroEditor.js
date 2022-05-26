/** External dependencies */
import { promises as Fs } from 'fs';
import { createServer } from 'http';
import { lookup } from 'mime-types';
import Open from 'open';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzip } from 'zlib';

/** Server dependencies */
import MarkerBackupManager from './MarkerBackupManager.js';
import MarkerCacheManager from './MarkerCacheManager.js';
import PlexIntroEditorConfig from './PlexIntroEditorConfig.js';
import PlexQueryManager from './PlexQueryManager.js';
import { QueryParser, QueryParserException } from './QueryParse.js';
import ThumbnailManager from './ThumbnailManager.js';
/** @typedef {!import('./CreateDatabase.cjs').SqliteDatabase} SqliteDatabase */

/** Server+Client shared dependencies */
import { Log, ConsoleLog } from './../Shared/ConsoleLog.js';
import { MarkerData, ShowData, SeasonData, EpisodeData } from './../Shared/PlexTypes.js';


/**
 * User configuration.
 * @type {PlexIntroEditorConfig} */
let Config;

/**
 * Manages retrieving preview thumbnails for episodes.
 * @type {ThumbnailManager}
 */
let Thumbnails;

/**
 * Manages basic marker information for the entire database.
 * @type {MarkerCacheManager}
 */
let MarkerCache = null;

/**
 * Manages executing queries to the Plex database.
 * @type {PlexQueryManager}
 */
let QueryManager;

/**
 * Records marker actions in a database to be restored if Plex removes them, or reverted
 * if changes in Plex's marker schema causes these markers to break the database.
 * @type {MarkerBackupManager} */
let BackupManager;

/** The root of the project, which is one directory up from the 'Server' folder we're currently in. */
const ProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Initializes and starts the server */
function run() {
    setupTerminateHandlers();
    Config = new PlexIntroEditorConfig(ProjectRoot);
    Log.info(`Verifying database '${Config.databasePath()}'...`);

    // Set up the database, and make sure it's the right one.
    QueryManager = new PlexQueryManager(Config.databasePath(), () => {
        Log.info('Database Verified.');
        if (Config.backupActions()) {
            Log.info('Initializing marker backup database...');
            BackupManager = new MarkerBackupManager(QueryManager, ProjectRoot, afterQueryInit);
        } else {
            Log.warn('Marker backup not enabled. Any changes removed by Plex will not be recoverable.');
            afterQueryInit();
        }
    });
}

/** Called after the query manager (and optionally the marker recorder) is initialized. */
function afterQueryInit() {
    Thumbnails = new ThumbnailManager(QueryManager.database(), Config.metadataPath());
    if (Config.extendedMarkerStats()) {
        MarkerCache = new MarkerCacheManager(QueryManager.database(), QueryManager.markerTagId());
        MarkerCache.buildCache(afterMarkerCacheManagerInit, (message) => {
            Log.error(message, 'Failed to build marker cache:');
            Log.error('Continuing to server creating, but extended marker statistics will not be available.');
            Config.disableExtendedMarkerStats();
            MarkerCache = null;
            launchServer();
        });
    } else {
        // If extended marker stats aren't enabled, just create the server now.
        Log.info('Creating server...');
        launchServer();
    }
}

/** Called after the marker cache manager is initialized and checks for purged markers if the backup manager is enabled. */
function afterMarkerCacheManagerInit() {
    if (Config.backupActions()) {
        BackupManager.buildAllPurges(MarkerCache, (err) => {
            if (err) {
                Log.error(err); // Log this, but don't fail. Maybe it will work next time.
            } else {
                Log.info(`Looked for purged markers, found ${BackupManager.purgeCount()}`);
            }

            launchServer();
        });
    } else {
        launchServer();
    }
}

export default run;

/** Set up process listeners that will shut down the process
 * when it encounters an unhandled exception or SIGINT. */
function setupTerminateHandlers() {

    // If we encounter an unhandled exception, handle it somewhat gracefully and exit the process.
    process.on('uncaughtException', (err) => {
        Log.critical(err.message);
        Log.verbose(err.stack ? err.stack : '(Could not find stack trace)');
        Log.error('The server ran into an unexpected problem, exiting...');
        QueryManager?.close();
        BackupManager?.close();
        process.exit(1);
    });

    // Capture Ctrl+C and cleanly exit the process
    process.on('SIGINT', () => {
        Log.info('SIGINT detected, exiting...');
        QueryManager?.close();
        BackupManager?.close();
        process.exit(0);
    });
}

/** Creates the server. Called after verifying the config file and database. */
function launchServer() {
    const server = createServer(serverMain);

    server.listen(Config.port(), Config.host(), () => {
        const url = `http://${Config.host()}:${Config.port()}`;
        Log.info(`Server running at ${url} (Ctrl+C to exit)`);
        if (Config.autoOpen()) {
            Log.info('Launching browser...');
            Open(url);
        }
    });
}

/**
 * Entrypoint for incoming connections to the server.
 * @type {Http.RequestListener}
 */
function serverMain(req, res) {
    Log.verbose(`(${req.socket.remoteAddress || 'UNKNOWN'}) ${req.method}: ${req.url}`);
    const method = req.method?.toLowerCase();

    // Don't get into node_modules or parent directories
    if (req.url.toLowerCase().indexOf('node_modules') != -1 || req.url.indexOf('/..') != -1) {
        return jsonError(res, 403, `Cannot access ${req.url}: Forbidden`);
    }

    try {
        // Only serve static resources via GET, and only accept queries for JSON via POST.
        switch (method) {
            case 'get':
                return handleGet(req, res);
            case 'post':
                return handlePost(req, res);
            default:
                return jsonError(res, 405, `Unexpected method "${req.method?.toUpperCase()}"`);
        }
    } catch (e) {
        // Something's gone horribly wrong
        Log.error(e.toString(), `Exception thrown for ${req.url}`);
        Log.verbose(e.stack || '(Unable to get stack trace)');
        return jsonError(res, 500, `The server was unable to process this request: ${e.toString()}`);
    }
}

/**
 * Handle GET requests, used to serve static content like HTML/CSS/SVG.
 * @param {Http.IncomingMessage} req
 * @param {Http.ServerResponse} res
 */
function handleGet(req, res) {
    let url = req.url;
    if (url == '/') {
        url = '/index.html';
    }

    if (url.startsWith('/i/')) {
        return getSvgIcon(url, res);
    } else if (url.startsWith('/t/')) {
        return getThumbnail(url, res);
    }

    let mimetype = lookup(url);
    if (!mimetype) {
        res.statusCode = 404;
        res.end('Bad MIME type!');
        return;
    }

    Fs.readFile(ProjectRoot + url).then(contents => {
        returnCompressedData(res, 200, contents, mimetype);
    }).catch(err => {
        Log.warn(`Unable to serve ${url}: ${err.message}`);
        res.statusCode = 404;
        res.end('Not Found: ' + err.code);
    });
}

/**
 * Retrieve an SVG icon requested with the given color.
 * @param {string} url The svg url of the form /i/[hex color]/[icon].svg.
 * @param {Http.ServerResponse} res
 */
function getSvgIcon(url, res) {
    let parts = url.split('/');
    if (parts.length !== 4) {
        return jsonError(res, 400, 'Invalid icon request.');
    }

    const color = parts[2];
    const icon = parts[3];

    // Expecting a 3 or 6 character hex string
    if (!/^[a-fA-F0-9]{3}$/.test(color) && !/^[a-fA-F0-9]{6}$/.test(color)) {
        return jsonError(res, 400, 'Invalid icon color.');
    }

    Fs.readFile(ProjectRoot + '/SVG/' + icon).then(contents => {
        // Raw file has FILL_COLOR in place of hardcoded values. Replace
        // it with the requested hex color (after decoding the contents)
        if (Buffer.isBuffer(contents)) {
            contents = contents.toString('utf-8');
        }

        // Could send this back compressed, but most of these are so small
        // that it doesn't make a tangible difference.
        contents = contents.replace(/FILL_COLOR/g, `#${color}`);
        res.setHeader('Content-Type', 'image/svg+xml; charset=UTF-8');
        res.end(Buffer.from(contents, 'utf-8'));
    }).catch(err => {
        Log.error(err, 'Failed to read icon');
        res.statusCode = 404;
        res.end('Not Found: ' + err.code);
    })
}

/** Convert a comma separated string into an array of integers */
const splitKeys = keys => keys.split(',').map(key => parseInt(key));
/** @typedef {(params: QueryParser, res: Http.ServerResponse) => void} EndpointForwardingFunction */

/**
 * Map endpoints to their corresponding functions. Also breaks out and validates expected query parameters.
 * @type {{[endpoint: string]: EndpointForwardingFunction}}
 */
const EndpointMap = {
    query        : (params, res) => queryIds(params.custom('keys', splitKeys), res),
    edit         : (params, res) => editMarker(...params.ints('id', 'start', 'end', 'userCreated'), res),
    add          : (params, res) => addMarker(...params.ints('metadataId', 'start', 'end'), res),
    delete       : (params, res) => deleteMarker(params.i('id'), res),
    get_sections : (_     , res) => getLibraries(res),
    get_section  : (params, res) => getShows(params.i('id'), res),
    get_seasons  : (params, res) => getSeasons(params.i('id'), res),
    get_episodes : (params, res) => getEpisodes(params.i('id'), res),
    get_stats    : (params, res) => allStats(params.i('id'), res),
    get_config   : (_     , res) => getConfig(res),
    log_settings : (params, res) => setLogSettings(...params.ints('level', 'dark', 'trace'), res),
    purge_check  : (params, res) => purgeCheck(params.i('id'), res),
    all_purges   : (params, res) => allPurges(params.i('sectionId'), res),
    restore      : (params, res) => restoreMarker(...params.ints('markerId', 'sectionId'), res),
    ignore_purge : (params, res) => ignorePurgedMarker(...params.ints('markerId', 'sectionId'), res),
};

/**
 * Handle POST requests, used to return JSON data queried by the client.
 * @param {Http.IncomingMessage} req
 * @param {Http.ServerResponse} res
 */
function handlePost(req, res) {
    const url = req.url.toLowerCase();
    const endpointIndex = url.indexOf('?');
    const endpoint = endpointIndex == -1 ? url.substring(1) : url.substring(1, endpointIndex);
    const parameters = new QueryParser(req);
    if (EndpointMap[endpoint]) {
        try {
            return EndpointMap[endpoint](parameters, res);
        } catch (ex) {
            // Capture QueryParserException and overwrite the 500 error we would otherwise return with 400
            if (ex instanceof QueryParserException) {
                return jsonError(res, 400, ex.message);
            }

            throw ex;
        }
    }

    return jsonError(res, 404, `Invalid endpoint: ${endpoint}`);
}

/**
 * Helper method that returns the given HTTP status code alongside a JSON object with a single 'Error' field.
 * @param {Http.ServerResponse} res
 * @param {number} code HTTP status code.
 * @param {string} error Error message.
 */
function jsonError(res, code, error) {
    Log.error(error, 'Unable to complete request');
    returnCompressedData(res, code, JSON.stringify({ Error : error }), 'application/json');
}

/**
 * Helper method that returns a success HTTP status code alongside any data we want to return to the client.
 * @param {Http.ServerResponse} res
 * @param {Object} [data] Data to return to the client. If empty, returns a simple success message.
 */
function jsonSuccess(res, data) {
    // TMI logging, post the entire response, for verbose just indicate we succeeded.
    if (Log.getLevel() <= ConsoleLog.Level.Tmi) {
        Log.tmi(data ? JSON.stringify(data) : 'true', 'Success');
    } else {
        Log.verbose(true, 'Success')
    }

    returnCompressedData(res, 200, JSON.stringify(data || { success : true }), 'application/json');
}

/**
 * Attempt to send gzip compressed data to reduce network traffic, falling back to plain text on failure.
 * @param {Http.ServerResponse} res
 * @param {number} status HTTP status code.
 * @param {*} data The data to compress and return.
 * @param {string} contentType The MIME type of `data`.
 */
function returnCompressedData(res, status, data, contentType) {
    gzip(data, (err, buffer) => {
        if (err) {
            Log.warn('Failed to compress data, sending uncompressed');
            res.writeHead(status, { 'Content-Type' : contentType });
            res.end(data);
            return;
        }

        res.writeHead(status, {
            'Content-Encoding' : 'gzip',
            'Content-Type' : contentType
        });

        res.end(buffer);
    })
}

/**
 * Retrieve an array of markers for all requested metadata ids.
 * @param {number[]} keys The metadata ids to lookup.
 * @param {Http.ServerResponse} res
 */
function queryIds(keys, res) {
    let markers = {};
    keys.forEach(key => {
        markers[key] = [];
    });

    QueryManager.getMarkersForEpisodes(keys, (err, rows) => {
        if (err) {
            Log.error(err);
            return jsonError(res, 400, 'Unable to retrieve ids');
        }

        rows.forEach(row => {
            markers[row.episode_id].push(new MarkerData(row));
        });

        return jsonSuccess(res, markers);
    });
}

/**
 * Edit an existing marker, and update index order as needed.
 * @param {number} markerId The id of the marker to edit.
 * @param {number} startMs The start time of the marker, in milliseconds.
 * @param {number} endMs The end time of the marker, in milliseconds.
 * @param {Http.ServerResponse} res
 */
function editMarker(markerId, startMs, endMs, userCreated, res) {
    QueryManager.getSingleMarker(markerId, (err, currentMarker) => {
        if (err || !currentMarker) {
            return jsonError(res, 400, err || 'Intro marker not found');
        }

        const oldIndex = currentMarker.index;

        // Get all markers to adjust indexes if necessary
        QueryManager.getEpisodeMarkers(currentMarker.episode_id, (err, rows) => {
            if (err) {
                return jsonError(res, 400, err);
            }

            Log.verbose(`Markers for this episode: ${rows.length}`);

            let allMarkers = rows;
            allMarkers[oldIndex].start = startMs;
            allMarkers[oldIndex].end = endMs;
            allMarkers.sort((a, b) => a.start - b.start);
            let newIndex = 0;

            for (let index = 0; index < allMarkers.length; ++index) {
                let marker = allMarkers[index];
                if (marker.end >= startMs && marker.start <= endMs && marker.id != markerId) {
                    // Overlap, this should be handled client-side
                    return jsonError(res, 400, 'Overlapping markers. The existing marker should be expanded to include this range instead.');
                }

                if (marker.id == markerId) {
                    newIndex = index;
                }

                marker.newIndex = index;
            }

            QueryManager.editMarker(markerId, newIndex, startMs, endMs, userCreated, (err) => {
                if (err) {
                    return jsonError(res, 400, err);
                }

                for (const marker of allMarkers) {
                    if (marker.index != marker.newIndex) {
                        QueryManager.updateMarkerIndex(marker.id, marker.newIndex);
                    }
                }

                const newMarker = new MarkerData(currentMarker);
                const oldStart = newMarker.start;
                const oldEnd = newMarker.end;
                newMarker.start = startMs;
                newMarker.end = endMs;
                BackupManager?.recordEdit(newMarker, oldStart, oldEnd);
                return jsonSuccess(res, { episodeId : currentMarker.episode_id, id : markerId, start : startMs, end : endMs, index : newIndex });
            });

        });
    });
}

/**
 * Adds the given marker to the database, rearranging indexes as necessary.
 * @param {number} metadataId The metadata id of the episode to add a marker to.
 * @param {number} startMs The start time of the marker, in milliseconds.
 * @param {number} endMs The end time of the marker, in milliseconds.
 * @param {Http.ServerResponse} res
 */
function addMarker(metadataId, startMs, endMs, res) {
    if (startMs >= endMs) {
        return jsonError(res, 400, "Start time must be less than end time.");
    }

    const successFunc = (allMarkers, newMarker) => {
        const markerData = new MarkerData(newMarker);
        updateMarkerBreakdownCache(markerData, allMarkers.length - 1, 1 /*delta*/);
        MarkerCache?.addMarkerToCache(newMarker);
        BackupManager?.recordAdd(markerData);
        jsonSuccess(res, markerData);
    };

    const failureFunc = (userError, message) => {
        return jsonError(res, userError ? 400 : 500, message);
    };

    QueryManager.addMarker(metadataId, startMs, endMs, successFunc, failureFunc);
}

/**
 * Removes the given marker from the database, rearranging indexes as necessary.
 * @param {number} markerId The marker id to remove from the database.
 * @param {Http.ServerResponse} res
 */
function deleteMarker(markerId, res) {
    QueryManager.getSingleMarker(markerId, (err, markerToDelete) => {
        if (err || !markerToDelete) {
            Log.error(err.message, `Failed to get marker to delete`);
            return jsonError(res, 500, "Error getting intro marker.");
        }

        if (!markerToDelete) {
            return jsonError(res, 400, "Could not find intro marker");
        }

        QueryManager.getEpisodeMarkers(markerToDelete.episode_id, (err, allMarkers) => {
            if (err) {
                return jsonError(res, 400, "Could not retrieve intro markers for possible rearrangement");
            }

            let deleteIndex = 0;
            for (const marker of allMarkers) {
                if (marker.id == markerId) {
                    deleteIndex = marker.index;
                }
            }

            // Now that we're done rearranging, delete the original tag.
            QueryManager.deleteMarker(markerId, (err) => {
                if (err) {
                    return jsonError(res, 500, 'Failed to delete intro marker');
                }

                // If deletion was successful, now we can check to see whether we need to rearrange indexes to keep things contiguous
                if (deleteIndex < allMarkers.length - 1) {

                    // Fire and forget, hopefully it worked, but it _shouldn't_ be the end of the world if it doesn't.
                    for (const marker of allMarkers) {
                        if (marker.index > deleteIndex) {
                            QueryManager.updateMarkerIndex(marker.id, marker.index - 1);
                        }
                    }
                }

                const deletedMarker = new MarkerData(markerToDelete);
                MarkerCache?.removeMarkerFromCache(markerId);
                updateMarkerBreakdownCache(deletedMarker, allMarkers.length, -1 /*delta*/);
                BackupManager?.recordDelete(deletedMarker);
                return jsonSuccess(res, deletedMarker);
            });
        });
    });
}

/**
 * Retrieve all TV libraries found in the database.
 * @param {Http.ServerResponse} res
 */
function getLibraries(res) {
    QueryManager.getShowLibraries((err, rows) => {
        if (err) {
            return jsonError(res, 400, "Could not retrieve library sections.");
        }

        let libraries = [];
        for (const row of rows) {
            libraries.push({ id : row.id, name : row.name });
        }

        return jsonSuccess(res, libraries);
    });
}

/**
 * Retrieve all shows from the given library section.
 * @param {number} sectionId The section id of the library.
 * @param {Http.ServerResponse} res
 */
function getShows(sectionId, res) {
    QueryManager.getShows(sectionId, (err, rows) => {
        if (err) {
            return jsonError(res, 400, `Could not retrieve shows from the database: ${err.message}`);
        }

        let shows = [];
        for (const show of rows) {
            show.markerBreakdown = MarkerCache?.getShowStats(show.id);
            shows.push(new ShowData(show));
        }

        return jsonSuccess(res, shows);
    });
}

/**
 * Retrieve all seasons for the show specified by the given metadataId.
 * @param {number} metadataId The metadata id of the a series.
 * @param {Http.ServerResponse} res
 */
function getSeasons(metadataId, res) {
    QueryManager.getSeasons(metadataId, (err, rows) => {
        if (err) {
            return jsonError(res, 400, "Could not retrieve seasons from the database.");
        }

        let seasons = [];
        for (const season of rows) {
            season.markerBreakdown = MarkerCache?.getSeasonStats(metadataId, season.id);
            seasons.push(new SeasonData(season));
        }

        return jsonSuccess(res, seasons);
    })
}

/**
 * Retrieve all episodes for the season specified by the given metadataId.
 * @param {number} metadataId The metadata id for the season of a show.
 * @param {Http.ServerResponse} res
 */
function getEpisodes(metadataId, res) {
    QueryManager.getEpisodes(metadataId, (err, rows) => {
        if (err) {
            return jsonError(res, 400, "Could not retrieve episodes from the database.");
        }

        // There's definitely a better way to do this, but determining whether an episode
        // has thumbnails attached is asynchronous, so keep track of how many results have
        // come in, and only return once we've processed all rows.
        let waitingFor = rows.length;
        let episodes = [];
        rows.forEach((episode, index) => {
            const metadataId = episode.id;
            episodes.push(new EpisodeData(episode));

            if (Config.useThumbnails()) {
                Thumbnails.hasThumbnails(metadataId).then(hasThumbs => {
                    episodes[index].hasThumbnails = hasThumbs;
                    --waitingFor;
                    if (waitingFor == 0) {
                        return jsonSuccess(res, episodes);
                    }
                }).catch(() => {
                    --waitingFor;
                    if (waitingFor == 0) {
                        // We failed, but for auxillary thumbnails, so nothing to completely fail over.
                        return jsonSuccess(res, episodes);
                    }
                    episodes[index].hasThumbnails = false;
                });
            }
        });

        if (!Config.useThumbnails()) {
            return jsonSuccess(res, episodes);
        }
    });
}

/**
 * Map of section IDs to a map of marker counts X to the number episodes that have X markers.
 * @type {Object.<number, Object.<number, number>}
 */
let markerBreakdownCache = {};

/**
 * Gather marker information for all episodes in the given library,
 * returning the number of episodes that have X markers associated with it.
 * @param {number} sectionId The library section id to parse.
 * @param {Http.ServerResponse} res
 */
function allStats(sectionId, res) {
    // If we have global marker data, forego the specialized markerBreakdownCache
    // and build the statistics using the cache manager.
    if (Config.extendedMarkerStats()) {
        Log.verbose('Grabbing section data from the full marker cache.');

        const buckets = MarkerCache.getSectionOverview(sectionId);
        if (buckets) {
            return jsonSuccess(res, buckets);
        }

        // Something went wrong with our global cache. Fall back to markerBreakdownCache.
    }

    if (markerBreakdownCache[sectionId]) {
        Log.verbose('Found cached data, returning it');
        return jsonSuccess(res, markerBreakdownCache[sectionId]);
    }

    QueryManager.markerStatsForSection(sectionId, (err, rows) => {
        if (err) {
            return jsonError(res, 400, err.message);
        }

        let buckets = {};
        Log.verbose(`Parsing ${rows.length} tags`);
        let idCur = -1;
        let countCur = 0;
        for (const row of rows) {
            if (row.episode_id == idCur) {
                if (row.tag_id == QueryManager.markerTagId()) {
                    ++countCur;
                }
            } else {
                if (!buckets[countCur]) {
                    buckets[countCur] = 0;
                }

                ++buckets[countCur];
                idCur = row.episode_id;
                countCur = row.tag_id == QueryManager.markerTagId() ? 1 : 0;
            }
        }

        ++buckets[countCur];
        markerBreakdownCache[sectionId] = buckets;
        return jsonSuccess(res, buckets);
    });
}

/**
 * Ensure our marker bucketing stays up to date after the user adds or deletes markers.
 * @param {MarkerData} marker The marker that changed.
 * @param {number} oldMarkerCount The old marker count bucket.
 * @param {number} delta The change from the old marker count, -1 for marker removals, 1 for additions.
 */
function updateMarkerBreakdownCache(marker, oldMarkerCount, delta) {
    const section = marker.sectionId;
    if (!markerBreakdownCache[section]) {
        return;
    }

    if (!(oldMarkerCount in markerBreakdownCache[section])) {
        Log.warn(`updateMarkerBreakdownCache: no bucket for oldMarkerCount. That's not right!`);
        markerBreakdownCache[section][oldMarkerCount] = 1; // Bring it down to zero I guess.
    }

    markerBreakdownCache[section][oldMarkerCount] -= 1;

    const newMarkerCount = oldMarkerCount + delta;
    if (!(newMarkerCount in markerBreakdownCache[section])) {
        markerBreakdownCache[section][newMarkerCount] = 0;
    }

    markerBreakdownCache[section][newMarkerCount] += 1;
}

/**
 * Retrieve a thumbnail for the episode and timestamp denoted by the url, /t/metadataId/timestampInSeconds
 * @param {string} url The url specifying the thumbnail to retrieve.
 * @param {Http.ServerResponse} res
 */
function getThumbnail(url, res) {
    /** @param {Http.ServerResponse} res */
    const badRequest = (res) => { res.statusCode = 400; res.end(); };

    if (!Config.useThumbnails()) {
        return badRequest(res);
    }

    const split = url.split('/');
    if (split.length != 4) {
        return badRequest(res);
    }

    const metadataId = parseInt(split[2]);
    const timestamp = parseInt(split[3]);
    if (isNaN(metadataId) || isNaN(timestamp)) {
        return badRequest(res);
    }

    Thumbnails.getThumbnail(metadataId, timestamp).then(data => {
        res.writeHead(200, { 'Content-Type' : 'image/jpeg', 'Content-Length' : data.length });
        res.end(data);
    }).catch((err) => {
        Log.error(err, 'Failed to retrieve thumbnail');
        res.statusCode = 500, res.end();
    });
}

/**
 * Retrieve a subset of the app configuration that the frontend needs access to.
 * @param {Http.ServerResponse} res
 */
function getConfig(res) {
    jsonSuccess(res, {
        useThumbnails : Config.useThumbnails(),
        extendedMarkerStats : Config.extendedMarkerStats(),
        backupActions : Config.backupActions()
    });
}

/**
 * Set the server log properties, inherited from the client.
 * @param {number} newLevel The new log level.
 * @param {number} darkConsole Whether to adjust log colors for a dark background.
 * @param {number} traceLogging Whether to also print a stack trace for each log entry.
 * @param {Http.ServerResponse} res */
function setLogSettings(newLevel, darkConsole, traceLogging, res) {
    const logLevelString = Object.keys(ConsoleLog.Level).find(l => ConsoleLog.Level[l] == newLevel);
    if (logLevelString === undefined) {
        Log.warn(newLevel, 'Attempting to set an invalid log level, ignoring');
        // If the level is invalid, don't adjust anything else either.
        return jsonError(res, 400, 'Invalid Log Level');
    }

    if (newLevel != Log.getLevel() || darkConsole != Log.getDarkConsole() || traceLogging != Log.getTrace()) {
        // Force the message.
        Log.setLevel(ConsoleLog.Level.Info);
        const newSettings = { Level : newLevel, Dark : darkConsole, Trace : traceLogging };
        Log.info(newSettings, 'Changing log settings due to client request');
        Log.setLevel(newLevel);
        Log.setDarkConsole(darkConsole);
        Log.setTrace(traceLogging);
    }

    return jsonSuccess(res);
}


/**
 * Checks for markers that the backup database thinks should exist, but aren't in the Plex database.
 * @param {number} metadataId The episode/season/show id
 * @param {Http.ServerResponse} res */
 function purgeCheck(metadataId, res) {
    if (!BackupManager || !Config.backupActions()) {
        return jsonError(res, 400, 'Feature not enabled');
    }

    BackupManager.checkForPurges(metadataId, (err, markers) => {
        if (err) {
            return jsonError(res, 500, err.message);
        }

        Log.info(markers, `Found ${markers.length} missing markers:`);
        jsonSuccess(res, markers);
    });
}

/**
 * Find all purged markers for the given library section.
 * @param {number} sectionId The library section
 * @param {Http.ServerResponse} res */
function allPurges(sectionId, res) {
    if (!BackupManager || !Config.backupActions()) {
        return jsonError(res, 400, 'Feature not enabled');
    }

    try {
        jsonSuccess(res, BackupManager.purgesForSection(sectionId));
    } catch (e) {
        return jsonError(res, 400, e.message);
    }
}

/**
 * Attempts to restore the last known state of the marker with the given id.
 * @param {number} oldMarkerId
 * @param {number} sectionId
 * @param {Http.ServerResponse} res */
function restoreMarker(oldMarkerId, sectionId, res) {
    if (!BackupManager || !Config.backupActions()) {
        return jsonError(res, 400, 'Feature not enabled');
    }

    BackupManager.restoreMarker(oldMarkerId, sectionId, (err, restoredMarker) => {
        if (err) {
            return jsonError(res, 500, err);
        }

        MarkerCache?.addMarkerToCache(restoredMarker);
        jsonSuccess(res, new MarkerData(restoredMarker));
    });
}

/**
 * Ignores the purged marker with the given id, preventing the user from seeing it again.
 * @param {number} oldMarkerId
 * @param {number} sectionId
 * @param {Http.ServerResponse} res */
function ignorePurgedMarker(oldMarkerId, sectionId, res) {
    if (!BackupManager || !Config.backupActions()) {
        return jsonError(res, 400, 'Feature not enabled');
    }

    BackupManager.ignorePurgedMarker(oldMarkerId, sectionId, (err) => {
        if (err) {
            return jsonError(res, 500, err.message);
        }

        jsonSuccess(res);
    });
}
