// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DaemonBridge, createDaemonBridge, convertToLegacyFormat } = require('../ui/lib/daemon-bridge');

/**
 * @typedef {Object} MockDaemonServer
 * @property {net.Server} server
 * @property {number} port
 * @property {Set<net.Socket>} sockets
 * @property {Array<any>} receivedMessages
 * @property {(payload: any) => void} broadcast
 * @property {() => Promise<void>} close
 */

/**
 * Finds an unused local TCP port for test servers.
 * @returns {Promise<number>}
 */
function findUnusedPort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            if (!address || typeof address === 'string') {
                probe.close(() => reject(new Error('Expected TCP address object')));
                return;
            }
            const port = address.port;
            probe.close((closeError) => {
                if (closeError) {
                    reject(closeError);
                    return;
                }
                resolve(port);
            });
        });
    });
}

/**
 * Starts a mock TCP newline-delimited JSON virtualpad daemon.
 * @param {(socket: net.Socket, message: any) => void} [onMessage]
 * @returns {Promise<MockDaemonServer>}
 */
function createMockDaemon(onMessage) {
    /** @type {Set<net.Socket>} */
    const sockets = new Set();
    /** @type {Array<any>} */
    const receivedMessages = [];

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        let buffer = '';

        socket.on('data', (chunk) => {
            buffer += String(chunk);
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (line.length > 0) {
                    const parsed = JSON.parse(line);
                    receivedMessages.push(parsed);
                    if (onMessage) {
                        onMessage(socket, parsed);
                    }
                }
                newlineIndex = buffer.indexOf('\n');
            }
        });

        socket.on('close', () => {
            sockets.delete(socket);
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Expected TCP address object'));
                return;
            }
            resolve({
                server,
                port: address.port,
                sockets,
                receivedMessages,
                broadcast(payload) {
                    const line = `${JSON.stringify(payload)}\n`;
                    for (const socket of sockets) {
                        socket.write(line);
                    }
                },
                close() {
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                    return new Promise((closeResolve) => {
                        server.close(() => closeResolve());
                    });
                }
            });
        });
    });
}

/**
 * Waits for a named event from an EventEmitter with a timeout.
 * @template T
 * @param {import('events').EventEmitter} emitter
 * @param {string} eventName
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<T>}
 */
function waitForEvent(emitter, eventName, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            emitter.removeListener(eventName, listener);
            reject(new Error(`Timed out waiting for event "${eventName}"`));
        }, timeoutMs);

        /**
         * Resolves the promise when the expected event arrives.
         * @param {T} payload
         * @returns {void}
         */
        const listener = (payload) => {
            clearTimeout(timer);
            resolve(payload);
        };
        emitter.once(eventName, listener);
    });
}

test('convertToLegacyFormat maps PhysicalControllerInfo to legacy controller format', () => {
    const xbox = convertToLegacyFormat({
        id: 'ctrl-1',
        name: 'Xbox Wireless Controller',
        kind: 'xbox',
        vendorId: 0x045e,
        productId: 0x0b13,
        hasGyro: false,
        hasAccelerometer: false,
        batteryLevel: { level: 'high' },
        connectionType: 'bluetooth',
        assignedSlot: 1,
        joyconMode: null
    }, 0, 0, 0);

    assert.strictEqual(xbox.id, 'ctrl-1');
    assert.strictEqual(xbox.name, 'Xbox Wireless Controller');
    assert.strictEqual(xbox.kind, 'xbox');
    assert.strictEqual(xbox.label, 'Xbox Controller');
    assert.strictEqual(xbox.vendor, '045e');
    assert.strictEqual(xbox.product, '0b13');
    assert.strictEqual(xbox.bus, '0005');
    assert.strictEqual(xbox.connection, 'Bluetooth');
    assert.strictEqual(xbox.pad, true);
    assert.strictEqual(xbox.player, 2);
    assert.strictEqual(xbox.sdlIndex, 1);
    assert.strictEqual(xbox.nameIndex, 0);
    assert.strictEqual(xbox.combined, false);
    assert.deepStrictEqual(xbox.memberKeys, []);
    assert.strictEqual(xbox.address, null);
    assert.strictEqual(xbox.daemonId, 'ctrl-1');
    assert.deepStrictEqual(xbox.batteryLevel, { level: 'high' });

    const combinedJoyCon = convertToLegacyFormat({
        id: 'ctrl-jc',
        name: 'Joy-Con Pair',
        kind: 'switch_joycon_left',
        vendorId: 0x057e,
        productId: 0x2006,
        hasGyro: true,
        hasAccelerometer: true,
        batteryLevel: null,
        connectionType: 'usb',
        assignedSlot: 0,
        joyconMode: 'combined'
    }, 1, 0, 1);

    assert.strictEqual(combinedJoyCon.kind, 'switch');
    assert.strictEqual(combinedJoyCon.label, 'Switch Controller (combined)');
    assert.strictEqual(combinedJoyCon.combined, true);
    assert.strictEqual(combinedJoyCon.sdlName, 'Nintendo Switch Joy-Con (L/R)');
    assert.strictEqual(combinedJoyCon.connection, 'USB');
    assert.strictEqual(combinedJoyCon.player, 1);

    const playstation = convertToLegacyFormat({
        id: 'ctrl-ps',
        name: 'DualSense Wireless Controller',
        kind: 'playstation',
        vendorId: 0x054c,
        productId: 0x0ce6,
        hasGyro: true,
        hasAccelerometer: true,
        batteryLevel: { level: 'normal' },
        connectionType: 'usb',
        assignedSlot: null,
        joyconMode: null
    }, 2, 0, 2);

    assert.strictEqual(playstation.kind, 'generic');
    assert.strictEqual(playstation.pad, true);
    assert.strictEqual(playstation.player, 3);
    assert.strictEqual(playstation.sdlIndex, 2);
});

test('createDaemonBridge falls back to controllers.detect when daemon is not running', async () => {
    const unusedPort = await findUnusedPort();
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-bridge-fallback-'));
    const procFile = path.join(temporaryDir, 'devices');
    fs.writeFileSync(
        procFile,
        'I: Bus=0003 Vendor=045e Product=028e Version=0110\nN: Name="Microsoft X-Box 360 pad"\nP: Phys=\nS: Sysfs=/devices/x\nU: Uniq=\nH: Handlers=event5 js0\nB: PROP=0\n'
    );

    const bridge = createDaemonBridge({
        port: unusedPort,
        reconnectMs: 5000,
        log: () => {}
    });

    try {
        assert.ok(bridge instanceof DaemonBridge);
        assert.strictEqual(bridge.daemonConnected, false);

        const detected = bridge.detectControllers({
            platform: 'linux',
            procFile,
            usbRoot: path.join(temporaryDir, 'nonexistent-usb')
        });
        assert.strictEqual(detected.length, 1);
        assert.strictEqual(detected[0].name, 'Microsoft X-Box 360 pad');
        assert.strictEqual(detected[0].kind, 'xbox');

        const slots = bridge.getSlots();
        assert.strictEqual(slots.length, 4);
        assert.deepStrictEqual(slots[0], { index: 0, assignedPhysical: null, active: false });

        await assert.rejects(() => bridge.assign('ctrl-1', 0), /not connected/i);
        await assert.rejects(() => bridge.swapSlots(0, 1), /not connected/i);
        await assert.rejects(() => bridge.setJoyConMode('ctrl-1', 'combined'), /not connected/i);
        await assert.rejects(() => bridge.autoAssign(), /not connected/i);
    }
    finally {
        bridge.disconnect();
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
});

test('createDaemonBridge uses daemon state and forwards commands when daemon is connected', async () => {
    const mockDaemon = await createMockDaemon((socket, message) => {
        if (message.type === 'QueryState') {
            socket.write(`${JSON.stringify({
                type: 'StateUpdate',
                slots: [
                    { index: 0, assignedPhysical: 'phys-1', active: true },
                    { index: 1, assignedPhysical: 'phys-2', active: true },
                    { index: 2, assignedPhysical: null, active: false },
                    { index: 3, assignedPhysical: null, active: false }
                ],
                physicalControllers: [
                    {
                        id: 'phys-1',
                        name: 'Pro Controller',
                        kind: 'switch',
                        vendorId: 0x057e,
                        productId: 0x2009,
                        hasGyro: true,
                        hasAccelerometer: true,
                        batteryLevel: { level: 'full' },
                        connectionType: 'bluetooth',
                        assignedSlot: 0,
                        joyconMode: null
                    },
                    {
                        id: 'phys-2',
                        name: 'Pro Controller',
                        kind: 'switch',
                        vendorId: 0x057e,
                        productId: 0x2009,
                        hasGyro: true,
                        hasAccelerometer: true,
                        batteryLevel: { level: 'normal' },
                        connectionType: 'usb',
                        assignedSlot: 1,
                        joyconMode: null
                    }
                ]
            })}\n`);
        }
    });

    const bridge = createDaemonBridge({
        port: mockDaemon.port,
        autoConnect: false,
        log: () => {}
    });

    try {
        const connectedPromise = waitForEvent(bridge.client, 'connected');
        await bridge.client.connect();
        await connectedPromise;

        assert.strictEqual(bridge.daemonConnected, true);

        const statePromise = waitForEvent(bridge.client, 'state');
        await bridge.client.queryState();
        await statePromise;

        const detected = bridge.detectControllers({ platform: 'linux' });
        assert.strictEqual(detected.length, 2);
        assert.strictEqual(detected[0].id, 'phys-1');
        assert.strictEqual(detected[0].nameIndex, 0);
        assert.strictEqual(detected[0].player, 1);
        assert.strictEqual(detected[1].id, 'phys-2');
        assert.strictEqual(detected[1].nameIndex, 1);
        assert.strictEqual(detected[1].player, 2);

        const inputconfig = require('../ui/lib/inputconfig');
        const playersLib = require('../ui/lib/players');
        const described = inputconfig.describe(detected, { players: playersLib.defaults(), wiiRemotes: 0 });
        assert.strictEqual(described.slots[0].mode, 'pad');
        assert.strictEqual(described.slots[0].controller.id, 'phys-1');
        assert.strictEqual(described.slots[1].mode, 'pad');
        assert.strictEqual(described.slots[1].controller.id, 'phys-2');
        assert.ok(playersLib.padKey(detected[0]).startsWith('pad:057e:2009:Pro Controller#0'));

        const status = bridge.getStatus();
        assert.strictEqual(status.connected, true);
        assert.strictEqual(status.slots[0].assignedPhysical, 'phys-1');
        assert.strictEqual(status.physicalControllers.length, 2);

        await bridge.assign('phys-1', 2);
        await bridge.swapSlots(0, 1);
        await bridge.setJoyConMode('phys-1', 'split_left');
        await bridge.autoAssign();
        await bridge.unassign('phys-1');

        await new Promise((resolve) => setTimeout(resolve, 30));

        const sentTypes = mockDaemon.receivedMessages.map((entry) => entry.type);
        assert.ok(sentTypes.includes('AssignController'));
        assert.ok(sentTypes.includes('SwapSlots'));
        assert.ok(sentTypes.includes('SetJoyConMode'));
        assert.ok(sentTypes.includes('AutoAssign'));
        assert.ok(sentTypes.includes('UnassignController'));
    }
    finally {
        bridge.disconnect();
        await mockDaemon.close();
    }
});

test('bridge methods validate input arguments strictly', async () => {
    const bridge = createDaemonBridge({
        autoConnect: false,
        log: () => {}
    });

    try {
        assert.throws(() => createDaemonBridge(/** @type {any} */ ('invalid')), TypeError);
        assert.throws(() => createDaemonBridge({ port: 99999 }), RangeError);
        assert.throws(() => bridge.detectControllers(/** @type {any} */ (42)), TypeError);
        assert.throws(() => convertToLegacyFormat(/** @type {any} */ (null)), TypeError);

        await assert.rejects(() => bridge.assign('', 0), RangeError);
        await assert.rejects(() => bridge.assign('ctrl-1', 4), RangeError);
        await assert.rejects(() => bridge.swapSlots(-1, 0), RangeError);
        await assert.rejects(() => bridge.setJoyConMode('ctrl-1', 'invalid_mode'), RangeError);
    }
    finally {
        bridge.disconnect();
    }
});
