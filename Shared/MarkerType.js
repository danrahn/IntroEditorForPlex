
/** Set of known marker types. */
const _supportedMarkerTypes = new Set(['intro', 'credits', 'commercial']);

/**
 * Return whether the given marker type is a supported type.
 * @param {string} markerType */
const supportedMarkerType = markerType => _supportedMarkerTypes.has(markerType);

/**
 * Possible marker types
 * @enum */
const MarkerType = {
    /** @readonly */
    Intro   : 'intro',
    /** @readonly */
    Credits : 'credits',
    /** @readonly */
    Ad      : 'commercial',
};

/**
 * Known marker types, as OR-able values
 * @enum */
const MarkerEnum = {
    /**@readonly*/
    Intro   : 0x1,
    /**@readonly*/
    Credits : 0x2,
    /**@readonly*/
    Ad      : 0x4,
    /**@readonly*/
    All     : 0x1 | 0x2 | 0x4,

    /**
     * Determine whether the given enum values matches the given marker type string.
     * @param {string} markerType
     * @param {number} markerEnum */
    typeMatch : (markerType, markerEnum) => {
        switch (markerType) {
            case MarkerType.Intro:
                return (markerEnum & MarkerEnum.Intro) !== 0;
            case MarkerType.Credits:
                return (markerEnum & MarkerEnum.Credits) !== 0;
            case MarkerType.Ad:
                return (markerEnum & MarkerEnum.Ad) !== 0;
            default:
                return false;
        }
    }
};

export { MarkerEnum, MarkerType, supportedMarkerType };
