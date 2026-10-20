// Writes each emulator's controller settings from the controllers the menu detected, right before a
// game starts. Existing config files are edited in place (other settings are kept) and the original
// is copied to <file>.emulator-menu.bak the first time we change it.
//
//   Dolphin   GameCube ports, Wii Remotes (emulated or real), official GameCube adapter
//   Ryujinx   not written (see README): its format depends on per-device IDs
const os = require('os');
const platformLib = require('./platform');
const path = require('path');
const { Ini, save } = require('./ini');
const adapters = require('./saves/adapters');
const mappings = require('./mappings');
const playersLib = require('./players');

// Dolphin SIDevice values
const SI_NONE = 0;
const SI_GC_CONTROLLER = 6;
const SI_GC_ADAPTER = 12;

// Dolphin source for a Wii Remote slot
const WIIMOTE_NONE = 0;
const WIIMOTE_REAL = 2;

function flatpakDirs(home, id) {
    const base = path.join(home, '.var', 'app', id);
    return { config: path.join(base, 'config'), data: path.join(base, 'data') };
}

// Where Dolphin keeps Dolphin.ini, GCPadNew.ini and WiimoteNew.ini
function dolphinConfigDir({ platform, home, env, exePath }) {
    if (platform === 'win32') return path.join(adapters.dolphinWindowsUser({ home, env, exePath }), 'Config');
    return path.join(flatpakDirs(home, 'org.DolphinEmu.dolphin-emu').config, 'dolphin-emu');
}

// ---------- Who plays what ----------

// settings: {players, wiiRemotes}; store: the mapping profiles (lib/mappings)
function slotsFor(controllers, settings = {}, store = mappings.createStore('')) {
    return playersLib.resolve(controllers, settings, id => store.get(id));
}

// For the controllers page: where each controller will play, as short phrases, plus the real Wii Remotes
// that are set up but not connected (Dolphin connects those itself when a game starts)
function describe(controllers, settings = {}, store) {
    const slots = slotsFor(controllers, settings, store);
    const roles = {};
    const waiting = [];
    for (const c of controllers) roles[c.id] = c.adapter ? ['GameCube: the port each controller is plugged into'] : [];
    for (const s of slots) {
        const n = s.index + 1;
        if (s.mode === 'pad') {
            roles[s.controller.id] = [`Player ${n}`, `Wii: ${s.wii.name}`, `GameCube: ${s.gc.name}`];
        } else if (s.mode === 'real') {
            const seen = controllers.find(c => c.kind === 'wiimote' && !roles[c.id].length);
            if (seen) roles[seen.id] = [`Player ${n}`, 'Wii Remote (real)'];
            else waiting.push({ id: `real-wiimote-${n}`, player: n, roles: [`Player ${n}`, 'Real Wii Remote', 'Connects when a game starts: press 1 + 2'] });
        }
    }
    for (const c of controllers) if (!c.adapter && !roles[c.id].length) roles[c.id] = ['Not used by a player'];
    return { slots, roles, waiting };
}

// ---------- Dolphin ----------

// Xbox pads on Windows are reached through XInput; everything else through SDL
function dolphinDevice(c, platform) {
    if (platform === 'win32' && c.xinputIndex !== null && c.xinputIndex !== undefined) return `XInput/${c.xinputIndex}/Gamepad`;
    return `SDL/${c.nameIndex}/${c.name}`;
}

function writeDolphin(controllers, { home, platform, env, exePath, wiiRemotes = 0, players, profiles }) {
    const adapter = controllers.some(c => c.adapter);
    const slots = slotsFor(controllers, { players, wiiRemotes }, profiles);
    const anyone = slots.some(s => s.mode === 'pad' || s.mode === 'real');
    if (!anyone && !adapter) return { status: 'skipped', message: 'No supported controller connected' };

    const dir = dolphinConfigDir({ platform, home, env, exePath });
    const main = Ini.read(path.join(dir, 'Dolphin.ini'));
    const gc = Ini.read(path.join(dir, 'GCPadNew.ini'));
    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    const done = [];
    // The GameCube ports are left alone when no gamepad or adapter is involved (only a real Wii Remote, say)
    const touchPorts = adapter || slots.some(s => s.mode === 'pad');

    for (const s of slots) {
        const i = s.index;
        if (s.mode === 'pad') {
            const device = dolphinDevice(s.controller, platform);
            main.set('Core', `SIDevice${i}`, String(SI_GC_CONTROLLER));
            gc.replaceSection(`GCPad${i + 1}`, mappings.dolphinSection(s.gc, device));
            wm.replaceSection(`Wiimote${i + 1}`, mappings.dolphinSection(s.wii, device));
            done.push(`Player ${i + 1}: ${s.controller.name} (${s.wii.name})`);
        } else {
            if (touchPorts) main.set('Core', `SIDevice${i}`, String(adapter ? SI_GC_ADAPTER : SI_NONE));
            if (s.mode === 'real') {
                wm.replaceSection(`Wiimote${i + 1}`, [['Source', String(WIIMOTE_REAL)]]);
                done.push(`Player ${i + 1}: real Wii Remote`);
            } else {
                wm.replaceSection(`Wiimote${i + 1}`, [['Source', String(WIIMOTE_NONE)]]);
            }
        }
    }
    if (slots.some(s => s.mode === 'real')) main.set('Core', 'WiimoteContinuousScanning', 'True');
    if (adapter) done.push('GameCube adapter');

    const changed = [save(path.join(dir, 'Dolphin.ini'), main), save(path.join(dir, 'GCPadNew.ini'), gc), save(path.join(dir, 'WiimoteNew.ini'), wm)];
    return { status: 'configured', changed: changed.some(Boolean), message: done.join(', ') };
}

const writers = { dolphin: writeDolphin };

// Writes the emulator's controller config. Never throws: a failure here must not stop a game launching.
// context: {home, platform, env, exePath(id), wiiRemotes, players, profiles}. Defaults to this computer.
function apply(emulatorId, controllers, context = {}) {
    const ctx = {
        wiiRemotes: context.wiiRemotes || 0, players: context.players, profiles: context.profiles || mappings.createStore(''),
        home: context.home || os.homedir(), platform: context.platform || platformLib.current(), env: context.env || process.env, exePath: context.exePath || (() => null)
    };
    const write = writers[emulatorId];
    if (!write) {
        return { emulator: emulatorId, status: 'unsupported', message: 'Set up controllers in the emulator itself (Settings → Open)' };
    }
    try {
        return { emulator: emulatorId, ...write(controllers, ctx) };
    } catch (err) {
        return { emulator: emulatorId, status: 'error', message: err.message };
    }
}

module.exports = { apply, describe, slotsFor, dolphinDevice };
