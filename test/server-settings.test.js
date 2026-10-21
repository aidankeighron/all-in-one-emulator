const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `srv-${p}-`));
const home = tmp('home');
const cfgHome = tmp('cfg');
const roms = tmp('roms');
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = cfgHome;
process.env.ROMS_DIR = roms;
fs.mkdirSync(path.join(roms, 'wii'), { recursive: true });
for (const n of ['Alpha', 'Bravo', 'Charlie']) fs.writeFileSync(path.join(roms, 'wii', `${n}.iso`), 'x');

const server = require('../ui/server');

async function api(port, method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}

test('favourite games are listed first, kept between runs, and can be removed', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'GET', '/api/games');
        assert.deepStrictEqual(r.body.games.map(g => g.title), ['Alpha', 'Bravo', 'Charlie']);
        assert.ok(r.body.games.every(g => g.favorite === false));

        r = await api(port, 'POST', '/api/favorites', { path: 'wii/Charlie.iso', favorite: true });
        assert.strictEqual(r.status, 200);
        r = await api(port, 'GET', '/api/games');
        assert.deepStrictEqual(r.body.games.map(g => g.title), ['Charlie', 'Alpha', 'Bravo']);
        assert.strictEqual(r.body.games[0].favorite, true);
        assert.match(fs.readFileSync(path.join(cfgHome, 'all-in-one-emulator', 'config.json'), 'utf8'), /wii\/Charlie\.iso/);

        r = await api(port, 'POST', '/api/favorites', { path: 'wii/Charlie.iso', favorite: false });
        r = await api(port, 'GET', '/api/games');
        assert.deepStrictEqual(r.body.games.map(g => g.title), ['Alpha', 'Bravo', 'Charlie']);

        r = await api(port, 'POST', '/api/favorites', { path: 5, favorite: true });
        assert.strictEqual(r.status, 400);
    } finally { srv.close(); }
});

test('the pause hold time is 0 to 2 seconds in half-second steps, 1.5 by default', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'GET', '/api/settings');
        assert.strictEqual(r.body.pauseHold, 1.5);
        for (const v of [0, 0.5, 1, 1.5, 2]) {
            assert.strictEqual((await api(port, 'POST', '/api/settings', { pauseHold: v })).status, 200);
            assert.strictEqual((await api(port, 'GET', '/api/settings')).body.pauseHold, v);
        }
        for (const bad of [0.7, 2.5, -1, 'x']) {
            assert.strictEqual((await api(port, 'POST', '/api/settings', { pauseHold: bad })).status, 400, `rejects ${bad}`);
        }
        assert.strictEqual((await api(port, 'GET', '/api/settings')).body.pauseHold, 2, 'a rejected value changes nothing');
    } finally { srv.close(); }
});
