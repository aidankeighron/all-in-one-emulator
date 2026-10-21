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

// BlueZ remembers controllers from an earlier scan and then announces them only as property changes, never "[NEW]"
const KNOWN = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  const [cmd, addr] = l.trim().split(' ');
  if (cmd === 'devices') console.log('Device AA:BB:CC:DD:EE:FF Joy-Con (L)');
  if (cmd === 'scan' && addr === 'on') setTimeout(() => console.log('[CHG] Device AA:BB:CC:DD:EE:FF RSSI: -60'), 60);
  if (cmd === 'pair') setTimeout(() => console.log('Pairing successful'), 20);
  if (cmd === 'trust') console.log('Changing ' + addr + ' trust succeeded');
  if (cmd === 'connect') setTimeout(() => console.log('Connection successful'), 20);
  if (cmd === 'quit') process.exit(0);
});`;

test('a Joy-Con BlueZ already knows is found when it starts advertising again', async () => {
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: fakeBluetoothctl(KNOWN) });
    b.startPairing('switch');
    const job = await waitFor(b);
    assert.strictEqual(job.phase, 'done', job.message);
    assert.match(job.message, /Joy-Con \(L\) connected/);
});

// A controller added from the system's Bluetooth settings is already there and says nothing more: `info` shows it is in range
const LISTED = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  const [cmd, addr] = l.trim().split(' ');
  if (cmd === 'devices') console.log('Device AA:BB:CC:DD:EE:FF Joy-Con (R)\\nDevice 11:22:33:44:55:66 Keyboard');
  if (cmd === 'info') console.log('Device ' + addr + ' (public)\\n\\tName: Joy-Con (R)\\n\\tPaired: no\\n\\tRSSI: -55');
  if (cmd === 'pair') setTimeout(() => console.log('Pairing successful'), 20);
  if (cmd === 'trust') console.log('Changing ' + addr + ' trust succeeded');
  if (cmd === 'connect') setTimeout(() => console.log('Connection successful'), 20);
  if (cmd === 'quit') process.exit(0);
});`;

test('a Joy-Con that is already listed and in range is found without any new event', async () => {
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: fakeBluetoothctl(LISTED) });
    b.startPairing('switch');
    const job = await waitFor(b);
    assert.strictEqual(job.phase, 'done', job.message);
    assert.match(job.message, /Joy-Con \(R\) connected/);
});

// Lines that arrive while bluetoothctl waits for a command carry its prompt in front
const PROMPTED = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  const [cmd, addr] = l.trim().split(' ');
  if (cmd === 'scan' && addr === 'on') setTimeout(() => console.log('[bluetooth]# \\x1b[0;92m[NEW]\\x1b[0m Device AA:BB:CC:DD:EE:FF Joy-Con (L)'), 40);
  if (cmd === 'pair') setTimeout(() => console.log('[bluetooth]# [bluetooth]# Pairing successful'), 20);
  if (cmd === 'trust') console.log('[Joy-Con (L)]# Changing ' + addr + ' trust succeeded');
  if (cmd === 'connect') setTimeout(() => console.log('[Joy-Con (L)]# Connection successful'), 20);
  if (cmd === 'quit') process.exit(0);
});`;

test('lines with the bluetoothctl prompt in front are still understood', async () => {
    const b = bt.createBluetooth({ platform: 'linux', spawnImpl: fakeBluetoothctl(PROMPTED) });
    b.startPairing('switch');
    const job = await waitFor(b);
    assert.strictEqual(job.phase, 'done', job.message);
    assert.match(job.message, /Joy-Con \(L\) connected/);
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

test('real Wii Remotes take the first players and gamepads fill the rest', () => {
    const pad = (n, i) => ({ id: `js${i}`, name: n, kind: 'xbox', pad: true, nameIndex: 0, sdlIndex: i, xinputIndex: null });
    const list = [pad('Xbox', 0)];
    const view = inputconfig.describe(list, { wiiRemotes: 2 });
    assert.deepStrictEqual(view.slots.map(s => s.mode), ['real', 'real', 'pad', 'empty']);
    assert.strictEqual(view.roles.js0[0], 'Player 3');
    assert.match(view.waiting[0].roles.join(' '), /Player 1/);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-home-'));
    const res = inputconfig.apply('dolphin', [], { home, platform: 'linux', env: {}, wiiRemotes: 2 });
    assert.strictEqual(res.status, 'configured');
    const dir = path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');
    assert.match(fs.readFileSync(path.join(dir, 'WiimoteNew.ini'), 'utf8'), /\[Wiimote1\]\s+Source = 2/);
    assert.match(fs.readFileSync(path.join(dir, 'Dolphin.ini'), 'utf8'), /WiimoteContinuousScanning = True/);
});
