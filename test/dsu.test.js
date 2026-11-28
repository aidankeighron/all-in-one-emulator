// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const SERVER_MAGIC = Buffer.from('DSUS', 'ascii');
const CLIENT_MAGIC = Buffer.from('DSUC', 'ascii');
const DSU_VERSION = 1001;
const MESSAGE_TYPE_VERSION = 0x00100000;
const MESSAGE_TYPE_CONTROLLER_INFO = 0x00100001;
const MESSAGE_TYPE_CONTROLLER_DATA = 0x00100002;

/**
 * Computes IEEE 802.3 CRC-32 for a Cemuhook/DSU packet buffer.
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
    let crc = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        crc ^= buffer[index];
        for (let bit = 0; bit < 8; bit += 1) {
            if ((crc & 1) !== 0) {
                crc = (crc >>> 1) ^ 0xedb88320;
            }
            else {
                crc >>>= 1;
            }
        }
    }
    return (~crc) >>> 0;
}

/**
 * Builds a signed Cemuhook/DSU client or server packet.
 * @param {Buffer} magic
 * @param {number} senderId
 * @param {number} messageType
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function buildDsuPacket(magic, senderId, messageType, payload) {
    const packet = Buffer.alloc(20 + payload.length);
    magic.copy(packet, 0);
    packet.writeUInt16LE(DSU_VERSION, 4);
    packet.writeUInt16LE(4 + payload.length, 6);
    packet.writeUInt32LE(0, 8);
    packet.writeUInt32LE(senderId >>> 0, 12);
    packet.writeUInt32LE(messageType >>> 0, 16);
    payload.copy(packet, 20);
    packet.writeUInt32LE(crc32(packet), 8);
    return packet;
}

/**
 * Verifies a Cemuhook/DSU packet header and CRC-32 checksum.
 * @param {Buffer} packet
 * @returns {{ magic: string, version: number, messageType: number, payload: Buffer }}
 */
function parseDsuPacket(packet) {
    assert.ok(packet.length >= 20, 'DSU packet must be at least 20 bytes');
    const actualCrc = packet.readUInt32LE(8);
    const scratch = Buffer.from(packet);
    scratch.writeUInt32LE(0, 8);
    assert.strictEqual(crc32(scratch), actualCrc, 'DSU packet CRC-32 must match');
    return {
        magic: packet.subarray(0, 4).toString('ascii'),
        version: packet.readUInt16LE(4),
        messageType: packet.readUInt32LE(16),
        payload: packet.subarray(20)
    };
}

test('DSU CRC-32 matches standard IEEE 802.3 vector', () => {
    assert.strictEqual(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
    assert.strictEqual(crc32(Buffer.alloc(0)), 0x00000000);
});

test('DSU UDP server mock handles VersionRequest, ControllerInfoRequest, and slot 0-3 motion streaming', async () => {
    const serverSocket = dgram.createSocket('udp4');
    const clientSocket = dgram.createSocket('udp4');
    const serverId = 0x44535553;
    const registeredClients = new Map();

    serverSocket.on('message', (datagram, rinfo) => {
        const parsed = parseDsuPacket(datagram);
        if (parsed.magic !== 'DSUC') {
            return;
        }
        if (parsed.messageType === MESSAGE_TYPE_VERSION) {
            const payload = Buffer.alloc(2);
            payload.writeUInt16LE(DSU_VERSION, 0);
            serverSocket.send(buildDsuPacket(SERVER_MAGIC, serverId, MESSAGE_TYPE_VERSION, payload), rinfo.port, rinfo.address);
        }
        else if (parsed.messageType === MESSAGE_TYPE_CONTROLLER_INFO) {
            const portCount = parsed.payload.readUInt32LE(0);
            for (let index = 0; index < portCount; index += 1) {
                const slot = parsed.payload[4 + index];
                const payload = Buffer.alloc(12);
                payload[0] = slot;
                payload[1] = slot < 2 ? 2 : 0; // Slots 0-1 connected
                payload[2] = slot < 2 ? 2 : 0; // Full gyro
                payload[3] = slot < 2 ? 2 : 0; // Bluetooth
                payload[9] = slot + 1;         // Fake MAC 00:00:00:00:00:0N
                payload[10] = slot < 2 ? 0x04 : 0x00;
                serverSocket.send(buildDsuPacket(SERVER_MAGIC, serverId, MESSAGE_TYPE_CONTROLLER_INFO, payload), rinfo.port, rinfo.address);
            }
        }
        else if (parsed.messageType === MESSAGE_TYPE_CONTROLLER_DATA) {
            const slot = parsed.payload[1];
            registeredClients.set(`${rinfo.address}:${rinfo.port}`, { address: rinfo.address, port: rinfo.port, slot });
        }
    });

    await new Promise((resolve) => serverSocket.bind(0, '127.0.0.1', resolve));
    await new Promise((resolve) => clientSocket.bind(0, '127.0.0.1', resolve));

    const serverAddr = serverSocket.address();
    /** @type {Array<{ magic: string, version: number, messageType: number, payload: Buffer }>} */
    const received = [];
    clientSocket.on('message', (msg) => {
        received.push(parseDsuPacket(msg));
    });

    try {
        // 1. Version request
        clientSocket.send(buildDsuPacket(CLIENT_MAGIC, 42, MESSAGE_TYPE_VERSION, Buffer.alloc(0)), serverAddr.port, '127.0.0.1');
        // 2. Controller info for slots 0 and 2
        const infoReq = Buffer.from([2, 0, 0, 0, 0, 2]);
        clientSocket.send(buildDsuPacket(CLIENT_MAGIC, 42, MESSAGE_TYPE_CONTROLLER_INFO, infoReq), serverAddr.port, '127.0.0.1');
        // 3. Subscribe to slot 1 motion data
        const dataReq = Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]);
        clientSocket.send(buildDsuPacket(CLIENT_MAGIC, 42, MESSAGE_TYPE_CONTROLLER_DATA, dataReq), serverAddr.port, '127.0.0.1');

        await new Promise((resolve) => setTimeout(resolve, 60));

        // Broadcast one motion sample for slot 1
        const motionPayload = Buffer.alloc(80);
        motionPayload[0] = 1; // slot 1
        motionPayload[1] = 2; // connected
        motionPayload[2] = 2; // full gyro
        motionPayload[3] = 2; // bluetooth
        motionPayload[9] = 2; // MAC ...:02
        motionPayload[10] = 0x04;
        motionPayload[11] = 1; // connected byte
        motionPayload.writeBigUInt64LE(123456n, 48);
        motionPayload.writeFloatLE(0.5, 56);  // accel_x
        motionPayload.writeFloatLE(15.25, 68); // gyro_pitch
        for (const sub of registeredClients.values()) {
            if (sub.slot === 1) {
                serverSocket.send(buildDsuPacket(SERVER_MAGIC, serverId, MESSAGE_TYPE_CONTROLLER_DATA, motionPayload), sub.port, sub.address);
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 40));

        const versionMsg = received.find((m) => m.messageType === MESSAGE_TYPE_VERSION);
        assert.ok(versionMsg);
        assert.strictEqual(versionMsg.payload.readUInt16LE(0), DSU_VERSION);

        const infos = received.filter((m) => m.messageType === MESSAGE_TYPE_CONTROLLER_INFO);
        assert.strictEqual(infos.length, 2);
        assert.strictEqual(infos[0].payload[0], 0);
        assert.strictEqual(infos[0].payload[1], 2);
        assert.strictEqual(infos[1].payload[0], 2);
        assert.strictEqual(infos[1].payload[1], 0);

        const motionMsg = received.find((m) => m.messageType === MESSAGE_TYPE_CONTROLLER_DATA);
        assert.ok(motionMsg);
        assert.strictEqual(motionMsg.payload[0], 1);
        assert.strictEqual(motionMsg.payload.readFloatLE(56), 0.5);
        assert.strictEqual(motionMsg.payload.readFloatLE(68), 15.25);
    }
    finally {
        serverSocket.close();
        clientSocket.close();
    }
});
