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
    assert.strictEqual(gc.get('GCPad1', 'Main Stick/Up'), '`Left Y+`', 'SDL reports pushing a stick up as Y+');

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

test('Ryujinx is reported as manual', () => {
    assert.strictEqual(inputconfig.apply('ryujinx', [pad()]).status, 'unsupported');
});

test('describe says where each controller plays', () => {
    const view = inputconfig.describe([pad(), wiimote(), adapter], {});
    assert.deepStrictEqual(view.roles.js0, ['Player 1', 'Wii: Wii Remote + Nunchuk', 'GameCube: GameCube controller']);
    assert.deepStrictEqual(view.roles.js1, ['Player 2', 'Wii Remote (real)']);
    assert.deepStrictEqual(view.waiting, []);
});

test('a real Wii Remote that is set up but not connected is listed as waiting', () => {
    const view = inputconfig.describe([pad()], { wiiRemotes: 1 });
    assert.strictEqual(view.waiting.length, 1);
    assert.match(view.waiting[0].roles.join(' '), /Player 1.*press 1 \+ 2/);
    assert.deepStrictEqual(view.roles.js0.slice(0, 1), ['Player 2'], 'the gamepad moves to the next player');
});
