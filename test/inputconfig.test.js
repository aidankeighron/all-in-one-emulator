const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Ini, save } = require('../ui/lib/ini');
const inputconfig = require('../ui/lib/inputconfig');

const pad = (over = {}) => ({ id: 'js0', name: 'Xbox 360 Controller', kind: 'xbox', pad: true, js: 0, sdlIndex: 0, nameIndex: 0, ...over });
const wiimote = (over = {}) => ({ id: 'js1', name: 'Nintendo Wii Remote', kind: 'wiimote', pad: false, js: 1, sdlIndex: 1, nameIndex: 0, ...over });
const adapter = { id: 'gc-adapter', name: 'Nintendo GameCube Controller Adapter', kind: 'gamecube', pad: false, adapter: true };

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inputcfg-'));
const dolphinDir = home => path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');

test('Ini keeps unrelated lines and updates or adds keys', () => {
    const ini = new Ini('# note\n[Core]\nA = 1\nB = 2\n\n[Other]\nX = 9\n');
    ini.set('Core', 'B', '3').set('Core', 'C', '4').set('New', 'K', 'v');
    assert.strictEqual(ini.toString(), '# note\n[Core]\nA = 1\nB = 3\nC = 4\n\n[Other]\nX = 9\n\n[New]\nK = v\n');
    assert.strictEqual(ini.get('Core', 'C'), '4');
});

test('Ini.replaceSection swaps the whole body', () => {
    const ini = new Ini('[P]\nold = 1\nold2 = 2\n\n[Q]\nz = 1\n');
    ini.replaceSection('P', [['a', 'b']]);
    assert.strictEqual(ini.toString(), '[P]\na = b\n\n[Q]\nz = 1\n');
});

test('save backs up the original once and skips identical writes', () => {
    const dir = tmpHome();
    const file = path.join(dir, 'x.ini');
    fs.writeFileSync(file, '[A]\nk = 1\n');
    assert.strictEqual(save(file, Ini.read(file).set('A', 'k', '2')), true);
    assert.strictEqual(save(file, Ini.read(file).set('A', 'k', '3')), true);
    assert.strictEqual(fs.readFileSync(`${file}.emulator-menu.bak`, 'utf8'), '[A]\nk = 1\n');
    assert.strictEqual(save(file, Ini.read(file)), false);
});

test('Dolphin: gamepad becomes GameCube port 1 and an emulated Wii Remote with Nunchuk', () => {
    const home = tmpHome();
    const result = inputconfig.apply('dolphin', [pad()], { home });
    assert.strictEqual(result.status, 'configured');

    const dir = dolphinDir(home);
    const main = Ini.read(path.join(dir, 'Dolphin.ini'));
    assert.strictEqual(main.get('Core', 'SIDevice0'), '6');
    assert.strictEqual(main.get('Core', 'SIDevice1'), '0');

    const gc = Ini.read(path.join(dir, 'GCPadNew.ini'));
    assert.strictEqual(gc.get('GCPad1', 'Device'), 'SDL/0/Xbox 360 Controller');
    assert.strictEqual(gc.get('GCPad1', 'Buttons/A'), '`Button A`');
    assert.strictEqual(gc.get('GCPad1', 'Buttons/Start'), 'Start');
    assert.strictEqual(gc.get('GCPad1', 'Main Stick/Up'), '`Left Y-`');

    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote1', 'Source'), '1');
    assert.strictEqual(wm.get('Wiimote1', 'Extension'), 'Nunchuk');
    assert.strictEqual(wm.get('Wiimote2', 'Source'), '0');
});

test('Dolphin: a real Wii Remote takes its slot and turns scanning on; the GC adapter takes free ports', () => {
    const home = tmpHome();
    const result = inputconfig.apply('dolphin', [pad(), wiimote(), adapter], { home });
    assert.strictEqual(result.status, 'configured');
    const dir = dolphinDir(home);
    const main = Ini.read(path.join(dir, 'Dolphin.ini'));
    assert.deepStrictEqual([0, 1, 2, 3].map(i => main.get('Core', `SIDevice${i}`)), ['6', '12', '12', '12']);
    assert.strictEqual(main.get('Core', 'WiimoteContinuousScanning'), 'True');
    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote1', 'Source'), '1');
    assert.strictEqual(wm.get('Wiimote2', 'Source'), '2');
});

test('Dolphin: untouched when nothing usable is connected', () => {
    const home = tmpHome();
    assert.strictEqual(inputconfig.apply('dolphin', [], { home }).status, 'skipped');
    assert.strictEqual(fs.existsSync(dolphinDir(home)), false);
});

test('Dolphin: second identical pad uses the next name index', () => {
    const home = tmpHome();
    inputconfig.apply('dolphin', [pad(), pad({ id: 'js1', js: 1, sdlIndex: 1, nameIndex: 1 })], { home });
    const gc = Ini.read(path.join(dolphinDir(home), 'GCPadNew.ini'));
    assert.strictEqual(gc.get('GCPad2', 'Device'), 'SDL/1/Xbox 360 Controller');
});

test('PCSX2 and DuckStation: asks for a first run instead of inventing a settings file', () => {
    const home = tmpHome();
    assert.strictEqual(inputconfig.apply('pcsx2', [pad()], { home }).status, 'needs-first-run');
    assert.strictEqual(inputconfig.apply('duckstation', [pad()], { home }).status, 'needs-first-run');
});

test('PCSX2: writes SDL bindings into the existing settings and keeps the rest', () => {
    const home = tmpHome();
    const file = path.join(home, '.var/app/net.pcsx2.PCSX2/config/PCSX2/inis/PCSX2.ini');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[UI]\nTheme = dark\n\n[Pad1]\nUp = Keyboard/Up\n');
    const result = inputconfig.apply('pcsx2', [pad({ sdlIndex: 2 })], { home });
    assert.strictEqual(result.status, 'configured');
    const ini = Ini.read(file);
    assert.strictEqual(ini.get('UI', 'Theme'), 'dark');
    assert.strictEqual(ini.get('Pad1', 'Type'), 'DualShock2');
    assert.strictEqual(ini.get('Pad1', 'Cross'), 'SDL-2/A');
    assert.strictEqual(ini.get('Pad1', 'L2'), 'SDL-2/+LeftTrigger');
    assert.strictEqual(ini.get('Pad1', 'LUp'), 'SDL-2/-LeftY');
    assert.strictEqual(ini.get('InputSources', 'SDL'), 'true');
    assert.ok(fs.existsSync(`${file}.emulator-menu.bak`));
});

test('DuckStation: finds settings under data/ when that is where they are', () => {
    const home = tmpHome();
    const file = path.join(home, '.var/app/org.duckstation.DuckStation/data/duckstation/settings.ini');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[Main]\nSettingsVersion = 3\n');
    const result = inputconfig.apply('duckstation', [pad(), pad({ id: 'js1', sdlIndex: 1 })], { home });
    assert.strictEqual(result.status, 'configured');
    const ini = Ini.read(file);
    assert.strictEqual(ini.get('Main', 'SettingsVersion'), '3');
    assert.strictEqual(ini.get('Pad1', 'Type'), 'AnalogController');
    assert.strictEqual(ini.get('Pad2', 'Cross'), 'SDL-1/A');
});

test('PPSSPP needs nothing; RPCS3 and Ryujinx are reported as manual', () => {
    assert.strictEqual(inputconfig.apply('ppsspp', [pad()]).status, 'automatic');
    assert.strictEqual(inputconfig.apply('rpcs3', [pad()]).status, 'unsupported');
});

test('assignments say where each controller plays', () => {
    const list = [pad(), wiimote(), adapter];
    const roles = inputconfig.assignments(list);
    assert.deepStrictEqual(roles.js0, ['GameCube port 1', 'Wii Remote 1', 'PS1/PS2 pad 1']);
    assert.deepStrictEqual(roles.js1, ['Wii Remote 2']);
});
