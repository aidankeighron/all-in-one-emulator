// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { VirtualPadClient, createClient } = require('../ui/lib/virtualpad');

/**
 * Finds an unused local TCP port by binding an ephemeral server briefly.
 * @returns {Promise<number>}
 */
function findUnusedPort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            if (!address || typeof address === 'string') {
                probe.close(() => reject(new Error('Failed to acquire numeric port')));
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
 * Starts a mock TCP ndjson server for testing VirtualPadClient.
 * @param {(socket: net.Socket, message: any) => void} [onMessage]
 * @returns {Promise<{ server: net.Server, port: number, sockets: Set<net.Socket>, send: (socket: net.Socket, payload: any) => void, close: () => Promise<void> }>}
 */
function createMockDaemon(onMessage) {
    /** @type {Set<net.Socket>} */
    const sockets = new Set();

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
                if (line.length > 0 && onMessage) {
                    onMessage(socket, JSON.parse(line));
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
                send(socket, payload) {
                    socket.write(`${JSON.stringify(payload)}\n`);
                },
                close() {
                    for (const activeSocket of sockets) {
                        activeSocket.destroy();
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
 * Waits for a specific event to fire on an EventEmitter.
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
         * Event listener wrapper.
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

test('createClient creates VirtualPadClient with empty fallback state', () => {
    const client = createClient({ log: () => {} });
    assert.ok(client instanceof VirtualPadClient);
    assert.strictEqual(client.connected, false);
    const state = client.state;
    assert.strictEqual(state.connected, false);
    assert.deepStrictEqual(state.physicalControllers, []);
    assert.strictEqual(state.slots.length, 4);
    assert.deepStrictEqual(
        state.slots.map((slot) => ({ index: slot.index, assignedPhysical: slot.assignedPhysical, active: slot.active })),
        [
            { index: 0, assignedPhysical: null, active: false },
            { index: 1, assignedPhysical: null, active: false },
            { index: 2, assignedPhysical: null, active: false },
            { index: 3, assignedPhysical: null, active: false }
        ]
    );
    assert.deepStrictEqual(client.listPhysical(), []);
    assert.deepStrictEqual(client.getSlot(2), { index: 2, assignedPhysical: null, active: false });
});

test('fallback mode emits disconnected, keeps empty state, and retries connection', async () => {
    const port = await findUnusedPort();
    const client = createClient({
        host: '127.0.0.1',
        port,
        reconnectMs: 40,
        log: () => {}
    });

    let disconnectedCount = 0;
    client.on('disconnected', () => {
        disconnectedCount += 1;
    });

    await client.connect();
    assert.strictEqual(client.connected, false);
    assert.ok(disconnectedCount >= 1);
    assert.strictEqual(client.state.connected, false);
    assert.strictEqual(client.state.slots.length, 4);

    // Start a daemon on the same port and confirm automatic reconnect succeeds.
    const daemon = await createMockDaemon();
    daemon.server.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const reconnectServer = net.createServer();
    try {
        await new Promise((resolve, reject) => {
            reconnectServer.once('error', reject);
            reconnectServer.listen(port, '127.0.0.1', () => resolve());
        });

        await waitForEvent(client, 'connected', 2000);
        assert.strictEqual(client.connected, true);
    }
    finally {
        client.disconnect();
        await new Promise((resolve) => reconnectServer.close(() => resolve()));
    }
});

test('sends ndjson commands and handles StateUpdate + queryState', async () => {
    /** @type {any[]} */
    const received = [];

    const daemon = await createMockDaemon((socket, message) => {
        received.push(message);
        if (message.type === 'QueryState') {
            daemon.send(socket, {
                type: 'StateUpdate',
                slots: [
                    { index: 0, assignedPhysical: 'pad-1', active: true },
                    { index: 1, assignedPhysical: null, active: false },
                    { index: 2, assignedPhysical: null, active: false },
                    { index: 3, assignedPhysical: null, active: false }
                ],
                physicalControllers: [
                    {
                        id: 'pad-1',
                        name: 'Nintendo Switch Pro Controller',
                        kind: 'switch',
                        vendorId: 1406,
                        productId: 8201,
                        hasGyro: true,
                        hasAccelerometer: true,
                        batteryLevel: { level: 'high' },
                        connectionType: 'bluetooth',
                        assignedSlot: 0,
                        joyconMode: null
                    }
                ]
            });
        }
    });

    const client = createClient({
        port: daemon.port,
        reconnectMs: 50,
        log: () => {}
    });

    try {
        await client.connect();
        assert.strictEqual(client.connected, true);

        await client.assign('pad-1', 0);
        await client.unassign('pad-1');
        await client.swapSlots(0, 1);
        await client.setJoyConMode('joycon-l', 'split_left');
        await client.autoAssign();

        const stateEventPromise = waitForEvent(client, 'state');
        const queriedState = await client.queryState();
        const emittedState = await stateEventPromise;

        assert.strictEqual(queriedState.connected, true);
        assert.strictEqual(queriedState.slots[0].assignedPhysical, 'pad-1');
        assert.strictEqual(queriedState.slots[0].active, true);
        assert.strictEqual(queriedState.physicalControllers.length, 1);
        assert.strictEqual(queriedState.physicalControllers[0].kind, 'switch');
        assert.deepStrictEqual(emittedState, queriedState);
        assert.strictEqual(client.listPhysical().length, 1);
        assert.strictEqual(client.getSlot(0).assignedPhysical, 'pad-1');

        assert.deepStrictEqual(received, [
            { type: 'AssignController', controllerId: 'pad-1', slotIndex: 0 },
            { type: 'UnassignController', controllerId: 'pad-1' },
            { type: 'SwapSlots', slotA: 0, slotB: 1 },
            { type: 'SetJoyConMode', controllerId: 'joycon-l', mode: 'split_left' },
            { type: 'AutoAssign' },
            { type: 'QueryState' }
        ]);
    }
    finally {
        client.disconnect();
        await daemon.close();
    }
});

test('handles chunked ndjson messages, malformed lines, and controller/home/battery events', async () => {
    const daemon = await createMockDaemon();
    const client = createClient({
        port: daemon.port,
        log: () => {}
    });

    try {
        await client.connect();
        const socket = Array.from(daemon.sockets)[0];
        assert.ok(socket);

        const controllerConnectedPromise = waitForEvent(client, 'controller-connected');
        const batteryPromise = waitForEvent(client, 'battery');
        const homeButtonPromise = waitForEvent(client, 'home-button');
        const controllerDisconnectedPromise = waitForEvent(client, 'controller-disconnected');

        const firstMessage = JSON.stringify({
            type: 'ControllerConnected',
            controller: {
                id: 'jc-1',
                name: 'Joy-Con (L)',
                kind: 'switch_joycon_left',
                vendorId: 1406,
                productId: 8198,
                hasGyro: true,
                hasAccelerometer: true,
                batteryLevel: { level: 'medium' },
                connectionType: 'bluetooth',
                assignedSlot: null,
                joyconMode: 'split_left'
            }
        });

        // Send partial TCP chunks and malformed JSON to verify ndjson framing resilience.
        socket.write(firstMessage.slice(0, 25));
        socket.write(`${firstMessage.slice(25)}\n{not valid json}\n`);

        const connectedController = await controllerConnectedPromise;
        assert.strictEqual(connectedController.id, 'jc-1');
        assert.strictEqual(connectedController.kind, 'switch_joycon_left');
        assert.strictEqual(client.listPhysical().length, 1);

        daemon.send(socket, { type: 'BatteryChanged', controllerId: 'jc-1', level: 'low' });
        const batteryEvent = await batteryPromise;
        assert.deepStrictEqual(batteryEvent, { controllerId: 'jc-1', level: 'low' });
        assert.deepStrictEqual(client.listPhysical()[0].batteryLevel, { level: 'low' });

        daemon.send(socket, { type: 'HomeButton', controllerId: 'jc-1', slotIndex: 1 });
        const homeEvent = await homeButtonPromise;
        assert.deepStrictEqual(homeEvent, { controllerId: 'jc-1', slotIndex: 1 });

        daemon.send(socket, { type: 'ControllerDisconnected', controllerId: 'jc-1' });
        const disconnectedId = await controllerDisconnectedPromise;
        assert.strictEqual(disconnectedId, 'jc-1');
        assert.strictEqual(client.listPhysical().length, 0);
    }
    finally {
        client.disconnect();
        await daemon.close();
    }
});

test('validates constructor options and method arguments', async () => {
    assert.throws(() => createClient({ port: 0 }), RangeError);
    assert.throws(() => createClient({ port: 70000 }), RangeError);
    assert.throws(() => createClient({ host: '' }), TypeError);
    assert.throws(() => createClient({ reconnectMs: -1 }), RangeError);
    // @ts-expect-error verifying runtime validation on invalid log option
    assert.throws(() => createClient({ log: 'not-a-function' }), TypeError);

    const client = createClient({ log: () => {} });
    assert.throws(() => client.getSlot(-1), RangeError);
    assert.throws(() => client.getSlot(4), RangeError);
    // @ts-expect-error verifying runtime validation on non-integer slot index
    assert.throws(() => client.getSlot(1.5), TypeError);

    await assert.rejects(() => client.assign('', 0), RangeError);
    await assert.rejects(() => client.assign('pad-1', 4), RangeError);
    await assert.rejects(() => client.unassign('   '), RangeError);
    await assert.rejects(() => client.swapSlots(0, 9), RangeError);
    await assert.rejects(() => client.setJoyConMode('pad-1', 'invalid_mode'), RangeError);
    await assert.rejects(() => client.autoAssign(), /Not connected/);
    await assert.rejects(() => client.queryState(), /Not connected/);
});
