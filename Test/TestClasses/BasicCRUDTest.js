import TestBase from '../TestBase.js';
import TestHelpers from '../TestHelpers.js';

/**
 * Integration test for basic Create, Update, and Delete operations.
 * No (R)enaming to do, but CRUD sounds better than CUD. */
class BasicCRUD extends TestBase {
    constructor() {
        super();
        this.testMethods = [
            this.testSingleAdd,
            this.testSingleCreditAdd,
            this.testSingleFinalCreditAdd,
            this.testSingleAdAdd,
            this.testSingleMovieAdd,
            this.testSingleMovieCreditsAdd,
            this.testSingleMovieFinalCreditsAdd,
            this.testSingleMovieAdAdd,
            this.testAddFlippedStartAndEnd,
            this.testNegativeStart,
            this.testEqualStartAndEnd,
            this.testAddToSeason,
            this.testAddToShow,
            this.testAddToMusic,
            this.testSingleEdit,
            this.testSingleEditMakeCredit,
            this.testSingleEditMakeFinalCredit,
            this.testSingleMovieEdit,
            this.testSingleMovieCreditsEdit,
            this.testSingleMovieFinalCreditsEdit,
            this.testSingleMovieAdEdit,
            this.testMarkerTypeEdit,
            this.testEditOfNonexistentMarker,
            this.testEditOfFinalIntroMarker,
            this.testEditFlippedStartAndEnd,
            this.testSingleDelete,
            this.testSingleCreditsDelete,
            this.testSingleFinalCreditsDelete,
            this.testSingleAdDelete,
            this.testSingleMovieDelete,
            this.testSingleMovieCreditsDelete,
            this.testSingleMovieFinalCreditsDelete,
            this.testDeleteOfNonexistentMarker,
        ];
    }

    className() { return 'BasicCRUD'; }

    /**
     * Test adding a single marker to an episode that has no existing markers. */
    async testSingleAdd() {
        const show = TestBase.DefaultMetadata.Show1;
        const episodeId = show.Season1.Episode1.Id;
        await this.#testSingleAdd(episodeId, 0, 1000, show.Id, show.Season1.Id, 'intro', false /*final*/);
    }

    /**
     * Test adding a single non-final credit marker to an episode that has no existing markers. */
    async testSingleCreditAdd() {
        const show = TestBase.DefaultMetadata.Show1;
        const episodeId = show.Season1.Episode1.Id;
        await this.#testSingleAdd(episodeId, 45000, 50000, show.Id, show.Season1.Id, 'credits', false /*final*/);
    }

    /**
     * Test adding a single final credit marker to an episode that has no existing markers. */
    async testSingleFinalCreditAdd() {
        const show = TestBase.DefaultMetadata.Show1;
        const episodeId = show.Season1.Episode1.Id;
        await this.#testSingleAdd(episodeId, 45000, 50000, show.Id, show.Season1.Id, 'credits', true /*final*/);
    }

    /**
     * Test adding a single ad marker to an episode that has no existing markers. */
    async testSingleAdAdd() {
        const show = TestBase.DefaultMetadata.Show1;
        const episodeId = show.Season1.Episode1.Id;
        await this.#testSingleAdd(episodeId, 45000, 50000, show.Id, show.Season1.Id, 'commercial', false /*final*/);
    }

    /**
     * Add a single intro marker to a movie that has no markers. */
    async testSingleMovieAdd() {
        const movie = TestBase.DefaultMetadata.Movie1;
        await this.#testSingleAdd(movie.Id, 0, 1000, -1, -1, 'intro', false /*final*/);
    }

    /**
     * Add a single non-final credits marker to a movie that has no markers. */
    async testSingleMovieCreditsAdd() {
        const movie = TestBase.DefaultMetadata.Movie1;
        await this.#testSingleAdd(movie.Id, 40000, 50000, -1, -1, 'credits', false /*final*/);
    }

    /**
     * Add a single final credits marker to a movie that has no markers. */
    async testSingleMovieFinalCreditsAdd() {
        const movie = TestBase.DefaultMetadata.Movie1;
        await this.#testSingleAdd(movie.Id, 45000, 60000, -1, -1, 'credits', true /*final*/);
    }

    /**
     * Add a single ad marker to a movie that has no markers. */
    async testSingleMovieAdAdd() {
        const movie = TestBase.DefaultMetadata.Movie1;
        await this.#testSingleAdd(movie.Id, 45000, 60000, -1, -1, 'commercial', false /*final*/);
    }

    /**
     * Test adding a single marker to an item that has no existing markers.
     * @param {number} id metadata id of the item
     * @param {number} start
     * @param {number} end
     * @param {number} showId -1 for movies
     * @param {number} seasonId -1 for movies
     * @param {string} markerType
     * @param {boolean} final */
    async #testSingleAdd(id, start, end, showId, seasonId, markerType='intro', final=false) {
        const marker = await this.addMarker(id, start, end, markerType, final);
        return TestHelpers.validateMarker(marker, markerType, id, seasonId, showId, start, end, 0 /*expectedIndex*/, final, this.testDb);
    }

    /**
     * Ensure attempting to add a marker with a start time greater than the end time fails.
     * It'd be interesting if flipped markers would allow us to seek back in time though, if
     * someone wanted to do that for whatever reason. */
    testAddFlippedStartAndEnd() {
        const show = TestBase.DefaultMetadata.Show1;
        return this.#flippedTestHelper('add', {
            metadataId : show.Season1.Episode1.Id,
            start : 1000,
            end : 0
        });
    }

    /**
     * Ensure attempting to add a marker with a negative index fails. */
    async testNegativeStart() {
        this.expectFailure();
        const show = TestBase.DefaultMetadata.Show1;
        const response = await this.addMarkerRaw(show.Season1.Episode1.Id, -1, 10000);

        return TestHelpers.verifyBadRequest(response, 'add with negative startMs');
    }

    /**
     * A marker can't have the same start and end time. */
    async testEqualStartAndEnd() {
        this.expectFailure();
        const show = TestBase.DefaultMetadata.Show1;
        const response = await this.addMarkerRaw(show.Season1.Episode1.Id, 10000, 10000);

        return TestHelpers.verifyBadRequest(response, 'add with equal startMs and endMs');
    }

    /**
     * Ensure attempting to add a marker to a season fails. */
    testAddToSeason() {
        return this.#addToWrongMetadataType(TestBase.DefaultMetadata.Show1.Season1.Id);
    }

    /**
     * Ensure attempting to add a marker to a show fails. */
    testAddToShow() {
        return this.#addToWrongMetadataType(TestBase.DefaultMetadata.Show1.Id);
    }

    /**
     * Ensure attempting to a dd a marker to an artist/album/track fails. */
    async testAddToMusic() {
        await this.#addToWrongMetadataType(200 /*Artist1*/);
        await this.#addToWrongMetadataType(201 /*Album1*/);
        await this.#addToWrongMetadataType(202 /*Track1*/);
    }

    /**
     * Helper that tries to add a marker to an item with the given metadataId,
     * which isn't an episode. */
    async #addToWrongMetadataType(metadataId) {
        this.expectFailure();
        const response = await this.addMarkerRaw(metadataId, 0, 10000);

        return TestHelpers.verifyBadRequest(response);
    }

    /**
     * Test editing an existing marker for a single episode. */
    testSingleEdit() {
        // With default config, taggings id 1 is a marker from 15 to 45 seconds.
        const show = TestBase.DefaultMetadata.Show1;
        const episode = show.Season1.Episode2;
        return this.#testSingleEdit(episode.Marker1.Id, 14000, 46000, episode.Id, show.Season1.Id, show.Id, 'intro', false /*final*/);
    }

    /**
     * Test editing an existing credits marker for a single episode. */
    testSingleEditMakeCredit() {
        const show = TestBase.DefaultMetadata.Show1;
        const episode = show.Season1.Episode2;
        return this.#testSingleEdit(episode.Marker1.Id, 45000, 55000, episode.Id, show.Season1.Id, show.Id, 'credits', false /*final*/);
    }

    /**
     * Test editing an existing final credits marker for a single episode. */
    testSingleEditMakeFinalCredit() {
        const show = TestBase.DefaultMetadata.Show1;
        const episode = show.Season1.Episode2;
        return this.#testSingleEdit(episode.Marker1.Id, 45000, 60000, episode.Id, show.Season1.Id, show.Id, 'credits', true /*final*/);
    }

    /**
     * Test editing an existing marker for a single movie. */
    testSingleMovieEdit() {
        const movie = TestBase.DefaultMetadata.Movie3;
        return this.#testSingleEdit(movie.Marker1.Id, 14000, 46000, movie.Id, -1, -1, 'intro', false /*final*/);
    }

    /**
     * Test editing an existing credits marker for a single movie. */
    testSingleMovieCreditsEdit() {
        const movie = TestBase.DefaultMetadata.Movie2;
        return this.#testSingleEdit(movie.Marker2.Id, 45000, 54000, movie.Id, -1, -1, 'credits', false /*final*/, 1 /*expectedIndex*/);
    }

    /**
     * Test editing an existing final credits marker for a single movie. */
    testSingleMovieFinalCreditsEdit() {
        const movie = TestBase.DefaultMetadata.Movie2;
        return this.#testSingleEdit(movie.Marker3.Id, 46000, 60000, movie.Id, -1, -1, 'credits', true /*final*/, 2 /*expectedIndex*/);
    }

    testSingleMovieAdEdit() {
        const movie = TestBase.DefaultMetadata.Movie2;
        return this.#testSingleEdit(movie.Marker4.Id, 65000, 95000, movie.Id, -1, -1, 'commercial', false /*final*/, 3 /*expectedIndex*/);
    }

    /**
     * Test editing an existing marker between different marker types for a single movie. */
    async testMarkerTypeEdit() {
        const movie = TestBase.DefaultMetadata.Movie3;
        await this.#testSingleEdit(movie.Marker1.Id, 45000, 60000, movie.Id, -1, -1, 'credits', true /*final*/);
        await this.#testSingleEdit(movie.Marker1.Id, 10000, 20000, movie.Id, -1, -1, 'intro', false /*final*/);
        await this.#testSingleEdit(movie.Marker1.Id, 10000, 20000, movie.Id, -1, -1, 'commercial', false /*final*/);
        await this.#testSingleEdit(movie.Marker1.Id, 45000, 55000, movie.Id, -1, -1, 'credits', false /*final*/);
    }

    /**
     * Test editing a single marker of an item.
     * @param {number} markerId
     * @param {number} start
     * @param {number} end
     * @param {number} parentId
     * @param {number} seasonId -1 for movies
     * @param {number} showId -1 for movies
     * @param {string} markerType
     * @param {boolean} final */
    async #testSingleEdit(markerId, start, end, parentId, seasonId, showId, markerType='intro', final=false, index=0) {
        const marker = await this.editMarker(markerId, start, end, markerType, final);
        return TestHelpers.validateMarker(
            marker,
            markerType,
            parentId,
            seasonId,
            showId,
            start,
            end,
            index,
            final,
            this.testDb);
    }

    /**
     * Ensure we fail if we attempt to edit a marker that doesn't exist. */
    async testEditOfNonexistentMarker() {
        // Don't surface expected errors from the main application log
        this.expectFailure();
        /* MarkerId of 100 = arbitrary bad value */
        const response = await this.editMarkerRaw(100, 0, 10000, 'intro', false /*final*/);

        return TestHelpers.verifyBadRequest(response, 'edit of nonexistent marker');
    }

    /**
     * Ensure that if we try to mark an intro marker final, we still edit it, but don't mark it final. */
    async testEditOfFinalIntroMarker() {
        // With default config, taggings id 1 is a marker from 15 to 45 seconds.
        const show = TestBase.DefaultMetadata.Show1;
        this.expectFailure(); // We get warned about doing this, as we should.
        const marker = await this.editMarker(show.Season1.Episode2.Marker1.Id, 14000, 46000, 'intro', true /*final*/);

        return TestHelpers.validateMarker(marker,
            'intro' /*expectedType*/,
            show.Season1.Episode2.Id,
            show.Season1.Id,
            show.Id,
            14000 /*expectedStart*/,
            46000 /*expectedEnd*/,
            0 /*expectedIndex*/,
            false /*expectedFinal*/,
            this.testDb);
    }

    /**
     * Ensure we fail to edit a marker to have a start time greater than the end time. */
    testEditFlippedStartAndEnd() {
        const show = TestBase.DefaultMetadata.Show1;
        return this.#flippedTestHelper('edit', {
            id : show.Season1.Episode2.Marker1.Id,
            start : 10000,
            end : 0,
            userCreated : 0
        });
    }

    /**
     * Test deleting a single marker from an episode. */
    testSingleDelete() {
        return this.#testSingleDelete(TestBase.DefaultMetadata.Show1.Season1.Episode2.Marker1);
    }

    /**
     * Test deleting a single credits marker from an episode. */
    testSingleCreditsDelete() {
        return this.#testSingleDelete(TestBase.DefaultMetadata.Show3.Season1.Episode2.Marker2);
    }

    /**
     * Test deleting a single final credits marker from an episode. */
    testSingleFinalCreditsDelete() {
        return this.#testSingleDelete(TestBase.DefaultMetadata.Show3.Season1.Episode2.Marker3);
    }

    /**
     * Test deleting a single commercial marker from a movie. */
    testSingleAdDelete() {
        return this.#testSingleDelete(TestBase.DefaultMetadata.Movie2.Marker4);
    }

    /**
     * Test deleting a single marker from a movie. */
    testSingleMovieDelete() {
        return this.#testSingleDelete(TestBase.DefaultMetadata.Movie3.Marker1);
    }

    /**
     * Test deleting a single credits marker from a movie. */
    testSingleMovieCreditsDelete() {
        return this.#testSingleDelete(TestBase.DefaultMetadata.Movie2.Marker2);
    }

    /**
     * Test deleting a single final credits marker from a movie. */
    testSingleMovieFinalCreditsDelete() {
        return this.#testSingleDelete(TestBase.DefaultMetadata.Movie2.Marker3);
    }

    /**
     * Helper to verify that the given DefaultMetadata Marker was deleted.
     * @param {{Id: number, Start: number, End: number, Index: number, Type: string, Final: boolean}} toDelete */
    async #testSingleDelete(toDelete) {
        const marker = await this.send('delete', { id : toDelete.Id });
        return TestHelpers.validateMarker(
            marker,
            toDelete.Type,
            null, null, null, // parent/season/show
            toDelete.Start,
            toDelete.End,
            toDelete.Index,
            toDelete.Final,
            this.testDb,
            true /*isDeleted*/);
    }

    /**
     * Ensure we fail if we attempt to delete a marker that doesn't exist. */
    async testDeleteOfNonexistentMarker() {
        // Don't surface expected errors from the main application log
        this.expectFailure();
        const response = await this.send('delete', {
            id : 100, /* arbitrary bad value */
        }, true /*raw*/);

        return TestHelpers.verifyBadRequest(response, 'delete of nonexistent marker');
    }

    /** Small helper that tests start > end requests for adding and editing markers. */
    async #flippedTestHelper(endpoint, parameters) {
        this.expectFailure();
        const response = await this.send(endpoint, parameters, true /*raw*/);

        return TestHelpers.verifyBadRequest(response, `${endpoint} with startMs greater than endMs`);
    }
}

export default BasicCRUD;
