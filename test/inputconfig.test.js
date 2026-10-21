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
    assert.strictEqual(wm.get('Wiimote1', 'Extension'), 'Classic', 'an Xbox-style pad is a Classic Controller unless told otherwise');
    assert.strictEqual(wm.get('Wiimote1', 'Classic/Buttons/A'), '`Button A`');
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

test('Ryujinx is skipped until it has been opened once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryu-none-'));
    assert.strictEqual(inputconfig.apply('ryujinx', [pad()], { home, platform: 'linux' }).status, 'skipped');
});

test('describe says where each controller plays', () => {
    const view = inputconfig.describe([pad(), wiimote(), adapter], {});
    assert.deepStrictEqual(view.roles.js0, ['Player 1', 'Wii: Wii Classic Controller (Xbox / generic)', 'GameCube: GameCube (Xbox / generic)', 'Switch: Switch (Xbox / generic)']);
    assert.deepStrictEqual(view.roles.js1, ['Player 2', 'Wii: Official Wii Remote']);
    assert.deepStrictEqual(view.playerOf, { js0: 1, js1: 2 });
    assert.deepStrictEqual(view.waiting, []);
});

test('a real Wii Remote that is set up but not connected is listed as waiting', () => {
    const view = inputconfig.describe([pad()], { wiiRemotes: 1 });
    assert.strictEqual(view.waiting.length, 1);
    assert.match(view.waiting[0].roles.join(' '), /Player 1.*press 1 \+ 2/);
    assert.deepStrictEqual(view.roles.js0.slice(0, 1), ['Player 2'], 'the gamepad moves to the next player');
});

test('Ryujinx: the controller id matches the one Ryujinx writes itself, and the player entry is filled in', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const controllers = require('../ui/lib/controllers');
    const proc = 'I: Bus=0003 Vendor=24c6 Product=592a Version=0101\nN: Name="Generic X-Box pad"\nP: Phys=\nS: Sysfs=/x\nU: Uniq=\nH: Handlers=js0 event5\nB: PROP=0\n';
    const list = controllers.build(controllers.parseProc(proc));
    assert.strictEqual(inputconfig.ryujinxId(list[0], list), '0-00000003-24c6-0000-2a59-000001010000');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryu-'));
    const dir = path.join(home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Config.json'), JSON.stringify({ version: 70, docked_mode: true, input_config: [] }));
    const result = inputconfig.apply('ryujinx', list, { home, platform: 'linux' });
    assert.strictEqual(result.status, 'configured');
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'Config.json'), 'utf8'));
    assert.strictEqual(written.docked_mode, true, 'other settings are kept');
    assert.strictEqual(written.input_config[0].id, '0-00000003-24c6-0000-2a59-000001010000');
    assert.strictEqual(written.input_config[0].player_index, 'Player1');
    assert.strictEqual(written.input_config[0].right_joycon.button_a, 'A');
    assert.ok(fs.existsSync(path.join(dir, 'Config.json.emulator-menu.bak')));
});

test('Ryujinx on Windows: a pad Ryujinx already knows is put on the right player', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryuw-'));
    const dir = path.join(home, 'AppData', 'Roaming', 'Ryujinx');
    fs.mkdirSync(dir, { recursive: true });
    const entry = { id: '0-00000003-24c6-0000-2a59-000001010000', name: 'Generic X-Box pad (0)', backend: 'GamepadSDL2', player_index: 'Player3', controller_type: 'ProController', right_joycon: { button_a: 'B' } };
    fs.writeFileSync(path.join(dir, 'Config.json'), JSON.stringify({ input_config: [entry] }));
    const known = { id: 'pad0', name: 'Generic X-Box pad', kind: 'generic', pad: true, vendor: '24c6', product: '592a', nameIndex: 0, js: null };
    const env = { APPDATA: path.join(home, 'AppData', 'Roaming') };
    const r = inputconfig.apply('ryujinx', [known], { home, platform: 'win32', env });
    assert.strictEqual(r.status, 'configured');
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'Config.json'), 'utf8')).input_config;
    assert.strictEqual(out[0].player_index, 'Player1');
    assert.strictEqual(out[0].right_joycon.button_a, 'B', 'the person’s layout is kept');
    const stranger = { ...known, name: 'Other pad', vendor: '1234', product: '5678' };
    assert.strictEqual(inputconfig.apply('ryujinx', [stranger], { home, platform: 'win32', env }).status, 'skipped');
});

test('Dolphin: a Joy-Con pair is one device, motion comes from its right half, and SDL is told to join them', () => {
    const controllers = require('../ui/lib/controllers');
    const j = (side, n) => ({ id: `js${n}`, name: `Joy-Con (${side})`, kind: 'switch', vendor: '057e', product: side === 'L' ? '2006' : '2007', bus: '0005', version: '0001', js: n, sdlIndex: n, nameIndex: 0, pad: true, connection: 'Bluetooth', player: n });
    const pair = controllers.combine([j('L', 0), j('R', 1)]);
    const home = tmpHome();
    const result = inputconfig.apply('dolphin', pair, { home });
    assert.strictEqual(result.status, 'configured');
    const dir = dolphinDir(home);
    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote1', 'Device'), 'SDL/0/Nintendo Switch Joy-Con (L/R)');
    assert.strictEqual(wm.get('Wiimote1', 'IMUGyroscope/Pitch Up'), '`Gyro R Pitch Up`', 'a Nintendo pad gets the gyro mapping unless told otherwise');
    assert.strictEqual(wm.get('Wiimote1', 'Extension'), 'Nunchuk');
    assert.strictEqual(wm.get('Wiimote1', 'Buttons/A'), '`Button B`');
    const gc = Ini.read(path.join(dir, 'GCPadNew.ini'));
    assert.strictEqual(gc.get('GCPad1', 'Device'), 'SDL/0/Nintendo Switch Joy-Con (L/R)');
    assert.strictEqual(gc.get('GCPad1', 'Buttons/A'), '`Button B`');
    assert.strictEqual(Ini.read(path.join(dir, 'Dolphin.ini')).get('SDL_Hints', 'SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS'), '1');

    // taken apart on purpose: SDL is told not to join them
    const apart = tmpHome();
    inputconfig.apply('dolphin', [j('L', 0), j('R', 1)], { home: apart, joyconsSplit: true });
    assert.strictEqual(Ini.read(path.join(dolphinDir(apart), 'Dolphin.ini')).get('SDL_Hints', 'SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS'), '0');
    // and left alone when nobody asked
    const plain = tmpHome();
    inputconfig.apply('dolphin', [pad()], { home: plain });
    assert.strictEqual(Ini.read(path.join(dolphinDir(plain), 'Dolphin.ini')).get('SDL_Hints', 'SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS'), undefined);
});

test('Ryujinx: the Switch mapping is written, a layout made in Ryujinx is kept until one is chosen, a Joy-Con keeps its type', () => {
    const mappings = require('../ui/lib/mappings');
    const players = require('../ui/lib/players');
    const profiles = mappings.createStore(tmpHome());
    const home = tmpHome();
    const dir = path.join(home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx');
    fs.mkdirSync(dir, { recursive: true });
    const write = input_config => fs.writeFileSync(path.join(dir, 'Config.json'), JSON.stringify({ version: 70, input_config }));
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'Config.json'), 'utf8')).input_config;
    const pro = pad({ name: 'Nintendo Switch Pro Controller', kind: 'switch', vendor: '057e', product: '2009', bus: '0005', version: '0001' });

    write([]);
    inputconfig.apply('ryujinx', [pro], { home, platform: 'linux', profiles });
    assert.strictEqual(read()[0].right_joycon.button_a, 'B', 'a Nintendo pad is mapped by the labels on it');
    assert.strictEqual(read()[0].left_joycon.button_minus, 'Back');

    const mine = read();
    mine[0].right_joycon.button_a = 'Y';
    write(mine);
    inputconfig.apply('ryujinx', [pro], { home, platform: 'linux', profiles });
    assert.strictEqual(read()[0].right_joycon.button_a, 'Y', 'the layout made in Ryujinx is kept on automatic');
    inputconfig.apply('ryujinx', [pro], { home, platform: 'linux', profiles, players: [{ sw: 'switch-generic' }] });
    assert.strictEqual(read()[0].right_joycon.button_a, 'A', 'a mapping chosen for the player is written');

    // Ryujinx writes Minus and Plus on its newer versions: keep spelling them that way
    const newer = read();
    newer[0].left_joycon.button_minus = 'Minus';
    write(newer);
    inputconfig.apply('ryujinx', [pro], { home, platform: 'linux', profiles, players: [{ sw: 'switch-generic' }] });
    assert.strictEqual(read()[0].left_joycon.button_minus, 'Minus');
    assert.strictEqual(read()[0].right_joycon.button_plus, 'Plus');

    // a lone Joy-Con
    write([]);
    const jc = { ...pro, name: 'Joy-Con (R)', product: '2007' };
    inputconfig.apply('ryujinx', [jc], { home, platform: 'linux', profiles });
    assert.strictEqual(read()[0].controller_type, 'JoyconRight');

    // a pair is read as its left half, and the setup says so
    write([]);
    const controllers = require('../ui/lib/controllers');
    const l = { ...pro, id: 'js2', name: 'Joy-Con (L)', product: '2006', js: 2 }, r = { ...pro, id: 'js3', name: 'Joy-Con (R)', product: '2007', js: 3 };
    const res = inputconfig.apply('ryujinx', controllers.combine([l, r]), { home, platform: 'linux', profiles });
    assert.match(res.message, /Joy-Con pair is read as Joy-Con \(L\) alone/);
    assert.strictEqual(read().length, 1);
});

test('Ryujinx: rumble is on out of the box, and with BetterJoy running motion comes from its server', () => {
    const mappings = require('../ui/lib/mappings');
    const profiles = mappings.createStore(tmpHome());
    const home = tmpHome();
    const dir = path.join(home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Config.json'), JSON.stringify({ version: 70, input_config: [] }));
    const xpad = pad({ vendor: '045e', product: '028e', bus: '0003', version: '0110' });
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'Config.json'), 'utf8')).input_config[0];
    inputconfig.apply('ryujinx', [xpad], { home, platform: 'linux', profiles });
    assert.strictEqual(read().rumble.enable_rumble, true);
    assert.notStrictEqual(read().motion.motion_backend, 'CemuHook');
    // a layout made in Ryujinx is kept on automatic, but rumble still comes on
    const mine = read(); mine.rumble.enable_rumble = false; mine.right_joycon.button_a = 'Y';
    fs.writeFileSync(path.join(dir, 'Config.json'), JSON.stringify({ input_config: [mine] }));
    inputconfig.apply('ryujinx', [xpad], { home, platform: 'linux', profiles, betterjoyMotion: 26760 });
    assert.strictEqual(read().right_joycon.button_a, 'Y');
    assert.strictEqual(read().rumble.enable_rumble, true);
    assert.strictEqual(read().motion.motion_backend, 'CemuHook');
    assert.strictEqual(read().motion.dsu_server_port, 26760);
    assert.strictEqual(read().motion.dsu_server_host, '127.0.0.1');
});
