const test = require('node:test');
const assert = require('node:assert');
const { createDetector } = require('../ui/lib/hotkey');

function ev(number, value, init = false) {
    const b = Buffer.alloc(8);
    b.writeInt16LE(value, 4);
    b[6] = init ? 0x81 : 0x01;
    b[7] = number;
    return b;
}

function fakeTimers() {
    let pending = null;
    return {
        setTimer: fn => (pending = fn),
        clearTimer: () => { pending = null; },
        fire: () => { const fn = pending; pending = null; if (fn) fn(); },
        get armed() { return pending !== null; }
    };
}

test('fires only after the whole combo is held', () => {
    const t = fakeTimers();
    let fired = 0;
    const d = createDetector({ buttons: [6, 7], onTrigger: () => fired++, setTimer: t.setTimer, clearTimer: t.clearTimer });

    d.feed(ev(6, 1));
    assert.ok(!t.armed, 'one button is not enough');
    d.feed(ev(7, 1));
    assert.ok(t.armed);
    t.fire();
    assert.strictEqual(fired, 1);
});

test('releasing a button before the hold time cancels it', () => {
    const t = fakeTimers();
    let fired = 0;
    const d = createDetector({ buttons: [6, 7], onTrigger: () => fired++, setTimer: t.setTimer, clearTimer: t.clearTimer });

    d.feed(Buffer.concat([ev(6, 1), ev(7, 1)]));
    d.feed(ev(7, 0));
    assert.ok(!t.armed);
    t.fire();
    assert.strictEqual(fired, 0);
});

test('ignores axis events and counts initial button state', () => {
    const t = fakeTimers();
    const d = createDetector({ buttons: [6, 7], onTrigger: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const axis = Buffer.alloc(8); axis.writeInt16LE(32767, 4); axis[6] = 0x02; axis[7] = 6;
    d.feed(axis);
    assert.ok(!t.armed);
    d.feed(Buffer.concat([ev(6, 1, true), ev(7, 1, true)]));
    assert.ok(t.armed);
});

test('holding on after it went off does not set it off again until the buttons are let go', () => {
    const t = fakeTimers();
    let fired = 0;
    const d = createDetector({ buttons: [6, 7], onTrigger: () => fired++, setTimer: t.setTimer, clearTimer: t.clearTimer });
    d.feed(Buffer.concat([ev(6, 1), ev(7, 1)]));
    t.fire();
    assert.strictEqual(fired, 1);
    d.feed(ev(0, 1));                       // another event while both are still down
    assert.ok(!t.armed, 'not armed again while still held');
    d.feed(Buffer.concat([ev(6, 0), ev(7, 0)]));
    d.feed(Buffer.concat([ev(6, 1), ev(7, 1)]));
    assert.ok(t.armed, 'armed again after a release');
});

test('a hold time of zero goes off as soon as both buttons are down', () => {
    let fired = 0;
    let delay = null;
    const d = createDetector({ buttons: [6, 7], holdMs: 0, onTrigger: () => fired++, setTimer: (fn, ms) => { delay = ms; fn(); return 1; }, clearTimer: () => {} });
    d.feed(Buffer.concat([ev(6, 1), ev(7, 1)]));
    assert.strictEqual(delay, 0);
    assert.strictEqual(fired, 1);
});

test('the pause combo is Back + Start on each controller, wherever they are numbered; − and + on a Wii Remote', () => {
    const { comboFor } = require('../ui/lib/hotkey');
    // Xbox 360 (xpad): A B X Y LB RB Back Start Guide L3 R3
    assert.deepStrictEqual(comboFor({ name: 'Microsoft X-Box 360 pad', keys: [0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e] }), [6, 7]);
    // Switch Pro Controller (hid-nintendo): Capture (BTN_Z) and ZL/ZR come before − and +
    assert.deepStrictEqual(comboFor({ name: 'Nintendo Switch Pro Controller', keys: [0x130, 0x131, 0x133, 0x134, 0x135, 0x136, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e] }), [9, 10]);
    // Wii Remote, in the joystick device's order: A B Home + − 1 2
    assert.deepStrictEqual(comboFor({ name: 'Nintendo Wii Remote', keys: [0x130, 0x131, 0x13c, 0x197, 0x19c, 0x101, 0x102] }), [4, 3]);
    // a pad with no Back or Start is not watched; one whose buttons are unknown gets the usual numbers
    assert.strictEqual(comboFor({ name: 'Nintendo Wii Remote Accelerometer', keys: [0x130] }), null);
    assert.deepStrictEqual(comboFor({ name: 'x', keys: [] }), [6, 7]);
});
