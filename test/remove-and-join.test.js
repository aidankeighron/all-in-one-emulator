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

test('Dolphin: with a Wii Remote paired, free players wait for one, so a remote can join while the game runs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spare-'));
    const dir = path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');
    inputconfig.apply('dolphin', [pad()], { home, platform: 'linux', spareRemotes: true });
    let wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote1', 'Source'), '1');
    assert.deepStrictEqual([2, 3, 4].map(n => wm.get(`Wiimote${n}`, 'Source')), ['2', '2', '2']);
    assert.strictEqual(Ini.read(path.join(dir, 'Dolphin.ini')).get('Core', 'WiimoteContinuousScanning'), 'True');
    // without one, a free player is nobody (and no scanning)
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spare-'));
    inputconfig.apply('dolphin', [pad()], { home: home2, platform: 'linux' });
    wm = Ini.read(path.join(home2, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu/WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote2', 'Source'), '0');
    // nothing connected at all still writes the waiting slots
    const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'spare-'));
    assert.strictEqual(inputconfig.apply('dolphin', [], { home: home3, platform: 'linux', spareRemotes: true }).status, 'configured');
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
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: fakeCrowd(), exists: () => false });
    b.startPairing('all');
    const end = Date.now() + 4000;
    while (Date.now() < end && (b.snapshot().devices || []).length < 3) await new Promise(r => setTimeout(r, 20));
    let job = b.snapshot();
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
