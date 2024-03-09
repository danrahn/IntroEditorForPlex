import { $, $$, buildNode, clearEle, clickOnEnterCallback } from './Common.js';
import { ContextualLog } from '../../Shared/ConsoleLog.js';

import { FilterSettings, SortConditions, SortOrder } from './FilterDialog.js';
import { MovieResultRow, ResultRow, SectionOptionsResultRow, ShowResultRow } from './ResultRow.js';
import { UISection, UISections } from './ResultSections.js';
import { ClientSettings } from './ClientSettings.js';
import { CustomEvents } from './CustomEvents.js';
import Overlay from './Overlay.js';
import { PlexClientState } from './PlexClientState.js';
import { PurgedMarkers } from './PurgedMarkerManager.js';
import { SectionType } from '../../Shared/PlexTypes.js';

/** @typedef {!import('../../Shared/PlexTypes').LibrarySection} LibrarySection */
/** @typedef {!import('../../Shared/PlexTypes').ShowData} ShowData */
/** @typedef {!import('./ClientDataExtensions').ClientMovieData} ClientMovieData */


const BaseLog = new ContextualLog('PlexUI');

/**
 * OR-able modifier states
 * @enum */
const Modifiers = {
    /**@readonly*/ None  : 0,
    /**@readonly*/ Ctrl  : 1,
    /**@readonly*/ Alt   : 2,
    /**@readonly*/ Shift : 4,
};

/**
 * The singleton UI instance
 * @type {PlexUIManager}
 * @readonly */ // Externally readonly
let Instance;

/**
 * Handles UI interactions of the application, including
 * setting up search/dropdown listeners, and building show/season/episode result rows.
 */
class PlexUIManager {

    /** The library selection dropdown.
     * @type {HTMLSelectElement} */
    #dropdown = $('#libraries');

    /**
     * The show search box.
     * @type {HTMLInputElement} */
    #searchBox = $('#search');

    /**
     * The last value we searched for, used to ensure
     * we don't reparse thing on null input (e.g. alt key down)
     * @type {string} */
    #lastSearch = null;

    /**
     * The container that encapsulates the three result groups
     * @type {HTMLElement} */
    #searchContainer = $('#container');

    /**
     * timerID for the search timeout
     * @type {number} */
    #searchTimer;

    #lastSort = {
        by : SortConditions.Alphabetical,
        order : SortOrder.Ascending
    };

    /** Creates the singleton PlexUI for this session. */
    static CreateInstance() {
        if (Instance) {
            BaseLog.error('We should only have a single PlexUI instance!');
            return;
        }

        Instance = new PlexUIManager();
        window.addEventListener(CustomEvents.ClientSettingsApplied, PlexUIManager.OnSettingsApplied);
        window.addEventListener(CustomEvents.MarkerFilterApplied, PlexUIManager.OnFilterApplied);
    }

    /**
     * Callback invoked when settings are applied.
     * @param {CustomEvent} e A custom event whose `detail indicates whether a setting that
     * that affects the display of markers was changed, requiring the current view to be reset. */
    static OnSettingsApplied(e) {
        Instance?.onSettingsApplied(e.detail);
    }

    /**
     * Callback invoked when a new filter is applied. */
    static OnFilterApplied() {
        Instance?.onFilterApplied();
    }

    /** Constructs a new PlexUI and begins listening for change events. */
    constructor() {
        if (Instance) {
            throw new Error(`Don't create a new PlexUI when the singleton already exists!`);
        }

        this.#dropdown.addEventListener('change', this.#libraryChanged.bind(this));
        this.#searchBox.addEventListener('keyup', this.#onSearchInput.bind(this));
        window.addEventListener('keyup', this.#globalShortcutHandler.bind(this));
    }

    /**
     * Determines whether the event target is input-like and should
     * be ignored by any global handlers.
     * @param {KeyboardEvent} e */
    #inInput(e) {
        const tag = e.target.tagName.toLowerCase();
        return tag === 'textarea' || tag === 'input' && e.target.type === 'text';
    }

    /**
     * @param {HTMLElement} element */
    #isHidden(element) {
        return element.offsetParent === null;
    }

    /**
     * @param {KeyboardEvent} e */
    #modifiers(e) {
        return (e.altKey << 2 | e.shiftKey << 1 | e.ctrlKey);
    }

    /**
     * Sets up some global shortcuts to help with navigation.
     * @param {KeyboardEvent} e */
    #globalShortcutHandler(e) {
        if (this.#inInput(e)) {
            return;
        }

        const modifiers = this.#modifiers(e);
        switch (e.key) {
            case '/':
                if (modifiers === Modifiers.None && !this.#isHidden(this.#searchBox)) {
                    this.#searchBox.focus();
                }
                break;
            default:
                break;
        }
    }

    /**
     * Populate the library selection dropdown with the items retrieved from the database.
     * If only a single library is returned, automatically select it.
     * @param {LibrarySection[]} libraries List of libraries found in the database. */
    init(libraries) {
        clearEle(this.#dropdown);
        if (libraries.length < 1) {
            Overlay.show('No Movie/TV libraries found in the database.');
            return;
        }

        this.#dropdown.appendChild(buildNode('option', { value : '-1', libtype : '-1' }, 'Select a library to parse'));
        const savedSection = ClientSettings.lastSection();

        // We might not find the section if we're using a different database or the library was deleted.
        let lastSectionExists = false;
        for (const library of libraries) {
            lastSectionExists ||= library.id === savedSection;
            this.#dropdown.appendChild(buildNode('option', { value : library.id, libtype : library.type }, library.name));
        }

        if (savedSection !== -1 && !lastSectionExists) {
            BaseLog.info(`Found a cached library section (${savedSection}), but it doesn't exist anymore!`);
        }

        // Select a library automatically if there's only one TV show library
        // or we have an existing cached library section.
        const preSelect = libraries.length === 1 ? libraries[0].id : lastSectionExists ? savedSection : -1;
        if (preSelect !== -1) {
            this.#dropdown.value = preSelect;
            this.#libraryChanged();
        }
    }

    /**
     * Callback invoked when settings are applied.
     * @param {boolean} shouldResetView Whether a setting that affects the display of markers
     * was changed, requiring the current view to be reset. */
    onSettingsApplied(shouldResetView) {
        if (shouldResetView) {
            UISections.clearAllSections();
        }

        if (!this.#searchBox.classList.contains('hidden')) {
            this.#searchBox.value = '';
            this.#searchBox.focus();
        }
    }

    async #libraryChanged() {
        this.#searchContainer.classList.add('hidden');
        this.#lastSearch = null;
        const section = parseInt(this.#dropdown.value);
        const libType = parseInt(this.#dropdown.childNodes[this.#dropdown.selectedIndex].getAttribute('libtype'));
        switch (libType) {
            case SectionType.Movie:
                this.#searchBox.placeholder = 'Search for a Movie...';
                break;
            case SectionType.TV:
                this.#searchBox.placeholder = 'Search for a Show...';
                break;
            case -1:
                // "Select a library"
                break;
            default:
                BaseLog.warn(`Unexpected library type ${libType}`);
                this.#searchBox.placeholder = 'Search for an item...';
                break;
        }

        await PlexClientState.setSection(section, libType);
        UISections.clearAllSections();
        if (!isNaN(section) && section !== -1) {
            ClientSettings.setLastSection(section);
            this.#searchContainer.classList.remove('hidden');
        }

        if (ClientSettings.showExtendedMarkerInfo()) {
            // In this case, we should have pre-built our purge cache, so grab everything now so that
            // we don't have to 'Find Purged Markers' to hydrate the warning icons at the movie/show/season/episode level
            PurgedMarkers.findPurgedMarkers(true /*dryRun*/);
        }

        if (this.#searchBox.value.length > 0 || FilterSettings.hasFilter()) {
            this.#search(); // Restart any existing search in the new library
        } else {
            this.#noSearch();
        }
    }

    /**
     * Handle search box input. Invoke a search immediately if 'Enter' is pressed, otherwise
     * set a timeout to invoke a search after a quarter of a second has passed.
     * @this {PlexUIManager}
     * @param {KeyboardEvent} e */
    #onSearchInput(e) {
        clearTimeout(this.#searchTimer);
        if (e.key === 'Enter') {
            this.#lastSearch = null; // Guarantee we reload things.
            return this.#search();
        }

        // List of modifiers to ignore as input, take from
        // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values (and Tab).
        const modifiers = ['Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'FnLock', 'Hyper', 'Meta',
            'NumLock', 'ScrollLock', 'Shift', 'Super', 'Symbol', 'SymbolLock', 'Tab'];
        if (modifiers.indexOf(e.key) !== -1) {
            return;
        }

        if (this.#searchBox.value.length === 0) {
            // Only show all items if the user explicitly presses 'Enter'
            // on a blank query with no filter, otherwise clear the results.
            if (this.#lastSearch?.length !== 0 && !FilterSettings.hasFilter()) {
                // Previous search was deleted, and we have no filter. Go to default state,
                // not loading any results.
                UISections.clearAllSections();
                this.#noSearch();
                return;
            } else if (!FilterSettings.hasFilter()) {
                // Last search _was_ empty, but 'enter' wasn't pressed, so don't do anything.
                return;
            }

            // Otherwise, we have a filter and our previous search wasn't empty,
            // so set our regular timer for a filtered search of all items.
        }

        this.#searchTimer = setTimeout(this.#search.bind(this), 250);
    }

    /** Initiate a search to the database for shows. */
    #search(forFilterReapply=false, newSort=false) {
        if (!forFilterReapply && this.#searchBox.value === this.#lastSearch) {
            return;
        }

        this.#lastSearch = this.#searchBox.value;

        // If we're adjusting the list due to a filter change, we
        // don't want to reapply the search itself, just decide what
        // items we want to display, unless the sort order has changed.
        if (!forFilterReapply || (newSort && UISections.sectionVisible(UISection.MoviesOrShows))) {

            // Remove any existing show/season/marker data
            UISections.clearAllSections();

            PlexClientState.search(this.#searchBox.value);

            UISections.clearAndShowSections(UISection.MoviesOrShows);
        } else {
            // Clear the section, but don't show it
            UISections.clearSections(UISection.MoviesOrShows);
        }

        switch (PlexClientState.activeSectionType()) {
            case SectionType.Movie:
                this.#searchMovies();
                break;
            case SectionType.TV:
                this.#searchShows(forFilterReapply);
                break;
            default:
                BaseLog.error(`Attempting to search with an invalid section type.`);
                break;
        }
    }

    /**
     * Add a "landing page" for a library, including the main section options row,
     * and a description row explaining how to narrow things down. */
    #noSearch() {
        if (!ClientSettings.showExtendedMarkerInfo()) {
            return;
        }

        const itemList = UISections.getSection(UISection.MoviesOrShows);
        itemList.appendChild(new SectionOptionsResultRow().buildRow());
        itemList.appendChild(this.noResultsBecauseNoSearchRow());
    }

    #searchMovies() {
        const movieList = UISections.getSection(UISection.MoviesOrShows);
        if (ClientSettings.showExtendedMarkerInfo()) {
            movieList.appendChild(new SectionOptionsResultRow().buildRow());
        }

        /** @type {ClientMovieData[]} */
        const searchResults = PlexClientState.getUnfilteredSearchResults();
        if (searchResults.length === 0) {
            movieList.appendChild(buildNode('div', { class : 'topLevelResult movieResult' }, 'No results found.'));
            return;
        }

        /** @type {MovieResultRow[]} */
        const filteredResults = [];
        const rowsLimit = 250; // Most systems should still be fine with this. Even 1000 might not be horrible, but play it safe.
        let nonFiltered = 0;
        let nextFilterIndex = 0;
        for (const movie of searchResults) {
            ++nextFilterIndex;
            if (!FilterSettings.shouldFilter(movie.markerBreakdown())) {
                ++nonFiltered;
                const newRow = new MovieResultRow(movie);
                filteredResults.push(newRow);
                movieList.appendChild(newRow.buildRow());
            }

            if (nonFiltered === rowsLimit) {
                break;
            }
        }

        if (nonFiltered === 0) {
            movieList.appendChild(ResultRow.NoResultsBecauseOfFilterRow());
        }

        if (searchResults.length > nextFilterIndex) {

            const loadTheRest = () => {
                movieList.removeChild(movieList.children[movieList.children.length - 1]);
                for (const movie of searchResults.slice(nextFilterIndex)) {
                    if (!FilterSettings.shouldFilter(movie.markerBreakdown())) {
                        const newRow = new MovieResultRow(movie);
                        filteredResults.push(newRow);
                        movieList.appendChild(newRow.buildRow());
                    }
                }
            };

            const text = `Results are limited to the top ${rowsLimit} items, ` +
            `click here to load up to ${searchResults.length - nextFilterIndex} more.<br><br>` +
            `WARNING: loading too many rows might hang your browser page.<br>`;
            movieList.appendChild(
                buildNode('div',
                    { class : 'topLevelResult movieResult', style : 'text-align: center' },
                    text,
                    { click : loadTheRest }));
        }

        PlexClientState.setActiveSearchRows(filteredResults);
    }

    #searchShows(forFilterReapply=false) {
        if (!forFilterReapply) {
            // "Background" update, we don't want to wipe out the
            // current view if the user is viewing a show/season
            PlexClientState.clearActiveShow();
        }

        const showList = UISections.getSection(UISection.MoviesOrShows);
        if (ClientSettings.showExtendedMarkerInfo()) {
            showList.appendChild(new SectionOptionsResultRow().buildRow());
        }

        /** @type {ShowData[]} */
        const searchResults = PlexClientState.getUnfilteredSearchResults();
        if (searchResults.length === 0) {
            showList.appendChild(buildNode('div', { class : 'topLevelResult showResult' }, 'No results found.'));
            return;
        }

        /** @type {ShowResultRow[]} */
        const filteredResults = [];
        for (const show of searchResults) {
            if (!FilterSettings.shouldFilter(show.markerBreakdown())) {
                const newRow = new ShowResultRow(show);
                filteredResults.push(newRow);
                showList.appendChild(newRow.buildRow());
            }
        }

        if (filteredResults.length === 0) {
            showList.appendChild(ResultRow.NoResultsBecauseOfFilterRow());
        }

        PlexClientState.setActiveSearchRows(filteredResults);
    }

    noResultsBecauseNoSearchRow() {
        return buildNode(
            'div',
            { class : 'topLevelResult noSearchRow tabbableRow', tabindex : 0 },
            'Click here to load all items, or narrow things down with a filter or search above.',
            { click : /**@this {PlexUIManager}*/ function() { this.#search(); }.bind(this),
              keydown : clickOnEnterCallback }
        );
    }

    /**
     * Callback invoked when a new filter is applied. */
    onFilterApplied() {
        // Don't start a search if we don't have any existing items, unless
        // we're in the "start" page.
        const showingStartScreen = $$('.noSearchRow', UISections.getSection(UISection.MoviesOrShows));
        const newSort = FilterSettings.sortBy !== this.#lastSort.by || FilterSettings.sortOrder !== this.#lastSort.order;
        this.#lastSort.by = FilterSettings.sortBy;
        this.#lastSort.order = FilterSettings.sortOrder;
        if (PlexClientState.getUnfilteredSearchResults().length !== 0
            || showingStartScreen) {
            this.#search(!showingStartScreen /*forFilterReapply*/, newSort);
        }

        // onFilterApplied should probably live completely within PlexClientState,
        // or I need to set stricter boundaries on what goes there versus here, since
        // they both are UI-related.
        PlexClientState.onFilterApplied();
    }
}

export { PlexUIManager, UISection, Instance as PlexUI };
