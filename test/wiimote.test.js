const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wiimote = require('../ui/lib/wiimote');

// struct input_event: timeval (16 bytes), type, code, value
function ev(code, value, type = 1) {
    const b = Buffer.alloc(wiimote.EVENT_SIZE);
    b.writeUInt16LE(type, 16);
    b.writeUInt16LE(code, 18);
    b.writeInt32LE(value, 20);
    return b;
}

test('the D-pad (arrow keys) and the buttons of a Wii Remote are read from its event device', () => {
    const state = wiimote.createState();
    assert.ok(state.feed(Buffer.concat([ev(103, 1), ev(0x130, 1), ev(0, 0, 0)])));
    assert.deepStrictEqual([...state.down].sort(), ['a', 'up']);
    assert.ok(state.feed(ev(103, 0)));
    assert.ok(!state.feed(ev(0x130, 2)), 'a repeat is not a change');
    assert.ok(!state.feed(ev(0x110, 1)), 'a code that is not a remote button is ignored');
    assert.deepStrictEqual([...state.down], ['a']);
});

test('only the remote itself is read, not its sensors; remotes come and go', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiimote-'));
    fs.writeFileSync(path.join(dir, 'event7'), Buffer.concat([ev(108, 1), ev(0x197, 1)]));
    let devices = [
        { name: 'Nintendo Wii Remote', event: 7, js: 2 },
        { name: 'Nintendo Wii Remote Accelerometer', event: 8, js: 3 },
        { name: 'Microsoft X-Box 360 pad', event: 5, js: 0 }
    ];
    const reader = wiimote.createReader({ listDevices: () => devices, dir, open: f => fs.openSync(f, 'r'), log: () => {} });
    const seen = [];
    reader.scan();
    reader.poll();
    assert.deepStrictEqual(reader.snapshot().map(r => [r.id, r.buttons.sort()]), [['event7', ['down', 'plus']]]);
    const off = reader.subscribe(r => seen.push(r));
    devices = [];
    reader.scan();
    assert.deepStrictEqual(reader.snapshot(), []);
    assert.deepStrictEqual(seen[seen.length - 1], []);
    off();
});
