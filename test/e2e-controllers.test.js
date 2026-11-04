// The whole path for a Wii game with an Xbox pad, a real Wii Remote and a joycond Joy-Con pair: the server detects them
// (from a stand-in for /proc/bus/input/devices), writes Dolphin's settings, starts Dolphin (a stand-in flatpak), keeps the
// players in place when the Wii Remote reconnects, holds controller changes until the game closes, and quits without a prompt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `e2epads-${p}-`));
const home = tmp('home');
const roms = tmp('roms');
const bin = tmp('bin');
const runLog = path.join(bin, 'runs.log');
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = tmp('cfg');
process.env.ROMS_DIR = roms;
process.env.EMU_NO_HOTKEY = '1';
process.env.PATH = `${bin}:${process.env.PATH}`;

// flatpak: everything is installed; `run` writes its arguments and plays until it is told to stop
fs.writeFileSync(path.join(bin, 'flatpak'), `#!/bin/sh
case "$1" in
  run) shift; echo "$*" >> '${runLog}'; trap 'exit 0' TERM; while true; do sleep 0.05; done ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

const dev = (name, { bus = '0003', vendor, product, version = '0001', handlers }) =>
    `I: Bus=${bus} Vendor=${vendor} Product=${product} Version=${version}\nN: Name="${name}"\nP: Phys=\nS: Sysfs=/devices/x\nU: Uniq=\nH: Handlers=${handlers}\nB: KEY=0\n`;
const XBOX = dev('Microsoft X-Box 360 pad', { vendor: '045e', product: '028e', version: '0114', handlers: 'event5 js0' });
const wii = n => dev('Nintendo Wii Remote', { bus: '0005', vendor: '057e', product: '0306', version: '8600', handlers: `event${n + 5} js${n}` })
    + '\n' + dev('Nintendo Wii Remote Accelerometer', { bus: '0005', vendor: '057e', product: '0306', version: '8600', handlers: `event${n + 20}` });
const JOYCOND = [
    dev('Nintendo Switch Left Joy-Con', { bus: '0005', vendor: '057e', product: '2006', version: '8001', handlers: 'event10 js2' }),
    dev('Nintendo Switch Right Joy-Con', { bus: '0005', vendor: '057e', product: '2007', version: '8001', handlers: 'event11 js3' }),
    dev('Nintendo Switch Combined Joy-Cons', { bus: '0006', vendor: '057e', product: '2008', version: '0000', handlers: 'event12 js4' })
].join('\n');

let procText = '';
const realRead = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
    if (file === '/proc/bus/input/devices') return procText;
    return realRead.call(this, file, ...rest);
};

const server = require('../ui/server');
const { Ini } = require('../ui/lib/ini');
const dolphinDir = path.join(home, '.var/app/org.DolphinEmu.dolphin-emu/config/dolphin-emu');

async function api(port, method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}
const until = async (check, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('Xbox on player 1, Wii Remote on player 2, Joy-Con pair on player 3: each reaches its own player in Dolphin', async () => {
    fs.mkdirSync(path.join(roms, 'wii'), { recursive: true });
    fs.writeFileSync(path.join(roms, 'wii', 'Game.iso'), 'x');
    procText = [XBOX, wii(1), JOYCOND].join('\n');
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        let r = await api(port, 'GET', '/api/controllers');
        assert.deepStrictEqual(r.body.controllers.map(c => [c.player, c.kind]), [[1, 'xbox'], [2, 'wiimote'], [3, 'switch']]);

        r = await api(port, 'POST', '/api/launch', { path: 'wii/Game.iso' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const wm = Ini.read(path.join(dolphinDir, 'WiimoteNew.ini'));
        assert.strictEqual(wm.get('Wiimote1', 'Device'), 'SDL/0/Xbox 360 Controller');
        assert.strictEqual(wm.get('Wiimote2', 'Source'), '2', 'player 2 is the real Wii Remote');
        assert.strictEqual(wm.get('Wiimote3', 'Source'), '1');
        assert.strictEqual(wm.get('Wiimote3', 'Device'), 'SDL/0/Nintendo Switch Joy-Con (L/R)', 'the joycond pair by the name SDL gives it');
        const main = Ini.read(path.join(dolphinDir, 'Dolphin.ini'));
        assert.strictEqual(main.get('SDL_Hints', 'SDL_JOYSTICK_HIDAPI_JOY_CONS'), '0');
        assert.strictEqual(main.get('Core', 'WiimoteContinuousScanning'), 'False');
        assert.ok(await until(() => fs.existsSync(runLog)), 'Dolphin was started');
        assert.match(fs.readFileSync(runLog, 'utf8'), /Dolphin\.Interface\.ConfirmStop=False/);

        // The Wii Remote drops out and comes back: the system now lists it last, but it keeps player 2
        procText = [XBOX, JOYCOND, wii(5)].join('\n');
        r = await api(port, 'GET', '/api/controllers');
        assert.deepStrictEqual(r.body.controllers.map(c => [c.player, c.kind]), [[1, 'xbox'], [2, 'wiimote'], [3, 'switch']]);
        r = await api(port, 'GET', '/api/status');
        assert.strictEqual(r.body.running, true);
        assert.strictEqual(r.body.controllersChanged, false, 'nothing to restart for a reconnect');

        // Players 1 and 3 swap during the game: Dolphin's files are left alone, and the game needs a Reset
        const before = fs.readFileSync(path.join(dolphinDir, 'WiimoteNew.ini'), 'utf8');
        r = await api(port, 'POST', '/api/players/move', { from: 2, to: 0 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(fs.readFileSync(path.join(dolphinDir, 'WiimoteNew.ini'), 'utf8'), before, 'not written while Dolphin runs');
        r = await api(port, 'GET', '/api/status');
        assert.strictEqual(r.body.controllersChanged, true);

        // Quit: the change is written once Dolphin has closed
        await api(port, 'POST', '/api/game/quit');
        assert.ok(await until(async () => !(await api(port, 'GET', '/api/status')).body.running), 'the game ended');
        const after = Ini.read(path.join(dolphinDir, 'WiimoteNew.ini'));
        assert.strictEqual(after.get('Wiimote1', 'Device'), 'SDL/0/Nintendo Switch Joy-Con (L/R)');
        assert.strictEqual(after.get('Wiimote3', 'Device'), 'SDL/0/Xbox 360 Controller');
        assert.strictEqual(after.get('Wiimote2', 'Source'), '2');
    } finally {
        srv.close();
    }
});

test('the same controllers in a Switch game: Xbox is Player 1, the Joy-Con pair Player 2, the Wii Remote is left out', async () => {
    fs.mkdirSync(path.join(roms, 'switch'), { recursive: true });
    fs.writeFileSync(path.join(roms, 'switch', 'Game.nsp'), 'x');
    const ryuDir = path.join(home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx');
    fs.mkdirSync(ryuDir, { recursive: true });
    fs.writeFileSync(path.join(ryuDir, 'Config.json'), JSON.stringify({ version: 70, input_config: [] }));
    fs.rmSync(runLog, { force: true });
    procText = [XBOX, wii(1), JOYCOND].join('\n');
    const { server: srv, port } = await server.start({ port: 0 });
    try {
        await api(port, 'POST', '/api/players', { players: [] });       // everyone back on automatic
        const r = await api(port, 'POST', '/api/launch', { path: 'switch/Game.nsp' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const list = JSON.parse(fs.readFileSync(path.join(ryuDir, 'Config.json'), 'utf8')).input_config;
        const by = Object.fromEntries(list.map(e => [e.player_index, e]));
        assert.match(by.Player1.id, /^0-00000003-045e-0000-8e02-/, 'Player 1 is the Xbox pad');
        assert.match(by.Player2.id, /^0-00000006-057e-0000-0820-/, 'Player 2 is the joycond pair');
        assert.strictEqual(by.Player2.controller_type, 'ProController');
        assert.ok(!by.Player3, 'no player behind an empty one');
        assert.ok(await until(() => fs.existsSync(runLog)), 'Ryujinx was started');
        assert.match(fs.readFileSync(runLog, 'utf8'), /SDL_JOYSTICK_HIDAPI_JOY_CONS=0/, 'Ryujinx reads Joy-Cons through the kernel too');
        await api(port, 'POST', '/api/game/quit');
        assert.ok(await until(async () => !(await api(port, 'GET', '/api/status')).body.running), 'the game ended');
    } finally {
        srv.close();
    }
});
