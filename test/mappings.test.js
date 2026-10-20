const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mappings = require('../ui/lib/mappings');
const players = require('../ui/lib/players');
const inputconfig = require('../ui/lib/inputconfig');
const { Ini } = require('../ui/lib/ini');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maps-'));
const pad = (over = {}) => ({ id: 'js0', name: 'Xbox 360 Controller', kind: 'xbox', pad: true, vendor: '045e', product: '028e', js: 0, sdlIndex: 0, nameIndex: 0, ...over });
const switchPad = (over = {}) => pad({ id: 'js1', name: 'Nintendo Switch Pro Controller', kind: 'switch', vendor: '057e', product: '2009', js: 1, ...over });
const dolphinDir = home => path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');

test('every built-in mapping only uses controls and inputs that exist', () => {
    const store = mappings.createStore(tmp());
    const all = store.list().filter(p => p.builtin);
    assert.ok(all.length >= 8);
    for (const p of all) assert.doesNotThrow(() => mappings.normalize(p, { builtin: true }), p.id);
    assert.ok(all.some(p => p.id === mappings.DEFAULT_PROFILE.wii) && all.some(p => p.id === mappings.DEFAULT_PROFILE.gamecube));
});

test('pushing a stick up is Y+ (SDL inverts the vertical axes)', () => {
    const p = mappings.createStore(tmp()).get('gc-default');
    assert.strictEqual(p.entries['Main Stick/Up'], 'Left Y+');
    assert.strictEqual(p.entries['C-Stick/Down'], 'Right Y-');
});

test('your own mappings are saved as files, listed, duplicated and deleted; built-ins are read-only', () => {
    const dir = tmp();
    const store = mappings.createStore(dir);
    const saved = store.save({ name: 'My Xbox + Nunchuk', target: 'wii', extension: 'nunchuk', entries: { 'Buttons/A': 'Button B', 'Buttons/B': '' } });
    assert.strictEqual(saved.id, 'my-xbox-nunchuk');
    assert.ok(fs.existsSync(path.join(dir, 'my-xbox-nunchuk.json')));
    assert.deepStrictEqual(store.get('my-xbox-nunchuk').entries, { 'Buttons/A': 'Button B' });

    const copy = store.duplicate('wii-nunchuk', 'Nunchuk, my way');
    assert.ok(!copy.builtin && copy.entries['Buttons/A'] === 'Button A');
    assert.ok(store.list().some(p => p.id === copy.id));

    assert.throws(() => store.save({ ...saved, id: 'wii-nunchuk' }), /built-in/);
    assert.throws(() => store.remove('wii-nunchuk'), /built-in/);
    store.remove(saved.id);
    assert.strictEqual(store.get(saved.id), null);
});

test('mappings are validated: unknown controls, inputs, settings and ids are refused', () => {
    const store = mappings.createStore(tmp());
    const base = { name: 'x', target: 'wii', extension: 'none' };
    assert.throws(() => store.save({ ...base, entries: { 'Buttons/Q': 'Button A' } }), /Unknown control/);
    assert.throws(() => store.save({ ...base, entries: { 'Buttons/A': 'Button A\nDevice = evil' } }), /not an input/);
    assert.throws(() => store.save({ ...base, entries: { 'Buttons/A': '`Button A` | Start' } }), /not an input/);
    assert.throws(() => store.save({ ...base, settings: { 'Core/Evil': 'True' } }), /Unknown setting/);
    assert.throws(() => store.save({ ...base, extension: 'guitar' }), /extension/);
    assert.throws(() => store.save({ ...base, name: '   ' }), /name/);
    assert.throws(() => store.save({ ...base, id: '../escape' }), /Bad mapping id/);
    assert.strictEqual(store.get('../escape'), null);
    assert.doesNotThrow(() => store.save({ ...base, entries: { 'D-Pad/Up': 'Pad N | Left Y+' } }));
});

test('a broken file in the mappings folder is ignored', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'junk.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ name: 'w', target: 'wii', entries: { 'Nope/X': 'Button A' } }));
    assert.ok(mappings.createStore(dir).list().every(p => p.builtin));
});

test('the Dolphin section follows the mapping: extension, settings and quoting', () => {
    const store = mappings.createStore(tmp());
    const sideways = Object.fromEntries(mappings.dolphinSection(store.get('wii-sideways'), 'SDL/0/Pad'));
    assert.strictEqual(sideways.Source, '1');
    assert.strictEqual(sideways.Extension, 'None');
    assert.strictEqual(sideways['Options/Sideways Wiimote'], 'True');
    assert.strictEqual(sideways['D-Pad/Right'], '`Pad N` | `Left Y+`');
    assert.ok(!Object.keys(sideways).some(k => k.startsWith('Nunchuk/')), 'no Nunchuk lines without the Nunchuk');

    const nunchuk = Object.fromEntries(mappings.dolphinSection(store.get('wii-nunchuk'), 'SDL/0/Pad'));
    assert.strictEqual(nunchuk.Extension, 'Nunchuk');
    assert.strictEqual(nunchuk['Nunchuk/Stick/Up'], '`Left Y+`');
    assert.strictEqual(nunchuk['Buttons/Home'], 'Guide');

    const classic = Object.fromEntries(mappings.dolphinSection(store.get('wii-classic'), 'SDL/0/Pad'));
    assert.strictEqual(classic.Extension, 'Classic');
    assert.ok(classic['Classic/Triggers/L-Analog']);
    assert.ok(!Object.keys(classic).some(k => k.startsWith('Nunchuk/')));
});

test('players: explicit choices win, automatic players take what is left, controllers keep their player', () => {
    const store = mappings.createStore(tmp());
    const xbox = pad(), pro = switchPad(), second = pad({ id: 'js2', js: 2, nameIndex: 1 });
    const get = id => store.get(id);

    let slots = players.resolve([xbox, pro], { players: [] }, get);
    assert.deepStrictEqual(slots.map(s => s.mode), ['pad', 'pad', 'empty', 'empty']);
    assert.strictEqual(slots[0].controller.name, 'Xbox 360 Controller');

    // Player 1 asks for the Pro Controller; the Xbox pad falls to player 2 even though it was plugged in first
    const cfg = { players: [{ device: players.padKey(pro), wii: 'wii-classic', gc: 'gc-nintendo' }] };
    slots = players.resolve([xbox, pro], cfg, get);
    assert.strictEqual(slots[0].controller.name, 'Nintendo Switch Pro Controller');
    assert.strictEqual(slots[0].wii.id, 'wii-classic');
    assert.strictEqual(slots[0].gc.id, 'gc-nintendo');
    assert.strictEqual(slots[1].controller.name, 'Xbox 360 Controller');
    assert.strictEqual(slots[1].wii.id, 'wii-nunchuk', 'automatic mapping is the standard one');

    // Two identical pads stay distinguishable by their order
    slots = players.resolve([xbox, second], { players: [{ device: 'auto' }, { device: players.padKey(second) }] }, get);
    assert.strictEqual(slots[1].controller.id, 'js2');

    // A controller that is not plugged in leaves the player empty and says why
    slots = players.resolve([xbox], { players: [{ device: players.padKey(pro) }] }, get);
    assert.strictEqual(slots[0].mode, 'empty');
    assert.strictEqual(slots[0].missing, players.padKey(pro));
    assert.strictEqual(slots[1].controller.name, 'Xbox 360 Controller');

    // none and real
    slots = players.resolve([xbox], { players: [{ device: 'none' }, { device: 'real' }, { device: 'auto' }] }, get);
    assert.deepStrictEqual(slots.map(s => s.mode), ['none', 'real', 'pad', 'empty']);
});

test('players are sanitised', () => {
    const clean = players.normalize([{ device: 'rm -rf', wii: '../x', gc: 'gc-default' }, 'nope', null]);
    assert.strictEqual(clean.length, 4);
    assert.deepStrictEqual(clean[0], { device: 'auto', wii: 'auto', gc: 'gc-default' });
});

test('Dolphin gets each player their own controller and mapping, and a changed mapping is re-synced', () => {
    const home = tmp();
    const profiles = mappings.createStore(tmp());
    const xbox = pad(), pro = switchPad();
    const cfg = { players: [{ device: players.padKey(pro), wii: 'wii-sideways', gc: 'gc-nintendo' }, { device: players.padKey(xbox), wii: 'wii-classic' }] };
    const run = () => inputconfig.apply('dolphin', [xbox, pro], { home, players: cfg.players, profiles });
    assert.strictEqual(run().status, 'configured');

    const dir = dolphinDir(home);
    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote1', 'Device'), 'SDL/0/Nintendo Switch Pro Controller');
    assert.strictEqual(wm.get('Wiimote1', 'Options/Sideways Wiimote'), 'True');
    assert.strictEqual(wm.get('Wiimote1', 'Extension'), 'None');
    assert.strictEqual(wm.get('Wiimote2', 'Device'), 'SDL/0/Xbox 360 Controller');
    assert.strictEqual(wm.get('Wiimote2', 'Extension'), 'Classic');
    assert.strictEqual(wm.get('Wiimote3', 'Source'), '0');
    const gc = Ini.read(path.join(dir, 'GCPadNew.ini'));
    assert.strictEqual(gc.get('GCPad1', 'Buttons/A'), '`Button B`');
    assert.strictEqual(gc.get('GCPad2', 'Buttons/A'), '`Button A`');

    // Edit the Xbox player's mapping: the next sync rewrites only what changed
    const mine = profiles.save({ name: 'Mine', target: 'wii', extension: 'nunchuk', entries: { 'Buttons/A': 'Button Y' } });
    cfg.players[1].wii = mine.id;
    assert.strictEqual(run().changed, true);
    assert.strictEqual(Ini.read(path.join(dir, 'WiimoteNew.ini')).get('Wiimote2', 'Buttons/A'), '`Button Y`');
    assert.strictEqual(run().changed, false, 'nothing to change the second time');
});

test('with nobody on a gamepad, a real Wii Remote leaves the GameCube ports alone', () => {
    const home = tmp();
    const res = inputconfig.apply('dolphin', [], { home, wiiRemotes: 1 });
    assert.strictEqual(res.status, 'configured');
    const main = Ini.read(path.join(dolphinDir(home), 'Dolphin.ini'));
    assert.strictEqual(main.get('Core', 'SIDevice0'), undefined);
    assert.strictEqual(Ini.read(path.join(dolphinDir(home), 'WiimoteNew.ini')).get('Wiimote1', 'Source'), '2');
});
