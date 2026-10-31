// A real Wii Remote in the menu (Linux). The kernel's Wii Remote driver reports the D-pad as the arrow keys, and the joystick
// device that browsers read (/dev/input/js*) leaves those out, so the menu window sees A, B, 1, 2, +, − and Home but no way to
// move. This reads the remote's own event device instead (/dev/input/event*, which the person at the computer may read for a
// joystick, like the js devices) and tells the menu window which buttons are down.
//
// Remotes connected later are picked up (checked every two seconds); one that goes away is let go.
const fs = require('fs');
const path = require('path');

// struct input_event on 64-bit Linux: struct timeval (16 bytes), u16 type, u16 code, s32 value
const EVENT_SIZE = 24;
const EV_KEY = 1;

// The remote's buttons by the key code the kernel gives each (drivers/hid/hid-wiimote-modules.c), held upright
const BUTTONS = {
    103: 'up', 108: 'down', 105: 'left', 106: 'right',
    0x130: 'a', 0x131: 'b', 0x101: 'one', 0x102: 'two',
    0x197: 'plus', 0x19c: 'minus', 0x13c: 'home'
};

// Reads raw events into a set of pressed button names. feed(buf) returns true when something changed.
function createState() {
    const down = new Set();
    return {
        down,
        feed(buf) {
            let changed = false;
            for (let i = 0; i + EVENT_SIZE <= buf.length; i += EVENT_SIZE) {
                if (buf.readUInt16LE(i + 16) !== EV_KEY) continue;
                const name = BUTTONS[buf.readUInt16LE(i + 18)];
                if (!name) continue;
                const value = buf.readInt32LE(i + 20);
                const had = down.has(name);
                if (value && !had) { down.add(name); changed = true; } else if (!value && had) { down.delete(name); changed = true; }
            }
            return changed;
        }
    };
}

// The core device of each connected remote (its accelerometer, IR camera and extensions are devices of their own)
function remotesIn(devices) {
    return devices.filter(d => /^nintendo wii remote$/i.test(d.name) && d.event !== null && d.event !== undefined);
}

function defaultDevices() {
    const { parseProc } = require('./controllers');
    try { return parseProc(fs.readFileSync('/proc/bus/input/devices', 'utf8')); } catch { return []; }
}

// onChange(remotes) is called with [{id, buttons: [...]}] whenever a button goes down or up, or a remote comes or goes
function createReader({ listDevices = defaultDevices, open = file => fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK), dir = '/dev/input', pollMs = 16, rescanMs = 2000, log = console.warn } = {}) {
    const remotes = new Map();      // "event7" -> {fd, state}
    const listeners = new Set();
    const warned = new Set();
    let timers = null;

    const snapshot = () => [...remotes.entries()].map(([id, r]) => ({ id, buttons: [...r.state.down] }));
    const emit = () => { const now = snapshot(); for (const fn of listeners) { try { fn(now); } catch { /* a closed connection */ } } };

    function drop(id) {
        const r = remotes.get(id);
        if (!r) return;
        try { fs.closeSync(r.fd); } catch { /* already closed */ }
        remotes.delete(id);
    }

    function scan() {
        let devices;
        try { devices = remotesIn(listDevices()); } catch { devices = []; }
        const ids = new Set(devices.map(d => `event${d.event}`));
        let changed = false;
        for (const id of [...remotes.keys()]) if (!ids.has(id)) { drop(id); changed = true; }
        for (const id of ids) {
            if (remotes.has(id)) continue;
            try {
                remotes.set(id, { fd: open(path.join(dir, id)), state: createState() });
                warned.delete(id);
                changed = true;
            } catch (err) {
                if (!warned.has(id)) { warned.add(id); log(`[WIIMOTE] cannot read ${id}: ${err.code || err.message}`); }
            }
        }
        if (changed) emit();
    }

    function poll() {
        const buf = Buffer.alloc(EVENT_SIZE * 64);
        let changed = false;
        for (const [id, r] of remotes) {
            for (;;) {
                let n;
                try { n = fs.readSync(r.fd, buf, 0, buf.length, null); } catch (err) {
                    if (err.code !== 'EAGAIN') { drop(id); changed = true; }
                    break;
                }
                if (n <= 0) break;
                if (r.state.feed(buf.subarray(0, n))) changed = true;
            }
        }
        if (changed) emit();
    }

    function startTimers() {
        if (timers) return;
        scan();
        timers = [setInterval(poll, pollMs), setInterval(scan, rescanMs)];
    }

    function stopTimers() {
        if (!timers) return;
        timers.forEach(clearInterval);
        timers = null;
        for (const id of [...remotes.keys()]) drop(id);
    }

    return {
        // Starts reading while someone listens; returns a function that stops listening
        subscribe(fn) {
            listeners.add(fn);
            startTimers();
            fn(snapshot());
            return () => { listeners.delete(fn); if (!listeners.size) stopTimers(); };
        },
        snapshot,
        scan,
        poll,
        stop: stopTimers
    };
}

module.exports = { createReader, createState, remotesIn, BUTTONS, EVENT_SIZE };
