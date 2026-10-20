// Writes each emulator's controller settings from the controllers the menu detected, right before a
// game starts. Existing config files are edited in place (other settings are kept) and the original
// is copied to <file>.emulator-menu.bak the first time we change it.
//
//   Dolphin   GameCube ports, Wii Remotes (emulated or real), official GameCube adapter
//   Ryujinx   Config.json's input_config: one entry per player, found by the controller's SDL id (Linux only)
const fs = require('fs');
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

// ---------- Ryujinx ----------

// The button layout used for a controller Ryujinx has no entry for yet: a Switch Pro Controller on a standard pad
const RYUJINX_PAD = {
    left_joycon_stick: { joystick: 'Left', invert_stick_x: false, invert_stick_y: false, rotate90_cw: false, stick_button: 'LeftStick' },
    right_joycon_stick: { joystick: 'Right', invert_stick_x: false, invert_stick_y: false, rotate90_cw: false, stick_button: 'RightStick' },
    deadzone_left: 0.1, deadzone_right: 0.1, range_left: 1, range_right: 1, trigger_threshold: 0.5,
    motion: { motion_backend: 'GamepadDriver', sensitivity: 100, gyro_deadzone: 1, enable_motion: true },
    rumble: { strong_rumble: 1, weak_rumble: 1, enable_rumble: false },
    led: { enable_led: false, turn_off_led: false, use_rainbow: false, led_color: 0 },
    left_joycon: { button_minus: 'Back', button_l: 'LeftShoulder', button_zl: 'LeftTrigger', button_sl: 'SingleLeftTrigger0', button_sr: 'SingleRightTrigger0', dpad_up: 'DpadUp', dpad_down: 'DpadDown', dpad_left: 'DpadLeft', dpad_right: 'DpadRight' },
    right_joycon: { button_plus: 'Start', button_r: 'RightShoulder', button_zr: 'RightTrigger', button_sl: 'SingleLeftTrigger1', button_sr: 'SingleRightTrigger1', button_x: 'X', button_b: 'B', button_y: 'Y', button_a: 'A' },
    version: 1, backend: 'GamepadSDL2', controller_type: 'ProController'
};

// Ryujinx names a controller by its SDL GUID (bus, vendor, product, version) written as a .NET Guid, with the
// number of the identical controllers before it in front: "0-00000003-24c6-0000-2a59-000001010000"
function ryujinxId(c, all) {
    const le = hex => hex.padStart(4, '0').match(/../g).reverse().join('');
    const bus = le(c.bus || '0003'), vendor = le(c.vendor), product = le(c.product), version = le(c.version || '0000');
    // bytes: bus(2) crc(2) vendor(2) 0(2) product(2) 0(2) version(2) 0(2); the first three groups are printed byte-swapped
    const bytes = [bus, '0000', vendor, '0000', product, '0000', version, '0000'];
    const rev = h => h.match(/../g).reverse().join('');
    const text = `${rev(bytes[0] + bytes[1])}-${rev(bytes[2])}-${rev(bytes[3])}-${bytes[4]}-${bytes[5]}${bytes[6]}${bytes[7]}`;
    const same = all.filter(o => o.bus === c.bus && o.vendor === c.vendor && o.product === c.product && o.version === c.version);
    return `${Math.max(0, same.indexOf(c))}-${text}`;
}

function writeRyujinx(controllers, { home, platform, players, profiles }) {
    if (platform === 'win32') return { status: 'skipped', message: 'On Windows, set up Switch controllers in Ryujinx itself' };
    const file = path.join(flatpakDirs(home, 'io.github.ryubing.Ryujinx').config, 'Ryujinx', 'Config.json');
    if (!fs.existsSync(file)) return { status: 'skipped', message: 'Open Ryujinx once from Settings first' };
    const slots = slotsFor(controllers, { players }, profiles).filter(s => s.mode === 'pad');
    if (!slots.length) return { status: 'skipped', message: 'No supported controller connected' };

    const original = fs.readFileSync(file, 'utf8');
    const config = JSON.parse(original);
    const old = Array.isArray(config.input_config) ? config.input_config : [];
    const pads = controllers.filter(c => c.js !== null && c.js !== undefined);
    const made = slots.map(s => {
        const index = `Player${s.index + 1}`;
        // Keep the person's own button layout for this player when there is one
        const mine = old.find(e => e.player_index === index) || old.find(e => e.backend === 'GamepadSDL2') || RYUJINX_PAD;
        const id = ryujinxId(s.controller, pads);
        return { ...JSON.parse(JSON.stringify(mine)), backend: 'GamepadSDL2', id, name: `${s.controller.name} (${id.split('-')[0]})`, player_index: index };
    });
    const taken = new Set(made.map(e => e.player_index));
    const ids = new Set(made.map(e => e.id));
    const next = [...made, ...old.filter(e => !taken.has(e.player_index) && !ids.has(e.id))]
        .sort((a, b) => a.player_index.localeCompare(b.player_index));
    config.input_config = next;
    const text = JSON.stringify(config, null, 2);
    if (text === original.replace(/\r\n/g, '\n').trimEnd()) return { status: 'configured', changed: false, message: made.map(e => `${e.player_index}: ${e.name}`).join(', ') };
    if (!fs.existsSync(file + '.emulator-menu.bak')) fs.copyFileSync(file, file + '.emulator-menu.bak');
    fs.writeFileSync(`${file}.tmp-${process.pid}`, text);
    fs.renameSync(`${file}.tmp-${process.pid}`, file);
    return { status: 'configured', changed: true, message: made.map(e => `${e.player_index}: ${e.name}`).join(', ') };
}

const writers = { dolphin: writeDolphin, ryujinx: writeRyujinx };

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

module.exports = { apply, describe, slotsFor, dolphinDevice, ryujinxId };
