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
