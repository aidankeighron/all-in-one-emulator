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

        r = await api(port, 'POST', '/api/mappings/duplicate', { id: 'wii-nunchuk-gyro' });
        assert.ok(r.body.profile.name.startsWith('Copy of'));
        r = await api(port, 'POST', '/api/mappings/delete', { id: r.body.profile.id });
        assert.strictEqual(r.status, 200);
        r = await api(port, 'POST', '/api/mappings/delete', { id: 'wii-nunchuk-gyro' });
        assert.strictEqual(r.status, 400);

        r = await api(port, 'GET', '/api/mappings');
        assert.ok(r.body.sources.wii.generic.length > 20 && r.body.sources.wii.nintendo.length > r.body.sources.wii.generic.length && r.body.controls.wii.length > 20);
        assert.ok(r.body.controls.switch.length > 10 && r.body.targets.switch && r.body.families.nintendo);
        r = await api(port, 'POST', '/api/players', { players: [] }, { Origin: 'http://evil.example' });
        assert.strictEqual(r.status, 403);
    } finally { srv.close(); }
});

test('the Controllers page shows controllers in player order, and they can be moved, remapped, combined and split', async () => {
    const controllers = require('../ui/lib/controllers');
    const dev = (name, bus, vendor, product, js) => `I: Bus=${bus} Vendor=${vendor} Product=${product} Version=0110\nN: Name="${name}"\nP: Phys=\nS: Sysfs=/x\nU: Uniq=\nH: Handlers=event${js + 10} js${js}\nB: PROP=0\n`;
    const procFile = path.join(tmp('proc'), 'devices');
    fs.writeFileSync(procFile, [
        dev('Logitech G29 Driving Force Racing Wheel', '0003', '046d', 'c24f', 0),
        dev('Microsoft X-Box 360 pad', '0003', '045e', '028e', 1),
        dev('Nintendo Switch Left Joy-Con', '0005', '057e', '2006', 2),
        dev('Nintendo Switch Right Joy-Con', '0005', '057e', '2007', 3)
    ].join('\n'));
    const realDetect = controllers.detect;
    controllers.detect = opts => realDetect({ ...opts, procFile, usbRoot: '/nonexistent' });
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        await api(port, 'POST', '/api/players', { players: [] });
        let r = await api(port, 'GET', '/api/controllers');
        // Joy-Cons are listed one by one until the person joins them
        assert.deepStrictEqual(r.body.controllers.map(c => [c.name, c.player]), [['Logitech G29 Driving Force Racing Wheel', 1], ['Microsoft X-Box 360 pad', 2], ['Nintendo Switch Left Joy-Con', 3], ['Nintendo Switch Right Joy-Con', 4]]);
        r = await api(port, 'POST', '/api/controllers/combine', { a: r.body.controllers[2].key, b: r.body.controllers[3].key });
        assert.deepStrictEqual(r.body.controllers.map(c => [c.name, c.player]), [['Logitech G29 Driving Force Racing Wheel', 1], ['Microsoft X-Box 360 pad', 2], ['Joy-Con pair', 3]]);
        const [wheel, xbox, pair] = r.body.controllers;
        assert.strictEqual(pair.maps.wii.id, 'wii-nunchuk-gyro');
        assert.strictEqual(xbox.maps.sw.id, 'switch-generic');
        assert.ok(pair.canCombine && !xbox.canCombine);

        // the real pad takes player 1 from the wheel: the page shows it first
        r = await api(port, 'POST', '/api/players/move', { from: 1, to: 0 });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.controllers.map(c => [c.name, c.player]), [['Microsoft X-Box 360 pad', 1], ['Logitech G29 Driving Force Racing Wheel', 2], ['Joy-Con pair', 3]]);
        // and it is the same on the next look, and in the Players screen
        r = await api(port, 'GET', '/api/controllers');
        assert.strictEqual(r.body.controllers[0].name, 'Microsoft X-Box 360 pad');
        r = await api(port, 'GET', '/api/players');
        assert.strictEqual(r.body.slots[0].controller, 'Microsoft X-Box 360 pad');
        // into an empty player
        r = await api(port, 'POST', '/api/players/move', { from: 2, to: 3 });
        assert.strictEqual(r.body.controllers.find(c => c.name === 'Joy-Con pair').player, 4);
        r = await api(port, 'POST', '/api/players/move', { from: 0, to: 7 });
        assert.strictEqual(r.status, 400);
        r = await api(port, 'POST', '/api/players/move', { to: 1 });
        assert.strictEqual(r.status, 400);

        // a mapping for one player and console, only if it is for that console
        r = await api(port, 'POST', '/api/players/mapping', { player: 0, target: 'gamecube', id: 'gc-nintendo' });
        assert.strictEqual(r.body.controllers[0].maps.gc.id, 'gc-nintendo');
        r = await api(port, 'POST', '/api/players/mapping', { player: 0, target: 'gamecube', id: 'wii-classic' });
        assert.strictEqual(r.status, 400);
        r = await api(port, 'POST', '/api/players/mapping', { player: 0, target: 'gamecube', id: 'auto' });
        assert.strictEqual(r.body.controllers[0].maps.gc.id, 'gc-default');

        // take the Joy-Cons apart, then put the Xbox pad and the right Joy-Con together by hand
        const members = pair.memberKeys;
        r = await api(port, 'POST', '/api/controllers/split', { members });
        assert.strictEqual(r.body.controllers.length, 4);
        assert.ok(r.body.controllers.every(c => !c.combined));
        assert.strictEqual(r.body.controllers.find(c => c.name === 'Nintendo Switch Left Joy-Con').player, 4, 'the left half keeps the pair’s player');
        r = await api(port, 'POST', '/api/controllers/combine', { a: members[0], b: members[1] });
        assert.strictEqual(r.body.controllers.length, 3);
        assert.strictEqual(r.body.controllers.find(c => c.name === 'Joy-Con pair').player, 4, 'and the pair keeps it again');
        r = await api(port, 'POST', '/api/controllers/combine', { a: members[0], b: members[0] });
        assert.strictEqual(r.status, 400);
        r = await api(port, 'POST', '/api/controllers/split', { members: ['x'] });
        assert.strictEqual(r.status, 400);
    } finally { srv.close(); controllers.detect = realDetect; }
});
