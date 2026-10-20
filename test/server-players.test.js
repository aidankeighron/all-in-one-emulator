const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `srvpl-${p}-`));
const home = tmp('home');
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = tmp('cfg');
process.env.ROMS_DIR = tmp('roms');
const server = require('../ui/server');

async function api(port, method, url, body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers }, body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}

test('players and mappings are saved, validated and synced to Dolphin through the API', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'GET', '/api/players');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.players.length, 4);
        assert.ok(r.body.profiles.some(p => p.id === 'wii-classic' && p.builtin));

        r = await api(port, 'POST', '/api/players', { players: 'nope' });
        assert.strictEqual(r.status, 400);

        // A mapping of my own
        r = await api(port, 'POST', '/api/mappings', { name: 'Mine', target: 'wii', extension: 'nunchuk', entries: { 'Buttons/A': 'Button Y' } });
        assert.strictEqual(r.status, 200);
        const id = r.body.profile.id;
        assert.ok(fs.existsSync(path.join(process.env.XDG_CONFIG_HOME, 'all-in-one-emulator', 'mappings', `${id}.json`)));

        r = await api(port, 'POST', '/api/mappings', { name: 'Bad', target: 'wii', entries: { 'Buttons/A': 'nope' } });
        assert.strictEqual(r.status, 400);
        r = await api(port, 'POST', '/api/mappings', { id: 'wii-nunchuk', name: 'x', target: 'wii', entries: {} });
        assert.strictEqual(r.status, 400);

        r = await api(port, 'POST', '/api/players', { players: [{ device: 'real', wii: id, gc: 'auto' }, { device: 'none' }] });
        assert.strictEqual(r.body.players[0].device, 'real');
        assert.strictEqual(r.body.slots[0].mode, 'real');

        r = await api(port, 'POST', '/api/players/add-real');
        assert.strictEqual(r.body.player, 2, 'player 2 was "none", which counts as free');
        r = await api(port, 'GET', '/api/players');
        assert.strictEqual(r.body.players[1].device, 'real');

        r = await api(port, 'POST', '/api/mappings/duplicate', { id: 'wii-gyro' });
        assert.ok(r.body.profile.name.startsWith('Copy of'));
        r = await api(port, 'POST', '/api/mappings/delete', { id: r.body.profile.id });
        assert.strictEqual(r.status, 200);
        r = await api(port, 'POST', '/api/mappings/delete', { id: 'wii-gyro' });
        assert.strictEqual(r.status, 400);

        r = await api(port, 'GET', '/api/mappings');
        assert.ok(r.body.sources.length > 20 && r.body.controls.wii.length > 20);
        r = await api(port, 'POST', '/api/players', { players: [] }, { Origin: 'http://evil.example' });
        assert.strictEqual(r.status, 403);
    } finally { srv.close(); }
});
