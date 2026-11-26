const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

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
