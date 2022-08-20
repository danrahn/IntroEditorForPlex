import TestBase from '../TestBase.js';
import TestHelpers from '../TestHelpers.js';

/**
 * Test the behavior of bulk shifting markers. */
class ShiftTest extends TestBase {
    constructor() {
        super();
        this.testMethods = [
            this.shiftSingleEpisodeTest,
            this.shiftSingleEpisodeNegativeTest,
            this.checkShiftSingleEpisodeTest,
            this.shiftSingleEpisodeCutsOffStartTest,
            this.shiftSingleEpisodeCutsOffEndTest,
            this.shiftSingleEpisodeTooMuchTest,
            this.shiftSingleSeasonTest,
            this.shiftSingleShowTest,
            this.shiftSingleEpisodeWithMultipleMarkersDontApplyTest,
            this.shiftSingleEpisodeWithMultipleMarkersTryApplyTest,
            this.shiftSingleEpisodeWithMultipleMarkersTryApplyWithIgnoreTest,
            this.shiftSingleEpisodeWithMultipleMarkersForceApplyTest,
            this.shiftSeasonWithIgnoreTest,
            this.shiftShowWithIgnoreTest
        ]
    }

    className() { return 'ShiftTest'; }

    /**
     * Test shifting an episode with a single marker. */
    async shiftSingleEpisodeTest() {
        const episode = TestBase.DefaultMetadata.Show1.Season1.Episode2;
        const shift = 3000;
        const result = await this.#verifyShift(episode.Id, shift, 1);
        const newMarker = result.allMarkers[0];
        return TestHelpers.validateMarker(newMarker, episode.Id, null, null, episode.Marker1.Start + shift, episode.Marker1.End + shift, 0, this.testDb);
    }

    /**
     * Shift a marker with a negative offset. */
    async shiftSingleEpisodeNegativeTest() {
        const episode = TestBase.DefaultMetadata.Show1.Season1.Episode2;
        const shift = -3000;
        const result = await this.#verifyShift(episode.Id, shift, 1);
        const newMarker = result.allMarkers[0];
        return TestHelpers.validateMarker(newMarker, episode.Id, null, null, episode.Marker1.Start + shift, episode.Marker1.End + shift, 0, this.testDb);
    }

    /**
     * Ensure changes aren't applied when only checking a shift, even if there are no conflicts. */
    async checkShiftSingleEpisodeTest() {
        const episode = TestBase.DefaultMetadata.Show1.Season1.Episode2;
        const expectedMarker = episode.Marker1;
        const result = await this.send('check_shift', { id : episode.Id });
        TestHelpers.verify(result && result.allMarkers && result.allMarkers.length == 1, `Bad response from check_shift: ${result}`);
        const checkedMarker = result.allMarkers[0];

        return TestHelpers.validateMarker(checkedMarker, episode.Id, null, null, expectedMarker.Start, expectedMarker.End, expectedMarker.Index, this.testDatabase);
    }

    /**
     * Ensure we don't shift the start of a marker before 0, even if the shift is greater than the current start. */
    async shiftSingleEpisodeCutsOffStartTest() {
        const episode = TestBase.DefaultMetadata.Show1.Season1.Episode2;
        const shift = -16000;
        TestHelpers.verify(episode.Marker1.Start + shift < 0, `episode.Marker1.Start + shift < 0: Can't test start cutoff if we don't shift this enough!`);
        const result = await this.#verifyShift(episode.Id, shift, 1);
        const newMarker = result.allMarkers[0];
        return TestHelpers.validateMarker(newMarker, episode.Id, null, null, 0, episode.Marker1.End + shift, 0, this.testDb);
    }

    /**
     * Ensure we don't shift the end of the marker beyond the episode duration. */
    async shiftSingleEpisodeCutsOffEndTest() {
        const episode = TestBase.DefaultMetadata.Show1.Season1.Episode2;
        const shift = 600000 - 16000;
        TestHelpers.verify(episode.Marker1.End + shift > 600000, `episode.Marker1.End + shift > 600000: Can't test end cutoff if we don't shift this enough!`);
        const result = await this.#verifyShift(episode.Id, shift, 1);
        const newMarker = result.allMarkers[0];
        return TestHelpers.validateMarker(newMarker, episode.Id, null, null, episode.Marker1.Start + shift, 600000, 0, this.testDb);
    }

    /**
     * Ensure we fail to offset a marker that would either force the end time to be 0 or
     * less, or the start time to be greater than or equal to the duration of the episode. */
    async shiftSingleEpisodeTooMuchTest() {
        this.expectFailure();
        const episode = TestBase.DefaultMetadata.Show1.Season1.Episode2;

        // Shift too early
        let shift = -45000;
        let result = await this.send('shift', {
            id : episode.Id,
            shift : shift,
            force : 0,
        }, true);

        TestHelpers.verifyBadRequest(result);

        // Shift too late
        shift = 600000;
        result = await this.send('shift', {
            id : episode.Id,
            shift : shift,
            force : 0,
        }, true);
        TestHelpers.verifyBadRequest(result);
    }

    /**
     * Test shifting a season with a single marker among all episodes. */
    async shiftSingleSeasonTest() {
        // Really the same as shiftSingleEpisodeTest
        const season = TestBase.DefaultMetadata.Show1.Season1;
        const shift = 3000;
        const result = await this.#verifyShift(season.Id, shift, 1);
        const newMarker = result.allMarkers[0];
        const oldMarker = season.Episode2.Marker1;
        return TestHelpers.validateMarker(newMarker, null, season.Id, null, oldMarker.Start + shift, oldMarker.End + shift, 0, this.testDb);
    }

    /**
     * Test shifting a show with a single marker among all episodes. */
    async shiftSingleShowTest() {
        const show = TestBase.DefaultMetadata.Show1;
        const shift = 3000;
        const result = await this.#verifyShift(show.Id, shift, 1);
        const newMarker = result.allMarkers[0];
        const oldMarker = show.Season1.Episode2.Marker1;
        return TestHelpers.validateMarker(newMarker, null, null, show.Id, oldMarker.Start + shift, oldMarker.End + shift, 0, this.testDb);

    }

    /**
     * Ensure we don't apply anything when only checking the shift and the episode has multiple markers. */
    async shiftSingleEpisodeWithMultipleMarkersDontApplyTest() {
        const episode = TestBase.DefaultMetadata.Show3.Season1.Episode2;
        const result = await this.send('check_shift', { id : episode.Id });
        TestHelpers.verify(result, `Expected check_shift to return a valid object, found nothing.`);
        TestHelpers.verify(result.applied === false, `Expected result.applied to be false, found ${result.applied}.`);
        TestHelpers.verify(result.conflict === true, `Expected result.conflict to be true, found ${result.conflict}.`);
        TestHelpers.verify(result.allMarkers instanceof Array, `Expected result.allMarkers to be an array.`);
        TestHelpers.verify(result.allMarkers.length == 2, `Expected result.allMarkers.length to be 2, found ${result.allMarkers.length}.`);
    }

    /**
     * Ensure we don't apply anything when an episode has multiple markers and we aren't forcing the operation. */
    async shiftSingleEpisodeWithMultipleMarkersTryApplyTest() {
        const episode = TestBase.DefaultMetadata.Show3.Season1.Episode2;
        const result = await this.send('shift', { id : episode.Id, shift : 3000, force : 0 });
        TestHelpers.verify(result, `Expected shift to return a valid object, found nothing.`);
        TestHelpers.verify(result.applied === false, `Expected result.applied to be false, found ${result.applied}.`);
        TestHelpers.verify(result.conflict === true, `Expected result.conflict to be true, found ${result.conflict}.`);
        TestHelpers.verify(result.allMarkers instanceof Array, `Expected result.allMarkers to be an array.`);
        TestHelpers.verify(result.allMarkers.length == 2, `Expected result.allMarkers.length to be 2, found ${result.allMarkers.length}.`);
    }

    /**
     * Ensure we apply the shift when an episode has multiple markers, but only one isn't being ignored. */
    async shiftSingleEpisodeWithMultipleMarkersTryApplyWithIgnoreTest() {
        const episode = TestBase.DefaultMetadata.Show3.Season1.Episode2;
        const shift = 3000;
        const result = await this.#verifyShift(episode.Id, shift, 1, [episode.Marker2.Id]);
        const newMarker = result.allMarkers[0];
        await TestHelpers.validateMarker(newMarker, episode.Id, null, null, episode.Marker1.Start + shift, episode.Marker1.End + shift, 0, this.testDb);

        // Fake marker data to verify that the second marker wasn't changed
        const marker2 = episode.Marker2;
        const fakeMarkerData = { id : marker2.Id, start : marker2.Start, end : marker2.End, index : marker2.Index };
        return TestHelpers.validateMarker(fakeMarkerData, null, null, null, marker2.Start, marker2.End, marker2.Index);
    }

    /**
     * Ensure we apply the shift to multiple markers in the same episode when forcing the operation. */
    async shiftSingleEpisodeWithMultipleMarkersForceApplyTest() {
        const episode = TestBase.DefaultMetadata.Show3.Season1.Episode2;
        const shift = 3000;
        const result = await this.#verifyShift(episode.Id, shift, 2, [], true, 1);
        /** @type {MarkerData[]} */
        const newMarkers = result.allMarkers;

        // Order not guaranteed.
        const sorted = newMarkers.sort((a, b) => a.id - b.id);
        await TestHelpers.validateMarker(sorted[0], episode.Id, null, null, episode.Marker1.Start + shift, episode.Marker1.End + shift, 0, this.testDb);
        await TestHelpers.validateMarker(sorted[1], episode.Id, null, null, episode.Marker2.Start + shift, episode.Marker2.End + shift, 1, this.testDb);
    }

    /**
     * Ensure multiple markers in a season are shifted when the ignore list ensures all episodes only have a single
     * marker to shift. */
    async shiftSeasonWithIgnoreTest() {
        const season = TestBase.DefaultMetadata.Show3.Season1;
        const shift = 3000;
        const result = await this.#verifyShift(season.Id, shift, 2, [season.Episode2.Marker2.Id]);
        /** @type {MarkerData[]} */
        const newMarkers = result.allMarkers;

        // Order not guaranteed.
        const sorted = newMarkers.sort((a, b) => a.id - b.id);
        await TestHelpers.validateMarker(sorted[0], null, season.Id, null, season.Episode1.Marker1.Start + shift, season.Episode1.Marker1.End + shift, 0, this.testDb);
        await TestHelpers.validateMarker(sorted[1], null, season.Id, null, season.Episode2.Marker1.Start + shift, season.Episode2.Marker1.End + shift, 0, this.testDb);

        // Fake marker data to verify that the ignored marker wasn't changed
        const marker2 = season.Episode2.Marker2;
        const fakeMarkerData = { id : marker2.Id, start : marker2.Start, end : marker2.End, index : marker2.Index };
        return TestHelpers.validateMarker(fakeMarkerData, null, null, null, marker2.Start, marker2.End, marker2.Index);
    }

    /**
     * Ensure multiple markers in a show are shifted when the ignore list ensures all episodes only have a single
     * marker to shift. */
    async shiftShowWithIgnoreTest() {
        const show = TestBase.DefaultMetadata.Show3;
        const shift = 3000;
        const result = await this.#verifyShift(show.Id, shift, 3, [show.Season1.Episode2.Marker1.Id]);
        /** @type {MarkerData[]} */
        const newMarkers = result.allMarkers;

        // Order not guaranteed.
        const sorted = newMarkers.sort((a, b) => a.id - b.id);
        await TestHelpers.validateMarker(sorted[0], null, null, show.Id, show.Season1.Episode1.Marker1.Start + shift, show.Season1.Episode1.Marker1.End + shift, 0, this.testDb);
        await TestHelpers.validateMarker(sorted[1], null, null, show.Id, show.Season1.Episode2.Marker2.Start + shift, show.Season1.Episode2.Marker2.End + shift, 1, this.testDb);
        await TestHelpers.validateMarker(sorted[2], null, null, show.Id, show.Season2.Episode1.Marker1.Start + shift, show.Season2.Episode1.Marker1.End + shift, 0, this.testDb);

        // Fake marker data to verify that the ignored marker wasn't changed
        const marker1 = show.Season1.Episode2.Marker1;
        const fakeMarkerData = { id : marker1.Id, start : marker1.Start, end : marker1.End, index : marker1.Index };
        return TestHelpers.validateMarker(fakeMarkerData, null, null, null, marker1.Start, marker1.End, marker1.Index);
    }

    /**
     * Helper that validates a successfully applied shift.
     * @param {number} metadataId The show/season/episode metadata id.
     * @param {number} shift The ms to shift.
     * @param {number} expectedLength The expected number of shifted markers.
     * @param {number[]} [ignoreList=[]] The list of marker ids to ignore.
     * @param {boolean} expectConflict Whether we expect to encounter a conflict.
     * @param {boolean} force Whether the shift operation should be forced. */
    async #verifyShift(metadataId, shift, expectedLength, ignoreList=[], expectConflict=false, force=0) {
        const params = {
            id : metadataId,
            shift : shift,
            force : force
        };
        if (ignoreList.length != 0) {
            params.ignored = ignoreList.join(',');
        }

        let result = await this.send('shift', params);

        TestHelpers.verify(result, `Expected successful 'shift' to return an object, found nothing.`);
        TestHelpers.verify(result.applied === true, `Expected successful 'shift' to return applied=true, found ${result.applied}.`);
        TestHelpers.verify(result.conflict == expectConflict, `Expected shift.conflict to be ${expectConflict}, found ${result.conflict}.`);

        let newMarkers = result.allMarkers;
        TestHelpers.verify(newMarkers instanceof Array, `Expected successful 'shift' to have an allMarkers field with an array of shifted markers.`);
        TestHelpers.verify(newMarkers.length == expectedLength, `Expected ${expectedLength} shifted marker(s), found ${newMarkers.length}`);
        return result;
    }
}

export default ShiftTest;
