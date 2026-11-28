// @ts-check
'use strict';

const { VirtualPadClient } = require('./virtualpad');
const controllers = require('./controllers');

const DEFAULT_DAEMON_PORT = 26780;
const SLOT_COUNT = 4;

const VALID_JOYCON_MODES = new Set([
    'combined',
    'split_left',
    'split_right'
]);

/** @type {Record<string, LegacyControllerKind>} */
const LEGACY_KIND_MAP = {
    xbox: 'xbox',
    switch: 'switch',
    switch_pro: 'switch',
    switch_joycon_left: 'switch',
    switch_joycon_right: 'switch',
    joycon_left: 'switch',
    joycon_right: 'switch',
    joycon_pair: 'switch',
    gamecube: 'gamecube',
    wiimote: 'wiimote',
    playstation: 'generic',
    generic: 'generic'
};

/** @type {Record<string, string>} */
const CONNECTION_LABEL_MAP = {
    usb: 'USB',
    bluetooth: 'Bluetooth',
    wireless: 'Wireless',
    unknown: 'Connected'
};

/**
 * @typedef {import('./virtualpad').PhysicalControllerInfo} PhysicalControllerInfo
 */

/**
 * @typedef {import('./virtualpad').VirtualSlotState} VirtualSlotState
 */

/**
 * @typedef {import('./virtualpad').JoyConMode} JoyConMode
 */

/**
 * @typedef {import('./virtualpad').BatteryLevelInfo} BatteryLevelInfo
 */

/**
 * @typedef {import('./virtualpad').LogFunction} LogFunction
 */

/**
 * @typedef {'xbox'|'switch'|'gamecube'|'wiimote'|'generic'} LegacyControllerKind
 */

/**
 * Controller record shape expected by `controllers.js`, `players.js`, `inputconfig.js`, and `server.js`.
 * @typedef {Object} LegacyControllerRecord
 * @property {string} id
 * @property {string} name
 * @property {LegacyControllerKind} kind
 * @property {string} label
 * @property {string} connection
 * @property {string} vendor
 * @property {string} product
 * @property {string} bus
 * @property {string} version
 * @property {string|null} address
 * @property {string|null} reportedAddress
 * @property {string[]} addresses
 * @property {string[]} reportedAddresses
 * @property {number[]} keys
 * @property {number|null} js
 * @property {number|null} sdlIndex
 * @property {number} nameIndex
 * @property {boolean} pad
 * @property {number} player
 * @property {boolean} combined
 * @property {string[]} members
 * @property {string[]} memberKeys
 * @property {string[]} memberNames
 * @property {string} [sdlName]
 * @property {boolean} hasGyro
 * @property {boolean} hasAccelerometer
 * @property {BatteryLevelInfo|null} batteryLevel
 * @property {number|null} assignedSlot
 * @property {JoyConMode|null} joyconMode
 * @property {string} daemonId
 */

/**
 * Options accepted by `createDaemonBridge` and `DaemonBridge`.
 * @typedef {Object} DaemonBridgeOptions
 * @property {number} [port]
 * @property {string} [host]
 * @property {number} [reconnectMs]
 * @property {number} [requestTimeoutMs]
 * @property {LogFunction} [log]
 * @property {boolean} [autoConnect]
 * @property {VirtualPadClient} [client]
 */

/**
 * Options forwarded to `controllers.detect()` when falling back to OS detection.
 * @typedef {Object} DetectControllersOptions
 * @property {string} [platform]
 * @property {string} [procFile]
 * @property {string} [usbRoot]
 * @property {string} [sysRoot]
 * @property {number} [now]
 * @property {{ merges?: string[][], splits?: string[][], auto?: boolean }} [merge]
 */

/**
 * Combined daemon connection and virtual slot snapshot.
 * @typedef {Object} DaemonStatusSnapshot
 * @property {boolean} connected
 * @property {VirtualSlotState[]} slots
 * @property {PhysicalControllerInfo[]} physicalControllers
 */

/**
 * Checks whether a value is a non-null plain object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Creates four empty virtual slot records for disconnected fallback state.
 * @returns {VirtualSlotState[]}
 */
function createEmptySlots() {
    /** @type {VirtualSlotState[]} */
    const slots = [];
    for (let slotIndex = 0; slotIndex < SLOT_COUNT; slotIndex += 1) {
        slots.push({
            index: slotIndex,
            assignedPhysical: null,
            active: false
        });
    }
    return slots;
}

/**
 * Validates that a slot index is an integer from 0 to 3.
 * @param {number} slotIndex
 * @param {string} parameterName
 * @returns {number}
 */
function validateSlotIndex(slotIndex, parameterName) {
    if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex)) {
        throw new TypeError(`${parameterName} must be an integer between 0 and 3`);
    }
    if (slotIndex < 0 || slotIndex >= SLOT_COUNT) {
        throw new RangeError(`${parameterName} must be between 0 and 3, received ${slotIndex}`);
    }
    return slotIndex;
}

/**
 * Validates and trims a physical controller identifier.
 * @param {string} controllerId
 * @returns {string}
 */
function validateControllerId(controllerId) {
    if (typeof controllerId !== 'string') {
        throw new TypeError('controllerId must be a non-empty string');
    }
    const trimmed = controllerId.trim();
    if (trimmed.length === 0) {
        throw new RangeError('controllerId must not be empty');
    }
    return trimmed;
}

/**
 * Validates a Joy-Con mode string.
 * @param {string} mode
 * @returns {JoyConMode}
 */
function validateJoyConMode(mode) {
    if (typeof mode !== 'string') {
        throw new TypeError('mode must be a string');
    }
    const trimmed = mode.trim();
    if (!VALID_JOYCON_MODES.has(trimmed)) {
        throw new RangeError(`mode must be one of combined, split_left, split_right; received "${trimmed}"`);
    }
    return /** @type {JoyConMode} */ (trimmed);
}

/**
 * Formats a numeric USB/Bluetooth vendor or product ID into a 4-character hex string.
 * @param {number} numericId
 * @returns {string}
 */
function formatHexId(numericId) {
    if (typeof numericId !== 'number' || !Number.isFinite(numericId) || numericId <= 0) {
        return '';
    }
    const normalized = Math.trunc(numericId) & 0xffff;
    return normalized.toString(16).padStart(4, '0');
}

/**
 * Validates bridge constructor options and returns normalized settings.
 * @param {DaemonBridgeOptions|undefined} options
 * @returns {{ port: number, host: string|undefined, reconnectMs: number|undefined, requestTimeoutMs: number|undefined, log: LogFunction, autoConnect: boolean, client: VirtualPadClient|undefined }}
 */
function validateBridgeOptions(options) {
    if (options !== undefined && !isPlainObject(options)) {
        throw new TypeError('options must be a plain object');
    }

    const source = options || {};
    const port = source.port === undefined ? DEFAULT_DAEMON_PORT : source.port;
    const log = source.log === undefined ? console.log : source.log;
    const autoConnect = source.autoConnect === undefined ? true : source.autoConnect;

    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RangeError('port must be an integer between 1 and 65535');
    }
    if (source.host !== undefined && (typeof source.host !== 'string' || source.host.trim().length === 0)) {
        throw new TypeError('host must be a non-empty string');
    }
    if (source.reconnectMs !== undefined && (typeof source.reconnectMs !== 'number' || !Number.isFinite(source.reconnectMs) || source.reconnectMs < 0)) {
        throw new RangeError('reconnectMs must be a non-negative finite number');
    }
    if (source.requestTimeoutMs !== undefined && (typeof source.requestTimeoutMs !== 'number' || !Number.isFinite(source.requestTimeoutMs) || source.requestTimeoutMs <= 0)) {
        throw new RangeError('requestTimeoutMs must be a positive finite number');
    }
    if (typeof log !== 'function') {
        throw new TypeError('log must be a function');
    }
    if (typeof autoConnect !== 'boolean') {
        throw new TypeError('autoConnect must be a boolean');
    }
    if (source.client !== undefined && !(source.client instanceof VirtualPadClient)) {
        throw new TypeError('client must be an instance of VirtualPadClient');
    }

    return {
        port,
        host: source.host !== undefined ? source.host.trim() : undefined,
        reconnectMs: source.reconnectMs,
        requestTimeoutMs: source.requestTimeoutMs,
        log,
        autoConnect,
        client: source.client
    };
}

/**
 * Converts a daemon BatteryLevelInfo object into the legacy `battery` shape consumed by `ui/index.html`.
 * @param {BatteryLevelInfo|null} batteryLevel
 * @returns {{ percent: number|null, level: string, charging: boolean, low: boolean }|null}
 */
function convertBatteryLevel(batteryLevel) {
    if (!batteryLevel || typeof batteryLevel.level !== 'string') {
        return null;
    }
    const level = batteryLevel.level.toLowerCase();
    if (level === 'unknown' || level === 'wired') {
        return null;
    }
    const percentMap = {
        empty: 5,
        critical: 10,
        low: 20,
        medium: 60,
        normal: 60,
        high: 85,
        full: 100
    };
    return {
        percent: percentMap[level] ?? null,
        level,
        charging: level === 'charging',
        low: level === 'empty' || level === 'critical' || level === 'low'
    };
}

/**
 * Converts a PhysicalControllerInfo record from the daemon into the legacy object shape
 * produced by `controllers.js` and consumed by `players.js`, `inputconfig.js`, and `server.js`.
 * @param {PhysicalControllerInfo} physicalController
 * @param {number} [index=0]
 * @param {number} [nameIndex=0]
 * @param {number} [padOrderIndex=0]
 * @returns {LegacyControllerRecord}
 */
function convertToLegacyFormat(physicalController, index = 0, nameIndex = 0, padOrderIndex = 0) {
    if (!isPlainObject(physicalController)) {
        throw new TypeError('physicalController must be an object');
    }
    if (typeof physicalController.id !== 'string' || physicalController.id.trim().length === 0) {
        throw new TypeError('physicalController.id must be a non-empty string');
    }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        throw new RangeError('index must be a non-negative integer');
    }
    if (typeof nameIndex !== 'number' || !Number.isInteger(nameIndex) || nameIndex < 0) {
        throw new RangeError('nameIndex must be a non-negative integer');
    }
    if (typeof padOrderIndex !== 'number' || !Number.isInteger(padOrderIndex) || padOrderIndex < 0) {
        throw new RangeError('padOrderIndex must be a non-negative integer');
    }

    const controllerId = physicalController.id.trim();
    const controllerName = typeof physicalController.name === 'string' && physicalController.name.trim().length > 0
        ? physicalController.name.trim()
        : controllerId;
    const rawKind = typeof physicalController.kind === 'string' ? physicalController.kind : 'generic';
    /** @type {LegacyControllerKind} */
    const legacyKind = LEGACY_KIND_MAP[rawKind] || 'generic';
    const combined = physicalController.joyconMode === 'combined' || rawKind === 'joycon_pair';
    const isPad = legacyKind !== 'wiimote';

    const assignedSlot = (
        typeof physicalController.assignedSlot === 'number'
        && Number.isInteger(physicalController.assignedSlot)
        && physicalController.assignedSlot >= 0
        && physicalController.assignedSlot < SLOT_COUNT
    )
        ? physicalController.assignedSlot
        : null;

    const connectionType = typeof physicalController.connectionType === 'string'
        ? physicalController.connectionType
        : 'unknown';
    const connection = CONNECTION_LABEL_MAP[connectionType] || 'Connected';
    const bus = connectionType === 'bluetooth'
        ? '0005'
        : (connectionType === 'usb' ? '0003' : '0000');

    const label = combined
        ? 'Switch Controller (combined)'
        : (controllers.KIND_LABELS[legacyKind] || 'Game Controller');

    const player = assignedSlot !== null ? assignedSlot + 1 : index + 1;
    const jsDeviceIndex = isPad ? (assignedSlot !== null ? assignedSlot : index) : null;
    const sdlIndex = isPad ? (assignedSlot !== null ? assignedSlot : padOrderIndex) : null;

    /** @type {LegacyControllerRecord} */
    const legacyRecord = {
        id: controllerId,
        name: controllerName,
        kind: legacyKind,
        label,
        connection,
        vendor: formatHexId(physicalController.vendorId),
        product: formatHexId(physicalController.productId),
        bus,
        version: '0000',
        address: null,
        reportedAddress: null,
        addresses: [],
        reportedAddresses: [],
        keys: [],
        js: jsDeviceIndex,
        sdlIndex,
        nameIndex,
        pad: isPad,
        player,
        combined,
        members: [],
        memberKeys: [],
        memberNames: [],
        hasGyro: Boolean(physicalController.hasGyro),
        hasAccelerometer: Boolean(physicalController.hasAccelerometer),
        batteryLevel: physicalController.batteryLevel ? { level: physicalController.batteryLevel.level } : null,
        battery: convertBatteryLevel(physicalController.batteryLevel),
        assignedSlot,
        joyconMode: physicalController.joyconMode ?? null,
        daemonId: controllerId
    };

    if (combined) {
        legacyRecord.sdlName = controllers.JOYCON_PAIR_SDL_NAME;
    }

    return legacyRecord;
}

/**
 * Bridges `ui/server.js` controller detection and slot management with `VirtualPadClient`.
 */
class DaemonBridge {
    /**
     * Creates a new DaemonBridge instance and initiates connection to the daemon.
     * @param {DaemonBridgeOptions} [options={}]
     */
    constructor(options = {}) {
        const validated = validateBridgeOptions(options);

        /** @private @type {LogFunction} */
        this._log = validated.log;

        if (validated.client) {
            /** @private @type {VirtualPadClient} */
            this._client = validated.client;
        }
        else {
            /** @type {import('./virtualpad').VirtualPadClientOptions} */
            const clientOptions = {
                port: validated.port,
                log: validated.log
            };
            if (validated.host !== undefined) {
                clientOptions.host = validated.host;
            }
            if (validated.reconnectMs !== undefined) {
                clientOptions.reconnectMs = validated.reconnectMs;
            }
            if (validated.requestTimeoutMs !== undefined) {
                clientOptions.requestTimeoutMs = validated.requestTimeoutMs;
            }
            this._client = new VirtualPadClient(clientOptions);
        }

        if (validated.autoConnect) {
            this._client.connect().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this._log(`[DAEMON-BRIDGE] Initial connection failed: ${message}`);
            });
        }
    }

    /**
     * Whether the virtualpad daemon is currently connected.
     * @returns {boolean}
     */
    get daemonConnected() {
        return this._client.connected;
    }

    /**
     * Raw VirtualPadClient instance for subscribing to daemon events.
     * @returns {VirtualPadClient}
     */
    get client() {
        return this._client;
    }

    /**
     * Detects controllers using daemon state when connected, falling back to OS detection.
     * @param {DetectControllersOptions} [options={}]
     * @returns {LegacyControllerRecord[]}
     */
    detectControllers(options = {}) {
        if (options !== undefined && !isPlainObject(options)) {
            throw new TypeError('options must be a plain object');
        }

        if (this._client.connected) {
            const physicalControllers = this._client.state.physicalControllers;
            /** @type {Map<string, number>} */
            const nameCountMap = new Map();
            let padOrderIndex = 0;

            return physicalControllers.map((physicalController, index) => {
                const nameKey = physicalController.name || physicalController.id;
                const nameIndex = nameCountMap.get(nameKey) || 0;
                nameCountMap.set(nameKey, nameIndex + 1);

                const converted = convertToLegacyFormat(physicalController, index, nameIndex, padOrderIndex);
                if (converted.pad) {
                    padOrderIndex += 1;
                }
                return converted;
            });
        }

        return controllers.detect(options);
    }

    /**
     * Returns the 4 virtual slot states from the daemon, or empty fallback slots if disconnected.
     * @returns {VirtualSlotState[]}
     */
    getSlots() {
        if (this._client.connected) {
            return this._client.state.slots;
        }
        return createEmptySlots();
    }

    /**
     * Returns a full daemon status snapshot including connection state, slots, and physical controllers.
     * @returns {DaemonStatusSnapshot}
     */
    getStatus() {
        return {
            connected: this._client.connected,
            slots: this.getSlots(),
            physicalControllers: this._client.connected ? this._client.listPhysical() : []
        };
    }

    /**
     * Assigns a physical controller to a virtual slot (0-3) via the daemon.
     * @param {string} controllerId
     * @param {number} slotIndex
     * @returns {Promise<void>}
     */
    async assign(controllerId, slotIndex) {
        const validControllerId = validateControllerId(controllerId);
        const validSlotIndex = validateSlotIndex(slotIndex, 'slotIndex');
        this._assertDaemonConnected();
        await this._client.assign(validControllerId, validSlotIndex);
    }

    /**
     * Unassigns a physical controller from its virtual slot via the daemon.
     * @param {string} controllerId
     * @returns {Promise<void>}
     */
    async unassign(controllerId) {
        const validControllerId = validateControllerId(controllerId);
        this._assertDaemonConnected();
        await this._client.unassign(validControllerId);
    }

    /**
     * Swaps two virtual controller slots (0-3) via the daemon.
     * @param {number} slotA
     * @param {number} slotB
     * @returns {Promise<void>}
     */
    async swapSlots(slotA, slotB) {
        const validSlotA = validateSlotIndex(slotA, 'slotA');
        const validSlotB = validateSlotIndex(slotB, 'slotB');
        this._assertDaemonConnected();
        await this._client.swapSlots(validSlotA, validSlotB);
    }

    /**
     * Sets the Joy-Con operating mode (`combined`, `split_left`, or `split_right`) via the daemon.
     * @param {string} controllerId
     * @param {JoyConMode|string} mode
     * @returns {Promise<void>}
     */
    async setJoyConMode(controllerId, mode) {
        const validControllerId = validateControllerId(controllerId);
        const validMode = validateJoyConMode(mode);
        this._assertDaemonConnected();
        await this._client.setJoyConMode(validControllerId, validMode);
    }

    /**
     * Requests that the daemon auto-assign unassigned controllers to free virtual slots.
     * @returns {Promise<void>}
     */
    async autoAssign() {
        this._assertDaemonConnected();
        await this._client.autoAssign();
    }

    /**
     * Closes the daemon client connection and cancels reconnect timers.
     * @returns {void}
     */
    disconnect() {
        this._client.disconnect();
    }

    /**
     * Ensures the daemon is connected before sending a mutation command.
     * @private
     * @returns {void}
     */
    _assertDaemonConnected() {
        if (!this._client.connected) {
            throw new Error('Virtual controller daemon is not connected');
        }
    }
}

/**
 * Creates a bridge that uses the virtual controller daemon when available,
 * falling back to the existing `controllers.detect()` flow when the daemon
 * is not running.
 * @param {DaemonBridgeOptions} [options={}]
 * @returns {DaemonBridge}
 */
function createDaemonBridge(options = {}) {
    return new DaemonBridge(options);
}

module.exports = {
    DaemonBridge,
    createDaemonBridge,
    convertToLegacyFormat
};
