const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const wifi = require('../ui/lib/wifi');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-'));

// A pretend /sys with an ath10k card on the PCI bus. withInterface adds the wlan0 interface it normally has.
function fakeSys({ withInterface = false, driver = 'ath10k_pci' } = {}) {
    const sys = tmp(), addr = '0000:02:00.0';
    const dev = path.join(sys, 'bus/pci/devices', addr);
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, 'class'), '0x028000\n');
    fs.writeFileSync(path.join(dev, 'vendor'), '0x168c\n');
    fs.writeFileSync(path.join(dev, 'device'), '0x003e\n');
    if (driver) {
        const drv = path.join(sys, 'bus/pci/drivers', driver);
        fs.mkdirSync(drv, { recursive: true });
        fs.mkdirSync(path.join(sys, 'module', driver), { recursive: true });
        fs.symlinkSync(path.join(sys, 'module', driver), path.join(drv, 'module'));
        fs.symlinkSync(drv, path.join(dev, 'driver'));
    }
    if (withInterface) {
        const net = path.join(sys, 'class/net/wlp2s0');
        fs.mkdirSync(path.join(net, 'wireless'), { recursive: true });
        fs.writeFileSync(path.join(net, 'operstate'), 'down\n');
        fs.symlinkSync(dev, path.join(net, 'device'));
        fs.mkdirSync(path.join(sys, 'bus/pci/subsystem'), { recursive: true });
        fs.symlinkSync(path.join(sys, 'bus/pci/subsystem'), path.join(dev, 'subsystem'));
    }
    return { sys, addr };
}

const outputs = over => (file, args, o, cb) => {
    const key = [file, ...args].join(' ');
    const table = {
        'rfkill list wifi': '0: phy0: Wireless LAN\n\tSoft blocked: no\n\tHard blocked: no\n',
        'systemctl is-active NetworkManager': 'active\n',
        'nmcli -t -f DEVICE,TYPE,STATE device': 'lo:loopback:unmanaged\n',
        ...over
    };
    const hit = Object.entries(table).find(([k]) => key.startsWith(k));
    if (file === 'journalctl') return cb(null, args.includes('-k') ? 'Oct 21 08:00:01 pc kernel: ath10k_pci 0000:02:00.0: failed to wake up device\nOct 21 08:00:02 pc kernel: usb 1-1: new device\nOct 21 08:00:03 pc kernel: ath10k_pci 0000:02:00.0: could not init core (-110)\n' : 'Oct 21 08:00:09 pc emulator-menu-wifi[1]: woke up: bringing Wi-Fi back\n');
    cb(null, hit ? hit[1] : '');
};

test('with the card on the bus but no interface, the diagnosis says the driver lost it, and shows the kernel’s complaints', async () => {
    const { sys } = fakeSys();
    const w = wifi.createWifi({ platform: 'linux', sys, execImpl: outputs({}), exists: fs.existsSync, release: '6.8.0-45-generic' });
    const d = await w.diagnose();
    assert.strictEqual(d.supported, true);
    assert.strictEqual(d.kernelRelease, '6.8.0-45-generic');
    assert.deepStrictEqual(d.adapters, []);
    assert.deepStrictEqual(d.cards.map(c => [c.address, c.driver, c.module]), [['0000:02:00.0', 'ath10k_pci', 'ath10k_pci']]);
    assert.strictEqual(d.verdict.level, 'bad');
    assert.match(d.verdict.text, /driver \(ath10k_pci\) has no Wi-Fi interface/);
    assert.strictEqual(d.kernel.length, 2, 'only the Wi-Fi lines of the kernel log');
    assert.match(d.kernel[0], /failed to wake up device/);
    assert.match(d.history[0], /woke up/);
    assert.deepStrictEqual(w.target(), { module: 'ath10k_pci', address: '0000:02:00.0', bus: 'pci' });
});

test('the diagnosis tells a missing card, a blocked radio, a stopped NetworkManager and a working connection apart', async () => {
    const none = wifi.createWifi({ platform: 'linux', sys: tmp(), execImpl: outputs({}) });
    assert.match((await none.diagnose()).verdict.text, /dropped off the bus/);
    const { sys } = fakeSys({ withInterface: true });
    const w = (over) => wifi.createWifi({ platform: 'linux', sys, execImpl: outputs(over) });
    assert.match((await w({ 'rfkill list wifi': 'Soft blocked: yes\nHard blocked: no' }).diagnose()).verdict.text, /blocked by software/);
    assert.match((await w({ 'rfkill list wifi': 'Soft blocked: no\nHard blocked: yes' }).diagnose()).verdict.text, /hardware switch/);
    assert.match((await w({ 'systemctl is-active NetworkManager': 'inactive' }).diagnose()).verdict.text, /NetworkManager is not running/);
    assert.match((await w({ 'nmcli -t -f DEVICE,TYPE,STATE device': 'wlp2s0:wifi:unavailable' }).diagnose()).verdict.text, /unavailable/);
    const ok = await w({ 'nmcli -t -f DEVICE,TYPE,STATE device': 'wlp2s0:wifi:connected' }).diagnose();
    assert.strictEqual(ok.verdict.level, 'ok');
    assert.strictEqual(ok.adapters[0].driver, 'ath10k_pci');
    assert.strictEqual((await wifi.createWifi({ platform: 'win32' }).diagnose()).supported, false);
});

// Runs the repair script against stand-in commands. `fixedBy` says what finally brings Wi-Fi back: 'rescan' (the PCI reset) or nothing.
function runRepair({ fixedBy, mod = 'ath10k_pci' }) {
    const sys = fakeSys().sys, bin = tmp(), state = tmp();
    const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('sleep', 'exit 0'); stub('logger', 'exit 0'); stub('rfkill', 'exit 0'); stub('systemctl', `echo "systemctl $*" >> "${state}/calls"`);
    stub('modprobe', `echo "modprobe $*" >> "${state}/calls"`);
    stub('nmcli', `case "$1" in radio) exit 0;; esac\nif [ "${fixedBy}" = rescan ] && [ "$(cat "${sys}/bus/pci/rescan" 2>/dev/null)" = 1 ]; then echo wifi:connected; else echo wifi:unavailable; fi`);
    const file = path.join(tmp(), 'repair.sh');
    fs.writeFileSync(file, wifi.repairScript({ sys, module: mod, address: '0000:02:00.0', bus: 'pci' }));
    const r = spawnSync('sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    return { out: r.stdout, code: r.status, calls: fs.existsSync(path.join(state, 'calls')) ? fs.readFileSync(path.join(state, 'calls'), 'utf8') : '', sys };
}

test('the repair ladder goes up one step at a time, reloading ath10k and then resetting the card on the bus', () => {
    const r = runRepair({ fixedBy: 'rescan' });
    assert.strictEqual(r.code, 0, r.out);
    const steps = r.out.split('\n').filter(l => /^Step/.test(l));
    assert.deepStrictEqual(steps.map(l => l.replace(/:.*/, '')), ['Step 1', 'Step 2', 'Step 3', 'Step 4']);
    assert.match(r.out, /Step 3: reload the driver \(ath10k_pci\)/);
    assert.match(r.out, /Wi-Fi is back \(the card was reset\)/);
    assert.match(r.calls, /modprobe -r ath10k_pci/);
    assert.match(r.calls, /modprobe -r ath10k_core/, 'the core module goes too, so the next load starts clean');
    assert.match(r.calls, /systemctl restart NetworkManager/);
    assert.strictEqual(fs.readFileSync(path.join(r.sys, 'bus/pci/devices/0000:02:00.0/remove'), 'utf8').trim(), '1');
    // it stops at the first step that works
    const easy = runRepair({ fixedBy: 'rescan' });
    assert.ok(!/Wi-Fi did not come back/.test(easy.out));
});

test('when nothing brings Wi-Fi back it says to cut the power', () => {
    const r = runRepair({ fixedBy: 'never' });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /unplug it from the wall for 30 seconds/);
});

test('the script is safe with odd names, and the sleep hook unloads before sleep and repairs after waking', () => {
    const script = wifi.repairScript({ module: 'x; rm -rf /', address: '$(id)' });
    assert.ok(!script.includes('rm -rf'), 'a name that is not a plain driver name is dropped');
    assert.match(script, /MOD=''/);
    const hook = wifi.hookScript({ module: 'ath10k_pci' });
    assert.match(hook, /pre\)[\s\S]*modprobe -r "\$MOD"[\s\S]*ath10k_core/);
    assert.match(hook, /post\)[\s\S]*wifi-repair\.sh/);
    assert.match(hook, /emulator-menu-wifi/);
    assert.match(wifi.nmConf(), /wifi\.powersave = 2/);
    for (const text of [hook, wifi.repairScript({ module: 'ath10k_pci', address: '0000:02:00.0' })]) {
        const f = path.join(tmp(), 's.sh');
        fs.writeFileSync(f, text);
        execFileSync('sh', ['-n', f]);            // valid shell
    }
});

test('repair and the sleep fix go through one password prompt each, and say what went wrong', async () => {
    const { sys } = fakeSys();
    const scripts = [];
    const spawnFor = code => (file, args) => { scripts.push(args[2]); const h = {}; setImmediate(() => h.close(code)); return { stdout: { on() {} }, stderr: { on() {} }, on: (e, f) => { h[e] = f; } }; };
    const w = code => wifi.createWifi({ platform: 'linux', sys, execImpl: outputs({}), spawnImpl: spawnFor(code), tmpdir: tmp() });
    assert.deepStrictEqual(await w(0).repair({}), { ok: true });
    await assert.rejects(w(126).repair({}), /cancelled/);
    await assert.rejects(w(1).repair({}), /unplug it for 30 seconds/);
    await w(0).setSleepFix(true, {});
    const install = scripts[scripts.length - 1];
    for (const f of [wifi.HOOK_FILE, wifi.REPAIR_FILE, wifi.NM_CONF]) assert.ok(install.includes(f), f);
    await w(0).setSleepFix(false, {});
    assert.match(scripts[scripts.length - 1], /^rm -f /);
    // with no card visible there is nothing to look after
    const blind = wifi.createWifi({ platform: 'linux', sys: tmp(), spawnImpl: spawnFor(0) });
    await assert.rejects(blind.setSleepFix(true, {}), /cannot see the Wi-Fi card/);
    await assert.rejects(wifi.createWifi({ platform: 'win32' }).repair({}), /Linux/);
});
