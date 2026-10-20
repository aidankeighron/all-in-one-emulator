// Windows support, simulated on any machine: fake APPDATA folders and a pretend platform.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platformLib = require('../ui/lib/platform');
const { createRunner } = require('../ui/lib/runner');
const adaptersLib = require('../ui/lib/saves/adapters');
const inputconfig = require('../ui/lib/inputconfig');
const controllers = require('../ui/lib/controllers');
const { Ini } = require('../ui/lib/ini');
const manifest = require('../emulators.json');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `win-${p}-`));
const put = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const emu = id => manifest.emulators.find(e => e.id === id);

test('config lives in %APPDATA% on Windows and in ~/.config on Linux; %VARS% expand in any case', () => {
    assert.strictEqual(platformLib.configDir({ platform: 'win32', env: { APPDATA: '/AppData/Roaming' }, home: '/h' }), path.join('/AppData/Roaming', 'all-in-one-emulator'));
    assert.strictEqual(platformLib.configDir({ platform: 'win32', env: {}, home: '/h' }), path.join('/h', 'AppData', 'Roaming', 'all-in-one-emulator'));
    assert.strictEqual(platformLib.configDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x' }, home: '/h' }), path.join('/x', 'all-in-one-emulator'));
    assert.strictEqual(platformLib.configDir({ platform: 'linux', env: {}, home: '/h' }), path.join('/h', '.config', 'all-in-one-emulator'));
    assert.strictEqual(platformLib.expandEnv('%LocalAppData%/Dolphin', { LOCALAPPDATA: '/L' }), '/L/Dolphin');
    assert.strictEqual(platformLib.expandEnv('%NOPE%/x', {}), '%NOPE%/x');
});

test('every emulator that can run on Windows says which program to start and where to get it', () => {
    for (const e of manifest.emulators) {
        assert.ok(e.windows && /\.exe$/.test(e.windows.exe) && /^https:\/\//.test(e.windows.download), e.id);
        assert.ok(e.windows.dirs.every(d => !d.includes('\\')), 'forward slashes work on every platform');
    }
});

test('runner (Windows): finds a program you chose, then the emulators folder, then the usual places', async () => {
    const emulatorsDir = tmp('emus');
    const chosen = put(path.join(tmp('chosen'), 'MyDolphin.exe'));
    const env = { USERPROFILE: tmp('profile') };
    let paths = {};
    const runner = createRunner({ platform: 'win32', env, emulatorsDir, getPaths: () => paths });
    assert.strictEqual(runner.manual, true);
    assert.strictEqual(await runner.available(), true);
    assert.strictEqual(await runner.isInstalled(emu('dolphin')), false);
    assert.strictEqual(runner.exePath(emu('dolphin')), null);

    const usual = put(path.join(env.USERPROFILE, 'Dolphin-x64', 'Dolphin.exe'));
    assert.strictEqual(runner.exePath(emu('dolphin')), usual, 'a usual place');

    const unpacked = put(path.join(emulatorsDir, 'dolphin', 'Dolphin-x64', 'Dolphin.exe'));
    assert.strictEqual(runner.exePath(emu('dolphin')), unpacked, 'unzipped into the emulators folder (inside its own subfolder)');

    paths = { dolphin: chosen };
    assert.strictEqual(runner.exePath(emu('dolphin')), chosen, 'the Locate choice wins');
    paths = { dolphin: '/gone/Dolphin.exe' };
    assert.strictEqual(runner.exePath(emu('dolphin')), unpacked, 'a choice that no longer exists is ignored');
    assert.strictEqual(await runner.isInstalled(emu('dolphin')), true);
    assert.strictEqual(runner.exePath(emu('ryujinx')), null);
});

test('runner (Windows): starts the program in its own folder, reports exit, and force-kills the whole tree', async () => {
    const exe = put(path.join(tmp('start'), 'Ryujinx.exe'));
    const calls = [];
    const { EventEmitter } = require('events');
    const fakeSpawn = (file, args, opts) => {
        calls.push({ file, args, cwd: opts.cwd });
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 4321;
        setImmediate(() => { child.stderr.emit('data', 'boom'); child.emit('close', 3); });
        return child;
    };
    const killed = [];
    const runner = createRunner({ platform: 'win32', env: {}, getPaths: () => ({ ryujinx: exe }), spawnImpl: fakeSpawn, execImpl: (...a) => killed.push(a.slice(0, 2)) });
    const exit = await new Promise(resolve => { const child = runner.launch(emu('ryujinx'), ['-r', 'C:/slot', 'game.nsp'], (code, err) => resolve({ code, err, child })); });
    assert.deepStrictEqual(calls, [{ file: exe, args: ['-r', 'C:/slot', 'game.nsp'], cwd: path.dirname(exe) }]);
    assert.deepStrictEqual([exit.code, exit.err], [3, 'boom']);
    runner.forceKill(emu('ryujinx'), exit.child);
    assert.deepStrictEqual(killed, [['taskkill', ['/PID', '4321', '/T', '/F']]]);

    const missing = await new Promise(resolve => createRunner({ platform: 'win32', env: {}, getPaths: () => ({}) }).launch(emu('dolphin'), [], (code, err) => resolve([code, err])));
    assert.deepStrictEqual(missing, [1, 'Dolphin was not found']);
});

test('runner (Linux): everything goes through Flatpak, and the menu installs emulators', async () => {
    const log = [];
    const fake = {
        available: async () => true, isInstalled: async id => id === 'org.DolphinEmu.dolphin-emu',
        install: async id => { log.push(['install', id]); return 0; }, grantAccess: async (id, dir) => log.push(['grant', id, dir]),
        launch: (id, args) => { log.push(['launch', id, args]); return { pid: 1 }; }, kill: async id => log.push(['kill', id])
    };
    const runner = createRunner({ platform: 'linux', flatpakImpl: fake });
    assert.strictEqual(runner.manual, false);
    assert.strictEqual(await runner.isInstalled(emu('dolphin')), true);
    assert.strictEqual(await runner.isInstalled(emu('ryujinx')), false);
    await runner.install(emu('dolphin'), () => {});
    await runner.grantAccess(emu('dolphin'), '/roms');
    runner.launch(emu('dolphin'), ['-b'], () => {});
    runner.forceKill(emu('dolphin'));
    assert.deepStrictEqual(log, [['install', 'org.DolphinEmu.dolphin-emu'], ['grant', 'org.DolphinEmu.dolphin-emu', '/roms'], ['launch', 'org.DolphinEmu.dolphin-emu', ['-b']], ['kill', 'org.DolphinEmu.dolphin-emu']]);
});

// ---------- save slots ----------

function winCtx(extra = {}) {
    const appdata = tmp('appdata');
    return { appdata, ctx: { platform: 'win32', home: tmp('home'), env: { APPDATA: appdata }, menuDir: tmp('menu'), ...extra } };
}

test('save slots (Windows, Ryujinx): data in %APPDATA%\\Ryujinx, folders joined, single files copied, slot folders owned by the slot', () => {
    const { appdata, ctx } = winCtx();
    const real = path.join(appdata, 'Ryujinx');
    put(path.join(real, 'system', 'prod.keys'), 'KEYS');
    put(path.join(real, 'Config.json'), '{"v":1}');
    put(path.join(real, 'bis', 'user', 'Contents', 'registered', 'update.nca'), 'UPDATE');
    put(path.join(real, 'bis', 'user', 'save', '0001', 'progress.bin'), 'OTHER GAME');
    const a = adaptersLib.create(ctx).get('ryujinx');
    const slot = a.slotRoot('abc');
    assert.strictEqual(slot, path.join(ctx.menuDir, 'slots', 'ryujinx', 'abc'));
    a.assemble(slot);

    const isLink = p => fs.lstatSync(path.join(slot, p)).isSymbolicLink();
    assert.ok(isLink('system') && isLink('bis/user/Contents'), 'folders are shared (junctions on Windows)');
    assert.ok(!isLink('Config.json') && fs.readFileSync(path.join(slot, 'Config.json'), 'utf8') === '{"v":1}', 'a single file is a copy');
    assert.ok(!isLink('bis/user/save') && fs.readdirSync(path.join(slot, 'bis/user/save')).length === 0, 'this slot starts without the other games\' saves');
    assert.deepStrictEqual(a.args(slot), ['-r', slot]);

    put(path.join(real, 'Config.json'), '{"v":2}');          // a setting changed in the emulator
    a.assemble(slot);
    assert.strictEqual(fs.readFileSync(path.join(slot, 'Config.json'), 'utf8'), '{"v":2}', 'copies are refreshed on every launch');
});

test('save slots (Windows, Ryujinx): a portable install keeps its data beside the program; no data yet asks to open it once', () => {
    const exeDir = tmp('portable');
    const { appdata, ctx } = winCtx({ exePath: id => (id === 'ryujinx' ? path.join(exeDir, 'Ryujinx.exe') : null) });
    put(path.join(appdata, 'Ryujinx', 'system', 'from-appdata'));
    put(path.join(exeDir, 'portable', 'system', 'from-portable'));
    const a = adaptersLib.create(ctx).get('ryujinx');
    a.assemble(a.slotRoot('p'));
    assert.ok(fs.existsSync(path.join(a.slotRoot('p'), 'system', 'from-portable')));

    const fresh = winCtx();
    assert.throws(() => adaptersLib.create(fresh.ctx).get('ryujinx').assemble(path.join(fresh.ctx.menuDir, 's')), { code: 'FIRST_RUN' });
});

test('save slots (Windows, Dolphin): GameCube cards and Wii game saves belong to the slot, settings and channels are shared', () => {
    const { appdata, ctx } = winCtx();
    const user = path.join(appdata, 'Dolphin Emulator');
    put(path.join(user, 'Config', 'Dolphin.ini'), '[Core]');
    put(path.join(user, 'GC', 'USA', 'MemoryCardA.USA.raw'), 'CARD');
    put(path.join(user, 'Wii', 'title', '00010001', 'channel'), 'CHANNEL');
    put(path.join(user, 'Wii', 'title', '00010000', '52535045', 'data', 'save'), 'WII SAVE');
    put(path.join(user, 'Load', 'Textures', 'x'), 'MOD');
    const a = adaptersLib.create(ctx).get('dolphin');
    const slot = a.slotRoot('d1');
    a.assemble(slot);
    const isLink = p => fs.lstatSync(path.join(slot, p)).isSymbolicLink();
    assert.ok(isLink('Config') && isLink('Load') && isLink('Wii/title/00010001'));
    assert.ok(!isLink('GC') && !isLink('Wii') && !isLink('Wii/title') && !isLink('Wii/title/00010000'));
    assert.deepStrictEqual(fs.readdirSync(path.join(slot, 'GC')), [], 'a new slot starts with empty cards');
    assert.deepStrictEqual(a.args(slot), ['-u', slot]);

    const exeDir = tmp('dolphin-portable');
    put(path.join(exeDir, 'portable.txt'));
    put(path.join(exeDir, 'User', 'Config', 'Dolphin.ini'));
    const portable = adaptersLib.create({ ...ctx, exePath: id => (id === 'dolphin' ? path.join(exeDir, 'Dolphin.exe') : null) }).get('dolphin');
    portable.assemble(portable.slotRoot('d2'));
    assert.ok(fs.existsSync(path.join(portable.slotRoot('d2'), 'Config', 'Dolphin.ini')), 'portable.txt means the User folder beside the program');
});

// ---------- controllers ----------

test('Windows controllers come from the window\'s own gamepad list', () => {
    const list = controllers.fromGamepadApi([
        { index: 0, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping: 'standard' },
        { index: 1, id: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', mapping: 'standard' },
        { index: 2, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping: 'standard' },
        { index: 3, id: 'Some Keyboard (Vendor: 1234 Product: 0001)', mapping: '' },
        null
    ]);
    assert.deepStrictEqual(list.map(c => [c.name, c.kind, c.xinputIndex, c.sdlIndex, c.nameIndex, c.player]), [
        ['Xbox 360 Controller', 'xbox', 0, 0, 0, 1],
        ['Pro Controller', 'switch', null, 1, 0, 2],
        ['Xbox 360 Controller', 'xbox', 1, 2, 1, 3]
    ]);
    assert.ok(list.every(c => c.pad));
});

test('detect on Windows trusts a recent report and forgets a stale one', () => {
    const pads = [{ index: 0, id: 'Xbox One Controller (XInput STANDARD GAMEPAD)', mapping: 'standard' }];
    controllers.report(pads, 1000);
    assert.strictEqual(controllers.detect({ platform: 'win32', now: 5000 }).length, 1);
    assert.strictEqual(controllers.detect({ platform: 'win32', now: 1000 + 61 * 1000 }).length, 0);
    controllers.report([], 1000);
});

test('Dolphin config on Windows: written to %APPDATA%\\Dolphin Emulator\\Config, Xbox pads through XInput, others through SDL', () => {
    const { appdata, ctx } = winCtx();
    const list = controllers.fromGamepadApi([
        { index: 0, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping: 'standard' },
        { index: 1, id: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', mapping: 'standard' }
    ]);
    const result = inputconfig.apply('dolphin', list, ctx);
    assert.strictEqual(result.status, 'configured', result.message);
    const dir = path.join(appdata, 'Dolphin Emulator', 'Config');
    const gc = Ini.read(path.join(dir, 'GCPadNew.ini'));
    assert.strictEqual(gc.get('GCPad1', 'Device'), 'XInput/0/Gamepad');
    assert.strictEqual(gc.get('GCPad1', 'Buttons/A'), '`Button A`');
    assert.strictEqual(gc.get('GCPad2', 'Device'), 'SDL/0/Pro Controller');
    const wm = Ini.read(path.join(dir, 'WiimoteNew.ini'));
    assert.strictEqual(wm.get('Wiimote1', 'Device'), 'XInput/0/Gamepad');
    assert.strictEqual(wm.get('Wiimote2', 'Device'), 'SDL/0/Pro Controller');
    assert.strictEqual(Ini.read(path.join(dir, 'Dolphin.ini')).get('Core', 'SIDevice0'), '6');
});
