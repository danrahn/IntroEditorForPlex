import {
    $,
    appendChildren,
    buildNode,
    clearEle,
    msToHms,
    pad0,
    realMs,
    timeInputShortcutHandler,
    timeToMs,
    waitFor } from './Common.js';

import { BulkActionCommon, BulkActionRow, BulkActionTable, BulkActionType } from './BulkActionCommon.js';
import { BulkMarkerResolveType, MarkerData } from '../../Shared/PlexTypes.js';
import { errorResponseOverlay, errorToast } from './ErrorHandling.js';
import BulkAddStickySettings from './StickySettings/BulkAddStickySettings.js';
import ButtonCreator from './ButtonCreator.js';
import { ContextualLog } from '../../Shared/ConsoleLog.js';
import { getSvgIcon } from './SVGHelper.js';
import Icons from './Icons.js';
import { MarkerType } from '../../Shared/MarkerType.js';
import Overlay from './Overlay.js';
import { PlexClientState } from './PlexClientState.js';
import { ServerCommands } from './Commands.js';
import TableElements from './TableElements.js';
import { ThemeColors } from './ThemeColors.js';
import Tooltip from './Tooltip.js';

/** @typedef {!import('../../Shared/PlexTypes').ChapterData} ChapterData */
/** @typedef {!import('../../Shared/PlexTypes').ChapterMap} ChapterMap */
/** @typedef {!import('../../Shared/PlexTypes').CustomBulkAddMap} CustomBulkAddMap */
/** @typedef {!import('../../Shared/PlexTypes').SeasonData} SeasonData */
/** @typedef {!import('../../Shared/PlexTypes').MarkerData} MarkerData */
/** @typedef {!import('../../Shared/PlexTypes').SerializedBulkAddResult} SerializedBulkAddResult */
/** @typedef {!import('../../Shared/PlexTypes').SerializedBulkAddResultEntry} SerializedBulkAddResultEntry */
/** @typedef {!import('../../Shared/PlexTypes').SerializedEpisodeData} SerializedEpisodeData */
/** @typedef {!import('../../Shared/PlexTypes').SerializedMarkerData} SerializedMarkerData */
/** @typedef {!import('../../Shared/PlexTypes').ShowData} ShowData */

const Log = new ContextualLog('BulkAddOverlay');

/**
 * UI for bulk adding markers to a given show/season
 */
class BulkAddOverlay {
    /** @type {ShowData|SeasonData} */
    #mediaItem;

    /** @type {BulkActionTable} */
    #table;
    /**
     * @type {SerializedBulkAddResult} */
    #serverResponse;

    /** @type {number} */
    #inputTimer = 0;

    /** @type {number} Cached ms of the current start input to prevent repeated calculations. */
    #cachedStart = NaN;
    /** @type {number} Cached ms of the current end input to prevent repeated calculations. */
    #cachedEnd = NaN;
    /** @type {HTMLElement} Cached chapter/manual mode toggle. */
    #inputMode;
    /** @type {ChapterMap} Chapter data for all individual episodes in this overlay. */
    #chapterMap;
    /** @type {ChapterData} Cached baseline start chapter data. */
    #cachedChapterStart;
    /** @type {ChapterData} Cached baseline end chapter data. */
    #cachedChapterEnd;
    /** @type {BulkAddStickySettings} Applicable settings that might "stick" depending on client settings. */
    #stickySettings = new BulkAddStickySettings();

    /**
     * List of descriptions for the various bulk marker resolution actions. */
    static #descriptions = [
        '',
        'If any added marker conflicts with existing markers, fail the entire operation',
        'If any added markers conflict with existing markers, merge them with into the existing marker(s)',
        'If any added marker conflicts with existing markers, don\'t add the marker to the episode',
        'If any added marker conflicts with existing markers, delete the existing markers',
    ];

    /** @type {Element?} */
    static #indexMatchingTooltip;

    static #getIndexMatchingTooltip() {
        BulkAddOverlay.#indexMatchingTooltip ??= buildNode('span',
            { class : 'smallerTooltip' },
            "When an exact chapter name match isn't available, " +
                "use the chapter's index to find matching chapters, not the closest timestamp");
        return BulkAddOverlay.#indexMatchingTooltip;
    }

    /**
     * Construct a new bulk add overlay.
     * @param {ShowData|SeasonData} mediaItem */
    constructor(mediaItem) {
        this.#mediaItem = mediaItem;
    }

    /** Return the customization table for this operation. */
    table() { return this.#table; }

    /**
     * Launch the bulk add overlay.
     * @param {HTMLElement} focusBack The element to set focus back to after the bulk overlay is dismissed. */
    show(focusBack) {
        // Any time we're showing the dialog we should reset any marker data we've accumulated
        this.#serverResponse = undefined;
        const container = buildNode('div', { id : 'bulkActionContainer' });
        const title = buildNode('h1', {}, 'Bulk Add Markers');
        appendChildren(container,
            title,
            buildNode('hr'),
            appendChildren(buildNode('div', { id : 'timeZone' }),
                buildNode('label', { for : 'addStart' }, 'Start: '),
                buildNode('input',
                    {   type : 'text',
                        placeholder : 'ms or ms:ss[.000]',
                        name : 'addStart',
                        id : 'addStart' },
                    0,
                    {   keyup : this.#onBulkAddInputChange.bind(this),
                        keydown : timeInputShortcutHandler }
                ),
                buildNode('label', { for : 'addEnd' }, 'End: '),
                buildNode('input',
                    {   type : 'text',
                        placeholder : 'ms or ms:ss[.000]',
                        name : 'addEnd',
                        id : 'addEnd' },
                    0,
                    { keyup : this.#onBulkAddInputChange.bind(this),
                      keydown : timeInputShortcutHandler }
                )
            ),
            appendChildren(buildNode('div', { id : 'chapterZone', class : 'hidden' }),
                buildNode('label', { for : 'baselineEpisode' }, 'Baseline: '),
                buildNode('select', { id : 'baselineEpisode' }, 0, { change : this.#onChapterEpisodeBaselineChanged.bind(this) }),
                buildNode('br'),
                buildNode('label', { for : 'addStartChapter' }, 'Start: '),
                buildNode('select', { id : 'addStartChapter' }, 0, { change : this.#onChapterChanged.bind(this) }),
                buildNode('label', { for : 'addEndChapter' }, 'End: '),
                buildNode('select', { id : 'addEndChapter' }, 0, { change : this.#onChapterChanged.bind(this) }),
                buildNode('br'),
                appendChildren(buildNode('span', { id : 'chapterIndexModeContainer' }),
                    buildNode('label', { for : 'chapterIndexMode' }, 'Force index matching: '),
                    buildNode('input',
                        { type : 'checkbox', id : 'chapterIndexMode' },
                        0,
                        { change : this.#onChapterIndexModeChanged.bind(this) }),
                    appendChildren(buildNode('span', { id : 'chapterIndexModeHelp' }),
                        getSvgIcon(Icons.Help, ThemeColors.Primary, { width : 15, height : 15 })
                    )
                )
            ),
            appendChildren(buildNode('div', { id : 'bulkAddInputMethod' }),
                ButtonCreator.fullButton(
                    'Chapter Mode',
                    Icons.Chapter,
                    ThemeColors.Primary,
                    this.#onInputMethodChanged.bind(this),
                    {
                        id : 'switchInputMethod',
                        class : 'disabled',
                        tooltip : 'Checking for chapters...'
                    }
                )
            ),
            appendChildren(buildNode('div', { id : 'bulkAddMarkerType' }),
                buildNode('label', { for : 'markerTypeSelect' }, 'Marker Type: '),
                appendChildren(buildNode('select', { id : 'markerTypeSelect' }, 0, { change : this.#onMarkerTypeChanged.bind(this) }),
                    buildNode('option', { value : MarkerType.Intro }, 'Intro'),
                    buildNode('option', { value : MarkerType.Credits }, 'Credits'))
            ),
            appendChildren(buildNode('div', { id : 'bulkAddApplyType' }),
                buildNode('label', { for : 'applyTypeSelect' }, 'Apply Action: '),
                appendChildren(
                    buildNode('select', { id : 'applyTypeSelect' }, 0, { change : this.#onApplyTypeChange.bind(this) }),
                    buildNode('option', { value : 1 }, 'Fail'),
                    buildNode('option', { value : 4 }, 'Overwrite'),
                    buildNode('option', { value : 2 }, 'Merge'),
                    buildNode('option', { value : 3 }, 'Ignore')),
                buildNode('div', { id : 'applyTypeDescription' }, BulkAddOverlay.#descriptions[this.#stickySettings.applyType()])
            ),
            buildNode('hr'),
            appendChildren(buildNode('div', { id : 'bulkActionButtons' }),
                ButtonCreator.fullButton(
                    'Apply', Icons.Confirm, ThemeColors.Green, this.#apply.bind(this), { id  : 'bulkAddApply' }),
                ButtonCreator.fullButton(
                    'Customize', Icons.Table, ThemeColors.Primary, this.#check.bind(this), { id : 'bulkAddCustomize' }),
                ButtonCreator.fullButton(
                    'Cancel', Icons.Cancel, ThemeColors.Red, Overlay.dismiss, { id : 'bulkAddCancel' })
            )
        );

        this.#inputMode = $('#switchInputMethod', container);
        Tooltip.setTooltip($('#chapterIndexModeHelp', container), BulkAddOverlay.#getIndexMatchingTooltip());
        $('#markerTypeSelect', container).value = this.#stickySettings.markerType();
        $('#applyTypeSelect', container).value = this.#stickySettings.applyType();

        Overlay.build({
            dismissible : true,
            closeButton : true,
            forceFullscreen : true,
            focusBack : focusBack }, container);

        // We could/should share chapter data for season-level bulk adds, but just grab it again.
        this.#checkForChapters();
    }

    /**
     * Processes time input
     * @param {MouseEvent} e */
    #onBulkAddInputChange(e) {
        const start = $('#addStart');
        const end = $('#addEnd');
        this.#cachedStart = timeToMs(start.value, true /*allowNegative*/);
        this.#cachedEnd = timeToMs(end.value, true /*allowNegative*/);
        isNaN(this.#cachedStart) ? start.classList.add('badInput') : start.classList.remove('badInput');
        isNaN(this.#cachedEnd) ? end.classList.add('badInput') : end.classList.remove('badInput');
        clearTimeout(this.#inputTimer);
        if (e.key === 'Enter') {
            this.#updateTableStats();
        }

        this.#inputTimer = setTimeout(this.#updateTableStats.bind(this), 250);
    }

    /**
     * Toggles manual input/chapter input */
    async #onInputMethodChanged() {
        if (!this.#serverResponse) {
            await this.#check(); // Need full episode data from a dry-run before continuing.
        }

        if ($('#baselineEpisode').children?.length === 0) {
            Log.assert(this.#populateChapterInfoDropdown(),
                `Something went wrong initializing chapter dropdowns, the view might not be correct.`);
        }

        const tz = $('#timeZone');
        tz.classList.toggle('hidden');
        $('#chapterZone').classList.toggle('hidden');
        const chapterMode = tz.classList.contains('hidden');
        if (chapterMode) {
            ButtonCreator.setText(this.#inputMode, 'Manual Mode');
            ButtonCreator.setIcon(this.#inputMode, Icons.Cursor, ThemeColors.Primary);
        } else {
            ButtonCreator.setText(this.#inputMode, 'Chapter Mode');
            ButtonCreator.setIcon(this.#inputMode, Icons.Chapter, ThemeColors.Primary);
        }

        this.#stickySettings.setChapterMode(chapterMode);
        this.#updateTableStats();
    }

    /** Update the type of marker to create. */
    #onMarkerTypeChanged() {
        this.#stickySettings.setMarkerType($('#markerTypeSelect').value);
    }

    /**
     * When the baseline episode changes, populate the chapter dropdown with the new chapters
     * and update the customization table. */
    #onChapterEpisodeBaselineChanged() {
        /** @type {HTMLSelectElement} */
        const select = $('#baselineEpisode');
        const id = select.value;
        select.title = select.options[select.selectedIndex].innerText;
        const chapters = this.#chapterMap[id];
        if (!chapters) {
            Log.warn(`Invalid episode specified in baseline episode dropdown. That's not right!`);
            return;
        }

        const startChapter = $('#addStartChapter');
        const endChapter = $('#addEndChapter');
        startChapter.setAttribute('data-switching-episode', 1); // Don't fire a bunch of change events when reorganizing.
        endChapter.setAttribute('data-switching-episode', 1);
        clearEle(startChapter);
        clearEle(endChapter);
        const displayTitle = (name, index, timestamp) => `${name || 'Chapter ' + (parseInt(index) + 1)} (${msToHms(timestamp)})`;

        for (const [index, chapter] of Object.entries(chapters)) {
            startChapter.appendChild(buildNode('option', { value : index }, displayTitle(chapter.name, index, chapter.start)));
            endChapter.appendChild(buildNode('option', { value : index }, displayTitle(chapter.name, index, chapter.end)));
        }

        this.#cachedChapterStart = chapters[startChapter.firstChild.value];
        this.#cachedChapterEnd = chapters[endChapter.firstChild.value];
        startChapter.title = startChapter.options[0].innerText;
        endChapter.title = endChapter.options[0].innerText;

        startChapter.removeAttribute('data-switching-episode');
        endChapter.removeAttribute('data-switching-episode');

        this.#updateTableStats();
    }

    /**
     * Update the customization table when the start/end chapter baseline is changed.
     * @param {Event} e */
    #onChapterChanged(e) {
        if (e.target.getAttribute('data-switching-episode')) {
            // We're repopulating the chapter list due to a baseline episode change. Don't do anything yet.
            return;
        }

        e.target.title = e.target.options[e.target.selectedIndex].innerText;
        const eid = $('#baselineEpisode').value;
        if (e.target.id === 'addStartChapter') {
            this.#cachedChapterStart = this.#chapterMap[eid][e.target.value];
        } else {
            this.#cachedChapterEnd = this.#chapterMap[eid][e.target.value];
        }

        this.#updateTableStats();
    }

    /**
     * Update chapter index mode, i.e. whether chapter indexes or timestamps take precedence for fuzzy matching. */
    #onChapterIndexModeChanged() {
        this.#stickySettings.setChapterIndexMode($('#chapterIndexMode').checked);
        this.#updateTableStats();
    }

    /**
     * Attempt to retrieve chapter data for all episodes in this overlay. */
    async #checkForChapters() {
        // This will already be set if we're reshowing the dialog after a
        // successful/failed operation, and chapter data should always be static.
        if (!this.#chapterMap) {
            try {
                this.#chapterMap = await ServerCommands.getChapters(this.#mediaItem.metadataId);
            } catch {
                Tooltip.setText(this.#inputMode, 'Unable to get chapter data, chapter mode unavailable');
                this.#chapterMap = null;
            }
        }

        let anyEmpty = false;
        let allEmpty = true;
        for (const chapterData of Object.values(this.#chapterMap)) {
            if (chapterData.length === 0) {
                anyEmpty = true;
            } else {
                allEmpty = false;
            }

            if (anyEmpty && !allEmpty) {
                break; // We have all the initial data we need here.
            }
        }

        let tooltipText = 'Toggle between chapter input and timestamp input';
        if (allEmpty) {
            tooltipText = 'No episodes have chapters, chapter mode unavailable';
        } else if (anyEmpty) {
            tooltipText += '<br>WARN: Not all episodes have chapter data available';
        }

        Tooltip.setText(this.#inputMode, tooltipText);

        if (!allEmpty) {
            this.#inputMode.classList.remove('disabled');
            if (this.#stickySettings.chapterMode()) {
                if (this.#stickySettings.chapterIndexMode()) {
                    $('#chapterIndexMode').checked = true;
                }

                await this.#onInputMethodChanged();
            }
        }
    }

    /**
     * Populate the baseline episode dropdown with all relevant episodes that have chapter data available. */
    #populateChapterInfoDropdown() {
        if (!this.#serverResponse || !this.#chapterMap) {
            Log.warn(`Chapter and episode data not initialized, cannot populate data.`);
            return false;
        }

        const select = $('#baselineEpisode');
        const episodeMap = this.#serverResponse.episodeMap;
        const episodePad = Math.max(
            Object.values(this.#serverResponse.episodeMap).reduce((acc, bare) =>
                acc = this.#chapterMap[bare.episodeData.metadataId].length > 0 ? Math.max(acc, bare.episodeData.index) : acc,
            0).toString().length, 2);
        const episodeIds = Object.keys(this.#chapterMap);
        episodeIds.sort((/**@type {number}*/a, /**@type  {number}*/b) => {
            const ad = episodeMap[a].episodeData;
            const bd = episodeMap[b].episodeData;
            return ad.seasonIndex - bd.seasonIndex || ad.index - bd.index;
        });

        for (const episodeId of episodeIds) {
            const chapters = this.#chapterMap[episodeId];
            if (chapters.length === 0) {
                continue;
            }

            /** @type {SerializedBulkAddResultEntry} */
            const entry = episodeMap[episodeId];
            if (!entry) {
                Log.warn(`Episode with chapter data (${episodeId}) not found in server response.`);
                continue;
            }

            const episode = entry.episodeData;
            const optionText = `S${pad0(episode.seasonIndex, 2)}E${pad0(episode.index, episodePad)} - ${episode.title}`;
            select.appendChild(buildNode('option', { value : episode.metadataId }, optionText));
        }

        this.#onChapterEpisodeBaselineChanged();

        return true;
    }

    /**
     * Processes bulk marker resolution type change. */
    #onApplyTypeChange() {
        const sel = $('#applyTypeSelect');
        if (!sel) { return; }

        const val = parseInt(sel.value);
        this.#stickySettings.setApplyType(val);
        $('#applyTypeDescription').innerText = BulkAddOverlay.#descriptions[val];
        this.#updateTableStats();
    }

    /**
     * Attempts to apply the current marker to the selected episodes. */
    async #apply() {
        const applyButton = $('#bulkAddApply');
        ButtonCreator.setIcon(applyButton, Icons.Loading, ThemeColors.Green);
        await this.#applyInternal();
        // The UI might have changed after applying, make sure we exist before setting anything.
        if (applyButton.isConnected) {
            ButtonCreator.setIcon(applyButton, Icons.Confirm, ThemeColors.Green);
        }
    }

    async #applyInternal() {
        if (this.chapterMode()) {
            return this.#applyChapters();
        }

        const startTime = this.startTime();
        const endTime = this.endTime();
        const resolveType = this.resolveType();
        const markerType = this.markerType();
        if (isNaN(startTime) || isNaN(endTime)) {
            return BulkActionCommon.flashButton('bulkAddApply', ThemeColors.Red);
        }

        try {
            const result = await ServerCommands.bulkAdd(
                markerType,
                this.#mediaItem.metadataId,
                startTime,
                // -0 is converted to a string over the wire, but -0 toString() is just '0', so handle it directly.
                Object.is(endTime, -0) ? '-0' : endTime,
                resolveType,
                this.#table?.getIgnored());

            await this.#postProcessBulkAdd(result);
        } catch (err) {
            await BulkActionCommon.flashButton('bulkAddApply', ThemeColors.Red, 500);
            errorResponseOverlay('Unable to bulk add, please try again later', err, this.show.bind(this));
        }
    }

    /**
     * Attempt to apply a bulk-add based on chapter data. */
    async #applyChapters() {
        if (!this.#serverResponse || !this.#table) {
            // We should only be submitting chapter-based markers if we've queried for episode info.
            Log.warn(`Attempting to add chapter-based markers without episode data. How did that happen?`);
            return BulkActionCommon.flashButton('bulkAddApply', ThemeColors.Red);
        }

        /** @type {CustomBulkAddMap} */
        const newMarkerMap = {};
        for (const row of this.#table.rows()) {
            if (!(row instanceof BulkAddRow)) {
                Log.warn(`Non-BulkAddRow found in BulkAdd table. How did that happen?`);
                continue;
            }

            if (!row.enabled) {
                continue;
            }

            const timestamp = row.getChapterTimestampData();
            if (timestamp.start >= timestamp.end) {
                Log.warn(`Ignoring bulk add for ${row.id} - start timestamp greater than end timestamp.`);
                continue;
            }

            newMarkerMap[row.id] = timestamp;
        }

        const newMarkerCount = Object.keys(newMarkerMap).length;
        if (newMarkerCount === 0) {
            Log.warn(`No new markers to add.`);
            return BulkActionCommon.flashButton('bulkAddApply', ThemeColors.Red);
        }

        Log.info(`Attempt to bulk-add ${newMarkerCount} markers based on chapter data.`);
        const resolveType = this.resolveType();
        const markerType = this.markerType();
        try {
            const result = await ServerCommands.bulkAddCustom(
                markerType,
                this.#mediaItem.metadataId,
                resolveType,
                newMarkerMap
            );

            await this.#postProcessBulkAdd(result);
        } catch (err) {
            await BulkActionCommon.flashButton('bulkAddApply', ThemeColors.Red, 1000);
            errorResponseOverlay('Unable to bulk add, please try again later', err, this.show.bind(this));
        }
    }

    /**
     * Triggers necessary updates after a bulk add succeeds.
     * @param {SerializedBulkAddResult} result */
    async #postProcessBulkAdd(result) {
        if (!result.applied) {
            BulkActionCommon.flashButton('bulkAddApply', ThemeColors.Red, 1000);
            if (result.notAppliedReason) {
                errorToast(result.notAppliedReason, 6000);
            }

            return;
        }

        const episodes = Object.values(result.episodeMap);
        let addCount = 0;
        let editCount = 0;
        let deleteCount = 0;
        /** @type {BulkMarkerResult} */
        const adds = {};
        /** @type {BulkMarkerResult} */
        const edits = {};
        /** @type {BulkMarkerResult} */
        const deletes = {};
        for (const episodeInfo of episodes) {
            if (episodeInfo.deletedMarkers) {
                for (const deleted of episodeInfo.deletedMarkers) {
                    const deleteShow = deletes[deleted.showId] ??= {};
                    (deleteShow[deleted.seasonId] ??= []).push(new MarkerData().setFromJson(deleted));
                    ++deleteCount;
                }
            }

            const marker = episodeInfo.changedMarker;
            if (!marker) { continue; }

            const mapToUse = episodeInfo.isAdd ? adds : edits;
            mapToUse[marker.showId] ??= {};
            (mapToUse[marker.showId][marker.seasonId] ??= []).push(new MarkerData().setFromJson(marker));
            episodeInfo.isAdd ? ++addCount : ++editCount;
        }

        BulkActionCommon.flashButton('bulkAddApply', ThemeColors.Green, 500).then(() => {
            Overlay.show(`<h2>Bulk Add Succeeded</h2><hr>` +
                `Markers Added: ${addCount}<br>` +
                `Markers Edited: ${editCount}<br>` +
                `Markers Deleted: ${deleteCount}<br>` +
                `Episodes Ignored: ${result.ignoredEpisodes.length}`);
        });


        // Need to do this more efficiently. We can duplicate lots of server calls by separating these three.
        // Like bulk-restoring, the duplication of calls can lead to invalid marker breakdown calculations. The
        // global "inBulkOperation" flag attempts to work around this without addressing the underlying issue.
        PlexClientState.setInBulkOperation(true);
        try {
            await PlexClientState.notifyBulkActionChange(deletes, BulkActionType.Delete);
            await PlexClientState.notifyBulkActionChange(adds, BulkActionType.Add);
            await PlexClientState.notifyBulkActionChange(edits, BulkActionType.Shift);
        } finally {
            PlexClientState.setInBulkOperation(false);
        }
    }

    /**
     * Request current marker statistics for the given episode group to check whether
     * a bulk add will conflict with anything. */
    async #check() {
        try {
            this.#serverResponse = await ServerCommands.checkBulkAdd(this.#mediaItem.metadataId);
            await this.#showCustomizeTable();
        } catch (err) {
            errorResponseOverlay('Unable to check bulk add, please try again later', err, this.show.bind(this));
        }
    }

    /**
     * Displays a table of all episodes in the group, with color coded columns
     * to let the user know when a marker add will fail/be merged with existing markers. */
    async #showCustomizeTable() {
        this.#table?.remove();
        this.#table = new BulkActionTable();

        this.#table.buildTableHead('Episode', 'Title', TableElements.shortTimeColumn('Start'), TableElements.shortTimeColumn('End'));

        const episodeData = Object.values(this.#serverResponse.episodeMap).sort((a, b) => {
            if (a.episodeData.seasonIndex !== b.episodeData.seasonIndex) {
                return a.episodeData.seasonIndex - b.episodeData.seasonIndex;
            }

            return a.episodeData.index - b.episodeData.index;
        });

        // There's a potential race condition here if our initial chapter query is slow and the user
        // immediately clicks 'customize'. As a fuzzy fix, and to avoid blocking the initial UI
        // waiting for chapter data, wait a bit here for the data to come in.
        if (this.#chapterMap === undefined) {
            Log.warn(`Chapter data not available, waiting a couple seconds before ignoring chapter data.`);
            ButtonCreator.setIcon($('#bulkAddCustomize'), Icons.Loading, ThemeColors.Primary);
            try {
                await waitFor(() => this.#chapterMap, 4000);
            } catch {
                Log.error(`Chapter data took too long, cannot use chapter data for this customization table.`);
            }

            ButtonCreator.setIcon($('#bulkAddCustomize'), Icons.Table, ThemeColors.Primary);
        }

        for (const episodeInfo of episodeData) {
            this.#table.addRow(new BulkAddRow(this, episodeInfo, this.#chapterMap?.[episodeInfo.episodeData.metadataId] ?? []));
        }

        $('#bulkActionContainer').appendChild(this.#table.html());
        this.#updateTableStats();
    }

    startTime() { return this.#cachedStart; }
    endTime() { return this.#cachedEnd; }
    resolveType() { return this.#stickySettings.applyType(); }
    /** @returns {string} */
    markerType() { return $('#markerTypeSelect').value; }
    /** @returns {boolean} */
    chapterMode() { return $('#timeZone').classList.contains('hidden'); }
    chapterStart() { return this.#cachedChapterStart; }
    chapterEnd() { return this.#cachedChapterEnd; }
    chapterIndexMode() { return this.#stickySettings.chapterIndexMode(); }

    /** Update all items in the customization table, if present. */
    #updateTableStats() {
        this.#table?.rows().forEach(row => row.update());
    }
}

/**
 * Enumerates possible match types when attempting to correlate
 * the baseline episode's chapters to a given row.
 * @enum */
const ChapterMatchMode = {
    /** @readonly We're in raw time input mode */
    Disabled : 0,
    /** @readonly We found a chapter with the same name as the baseline. */
    NameMatch : 1,
    /** @readonly We found a chapter with the same timestamp as the baseline. */
    TimestampMatch : 2,
    /** @readonly The user is using index mode, and we found a chapter at the same index. */
    IndexMatch : 3,
    /** @readonly We're returning the marker closest to the baseline, but it doesn't match exactly. */
    Fuzzy : 4,
    /** @readonly This item has no markers. */
    NoMatch : 5,
};

/**
 * Represents a single row in the bulk add customization table.
 */
class BulkAddRow extends BulkActionRow {
    /** @type {BulkAddOverlay} */
    #parent;
    /** @type {SerializedEpisodeData} */
    #episodeInfo;
    /** @type {HTMLTableCellElement} */
    #titleTd;
    /** @type {HTMLTableCellElement} */
    #startTd;
    /** @type {HTMLTableCellElement} */
    #endTd;
    /** @type {SerializedMarkerData[]} */
    #existingMarkers;
    /** @type {ChapterData[]} */
    #chapters;

    /**
     * @param {BulkAddOverlay} parent
     * @param {SerializedBulkAddResultEntry} episodeInfo
     * @param {ChapterData[]} chapters */
    constructor(parent, episodeInfo, chapters) {
        super(parent.table(), episodeInfo.episodeData.metadataId);
        this.#parent = parent;
        this.#episodeInfo = episodeInfo.episodeData;
        this.#existingMarkers = episodeInfo.existingMarkers;
        this.#chapters = chapters;
    }

    /** Create and return the table row.
     * @returns {HTMLTableRowElement} */
    build() {
        const startTime = this.#parent.startTime();
        const endTime = this.#parent.endTime();
        this.buildRow(
            this.createCheckbox(true, null /*mid*/, this.#episodeInfo.metadataId),
            `S${pad0(this.#episodeInfo.seasonIndex, 2)}E${pad0(this.#episodeInfo.index, 2)}`,
            this.#episodeInfo.title,
            isNaN(startTime) ? '-' : TableElements.timeData(endTime),
            isNaN(endTime) ? '-' : TableElements.timeData(endTime));
        this.#titleTd = this.row.children[2];
        this.#startTd = this.row.children[3];
        this.#endTd = this.row.children[4];
        return this.row;
    }

    /**
     * Return the start timestamp for this row, and the type of match we made to calculate it. */
    #calculateStart() {
        return this.#calculateStartEnd('start', this.#parent.chapterStart());
    }

    /**
     * Same as #calculateStart, but for the end timestamp. */
    #calculateEnd(min=-1) {
        return this.#calculateStartEnd('end', this.#parent.chapterEnd(), min);
    }

    /**
     * Return the start and end timestamp for this row. */
    getChapterTimestampData() {
        Log.assert(this.#parent.chapterMode(), `We should be in chapterMode if we're calling getChapterTimestampData`);
        const start = this.#calculateStartEnd('start', this.#parent.chapterStart()).time;
        return {
            start : start,
            end : this.#calculateStartEnd('end', this.#parent.chapterEnd(), start).time
        };
    }

    /**
     * Find the best timestamp for this row based on the bulk add type (raw/chapter)
     * @param {'start'|'end'} type
     * @param {ChapterData} baseline
     * @param {number} min
     * @returns {{ mode : number, time : number }} */
    #calculateStartEnd(type, baseline, min=-1) {
        if (!this.#parent.chapterMode()) {
            return {
                mode : ChapterMatchMode.Disabled,
                time : realMs(this.#parent[type + 'Time'](), this.#episodeInfo.duration),
            };
        }

        const baselineTime = baseline[type];
        if (this.#chapters.length === 0) {
            // No chapters to correlate, use the chapter time directly.
            return {
                mode : ChapterMatchMode.NoMatch,
                time : baselineTime,
            };
        }

        // Exact name match trumps all
        const nameMatches = this.#chapters.filter(c => c.name.length !== 0 && c.name === baseline.name);
        if (nameMatches.length > 0) {
            let closest = nameMatches[0][type];
            for (const chapter of nameMatches) {
                const chapterTime = chapter[type];
                if (Math.abs(baselineTime - closest) > Math.abs(baselineTime - chapter[type])) {
                    closest = chapterTime;
                }
            }

            return {
                mode : ChapterMatchMode.NameMatch,
                time : closest,
            };
        }

        // If the user selects 'index mode', ignore timestamps and just
        // pick the chapter with the same index (if it exists)
        if (this.#parent.chapterIndexMode() && this.#chapters.length > baseline.index) {
            return {
                mode : ChapterMatchMode.IndexMatch,
                time : this.#chapters[baseline.index][type]
            };
        }

        // If no name match, find the chapter with the closest timestamp, or index.
        let index = 0;
        while (index < this.#chapters.length && this.#chapters[index][type] <= min) {
            ++index;
        }

        // All timestamps are less than the minimum. This shouldn't happen, but just
        // return the last chapter.
        if (index === this.#chapters.length) {
            return {
                mode : ChapterMatchMode.Fuzzy,
                time : this.#chapters[this.#chapters.length - 1][type],
            };
        }

        let fuzzyTime = this.#chapters[index][type];
        for (; index < this.#chapters.length; ++index) {
            const chapterTime = this.#chapters[index][type];
            if (chapterTime === baselineTime) {
                return {
                    mode : ChapterMatchMode.TimestampMatch,
                    time : chapterTime,
                };
            }

            if (Math.abs(baselineTime - fuzzyTime) > Math.abs(baselineTime - chapterTime)) {
                fuzzyTime = chapterTime;
            }
        }

        return {
            mode : ChapterMatchMode.Fuzzy,
            time : fuzzyTime,
        };
    }

    /**
     * Update the text/colors of this row. */
    /* eslint-disable-next-line complexity */ // TODO: eslint is right, this needs to be broken up
    update() {
        if (!this.enabled) {
            this.row.classList.add('bulkActionInactive');
            this.#clear(true /*clearText*/);
            return;
        }

        this.row.classList.remove('bulkActionInactive');

        const startData = this.#calculateStart();
        const startTimeBase = startData.time;
        const endData = this.#calculateEnd(startTimeBase);
        const endTimeBase = endData.time;
        const resolveType = this.#parent.resolveType();
        const warnClass = resolveType === BulkMarkerResolveType.Merge ? 'bulkActionSemi' : 'bulkActionOff';
        this.#clear();
        let start = startTimeBase;
        let end = endTimeBase;
        let semiWarn = false;
        let isWarn = false;
        let tooltip = '';
        if (isNaN(startTimeBase) || isNaN(endTimeBase)) {
            tooltip = 'Invalid start or end time.';
        } else if (startTimeBase >= endTimeBase) {
            tooltip = `Start time is greater than end time:<br> ` +
                `Start: ${msToHms(startTimeBase)}<br>End: ${msToHms(endTimeBase)}`;
        } else if (startTimeBase < 0 || endTimeBase < 0) {
            tooltip = `Negative timestamp:<br>Start: ${msToHms(startTimeBase)}<br>End: ${msToHms(endTimeBase)}`;
        }

        if (tooltip) {
            this.#startTd.innerText = '--:--:--.---';
            this.#endTd.innerText = '--:--:--.---';
            this.#setClassBoth(warnClass);
            Tooltip.setTooltip(this.#startTd, tooltip);
            Tooltip.setTooltip(this.#endTd, tooltip);
            return;
        }

        for (const existingMarker of this.#existingMarkers) {
            // [Existing...{New++]---} or [Existing...{New++}...]
            if (start >= existingMarker.start && start <= existingMarker.end) {
                isWarn = true;
                semiWarn = false;
                this.#startTd.classList.add(warnClass);
                if (end < existingMarker.end) {
                    this.#setSingleClass(this.#endTd, warnClass);
                }

                tooltip += `<br>Overlaps with existing marker [${msToHms(existingMarker.start)}-${msToHms(existingMarker.end)}]`;

                if (resolveType === BulkMarkerResolveType.Merge) {
                    start = existingMarker.start;
                    end = Math.max(end, existingMarker.end);
                }
            // {New---[Existing++}...] or [Existing...{New+++}...]
            } else if (end >= existingMarker.start && end <= existingMarker.end) {
                isWarn = true;
                semiWarn = false;
                this.#setSingleClass(this.#endTd, warnClass);
                tooltip += `<br>Overlaps with existing marker [${msToHms(existingMarker.start)}-${msToHms(existingMarker.end)}]`;
                if (resolveType === BulkMarkerResolveType.Merge) {
                    start = Math.min(start, existingMarker.start);
                }

                this.#startTd.classList.add(warnClass);
            // {New---[Existing+++]---}
            } else if (start <= existingMarker.start && end >= existingMarker.end) {
                isWarn = true;
                semiWarn = false;
                this.#setClassBoth(warnClass);
                tooltip += `<br>Overlaps with existing marker [${msToHms(existingMarker.start)}-${msToHms(existingMarker.end)}]`;

                this.#startTd.classList.add(warnClass);
            }
        }

        if (end > this.#episodeInfo.duration) {
            isWarn = true;
            if (!this.#endTd.classList.contains('bulkActionOff')) {
                semiWarn = true;
                this.#endTd.classList.add('bulkActionSemi');
            }

            tooltip += `<br>End exceeds episode duration of ${msToHms(this.#episodeInfo.duration)}.`;
            end = this.#episodeInfo.duration;
            start = Math.min(start, end);
        }

        if (start >= this.#episodeInfo.duration) {
            isWarn = true;
            // setSingle instead of setBoth to ensure it overwrites anything set above.
            this.#setSingleClass(this.#startTd, 'bulkActionOff');
            this.#setSingleClass(this.#endTd, 'bulkActionOff');
            tooltip = `<br>Marker is beyond the end of the episode.`;
        }

        if (tooltip.length === 0) {
            Tooltip.removeTooltip(this.#startTd);
            Tooltip.removeTooltip(this.#endTd);
        } else {
            tooltip = tooltip.substring(4);
            Tooltip.setTooltip(this.#startTd, tooltip);
            Tooltip.setTooltip(this.#endTd, tooltip);
        }

        if (!isWarn) {
            this.#setClassBoth('bulkActionOn');
        }

        if (resolveType === BulkMarkerResolveType.Ignore && isWarn && !semiWarn) {
            this.row.classList.add('bulkActionInactive');
        } else {
            this.row.classList.remove('bulkActionInactive');
        }

        this.#startTd.innerText = msToHms(start);
        this.#endTd.innerText = msToHms(end);
        this.#setChapterMatchModeText(startData.mode, endData.mode);
    }

    /**
     * Sets title classes and tooltips depending on the bulk add mode and how
     * confident we are about chapter matches if in chapter mode.
     * @param {number} startMode
     * @param {number} endMode
     * @returns {void} */
    // eslint-disable-next-line complexity
    #setChapterMatchModeText(startMode, endMode) {
        // In "normal" mode - nothing extra to do.
        if (startMode === ChapterMatchMode.Disabled) {
            Log.assert(endMode === ChapterMatchMode.Disabled, `endData.mode === ChapterMatchMode.Disabled`);
            return;
        }

        // Use the title column to indicate how confident we are about the timestamps we're adding.
        // * If the start *and* end have either a chapter name or chapter timestamp match, green
        // * If the start *xor* end have a name/time match, yellow
        // * If the start *and* end *don't* have a name/time match, yellow // TODO: red if _way_ off from baseline
        // * If the episode has no chapter data, red

        const setTitleInfo = (state, tooltip) => {
            this.#setSingleClass(this.#titleTd, state);
            Tooltip.setTooltip(this.#titleTd, tooltip);
        };

        if (startMode === ChapterMatchMode.NoMatch) {
            Log.assert(endMode === ChapterMatchMode.NoMatch, `endData.mode === ChapterMatchMode.NoMatch`);
            return setTitleInfo('bulkActionOff', 'No chapter data found for this episode, using baseline chapter values.');
        }

        switch (startMode) {
            case ChapterMatchMode.NameMatch:
                switch (endMode) {
                    case ChapterMatchMode.NameMatch:
                        return setTitleInfo('bulkActionOn', 'This episode has matching chapter name data.');
                    case ChapterMatchMode.TimestampMatch:
                    case ChapterMatchMode.IndexMatch:
                        return setTitleInfo('bulkActionOn', 'This episode has matching chapter data.');
                    case ChapterMatchMode.Fuzzy:
                        return setTitleInfo('bulkActionSemi',
                            'Start chapter has a match, but end chapter does not, using closest timestamp.');
                    default:
                        return Log.warn(`Unexpected ChapterMatchMode ${endMode}`);
                }
            case ChapterMatchMode.TimestampMatch:
                switch (endMode) {
                    case ChapterMatchMode.NameMatch:
                    case ChapterMatchMode.IndexMatch:
                        return setTitleInfo('bulkActionOn', 'This episode has matching chapter data.');
                    case ChapterMatchMode.TimestampMatch:
                        return setTitleInfo('bulkActionOn', 'This episode has matching chapter timestamp data.');
                    case ChapterMatchMode.Fuzzy:
                        return setTitleInfo('bulkActionSemi',
                            'Start chapter has a timestamp match, but end chapter does not, using closest timestamp.');
                    default:
                        return Log.warn(`Unexpected ChapterMatchMode ${endMode}`);
                }
            case ChapterMatchMode.IndexMatch:
                switch (endMode) {
                    case ChapterMatchMode.TimestampMatch:
                    case ChapterMatchMode.NameMatch:
                        return setTitleInfo('bulkActionOn', 'This episode has matching chapter data.');
                    case ChapterMatchMode.IndexMatch:
                        return setTitleInfo('bulkActionOn', 'This episode has matching chapter index data.');
                    case ChapterMatchMode.Fuzzy:
                        return setTitleInfo('bulkActionSemi',
                            'Start chapter has an index match, but end chapter does not, using closest timestamp.');
                    default:
                        return Log.warn(`Unexpected ChapterMatchMode ${endMode}`);
                }
            case ChapterMatchMode.Fuzzy:
                switch (endMode) {
                    case ChapterMatchMode.NameMatch:
                        return setTitleInfo('bulkActionSemi',
                            'End chapter has a match, but start does not. Using closest timestamp.');
                    case ChapterMatchMode.TimestampMatch:
                        return setTitleInfo('bulkActionSemi',
                            'End chapter has a timestamp match, but start does not. Using closest timestamp.');
                    case ChapterMatchMode.IndexMatch:
                        return setTitleInfo('bulkActionSemi',
                            'End chapter has an index match, but start does not. Using closest timestamp');
                    case ChapterMatchMode.Fuzzy:
                        return setTitleInfo('bulkActionSemi', 'No matching chapters found, using chapter with the closest timestamps.');
                    default:
                        return Log.warn(`Unexpected ChapterMatchMode ${endMode}`);
                }
            default:
                return Log.warn(`Unexpected ChapterMatchMode ${endMode}`);
        }
    }

    /**
     * Clears any custom classes of the start/end columns.
     * @param {boolean} clearText Whether to also reset the start/end time text. */
    #clear(clearText=false) {
        if (clearText) {
            for (const td of [this.#startTd, this.#endTd]) {
                if (clearText) {
                    td.innerText = '--:--:--.---';
                }
            }
        }

        for (const td of [this.#titleTd, this.#startTd, this.#endTd]) {
            td.classList.remove('bulkActionOn');
            td.classList.remove('bulkActionOff');
            td.classList.remove('bulkActionSemi');
            Tooltip.removeTooltip(td);
        }
    }

    /**
     * Add the given class to both the start and end columns.
     * @param {string} className */
    #setClassBoth(className) {
        this.#startTd.classList.add(className);
        this.#endTd.classList.add(className);
    }

    /**
     * Add the given class to both the start and end columns, clearing out any other custom classes.
     * @param {HTMLTableCellElement} td
     * @param {string} className */
    #setSingleClass(td, className) {
        td.classList.remove('bulkActionOn');
        td.classList.remove('bulkActionOff');
        td.classList.remove('bulkActionSemi');
        td.classList.add(className);
    }
}

export default BulkAddOverlay;
