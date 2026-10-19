const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Everything points at temp folders before the server is loaded
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `srv-${p}-`));
const home = tmp('home');
const cfgHome = tmp('cfg');
const roms = tmp('roms');
const remote = tmp('remote');
execFileSync('git', ['init', '-q', '--bare', remote]);
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = cfgHome;
process.env.ROMS_DIR = roms;
fs.mkdirSync(path.join(cfgHome, 'all-in-one-emulator'), { recursive: true });
fs.writeFileSync(path.join(cfgHome, 'all-in-one-emulator', 'config.json'), JSON.stringify({ cloudRepoUrl: remote, cloudPassphrase: 'pw' }));
fs.mkdirSync(path.join(home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx/system'), { recursive: true });
fs.mkdirSync(path.join(roms, 'switch'), { recursive: true });
fs.writeFileSync(path.join(roms, 'switch', 'Super Mario Odyssey.nsp'), 'x');
fs.mkdirSync(path.join(roms, 'wii'), { recursive: true });
fs.writeFileSync(path.join(roms, 'wii', 'Wii Sports.iso'), 'x');

const server = require('../ui/server');

async function api(port, method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}

test('save slot endpoints: list, create, rename, delete, cloud status', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        const p = encodeURIComponent('switch/Super Mario Odyssey.nsp');
        let r = await api(port, 'GET', `/api/saves?path=${p}`);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.body.supported, r.body.online, r.body.slots.length], [true, true, 0]);

        r = await api(port, 'POST', '/api/saves/create', { path: 'switch/Super Mario Odyssey.nsp', name: 'Main run' });
        assert.strictEqual(r.status, 200);
        const id = r.body.id;
        r = await api(port, 'GET', `/api/saves?path=${p}`);
        assert.deepStrictEqual(r.body.slots.map(s => s.name), ['Main run']);

        r = await api(port, 'POST', '/api/saves/rename', { path: 'switch/Super Mario Odyssey.nsp', slot: id, name: 'Renamed' });
        assert.strictEqual(r.body.name, 'Renamed');
        r = await api(port, 'POST', '/api/saves/create', { path: 'switch/Super Mario Odyssey.nsp', name: '   ' });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.error, 'BAD_NAME');

        r = await api(port, 'GET', '/api/cloud');
        assert.deepStrictEqual([r.body.enabled, r.body.encrypted, r.body.configured], [true, true, true]);
        assert.ok(!('passphrase' in r.body), 'the passphrase is never sent to the page');

        r = await api(port, 'POST', '/api/saves/delete', { path: 'switch/Super Mario Odyssey.nsp', slot: id });
        assert.strictEqual(r.status, 200);

        // Wii is supported too; an unknown game is a clear error, not a crash
        r = await api(port, 'GET', `/api/saves?path=${encodeURIComponent('wii/Wii Sports.iso')}`);
        assert.strictEqual(r.body.supported, true);
        r = await api(port, 'GET', `/api/saves?path=${encodeURIComponent('wii/Nope.iso')}`);
        assert.strictEqual(r.body.error, 'UNKNOWN_GAME');

        r = await api(port, 'POST', '/api/cloud', { slotsEnabled: false });
        assert.strictEqual(r.body.slotsEnabled, false);
        r = await api(port, 'GET', `/api/saves?path=${p}`);
        assert.strictEqual(r.body.supported, false, 'turning slots off goes back to plain launching');
    } finally {
        srv.close();
    }
});

test('sync endpoint reports a quiet result when there is nothing to do', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        const r = await api(port, 'POST', '/api/saves/sync');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.body.online, r.body.updated, r.body.conflicts], [true, [], []]);
    } finally {
        srv.close();
    }
});
