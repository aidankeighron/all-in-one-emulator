const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const bt = require('../ui/lib/bluetooth');
const inputconfig = require('../ui/lib/inputconfig');

test('devices are recognised by their Bluetooth names', () => {
    assert.strictEqual(bt.classifyDevice('Nintendo RVL-CNT-01'), 'wiimote');
    assert.strictEqual(bt.classifyDevice('Nintendo RVL-CNT-01-TR'), 'wiimote');
    assert.strictEqual(bt.classifyDevice('Pro Controller'), 'pro');
    assert.strictEqual(bt.classifyDevice('Joy-Con (L)'), 'joycon-l');
    assert.strictEqual(bt.classifyDevice('Joy-Con (R)'), 'joycon-r');
    assert.strictEqual(bt.classifyDevice('Nintendo RVL-WBC-01'), 'balance-board');
    assert.strictEqual(bt.classifyDevice('Logitech Mouse'), null);
});

test('bluetoothctl output is parsed, colour codes and all', () => {
    assert.deepStrictEqual(bt.parseLine('\x1b[0;92m[NEW]\x1b[0m Device 00:1B:7A:11:22:33 Nintendo RVL-CNT-01'), { event: 'new', address: '00:1B:7A:11:22:33', name: 'Nintendo RVL-CNT-01' });
    assert.deepStrictEqual(bt.parseLine('[CHG] Device 00:1B:7A:11:22:33 Name: Pro Controller'), { event: 'name', address: '00:1B:7A:11:22:33', name: 'Pro Controller' });
    assert.strictEqual(bt.parseLine('[CHG] Device 00:1B:7A:11:22:33 RSSI: -60').event, 'prop');
    assert.strictEqual(bt.parseLine('Discovery started'), null);
    assert.deepStrictEqual(bt.parseDevices('Device AA:BB:CC:DD:EE:FF Pro Controller\nDevice 11:22:33:44:55:66 Mouse'), [{ address: 'AA:BB:CC:DD:EE:FF', name: 'Pro Controller' }, { address: '11:22:33:44:55:66', name: 'Mouse' }]);
});

test('kernel and package manager checks', () => {
    assert.ok(bt.kernelAtLeast('6.8.0-45-generic', 5, 16));
    assert.ok(!bt.kernelAtLeast('5.15.0-100-generic', 5, 16));
    assert.strictEqual(bt.packageCommand(n => n === 'dnf').name, 'dnf');
    assert.strictEqual(bt.packageCommand(n => n === 'apt-get').name, 'apt');
    assert.strictEqual(bt.packageCommand(() => false), null);
});

// A stand-in for bluetoothctl: prints a controller when "scan on" arrives and answers pair/trust/connect
function fakeBluetoothctl(script) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakebt-')), 'fake.js');
    fs.writeFileSync(file, script);
    return () => spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
}

const GOOD = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  const [cmd, addr] = l.trim().split(' ');
  if (cmd === 'scan' && addr === 'on') { console.log('Discovery started'); setTimeout(() => console.log('\\x1b[0;92m[NEW]\\x1b[0m Device 11:22:33:44:55:66 Keyboard'), 20); setTimeout(() => console.log('[NEW] Device AA:BB:CC:DD:EE:FF ' + (process.env.FAKE_NAME || 'Pro Controller')), 60); }
  if (cmd === 'pair') { console.log('Attempting to pair with ' + addr); setTimeout(() => console.log(process.env.FAKE_PAIR_FAIL ? 'Failed to pair: org.bluez.Error.AuthenticationFailed' : 'Pairing successful'), 20); }
  if (cmd === 'trust') console.log('[CHG] Device ' + addr + ' Trusted: yes\\nChanging ' + addr + ' trust succeeded');
  if (cmd === 'connect') setTimeout(() => console.log('Connection successful'), 20);
  if (cmd === 'quit') process.exit(0);
});`;

async function waitFor(bluetooth, done, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const j = bluetooth.snapshot();
        if (j && j.phase !== 'running') return j;
        await new Promise(r => setTimeout(r, 25));
    }
    return bluetooth.snapshot();
}

test('a Switch controller is paired, trusted and connected', async () => {
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: fakeBluetoothctl(GOOD) });
    b.startPairing('switch');
    const job = await waitFor(b);
    assert.strictEqual(job.phase, 'done', job.message);
    assert.match(job.message, /Switch Pro Controller connected/);
    assert.strictEqual(job.device.address, 'AA:BB:CC:DD:EE:FF');
});

test('a Wii Remote is only found, never paired with the computer', async () => {
    process.env.FAKE_NAME = 'Nintendo RVL-CNT-01';
    const lines = [];
    const spawnImpl = () => { const c = fakeBluetoothctl(GOOD)(); const w = c.stdin.write.bind(c.stdin); c.stdin.write = d => { lines.push(String(d).trim()); return w(d); }; return c; };
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl });
    b.startPairing('wiimote');
    const job = await waitFor(b);
    delete process.env.FAKE_NAME;
    assert.strictEqual(job.phase, 'done', job.message);
    assert.match(job.message, /press 1 \+ 2/);
    assert.ok(!lines.some(l => /^(pair|trust|connect)\b/.test(l)), `unexpected commands: ${lines}`);
});

test('a failed pairing says so, and nothing is left running', async () => {
    process.env.FAKE_PAIR_FAIL = '1';
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: fakeBluetoothctl(GOOD) });
    b.startPairing('switch');
    const job = await waitFor(b);
    delete process.env.FAKE_PAIR_FAIL;
    assert.strictEqual(job.phase, 'failed');
    assert.match(job.message, /AuthenticationFailed/);
    assert.doesNotThrow(() => b.startPairing('switch') && b.cancel());
});

test('searching gives up with advice when no controller appears', async () => {
    const quiet = fakeBluetoothctl(`require('readline').createInterface({ input: process.stdin }).on('line', l => { if (l.trim() === 'quit') process.exit(0); });`);
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: quiet, scanSeconds: 0.15 });
    b.startPairing('wiimote');
    const job = await waitFor(b);
    assert.strictEqual(job.phase, 'failed');
    assert.match(job.message, /Press 1 \+ 2/);
});

test('a missing bluetoothctl is explained', async () => {
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: () => spawn('definitely-not-a-program-xyz', [], { stdio: ['pipe', 'pipe', 'pipe'] }) });
    b.startPairing('switch');
    const job = await waitFor(b);
    assert.strictEqual(job.phase, 'failed');
    assert.match(job.message, /not installed/);
});

test('status reports what is missing, and Windows is manual', async () => {
    const none = bt.createBluetooth({ platform: 'linux', execImpl: (c, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '', '') });
    const st = await none.status();
    assert.deepStrictEqual(st.problems, ['not_installed']);
    assert.ok(!st.ready);
    const ok = bt.createBluetooth({ platform: 'linux', execImpl: (c, a, o, cb) => cb(null, a[0] === 'show' ? 'Controller AA:BB:CC:DD:EE:FF (public)\n\tPowered: yes\n' : 'bluetoothctl: 5.72', '') });
    assert.ok((await ok.status()).ready);
    const win = bt.createBluetooth({ platform: 'win32' });
    assert.ok((await win.status()).manual);
    await assert.rejects(async () => win.startPairing('switch'), /Windows settings/);
});

test('forget refuses anything that is not a Bluetooth address', async () => {
    const b = bt.createBluetooth({ platform: 'linux', execImpl: (c, a, o, cb) => cb(null, '', '') });
    await assert.rejects(b.forget('--help'), /Bad address/);
    assert.ok((await b.forget('aa:bb:cc:dd:ee:ff')).ok);
});

test('real Wii Remotes take the first slots and gamepads fill the rest', () => {
    const pad = (n, i) => ({ id: `js${i}`, name: n, kind: 'xbox', pad: true, nameIndex: 0, sdlIndex: i, xinputIndex: null });
    const list = [pad('Xbox', 0)];
    const p = inputconfig.players(list, 2);
    assert.deepStrictEqual(p.wii.map(c => c.kind), ['wiimote', 'wiimote', 'xbox']);
    const roles = inputconfig.assignments(list, 2);
    assert.ok(roles.js0.includes('Wii Remote 3'));
    assert.match(roles['real-wiimote-1'].join(' '), /Wii Remote 1/);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-home-'));
    const res = inputconfig.apply('dolphin', [], { home, platform: 'linux', env: {}, wiiRemotes: 2 });
    assert.strictEqual(res.status, 'configured');
    const dir = path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');
    assert.match(fs.readFileSync(path.join(dir, 'WiimoteNew.ini'), 'utf8'), /\[Wiimote1\]\s+Source = 2/);
    assert.match(fs.readFileSync(path.join(dir, 'Dolphin.ini'), 'utf8'), /WiimoteContinuousScanning = True/);
});

test('setup installs BlueZ with one permission prompt, then switches Bluetooth on', async () => {
    let installed = false;
    const execImpl = (cmd, args, o, cb) => {
        if (cmd === 'bluetoothctl' && args[0] === '--version') return installed ? cb(null, 'bluetoothctl: 5.72', '') : cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '', '');
        if (cmd === 'bluetoothctl' && args[0] === 'show') return cb(null, 'Controller AA:BB:CC:DD:EE:FF (public)\n\tPowered: yes\n', '');
        cb(null, '', '');
    };
    const calls = [];
    const spawnImpl = (cmd, args) => {
        calls.push([cmd, ...args]);
        const { EventEmitter } = require('events');
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        setTimeout(() => { child.stdout.emit('data', 'Setting up bluez\n'); installed = true; child.emit('close', 0); }, 20);
        return child;
    };
    const b = bt.createBluetooth({ platform: 'linux', execImpl, spawnImpl, exists: p => p === '/usr/bin/apt-get' });
    await b.setup();
    const job = await waitFor(b);
    assert.strictEqual(job.phase, 'done', job.message);
    assert.strictEqual(calls.length, 1, 'a single pkexec prompt');
    assert.strictEqual(calls[0][0], 'pkexec');
    assert.match(calls[0][3], /apt-get install -y bluez.*systemctl enable --now bluetooth/);
    assert.ok(job.lines.includes('Setting up bluez'));
});

test('setup explains a cancelled password prompt and a missing adapter', async () => {
    const { EventEmitter } = require('events');
    const make = code => () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setTimeout(() => c.emit('close', code), 10); return c; };
    const noCtl = (c, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '', '');
    const b1 = bt.createBluetooth({ platform: 'linux', execImpl: noCtl, spawnImpl: make(126), exists: p => p === '/usr/bin/apt-get' });
    await b1.setup();
    assert.match((await waitFor(b1)).message, /cancelled/);

    const noAdapter = (c, a, o, cb) => cb(null, a[0] === 'show' ? 'No default controller available' : 'bluetoothctl: 5.72', '');
    const b2 = bt.createBluetooth({ platform: 'linux', execImpl: noAdapter, spawnImpl: make(0), exists: () => true });
    await b2.setup();
    assert.match((await waitFor(b2)).message, /No Bluetooth adapter/);
});
