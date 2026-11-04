// Removing controllers (disconnect / forget), players kept for a Wii Remote that is not there, Wii Remotes joining a running
// Wii game, and Dolphin's access to Wii Remotes the computer holds
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const playersLib = require('../ui/lib/players');
const inputconfig = require('../ui/lib/inputconfig');
const controllers = require('../ui/lib/controllers');
const bt = require('../ui/lib/bluetooth');
const { createWiimoteAccess, RULES } = require('../ui/lib/wiimoteaccess');
const { Ini } = require('../ui/lib/ini');
const wiimoteLib = require('../ui/lib/wiimote');

const pad = (over = {}) => ({ id: 'js0', name: 'Xbox 360 Controller', kind: 'xbox', pad: true, js: 0, sdlIndex: 0, nameIndex: 0, vendor: '045e', product: '028e', ...over });
const wiimote = (over = {}) => ({ id: 'event9', name: 'Nintendo Wii Remote', kind: 'wiimote', pad: false, js: null, nameIndex: 0, vendor: '057e', product: '0306', address: 'AA:BB:CC:00:00:01', ...over });

test('moving a controller does not keep a player for a Wii Remote that was only there by itself', () => {
    const list = [wiimote(), pad()];
    const players = playersLib.defaults();
    const slots = playersLib.resolve(list, { players }, () => null);
    assert.strictEqual(slots[0].mode, 'real');
    // move the pad from player 2 to player 3: player 1 (the remote) stays automatic, so no "waiting" Wii Remote is left behind
    const moved = playersLib.swap(players, slots, 1, 2);
    assert.strictEqual(moved[0].device, 'auto');
    assert.strictEqual(moved[2].device, playersLib.padKey(list[1]));
    const view = inputconfig.describe([pad()], { players: moved });
    assert.strictEqual(view.waiting.length, 0);
});

test('a released player takes the next controller; everyone else keeps theirs, and nobody keeps a place for the removed one', () => {
    const a = pad(), b = pad({ id: 'js1', js: 1, name: 'Pro Controller', kind: 'switch', vendor: '057e', product: '2009' });
    const players = playersLib.defaults();
    players[3] = { ...players[3], device: playersLib.padKey(a) };      // an old place kept for a
    const slots = playersLib.resolve([a, b], { players }, () => null);
    const out = playersLib.release(players, slots, 3, playersLib.padKey(a));
    assert.strictEqual(out[3].device, 'auto');
    assert.strictEqual(out[0].device, playersLib.padKey(b), 'the Pro Controller keeps player 1');
    assert.ok(out.every(p => p.device !== playersLib.padKey(a)));
    // a player kept for a real Wii Remote is let go
    const kept = playersLib.normalize([{ device: 'real' }, { device: 'real' }]);
    const slots2 = playersLib.resolve([], { players: kept }, () => null);
    assert.deepStrictEqual(playersLib.release(kept, slots2, 1).map(p => p.device), ['real', 'auto', 'auto', 'auto']);
});

test('Dolphin never searches for Wii Remotes all the time (it knocks connected ones off); a free player is nobody', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    const dir = path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');
    inputconfig.apply('dolphin', [pad(), wiimote()], { home, platform: 'linux', game: 'wii' });
    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    assert.deepStrictEqual([1, 2, 3, 4].map(n => wm.get(`Wiimote${n}`, 'Source')), ['1', '2', '0', '0']);
    assert.strictEqual(Ini.read(path.join(dir, 'Dolphin.ini')).get('Core', 'WiimoteContinuousScanning'), 'False');
});

const block = (name, bus, uniq, event, js, product) => [
    `I: Bus=${bus} Vendor=057e Product=${product} Version=8001`, `N: Name="${name}"`, 'P: Phys=', 'S: Sysfs=/devices/x', `U: Uniq=${uniq}`,
    `H: Handlers=event${event}${js === null ? '' : ` js${js}`}`, 'B: EV=1b', 'B: KEY=7fff0000 0 0 0 0 0 0 0 0 0 0 0 ffff0000 0 0 0 0 0 0 0 0', 'B: ABS=3001b', ''
].join('\n');

test('a pair joycond joined is removed through its two Joy-Cons, which have the Bluetooth addresses', () => {
    const proc = [
        block('Nintendo Switch Left Joy-Con', '0005', 'aa:00:00:00:00:01', 10, 0, '2006'),
        block('Nintendo Switch Right Joy-Con', '0005', 'aa:00:00:00:00:02', 11, 1, '2007'),
        block('Nintendo Switch Combined Joy-Cons', '0006', '', 14, 2, '2008'),
        block('Nintendo Switch Left Joy-Con', '0005', 'aa:00:00:00:00:03', 15, 3, '2006'),
        block('Nintendo Switch Right Joy-Con', '0005', 'aa:00:00:00:00:04', 16, 4, '2007'),
        block('Nintendo Switch Combined Joy-Cons', '0006', '', 17, 5, '2008')
    ].join('\n');
    const list = controllers.build(controllers.parseProc(proc));
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual(list.map(c => c.addresses), [['AA:00:00:00:00:01', 'AA:00:00:00:00:02'], ['AA:00:00:00:00:03', 'AA:00:00:00:00:04']]);
    assert.ok(list.every(c => c.connection === 'Bluetooth'));
});

test('disconnect and forget only take a Bluetooth address, and ask bluetoothctl for the right thing', async () => {
    const calls = [];
    const b = bt.createBluetooth({ platform: 'linux', execImpl: (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, '', ''); } });
    await assert.rejects(b.disconnect('--help'), /Bad address/);
    assert.deepStrictEqual(await b.disconnect('aa:bb:cc:dd:ee:ff'), { ok: true });
    await b.forget('AA:BB:CC:DD:EE:FF');
    assert.deepStrictEqual(calls, [['bluetoothctl', 'disconnect', 'AA:BB:CC:DD:EE:FF'], ['bluetoothctl', 'remove', 'AA:BB:CC:DD:EE:FF']]);
});

// A stand-in for bluetoothctl where three controllers start advertising together, the way everyone at once is used
function fakeCrowd() {
    return () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const say = (line, ms = 5) => setTimeout(() => child.stdout.emit('data', `${line}\n`), ms);
        child.stdin = {
            write(text) {
                for (const l of String(text).split('\n').filter(Boolean)) {
                    const [cmd, addr] = l.trim().split(' ');
                    if (cmd === 'scan' && addr === 'on') {
                        say('[NEW] Device 11:00:00:00:00:01 Joy-Con (L)', 10);
                        say('[NEW] Device 11:00:00:00:00:02 Nintendo RVL-CNT-01', 12);
                        say('[NEW] Device 11:00:00:00:00:03 Logitech Mouse', 14);
                        say('[NEW] Device 11:00:00:00:00:04 Joy-Con (R)', 16);
                    }
                    if (cmd === 'pair') say('Pairing successful');
                    if (cmd === 'trust') say(`Changing ${addr} trust succeeded`);
                    // the Wii Remote cannot be connected to the computer: Dolphin connects it in a game
                    if (cmd === 'connect') say(addr.endsWith('02') ? 'Failed to connect: org.bluez.Error.Failed' : 'Connection successful');
                }
            }
        };
        child.kill = () => {};
        return child;
    };
}

test('everyone at once connects every controller that turns up, one after another, until it is told to stop', async () => {
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: fakeCrowd(), exists: () => false, retryMs: 20 });
    b.startPairing('all');
    const end = Date.now() + 4000;
    while (Date.now() < end && (b.snapshot().devices || []).length < 3) await new Promise(r => setTimeout(r, 20));
    let job = b.snapshot();
    if (job.phase === 'running' && job.devices.length < 3) b.cancel();
    assert.strictEqual(job.phase, 'running', 'it keeps waiting for more');
    assert.deepStrictEqual(job.devices.map(d => [d.label, d.ok]), [['Joy-Con (L)', true], ['Wii Remote', true], ['Joy-Con (R)', true]]);
    assert.match(job.devices[1].note, /Dolphin/);
    job = b.cancel();
    assert.strictEqual(job.phase, 'done');
    assert.match(job.message, /Connected: Joy-Con \(L\), Wii Remote, Joy-Con \(R\)/);
});

test('Dolphin access to Wii Remotes: found from the raw devices, and the rule is written with one password prompt', async () => {
    const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'hidraw-'));
    const dev = (name, id) => { fs.mkdirSync(path.join(sys, name, 'device'), { recursive: true }); fs.writeFileSync(path.join(sys, name, 'device', 'uevent'), `DRIVER=wiimote\nHID_ID=${id}\nHID_NAME=Nintendo RVL-CNT-01\n`); };
    dev('hidraw3', '0005:0000057E:00000306');
    dev('hidraw4', '0003:0000046D:0000C52B');      // a mouse receiver
    let installed = false;
    const ran = [];
    const spawnImpl = (cmd, args) => {
        ran.push([cmd, ...args]);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        setTimeout(() => { installed = true; child.emit('close', 0); }, 5);
        return child;
    };
    const access = createWiimoteAccess({ platform: 'linux', sysRoot: sys, devRoot: '/dev', ruleFile: '/tmp/x.rules', exists: () => installed, canOpen: () => installed, spawnImpl });
    assert.deepStrictEqual(access.status(), { supported: true, installed: false, remotes: 1, blocked: 1, needed: true });
    const after = await access.install();
    assert.strictEqual(after.needed, false);
    assert.strictEqual(ran[0][0], 'pkexec');
    assert.ok(RULES.every(l => ran[0][3].includes(l)), 'every line of the rule is written');
    assert.match(ran[0][3], /udevadm trigger --subsystem-match=hidraw/);
    assert.strictEqual(createWiimoteAccess({ platform: 'win32' }).status().needed, false);
});

// bluetoothctl where the Joy-Con connects itself right after pairing, so the menu's own "connect" fails
function fakeSelfConnecting({ stale = false } = {}) {
    const calls = [];
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        let paired = false;
        const say = (line, ms = 5) => setTimeout(() => child.stdout.emit('data', `${line}\n`), ms);
        child.stdin = {
            write(text) {
                for (const l of String(text).split('\n').filter(Boolean)) {
                    const [cmd, addr] = l.trim().split(' ');
                    calls.push(cmd);
                    if (cmd === 'scan' && addr === 'on') say('[NEW] Device 22:00:00:00:00:01 Joy-Con (R)', 10);
                    if (cmd === 'remove') { paired = false; say('[DEL] Device 22:00:00:00:00:01 Joy-Con (R)'); }
                    if (cmd === 'pair') {
                        // stale: BlueZ still has an old pairing the Joy-Con forgot, so nothing connects until it is paired afresh
                        if (stale && !calls.includes('remove')) say('Failed to pair: org.bluez.Error.AlreadyExists');
                        else { paired = true; say('Pairing successful'); }
                    }
                    if (cmd === 'trust') say(`Changing ${addr} trust succeeded`);
                    if (cmd === 'connect') {
                        if (paired && stale) say('Connection successful');
                        else say('Failed to connect: org.bluez.Error.Failed br-connection-create-socket');
                        if (paired && !stale) say(`[CHG] Device ${addr} Connected: yes`, 15);
                    }
                }
            }
        };
        child.kill = () => {};
        return child;
    };
    return { spawnImpl, calls };
}

async function settled(b, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const j = b.snapshot(); if (j && (j.devices || []).some(d => d.ok)) return j; await new Promise(r => setTimeout(r, 20)); }
    return b.snapshot();
}

test('a Joy-Con counts as connected once it is on the computer as a controller, even when "connect" failed', async () => {
    const { spawnImpl, calls } = fakeSelfConnecting();
    let since = 0;
    // the controller part comes up by itself a moment after pairing
    const inputPresent = () => { if (!since && calls.includes('trust')) since = Date.now(); return since && Date.now() - since > 60; };
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl, exists: () => false, retryMs: 30, selfWaitMs: 20, pollMs: 10, inputPresent });
    b.startPairing('all');
    const job = await settled(b);
    b.cancel();
    assert.deepStrictEqual(job.devices.map(d => [d.label, d.ok]), [['Joy-Con (R)', true]]);
});

test('"Connected: yes" from Bluetooth alone is not connected: without the controller showing up it is a failure, and is not hidden', async () => {
    const { spawnImpl, calls } = fakeSelfConnecting();
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl, exists: () => false, retryMs: 20, selfWaitMs: 20, pollMs: 10, stepSeconds: 0.2, inputPresent: () => false });
    b.startPairing('all');
    const end = Date.now() + 4000;
    while (Date.now() < end && !(b.snapshot().devices || []).length) await new Promise(r => setTimeout(r, 20));
    const job = b.cancel();
    assert.deepStrictEqual(job.devices.map(d => [d.label, d.ok]), [['Joy-Con (R)', false]]);
    assert.strictEqual(calls.filter(c => c === 'connect').length, 6, 'three times, then three more after pairing it afresh once');
    assert.strictEqual(calls.filter(c => c === 'remove').length, 1, 'paired afresh only once');
});

test('a Joy-Con BlueZ knew from before is unpaired and paired afresh straight away, without trying the old pairing', async () => {
    const { spawnImpl, calls } = fakeSelfConnecting({ stale: true });
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl, exists: () => false, retryMs: 30 });
    b.startPairing('all');
    const job = await settled(b);
    b.cancel();
    assert.deepStrictEqual(job.devices.map(d => [d.label, d.ok]), [['Joy-Con (R)', true]]);
    assert.strictEqual(calls.filter(c => c === 'connect').length, 1, 'only the fresh pairing is connected');
    assert.ok(calls.indexOf('remove') < calls.indexOf('connect'), 'the old pairing is removed first');
});

test('controller batteries are read from the system, matched by Bluetooth address (a Joy-Con pair shows its emptier half)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
    const put = (dir, files) => { fs.mkdirSync(path.join(root, dir, 'device'), { recursive: true }); for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(root, dir, f), `${v}\n`); };
    put('nintendo_switch_controller_battery_aa:00:00:00:00:01', { scope: 'Device', capacity_level: 'Low', status: 'Discharging' });
    put('nintendo_switch_controller_battery_aa:00:00:00:00:02', { scope: 'Device', capacity_level: 'High', status: 'Discharging' });
    put('wiimote_battery_bb:00:00:00:00:01', { scope: 'Device', capacity: '64', status: 'Discharging' });
    put('BAT0', { scope: 'System', capacity: '10', status: 'Discharging' });         // the laptop's own battery
    const all = controllers.batteries({ root });
    assert.strictEqual(all.size, 3);
    const pair = controllers.batteryOf({ addresses: ['AA:00:00:00:00:01', 'AA:00:00:00:00:02'] }, all);
    assert.deepStrictEqual(pair, { percent: null, level: 'low', charging: false, low: true });
    assert.deepStrictEqual(controllers.batteryOf({ address: 'BB:00:00:00:00:01' }, all), { percent: 64, level: 'high', charging: false, low: false });
    assert.strictEqual(controllers.batteryOf({ address: null }, all), null);
});

test('a Wii Remote is never unpaired by the menu, even when it will not connect', async () => {
    const { spawnImpl } = fakeSelfConnecting();
    const calls = [];
    const wrap = () => {
        const child = spawnImpl();
        const write = child.stdin.write;
        // the same stand-in, answering for a Wii Remote that BlueZ already knows
        child.stdin.write = text => {
            for (const l of String(text).split('\n').filter(Boolean)) calls.push(l.trim().split(' ')[0]);
            const t = String(text).replace(/scan on/, 'scan on');
            if (/^scan on/m.test(t)) setTimeout(() => child.stdout.emit('data', '[NEW] Device 33:00:00:00:00:01 Nintendo RVL-CNT-01\n'), 10);
            if (/^pair /m.test(t)) { setTimeout(() => child.stdout.emit('data', 'Failed to pair: org.bluez.Error.AlreadyExists\n'), 5); return; }
            if (/^scan on/m.test(t)) return;
            return write(text);
        };
        return child;
    };
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: wrap, exists: () => false, retryMs: 20, pollMs: 10, stepSeconds: 0.2, inputPresent: () => false });
    b.startPairing('all');
    const end = Date.now() + 4000;
    while (Date.now() < end && !(b.snapshot().devices || []).length) await new Promise(r => setTimeout(r, 20));
    const job = b.cancel();
    assert.ok(!calls.includes('remove'), 'never removed');
    assert.deepStrictEqual(job.devices.map(d => [d.label, d.ok]), [['Wii Remote', true]], 'still listed: Dolphin connects it in a game');
});

test('a Wii Remote gets its Bluetooth address from its HID device, which also says whether it is really connected', () => {
    const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-'));
    const hid = 'devices/pci0000:00/bluetooth/hci0/hci0:256/0005:057E:0306.0004';
    fs.mkdirSync(path.join(sys, hid, 'input', 'input23'), { recursive: true });
    fs.writeFileSync(path.join(sys, hid, 'uevent'), 'DRIVER=wiimote\nHID_ID=0005:0000057E:00000306\nHID_NAME=Nintendo RVL-CNT-01\nHID_UNIQ=8c:56:c5:aa:bb:cc\n');
    assert.strictEqual(controllers.hidAddress(`/${hid}/input/input23`, { sysRoot: sys }), '8C:56:C5:AA:BB:CC');
    // detect fills it in for the remote, whose input device has no Uniq
    const procFile = path.join(sys, 'devices.txt');
    fs.writeFileSync(procFile, ['I: Bus=0005 Vendor=057e Product=0306 Version=8001', 'N: Name="Nintendo Wii Remote"', 'P: Phys=', `S: Sysfs=/${hid}/input/input23`, 'U: Uniq=', 'H: Handlers=event23', 'B: EV=3', ''].join('\n'));
    const [remote] = controllers.detect({ platform: 'linux', procFile, usbRoot: '/nonexistent', sysRoot: sys });
    assert.strictEqual(remote.kind, 'wiimote');
    assert.strictEqual(remote.address, '8C:56:C5:AA:BB:CC');
    // present while its HID device is there
    const hidRoot = path.join(sys, 'bus-hid');
    fs.mkdirSync(path.join(hidRoot, '0005:057E:0306.0004'), { recursive: true });
    fs.writeFileSync(path.join(hidRoot, '0005:057E:0306.0004', 'uevent'), 'HID_UNIQ=8c:56:c5:aa:bb:cc\n');
    assert.strictEqual(controllers.hidPresent('8C:56:C5:AA:BB:CC', { hidRoot }), true);
    assert.strictEqual(controllers.hidPresent('8C:56:C5:AA:BB:CD', { hidRoot }), false);
});

test('a pair joycond joined takes one place: both Joy-Cons are hidden, not one Joy-Con and a motion sensor', () => {
    const imu = (name, event) => [`I: Bus=0005 Vendor=057e Product=2006 Version=8001`, `N: Name="${name}"`, 'P: Phys=', 'S: Sysfs=/devices/x', 'U: Uniq=', `H: Handlers=event${event}`, 'B: EV=9', 'B: ABS=3f', ''].join('\n');
    const proc = [
        block('Nintendo Switch Left Joy-Con', '0005', 'aa:00:00:00:00:01', 10, 0, '2006'),
        imu('Nintendo Switch Left Joy-Con IMU', 11),
        block('Nintendo Switch Right Joy-Con', '0005', 'aa:00:00:00:00:02', 12, 1, '2007'),
        imu('Nintendo Switch Right Joy-Con IMU', 13),
        block('Nintendo Switch Combined Joy-Cons', '0006', '', 14, 2, '2008')
    ].join('\n');
    const list = controllers.build(controllers.parseProc(proc));
    assert.deepStrictEqual(list.map(c => c.name), ['Nintendo Switch Combined Joy-Cons']);
    assert.deepStrictEqual(list[0].addresses, ['AA:00:00:00:00:01', 'AA:00:00:00:00:02']);
});

test('players kept for two Joy-Cons: once joined, the first one has the pair and the other player is free again', () => {
    const proc = [
        block('Nintendo Switch Left Joy-Con', '0005', 'aa:00:00:00:00:01', 10, 0, '2006'),
        block('Nintendo Switch Right Joy-Con', '0005', 'aa:00:00:00:00:02', 12, 1, '2007')
    ].join('\n');
    const before = controllers.build(controllers.parseProc(proc));
    const players = playersLib.normalize([{ device: playersLib.padKey(before[0]) }, { device: playersLib.padKey(before[1]) }]);
    // L + R: joycond makes the joined controller and the halves go
    const after = controllers.build(controllers.parseProc(`${proc}\n${block('Nintendo Switch Combined Joy-Cons', '0006', '', 14, 2, '2008')}`));
    const xbox = pad({ id: 'js3', js: 3 });
    const slots = playersLib.resolve([...after, xbox], { players }, () => null);
    assert.strictEqual(slots[0].controller.name, 'Nintendo Switch Combined Joy-Cons');
    assert.strictEqual(slots[1].controller, xbox, 'player 2 is free again, so the next controller takes it');
    assert.ok(slots.every(sl => !sl.missing));
});

test('Dolphin: a Wii game gets only Wii Remotes and a GameCube game only GameCube controllers, so no gamepad is two players', () => {
    const two = [pad(), pad({ id: 'js1', js: 1, sdlIndex: 1, name: 'Pro Controller', kind: 'switch', vendor: '057e', product: '2009' })];
    const read = home => {
        const dir = path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');
        return { main: Ini.read(path.join(dir, 'Dolphin.ini')), wm: Ini.read(path.join(dir, 'WiimoteNew.ini')) };
    };
    const wii = fs.mkdtempSync(path.join(os.tmpdir(), 'game-wii-'));
    inputconfig.apply('dolphin', two, { home: wii, platform: 'linux', game: 'wii' });
    let { main, wm } = read(wii);
    assert.deepStrictEqual([1, 2].map(n => wm.get(`Wiimote${n}`, 'Source')), ['1', '1'], 'both are Wii Remotes');
    assert.deepStrictEqual([0, 1, 2, 3].map(n => main.get('Core', `SIDevice${n}`)), ['0', '0', '0', '0'], 'and no GameCube controller');

    const gc = fs.mkdtempSync(path.join(os.tmpdir(), 'game-gc-'));
    inputconfig.apply('dolphin', two, { home: gc, platform: 'linux', game: 'gamecube' });
    ({ main, wm } = read(gc));
    assert.deepStrictEqual([0, 1, 2, 3].map(n => main.get('Core', `SIDevice${n}`)), ['6', '6', '0', '0'], 'both are GameCube controllers');
    assert.deepStrictEqual([1, 2, 3, 4].map(n => wm.get(`Wiimote${n}`, 'Source')), ['0', '0', '0', '0'], 'and no Wii Remote');
    assert.strictEqual(main.get('Core', 'WiimoteContinuousScanning'), 'False');
});

test('a Joy-Con is known by its Bluetooth address, not the one it reports about itself (which named its battery)', () => {
    const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'sysjc-'));
    const hid = 'devices/bt/hci0:256/0005:057E:2006.0007';
    fs.mkdirSync(path.join(sys, hid, 'input', 'input30'), { recursive: true });
    fs.writeFileSync(path.join(sys, hid, 'uevent'), 'HID_UNIQ=98:b6:e9:00:00:01\n');
    const procFile = path.join(sys, 'devices.txt');
    // the Joy-Con reports another address about itself
    fs.writeFileSync(procFile, block('Nintendo Switch Left Joy-Con', '0005', '01:00:00:e9:b6:98', 30, 0, '2006').replace('S: Sysfs=/devices/x', `S: Sysfs=/${hid}/input/input30`));
    const [jc] = controllers.detect({ platform: 'linux', procFile, usbRoot: '/nonexistent', sysRoot: sys });
    assert.strictEqual(jc.address, '98:B6:E9:00:00:01');
    assert.strictEqual(jc.reportedAddress, '01:00:00:E9:B6:98');
    const power = new Map([['01:00:00:E9:B6:98', { percent: null, level: 'low', charging: false, low: true }]]);
    assert.strictEqual(controllers.batteryOf(jc, power).level, 'low', 'its battery is still found');
});

test('the menu lets go of the Wii Remotes while held, and reads them again after', () => {
    const opened = [];
    const reader = wiimoteLib.createReader({ listDevices: () => [{ name: 'Nintendo Wii Remote', event: 7 }], open: f => { opened.push(f); return 99; }, pollMs: 1e6, rescanMs: 1e6 });
    const seen = [];
    const off = reader.subscribe(r => seen.push(r.length));
    assert.strictEqual(opened.length, 1);
    reader.hold(true);
    assert.strictEqual(seen[seen.length - 1], 0, 'nothing is read while held');
    reader.hold(false);
    assert.strictEqual(opened.length, 2, 'opened again');
    off();
});
