const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `srvlib-${p}-`));
const home = tmp('home'), cfgHome = tmp('cfg'), roms = tmp('roms'), theirRoms = tmp('theirs');
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = cfgHome;
process.env.ROMS_DIR = roms;
fs.mkdirSync(path.join(roms, 'wii'), { recursive: true });
fs.writeFileSync(path.join(roms, 'wii', 'Wii Sports.iso'), 'mine');

const library = require('../ui/lib/library');
const manifest = require('../emulators.json');
const server = require('../ui/server');

const bigGame = crypto.randomBytes(2 * 1024 * 1024);
fs.mkdirSync(path.join(theirRoms, 'switch'), { recursive: true });
fs.mkdirSync(path.join(theirRoms, 'wii'), { recursive: true });
fs.writeFileSync(path.join(theirRoms, 'switch', 'Super Mario Odyssey.nsp'), bigGame);
fs.writeFileSync(path.join(theirRoms, 'wii', 'Wii Sports.iso'), 'theirs');     // also on this computer
fs.writeFileSync(path.join(theirRoms, 'wii', 'Mario Kart Wii.iso'), 'kart');

async function api(port, method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}

test('games on the other computer show up as downloadable, and downloading one installs it', async () => {
    const KEY = 'host-key';
    const theirShare = library.createShareServer({ getKey: () => KEY, getRomsDir: () => theirRoms, manifest, name: () => 'Living Room PC' });
    const theirPort = await theirShare.start(0);
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'GET', '/api/games');
        assert.deepStrictEqual(r.body.games.map(g => g.title), ['Wii Sports'], 'nothing remote before it is set up');

        r = await api(port, 'POST', '/api/library/settings', { remote: { address: `127.0.0.1:${theirPort}`, key: 'wrong' } });
        assert.strictEqual(r.body.remote.error.code, 'BAD_KEY');
        r = await api(port, 'POST', '/api/library/test');
        assert.strictEqual(r.body.ok, false);

        r = await api(port, 'POST', '/api/library/settings', { remote: { address: `127.0.0.1:${theirPort}`, key: KEY } });
        assert.deepStrictEqual([r.body.remote.name, r.body.remote.games, r.body.remote.hasKey], ['Living Room PC', 3, true]);
        assert.ok(!('key' in r.body.remote) && !JSON.stringify(r.body.remote).includes(KEY), 'the access key typed for the other computer is never sent back to the page');

        r = await api(port, 'GET', '/api/games');
        const byTitle = Object.fromEntries(r.body.games.map(g => [g.title, g]));
        assert.deepStrictEqual(Object.keys(byTitle).sort(), ['Mario Kart Wii', 'Super Mario Odyssey', 'Wii Sports']);
        assert.ok(byTitle['Super Mario Odyssey'].remote && byTitle['Mario Kart Wii'].remote);
        assert.ok(!byTitle['Wii Sports'].remote, 'a game already here is just a game');
        assert.strictEqual(r.body.server.name, 'Living Room PC');

        // download
        r = await api(port, 'POST', '/api/library/download', { path: 'switch/Super Mario Odyssey.nsp' });
        assert.strictEqual(r.status, 200);
        let snap = r.body.download;
        for (let i = 0; i < 100 && snap.state === 'running'; i++) {
            await new Promise(res => setTimeout(res, 50));
            snap = (await api(port, 'GET', '/api/library/download')).body.download;
        }
        assert.strictEqual(snap.state, 'done');
        assert.ok(fs.readFileSync(path.join(roms, 'switch', 'Super Mario Odyssey.nsp')).equals(bigGame));

        r = await api(port, 'GET', '/api/games');
        assert.ok(!r.body.games.find(g => g.title === 'Super Mario Odyssey').remote, 'now it is installed');

        r = await api(port, 'POST', '/api/library/download', { path: 'switch/Super Mario Odyssey.nsp' });
        assert.strictEqual(r.status, 409, 'already here');
        r = await api(port, 'POST', '/api/library/download', { path: '../../etc/passwd' });
        assert.strictEqual(r.status, 404, 'only games the server lists');

        // the host goes away: the list still shows what was last seen, flagged as offline
        await theirShare.stop();
        await api(port, 'POST', '/api/library/test');
        r = await api(port, 'GET', '/api/games');
        assert.ok(r.body.games.find(g => g.title === 'Mario Kart Wii'), 'last known list is kept');
    } finally {
        srv.close();
        await theirShare.stop();
    }
});

test('sharing this computer: turning it on makes a key and a server, turning it off stops it', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'POST', '/api/library/settings', { sharing: { enabled: true, port: 18765 } });
        assert.strictEqual(r.body.sharing.running, true);
        assert.match(r.body.sharing.key, /^[0-9a-f]{48}$/);
        assert.ok(r.body.sharing.addresses.every(a => a.endsWith(':18765')));

        const index = await library.fetchIndex({ address: '127.0.0.1:18765', key: r.body.sharing.key, manifest });
        assert.ok(index.games.some(g => g.title === 'Wii Sports'));
        const keep = r.body.sharing.key;

        r = await api(port, 'POST', '/api/library/settings', { sharing: { newKey: true } });
        assert.notStrictEqual(r.body.sharing.key, keep);
        await assert.rejects(library.fetchIndex({ address: '127.0.0.1:18765', key: keep, manifest }), { code: 'BAD_KEY' });

        r = await api(port, 'POST', '/api/library/settings', { sharing: { enabled: false } });
        assert.strictEqual(r.body.sharing.running, false);
        await assert.rejects(library.fetchIndex({ address: '127.0.0.1:18765', key: r.body.sharing.key, manifest, timeoutMs: 1000 }), { code: 'UNREACHABLE' });
    } finally {
        srv.close();
    }
});
