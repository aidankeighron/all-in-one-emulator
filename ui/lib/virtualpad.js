// @ts-check
'use strict';

const { EventEmitter } = require('events');
const net = require('net');

const DEFAULT_PORT = 26780;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_RECONNECT_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const SLOT_COUNT = 4;
const MAX_RECEIVE_BUFFER_BYTES = 1024 * 1024;

const VALID_CONTROLLER_KINDS = new Set([
    'xbox',
    'switch',
    'switch_joycon_left',
    'switch_joycon_right',
    'playstation',
    'gamecube',
    'generic'
]);

const VALID_CONNECTION_TYPES = new Set([
    'usb',
    'bluetooth',
    'wireless',
    'unknown'
]);

const VALID_JOYCON_MODES = new Set([
    'combined',
    'split_left',
    'split_right'
]);

/**
 * @typedef {'xbox'|'switch'|'switch_joycon_left'|'switch_joycon_right'|'playstation'|'gamecube'|'generic'} ControllerKind
 */

/**
 * @typedef {'usb'|'bluetooth'|'wireless'|'unknown'} ConnectionType
 */

/**
 * @typedef {'combined'|'split_left'|'split_right'} JoyConMode
 */

/**
 * @typedef {Object} BatteryLevelInfo
 * @property {string} level - Battery level descriptor
 */

/**
 * @typedef {Object} PhysicalControllerInfo
 * @property {string} id - Unique controller identifier
 * @property {string} name - Human-readable controller name
 * @property {ControllerKind} kind
 * @property {number} vendorId
 * @property {number} productId
 * @property {boolean} hasGyro
 * @property {boolean} hasAccelerometer
 * @property {BatteryLevelInfo|null} batteryLevel
 * @property {ConnectionType} connectionType
 * @property {number|null} assignedSlot - 0-3 or null
 * @property {JoyConMode|null} joyconMode
 */

/**
 * @typedef {Object} VirtualSlotState
 * @property {number} index - 0-3
 * @property {string|null} assignedPhysical - Physical controller ID or null
 * @property {boolean} active
 */

/**
 * @typedef {Object} DaemonState
 * @property {VirtualSlotState[]} slots - 4 virtual slot states
 * @property {PhysicalControllerInfo[]} physicalControllers
 * @property {boolean} connected - Whether connected to daemon
 */

/**
 * @typedef {Object} HomeButtonEvent
 * @property {string} controllerId
 * @property {number|null} slotIndex
 */

/**
 * @typedef {Object} BatteryEvent
 * @property {string} controllerId
 * @property {string} level
 */

/**
 * @typedef {Function} LogFunction
 * @param {...any} argumentsList
 * @returns {void}
 */

/**
 * @typedef {Object} VirtualPadClientOptions
 * @property {number} [port] - TCP port of the virtualpad daemon (default 26780)
 * @property {string} [host] - Hostname or IP address of the daemon (default '127.0.0.1')
 * @property {number} [reconnectMs] - Reconnect interval in milliseconds (default 2000)
 * @property {number} [requestTimeoutMs] - Query timeout in milliseconds (default 5000)
 * @property {LogFunction} [log] - Logging callback
 */

/**
 * @typedef {Object} PendingStateRequest
 * @property {(state: DaemonState) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {ReturnType<typeof setTimeout>} timer
 */

/**
 * @typedef {Object} IncomingDaemonMessage
 * @property {string} type
 * @property {Array<any>} [slots]
 * @property {Array<any>} [physicalControllers]
 * @property {any} [controller]
 * @property {string} [controllerId]
 * @property {string} [id]
 * @property {number|null} [slotIndex]
 * @property {string|BatteryLevelInfo} [level]
 * @property {string} [message]
 * @property {string} [error]
 */

/**
 * Creates 4 empty virtual slot state objects.
 * @returns {VirtualSlotState[]}
 */
function createEmptySlots() {
    /** @type {VirtualSlotState[]} */
    const slots = [];
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        slots.push({
            index,
            assignedPhysical: null,
            active: false
        });
    }
    return slots;
}

/**
 * Clones a VirtualSlotState object.
 * @param {VirtualSlotState} slot
 * @returns {VirtualSlotState}
 */
function cloneSlot(slot) {
    return {
        index: slot.index,
        assignedPhysical: slot.assignedPhysical,
        active: slot.active
    };
}

/**
 * Clones a PhysicalControllerInfo object.
 * @param {PhysicalControllerInfo} controller
 * @returns {PhysicalControllerInfo}
 */
function cloneController(controller) {
    return {
        id: controller.id,
        name: controller.name,
        kind: controller.kind,
        vendorId: controller.vendorId,
        productId: controller.productId,
        hasGyro: controller.hasGyro,
        hasAccelerometer: controller.hasAccelerometer,
        batteryLevel: controller.batteryLevel ? { level: controller.batteryLevel.level } : null,
        connectionType: controller.connectionType,
        assignedSlot: controller.assignedSlot,
        joyconMode: controller.joyconMode
    };
}

/**
 * Validates that a slot index is an integer between 0 and 3 inclusive.
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
 * Validates a Joy-Con operating mode.
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
 * Normalizes a raw slot entry received from the daemon.
 * @param {any} rawSlot
 * @param {number} fallbackIndex
 * @returns {VirtualSlotState}
 */
function normalizeSlot(rawSlot, fallbackIndex) {
    if (!rawSlot || typeof rawSlot !== 'object') {
        return {
            index: fallbackIndex,
            assignedPhysical: null,
            active: false
        };
    }

    let index = fallbackIndex;
    if (typeof rawSlot.index === 'number' && Number.isInteger(rawSlot.index) && rawSlot.index >= 0 && rawSlot.index < SLOT_COUNT) {
        index = rawSlot.index;
    }

    let assignedPhysical = null;
    if (typeof rawSlot.assignedPhysical === 'string' && rawSlot.assignedPhysical.trim().length > 0) {
        assignedPhysical = rawSlot.assignedPhysical.trim();
    }

    return {
        index,
        assignedPhysical,
        active: Boolean(rawSlot.active)
    };
}

/**
 * Normalizes a battery level value received from the daemon.
 * @param {any} rawBattery
 * @returns {BatteryLevelInfo|null}
 */
function normalizeBatteryLevel(rawBattery) {
    if (rawBattery && typeof rawBattery === 'object' && typeof rawBattery.level === 'string') {
        const trimmed = rawBattery.level.trim();
        if (trimmed.length > 0) {
            return { level: trimmed };
        }
    }
    else if (typeof rawBattery === 'string' && rawBattery.trim().length > 0) {
        return { level: rawBattery.trim() };
    }
    return null;
}

/**
 * Normalizes a raw physical controller descriptor received from the daemon.
 * @param {any} rawController
 * @returns {PhysicalControllerInfo|null}
 */
function normalizePhysicalController(rawController) {
    if (!rawController || typeof rawController !== 'object') {
        return null;
    }
    if (typeof rawController.id !== 'string' || rawController.id.trim().length === 0) {
        return null;
    }

    const id = rawController.id.trim();
    const name = typeof rawController.name === 'string' && rawController.name.trim().length > 0
        ? rawController.name.trim()
        : id;

    /** @type {ControllerKind} */
    let kind = 'generic';
    if (typeof rawController.kind === 'string' && VALID_CONTROLLER_KINDS.has(rawController.kind)) {
        kind = /** @type {ControllerKind} */ (rawController.kind);
    }

    /** @type {ConnectionType} */
    let connectionType = 'unknown';
    if (typeof rawController.connectionType === 'string' && VALID_CONNECTION_TYPES.has(rawController.connectionType)) {
        connectionType = /** @type {ConnectionType} */ (rawController.connectionType);
    }

    /** @type {number|null} */
    let assignedSlot = null;
    if (
        typeof rawController.assignedSlot === 'number'
        && Number.isInteger(rawController.assignedSlot)
        && rawController.assignedSlot >= 0
        && rawController.assignedSlot < SLOT_COUNT
    ) {
        assignedSlot = rawController.assignedSlot;
    }

    /** @type {JoyConMode|null} */
    let joyconMode = null;
    if (typeof rawController.joyconMode === 'string' && VALID_JOYCON_MODES.has(rawController.joyconMode)) {
        joyconMode = /** @type {JoyConMode} */ (rawController.joyconMode);
    }

    const vendorId = typeof rawController.vendorId === 'number' && Number.isFinite(rawController.vendorId)
        ? rawController.vendorId
        : 0;
    const productId = typeof rawController.productId === 'number' && Number.isFinite(rawController.productId)
        ? rawController.productId
        : 0;

    return {
        id,
        name,
        kind,
        vendorId,
        productId,
        hasGyro: Boolean(rawController.hasGyro),
        hasAccelerometer: Boolean(rawController.hasAccelerometer),
        batteryLevel: normalizeBatteryLevel(rawController.batteryLevel),
        connectionType,
        assignedSlot,
        joyconMode
    };
}

/**
 * Validates constructor options and applies defaults.
 * @param {VirtualPadClientOptions} options
 * @returns {{ port: number, host: string, reconnectMs: number, requestTimeoutMs: number, log: LogFunction }}
 */
function validateClientOptions(options) {
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
        throw new TypeError('options must be a plain object');
    }

    const source = options || {};
    const port = source.port === undefined ? DEFAULT_PORT : source.port;
    const host = source.host === undefined ? DEFAULT_HOST : source.host;
    const reconnectMs = source.reconnectMs === undefined ? DEFAULT_RECONNECT_MS : source.reconnectMs;
    const requestTimeoutMs = source.requestTimeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : source.requestTimeoutMs;
    const log = source.log === undefined ? console.log : source.log;

    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RangeError('port must be an integer between 1 and 65535');
    }
    if (typeof host !== 'string' || host.trim().length === 0) {
        throw new TypeError('host must be a non-empty string');
    }
    if (typeof reconnectMs !== 'number' || !Number.isFinite(reconnectMs) || reconnectMs < 0) {
        throw new RangeError('reconnectMs must be a non-negative finite number');
    }
    if (typeof requestTimeoutMs !== 'number' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
        throw new RangeError('requestTimeoutMs must be a positive finite number');
    }
    if (typeof log !== 'function') {
        throw new TypeError('log must be a function');
    }

    return {
        port,
        host: host.trim(),
        reconnectMs,
        requestTimeoutMs,
        log
    };
}

/**
 * TCP newline-delimited JSON client for the virtualpad Rust daemon.
 */
class VirtualPadClient extends EventEmitter {
    /**
     * Creates a new VirtualPadClient instance.
     * @param {VirtualPadClientOptions} [options={}]
     */
    constructor(options = {}) {
        super();
        const validated = validateClientOptions(options);

        /** @private @type {number} */
        this._port = validated.port;
        /** @private @type {string} */
        this._host = validated.host;
        /** @private @type {number} */
        this._reconnectMs = validated.reconnectMs;
        /** @private @type {number} */
        this._requestTimeoutMs = validated.requestTimeoutMs;
        /** @private @type {LogFunction} */
        this._log = validated.log;

        /** @private @type {net.Socket|null} */
        this._socket = null;
        /** @private @type {boolean} */
        this._connected = false;
        /** @private @type {boolean} */
        this._manuallyDisconnected = false;
        /** @private @type {boolean} */
        this._hasReceivedInitialState = false;
        /** @private @type {ReturnType<typeof setTimeout>|null} */
        this._reconnectTimer = null;
        /** @private @type {Promise<void>|null} */
        this._connectPromise = null;
        /** @private @type {(() => void)|null} */
        this._resolveConnectPromise = null;
        /** @private @type {string} */
        this._receiveBuffer = '';

        /** @private @type {VirtualSlotState[]} */
        this._slots = createEmptySlots();
        /** @private @type {PhysicalControllerInfo[]} */
        this._physicalControllers = [];
        /** @private @type {PendingStateRequest[]} */
        this._pendingStateRequests = [];
    }

    /**
     * Whether the client is currently connected to the daemon.
     * @returns {boolean}
     */
    get connected() {
        return this._connected;
    }

    /**
     * Current virtual slot and physical controller state snapshot.
     * @returns {DaemonState}
     */
    get state() {
        return {
            slots: this._slots.map(cloneSlot),
            physicalControllers: this._physicalControllers.map(cloneController),
            connected: this._connected
        };
    }

    /**
     * Connects to the daemon over TCP using newline-delimited JSON.
     * Falls back gracefully if the daemon is unavailable and schedules reconnects.
     * @returns {Promise<void>}
     */
    async connect() {
        if (this._connected && this._socket && !this._socket.destroyed) {
            return;
        }
        if (this._connectPromise) {
            return this._connectPromise;
        }

        this._manuallyDisconnected = false;
        this._clearReconnectTimer();

        this._connectPromise = new Promise((resolve) => {
            let settled = false;
            const settleConnect = () => {
                if (!settled) {
                    settled = true;
                    this._connectPromise = null;
                    this._resolveConnectPromise = null;
                    resolve();
                }
            };

            this._resolveConnectPromise = settleConnect;
            this._receiveBuffer = '';

            const socket = net.createConnection({
                host: this._host,
                port: this._port
            });
            socket.setEncoding('utf8');
            this._socket = socket;

            socket.on('connect', () => {
                if (this._socket !== socket) {
                    socket.destroy();
                    settleConnect();
                    return;
                }
                this._connected = true;
                this._hasReceivedInitialState = false;
                this.emit('connected');
                settleConnect();
            });

            socket.on('data', (chunk) => {
                if (this._socket !== socket) {
                    return;
                }
                this._handleIncomingChunk(String(chunk));
            });

            socket.on('error', (error) => {
                this._log(`[VIRTUALPAD] Socket error (${this._host}:${this._port}): ${error.message}`);
            });

            socket.on('close', () => {
                if (this._socket === socket) {
                    this._socket = null;
                }
                this._receiveBuffer = '';
                this._connected = false;
                this._hasReceivedInitialState = false;
                this._resetState();
                this._rejectPendingRequests(new Error('Disconnected from virtualpad daemon'));

                if (!this._manuallyDisconnected) {
                    this.emit('disconnected');
                    this._scheduleReconnect();
                }
                settleConnect();
            });
        });

        return this._connectPromise;
    }

    /**
     * Disconnects from the daemon and cancels automatic reconnection.
     * @returns {void}
     */
    disconnect() {
        const wasConnected = this._connected;
        this._manuallyDisconnected = true;
        this._clearReconnectTimer();
        this._receiveBuffer = '';
        this._connected = false;
        this._hasReceivedInitialState = false;
        this._resetState();
        this._rejectPendingRequests(new Error('Client disconnected'));

        if (this._socket) {
            const activeSocket = this._socket;
            this._socket = null;
            activeSocket.destroy();
        }
        if (this._resolveConnectPromise) {
            this._resolveConnectPromise();
        }
        if (wasConnected) {
            this.emit('disconnected');
        }
    }

    /**
     * Assigns a physical controller to a virtual slot (0-3).
     * @param {string} controllerId
     * @param {number} slotIndex
     * @returns {Promise<void>}
     */
    async assign(controllerId, slotIndex) {
        const validControllerId = validateControllerId(controllerId);
        const validSlotIndex = validateSlotIndex(slotIndex, 'slotIndex');
        await this._sendMessage({
            type: 'AssignController',
            controllerId: validControllerId,
            slotIndex: validSlotIndex
        });
    }

    /**
     * Unassigns a physical controller from its virtual slot.
     * @param {string} controllerId
     * @returns {Promise<void>}
     */
    async unassign(controllerId) {
        const validControllerId = validateControllerId(controllerId);
        await this._sendMessage({
            type: 'UnassignController',
            controllerId: validControllerId
        });
    }

    /**
     * Swaps the assignments of two virtual slots (0-3).
     * @param {number} slotA
     * @param {number} slotB
     * @returns {Promise<void>}
     */
    async swapSlots(slotA, slotB) {
        const validSlotA = validateSlotIndex(slotA, 'slotA');
        const validSlotB = validateSlotIndex(slotB, 'slotB');
        await this._sendMessage({
            type: 'SwapSlots',
            slotA: validSlotA,
            slotB: validSlotB
        });
    }

    /**
     * Sets the operating mode for a Joy-Con controller.
     * @param {string} controllerId
     * @param {JoyConMode | string} mode
     * @returns {Promise<void>}
     */
    async setJoyConMode(controllerId, mode) {
        const validControllerId = validateControllerId(controllerId);
        const validMode = validateJoyConMode(mode);
        await this._sendMessage({
            type: 'SetJoyConMode',
            controllerId: validControllerId,
            mode: validMode
        });
    }

    /**
     * Requests that the daemon auto-assign unassigned physical controllers to free slots.
     * @returns {Promise<void>}
     */
    async autoAssign() {
        await this._sendMessage({
            type: 'AutoAssign'
        });
    }

    /**
     * Requests a full state refresh from the daemon and resolves with the updated state.
     * @returns {Promise<DaemonState>}
     */
    async queryState() {
        this._assertConnected();

        /** @type {Promise<DaemonState>} */
        const statePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this._pendingStateRequests.indexOf(entry);
                if (index !== -1) {
                    this._pendingStateRequests.splice(index, 1);
                }
                reject(new Error(`Timed out waiting for daemon state after ${this._requestTimeoutMs}ms`));
            }, this._requestTimeoutMs);

            /** @type {PendingStateRequest} */
            const entry = {
                resolve,
                reject,
                timer
            };
            this._pendingStateRequests.push(entry);
        });

        try {
            await this._sendMessage({ type: 'QueryState' });
        }
        catch (error) {
            this._rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
        }

        return statePromise;
    }

    /**
     * Returns a copy of the currently known physical controllers.
     * @returns {PhysicalControllerInfo[]}
     */
    listPhysical() {
        return this._physicalControllers.map(cloneController);
    }

    /**
     * Returns the state of a single virtual slot (0-3).
     * @param {number} index
     * @returns {VirtualSlotState}
     */
    getSlot(index) {
        const validIndex = validateSlotIndex(index, 'index');
        return cloneSlot(this._slots[validIndex]);
    }

    /**
     * Resets cached slots and physical controllers to the empty fallback state.
     * @private
     * @returns {void}
     */
    _resetState() {
        this._slots = createEmptySlots();
        this._physicalControllers = [];
    }

    /**
     * Clears any scheduled reconnect timer.
     * @private
     * @returns {void}
     */
    _clearReconnectTimer() {
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    /**
     * Schedules a reconnection attempt after the configured reconnect delay.
     * @private
     * @returns {void}
     */
    _scheduleReconnect() {
        if (this._manuallyDisconnected || this._connected || this._socket !== null || this._reconnectTimer !== null) {
            return;
        }

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this._manuallyDisconnected && !this._connected) {
                void this.connect();
            }
        }, this._reconnectMs);

        if (typeof this._reconnectTimer.unref === 'function') {
            this._reconnectTimer.unref();
        }
    }

    /**
     * Verifies that the socket is currently connected and writable.
     * @private
     * @returns {void}
     */
    _assertConnected() {
        if (!this._connected || !this._socket || this._socket.destroyed) {
            throw new Error('Not connected to virtualpad daemon');
        }
    }

    /**
     * Serializes and writes a single JSON line to the daemon socket.
     * @private
     * @param {Record<string, any>} payload
     * @returns {Promise<void>}
     */
    _sendMessage(payload) {
        this._assertConnected();
        const socket = /** @type {net.Socket} */ (this._socket);
        const line = `${JSON.stringify(payload)}\n`;

        return new Promise((resolve, reject) => {
            socket.write(line, 'utf8', (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    /**
     * Rejects and clears all pending state query requests.
     * @private
     * @param {Error} error
     * @returns {void}
     */
    _rejectPendingRequests(error) {
        while (this._pendingStateRequests.length > 0) {
            const pending = /** @type {PendingStateRequest} */ (this._pendingStateRequests.shift());
            clearTimeout(pending.timer);
            pending.reject(error);
        }
    }

    /**
     * Resolves and clears all pending state query requests with the current state.
     * @private
     * @returns {void}
     */
    _resolvePendingRequests() {
        const snapshot = this.state;
        while (this._pendingStateRequests.length > 0) {
            const pending = /** @type {PendingStateRequest} */ (this._pendingStateRequests.shift());
            clearTimeout(pending.timer);
            pending.resolve(snapshot);
        }
    }

    /**
     * Buffers incoming TCP chunks and parses complete newline-delimited JSON lines.
     * @private
     * @param {string} chunk
     * @returns {void}
     */
    _handleIncomingChunk(chunk) {
        this._receiveBuffer += chunk;
        if (Buffer.byteLength(this._receiveBuffer, 'utf8') > MAX_RECEIVE_BUFFER_BYTES) {
            this._log('[VIRTUALPAD] Receive buffer exceeded limit, resetting buffer');
            this._receiveBuffer = '';
            return;
        }

        let newlineIndex = this._receiveBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const rawLine = this._receiveBuffer.slice(0, newlineIndex).trim();
            this._receiveBuffer = this._receiveBuffer.slice(newlineIndex + 1);
            if (rawLine.length > 0) {
                this._parseAndHandleLine(rawLine);
            }
            newlineIndex = this._receiveBuffer.indexOf('\n');
        }
    }

    /**
     * Parses a single JSON line and routes it to the appropriate handler.
     * @private
     * @param {string} rawLine
     * @returns {void}
     */
    _parseAndHandleLine(rawLine) {
        /** @type {unknown} */
        let parsed;
        try {
            parsed = JSON.parse(rawLine);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._log(`[VIRTUALPAD] Failed to parse daemon message: ${message}`);
            return;
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            this._log('[VIRTUALPAD] Ignoring non-object daemon message');
            return;
        }

        const daemonMessage = /** @type {IncomingDaemonMessage} */ (parsed);
        if (typeof daemonMessage.type !== 'string' || daemonMessage.type.length === 0) {
            this._log('[VIRTUALPAD] Ignoring daemon message missing type');
            return;
        }

        this._dispatchMessage(daemonMessage);
    }

    /**
     * Dispatches a validated daemon message and updates internal state / emits events.
     * @private
     * @param {IncomingDaemonMessage} daemonMessage
     * @returns {void}
     */
    _dispatchMessage(daemonMessage) {
        switch (daemonMessage.type) {
            case 'StateUpdate':
            case 'StateResponse':
            case 'State': {
                this._applyStateUpdate(daemonMessage);
                break;
            }
            case 'ControllerConnected': {
                this._handleControllerConnected(daemonMessage);
                break;
            }
            case 'ControllerDisconnected': {
                this._handleControllerDisconnected(daemonMessage);
                break;
            }
            case 'HomeButton':
            case 'HomeButtonPressed': {
                this._handleHomeButton(daemonMessage);
                break;
            }
            case 'Battery':
            case 'BatteryUpdate':
            case 'BatteryChanged': {
                this._handleBatteryUpdate(daemonMessage);
                break;
            }
            case 'Error': {
                const detail = typeof daemonMessage.message === 'string'
                    ? daemonMessage.message
                    : (typeof daemonMessage.error === 'string' ? daemonMessage.error : 'Daemon returned an error');
                this._log(`[VIRTUALPAD] Daemon error: ${detail}`);
                this._rejectPendingRequests(new Error(detail));
                break;
            }
            default: {
                this._log(`[VIRTUALPAD] Unhandled daemon message type: ${daemonMessage.type}`);
                break;
            }
        }
    }

    /**
     * Applies a full StateUpdate snapshot and emits state/diff events.
     * @private
     * @param {IncomingDaemonMessage} daemonMessage
     * @returns {void}
     */
    _applyStateUpdate(daemonMessage) {
        const previousById = new Map(this._physicalControllers.map((controller) => [controller.id, controller]));
        const nextSlots = createEmptySlots();

        if (Array.isArray(daemonMessage.slots)) {
            for (let index = 0; index < daemonMessage.slots.length; index += 1) {
                const normalized = normalizeSlot(daemonMessage.slots[index], index);
                if (normalized.index >= 0 && normalized.index < SLOT_COUNT) {
                    nextSlots[normalized.index] = normalized;
                }
            }
        }

        /** @type {PhysicalControllerInfo[]} */
        const nextControllers = [];
        if (Array.isArray(daemonMessage.physicalControllers)) {
            for (const rawController of daemonMessage.physicalControllers) {
                const normalized = normalizePhysicalController(rawController);
                if (normalized) {
                    nextControllers.push(normalized);
                }
            }
        }

        const wasInitialized = this._hasReceivedInitialState;
        this._hasReceivedInitialState = true;
        this._slots = nextSlots;
        this._physicalControllers = nextControllers;

        if (wasInitialized) {
            const nextById = new Map(nextControllers.map((controller) => [controller.id, controller]));

            for (const controller of nextControllers) {
                const previous = previousById.get(controller.id);
                if (!previous) {
                    this.emit('controller-connected', cloneController(controller));
                }
                else if (
                    controller.batteryLevel
                    && (!previous.batteryLevel || previous.batteryLevel.level !== controller.batteryLevel.level)
                ) {
                    /** @type {BatteryEvent} */
                    const batteryPayload = {
                        controllerId: controller.id,
                        level: controller.batteryLevel.level
                    };
                    this.emit('battery', batteryPayload);
                }
            }

            for (const previousId of previousById.keys()) {
                if (!nextById.has(previousId)) {
                    this.emit('controller-disconnected', previousId);
                }
            }
        }

        const snapshot = this.state;
        this._resolvePendingRequests();
        this.emit('state', snapshot);
    }

    /**
     * Handles an incremental controller-connected message.
     * @private
     * @param {IncomingDaemonMessage} daemonMessage
     * @returns {void}
     */
    _handleControllerConnected(daemonMessage) {
        const source = daemonMessage.controller !== undefined ? daemonMessage.controller : daemonMessage;
        const normalized = normalizePhysicalController(source);
        if (!normalized) {
            return;
        }

        const existingIndex = this._physicalControllers.findIndex((controller) => controller.id === normalized.id);
        if (existingIndex === -1) {
            this._physicalControllers.push(normalized);
        }
        else {
            this._physicalControllers[existingIndex] = normalized;
        }
        this.emit('controller-connected', cloneController(normalized));
    }

    /**
     * Handles an incremental controller-disconnected message.
     * @private
     * @param {IncomingDaemonMessage} daemonMessage
     * @returns {void}
     */
    _handleControllerDisconnected(daemonMessage) {
        const rawId = typeof daemonMessage.controllerId === 'string'
            ? daemonMessage.controllerId
            : daemonMessage.id;
        if (typeof rawId !== 'string' || rawId.trim().length === 0) {
            return;
        }

        const controllerId = rawId.trim();
        this._physicalControllers = this._physicalControllers.filter((controller) => controller.id !== controllerId);
        for (const slot of this._slots) {
            if (slot.assignedPhysical === controllerId) {
                slot.assignedPhysical = null;
                slot.active = false;
            }
        }
        this.emit('controller-disconnected', controllerId);
    }

    /**
     * Handles a Home/Guide button press notification from the daemon.
     * @private
     * @param {IncomingDaemonMessage} daemonMessage
     * @returns {void}
     */
    _handleHomeButton(daemonMessage) {
        if (typeof daemonMessage.controllerId !== 'string' || daemonMessage.controllerId.trim().length === 0) {
            return;
        }

        /** @type {number|null} */
        let slotIndex = null;
        if (
            typeof daemonMessage.slotIndex === 'number'
            && Number.isInteger(daemonMessage.slotIndex)
            && daemonMessage.slotIndex >= 0
            && daemonMessage.slotIndex < SLOT_COUNT
        ) {
            slotIndex = daemonMessage.slotIndex;
        }

        /** @type {HomeButtonEvent} */
        const payload = {
            controllerId: daemonMessage.controllerId.trim(),
            slotIndex
        };
        this.emit('home-button', payload);
    }

    /**
     * Handles a battery level change notification from the daemon.
     * @private
     * @param {IncomingDaemonMessage} daemonMessage
     * @returns {void}
     */
    _handleBatteryUpdate(daemonMessage) {
        if (typeof daemonMessage.controllerId !== 'string' || daemonMessage.controllerId.trim().length === 0) {
            return;
        }
        const normalizedBattery = normalizeBatteryLevel(daemonMessage.level);
        if (!normalizedBattery) {
            return;
        }

        const controllerId = daemonMessage.controllerId.trim();
        const existing = this._physicalControllers.find((controller) => controller.id === controllerId);
        if (existing) {
            existing.batteryLevel = { level: normalizedBattery.level };
        }

        /** @type {BatteryEvent} */
        const payload = {
            controllerId,
            level: normalizedBattery.level
        };
        this.emit('battery', payload);
    }
}

/**
 * Factory helper that creates a new VirtualPadClient instance.
 * @param {VirtualPadClientOptions} [options={}]
 * @returns {VirtualPadClient}
 */
function createClient(options = {}) {
    return new VirtualPadClient(options);
}

module.exports = { VirtualPadClient, createClient };
