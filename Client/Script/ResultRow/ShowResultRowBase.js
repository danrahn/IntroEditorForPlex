import { ResultRow } from './ResultRow.js';

import { $$, $div, $span } from '../HtmlHelpers.js';
import { ContextualLog } from '/Shared/ConsoleLog.js';
import { plural } from '../Common.js';
import { PurgedMarkers } from '../PurgedMarkerManager.js';

const Log = ContextualLog.Create('ShowRowBase');

/**
 * Base class for a show result row, either a "real" one or a title placeholder.
 */
export class ShowResultRowBase extends ResultRow {

    /** @param {ShowData} show */
    constructor(show) {
        super(show, 'topLevelResult showResult');
    }

    /** Whether this row is a placeholder title row, used when a specific show/season is selected. */
    titleRow() { return false; }

    /**
     * Return the underlying show data associated with this result row.
     * @returns {ShowData} */
    show() { return this.mediaItem(); }

    /**
     * Callback to invoke when the row is clicked.
     * @returns {(e: MouseEvent) => any|null} */
    onClick() { return null; }

    /**
     * Creates a DOM element for this show.
     * Each entry contains three columns - the show name, the number of seasons, and the number of episodes. */
    buildRow() {
        if (this.html()) {
            Log.warn('buildRow has already been called for this ShowResultRow, that shouldn\'t happen');
            return this.html();
        }

        const show = this.show();
        const titleNode = $div({}, show.title);
        if (show.originalTitle) {
            titleNode.appendChild($span(` (${show.originalTitle})`, { class : 'resultRowAltTitle' }));
        }

        const customColumn = $div({ class : 'showResultSeasons' }, plural(show.seasonCount, 'Season'));
        const row = this.buildRowColumns(titleNode, customColumn, this.onClick());

        this.setHtml(row);
        return row;
    }

    /**
     * Returns the callback invoked when clicking on the marker count when purged markers are present. */
    getPurgeEventListener() {
        return this.#onShowPurgeClick.bind(this);
    }

    /**
     * Launches the purge overlay for this show.
     * @param {MouseEvent} e */
    #onShowPurgeClick(e) {
        if (this.isInfoIcon(e.target)) {
            return;
        }

        // For dummy rows, set focus back to the first tabbable row, as the purged icon might not exist anymore
        const focusBack = this.titleRow() ? $$('.tabbableRow', this.html().parentElement) : this.html();
        PurgedMarkers.showSingleShow(this.show().metadataId, focusBack);
    }
}
