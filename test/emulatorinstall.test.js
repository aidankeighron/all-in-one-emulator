const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const installer = require('../ui/lib/emulatorinstall');
const { createRunner } = require('../ui/lib/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));

function zipOf(files) {
    return new Promise(resolve => {
        const z = new yazl.ZipFile();
        for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name);
        z.end();
        const parts = [];
        z.outputStream.on('data', d => parts.push(d)).on('end', () => resolve(Buffer.concat(parts)));
    });
}

// A pretend release server: url -> {status, json} or {status, body}
const server = routes => async url => {
    const hit = routes[url];
    if (!hit) throw Object.assign(new Error('connect ETIMEDOUT'), { name: 'TimeoutError' });
    if (hit.body) return new Response(hit.body, { status: hit.status || 200, headers: { 'content-length': String(hit.body.length) } });
    return new Response(JSON.stringify(hit.json), { status: hit.status || 200 });
};

const ryujinx = {
    id: 'ryujinx', name: 'Ryujinx',
    windows: {
        exe: 'Ryujinx.exe',
        release: [
            { api: 'https://forge.test/api/releases/latest', asset: 'win.*x64.*\\.zip$' },
            { query: 'https://update.test/query' }
        ]
    }
};

test('installs from the first source that works, unpacking into the emulators folder', async () => {
    const emulatorsDir = tmp();
    const zip = await zipOf({ 'publish/Ryujinx.exe': 'exe', 'publish/data/x.bin': 'x' });
    const fetchImpl = server({
        'https://forge.test/api/releases/latest': { json: { tag_name: '1.3.3', assets: [{ name: 'ryujinx-1.3.3-linux_x64.tar.gz', browser_download_url: 'https://dl.test/linux' }, { name: 'ryujinx-1.3.3-win_x64.zip', browser_download_url: 'https://dl.test/win.zip' }] } },
        'https://dl.test/win.zip': { body: zip }
    });
    const lines = [];
    const code = await installer.install(ryujinx, { emulatorsDir, fetchImpl, onLine: l => lines.push(l), findExe: d => fs.existsSync(path.join(d, 'publish/Ryujinx.exe')) });
    assert.strictEqual(code, 0, lines.join('\n'));
    assert.ok(fs.existsSync(path.join(emulatorsDir, 'ryujinx/publish/Ryujinx.exe')));
    assert.ok(lines.some(l => /1\.3\.3/.test(l)));
    assert.deepStrictEqual(fs.readdirSync(emulatorsDir), ['ryujinx'], 'no temporary files are left behind');
});

test('falls back to the next source when the first one is down', async () => {
    const emulatorsDir = tmp();
    const zip = await zipOf({ 'Ryujinx.exe': 'exe' });
    const fetchImpl = server({
        'https://update.test/query': { json: { stable: { link: 'https://dl.test/Ryujinx-win_x64.zip' } } },
        'https://dl.test/Ryujinx-win_x64.zip': { body: zip }
    });
    const code = await installer.install(ryujinx, { emulatorsDir, fetchImpl, findExe: d => fs.existsSync(path.join(d, 'Ryujinx.exe')) });
    assert.strictEqual(code, 0);
    assert.ok(fs.existsSync(path.join(emulatorsDir, 'ryujinx/Ryujinx.exe')));
});

test('when every source fails, says why for each and how to do it by hand', async () => {
    const emulatorsDir = tmp();
    const lines = [];
    const code = await installer.install(ryujinx, { emulatorsDir, fetchImpl: server({}), onLine: l => lines.push(l) });
    assert.strictEqual(code, 1);
    const last = lines[lines.length - 1];
    assert.match(last, /forge\.test did not answer in time/);
    assert.match(last, /update\.test did not answer in time/);
    assert.match(last, /Locate/);
});

test('a zip address from config.json is used first', async () => {
    const emulatorsDir = tmp();
    const zip = await zipOf({ 'Ryujinx.exe': 'exe' });
    const code = await installer.install(ryujinx, { emulatorsDir, override: 'https://mine.test/r.zip', fetchImpl: server({ 'https://mine.test/r.zip': { body: zip } }) });
    assert.strictEqual(code, 0);
});

test('a zip cannot write outside the emulators folder, and a download without the program is refused', async () => {
    const emulatorsDir = tmp();
    const evil = await zipOf({ 'aa/escape.txt': 'no', 'Other.exe': 'x' });
    // yazl will not write a ".." name, so the name is changed in the bytes (same length)
    for (let i = evil.indexOf('aa/escape.txt'); i >= 0; i = evil.indexOf('aa/escape.txt', i + 1)) evil.write('../escape.txt', i);
    const code = await installer.install(ryujinx, { emulatorsDir, override: 'https://mine.test/r.zip', fetchImpl: server({ 'https://mine.test/r.zip': { body: evil } }), findExe: d => fs.existsSync(path.join(d, 'Ryujinx.exe')) });
    assert.strictEqual(code, 1);
    assert.ok(!fs.existsSync(path.join(emulatorsDir, '..', 'escape.txt')));
    assert.ok(!fs.existsSync(path.join(emulatorsDir, 'ryujinx')), 'nothing half-installed is kept');
});

test('on Windows the runner offers Install for emulators with sources and finds the result', async () => {
    const emulatorsDir = tmp();
    const runner = createRunner({ platform: 'win32', emulatorsDir, getUrls: () => ({}) });
    assert.strictEqual(runner.canInstall(ryujinx), true);
    assert.strictEqual(runner.canInstall({ id: 'x', windows: { exe: 'x.exe' } }), false);
    fs.mkdirSync(path.join(emulatorsDir, 'ryujinx/publish'), { recursive: true });
    fs.writeFileSync(path.join(emulatorsDir, 'ryujinx/publish/Ryujinx.exe'), 'x');
    assert.strictEqual(await runner.isInstalled(ryujinx), true);
    assert.strictEqual(runner.menuInstalled(ryujinx), true);
    await runner.uninstall(ryujinx, () => {});
    assert.strictEqual(await runner.isInstalled(ryujinx), false);
});
