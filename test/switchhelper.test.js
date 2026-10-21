const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const betterjoy = require('../ui/lib/betterjoy');
const joycond = require('../ui/lib/joycond');
const controllers = require('../ui/lib/controllers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'helper-'));
const zipOf = files => new Promise(resolve => {
    const z = new yazl.ZipFile();
    for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name);
    z.end();
    const parts = [];
    z.outputStream.on('data', d => parts.push(d)).on('end', () => resolve(Buffer.concat(parts)));
});
const releaseServer = routes => async url => {
    const hit = routes[url];
    if (!hit) throw Object.assign(new Error('offline'), { name: 'TimeoutError' });
    if (hit.body) return new Response(hit.body, { status: 200, headers: { 'content-length': String(hit.body.length) } });
    return new Response(JSON.stringify(hit.json), { status: 200 });
};

// ---------- BetterJoy (Windows) ----------

test('BetterJoy settings are written only where the file already has the key, in XML or JSON', () => {
    const xml = '<appSettings><add key="ShowAsXInput" value="false"/><add key="ShowAsDS4" value="true"/><add key="Other" value="x"/></appSettings>';
    const a = betterjoy.applySettings(xml);
    assert.match(a.text, /key="ShowAsXInput" value="true"/);
    assert.match(a.text, /key="ShowAsDS4" value="false"/);
    assert.match(a.text, /key="Other" value="x"/);
    assert.deepStrictEqual(a.changed.sort(), ['ShowAsDS4', 'ShowAsXInput']);
    const json = betterjoy.applySettings('{ "MotionServer": false, "Keep": 1 }');
    assert.strictEqual(json.text, '{ "MotionServer": true, "Keep": 1 }');
    assert.deepStrictEqual(betterjoy.applySettings('nothing here').changed, []);
});

test('BetterJoy: the driver is installed through one permission prompt, then BetterJoy is downloaded and started', async () => {
    const emulatorsDir = tmp(), systemRoot = tmp();
    const calls = [];
    const driverFile = path.join(systemRoot, 'System32', 'drivers', 'ViGEmBus.sys');
    const execImpl = (file, args, opts, cb) => {
        calls.push([file, args.join(' ')]);
        if (file === 'powershell.exe') { fs.mkdirSync(path.dirname(driverFile), { recursive: true }); fs.writeFileSync(driverFile, 'sys'); return cb(null, ''); }
        if (file === 'tasklist') return cb(null, calls.some(c => c[0] === 'spawn') ? 'BetterJoyForCemu.exe 1234' : 'INFO: No tasks');
        cb(null, '');
    };
    const spawnImpl = (exe, args, opts) => { calls.push(['spawn', exe]); return { on() {}, unref() {} }; };
    const zip = await zipOf({ 'BetterJoy/BetterJoyForCemu.exe': 'exe', 'BetterJoy/BetterJoyForCemu.exe.config': '<add key="ShowAsXInput" value="false"/>' });
    const fetchImpl = releaseServer({
        'https://api.github.com/repos/nefarius/ViGEmBus/releases/latest': { json: { tag_name: 'v1.22', assets: [{ name: 'ViGEmBus_1.22_x64.exe', browser_download_url: 'https://dl.test/vigem.exe' }] } },
        'https://dl.test/vigem.exe': { body: Buffer.from('installer') },
        'https://api.github.com/repos/Davidobot/BetterJoy/releases/latest': { json: { tag_name: 'v7.0', assets: [{ name: 'BetterJoy_v7.0.zip', browser_download_url: 'https://dl.test/bj.zip' }] } },
        'https://dl.test/bj.zip': { body: zip }
    });
    const bj = betterjoy.createBetterJoy({ platform: 'win32', emulatorsDir, env: { SystemRoot: systemRoot }, fetchImpl, execImpl, spawnImpl });
    assert.deepStrictEqual({ ...(await bj.status()), dir: 0 }, { supported: true, driver: false, installed: false, running: false, motionPort: 26760, dir: 0 });

    const lines = [];
    const d = await bj.installDriver({ onLine: l => lines.push(l) });
    assert.strictEqual(d.ok, true, lines.join('\n'));
    const ps = calls.find(c => c[0] === 'powershell.exe');
    assert.match(ps[1], /-Verb RunAs/, 'the installer runs through the Windows permission prompt');
    assert.ok(bj.driverInstalled());

    await bj.install({ onLine: l => lines.push(l) });
    assert.ok(bj.installed());
    assert.match(fs.readFileSync(path.join(emulatorsDir, 'betterjoy/BetterJoy/BetterJoyForCemu.exe.config'), 'utf8'), /ShowAsXInput" value="true"/);
    assert.deepStrictEqual(fs.readdirSync(emulatorsDir), ['betterjoy'], 'no temporary files are left behind');

    assert.deepStrictEqual(await bj.start(), { started: true });
    assert.ok(calls.some(c => c[0] === 'spawn' && /BetterJoyForCemu\.exe$/.test(c[1])));
    assert.deepStrictEqual(await bj.start(), { started: false }, 'it is not started twice');
    await bj.uninstall();
    assert.ok(!bj.installed());
    assert.ok(calls.some(c => c[0] === 'taskkill'));
});

test('BetterJoy: a refused permission prompt, a missing driver and a zip without the program are explained', async () => {
    const systemRoot = tmp();
    const fetchImpl = releaseServer({
        'https://api.github.com/repos/nefarius/ViGEmBus/releases/latest': { json: { assets: [{ name: 'v.exe', browser_download_url: 'https://dl.test/v.exe' }] } },
        'https://dl.test/v.exe': { body: Buffer.from('x') },
        'https://api.github.com/repos/Davidobot/BetterJoy/releases/latest': { json: { assets: [{ name: 'x.zip', browser_download_url: 'https://dl.test/x.zip' }] } },
        'https://dl.test/x.zip': { body: await zipOf({ 'readme.txt': 'nothing' }) }
    });
    const refused = betterjoy.createBetterJoy({ platform: 'win32', emulatorsDir: tmp(), env: { SystemRoot: systemRoot }, fetchImpl, execImpl: (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 1223 }), '') });
    await assert.rejects(refused.installDriver(), /permission/);
    const silent = betterjoy.createBetterJoy({ platform: 'win32', emulatorsDir: tmp(), env: { SystemRoot: systemRoot }, fetchImpl, execImpl: (f, a, o, cb) => cb(null, '') });
    await assert.rejects(silent.installDriver(), /without installing/);
    const restart = betterjoy.createBetterJoy({ platform: 'win32', emulatorsDir: tmp(), env: { SystemRoot: systemRoot }, fetchImpl, execImpl: (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 3010 }), '') });
    await assert.rejects(restart.installDriver(), /restart/);
    await assert.rejects(silent.install(), /did not contain/);
    await assert.rejects(silent.start(), /not installed/);
    const linux = betterjoy.createBetterJoy({ platform: 'linux', emulatorsDir: tmp() });
    assert.strictEqual((await linux.status()).supported, false);
    await assert.rejects(linux.install(), /only for Windows/);
});

test('with BetterJoy running, the real Switch controllers are left out and its Xbox pads are used', () => {
    const real = (name, product) => ({ index: product === '2006' ? 0 : 1, id: `${name} (STANDARD GAMEPAD Vendor: 057e Product: ${product})`, mapping: 'standard' });
    const xinput = { index: 2, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping: 'standard' };
    controllers.report([real('Joy-Con (L)', '2006'), real('Joy-Con (R)', '2007'), xinput]);
    assert.strictEqual(controllers.detect({ platform: 'win32', merge: { auto: false } }).length, 3);
    const hidden = controllers.detect({ platform: 'win32', merge: { auto: true }, hideNintendo: true });
    assert.deepStrictEqual(hidden.map(c => c.kind), ['xbox']);
});

// ---------- joycond (Linux) ----------

test('joycond: needs a new enough kernel, is installed from the packages with one password prompt, and started as a service', async () => {
    const calls = [];
    let installed = false, active = false;
    const exists = p => (p === '/usr/bin/apt-get') || (installed && p === '/usr/sbin/joycond');
    const spawnImpl = (file, args) => {
        calls.push(args.join(' '));
        const handlers = {};
        const child = { stdout: { on() {} }, stderr: { on() {} }, on: (e, f) => { handlers[e] = f; } };
        setImmediate(() => {
            if (/apt-get install -y joycond/.test(args.join(' '))) installed = true;
            if (/systemctl enable --now joycond/.test(args.join(' '))) active = true;
            handlers.close(0);
        });
        return child;
    };
    const execImpl = (file, args, o, cb) => cb(active ? null : new Error('inactive'), active ? 'active\n' : 'inactive\n');
    const jc = joycond.createJoycond({ platform: 'linux', exists, spawnImpl, execImpl, release: '6.8.0-generic' });
    assert.deepStrictEqual(await jc.status(), { supported: true, driver: true, installed: false, running: false });
    await jc.install({});
    assert.ok(jc.installed());
    assert.ok(calls.some(c => /apt-get install -y joycond/.test(c)));
    assert.deepStrictEqual(await jc.start({}), { started: true });
    assert.strictEqual((await jc.status()).running, true);
    await jc.stop({});
    assert.ok(calls.some(c => /disable --now joycond/.test(c)));
});

test('joycond: failures say what to do', async () => {
    const old = joycond.createJoycond({ platform: 'linux', release: '5.4.0', exists: () => false });
    await assert.rejects(old.installDriver(), /older than 5\.16/);
    const noPackages = joycond.createJoycond({ platform: 'linux', release: '6.8.0', exists: () => false });
    await assert.rejects(noPackages.install({}), /Build it yourself/);
    const declined = joycond.createJoycond({ platform: 'linux', release: '6.8.0', exists: p => p === '/usr/bin/apt-get', spawnImpl: () => { const h = {}; setImmediate(() => h.close(126)); return { stdout: { on() {} }, stderr: { on() {} }, on: (e, f) => { h[e] = f; } }; } });
    await assert.rejects(declined.install({}), /cancelled/);
    const pacman = joycond.createJoycond({ platform: 'linux', release: '6.8.0', exists: p => p === '/usr/bin/pacman' });
    await assert.rejects(pacman.install({}), /Build it yourself/);
    assert.strictEqual(joycond.createJoycond({ platform: 'win32' }).supported, false);
    assert.ok(joycond.kernelAtLeast('5.16.0', 5, 16) && !joycond.kernelAtLeast('5.15.9', 5, 16) && joycond.kernelAtLeast('6.1', 5, 16));
});

test('Linux: joycond’s combined controller replaces the two halves it joined', () => {
    const dev = (name, product, js) => `I: Bus=0005 Vendor=057e Product=${product} Version=0001\nN: Name="${name}"\nP: Phys=\nS: Sysfs=/x\nU: Uniq=\nH: Handlers=event${js + 10} js${js}\nB: PROP=0\n`;
    const proc = [dev('Nintendo Switch Left Joy-Con', '2006', 0), dev('Nintendo Switch Right Joy-Con', '2007', 1), dev('Nintendo Switch Combined Joy-Cons', '2008', 2)].join('\n');
    const list = controllers.build(controllers.parseProc(proc));
    assert.deepStrictEqual(list.map(c => c.name), ['Nintendo Switch Combined Joy-Cons']);
    assert.strictEqual(list[0].kind, 'switch');
    // another Joy-Con pair that was not joined stays as it is
    const more = proc + '\n' + dev('Nintendo Switch Left Joy-Con', '2006', 3);
    assert.strictEqual(controllers.build(controllers.parseProc(more)).length, 2);
});
