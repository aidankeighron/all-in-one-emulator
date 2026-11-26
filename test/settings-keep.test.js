// Settings changed in an emulator while it plays a save slot are kept; Dolphin reads Joy-Cons itself on Windows;
// Ryujinx is set up for smoother play
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const adaptersLib = require('../ui/lib/saves/adapters');
const inputconfig = require('../ui/lib/inputconfig');
const ryujinxTune = require('../ui/lib/ryujinxtune');
const { Ini } = require('../ui/lib/ini');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `keep-${p}-`));
const later = (file, seconds) => { const t = new Date(Date.now() + seconds * 1000); fs.utimesSync(file, t, t); };

test('Windows: Ryujinx settings saved into a slot’s copy of Config.json go back to the real one when the game closes', () => {
    const real = tmp('real'), slot = tmp('slot');
    fs.writeFileSync(path.join(real, 'Config.json'), '{"start_fullscreen": false, "docked_mode": true}');
    fs.mkdirSync(path.join(real, 'games'));
    adaptersLib.linkExcept(real, slot, [], true);
    assert.strictEqual(fs.readFileSync(path.join(slot, 'Config.json'), 'utf8'), fs.readFileSync(path.join(real, 'Config.json'), 'utf8'), 'the slot starts with a copy');

    // Nothing changed in the game: nothing goes back
    assert.deepStrictEqual(adaptersLib.settleFiles(real, slot, true), []);

    // The person turned on full screen and handheld mode in Ryujinx while it played the slot
    fs.writeFileSync(path.join(slot, 'Config.json'), '{"start_fullscreen": true, "docked_mode": false}');
    later(path.join(slot, 'Config.json'), 5);
    assert.deepStrictEqual(adaptersLib.settleFiles(real, slot, true), ['Config.json']);
    assert.strictEqual(fs.readFileSync(path.join(real, 'Config.json'), 'utf8'), '{"start_fullscreen": true, "docked_mode": false}');

    // ...and the next start copies the kept settings, not the old ones
    adaptersLib.linkExcept(real, slot, [], true);
    assert.match(fs.readFileSync(path.join(slot, 'Config.json'), 'utf8'), /"start_fullscreen": true/);
});

test('Windows: a slot copy changed while the menu was closed is not overwritten at the next start', () => {
    const real = tmp('real'), slot = tmp('slot');
    fs.writeFileSync(path.join(real, 'Config.json'), '{"docked_mode": true}');
    adaptersLib.linkExcept(real, slot, [], true);
    fs.writeFileSync(path.join(slot, 'Config.json'), '{"docked_mode": false}');
    later(path.join(slot, 'Config.json'), 5);
    adaptersLib.linkExcept(real, slot, [], true);
    assert.strictEqual(fs.readFileSync(path.join(real, 'Config.json'), 'utf8'), '{"docked_mode": false}');
    assert.strictEqual(fs.readFileSync(path.join(slot, 'Config.json'), 'utf8'), '{"docked_mode": false}');
});

test('Windows: the real settings changed by the menu (controllers) win over an older slot copy', () => {
    const real = tmp('real'), slot = tmp('slot');
    fs.writeFileSync(path.join(real, 'Config.json'), '{"input_config": []}');
    adaptersLib.linkExcept(real, slot, [], true);
    fs.writeFileSync(path.join(real, 'Config.json'), '{"input_config": [1]}');
    later(path.join(real, 'Config.json'), 5);
    assert.deepStrictEqual(adaptersLib.settleFiles(real, slot, true), []);
    assert.strictEqual(fs.readFileSync(path.join(real, 'Config.json'), 'utf8'), '{"input_config": [1]}');
    assert.strictEqual(fs.readFileSync(path.join(slot, 'Config.json'), 'utf8'), '{"input_config": [1]}', 'the copy is refreshed');
});

test('Linux: a settings file the emulator replaced inside the slot goes back and is linked again', { skip: process.platform === 'win32' }, () => {
    const real = tmp('real'), slot = tmp('slot');
    fs.writeFileSync(path.join(real, 'Config.json'), 'old');
    adaptersLib.linkExcept(real, slot, [], false);
    assert.ok(fs.lstatSync(path.join(slot, 'Config.json')).isSymbolicLink());
    fs.rmSync(path.join(slot, 'Config.json'));
    fs.writeFileSync(path.join(slot, 'Config.json'), 'new');
    later(path.join(slot, 'Config.json'), 5);
    assert.deepStrictEqual(adaptersLib.settleFiles(real, slot, false), ['Config.json']);
    assert.strictEqual(fs.readFileSync(path.join(real, 'Config.json'), 'utf8'), 'new');
    assert.ok(fs.lstatSync(path.join(slot, 'Config.json')).isSymbolicLink());
});

test('the Ryujinx adapter settles into its real folder', () => {
    const home = tmp('home');
    const env = { APPDATA: path.join(home, 'AppData', 'Roaming') };
    const real = path.join(env.APPDATA, 'Ryujinx');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'Config.json'), '{"a": 1}');
    const ryu = adaptersLib.create({ platform: 'win32', home, env, menuDir: path.join(home, 'menu') }).get('ryujinx');
    const root = ryu.slotRoot('s1');
    fs.mkdirSync(root, { recursive: true });
    ryu.assemble(root);
    fs.writeFileSync(path.join(root, 'Config.json'), '{"a": 2}');
    later(path.join(root, 'Config.json'), 5);
    assert.deepStrictEqual(ryu.settle(root), ['Config.json']);
    assert.strictEqual(fs.readFileSync(path.join(real, 'Config.json'), 'utf8'), '{"a": 2}');
});

// ---------- Dolphin on Windows ----------

const joycon = (side, n, over = {}) => ({ id: `pad${n}`, name: `Joy-Con (${side})`, kind: 'switch', vendor: '057e', product: side === 'L' ? '2006' : '2007', js: null, sdlIndex: n, nameIndex: 0, xinputIndex: null, pad: true, player: n + 1, ...over });
const dolphinIni = (home, env) => Ini.read(path.join(env.APPDATA, 'Dolphin Emulator', 'Config', 'Dolphin.ini'));

test('Windows: Dolphin reads each Joy-Con itself, on its own, as the menu names it', () => {
    const home = tmp('home'), env = { APPDATA: path.join(home, 'AppData', 'Roaming') };
    const r = inputconfig.apply('dolphin', [joycon('L', 0), joycon('R', 1)], { home, env, platform: 'win32', game: 'wii' });
    assert.strictEqual(r.status, 'configured');
    const main = dolphinIni(home, env);
    assert.strictEqual(main.get('SDL_Hints', 'SDL_JOYSTICK_HIDAPI_JOY_CONS'), '1');
    assert.strictEqual(main.get('SDL_Hints', 'SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS'), '0', 'Dolphin would otherwise join the two into one device the menu did not name');
    assert.strictEqual(main.get('SDL_Hints', 'SDL_JOYSTICK_HIDAPI_SWITCH'), '1');
    const wm = Ini.read(path.join(env.APPDATA, 'Dolphin Emulator', 'Config', 'WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote1', 'Device'), 'SDL/0/Nintendo Switch Joy-Con (L)');
    assert.strictEqual(wm.get('Wiimote1', 'Extension'), 'Nunchuk');
});

// ---------- Ryujinx for smoother play ----------

test('Ryujinx: smoother-play settings are written where the file has them, and nothing else', () => {
    const root = tmp('ryu');
    const file = path.join(root, 'Config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 72, gclow_latency: false, enable_shader_cache: false, enable_ptc: true, logging_enable_debug: true, docked_mode: false, start_fullscreen: true }, null, 2));
    const changed = ryujinxTune.apply(root);
    assert.deepStrictEqual(changed.sort(), ['enable_shader_cache', 'gclow_latency', 'logging_enable_debug']);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.gclow_latency, true);
    assert.strictEqual(after.docked_mode, false, 'the person’s own settings stay');
    assert.ok(!('enable_low_power_ptc' in after), 'a key this version does not have is not added');
    assert.deepStrictEqual(ryujinxTune.apply(root), [], 'a second time changes nothing');
    assert.deepStrictEqual(ryujinxTune.apply(tmp('none')), [], 'no Config.json yet: nothing, no error');
});
