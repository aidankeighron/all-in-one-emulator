// "Home button" for any emulator: while a game runs, watch the controller through the Linux
// joystick devices (/dev/input/js*) and fire a callback when a combo is held. This works even
// though the menu window isn't focused, and needs no per-emulator setup.
const fs = require('fs');
const path = require('path');

const HOLD_MS = 1500;
const EVENT_SIZE = 8;               // struct js_event { u32 time; s16 value; u8 type; u8 number; }
const JS_EVENT_BUTTON = 0x01;
const JS_EVENT_INIT = 0x80;

// Button numbers of the Back+Start pair
const COMBO = [6, 7];

// Tracks which buttons are down and calls onTrigger once the combo has been held for holdMs
function createDetector({ buttons, holdMs = HOLD_MS, onTrigger, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const down = new Set();
    let timer = null;
    let fired = false;   // once it has gone off, the buttons must be let go before it can go off again

    function update() {
        const all = buttons.every(b => down.has(b));
        if (!all) fired = false;
        if (all && !timer && !fired) {
            timer = setTimer(() => { timer = null; fired = true; onTrigger(); }, holdMs);
        } else if (!all && timer) {
            clearTimer(timer);
            timer = null;
        }
    }

    return {
        // buf: raw bytes read from a js device (a whole number of 8-byte events)
        feed(buf) {
            for (let i = 0; i + EVENT_SIZE <= buf.length; i += EVENT_SIZE) {
                const value = buf.readInt16LE(i + 4);
                const type = buf[i + 6] & ~JS_EVENT_INIT;
                const number = buf[i + 7];
                if (type !== JS_EVENT_BUTTON) continue;
                if (value) down.add(number); else down.delete(number);
            }
            update();
        },
        stop() {
            if (timer) clearTimer(timer);
            timer = null;
        }
    };
}

// Which button numbers make the pause combo on one joystick device. A device's buttons are numbered in the order of its
// button codes (see keyCodes in lib/controllers.js), so Back + Start is not 6 + 7 on every controller: on a Switch Pro
// Controller or a Joy-Con pair those numbers are other buttons. A Wii Remote has no Back or Start: − and + are its combo.
const BTN_SELECT = 0x13a, BTN_START = 0x13b, KEY_PREVIOUS = 0x19c, KEY_NEXT = 0x197;
function comboFor(dev) {
    const keys = dev && Array.isArray(dev.keys) ? dev.keys : [];
    const pick = (a, b) => (keys.includes(a) && keys.includes(b) ? [keys.indexOf(a), keys.indexOf(b)] : null);
    if (/^nintendo wii remote$/i.test((dev && dev.name) || '')) return pick(KEY_PREVIOUS, KEY_NEXT);
    return pick(BTN_SELECT, BTN_START) || (keys.length ? null : COMBO);
}

// Starts watching every joystick device, and the ones connected later (checked every two seconds). Returns a function
// that stops watching. listDevices() -> [{name, js, keys}] (from /proc/bus/input/devices)
function start(onCombo, { holdMs = HOLD_MS, listDevices = defaultDevices, rescanMs = 2000 } = {}) {
    const watchers = new Map();     // "js3" -> stop function

    function watch(js, buttons) {
        let fd;
        try {
            fd = fs.openSync(path.join('/dev/input', js), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        } catch (err) {
            console.warn(`[HOTKEY] cannot read ${js}: ${err.code}`);
            return () => {};
        }
        const detector = createDetector({ buttons, holdMs, onTrigger: onCombo });
        const buf = Buffer.alloc(EVENT_SIZE * 64);
        let gone = false;
        const timer = setInterval(() => {
            for (;;) {
                let n;
                try {
                    n = fs.readSync(fd, buf, 0, buf.length, null);
                } catch (err) {
                    if (err.code !== 'EAGAIN') gone = true;     // unplugged: the next scan lets it go
                    return;
                }
                if (n <= 0) return;
                detector.feed(buf.subarray(0, n));
            }
        }, 25);
        const stop = () => { clearInterval(timer); detector.stop(); try { fs.closeSync(fd); } catch { /* already closed */ } };
        stop.gone = () => gone;
        return stop;
    }

    function scan() {
        let devices;
        try { devices = listDevices(); } catch { devices = []; }
        const now = new Map();
        for (const d of devices) {
            if (d.js === null || d.js === undefined) continue;
            const combo = comboFor(d);
            if (combo) now.set(`js${d.js}`, combo);
        }
        for (const [js, stop] of watchers) {
            if (!now.has(js) || (stop.gone && stop.gone())) { stop(); watchers.delete(js); }
        }
        for (const [js, combo] of now) if (!watchers.has(js)) watchers.set(js, watch(js, combo));
    }

    scan();
    const rescan = setInterval(scan, rescanMs);
    return () => { clearInterval(rescan); for (const stop of watchers.values()) stop(); watchers.clear(); };
}

// Calls onActivity whenever any controller is used: a button pressed, or a stick pushed well past its middle (a drifting
// stick does not count), at most every throttleMs. Like start(), it works whatever window has the focus, so the menu can come
// to the front when a controller is picked up, and knows the controllers are not idle. Returns a function that stops it.
const JS_EVENT_AXIS = 0x02;
const AXIS_PUSH = 16000;
function activityIn(buf) {
    for (let i = 0; i + EVENT_SIZE <= buf.length; i += EVENT_SIZE) {
        const raw = buf[i + 6];
        if (raw & JS_EVENT_INIT) continue;                 // the state the device reports when it is opened
        const value = buf.readInt16LE(i + 4);
        if ((raw === JS_EVENT_BUTTON && value) || (raw === JS_EVENT_AXIS && Math.abs(value) > AXIS_PUSH)) return true;
    }
    return false;
}

function watchActivity(onActivity, { listDevices = defaultDevices, rescanMs = 2000, pollMs = 50, throttleMs = 250, open = f => fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) } = {}) {
    const fds = new Map();          // "js3" -> fd
    const buf = Buffer.alloc(EVENT_SIZE * 64);
    let last = 0;
    function scan() {
        let devices;
        try { devices = listDevices(); } catch { devices = []; }
        const now = new Set(devices.filter(d => d.js !== null && d.js !== undefined).map(d => `js${d.js}`));
        for (const [js, fd] of fds) if (!now.has(js)) { try { fs.closeSync(fd); } catch { /* gone */ } fds.delete(js); }
        for (const js of now) {
            if (fds.has(js)) continue;
            try { fds.set(js, open(path.join('/dev/input', js))); } catch { /* not readable: skipped */ }
        }
    }
    function poll() {
        let used = false;
        for (const [js, fd] of fds) {
            for (;;) {
                let n;
                try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (err) {
                    if (err.code !== 'EAGAIN') { try { fs.closeSync(fd); } catch { /* gone */ } fds.delete(js); }
                    break;
                }
                if (n <= 0) break;
                if (activityIn(buf.subarray(0, n))) used = true;
            }
        }
        const t = Date.now();
        if (used && t - last >= throttleMs) { last = t; onActivity(); }
    }
    scan();
    const timers = [setInterval(poll, pollMs), setInterval(scan, rescanMs)];
    timers.forEach(t => t.unref && t.unref());
    return () => { timers.forEach(clearInterval); for (const fd of fds.values()) { try { fs.closeSync(fd); } catch { /* gone */ } } fds.clear(); };
}

function defaultDevices() {
    const { parseProc } = require('./controllers');
    let text = '';
    try { text = fs.readFileSync('/proc/bus/input/devices', 'utf8'); } catch { /* no input subsystem */ }
    const devices = parseProc(text);
    if (devices.length) return devices;
    // No /proc to read: every joystick device with the usual numbering
    try { return fs.readdirSync('/dev/input').filter(n => /^js\d+$/.test(n)).map(n => ({ name: '', js: Number(n.slice(2)), keys: [] })); } catch { return []; }
}

module.exports = { start, createDetector, comboFor, watchActivity, activityIn };
