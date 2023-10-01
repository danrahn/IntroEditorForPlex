// External dependencies
import { dirname, join } from 'path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Client/Server shared dependencies
import { BaseLog, ConsoleLog } from '../Shared/ConsoleLog.js';

// Server/test dependencies/typedefs
import { GetServerState, ServerState } from '../Server/ServerState.js';
import DatabaseWrapper from '../Server/DatabaseWrapper.js';
import { ExtraData } from '../Server/PlexQueryManager.js';
import { run as mainRun } from '../Server/IntroEditor.js';
import TestHelpers from './TestHelpers.js';
import { TestLog } from './TestRunner.js';

/** @typedef {!import('../Shared/PlexTypes').SerializedMarkerData} SerializedMarkerData */

/**
 * Base class for integration tests, containing common test configuration logic.
 */
class TestBase {
    /** @type {method[]} */
    testMethods = [];

    static root = join(dirname(dirname(fileURLToPath(import.meta.url))), 'Test');
    static testConfig = join(TestBase.root, 'testConfig.json');
    static testDbPath = join(TestBase.root, 'plexDbTest.db');
    static backupDbPath = join(TestBase.root, 'Backup', 'markerActions.db');

    /** @type {DatabaseWrapper} */
    testDb = null;
    /** @type {DatabaseWrapper} */
    backupDb = null;
    /**
     * Determines whether this test class requires server setup.
     * True for backend/E2E tests, false for client-only tests.
     * @type {boolean} */
    requiresServer = true;

    constructor() {
        TestLog.tmi('TestBase Constructor');
    }

    /** The name of this test class. Should be overridden by implementing classes. */
    className() { return 'TestBase'; }

    /**
     * Base method to setup the test config. Implementing classes can override this
     * to provide custom settings. */
    setupConfig() { this.createConfig({}); }

    /**
     * Static helper method that attempts to delete the autogenerated test database/config */
    static Cleanup() {
        if (existsSync(TestBase.testDbPath)) {
            TestLog.tmi(`TestBase::Cleanup - Deleting old database`);
            unlinkSync(TestBase.testDbPath);
        }

        if (existsSync(TestBase.testConfig)) {
            TestLog.tmi(`TestBase::Cleanup - Deleting old config`);
            unlinkSync(TestBase.testConfig);
        }
    }

    /**
     * General purpose method that will be called before a test is executed. */
    testMethodSetup() {}

    /**
     * General purpose method that will be called after a test is executed. */
    testMethodTeardown() {
        // Tests that expect to fail disable Error logging in the main Log (see `expectFailure`). Rest it to Warn.
        BaseLog.setLevel(ConsoleLog.Level.Warn);
    }

    /**
     * Sets the application log level to suppress everything but critical messages
     * because we expect operations to fail. */
    expectFailure() {
        BaseLog.setLevel(ConsoleLog.Level.Critical);
    }

    /**
     * Initiate the run for this test class, setting up the database and config file before
     * running through the test methods.
     * @param {string?} methodName The specific test method to run, if any. */
    async runTests(methodName) {
        TestBase.Cleanup();
        let methodFn = null;
        if (methodName) {
            const availableMethods = {};
            this.testMethods.map(fn => availableMethods[fn.name] = fn);
            if (!availableMethods[methodName]) {
                throw new Error(`Test method ${methodName} not found. Make sure the test exists, and casing is correct.`);
            }

            methodFn = availableMethods[methodName];
        }

        if (this.requiresServer) {
            try {
                this.testDb = await DatabaseWrapper.CreateDatabase(TestBase.testDbPath, true /*allowCreate*/);
            } catch (err) {
                TestLog.error(err, `Failed to create test database, cannot run ${this.className()}!`);
                throw err;
            }

            await this.setupPlexDbTestTables();

            this.setupConfig();
            await this.startService();

            // Wait until after the service starts, as it will populate the empty backup database if necessary.
            await this.connectToBackupDatabase();
        }

        if (methodFn) {
            return this.runSingle(methodFn);
        }

        return this.runAll();
    }

    /**
     * Writes the test configuration to disk.
     * @param {{}} overrides Dictionary of custom configuration values to set, if any. */
    createConfig(overrides) {
        const testDefault = (field, value, force=false) => {
            if (!Object.prototype.hasOwnProperty.call(overrides, field) || force) { overrides[field] = value; }
        };

        const testFeature = (feature, value) => {
            overrides.features ??= {};
            if (!Object.prototype.hasOwnProperty.call(overrides.features, feature)) { overrides.features[feature] = value; }
        };

        // Test defaults
        testDefault('host', 'localhost', true);
        testDefault('port', 3233, true);
        testDefault('database', TestBase.testDbPath, true);
        testDefault('logLevel', 'DarkError');

        // Good testing of preview thumbnails would require actual bif files and proper test db
        // entries that I don't want to deal with right now.
        testFeature('previewThumbnails', false);
        testFeature('autoOpen', false);

        writeFileSync(TestBase.testConfig, JSON.stringify(overrides));
    }

    /**
     * Starts the marker editor. Expects to have been run via launch.json's "Run Tests"
     * configuration, which will pass in the right command line arguments to mainRun. */
    async startService() {
        if (GetServerState() == ServerState.FirstBoot) {
            return mainRun();
        }

        return this.resume();
    }

    /**
     * Run all available test methods for this class. */
    async runAll() {
        TestLog.info(`Running tests for ${this.className()}`);
        let successCount = 0;
        let failureCount = 0;
        for (const method of this.testMethods) {
            const success = await this.#runSingleInternal(method);
            success ? ++successCount : ++failureCount;
        }

        TestLog.info(`Ran ${this.testMethods.length} tests`);
        TestLog.info(`\tPASSED: ${successCount}`);
        TestLog.info(`\tFAILED: ${failureCount}`);
        if (failureCount != 0) {
            TestLog.error(`FAILED! One or more tests in ${this.className()} did not pass!`);
        }

        const result = { success : successCount, fail : failureCount };

        await this.testDb?.close();
        await this.backupDb?.close();
        return result;
    }

    async runSingle(testFn) {
        TestLog.info(`Running ${this.className()}::${testFn.name}`);
        const success = await this.#runSingleInternal(testFn);
        await this.testDb?.close();
        await this.backupDb?.close();
        return { success : success ? 1 : 0, fail : success ? 0 : 1 };
    }

    async #runSingleInternal(testMethod) {
        await this.resetState();
        await this.resume();
        this.testMethodSetup();
        let success = true;
        let response = '';
        try {
            await testMethod.bind(this)();
        } catch (ex) {
            success = false;
            response = ex.message;
        }

        this.testMethodTeardown();

        TestLog.verbose(`\t[${testMethod.name}]: ${success ? 'PASSED' : 'FAILED'}`);
        if (!success) {
            TestLog.verbose(`\t\t${response}`);
        }

        if (this.requiresServer) {
            await this.suspend();
        }

        return success;
    }

    /**
     * Suspend the test server, which will disconnect it from the test config
     * and database, allowing us to reset the server state between tests. */
    async suspend() {
        if (GetServerState() === ServerState.ShuttingDown) {
            return;
        }

        try {
            await this.send('suspend');
            TestLog.tmi('Detached from test server');
        } catch (err) {
            TestLog.error(err, 'Failed to shut down test server cleanly, force stopping tests');
            process.exit(1);
        }
    }

    /**
     * Resumes the test server after being suspended for cleanup. */
    async resume() {
        if (GetServerState() != ServerState.Suspended) {
            return;
        }

        await this.send('resume');
        BaseLog.tmi('Resuming server');
    }

    /**
     * Send a request to the test server.
     * @param {string} endpoint The command to run
     * @param {*} params Dictionary of query parameters to pass into the test server.
     * @param {boolean} raw Whether to return the immediate fetch result, not the parsed JSON data. */
    async send(endpoint, params={}, raw=false) {
        return this.#fetchInternal(endpoint, params, 'POST', { accept : 'application/json' }, raw);
    }

    /**
     * Sends a GET request to the test server.
     * @param {string} endpoint The file to retrieve
     * @param {*} params Dictionary of query parameters to pass into the test server.
     * @returns {Promise<Response>} */
    async get(endpoint, params={}) {
        return this.#fetchInternal(endpoint, params, 'GET', {}, true);
    }

    /**
     * Internal fetch handler
     * @param {string} endpoint
     * @param {*} params
     * @param {string} method POST or GET
     * @param {*} headers Any additional headers to add to the request
     * @param {boolean} raw */
    async #fetchInternal(endpoint, params, method, headers, raw) {
        if (GetServerState() == ServerState.FirstBoot || GetServerState() == ServerState.ShuttingDown) {
            TestLog.warn('TestHarness: Attempting to send a request to the test server when it isn\'t running!');
            return;
        }

        const url = new URL(`http://localhost:3233/${endpoint}`);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.append(key, value);
        }

        if (raw) {
            return fetch(url, { method : method, headers : headers });
        } else {
            TestHelpers.verify(method == 'POST', `We shouldn't be making non-raw GET requests`);
            return fetch(url, { method : method, headers : headers }).then(r => r.json());
        }
    }

    /* eslint-disable indent */
    /**
     * Map of default metadata items to their metadata/marker ids.
     * TODO: indexRemove: Replace Index with Order? Still want to test reordering, but via our calculated values. */
    static DefaultMetadata = {
        Show1 : { Id : 1,
            Season1 : { Id : 2,
                Episode1 : { Id : 3, },
                Episode2 : { Id : 4,
                    Marker1 : { Id : 1, Start : 15000, End : 45000, Index : 0, Type : 'intro', Final : false }, },
                Episode3 : { Id : 5, }, },
            Season2 : { Id : 6,
                Episode1 : { Id : 7, }, }
        },
        Show2 : { Id : 8,
            Season1 : { Id : 9,
                Episode1 : { Id : 10, }, },
        },
        Show3 : { Id : 11,
            Season1 : { Id : 12,
                Episode1 : { Id : 13,
                    Marker1 : { Id : 2, Start : 15000, End : 45000, Index : 0, Type : 'intro', Final : false }, },
                Episode2 : { Id : 14,
                    Marker1 : { Id : 3, Start : 15000, End : 45000, Index : 0, Type : 'intro', Final : false },
                    Marker2 : { Id : 4, Start : 300000, End : 345000, Index : 1, Type : 'credits', Final : false },
                    Marker3 : { Id : 5, Start : 360000, End : 370000, Index : 2, Type : 'credits', Final : true }, },
            },
            Season2 : { Id : 15,
                Episode1 : { Id : 16,
                    Marker1 : { Id : 6, Start : 13000, End : 47000, Index : 0, Type : 'intro', Final : false }, },
            },
        },
        Show1_1 : { Id : 17, // "Split" show
            Season1 : { Id : 18,
                Episode1 : { Id : 19, }, },
        },
        Movie1 : { Id : 100, },
        Movie2 : { Id : 101,
            Marker1 : { Id : 7, Start : 10000, End : 30000, Index : 0, Type : 'intro', Final : false },
            Marker2 : { Id : 8, Start : 40000, End : 45000, Index : 1, Type : 'credits', Final : false },
            Marker3 : { Id : 9, Start : 55000, End : 60000, Index : 2, Type : 'credits', Final : true },
        },
        Movie3 : { Id : 102,
            Marker1 : { Id : 10, Start : 15000, End : 45000, Index : 0, Type : 'intro', Final : false },
        }
    };
    /* eslint-enable */

    static NextMarkerIndex = 11;

    /**
     * Create the minimal recreation of the Plex database and enter some default metadata and marker items. */
    async setupPlexDbTestTables() {
        if (!this.testDb) {
            TestLog.error('Cannot add test marker, database is not initialized!');
            return;
        }

        const tables = TestHelpers.getCreateTables();

        // Create the intro marker tag.
        const introInsert = `INSERT INTO tags (tag_type) VALUES (12);`;

        // Create a single TV, Movie, and Music library.
        const sectionInsert = `
        INSERT INTO library_sections (library_id, name, section_type, uuid)
        VALUES                       (1,          "TV", 2,            "94319c6e-16c0-11ed-861d-0242ac120002"),
                                     (2,      "Movies", 1,            "dbdf1795-0f3c-4a9b-956b-6f10edb6eccc"),
                                     (3,       "Music", 8,            "27465ca2-2a7f-48b5-b5a2-d70da84f1cd9");`;

        // TODO: Have a "base" set of shows/seasons/episodes that cover many scenarios, with the option to override
        //       what's added to accommodate any scenario. Also have a map that indicates what's available
        // Type - 2=show, 3=season, 4=episode, 8=artist, 9=album, 10=track
        // Index - show=1, everything else = season/episode index
        // inserting id isn't necessary, just helpful for tracking
        const metadataInsert = `
        INSERT INTO metadata_items (id, library_section_id, metadata_type, parent_id, title,     \`index\`, guid)
        VALUES                     (1,  1,                  2,             NULL,      "Show1",    1,        "0"),
                                   (2,  1,                  3,             1,         "Season1",  1,        "1"),
                                   (3,  1,                  4,             2,         "Episode1", 1,        "2"),
                                   (4,  1,                  4,             2,         "Episode2", 2,        "3"),
                                   (5,  1,                  4,             2,         "Episode3", 3,        "4"),
                                   (6,  1,                  3,             1,         "Season2",  2,        "5"),
                                   (7,  1,                  4,             6,         "Episode1", 1,        "6"),
                                   (8,  1,                  2,             NULL,      "Show2",    1,        "7"),
                                   (9,  1,                  3,             8,         "Season1",  1,        "8"),
                                   (10, 1,                  4,             9,         "Episode1", 1,        "9"),
                                   (11, 1,                  2,             NULL,      "Show3",    1,        "a"),
                                   (12, 1,                  3,             11,        "Season1",  1,        "b"),
                                   (13, 1,                  4,             12,        "Episode1", 1,        "c"),
                                   (14, 1,                  4,             12,        "Episode2", 2,        "d"),
                                   (15, 1,                  3,             11,        "Season2",  2,        "e"),
                                   (16, 1,                  4,             15,        "Episode1", 1,        "f"),
                                   (17, 1,                  2,             NULL,      "Show1_1",  1,        "0"),
                                   (18, 1,                  3,             17,        "Season1",  1,        "1"),
                                   (19, 1,                  4,             18,        "Episode1", 1,        "2"),

                                   (100,2,                  1,             NULL,      "Movie1",   1,        "00"),
                                   (101,2,                  1,             NULL,      "Movie2",   1,        "01"),
                                   (102,2,                  1,             NULL,      "Movie3",   1,        "02"),
                                   
                                   (200,3,                  8,             NULL,      "Artist1",  1,        "03"),
                                   (201,3,                  9,             200,       "Album1",   1,        "04"),
                                   (202,3,                  10,            201,       "Track1",   1,        "05");`;

        // Need existing media, but only the metadata_item_id and duration field (for now)
        // Make them all 10 minutes (10*60*1000=6000000)
        const mediaInsert = `
        INSERT INTO media_items (metadata_item_id, duration)
        VALUES                  (3,                600000),
                                (4,                600000),
                                (5,                600000),
                                (7,                600000),
                                (10,               600000),
                                (13,               600000),
                                (14,               600000),
                                (16,               600000),
                                (19,               600000),
                                (100,              600000),
                                (101,              600000),
                                (102,              600000);`;

        return this.testDb.exec(tables + introInsert + sectionInsert + metadataInsert + mediaInsert + this.defaultMarkers());
    }

    /**
     * Connect to (and create if necessary) a marker backup database for tests. */
    async connectToBackupDatabase() {
        const testBackupPath = join(TestBase.root, 'Backup');
        if (!existsSync(testBackupPath)) {
            TestLog.verbose('Creating test backup directory');
            mkdirSync(testBackupPath);
        }

        this.backupDb = await DatabaseWrapper.CreateDatabase(TestBase.backupDbPath, true /*allowCreate*/);
    }

    /** @returns The INSERT statements that will add the default markers to the test database. */
    defaultMarkers() {
        /* eslint-disable max-len */
        const dbMarkerInsert = (metadataId, index, start, end, markerType, isFinal) => `
            INSERT INTO taggings
                (metadata_item_id, tag_id, "index", text, time_offset, end_time_offset, created_at, extra_data)
            VALUES
                (${metadataId}, 1, ${index}, "${markerType}", ${start}, ${end}, (strftime('%s','now')), "${ExtraData.get(markerType, isFinal)}");\n`;


        let insertString = '';
        let episode = TestBase.DefaultMetadata.Show1.Season1.Episode2;
        insertString += dbMarkerInsert(episode.Id, episode.Marker1.Index, episode.Marker1.Start, episode.Marker1.End, episode.Marker1.Type, episode.Marker1.Final);
        episode = TestBase.DefaultMetadata.Show3.Season1.Episode1;
        insertString += dbMarkerInsert(episode.Id, episode.Marker1.Index, episode.Marker1.Start, episode.Marker1.End, episode.Marker1.Type, episode.Marker1.Final);
        episode = TestBase.DefaultMetadata.Show3.Season1.Episode2;
        insertString += dbMarkerInsert(episode.Id, episode.Marker1.Index, episode.Marker1.Start, episode.Marker1.End, episode.Marker1.Type, episode.Marker1.Final);
        insertString += dbMarkerInsert(episode.Id, episode.Marker2.Index, episode.Marker2.Start, episode.Marker2.End, episode.Marker2.Type, episode.Marker2.Final);
        insertString += dbMarkerInsert(episode.Id, episode.Marker3.Index, episode.Marker3.Start, episode.Marker3.End, episode.Marker3.Type, episode.Marker3.Final);
        episode = TestBase.DefaultMetadata.Show3.Season2.Episode1;
        insertString += dbMarkerInsert(episode.Id, episode.Marker1.Index, episode.Marker1.Start, episode.Marker1.End, episode.Marker1.Type, episode.Marker1.Final);

        // Movies
        let movie = TestBase.DefaultMetadata.Movie2;
        insertString += dbMarkerInsert(movie.Id, movie.Marker1.Index, movie.Marker1.Start, movie.Marker1.End, movie.Marker1.Type, movie.Marker1.Final);
        insertString += dbMarkerInsert(movie.Id, movie.Marker2.Index, movie.Marker2.Start, movie.Marker2.End, movie.Marker2.Type, movie.Marker2.Final);
        insertString += dbMarkerInsert(movie.Id, movie.Marker3.Index, movie.Marker3.Start, movie.Marker3.End, movie.Marker3.Type, movie.Marker3.Final);
        movie = TestBase.DefaultMetadata.Movie3;
        insertString += dbMarkerInsert(movie.Id, movie.Marker1.Index, movie.Marker1.Start, movie.Marker1.End, movie.Marker1.Type, movie.Marker1.Final);
        return insertString;
        /* eslint-enable */
    }

    /**
     * Add a marker to the given episode via the 'add' endpoint, returning the JSON response.
     * @param {number} episodeId The episode's metadata id
     * @param {number} startMs
     * @param {number} endMs
     * @param {string} markerType
     * @param {boolean} final
     * @returns {Promise<SerializedMarkerData>} */
    async addMarker(episodeId, startMs, endMs, markerType='intro', final=false) {
        return this.#addMarkerCore(episodeId, startMs, endMs, markerType, final, false /*raw*/);
    }

    /**
     * Add a marker to the given episode via the 'add' endpoint, returning the raw request.
     * @param {number} metadataId The episode's metadata id
     * @param {number} startMs
     * @param {number} endMs
     * @param {string} markerType
     * @param {boolean} final
     * @returns {Promise<Response>} */
    async addMarkerRaw(metadataId, startMs, endMs, markerType='intro', final=false) {
        return this.#addMarkerCore(metadataId, startMs, endMs, markerType, final, true /*raw*/);
    }

    /**
     * Add a marker to the given episode via the 'add' endpoint.
     * @param {number} metadataId The episode's metadata id
     * @param {number} startMs
     * @param {number} endMs
     * @param {string} markerType
     * @param {boolean} final
     * @param {boolean} raw Whether the Response should be returned instead of the json response.
     * @returns {Promise<SerializedMarkerData|Response>} */
    async #addMarkerCore(metadataId, startMs, endMs, markerType, final, raw=false) {
        return this.send('add', {
            metadataId : metadataId,
            start : startMs,
            end : endMs,
            type : markerType,
            final : final ? 1 : 0,
        }, raw);
    }

    /**
     * Edit a marker with the given id via the 'edit' endpoint, returning the JSON response.
     * @param {number} markerId
     * @param {number} startMs
     * @param {number} endMs
     * @param {string} markerType
     * @param {boolean} final
     * @returns {Promise<SerializedMarkerData>} */
    async editMarker(markerId, startMs, endMs, markerType='intro', final=false) {
        return this.#editMarkerCore(markerId, startMs, endMs, markerType, final, false /*raw*/);
    }

    /**
     * Edit a marker with the given id via the 'edit' endpoint, returning the raw Response.
     * @param {number} markerId
     * @param {number} startMs
     * @param {number} endMs
     * @param {string} markerType
     * @param {boolean} final
     * @returns {Promise<Response>} */
    async editMarkerRaw(markerId, startMs, endMs, markerType, final) {
        return this.#editMarkerCore(markerId, startMs, endMs, markerType, final, true /*raw*/);
    }

    /**
     * Edit a marker with the given id via the 'edit' endpoint.
     * @param {number} markerId
     * @param {number} startMs
     * @param {number} endMs
     * @param {string} markerType
     * @param {boolean} final
     * @param {boolean} raw Whether the Response should be returned instead of the json response.
     * @returns {Promise<SerializedMarkerData|Response>} */
    async #editMarkerCore(markerId, startMs, endMs, markerType, final, raw) {
        return this.send('edit', {
            id : markerId,
            start : startMs,
            end : endMs,
            type : markerType,
            final : final ? 1 : 0,
        }, raw);
    }

    /**
     * Clear out the test databases and re-enter the default data. */
    async resetState() {
        await this.testDb?.exec(`
            DELETE FROM taggings;
            VACUUM;
            UPDATE sqlite_sequence SET seq=0 WHERE name="taggings";
            ${this.defaultMarkers()}`);
        await this.backupDb?.exec(`
            DELETE FROM actions;
            VACUUM;
            UPDATE sqlite_sequence SET seq=0 WHERE name="actions";`);
    }
}

export default TestBase;
