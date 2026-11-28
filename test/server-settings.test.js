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
process.env.APPDATA = cfgHome;   // config.js reads APPDATA, not XDG_CONFIG_HOME, on win32
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

test('home menu sorts by star, then backlog, then rest, ordered by last played within each tier', async () => {
    const config = require('../ui/lib/config');
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        // Set statuses: Alpha -> none, Bravo -> backlog, Charlie -> star
        assert.strictEqual((await api(port, 'POST', '/api/favorites', { path: 'wii/Charlie.iso', status: 'star' })).status, 200);
        let r = await api(port, 'POST', '/api/favorites', { path: 'wii/Bravo.iso', status: 'backlog' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.backlog, true);
        assert.strictEqual(r.body.favorite, false);

        r = await api(port, 'GET', '/api/games');
        assert.deepStrictEqual(r.body.games.map(g => g.title), ['Charlie', 'Bravo', 'Alpha']);
        assert.strictEqual(r.body.games[0].status, 'star');
        assert.strictEqual(r.body.games[1].status, 'backlog');
        assert.strictEqual(r.body.games[2].status, 'none');

        // Reject invalid status
        r = await api(port, 'POST', '/api/favorites', { path: 'wii/Alpha.iso', status: 'invalid' });
        assert.strictEqual(r.status, 400);

        // Clear Charlie & Bravo, test lastPlayed sorting within same tier and with a starred game
        await api(port, 'POST', '/api/favorites', { path: 'wii/Charlie.iso', status: 'none' });
        await api(port, 'POST', '/api/favorites', { path: 'wii/Bravo.iso', status: 'none' });
        config.recordLastPlayed('wii/Bravo.iso', 1000);
        config.recordLastPlayed('wii/Charlie.iso', 2000);
        config.recordLastPlayed('wii/Alpha.iso', 500);
        await api(port, 'POST', '/api/favorites', { path: 'wii/Alpha.iso', status: 'star' });

        r = await api(port, 'GET', '/api/games');
        // Alpha is starred so it stays at the front despite older lastPlayed; Charlie (2000) beats Bravo (1000)
        assert.deepStrictEqual(r.body.games.map(g => g.title), ['Alpha', 'Charlie', 'Bravo']);

        // Move Bravo to backlog: Alpha (star) -> Bravo (backlog) -> Charlie (none)
        await api(port, 'POST', '/api/favorites', { path: 'wii/Bravo.iso', status: 'backlog' });
        r = await api(port, 'GET', '/api/games');
        assert.deepStrictEqual(r.body.games.map(g => g.title), ['Alpha', 'Bravo', 'Charlie']);

        // Clean up status for subsequent tests
        await api(port, 'POST', '/api/favorites', { path: 'wii/Alpha.iso', status: 'none' });
        await api(port, 'POST', '/api/favorites', { path: 'wii/Bravo.iso', status: 'none' });
    } finally { srv.close(); }
});

test('settings includes build version, build number, and build date metadata', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        const r = await api(port, 'GET', '/api/settings');
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.build && typeof r.body.build.version === 'string');
        assert.strictEqual(typeof r.body.build.buildNumber, 'number');
        assert.ok('buildDate' in r.body.build);
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

test('the theme is system by default, and can be set to light or dark', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        assert.strictEqual((await api(port, 'GET', '/api/appearance')).body.theme, 'system');
        for (const t of ['dark', 'light', 'system']) {
            assert.strictEqual((await api(port, 'POST', '/api/settings', { theme: t })).status, 200);
            assert.strictEqual((await api(port, 'GET', '/api/appearance')).body.theme, t);
            assert.strictEqual((await api(port, 'GET', '/api/settings')).body.theme, t);
        }
        await api(port, 'POST', '/api/settings', { theme: 'dark' });
        assert.strictEqual((await api(port, 'POST', '/api/settings', { theme: 'purple' })).status, 400);
        assert.strictEqual((await api(port, 'GET', '/api/appearance')).body.theme, 'dark', 'a bad value changes nothing');
    } finally { srv.close(); }
});

test('starting a game whose file was renamed or moved says so', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'POST', '/api/launch', { path: 'wii/Old Name.iso' });
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.body.error, 'missing');
        assert.match(r.body.message, /Old Name\.iso/);
        r = await api(port, 'POST', '/api/launch', { path: '../../etc/passwd' });
        assert.strictEqual(r.status, 400);
    } finally { srv.close(); }
});

test('Windows pause combo: the controller-watch page is served, and Back + Start with no game does nothing', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        const page = await fetch(`http://127.0.0.1:${port}/padwatch.html`);
        assert.strictEqual(page.status, 200);
        assert.match(await page.text(), /api\/game\/pause-combo/);
        assert.strictEqual((await api(port, 'POST', '/api/game/pause-combo', { held: true })).status, 200);
        assert.strictEqual((await api(port, 'POST', '/api/game/pause-combo', { held: false })).status, 200);
        assert.strictEqual((await api(port, 'GET', '/api/status')).body.paused, false);
    } finally { srv.close(); }
});
