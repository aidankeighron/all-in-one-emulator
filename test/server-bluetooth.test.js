const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `srvbt-${p}-`));
process.env.HOME = tmp('home');
process.env.XDG_CONFIG_HOME = tmp('cfg');
process.env.ROMS_DIR = tmp('roms');
const server = require('../ui/server');

async function api(port, method, url, body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers }, body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}

test('real Wii Remotes set in the menu show on the controllers page and in Dolphin', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'POST', '/api/bluetooth/wiiremotes', { count: 9 });
        assert.strictEqual(r.status, 400);
        r = await api(port, 'POST', '/api/bluetooth/wiiremotes', { count: 2 });
        assert.strictEqual(r.body.wiiRemotes, 2);

        r = await api(port, 'GET', '/api/controllers');
        const remotes = r.body.controllers.filter(c => c.kind === 'wiimote');
        assert.strictEqual(remotes.length, 2);
        assert.ok(remotes.every(c => c.virtual));
        assert.match(remotes[0].roles.join(' '), /Player 1/);

        const ini = fs.readFileSync(path.join(process.env.HOME, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu/WiimoteNew.ini'), 'utf8');
        assert.match(ini, /\[Wiimote2\]\s+Source = 2/);
        assert.match(ini, /\[Wiimote3\]\s+Source = 0/);

        r = await api(port, 'POST', '/api/bluetooth/wiiremotes', { count: 0 });
        r = await api(port, 'GET', '/api/controllers');
        assert.strictEqual(r.body.controllers.filter(c => c.kind === 'wiimote').length, 0);
    } finally { srv.close(); }
});

test('the Bluetooth API refuses other sites and bad input', async () => {
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'POST', '/api/bluetooth/pair', { kind: 'switch' }, { Origin: 'http://evil.example' });
        assert.strictEqual(r.status, 403);
        r = await api(port, 'POST', '/api/bluetooth/pair', { kind: 'toaster' });
        assert.strictEqual(r.status, 409);
        r = await api(port, 'POST', '/api/bluetooth/forget', { address: '--help' });
        assert.strictEqual(r.status, 409);
        r = await api(port, 'GET', '/api/bluetooth/job');
        assert.strictEqual(r.status, 200);
    } finally { srv.close(); }
});
