// @ts-check
'use strict';

// Generates static emulator controller configurations pointing to the four
// virtual gamepad devices ("Virtual Pad 1" through "Virtual Pad 4") and the
// local DSU motion server (127.0.0.1:26760 by default).
//
// Existing config files are updated idempotently (keeping unrelated settings),
// with a one-time backup written to <file>.emulator-menu.bak before modifying.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ini, save } = require('./ini');
const mappings = require('./mappings');
const platformLibrary = require('./platform');
const playersLibrary = require('./players');
const adapters = require('./saves/adapters');

const MAX_VIRTUAL_SLOTS = 4;
const DEFAULT_DSU_PORT = 26760;
const DSU_SERVER_HOST = '127.0.0.1';

// Virtual Xbox 360 Wired hardware identifiers matching the virtualpad daemon.
const VIRTUAL_BUS_HEX = '0003';
const VIRTUAL_VENDOR_HEX = '045e';
const VIRTUAL_PRODUCT_HEX = '028e';
const VIRTUAL_VERSION_HEX = '0110';

// Dolphin SIDevice values.
const DOLPHIN_SI_NONE = 0;
const DOLPHIN_SI_GAMECUBE_CONTROLLER = 6;

// Dolphin Wiimote Source values.
const DOLPHIN_WIIMOTE_NONE = 0;
const DOLPHIN_WIIMOTE_REAL = 2;

const DOLPHIN_FLATPAK_ID = 'org.DolphinEmu.dolphin-emu';
const VALID_GAMES = new Set(['wii', 'gamecube']);
const VALID_EMULATORS = new Set(['dolphin', 'ryujinx']);

/**
 * @typedef {Object} PlatformContext
 * @property {string} [home] - User home directory override
 * @property {string} [platform] - Platform identifier ('linux' or 'win32')
 * @property {NodeJS.ProcessEnv} [env] - Environment variables
 * @property {(emulatorId: string) => (string|null)} [exePath] - Resolver for emulator executable path
 */

/**
 * @typedef {Object} MappingProfile
 * @property {string} id - Mapping profile identifier
 * @property {string} name - Human-readable profile name
 * @property {string} target - Target console ('wii', 'gamecube', or 'switch')
 * @property {string} family - Controller family ('generic', 'nintendo', or 'wiimote')
 * @property {string} extension - Wii extension ('nunchuk', 'classic', or 'none')
 * @property {Object<string, string>} settings - Emulator-specific profile options
 * @property {Object<string, string>} entries - Control binding entries
 */

/**
 * @typedef {Object} ProfileStore
 * @property {(id: string) => (MappingProfile|null)} get - Look up a profile by identifier
 */

/**
 * @typedef {Object} NormalizedPlayerSettings
 * @property {string} device - Controller selector ('auto', 'none', 'real', or 'pad:<id>')
 * @property {string} wii - Wii mapping profile identifier or 'auto'
 * @property {string} gc - GameCube mapping profile identifier or 'auto'
 * @property {string} sw - Switch mapping profile identifier or 'auto'
 */

/**
 * @typedef {Object} VirtualApplyOptions
 * @property {number} activePlayers - Number of active virtual controller slots (0-4)
 * @property {boolean[]} [realWiimotes] - Per-slot flag indicating real Wii Remote usage
 * @property {'wii'|'gamecube'|null} [game] - Active console for Dolphin ('wii' or 'gamecube')
 * @property {number} [dsuPort] - DSU UDP server port (default 26760)
 * @property {ProfileStore} [profiles] - Mapping profiles store
 * @property {Array<Object>} [players] - Per-player mapping preferences
 */

/**
 * @typedef {Object} ValidatedOptions
 * @property {number} activePlayers - Validated number of active virtual slots (0-4)
 * @property {boolean[]} realWiimotes - 4-element boolean array for real Wii Remote slots
 * @property {'wii'|'gamecube'|null} game - Normalized game target or null
 * @property {number} dsuPort - Validated DSU UDP port number
 * @property {ProfileStore} profilesStore - Profile store instance
 * @property {NormalizedPlayerSettings[]} normalizedPlayers - 4 normalized player preference objects
 */

/**
 * @typedef {Object} ValidatedContext
 * @property {string} home - Resolved home directory
 * @property {string} platform - Resolved platform identifier ('linux' or 'win32')
 * @property {NodeJS.ProcessEnv} env - Environment map
 * @property {(emulatorId: string) => (string|null)} exePath - Executable path resolver
 */

/**
 * @typedef {Object} ApplyResult
 * @property {string} emulator - Emulator identifier
 * @property {'configured'|'skipped'|'unsupported'|'error'} status - Configuration outcome status
 * @property {boolean} changed - Whether any config file content changed on disk
 * @property {string} message - Human-readable outcome description
 */

/**
 * @typedef {Object} RyujinxMotionConfig
 * @property {string} motion_backend - Motion backend ('CemuHook')
 * @property {string} dsu_server_host - DSU server IP address
 * @property {number} dsu_server_port - DSU server UDP port
 * @property {number} slot - DSU controller slot index (0-3)
 * @property {number} alt_slot - Secondary DSU controller slot index
 * @property {boolean} mirror_input - Whether input mirroring is enabled
 * @property {number} sensitivity - Gyro sensitivity
 * @property {number} gyro_deadzone - Gyro deadzone threshold
 * @property {boolean} enable_motion - Whether motion controls are active
 */

/**
 * @typedef {Object} RyujinxRumbleConfig
 * @property {number} strong_rumble - Strong motor intensity multiplier
 * @property {number} weak_rumble - Weak motor intensity multiplier
 * @property {boolean} enable_rumble - Whether rumble is enabled
 */

/**
 * @typedef {Object} RyujinxControllerPatch
 * @property {Object<string, string>} left_joycon - Left Joy-Con button fields
 * @property {Object<string, string>} right_joycon - Right Joy-Con button fields
 * @property {Object<string, (string|boolean)>} left_joycon_stick - Left analog stick fields
 * @property {Object<string, (string|boolean)>} right_joycon_stick - Right analog stick fields
 * @property {RyujinxMotionConfig} motion - Motion fields
 * @property {RyujinxRumbleConfig} rumble - Rumble fields
 */

/**
 * @typedef {Object} RyujinxInputEntry
 * @property {Object<string, (string|boolean)>} left_joycon_stick
 * @property {Object<string, (string|boolean)>} right_joycon_stick
 * @property {number} deadzone_left
 * @property {number} deadzone_right
 * @property {number} range_left
 * @property {number} range_right
 * @property {number} trigger_threshold
 * @property {RyujinxMotionConfig} motion
 * @property {RyujinxRumbleConfig} rumble
 * @property {{ enable_led: boolean, turn_off_led: boolean, use_rainbow: boolean, led_color: number }} led
 * @property {Object<string, string>} left_joycon
 * @property {Object<string, string>} right_joycon
 * @property {number} version
 * @property {string} backend
 * @property {string} controller_type
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [player_index]
 */

/** @type {RyujinxInputEntry} */
const BASE_RYUJINX_PAD = {
    left_joycon_stick: {
        joystick: 'Left',
        invert_stick_x: false,
        invert_stick_y: false,
        rotate90_cw: false,
        stick_button: 'LeftStick'
    },
    right_joycon_stick: {
        joystick: 'Right',
        invert_stick_x: false,
        invert_stick_y: false,
        rotate90_cw: false,
        stick_button: 'RightStick'
    },
    deadzone_left: 0.1,
    deadzone_right: 0.1,
    range_left: 1,
    range_right: 1,
    trigger_threshold: 0.5,
    motion: {
        motion_backend: 'CemuHook',
        dsu_server_host: DSU_SERVER_HOST,
        dsu_server_port: DEFAULT_DSU_PORT,
        slot: 0,
        alt_slot: 0,
        mirror_input: false,
        sensitivity: 100,
        gyro_deadzone: 1,
        enable_motion: true
    },
    rumble: {
        strong_rumble: 1,
        weak_rumble: 1,
        enable_rumble: true
    },
    led: {
        enable_led: false,
        turn_off_led: false,
        use_rainbow: false,
        led_color: 0
    },
    left_joycon: {
        button_minus: 'Back',
        button_l: 'LeftShoulder',
        button_zl: 'LeftTrigger',
        button_sl: 'SingleLeftTrigger0',
        button_sr: 'SingleRightTrigger0',
        dpad_up: 'DpadUp',
        dpad_down: 'DpadDown',
        dpad_left: 'DpadLeft',
        dpad_right: 'DpadRight'
    },
    right_joycon: {
        button_plus: 'Start',
        button_r: 'RightShoulder',
        button_zr: 'RightTrigger',
        button_sl: 'SingleLeftTrigger1',
        button_sr: 'SingleRightTrigger1',
        button_x: 'X',
        button_b: 'B',
        button_y: 'Y',
        button_a: 'A'
    },
    version: 1,
    backend: 'GamepadSDL2',
    controller_type: 'ProController'
};

/**
 * Validates that a virtual slot index is an integer within 0..3.
 * @param {number} slotIndex - Virtual controller slot index (0-3)
 * @returns {number} Validated slot index
 */
function validateSlotIndex(slotIndex) {
    if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex)) {
        throw new TypeError(`slotIndex must be an integer, received ${String(slotIndex)}`);
    }
    if (slotIndex < 0 || slotIndex >= MAX_VIRTUAL_SLOTS) {
        throw new RangeError(`slotIndex must be between 0 and ${MAX_VIRTUAL_SLOTS - 1}, received ${slotIndex}`);
    }
    return slotIndex;
}

/**
 * Reverses the byte pairs in an even-length hexadecimal string.
 * @param {string} hexText - Even-length hexadecimal string
 * @returns {string} Byte-reversed hexadecimal string
 */
function reverseHexBytes(hexText) {
    const pairs = hexText.match(/../g);
    if (!pairs) {
        return '';
    }
    return pairs.reverse().join('');
}

/**
 * Computes the static Ryujinx .NET SDL GUID suffix for the virtual Xbox 360 device.
 * @returns {string} Hyphenated .NET SDL GUID without the leading slot prefix
 */
function buildVirtualGuidSuffix() {
    const busBytes = reverseHexBytes(VIRTUAL_BUS_HEX.padStart(4, '0'));
    const vendorBytes = reverseHexBytes(VIRTUAL_VENDOR_HEX.padStart(4, '0'));
    const productBytes = reverseHexBytes(VIRTUAL_PRODUCT_HEX.padStart(4, '0'));
    const versionBytes = reverseHexBytes(VIRTUAL_VERSION_HEX.padStart(4, '0'));

    const segments = [busBytes, '0000', vendorBytes, '0000', productBytes, '0000', versionBytes, '0000'];
    const firstGroup = reverseHexBytes(segments[0] + segments[1]);
    const secondGroup = reverseHexBytes(segments[2]);
    const thirdGroup = reverseHexBytes(segments[3]);
    const fourthGroup = segments[4];
    const fifthGroup = segments[5] + segments[6] + segments[7];

    return `${firstGroup}-${secondGroup}-${thirdGroup}-${fourthGroup}-${fifthGroup}`;
}

const VIRTUAL_GUID_SUFFIX = buildVirtualGuidSuffix();
const VIRTUAL_GUID_PATTERN = new RegExp(`^[0-${MAX_VIRTUAL_SLOTS - 1}]-${VIRTUAL_GUID_SUFFIX}$`);

/**
 * Get the virtual device SDL name for a given slot index.
 * @param {number} slotIndex - Slot index from 0 to 3
 * @returns {string} Static virtual gamepad name (for example, "Virtual Pad 1")
 */
function virtualDeviceName(slotIndex) {
    const validatedIndex = validateSlotIndex(slotIndex);
    return `Virtual Pad ${validatedIndex + 1}`;
}

/**
 * Get the virtual device Ryujinx GUID for a given slot index.
 * @param {number} slotIndex - Slot index from 0 to 3
 * @returns {string} Static Ryujinx SDL GUID (for example, "0-00000003-045e-0000-8e02-000010010000")
 */
function virtualDeviceGuid(slotIndex) {
    const validatedIndex = validateSlotIndex(slotIndex);
    return `${validatedIndex}-${VIRTUAL_GUID_SUFFIX}`;
}

/**
 * Manages generation of static virtual controller configurations for supported emulators.
 */
class VirtualInputConfigurator {
    /**
     * Validates and normalizes the platform context object.
     * @param {PlatformContext|null|undefined} rawContext - Raw platform context passed by caller
     * @returns {ValidatedContext} Sanitized platform context
     */
    normalizeContext(rawContext) {
        if (rawContext !== undefined && rawContext !== null && typeof rawContext !== 'object') {
            throw new TypeError('context must be an object when provided');
        }
        const source = rawContext || {};
        const home = typeof source.home === 'string' && source.home.trim() !== ''
            ? source.home
            : os.homedir();
        const platform = typeof source.platform === 'string' && source.platform.trim() !== ''
            ? source.platform
            : platformLibrary.current();
        const env = source.env && typeof source.env === 'object' ? source.env : process.env;
        const exePath = typeof source.exePath === 'function' ? source.exePath : (() => null);

        return { home, platform, env, exePath };
    }

    /**
     * Validates and sanitizes virtual input configuration options.
     * @param {VirtualApplyOptions|null|undefined} rawOptions - Raw options passed by caller
     * @returns {ValidatedOptions} Validated and sanitized options
     */
    normalizeOptions(rawOptions) {
        if (rawOptions !== undefined && rawOptions !== null && typeof rawOptions !== 'object') {
            throw new TypeError('options must be an object when provided');
        }
        const options = rawOptions || {};

        let activePlayers = 0;
        if (options.activePlayers !== undefined && options.activePlayers !== null) {
            if (typeof options.activePlayers !== 'number' || !Number.isInteger(options.activePlayers)) {
                throw new TypeError(`options.activePlayers must be an integer, received ${String(options.activePlayers)}`);
            }
            if (options.activePlayers < 0 || options.activePlayers > MAX_VIRTUAL_SLOTS) {
                throw new RangeError(`options.activePlayers must be between 0 and ${MAX_VIRTUAL_SLOTS}, received ${options.activePlayers}`);
            }
            activePlayers = options.activePlayers;
        }

        /** @type {boolean[]} */
        const realWiimotes = [false, false, false, false];
        if (options.realWiimotes !== undefined && options.realWiimotes !== null) {
            if (!Array.isArray(options.realWiimotes)) {
                throw new TypeError('options.realWiimotes must be an array of booleans');
            }
            for (let slotIndex = 0; slotIndex < MAX_VIRTUAL_SLOTS; slotIndex += 1) {
                realWiimotes[slotIndex] = Boolean(options.realWiimotes[slotIndex]);
            }
        }

        /** @type {'wii'|'gamecube'|null} */
        let game = null;
        if (options.game !== undefined && options.game !== null && options.game !== '') {
            if (typeof options.game !== 'string') {
                throw new TypeError(`options.game must be a string, received ${typeof options.game}`);
            }
            const normalizedGame = options.game.trim().toLowerCase();
            if (!VALID_GAMES.has(normalizedGame)) {
                throw new RangeError(`options.game must be 'wii' or 'gamecube', received '${options.game}'`);
            }
            game = /** @type {'wii'|'gamecube'} */ (normalizedGame);
        }

        let dsuPort = DEFAULT_DSU_PORT;
        if (options.dsuPort !== undefined && options.dsuPort !== null) {
            if (typeof options.dsuPort !== 'number' || !Number.isInteger(options.dsuPort)) {
                throw new TypeError(`options.dsuPort must be an integer, received ${String(options.dsuPort)}`);
            }
            if (options.dsuPort < 1 || options.dsuPort > 65535) {
                throw new RangeError(`options.dsuPort must be between 1 and 65535, received ${options.dsuPort}`);
            }
            dsuPort = options.dsuPort;
        }

        /** @type {ProfileStore} */
        let profilesStore;
        if (options.profiles !== undefined && options.profiles !== null) {
            if (typeof options.profiles !== 'object' || typeof options.profiles.get !== 'function') {
                throw new TypeError('options.profiles must provide a get(id) method');
            }
            profilesStore = options.profiles;
        }
        else {
            profilesStore = mappings.createStore('');
        }

        const normalizedPlayers = /** @type {NormalizedPlayerSettings[]} */ (
            playersLibrary.normalize(options.players)
        );

        return {
            activePlayers,
            realWiimotes,
            game,
            dsuPort,
            profilesStore,
            normalizedPlayers
        };
    }

    /**
     * Resolves a mapping profile for a player slot and console target, falling back to generic defaults.
     * @param {NormalizedPlayerSettings} playerSettings - Normalized settings for one player
     * @param {'wii'|'gamecube'|'switch'} target - Emulated console target
     * @param {ProfileStore} profilesStore - Mapping profile lookup store
     * @returns {MappingProfile} Resolved mapping profile
     */
    resolveProfile(playerSettings, target, profilesStore) {
        const fieldByTarget = {
            wii: 'wii',
            gamecube: 'gc',
            switch: 'sw'
        };
        const fieldName = fieldByTarget[target];
        const requestedProfileId = playerSettings ? playerSettings[fieldName] : 'auto';
        const chosenProfile = requestedProfileId && requestedProfileId !== 'auto'
            ? profilesStore.get(requestedProfileId)
            : null;

        if (chosenProfile && chosenProfile.target === target && chosenProfile.family !== 'wiimote') {
            return chosenProfile;
        }

        const defaultGenericId = mappings.defaultFor(target, 'generic');
        const resolvedDefault = profilesStore.get(defaultGenericId)
            || profilesStore.get(mappings.DEFAULT_PROFILE[target]);

        if (!resolvedDefault) {
            throw new Error(`Unable to resolve default mapping profile for target '${target}'`);
        }
        return resolvedDefault;
    }

    /**
     * Resolves Dolphin's configuration directory for the target platform.
     * @param {ValidatedContext} context - Validated platform context
     * @returns {string} Path to Dolphin's Config directory
     */
    resolveDolphinConfigDirectory(context) {
        if (context.platform === 'win32') {
            const windowsUserDirectory = adapters.dolphinWindowsUser({
                home: context.home,
                env: context.env,
                exePath: context.exePath
            });
            return path.join(windowsUserDirectory, 'Config');
        }
        return path.join(context.home, '.var', 'app', DOLPHIN_FLATPAK_ID, 'config', 'dolphin-emu');
    }

    /**
     * Formats the static SDL device string expected by Dolphin for a virtual slot.
     * @param {number} slotIndex - Slot index from 0 to 3
     * @returns {string} Dolphin SDL device string (e.g., "SDL/0/Virtual Pad 1")
     */
    formatDolphinDevice(slotIndex) {
        return `SDL/${slotIndex}/${virtualDeviceName(slotIndex)}`;
    }

    /**
     * Collects slot indices (0..activePlayers-1) backed by virtual gamepads rather than real Wii Remotes.
     * @param {ValidatedOptions} options - Validated virtual input options
     * @returns {number[]} Ordered slot indices assigned to virtual gamepads
     */
    collectVirtualSlotIndices(options) {
        /** @type {number[]} */
        const indices = [];
        for (let slotIndex = 0; slotIndex < options.activePlayers; slotIndex += 1) {
            if (!options.realWiimotes[slotIndex]) {
                indices.push(slotIndex);
            }
        }
        return indices;
    }

    /**
     * Writes Dolphin.ini, GCPadNew.ini, and WiimoteNew.ini for virtual controllers and DSU motion.
     * @param {ValidatedContext} context - Validated platform context
     * @param {ValidatedOptions} options - Validated configuration options
     * @returns {{ status: 'configured'|'skipped', changed: boolean, message: string }} Outcome details
     */
    configureDolphin(context, options) {
        const hasRealWiimote = options.realWiimotes.some(Boolean);
        const virtualSlotIndices = this.collectVirtualSlotIndices(options);

        if (virtualSlotIndices.length === 0 && !hasRealWiimote) {
            return {
                status: 'skipped',
                changed: false,
                message: 'No active virtual controllers or real Wii Remotes'
            };
        }

        const configDirectory = this.resolveDolphinConfigDirectory(context);
        const mainIniPath = path.join(configDirectory, 'Dolphin.ini');
        const gamecubeIniPath = path.join(configDirectory, 'GCPadNew.ini');
        const wiimoteIniPath = path.join(configDirectory, 'WiimoteNew.ini');

        const mainIni = Ini.read(mainIniPath);
        const gamecubeIni = Ini.read(gamecubeIniPath);
        const wiimoteIni = Ini.read(wiimoteIniPath);

        const configureWiiSide = options.game !== 'gamecube';
        const configureGamecubeSide = options.game !== 'wii';
        /** @type {string[]} */
        const configuredSummaries = [];

        for (let slotIndex = 0; slotIndex < MAX_VIRTUAL_SLOTS; slotIndex += 1) {
            const sectionName = `Wiimote${slotIndex + 1}`;
            if (!configureWiiSide) {
                wiimoteIni.replaceSection(sectionName, [['Source', String(DOLPHIN_WIIMOTE_NONE)]]);
            }
            else if (options.realWiimotes[slotIndex]) {
                wiimoteIni.replaceSection(sectionName, [['Source', String(DOLPHIN_WIIMOTE_REAL)]]);
                configuredSummaries.push(`Player ${slotIndex + 1}: real Wii Remote`);
            }
            else if (slotIndex < options.activePlayers) {
                const wiiProfile = this.resolveProfile(
                    options.normalizedPlayers[slotIndex],
                    'wii',
                    options.profilesStore
                );
                const deviceName = this.formatDolphinDevice(slotIndex);
                wiimoteIni.replaceSection(sectionName, mappings.dolphinSection(wiiProfile, deviceName));
                configuredSummaries.push(`Player ${slotIndex + 1}: ${virtualDeviceName(slotIndex)} (${wiiProfile.name})`);
            }
            else {
                wiimoteIni.replaceSection(sectionName, [['Source', String(DOLPHIN_WIIMOTE_NONE)]]);
            }
        }

        const gamecubePadSlots = configureGamecubeSide ? virtualSlotIndices : [];
        const hasAnyVirtualPad = virtualSlotIndices.length > 0;

        for (let portIndex = 0; portIndex < MAX_VIRTUAL_SLOTS; portIndex += 1) {
            const assignedSlot = gamecubePadSlots[portIndex];
            if (assignedSlot !== undefined) {
                const gamecubeProfile = this.resolveProfile(
                    options.normalizedPlayers[assignedSlot],
                    'gamecube',
                    options.profilesStore
                );
                const deviceName = this.formatDolphinDevice(assignedSlot);
                mainIni.set('Core', `SIDevice${portIndex}`, String(DOLPHIN_SI_GAMECUBE_CONTROLLER));
                gamecubeIni.replaceSection(
                    `GCPad${portIndex + 1}`,
                    mappings.dolphinSection(gamecubeProfile, deviceName)
                );
                if (!configureWiiSide) {
                    configuredSummaries.push(`Player ${assignedSlot + 1}: ${virtualDeviceName(assignedSlot)} (${gamecubeProfile.name})`);
                }
            }
            else if (hasAnyVirtualPad) {
                mainIni.set('Core', `SIDevice${portIndex}`, String(DOLPHIN_SI_NONE));
            }
        }

        mainIni.set('Input', 'DSUServerAddress', DSU_SERVER_HOST);
        mainIni.set('Input', 'DSUServerPort', String(options.dsuPort));

        if (hasRealWiimote || !configureWiiSide) {
            mainIni.set('Core', 'WiimoteContinuousScanning', 'False');
        }

        const writeFlags = [
            save(mainIniPath, mainIni),
            save(gamecubeIniPath, gamecubeIni),
            save(wiimoteIniPath, wiimoteIni)
        ];

        return {
            status: 'configured',
            changed: writeFlags.some(Boolean),
            message: configuredSummaries.join(', ')
        };
    }

    /**
     * Builds a single Ryujinx input_config entry for one virtual pad slot.
     * @param {number} slotIndex - Virtual pad slot index (0-3)
     * @param {number} playerNumber - Switch player number (1-4)
     * @param {ValidatedOptions} options - Validated virtual input options
     * @param {RyujinxInputEntry[]} previousEntries - Existing Config.json input_config entries
     * @param {Object<string, string>} minusPlusSpelling - Ryujinx Back/Start vs Minus/Plus token map
     * @returns {RyujinxInputEntry} Constructed Ryujinx controller configuration entry
     */
    buildRyujinxEntry(slotIndex, playerNumber, options, previousEntries, minusPlusSpelling) {
        const playerIndex = `Player${playerNumber}`;
        const deviceGuid = virtualDeviceGuid(slotIndex);
        const deviceName = virtualDeviceName(slotIndex);

        const existingEntry = previousEntries.find(
            entry => entry && entry.player_index === playerIndex && entry.id === deviceGuid
        );
        const templateEntry = existingEntry || BASE_RYUJINX_PAD;

        /** @type {RyujinxInputEntry} */
        const entry = {
            ...JSON.parse(JSON.stringify(templateEntry)),
            backend: 'GamepadSDL2',
            id: deviceGuid,
            name: `${deviceName} (${slotIndex})`,
            player_index: playerIndex,
            controller_type: 'ProController'
        };

        const switchProfile = this.resolveProfile(
            options.normalizedPlayers[slotIndex],
            'switch',
            options.profilesStore
        );
        const patch = /** @type {RyujinxControllerPatch} */ (mappings.ryujinxPatch(switchProfile));

        const buttonAndStickGroups = ['left_joycon', 'right_joycon', 'left_joycon_stick', 'right_joycon_stick'];
        for (const groupName of buttonAndStickGroups) {
            const groupPatch = patch[groupName] || {};
            /** @type {Object<string, (string|boolean)>} */
            const mappedFields = {};
            for (const [fieldKey, fieldValue] of Object.entries(groupPatch)) {
                if (typeof fieldValue === 'string' && minusPlusSpelling[fieldValue]) {
                    mappedFields[fieldKey] = minusPlusSpelling[fieldValue];
                }
                else {
                    mappedFields[fieldKey] = fieldValue;
                }
            }
            entry[groupName] = {
                ...(entry[groupName] || {}),
                ...mappedFields
            };
        }

        entry.rumble = {
            ...(entry.rumble || {}),
            enable_rumble: Boolean(patch.rumble && patch.rumble.enable_rumble)
        };

        entry.motion = {
            ...(entry.motion || {}),
            enable_motion: Boolean(patch.motion && patch.motion.enable_motion),
            motion_backend: 'CemuHook',
            dsu_server_host: DSU_SERVER_HOST,
            dsu_server_port: options.dsuPort,
            slot: slotIndex,
            alt_slot: slotIndex,
            mirror_input: false
        };

        return entry;
    }

    /**
     * Atomically writes Config.json with backup creation when content has changed.
     * @param {string} configFilePath - Full path to Ryujinx Config.json
     * @param {string} nextText - Formatted JSON content to write
     * @param {string} originalText - Original file contents read before modification
     * @returns {boolean} True when the file on disk was updated
     */
    writeRyujinxConfigFile(configFilePath, nextText, originalText) {
        const normalizedOriginal = originalText.replace(/\r\n/g, '\n').trimEnd();
        if (nextText === normalizedOriginal) {
            fs.rmSync(`${configFilePath}.emulator-menu.last`, { force: true });
            return false;
        }

        const backupFilePath = `${configFilePath}.emulator-menu.bak`;
        if (!fs.existsSync(backupFilePath)) {
            fs.copyFileSync(configFilePath, backupFilePath);
        }
        fs.copyFileSync(configFilePath, `${configFilePath}.emulator-menu.last`);

        const temporaryFilePath = `${configFilePath}.tmp-${process.pid}`;
        fs.writeFileSync(temporaryFilePath, nextText);
        fs.renameSync(temporaryFilePath, configFilePath);
        return true;
    }

    /**
     * Writes static virtual pad GUIDs and CemuHook DSU motion settings into Ryujinx Config.json.
     * @param {ValidatedContext} context - Validated platform context
     * @param {ValidatedOptions} options - Validated virtual input options
     * @returns {{ status: 'configured'|'skipped', changed: boolean, message: string }} Outcome details
     */
    configureRyujinx(context, options) {
        const dataRoot = adapters.create({
            platform: context.platform,
            home: context.home,
            env: context.env,
            exePath: context.exePath
        }).get('ryujinx').dataRoot();

        const configFilePath = path.join(dataRoot, 'Config.json');
        if (!fs.existsSync(configFilePath)) {
            return {
                status: 'skipped',
                changed: false,
                message: 'Open Ryujinx once from Settings first'
            };
        }

        const virtualSlotIndices = this.collectVirtualSlotIndices(options);
        if (virtualSlotIndices.length === 0) {
            return {
                status: 'skipped',
                changed: false,
                message: 'No active virtual controllers'
            };
        }

        const originalText = fs.readFileSync(configFilePath, 'utf8');
        const parsedConfig = JSON.parse(originalText);
        if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
            throw new Error('Ryujinx Config.json must contain a JSON object');
        }

        /** @type {RyujinxInputEntry[]} */
        const previousEntries = Array.isArray(parsedConfig.input_config) ? parsedConfig.input_config : [];
        const usesMinusPlus = previousEntries.some(
            entry => entry && entry.left_joycon && entry.left_joycon.button_minus === 'Minus'
        );
        const minusPlusSpelling = usesMinusPlus ? { Back: 'Minus', Start: 'Plus' } : {};

        /** @type {RyujinxInputEntry[]} */
        const configuredEntries = virtualSlotIndices.map((slotIndex, orderIndex) => {
            return this.buildRyujinxEntry(
                slotIndex,
                orderIndex + 1,
                options,
                previousEntries,
                minusPlusSpelling
            );
        });

        const takenPlayerIndices = new Set(configuredEntries.map(entry => entry.player_index));
        const takenIds = new Set(configuredEntries.map(entry => entry.id));
        const preservedEntries = previousEntries.filter((entry) => {
            if (!entry || typeof entry !== 'object') {
                return false;
            }
            if (takenPlayerIndices.has(entry.player_index) || takenIds.has(entry.id)) {
                return false;
            }
            if (typeof entry.id === 'string' && VIRTUAL_GUID_PATTERN.test(entry.id)) {
                return false;
            }
            return true;
        });

        parsedConfig.input_config = [...configuredEntries, ...preservedEntries].sort((first, second) => {
            return String(first.player_index || '').localeCompare(String(second.player_index || ''));
        });

        const nextText = JSON.stringify(parsedConfig, null, 2);
        const changed = this.writeRyujinxConfigFile(configFilePath, nextText, originalText);
        const summary = configuredEntries.map(entry => `${entry.player_index}: ${entry.name}`).join(', ');

        return {
            status: 'configured',
            changed,
            message: summary
        };
    }

    /**
     * Write static virtual slot configs for an emulator. Never throws so game launch is not blocked.
     * @param {string} emulatorId - Emulator identifier ('dolphin' or 'ryujinx')
     * @param {PlatformContext} [context] - Platform context (home, platform, env, exePath)
     * @param {VirtualApplyOptions} [options] - Virtual slot and mapping options
     * @returns {ApplyResult} Configuration outcome for the emulator
     */
    apply(emulatorId, context, options) {
        const normalizedEmulatorId = typeof emulatorId === 'string' ? emulatorId.trim().toLowerCase() : '';
        if (!VALID_EMULATORS.has(normalizedEmulatorId)) {
            return {
                emulator: normalizedEmulatorId || String(emulatorId || ''),
                status: 'unsupported',
                changed: false,
                message: 'Set up controllers in the emulator itself (Settings → Open)'
            };
        }

        try {
            const validatedContext = this.normalizeContext(context);
            const validatedOptions = this.normalizeOptions(options);

            if (normalizedEmulatorId === 'dolphin') {
                return {
                    emulator: normalizedEmulatorId,
                    ...this.configureDolphin(validatedContext, validatedOptions)
                };
            }
            return {
                emulator: normalizedEmulatorId,
                ...this.configureRyujinx(validatedContext, validatedOptions)
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                emulator: normalizedEmulatorId,
                status: 'error',
                changed: false,
                message
            };
        }
    }
}

const configurator = new VirtualInputConfigurator();

module.exports = {
    /**
     * Write static virtual slot configs for an emulator.
     * @param {string} emulatorId - 'dolphin' or 'ryujinx'
     * @param {PlatformContext} [context] - Platform context (home, platform, env, etc.)
     * @param {VirtualApplyOptions} [options] - Configuration options for virtual slots and motion
     * @returns {ApplyResult} Configuration status, change flag, and message
     */
    apply(emulatorId, context, options) {
        return configurator.apply(emulatorId, context, options);
    },

    /**
     * Get the virtual device SDL name for a given slot index.
     * @param {number} slotIndex - Slot index (0-3)
     * @returns {string} Static virtual gamepad name (e.g., "Virtual Pad 1")
     */
    virtualDeviceName,

    /**
     * Get the virtual device Ryujinx GUID for a given slot index.
     * @param {number} slotIndex - Slot index (0-3)
     * @returns {string} Static Ryujinx SDL GUID
     */
    virtualDeviceGuid
};
