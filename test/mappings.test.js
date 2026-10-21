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
    assert.strictEqual(all.length, 9);
    for (const p of all) assert.doesNotThrow(() => mappings.normalize(p, { builtin: true }), p.id);
    for (const target of ['wii', 'gamecube', 'switch']) {
        for (const family of ['generic', 'nintendo', 'wiimote']) {
            const id = mappings.defaultFor(target, family);
            assert.ok(all.some(p => p.id === id && p.target === target), `${target}/${family} default ${id} exists`);
        }
    }
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
    assert.strictEqual(copy.family, 'generic');
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
    const mine = store.save({ name: 'Sideways', target: 'wii', extension: 'none', settings: { 'Options/Sideways Wiimote': 'True' }, entries: { 'D-Pad/Right': 'Pad N | Left Y+', 'Buttons/A': 'Button B' } });
    const sideways = Object.fromEntries(mappings.dolphinSection(mine, 'SDL/0/Pad'));
    assert.strictEqual(sideways.Source, '1');
    assert.strictEqual(sideways.Extension, 'None');
    assert.strictEqual(sideways['Options/Sideways Wiimote'], 'True');
    assert.strictEqual(sideways['D-Pad/Right'], '`Pad N` | `Left Y+`');
    assert.ok(!Object.keys(sideways).some(k => k.startsWith('Nunchuk/')), 'no Nunchuk lines without the Nunchuk');

    const nunchuk = Object.fromEntries(mappings.dolphinSection(store.get('wii-nunchuk'), 'SDL/0/Pad'));
    assert.strictEqual(nunchuk.Extension, 'Nunchuk');
    assert.strictEqual(nunchuk['Nunchuk/Stick/Up'], '`Left Y+`');
    assert.strictEqual(nunchuk['Buttons/Home'], 'Guide');
    assert.ok(!Object.keys(nunchuk).some(k => /^(IR|IMU|Shake|Tilt|Swing)/.test(k)), 'no pointer or motion unless you add them');

    const classic = Object.fromEntries(mappings.dolphinSection(store.get('wii-classic'), 'SDL/0/Pad'));
    assert.strictEqual(classic.Extension, 'Classic');
    assert.ok(classic['Classic/Triggers/L-Analog']);
    assert.strictEqual(classic['Classic/Buttons/A'], '`Button A`', 'an Xbox A is the Classic Controller’s A');
    assert.ok(!Object.keys(classic).some(k => k.startsWith('Nunchuk/')));

    const nintendoClassic = Object.fromEntries(mappings.dolphinSection(store.get('wii-classic-nintendo'), 'SDL/0/Pad'));
    assert.strictEqual(nintendoClassic['Classic/Buttons/A'], '`Button B`', 'the Switch controller’s A is on the right, which Dolphin calls B');
});

test('the gyro mapping drives the Wii Remote’s motion from the controller’s sensors, and a Joy-Con pair uses its right half', () => {
    const store = mappings.createStore(tmp());
    const single = Object.fromEntries(mappings.dolphinSection(store.get('wii-nunchuk-gyro'), 'SDL/0/Nintendo Switch Pro Controller'));
    assert.strictEqual(single['IMUGyroscope/Pitch Up'], '`Gyro Pitch Up`');
    assert.strictEqual(single['IMUAccelerometer/Forward'], '`Accel Forward`');
    assert.ok(!single['IMUIR/Recenter'] && !Object.keys(single).some(k => k.startsWith('IR/')), 'no pointer');
    const pair = Object.fromEntries(mappings.dolphinSection(store.get('wii-nunchuk-gyro'), 'SDL/0/Nintendo Switch Joy-Con (L/R)', { pair: true }));
    assert.strictEqual(pair['IMUGyroscope/Pitch Up'], '`Gyro R Pitch Up`');
    assert.strictEqual(pair['IMUAccelerometer/Forward'], '`Accel R Forward`');
});

test('mappings are made for a kind of controller, and the inputs on offer follow it', () => {
    const xbox = mappings.sourcesFor('generic', 'wii'), nintendo = mappings.sourcesFor('nintendo', 'wii');
    assert.ok(!xbox.some(s => /Gyro|Accel/.test(s.value)), 'an Xbox pad has no motion sensors');
    assert.ok(nintendo.some(s => s.value === 'Gyro Pitch Up') && nintendo.some(s => s.value === 'Misc 1'));
    assert.strictEqual(xbox.find(s => s.value === 'Button B').label, 'B (right button)');
    assert.strictEqual(nintendo.find(s => s.value === 'Button B').label, 'A (right button)', 'the same input is the A button on a Nintendo pad');
    assert.strictEqual(nintendo.find(s => s.value === 'Trigger L').label, 'ZL');
    // the Switch can only take single buttons
    const sw = mappings.sourcesFor('nintendo', 'switch');
    assert.ok(sw.length > 10 && !sw.some(s => /stick (up|down|left|right)|Gyro|Accel/.test(s.label)));

    const store = mappings.createStore(tmp());
    assert.throws(() => store.save({ name: 'x', target: 'wii', family: 'generic', entries: { 'IMUGyroscope/Pitch Up': 'Gyro Pitch Up' } }), /motion/);
    assert.doesNotThrow(() => store.save({ name: 'x', target: 'wii', family: 'nintendo', entries: { 'IMUGyroscope/Pitch Up': 'Gyro Pitch Up' } }));
    assert.throws(() => store.save({ name: 'x', target: 'switch', family: 'generic', entries: { 'Buttons/A': 'Left Y+' } }), /cannot be used/);
    assert.throws(() => store.save({ name: 'x', target: 'switch', family: 'generic', entries: { 'Buttons/A': 'Button A | Button B' } }), /cannot be used|not an input/);
    assert.throws(() => store.save({ name: 'x', target: 'gamecube', family: 'wiimote' }), /Wii Remote/);
    assert.throws(() => store.save({ name: 'x', target: 'wii', family: 'wiimote' }), /needs no mapping/);
    assert.throws(() => store.save({ name: 'x', target: 'wii', family: 'guitar' }), /kind of controller/);
    assert.throws(() => store.save({ name: 'x', target: 'switch', family: 'generic', settings: { 'Sticks/Left': 'Middle' } }), /Unknown setting/);
    assert.doesNotThrow(() => store.save({ name: 'x', target: 'switch', family: 'nintendo', settings: { 'Sticks/Left': 'Right', 'Motion/Enabled': 'False' } }));
    // a mapping saved before kinds existed is for a Nintendo pad only if it used the motion sensors
    fs.writeFileSync(path.join(store.dir, 'old.json'), JSON.stringify({ name: 'Old', target: 'wii', entries: { 'IMUGyroscope/Pitch Up': 'Gyro Pitch Up' } }));
    fs.writeFileSync(path.join(store.dir, 'old2.json'), JSON.stringify({ name: 'Old two', target: 'wii', entries: { 'Buttons/A': 'Button A' } }));
    assert.strictEqual(store.get('old').family, 'nintendo');
    assert.strictEqual(store.get('old2').family, 'generic');
});

test('a Switch mapping becomes Ryujinx buttons, sticks and motion', () => {
    const store = mappings.createStore(tmp());
    const generic = mappings.ryujinxPatch(store.get('switch-generic'));
    assert.strictEqual(generic.right_joycon.button_a, 'A');
    assert.strictEqual(generic.right_joycon.button_zr, 'RightTrigger');
    assert.strictEqual(generic.left_joycon.dpad_up, 'DpadUp');
    assert.strictEqual(generic.left_joycon_stick.joystick, 'Left');
    const nintendo = mappings.ryujinxPatch(store.get('switch-nintendo'));
    assert.strictEqual(nintendo.right_joycon.button_a, 'B', 'the A button of a Switch pad is on the right, which Ryujinx calls B');
    const mine = store.save({ name: 'Lefty', target: 'switch', family: 'generic', settings: { 'Sticks/Left': 'Right', 'Sticks/Right': 'Left', 'Motion/Enabled': 'False' }, entries: { 'Buttons/A': 'Button X' } });
    const patch = mappings.ryujinxPatch(mine);
    assert.strictEqual(patch.right_joycon.button_a, 'X');
    assert.strictEqual(patch.right_joycon.button_b, 'Unbound', 'what is not mapped is unbound');
    assert.strictEqual(patch.left_joycon_stick.joystick, 'Right');
    assert.strictEqual(patch.motion.enable_motion, false);
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
    assert.strictEqual(slots[0].sw.id, 'switch-nintendo', 'a Nintendo pad gets the Nintendo Switch mapping on automatic');
    assert.strictEqual(slots[1].sw.id, 'switch-generic');
    assert.strictEqual(slots[0].gc.id, 'gc-nintendo');
    assert.strictEqual(slots[1].controller.name, 'Xbox 360 Controller');
    assert.strictEqual(slots[1].wii.id, 'wii-classic', 'automatic mapping is the standard one for an Xbox-style pad');

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
    assert.deepStrictEqual(clean[0], { device: 'auto', wii: 'auto', gc: 'gc-default', sw: 'auto' });
});

test('a mapping follows the kind of controller: Nintendo pads, Xbox-style pads and real Wii Remotes get their own standard ones', () => {
    const store = mappings.createStore(tmp());
    const get = id => store.get(id);
    const xbox = pad(), pro = switchPad();
    let slots = players.resolve([pro, xbox], { players: [] }, get);
    assert.deepStrictEqual([slots[0].wii.id, slots[0].gc.id, slots[0].sw.id], ['wii-nunchuk-gyro', 'gc-nintendo', 'switch-nintendo']);
    assert.deepStrictEqual([slots[1].wii.id, slots[1].gc.id, slots[1].sw.id], ['wii-classic', 'gc-default', 'switch-generic']);
    slots = players.resolve([], { players: [{ device: 'real' }] }, get);
    assert.strictEqual(slots[0].family, 'wiimote');
    assert.strictEqual(slots[0].wii.id, 'wii-remote');
    // A mapping for the wrong console, or a real-remote one picked for a gamepad, is not used
    slots = players.resolve([xbox], { players: [{ device: 'auto', wii: 'gc-default', gc: 'wii-classic', sw: 'wii-remote' }] }, get);
    assert.deepStrictEqual([slots[0].wii.id, slots[0].gc.id, slots[0].sw.id], ['wii-classic', 'gc-default', 'switch-generic']);
    // a chosen one wins, and stays chosen when the player's controller changes
    slots = players.resolve([pro], { players: [{ device: 'auto', wii: 'wii-classic-nintendo' }] }, get);
    assert.strictEqual(slots[0].wii.id, 'wii-classic-nintendo');
});

test('moving a controller to another player swaps the two, and the mappings go with their controllers', () => {
    const store = mappings.createStore(tmp());
    const get = id => store.get(id);
    const xbox = pad(), pro = switchPad();
    const saved = [{ device: 'auto', wii: 'wii-classic' }, { device: 'auto', gc: 'gc-nintendo' }];
    const slots = players.resolve([xbox, pro], { players: saved }, get);
    assert.deepStrictEqual(slots.map(s => s.mode), ['pad', 'pad', 'empty', 'empty']);

    let list = players.swap(saved, slots, 0, 1);
    let now = players.resolve([xbox, pro], { players: list }, get);
    assert.strictEqual(now[0].controller.name, 'Nintendo Switch Pro Controller');
    assert.strictEqual(now[1].controller.name, 'Xbox 360 Controller');
    assert.strictEqual(now[0].gc.id, 'gc-nintendo', 'the Pro Controller took its GameCube mapping with it');
    assert.strictEqual(now[1].wii.id, 'wii-classic');
    // it holds when another controller is plugged in first
    const newcomer = pad({ id: 'js9', name: 'Other', js: 9, nameIndex: 0, vendor: '1111' });
    now = players.resolve([newcomer, xbox, pro], { players: list }, get);
    assert.strictEqual(now[0].controller.name, 'Nintendo Switch Pro Controller');
    assert.strictEqual(now[2].controller.name, 'Other');

    // into an empty player
    list = players.swap(saved, slots, 0, 2);
    now = players.resolve([xbox, pro], { players: list }, get);
    assert.deepStrictEqual(now.map(s => s.controller && s.controller.name), [null, 'Nintendo Switch Pro Controller', 'Xbox 360 Controller', null], 'the Pro Controller stays player 2');
    // a real Wii Remote moves too
    const withReal = players.resolve([xbox], { players: [{ device: 'real' }, { device: 'auto' }] }, get);
    list = players.swap([{ device: 'real' }, { device: 'auto' }], withReal, 0, 1);
    assert.strictEqual(list[1].device, 'real');
    assert.strictEqual(list[0].device, players.padKey(xbox));
    // nonsense changes nothing
    assert.deepStrictEqual(players.swap(saved, slots, 0, 9), players.normalize(saved));

    // a controller nobody uses takes a player; whoever had it loses it
    const spare = pad({ id: 'js3', name: 'Spare', js: 3, nameIndex: 0, vendor: '2222' });
    const taken = [{ device: players.padKey(spare) }, {}];
    const before = players.resolve([spare], { players: taken }, get);
    list = players.place(taken, before, players.padKey(spare), 1);
    assert.strictEqual(list[1].device, players.padKey(spare));
    assert.strictEqual(list[0].device, 'auto');
    assert.strictEqual(players.place(list, before, 'real', 0)[0].device, 'auto', 'only controllers can be placed');

    // two controllers become one: the player that had either keeps the pair; a second one goes back to automatic
    const [ka, kb, pair] = ['pad:a', 'pad:b', 'pad:combo:a+b'];
    assert.deepStrictEqual(players.repin([{ device: kb }, { device: ka }], [ka, kb], pair).map(p => p.device), [pair, 'auto', 'auto', 'auto']);
    assert.deepStrictEqual(players.repin([{ device: pair }], [pair], ka).map(p => p.device), [ka, 'auto', 'auto', 'auto']);
});

test('Dolphin gets each player their own controller and mapping, and a changed mapping is re-synced', () => {
    const home = tmp();
    const profiles = mappings.createStore(tmp());
    const xbox = pad(), pro = switchPad();
    const sideways = profiles.save({ name: 'Sideways', target: 'wii', extension: 'none', settings: { 'Options/Sideways Wiimote': 'True' }, entries: { 'Buttons/A': 'Button B' } });
    const cfg = { players: [{ device: players.padKey(pro), wii: sideways.id, gc: 'gc-nintendo' }, { device: players.padKey(xbox), wii: 'wii-classic' }] };
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
