import { $, appendChildren, buildNode, msToHms, pad0, ServerCommand, timeInputShortcutHandler, timeToMs } from './Common.js';
import { ContextualLog } from '../../Shared/ConsoleLog.js';

import Overlay from './inc/Overlay.js';

import { BulkActionCommon, BulkActionRow, BulkActionTable, BulkActionType } from './BulkActionCommon.js';
import ButtonCreator from './ButtonCreator.js';
import { PlexClientState } from './PlexClientState.js';
import TableElements from './TableElements.js';

/** @typedef {!import('../../Shared/PlexTypes').EpisodeData} EpisodeData */
/** @typedef {!import('../../Shared/PlexTypes').SeasonData} SeasonData */
/** @typedef {!import('../../Shared/PlexTypes').SerializedMarkerData} SerializedMarkerData */
/** @typedef {!import('../../Shared/PlexTypes').SerializedEpisodeData} SerializedEpisodeData */
/** @typedef {!import('../../Shared/PlexTypes').ShiftResult} ShiftResult */
/** @typedef {!import('../../Shared/PlexTypes').ShowData} ShowData */

/**
 * @typedef {Object} IgnoreInfo
 * @property {number[]} ignored List of ignored marker ids
 * @property {boolean} tableVisible Whether the customization table is visible
 * @property {boolean} hasUnresolved Whether any markers are in an unresolved state
 * @property {boolean} hasCutoff Whether any markers are partially cut off by the shift
 * @property {boolean} hasError Whether any markers are completely cut off by the shift
 */

const Log = new ContextualLog('BulkShift');

/**
 * UI for bulk shifting markers for a given show/season by a set amount of time.
 */
class BulkShiftOverlay {
    /** @type {ShowData|SeasonData} */
    #mediaItem;

    /** @type {HTMLInputElement} */
    #startTimeInput;

    /** @type {HTMLInputElement} */
    #endTimeInput;

    /** @type {boolean} */
    #separateShift = false;

    /**
     * Timer id to track shift user input.
     * @type {number} */
    #inputTimer;

    /** @type {BulkActionTable} */
    #table;

    /** @type {number} Cached start shift time, in milliseconds */
    #startShiftMs;

    /** @type {number} Cached end shift time, in milliseconds */
    #endShiftMs;

    /**
     * Construct a new shift overlay.
     * @param {ShowData|SeasonData} mediaItem */
    constructor(mediaItem) {
        this.#mediaItem = mediaItem;
    }

    /** 
     * Keeps track of markers without existing rows, so we can add them to the ignored markers table later
     * @type {Array} */
    #markersWithoutRows = [];

    /**
     * Launch the bulk shift overlay.
     * @param {HTMLElement} focusBack The element to set focus back to after the bulk overlay is dismissed. */
    show(focusBack) {
        const container = buildNode('div', { id : 'bulkActionContainer' });
        const title = buildNode('h1', {}, `Shift Markers for ${this.#mediaItem.title}`);
        this.#startTimeInput = buildNode(
            'input', {
                type : 'text',
                placeholder : 'ms or mm:ss[.000]',
                name : 'shiftStartTime',
                id : 'shiftStartTime'
            },
            0,
            { keyup : this.#onTimeShiftChange.bind(this),
              keydown : timeInputShortcutHandler });

        this.#endTimeInput = buildNode('input',
            {   type : 'text',
                placeholder : 'ms or mm:ss[.000]',
                name : 'shiftEndTime',
                id : 'shiftEndTime',
                class : 'hidden' },
            0,
            { keyup : this.#onTimeShiftChange.bind(this),
              keydown : timeInputShortcutHandler });

        const separateShiftCheck = buildNode(
            'input', {
                type : 'checkbox',
                name : 'separateShiftCheck',
                id : 'separateShiftCheck'
            });

        separateShiftCheck.addEventListener('change', this.#onSeparateShiftChange.bind(this, separateShiftCheck));
        appendChildren(container,
            title,
            buildNode('hr'),
            appendChildren(buildNode('div', { id : 'shiftZone' }),
                buildNode('label', { for : 'shiftStartTime', id : 'shiftStartTimeLabel' }, 'Time shift: '),
                this.#startTimeInput,
                buildNode('label', { for : 'shiftEndTime', class : 'hidden', id : 'shiftEndTimeLabel' }, 'End shift: '),
                this.#endTimeInput),
            appendChildren(buildNode('div', { id : 'expandShrinkCheck' }),
                buildNode('label', { for : 'separateShiftCheck' }, 'Shift start and end times separately: '),
                separateShiftCheck),
            appendChildren(buildNode('div', { id : 'bulkShiftMarkerType' }),
                buildNode('label', { for : 'markerTypeSelect' }, 'Select Marker Type: '),
                appendChildren(
                    buildNode('select', { id : 'markerTypeSelect' }, 0, { change : this.#onMarkerTypeSelectChange.bind(this) }),
                    buildNode('option', { value : 'both', selected : 'selected' }, 'Both'),
                    buildNode('option', { value : 'intro' }, 'Intro'),
                    buildNode('option', { value : 'credits' }, 'Credits'))
            ),
            appendChildren(buildNode('div', { id : 'bulkActionButtons' }),
                ButtonCreator.textButton('Apply',
                    this.#tryApply.bind(this),
                    {
                        id : 'shiftApply',
                        tooltip : 'Attempt to apply the given time shift. ' +
                                  'Brings up customization menu if any markers have multiple episodes.'
                    }),
                ButtonCreator.textButton('Force Apply',
                    this.#forceApply.bind(this),
                    {
                        id : 'shiftForceApplyMain',
                        class : 'shiftForceApply',
                        tooltip : 'Force apply the given time shift to all selected markers, even if some episodes have multiple markers.'
                    }),
                ButtonCreator.textButton('Customize',
                    this.#check.bind(this),
                    { tooltip : 'Bring up the list of all applicable markers and selective choose which ones to shift.' }),
                ButtonCreator.textButton('Cancel', Overlay.dismiss)
            )
        );

        Overlay.build({
            dismissible : true,
            closeButton : true,
            forceFullscreen : true,
            focusBack : focusBack }, container);
    }

    /**
     * @param {KeyboardEvent} e */
    #onTimeShiftChange(e) {
        clearTimeout(this.#inputTimer);
        this.#checkShiftValue();
        if (!this.#table) {
            return;
        }

        if (e.key == 'Enter') {
            this.#adjustNewTimes();
            return;
        }

        this.#inputTimer = setTimeout(this.#adjustNewTimes.bind(this), 250);
    }

    /**
     * Update UI when the user enables/disables the 'separate start/end' checkbox
     * @param {HTMLInputElement} checkbox */
    #onSeparateShiftChange(checkbox) {
        this.#separateShift = checkbox.checked;
        if (!this.#separateShift) {
            $('#shiftStartTimeLabel').innerText = 'Time shift: ';
            $('#shiftEndTimeLabel').classList.add('hidden');
            this.#endTimeInput.classList.add('hidden');
        } else {
            $('#shiftStartTimeLabel').innerText = 'Start shift: ';
            $('#shiftEndTimeLabel').classList.remove('hidden');
            this.#endTimeInput.classList.remove('hidden');
            if (!this.#endTimeInput.value) { this.#endTimeInput.value = this.#startTimeInput.value; }

            this.#checkShiftValue();
        }

        this.#adjustNewTimes();
    }

    /**
     * Adjust the styling of all rows in the customize table after
     * the shift changes. */
    #adjustNewTimes() {
        this.#table?.rows().forEach(row => row.update());
    }

    /** Refresh/Show the custom markers list when a type is selected*/
    #onMarkerTypeSelectChange(checkbox) {
        this.#check();
    }

    /**
 * Map of error messages
     * @type {{[messageType: string]: string}}
     * @readonly */
    #messages = {
        unresolved : 'Some episodes have multiple markers, please resolve below or Force Apply.',
        unresolvedAgain : 'Are you sure you want to shift markers with unresolved conflicts? Anything unchecked will not be shifted.',
        cutoff : 'The current shift will cut off some markers. Are you sure you want to continue?',
        error : 'The current shift completely moves at least one selected marker beyond the bounds of the episode.<br>' +
                'Do you want to ignore those and continue?',
        unresolvedPlus : 'Are you sure you want to shift markers with unresolved conflicts? Anything unchecked will not be shifted.<br>' +
                         'Additionally, some markers are either cut off or completely beyond the bounds of an episode (or both).<br>' +
                         'Cut off markers will be applied and invalid markers will be ignored.',
        cutoffPlus : 'The current shift will cut off some markers, and ignore markers beyond the bounds of the episode.<br>' +
                     'Are you sure you want to continue?',
        invalidOffset : `Couldn't parse time offset, make sure it's valid.`
    };

    /**
     * Display a message in the bulk shift overlay.
     * @param {string} messageType
     * @param {boolean} addForceButton True to also add an additional 'force apply' button below the message */
    #showMessage(messageType, addForceButton=false) {
        let message = this.#messages[messageType];
        if (!message) {
            Log.warn(messageType, 'Attempting to show an invalid error message');
            message = 'The shift could not be applied, please try again later.';
        }

        const attributes = { id : 'resolveShiftMessage', resolveMessage : messageType };
        let node;
        if (addForceButton) {
            node = appendChildren(buildNode('div', attributes),
                buildNode('h4', {}, message),
                ButtonCreator.textButton(
                    'Force shift',
                    this.#forceApply.bind(this),
                    { id : 'shiftForceApplySub', class : 'shiftForceApply' })
            );
        } else {
            node = buildNode('h4', attributes, message);
        }

        const container = $('#bulkActionContainer');
        const currentNode = $('#resolveShiftMessage');
        if (currentNode) {
            container.insertBefore(node, currentNode);
            container.removeChild(currentNode);
            return;
        }

        const customizeTable = this.#table?.html();
        if (customizeTable) {
            container.insertBefore(node, customizeTable);
        } else {
            container.appendChild(node);
        }
    }

    /**
     * Return the current message type, or false if there isn't one showing.
     * @returns {string|false} */
    #getMessageType() {
        const message = $('#resolveShiftMessage');
        if (!message) {
            return false;
        }

        return message.getAttribute('resolveMessage');
    }

    /**
     * Attempts to apply the given shift to all markers under the given metadata id.
     * If any episode has multiple markers, shows the customization table. */
    async #tryApply() {
        const startShift = this.shiftStartValue();
        const endShift = this.shiftEndValue();
        if (isNaN(startShift) || isNaN(endShift) || (!startShift && !endShift)) {
            this.#checkShiftValue();
            this.#showMessage('invalidOffset');
            return BulkActionCommon.flashButton('shiftApply', 'red');
        }

        const ignoreInfo = this.#getIgnored();
        if (ignoreInfo.hasUnresolved) {
            return this.#warnAboutUnresolvedMarkers(ignoreInfo);
        }

        if (ignoreInfo.hasCutoff) {
            return this.#showMessage(ignoreInfo.hasError ? 'cutoff' : 'cutoffPlus', true);
        }

        if (ignoreInfo.hasError) {
            return this.#showMessage('error', true);
        }

        const shiftResult = await ServerCommand.shift(
            this.#mediaItem.metadataId,
            startShift, endShift,
            false /*force*/,
            ignoreInfo.ignored);

        if (shiftResult.applied) {
            const markerMap = BulkActionCommon.markerMapFromList(shiftResult.allMarkers);
            PlexClientState.notifyBulkActionChange(markerMap, BulkActionType.Shift);
            await BulkActionCommon.flashButton('shiftApply', 'green');

            Overlay.dismiss();
            return;
        }

        Log.assert(
            shiftResult.conflict || shiftResult.overflow,
            `We should only have !applied && !conflict during check_shift, not shift. What happened?`);

        this.#showMessage(shiftResult.overflow ? 'error' : 'unresolved', shiftResult.overflow);
        this.#showCustomizeTable(shiftResult);
    }

    /**
     * Indicate to the user that unresolved markers are preventing the operating from completing.
     * @param {IgnoreInfo} ignoreInfo */
    async #warnAboutUnresolvedMarkers(ignoreInfo) {
        Log.assert(this.#table, `How do we know we have unresolved markers if the table isn't showing?`);

        // If we've already shown the warning
        const existingMessage = this.#getMessageType();
        if (existingMessage && existingMessage != 'unresolvedPlus' && (ignoreInfo.hasCutoff || ignoreInfo.hasCutoff)) {
            return this.#showMessage('unresolvedPlus', true);
        }

        if (existingMessage && existingMessage != 'unresolvedAgain') {
            return this.#showMessage('unresolvedAgain', true);
        }

        // If we are already showing the force shift subdialog, just flash the button
        if (existingMessage == 'unresolvedAgain' || existingMessage == 'unresolvedPlus') {
            return BulkActionCommon.flashButton('shiftApply', 'red');
        }

        this.#showMessage('unresolved');
        if (!this.#table) {
            this.#check();
        }

        return;
    }

    /**
     * Force applies the given shift to all markers under the given metadata id. */
    async #forceApply() {
        const startShift = this.shiftStartValue();
        const endShift = this.shiftEndValue();
        if (isNaN(startShift) || isNaN(endShift) || (!startShift && !endShift)) {
            $('.shiftForceApply').forEach(f => BulkActionCommon.flashButton(f, 'red'));
        }

        // Brute force through everything, applying to all checked items (or all items if the conflict table isn't showing)
        const ignoreInfo = this.#getIgnored();
        try {
            const shiftResult = await ServerCommand.shift(
                this.#mediaItem.metadataId,
                startShift,
                endShift,
                true /*force*/,
                ignoreInfo.ignored);

            if (!shiftResult.applied) {
                Log.assert(shiftResult.overflow, `Force apply should only fail if overflow was found.`);
                this.#showCustomizeTable(shiftResult);
                this.#showMessage('error', true);
                return;
            }

            const markerMap = BulkActionCommon.markerMapFromList(shiftResult.allMarkers);
            PlexClientState.notifyBulkActionChange(markerMap, BulkActionType.Shift);
            $('.shiftForceApply').forEach(async f => {
                await BulkActionCommon.flashButton(f, 'green');
                Overlay.dismiss();
            });

        } catch (ex) {
            $('.shiftForceApply').forEach(f => BulkActionCommon.flashButton(f, 'red'));
        }
    }

    /**
     * Retrieves marker information for the current metadata id and displays it in a table for the user. */
    async #check() {
        const shiftResult = await ServerCommand.checkShift(this.#mediaItem.metadataId);
        this.#showCustomizeTable(shiftResult);
    }

    /**
     * Retrieve the current ms time of the start shift input.
     * @returns {number} */
    shiftStartValue() { return this.#startShiftMs; }

    /**
     * Retrieve the current ms time of the end shift input, or the start time if we're not separating the shift.
     * @returns {number} */
    shiftEndValue() { return this.#separateShift ? this.#endShiftMs : this.#startShiftMs; }

    table() { return this.#table; }

    /** Marks the time input red if the shift value is invalid. */
    #checkShiftValue() {
        const checkTime = (val, input) => {
            if (isNaN(val)) {
                input.classList.add('badInput');
            } else {
                input.classList.remove('badInput');
            }
        };

        this.#startShiftMs = timeToMs(this.#startTimeInput.value, true /*allowNegative*/);
        checkTime(this.#startShiftMs, this.#startTimeInput);
        if (this.#separateShift) {
            this.#endShiftMs = timeToMs(this.#endTimeInput.value, true /*allowNegative*/);
            // If end is less than or equal to start, mark it invalid.
            checkTime(this.#endShiftMs, this.#endTimeInput);
        }
    }

    /**
     * Display a table of all markers applicable to this instance's metadata id.
     * @param {ShiftResult} shiftResult */
    #showCustomizeTable(shiftResult) {
        this.#table?.remove();
        this.#table = new BulkActionTable();

        this.#table.buildTableHead(
            'Episode',
            TableElements.shortTimeColumn('Start Time'),
            TableElements.shortTimeColumn('End Time'),
            TableElements.shortTimeColumn('New Start'),
            TableElements.shortTimeColumn('New End')
        );

        const markerTypeSelected = this.markerType();
        const sortedMarkers = BulkActionCommon.sortMarkerList(shiftResult.allMarkers, shiftResult.episodeData);

        this.#markersWithoutRows.length = 0; 

        for (let i = 0; i < sortedMarkers.length; ++i) {
            const checkGroup = [];
            const eInfo = shiftResult.episodeData[sortedMarkers[i].parentId];

            
            if (markerTypeSelected == 'both' || sortedMarkers[i].markerType == markerTypeSelected)  { // If the marker type is selected, prep it for row addition
                checkGroup.push(sortedMarkers[i]);
            }
            else {
                this.#markersWithoutRows.push(sortedMarkers[i].id); // If not then store it for the getIgnored table later
            }
            
            while (i < sortedMarkers.length - 1 && sortedMarkers[i+1].parentId == eInfo.metadataId) {
                i++;
                // Same deal here as above comments
                if (markerTypeSelected == 'both' || sortedMarkers[i].markerType == markerTypeSelected)  { 
                    checkGroup.push(sortedMarkers[i]);
                }
                else this.#markersWithoutRows.push(sortedMarkers[i].id);
            }

            const multiple = checkGroup.length > 1;
            for (const marker of checkGroup) {
                const row = new BulkShiftRow(this, marker, eInfo, multiple);
                this.#table.addRow(row, multiple);
                row.update();
            }
        }

        $('#bulkActionContainer').appendChild(this.#table.html());
    }

    /**
     * Just an intellisense hack.
     * @returns {BulkShiftRow[]} */
    #tableRows() {
        return this.#table.rows();
    }

    /**
     * Return information about ignored markers in the shift table.
     * @returns {IgnoreInfo} */
    #getIgnored() {
        if (!this.#table) {
            return { ignored : [], tableVisible : false, hasUnresolved : false, hasCutoff : false, hasError : false };
        }

        const ignored = this.#table.getIgnored();
        let hasUnresolved = false;
        let hasCutoff = false;
        let hasError = false;
        for (const row of this.#tableRows()) {
            hasUnresolved = hasUnresolved || row.isUnresolved();
            hasCutoff = hasCutoff || row.isCutoff();
            if (row.isError()) {
                hasError = true;
                ignored.push(row.markerId());
            }
        }

        // Add markers with non-existant rows to the ignored list
        for (let i = 0; i < this.#markersWithoutRows.length; i++) {
            ignored.push(this.#markersWithoutRows[i]);
        }

        return {
            ignored : ignored,
            tableVisible : true,
            hasUnresolved : hasUnresolved,
            hasCutoff : hasCutoff,
            hasError  : hasError,
        };
    }
    
    // Copied this from BulkAddOverlay to maintain consistency
    markerType() { return $('#markerTypeSelect').value; } // TODO: store main container and scope to that. 

}

/**
 * Represents a single row in the bulk shift table.
 */
class BulkShiftRow extends BulkActionRow {
    /** @type {BulkShiftOverlay} */
    #parent;
    /** @type {SerializedMarkerData} */
    #marker;
    /** @type {SerializedEpisodeData} */
    #episode;
    /**
     * Whether there are other linked rows that are associated with the same episode
     * @type {boolean} */
    #linked = false;
    /**
     * Caches whether this row was enabled during the last update.
     * @type {boolean} */
    #enabledLastUpdate = null;
    /**
     * Tracks whether this row is partially shifted off the start/end of the episode.
     * Always false if the row is disabled.
     * @type {boolean} */
    #isWarn = false;
    /**
     * Tracks whether this row is completely shifted off the start/end of the episode.
     * Always false if the row is disabled.
     * @type {boolean} */
    #isError = false;

    /**
     * @param {BulkShiftOverlay} parent
     * @param {SerializedMarkerData} marker
     * @param {SerializedEpisodeData} episode
     * @param {boolean} linked Whether other markers with this episode id exist. */
    constructor(parent, marker, episode, linked) {
        super(parent.table(), marker.id);
        this.#parent = parent;
        this.#marker = marker;
        this.#episode = episode;
        this.#linked = linked;
    }

    episodeId() { return this.#marker.parentId; }
    markerId() { return this.#marker.id; }
    /** Returns whether this row is linked to other rows that share the same episode id. */
    linked() { return this.#linked; }
    /** Returns whether any part of the shifted marker in this row is cut off by the start/end of the episode. */
    isCutoff() { return this.#isWarn; }
    /** Returns whether the shifted marker is completely beyond the bounds of the episode. */
    isError() { return this.#isError; }
    /** Returns whether this marker is linked and no linked markers are checked. */
    isUnresolved() { return this.row.children[1].classList.contains('bulkActionSemi'); }

    /** Build and return the marker row. */
    build() {
        const row = this.buildRow(
            this.createCheckbox(!this.#linked, this.#marker.id, this.#marker.parentId, { linked : this.#linked ? 1 : 0 }),
            `S${pad0(this.#episode.seasonIndex, 2)}E${pad0(this.#episode.index, 2)}`,
            TableElements.timeData(this.#marker.start),
            TableElements.timeData(this.#marker.end),
            TableElements.timeData(this.#marker.start),
            TableElements.timeData(this.#marker.end),
        );

        if (this.#linked) {
            BulkShiftClasses.set(row.children[1], BulkShiftClasses.Type.Warn, true);
            this.#markActive(false, row.children[4], row.children[5]);
        } else {
            BulkShiftClasses.set(row.children[1], BulkShiftClasses.Type.On, true);
            this.#markActive(false, row.children[2], row.children[3]);
            row.children[4].classList.add('bulkActionSemi');
            row.children[5].classList.add('bulkActionSemi');
        }

        return this.row;
    }

    /**
     * Mark the given timing nodes as active or inactive.
     * @param {boolean} active
     * @param  {...HTMLElement} nodes */
    #markActive(active, ...nodes) {
        if (active) {
            nodes.forEach(n => n.classList.remove('bulkActionInactive'));
        } else {
            nodes.forEach(n => n.classList.add('bulkActionInactive'));
        }
    }

    /**
     * Adjust the styling of the new start/end values of the given row.
     * If the start/end of the marker is getting cut off, show it in yellow
     * If both the start/end are beyond the bounds of the episode, show both in red.
     * If the row is unchecked, clear all styling. */
    update() {
        this.#isError = false;
        this.#isWarn = false;
        const startShift = this.#parent.shiftStartValue() || 0;
        const endShift = this.#parent.shiftEndValue() || 0;
        if (this.enabled !== this.#enabledLastUpdate) {
            this.#markActive(!this.enabled, this.row.children[2], this.row.children[3]);
            if (!this.enabled) {
                BulkShiftClasses.set(this.row.children[4], BulkShiftClasses.Type.Reset, false);
                BulkShiftClasses.set(this.row.children[5], BulkShiftClasses.Type.Reset, false);
            } else {
                this.#markActive(this.enabled, this.row.children[4], this.row.children[5]);
            }

            this.#enabledLastUpdate = this.enabled;
        }

        const start = this.#marker.start + startShift;
        const end = this.#marker.end + endShift;
        const maxDuration = this.#episode.duration;
        const newStart = Math.max(0, Math.min(start, maxDuration));
        const newEnd = Math.max(0, Math.min(end, maxDuration));
        const newStartNode = this.row.children[4];
        const newEndNode = this.row.children[5];
        newStartNode.innerText = msToHms(newStart);
        newEndNode.innerText = msToHms(newEnd);
        // If we aren't enabled, skip custom coloring.
        if (this.enabled) {
            if (end < 0 || start > maxDuration || end <= start) {
                this.#markActive(true, this.row.children[2], this.row.children[3]);
                [newStartNode, newEndNode].forEach(n => {
                    BulkShiftClasses.set(n, BulkShiftClasses.Type.Error, false);
                });

                this.#isError = true;

                return;
            }

            if (start < 0) {
                BulkShiftClasses.set(newStartNode, BulkShiftClasses.Type.Warn, true);
                this.#isWarn = true;
            } else {
                BulkShiftClasses.set(newStartNode, BulkShiftClasses.Type.On, true);
            }

            if (end > maxDuration) {
                this.#isWarn = true;
                BulkShiftClasses.set(newEndNode, BulkShiftClasses.Type.Warn, true);
            } else {
                BulkShiftClasses.set(newEndNode, BulkShiftClasses.Type.On, true);
            }
        }


        if (!this.#linked) {
            BulkShiftClasses.set(this.row.children[1], this.enabled ? BulkShiftClasses.Type.On : BulkShiftClasses.Type.Error, true);
            return;
        }

        const linkedRows = [];
        let anyChecked = this.enabled;
        for (const row of this.#parent.table().rows()) {
            Log.assert(row instanceof BulkShiftRow, `How did a non-shift row get here?`);
            if (row.episodeId() == this.episodeId()) {
                linkedRows.push(row);
                anyChecked = anyChecked || row.enabled;
            }
        }

        for (const linkedRow of linkedRows) {
            if (anyChecked) {
                BulkShiftClasses.set(
                    linkedRow.row.children[1],
                    linkedRow.enabled ? BulkShiftClasses.Type.On : BulkShiftClasses.Type.Error,
                    true);
            } else {
                BulkShiftClasses.set(linkedRow.row.children[1], BulkShiftClasses.Type.Warn, true);
            }
        }
    }

}

/**
 * Small helper to apply styles to a table item. */
const BulkShiftClasses = {
    classNames : ['bulkActionOn', 'bulkActionOff', 'bulkActionSemi'],
    Type : {
        Reset : -1,
        On    :  0,
        Error :  1,
        Warn  :  2,
    },
    /**
     * Set the class of the given node.
     * @param {HTMLTableCellElement} node
     * @param {number} idx BulkShiftClasses.Type value
     * @param {boolean} active Whether this node is active */
    set : (node, idx, active) => {
        const names = BulkShiftClasses.classNames;
        active ? node.classList.remove('bulkActionInactive') : node.classList.add('bulkActionInactive');
        if (idx == -1) {
            node.classList.remove(names[0]);
            node.classList.remove(names[1]);
            node.classList.remove(names[2]);
            return;
        }

        if (!node.classList.contains(names[idx])) {
            for (let i = 0; i < names.length; ++i) {
                i == idx ? node.classList.add(names[i]) : node.classList.remove(names[i]);
            }
        }
    }
};

export default BulkShiftOverlay;
