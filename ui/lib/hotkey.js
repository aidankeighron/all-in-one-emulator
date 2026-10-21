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

// Starts watching every joystick device. Returns a function that stops watching.
function start(onCombo, { holdMs = HOLD_MS } = {}) {
    let names;
    try {
        names = fs.readdirSync('/dev/input').filter(n => /^js\d+$/.test(n));
    } catch {
        return () => {};
    }

    const watchers = [];
    for (const js of names) {
        let fd;
        try {
            fd = fs.openSync(path.join('/dev/input', js), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        } catch (err) {
            console.warn(`[HOTKEY] cannot read ${js}: ${err.code}`);
            continue;
        }
        const detector = createDetector({ buttons: COMBO, holdMs, onTrigger: onCombo });
        const buf = Buffer.alloc(EVENT_SIZE * 64);
        const timer = setInterval(() => {
            for (;;) {
                let n;
                try {
                    n = fs.readSync(fd, buf, 0, buf.length, null);
                } catch {
                    return; // EAGAIN: nothing new (or the device went away)
                }
                if (n <= 0) return;
                detector.feed(buf.subarray(0, n));
            }
        }, 25);
        watchers.push(() => { clearInterval(timer); detector.stop(); try { fs.closeSync(fd); } catch { /* already closed */ } });
    }
    return () => watchers.forEach(stop => stop());
}

module.exports = { start, createDetector };
