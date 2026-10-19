const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const library = require('../ui/lib/library');
const manifest = require('../emulators.json');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `lib-${p}-`));
const KEY = 'secret-key';
const big = crypto.randomBytes(3 * 1024 * 1024);

// A host computer with a few games, sharing on a free port
async function host() {
    const romsDir = tmp('host');
    fs.mkdirSync(path.join(romsDir, 'switch'));
    fs.mkdirSync(path.join(romsDir, 'wii'));
    fs.writeFileSync(path.join(romsDir, 'switch', 'Super Mario Odyssey.nsp'), big);
    fs.writeFileSync(path.join(romsDir, 'wii', 'Wii Sports.iso'), 'small game');
    fs.writeFileSync(path.join(romsDir, 'wii', 'notes.txt'), 'not a game');
    fs.writeFileSync(path.join(romsDir, 'secret.txt'), 'outside any system folder');
    const share = library.createShareServer({ getKey: () => KEY, getRomsDir: () => romsDir, manifest, name: () => 'Desk PC' });
    const port = await share.start(0);
    return { romsDir, share, port, address: `127.0.0.1:${port}` };
}

test('the index lists the host\'s games and needs the key', async () => {
    const h = await host();
    try {
        const index = await library.fetchIndex({ address: h.address, key: KEY, manifest });
        assert.strictEqual(index.name, 'Desk PC');
        assert.deepStrictEqual(index.games.map(g => [g.title, g.console, g.size]).sort(), [['Super Mario Odyssey', 'switch', big.length], ['Wii Sports', 'wii', 10]]);
        assert.ok(index.games.every(g => g.emulator && g.id));

        await assert.rejects(library.fetchIndex({ address: h.address, key: 'wrong', manifest }), { code: 'BAD_KEY' });
        await assert.rejects(library.fetchIndex({ address: h.address, key: '', manifest }), { code: 'BAD_KEY' });
        assert.strictEqual((await fetch(`http://${h.address}/library/index.json`)).status, 401);
        assert.strictEqual((await fetch(`http://${h.address}/`)).status, 404, 'nothing but /library/ is served');
    } finally { await h.share.stop(); }
});

test('only listed games can be fetched, never other files or paths outside the library', async () => {
    const h = await host();
    const get = p => fetch(`http://${h.address}/library/files/${p}`, { headers: { Authorization: `Bearer ${KEY}` } });
    try {
        assert.strictEqual((await get(encodeURIComponent('wii/Wii Sports.iso'))).status, 200);
        for (const bad of ['wii/notes.txt', 'secret.txt', '..%2Fsecret.txt', 'wii%2F..%2Fsecret.txt', '%2Fetc%2Fpasswd', 'wii/missing.iso', '%00', 'switch%5C..%5Csecret.txt']) {
            const r = await get(bad);
            assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
        }
        const part = await fetch(`http://${h.address}/library/files/${encodeURIComponent('wii/Wii Sports.iso')}`, { headers: { Authorization: `Bearer ${KEY}`, Range: 'bytes=2-5' } });
        assert.strictEqual(part.status, 206);
        assert.strictEqual(await part.text(), 'all ');
        assert.strictEqual((await fetch(`http://${h.address}/library/files/x`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } })).status, 405);
    } finally { await h.share.stop(); }
});

test('downloading a game puts it in the right folder, with progress, and leaves no partial file', async () => {
    const h = await host();
    const mine = tmp('client');
    try {
        const { games } = await library.fetchIndex({ address: h.address, key: KEY, manifest });
        const game = games.find(g => g.title === 'Super Mario Odyssey');
        const seen = [];
        const dest = await library.downloadGame({ address: h.address, key: KEY, game, romsDir: mine, manifest, onProgress: p => seen.push(p) });
        assert.strictEqual(dest, path.join(mine, 'switch', 'Super Mario Odyssey.nsp'));
        assert.ok(fs.readFileSync(dest).equals(big));
        assert.ok(!fs.existsSync(`${dest}.part`));
        assert.ok(seen.length > 1 && seen.at(-1).received === big.length && seen.every(p => p.total === big.length));
        await assert.rejects(library.downloadGame({ address: h.address, key: KEY, game, romsDir: mine, manifest }), { code: 'EXISTS' });
    } finally { await h.share.stop(); }
});

test('an interrupted download resumes where it stopped', async () => {
    const h = await host();
    const mine = tmp('resume');
    try {
        const { games } = await library.fetchIndex({ address: h.address, key: KEY, manifest });
        const game = games.find(g => g.title === 'Super Mario Odyssey');
        const dest = path.join(mine, 'switch', 'Super Mario Odyssey.nsp');
        fs.mkdirSync(path.dirname(dest));
        fs.writeFileSync(`${dest}.part`, big.subarray(0, 1024 * 1024));

        const ranges = [];
        const fetchImpl = (url, opts) => { ranges.push(opts.headers.Range); return fetch(url, opts); };
        await library.downloadGame({ address: h.address, key: KEY, game, romsDir: mine, manifest, fetchImpl });
        assert.deepStrictEqual(ranges, [`bytes=${1024 * 1024}-`], 'asked only for the missing part');
        assert.ok(fs.readFileSync(dest).equals(big));
    } finally { await h.share.stop(); }
});

test('cancelling keeps the partial file so a later download continues', async () => {
    const h = await host();
    const mine = tmp('cancel');
    try {
        const { games } = await library.fetchIndex({ address: h.address, key: KEY, manifest });
        const game = games.find(g => g.title === 'Super Mario Odyssey');
        const ctl = new AbortController();
        await assert.rejects(
            library.downloadGame({ address: h.address, key: KEY, game, romsDir: mine, manifest, signal: ctl.signal, onProgress: () => ctl.abort() }),
            { code: 'CANCELLED' }
        );
        const partial = path.join(mine, 'switch', 'Super Mario Odyssey.nsp.part');
        assert.ok(fs.existsSync(partial) && !fs.existsSync(partial.replace('.part', '')));
        await library.downloadGame({ address: h.address, key: KEY, game, romsDir: mine, manifest });
        assert.ok(fs.readFileSync(partial.replace('.part', '')).equals(big));
    } finally { await h.share.stop(); }
});

test('a hostile or broken server cannot make the client write outside the library', async () => {
    const evil = { name: 'x', games: [
        { id: 'a', title: 'ok', console: 'wii', path: 'wii/ok.iso', size: 5 },
        { id: 'b', title: 'up', console: 'wii', path: '../../.bashrc', size: 5 },
        { id: 'c', title: 'deep', console: 'wii', path: 'wii/sub/x.iso', size: 5 },
        { id: 'd', title: 'abs', console: 'wii', path: '/etc/passwd', size: 5 },
        { id: 'e', title: 'wrong ext', console: 'wii', path: 'wii/run.sh', size: 5 },
        { id: 'f', title: 'unknown folder', console: 'x', path: 'bin/x.iso', size: 5 },
        { id: 'g', title: 'hidden', console: 'wii', path: 'wii/.x.iso', size: 5 },
        { id: 'h', title: 'no size', console: 'wii', path: 'wii/n.iso' }
    ] };
    const fetchImpl = async () => ({ status: 200, ok: true, json: async () => evil });
    const index = await library.fetchIndex({ address: 'host', key: 'k', manifest, fetchImpl });
    assert.deepStrictEqual(index.games.map(g => g.path), ['wii/ok.iso']);
    await assert.rejects(library.downloadGame({ address: 'host', key: 'k', game: { path: '../x.iso', size: 1 }, romsDir: tmp('x'), manifest }), { code: 'BAD_PATH' });
});

test('addresses are tidied up and failures are explained', async () => {
    assert.strictEqual(library.baseUrl('192.168.1.20'), 'http://192.168.1.20:8765');
    assert.strictEqual(library.baseUrl('pc.tailnet.ts.net:9000'), 'http://pc.tailnet.ts.net:9000');
    assert.strictEqual(library.baseUrl(' http://10.0.0.5:1234/ '), 'http://10.0.0.5:1234');
    assert.throws(() => library.baseUrl(''), { code: 'NO_ADDRESS' });
    await assert.rejects(library.fetchIndex({ address: '127.0.0.1:1', key: 'k', manifest, timeoutMs: 1500 }), { code: 'UNREACHABLE' });
});

test('the share server refuses to start on a busy port and stops cleanly', async () => {
    const a = await host();
    try {
        const second = library.createShareServer({ getKey: () => KEY, getRomsDir: () => a.romsDir, manifest });
        await assert.rejects(second.start(a.port), { code: 'PORT_BUSY' });
    } finally { await a.share.stop(); }
    assert.strictEqual(a.share.running(), false);
});
