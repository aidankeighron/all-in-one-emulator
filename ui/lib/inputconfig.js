// Writes each emulator's controller settings from the controllers the menu detected, right before a
// game starts. Existing config files are edited in place (other settings are kept) and the original
// is copied to <file>.emulator-menu.bak the first time we change it.
//
//   Dolphin   GameCube ports, Wii Remotes (emulated or real), official GameCube adapter
//   Ryujinx   not written (see README): its format depends on per-device IDs
const os = require('os');
const path = require('path');
const { Ini, save } = require('./ini');

const GC_PORTS = 4;
const WII_SLOTS = 4;

// Dolphin SIDevice values
const SI_NONE = 0;
const SI_GC_CONTROLLER = 6;
const SI_GC_ADAPTER = 12;

// Dolphin source for a Wii Remote slot
const WIIMOTE_NONE = 0;
const WIIMOTE_EMULATED = 1;
const WIIMOTE_REAL = 2;

function flatpakDirs(home, id) {
    const base = path.join(home, '.var', 'app', id);
    return { config: path.join(base, 'config'), data: path.join(base, 'data') };
}

// Dolphin writes names that contain spaces or symbols between backticks
const q = name => /^\w+$/.test(name) ? name : `\`${name}\``;

// ---------- Who plays what ----------

function players(controllers) {
    const pads = controllers.filter(c => c.pad);
    return {
        pads,
        adapter: controllers.some(c => c.adapter),
        wii: controllers.filter(c => c.pad || c.kind === 'wiimote')
    };
}

// For the controllers page: where each controller will play, as short phrases
function assignments(controllers) {
    const { pads, wii } = players(controllers);
    const out = {};
    for (const c of controllers) {
        const roles = [];
        if (c.adapter) {
            roles.push('GameCube: the port each controller is plugged into');
        } else {
            const p = pads.indexOf(c), w = wii.indexOf(c);
            if (c.pad && p >= 0 && p < GC_PORTS) roles.push(`GameCube port ${p + 1}`);
            if (w >= 0 && w < WII_SLOTS) roles.push(`Wii Remote ${w + 1}`);
        }
        out[c.id] = roles;
    }
    return out;
}

// ---------- Dolphin ----------
// Control names are Dolphin's SDL gamepad names ("Button A", "Left X+", "Pad N", ...).

function dolphinDevice(c) {
    return `SDL/${c.nameIndex}/${c.name}`;
}

const dpad = [['D-Pad/Up', 'Pad N'], ['D-Pad/Down', 'Pad S'], ['D-Pad/Left', 'Pad W'], ['D-Pad/Right', 'Pad E']];
const stick = (prefix, side) => [
    [`${prefix}/Up`, `${side} Y-`], [`${prefix}/Down`, `${side} Y+`],
    [`${prefix}/Left`, `${side} X-`], [`${prefix}/Right`, `${side} X+`]
];

function gcPadEntries(c) {
    return [
        ['Device', dolphinDevice(c)],
        ['Buttons/A', 'Button A'], ['Buttons/B', 'Button X'], ['Buttons/X', 'Button B'], ['Buttons/Y', 'Button Y'],
        ['Buttons/Z', 'Shoulder R'], ['Buttons/Start', 'Start'],
        ...stick('Main Stick', 'Left'), ...stick('C-Stick', 'Right'),
        ['Triggers/L', 'Trigger L'], ['Triggers/R', 'Trigger R'],
        ['Triggers/L-Analog', 'Trigger L'], ['Triggers/R-Analog', 'Trigger R'],
        ...dpad
    ].map(([k, v]) => [k, k === 'Device' ? v : q(v)]);
}

// Wii Remote + Nunchuk on a gamepad: right stick points, left stick is the Nunchuk stick
function wiimotePadEntries(c) {
    return [
        ['Source', String(WIIMOTE_EMULATED)],
        ['Device', dolphinDevice(c)],
        ['Buttons/A', 'Button A'], ['Buttons/B', 'Trigger R'], ['Buttons/1', 'Button X'], ['Buttons/2', 'Button Y'],
        ['Buttons/-', 'Back'], ['Buttons/+', 'Start'], ['Buttons/Home', 'Guide'],
        ...stick('IR', 'Right'),
        ['Shake/X', 'Thumb R'], ['Shake/Y', 'Thumb R'], ['Shake/Z', 'Thumb R'],
        ...dpad,
        ['Extension', 'Nunchuk'],
        ['Nunchuk/Buttons/C', 'Shoulder L'], ['Nunchuk/Buttons/Z', 'Trigger L'],
        ...stick('Nunchuk/Stick', 'Left'),
        ['Nunchuk/Shake/X', 'Thumb L'], ['Nunchuk/Shake/Y', 'Thumb L'], ['Nunchuk/Shake/Z', 'Thumb L']
    ].map(([k, v]) => [k, k === 'Source' || k === 'Device' || k === 'Extension' ? v : q(v)]);
}

function writeDolphin(controllers, { home }) {
    const { pads, adapter, wii } = players(controllers);
    const realWiimotes = wii.filter(c => c.kind === 'wiimote');
    if (!pads.length && !adapter && !realWiimotes.length) return { status: 'skipped', message: 'No supported controller connected' };

    const dir = path.join(flatpakDirs(home, 'org.DolphinEmu.dolphin-emu').config, 'dolphin-emu');
    const main = Ini.read(path.join(dir, 'Dolphin.ini'));
    const gc = Ini.read(path.join(dir, 'GCPadNew.ini'));
    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    const done = [];

    if (pads.length || adapter) {
        for (let i = 0; i < GC_PORTS; i++) {
            const pad = pads[i];
            if (pad) {
                main.set('Core', `SIDevice${i}`, String(SI_GC_CONTROLLER));
                gc.replaceSection(`GCPad${i + 1}`, gcPadEntries(pad));
                done.push(`GameCube port ${i + 1}`);
            } else {
                main.set('Core', `SIDevice${i}`, String(adapter ? SI_GC_ADAPTER : SI_NONE));
            }
        }
    }

    for (let i = 0; i < WII_SLOTS; i++) {
        const c = wii[i];
        if (!c) {
            wm.replaceSection(`Wiimote${i + 1}`, [['Source', String(WIIMOTE_NONE)]]);
        } else if (c.kind === 'wiimote') {
            wm.replaceSection(`Wiimote${i + 1}`, [['Source', String(WIIMOTE_REAL)]]);
            done.push(`Wii Remote ${i + 1} (real)`);
        } else {
            wm.replaceSection(`Wiimote${i + 1}`, wiimotePadEntries(c));
            done.push(`Wii Remote ${i + 1}`);
        }
    }
    if (realWiimotes.length) main.set('Core', 'WiimoteContinuousScanning', 'True');
    if (adapter) done.push('GameCube adapter');

    const changed = [save(path.join(dir, 'Dolphin.ini'), main), save(path.join(dir, 'GCPadNew.ini'), gc), save(path.join(dir, 'WiimoteNew.ini'), wm)];
    return { status: 'configured', changed: changed.some(Boolean), message: done.join(', ') };
}

const writers = { dolphin: writeDolphin };

// Writes the emulator's controller config. Never throws: a failure here must not stop a game launching.
function apply(emulatorId, controllers, { home = os.homedir() } = {}) {
    const write = writers[emulatorId];
    if (!write) {
        return { emulator: emulatorId, status: 'unsupported', message: 'Set up controllers in the emulator itself (Settings → Open)' };
    }
    try {
        return { emulator: emulatorId, ...write(controllers, { home }) };
    } catch (err) {
        return { emulator: emulatorId, status: 'error', message: err.message };
    }
}

module.exports = { apply, assignments, players, gcPadEntries, wiimotePadEntries };
