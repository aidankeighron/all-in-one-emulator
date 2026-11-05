// When nobody uses the computer: the screen off or sleep, after a while in the menu, from controllers and the desktop's idle time
const test = require('node:test');
const assert = require('node:assert');
const { createIdle } = require('../ui/lib/idle');
const hotkey = require('../ui/lib/hotkey');

function setup({ action = 'screen', minutes = 10, desktopIdleMs = Infinity, game = false } = {}) {
    let t = 1_000_000;
    const calls = [];
    let slept = 0;
    const state = { action, minutes, desktopIdleMs, game };
    const execImpl = (cmd, args, opts, cb) => {
        calls.push(args.join(' '));
        if (args.includes('org.gnome.Mutter.IdleMonitor.GetIdletime')) return cb(null, Number.isFinite(state.desktopIdleMs) ? `(uint64 ${state.desktopIdleMs},)\n` : '', '');
        cb(null, '()', '');
    };
    const idle = createIdle({ getSettings: () => ({ action: state.action, minutes: state.minutes }), gameRunning: () => state.game, sleep: async () => { slept++; }, execImpl, now: () => t });
    return { idle, calls, state, advance: ms => { t += ms; }, slept: () => slept };
}
const MIN = 60 * 1000;

test('the screen goes off after the idle time with no controller, key or mouse, and a controller brings it back', async () => {
    const s = setup({ action: 'screen', minutes: 10, desktopIdleMs: 20 * MIN });
    for (let i = 0; i < 9; i++) { s.advance(MIN); assert.strictEqual(await s.idle.tick(), null); }
    s.advance(MIN);
    assert.strictEqual(await s.idle.tick(), 'screen');
    assert.ok(s.calls.some(c => c.includes('org.gnome.ScreenSaver.SetActive true')));
    s.advance(MIN);
    assert.strictEqual(await s.idle.tick(), null, 'once per idle spell');
    s.idle.controllerUsed();
    assert.ok(s.calls.some(c => c.includes('org.gnome.ScreenSaver.SetActive false')), 'a controller wakes the screen');
});

// time passes the way it does in the menu: a tick every 15 seconds; returns what the last tick did
async function pass(s, ms) {
    let r = null;
    for (let done = 0; done < ms; done += 15000) { s.advance(15000); const now = await s.idle.tick(); if (now) r = now; }
    return r;
}

test('the keyboard or mouse in use keeps it awake, and so does a game', async () => {
    const s = setup({ action: 'sleep', minutes: 10, desktopIdleMs: 30 * 1000 });
    assert.strictEqual(await pass(s, 30 * MIN), null, 'someone is typing on the desktop');
    s.state.desktopIdleMs = 40 * MIN;
    s.state.game = true;
    assert.strictEqual(await pass(s, MIN), null, 'never in a game');
    s.state.game = false;
    assert.strictEqual(await pass(s, 15 * 1000), 'sleep');
    assert.strictEqual(s.slept(), 1);
});

test('waking from sleep does not count as idle, and Off does nothing', async () => {
    const s = setup({ action: 'sleep', minutes: 10 });
    assert.strictEqual(await pass(s, 11 * MIN), 'sleep');
    s.advance(8 * 60 * MIN);                 // asleep all night: the clock jumped
    assert.strictEqual(await s.idle.tick(), null, 'just woke up');
    assert.strictEqual(await pass(s, 5 * MIN), null, 'and it counts from the wake');
    const off = setup({ action: 'off' });
    assert.strictEqual(await pass(off, 120 * MIN), null);
});

test('a button or a stick pushed far is activity; the state a device reports when opened, and a drifting stick, are not', () => {
    const ev = (value, type, number = 0) => { const b = Buffer.alloc(8); b.writeInt16LE(value, 4); b[6] = type; b[7] = number; return b; };
    assert.strictEqual(hotkey.activityIn(ev(1, 0x01)), true);
    assert.strictEqual(hotkey.activityIn(ev(0, 0x01)), false, 'a button let go');
    assert.strictEqual(hotkey.activityIn(ev(1, 0x81)), false, 'initial state');
    assert.strictEqual(hotkey.activityIn(ev(3000, 0x02)), false, 'drift');
    assert.strictEqual(hotkey.activityIn(ev(-30000, 0x02)), true);
});
