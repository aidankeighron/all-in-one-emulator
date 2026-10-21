const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const systemLib = require('../ui/lib/system');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sys-'));
const DEFAULT_GDM = '# GDM configuration storage\n\n[daemon]\n# Uncomment the line below to force the login screen to use Xorg\n#WaylandEnable=false\n#  AutomaticLoginEnable = true\n#  AutomaticLogin = user1\n\n[security]\n';

test('GDM: automatic sign-in is added in its own block, and removing it gives back the original file', () => {
    const on = systemLib.gdmConfig(DEFAULT_GDM, 'tv');
    assert.match(on, /\[daemon\]\n# emulator-menu kiosk: begin\nAutomaticLoginEnable=true\nAutomaticLogin=tv\n# emulator-menu kiosk: end/);
    assert.strictEqual(systemLib.gdmConfig(on, null), DEFAULT_GDM);
    assert.strictEqual(systemLib.gdmConfig(systemLib.gdmConfig(on, 'tv'), 'tv'), on, 'turning it on twice changes nothing more');
    // a sign-in the file already had is put aside while ours is on, and comes back
    const own = '[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin=someone\n';
    const withOurs = systemLib.gdmConfig(own, 'tv');
    assert.ok(!/^AutomaticLogin=someone/m.test(withOurs));
    assert.strictEqual(systemLib.gdmConfig(withOurs, null), own);
    assert.match(systemLib.gdmConfig('', 'tv'), /^\[daemon\]\n# emulator-menu kiosk: begin/);
    assert.match(systemLib.lightdmConfig('tv'), /\[Seat:\*\]\nautologin-user=tv\nautologin-user-timeout=0/);
});

test('the menu is started again as the AppImage, or as Electron from a source checkout', () => {
    assert.strictEqual(systemLib.appCommand({ env: { APPIMAGE: '/home/tv/Emulator Menu.AppImage' }, electron: true }), '"/home/tv/Emulator Menu.AppImage" --fullscreen');
    assert.strictEqual(systemLib.appCommand({ env: {}, electron: true, execPath: '/app/electron', root: '/app/menu' }), '"/app/electron" "/app/menu" --no-sandbox --fullscreen');
    assert.strictEqual(systemLib.appCommand({ env: {}, electron: false }), null);
    assert.match(systemLib.desktopEntry('x --fullscreen'), /Exec=x --fullscreen\n/);
});

function fakeSystem({ gdm = true, platform = 'linux' } = {}) {
    const home = tmp(), etc = tmp();
    const gdmFile = path.join(etc, 'custom.conf');
    if (gdm) fs.writeFileSync(gdmFile, DEFAULT_GDM);
    const calls = [], gsettings = { 'org.gnome.desktop.screensaver lock-enabled': 'true', 'org.gnome.desktop.session idle-delay': 'uint32 300', 'org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type': "'suspend'", 'org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type': "'suspend'" };
    const spawnImpl = (file, args) => {
        calls.push([file, ...args]);
        const handlers = {};
        setImmediate(() => {
            // pkexec runs the script as root: here it just runs it, with the real file standing in for /etc
            if (file === 'pkexec') {
                const script = args[2].split(path.join('/etc/gdm3', 'custom.conf')).join(gdmFile);
                require('child_process').execSync(script, { shell: '/bin/sh' });
            }
            handlers.close(0);
        });
        return { unref() {}, on: (e, f) => { handlers[e] = f; }, stdout: { on() {} }, stderr: { on() {} } };
    };
    const execImpl = (file, args, o, cb) => {
        if (file !== 'gsettings') return cb(null, '');
        const id = `${args[1]} ${args[2]}`;
        if (args[0] === 'get') return cb(null, `${gsettings[id]}\n`);
        gsettings[id] = args[3]; calls.push(['gsettings', ...args]); cb(null, '');
    };
    const exists = f => (f === '/etc/gdm3/custom.conf' ? gdm : fs.existsSync(f));
    const read = f => fs.readFileSync(f === '/etc/gdm3/custom.conf' ? gdmFile : f, 'utf8');
    const sys = systemLib.createSystem({ platform, home, user: 'tv', configDir: path.join(home, 'cfg'), exists, read, execImpl, spawnImpl, command: () => '"/x/app" --fullscreen' });
    return { sys, home, gdmFile, calls, gsettings };
}

test('kiosk mode: sign-in, autostart and the desktop’s lock and sleep are set, and all of it is put back', async () => {
    const { sys, home, gdmFile, calls, gsettings } = fakeSystem();
    assert.deepStrictEqual({ ...sys.status(), canStart: 1 }, { supported: true, displayManager: 'gdm', autologin: false, autostart: false, enabled: false, user: 'tv', canStart: 1 });
    const lines = [];
    const st = await sys.enable({ onLine: l => lines.push(l) });
    assert.strictEqual(st.enabled, true, lines.join('\n'));
    assert.match(fs.readFileSync(gdmFile, 'utf8'), /AutomaticLogin=tv/);
    assert.ok(fs.existsSync(gdmFile + '.emulator-menu.bak'), 'the original file is kept');
    assert.strictEqual(fs.readFileSync(gdmFile + '.emulator-menu.bak', 'utf8'), DEFAULT_GDM);
    assert.match(fs.readFileSync(path.join(home, '.config/autostart/emulator-menu.desktop'), 'utf8'), /Exec="\/x\/app" --fullscreen/);
    assert.deepStrictEqual([gsettings['org.gnome.desktop.screensaver lock-enabled'], gsettings['org.gnome.desktop.session idle-delay'], gsettings['org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type']], ['false', 'uint32 0', "'nothing'"]);
    assert.ok(calls.some(c => c[0] === 'pkexec'));

    // on twice must not lose the first saved values
    await sys.enable({});
    const off = await sys.disable({});
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(fs.readFileSync(gdmFile, 'utf8'), DEFAULT_GDM);
    assert.ok(!fs.existsSync(path.join(home, '.config/autostart/emulator-menu.desktop')));
    assert.deepStrictEqual([gsettings['org.gnome.desktop.screensaver lock-enabled'], gsettings['org.gnome.desktop.session idle-delay'], gsettings['org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type']], ['true', 'uint32 300', "'suspend'"]);
});

test('kiosk mode: a refused password changes nothing; an unknown sign-in screen and Windows are explained', async () => {
    const refused = fakeSystem();
    const decline = (file, args) => { const h = {}; setImmediate(() => h.close(126)); return { unref() {}, on: (e, f) => { h[e] = f; }, stdout: { on() {} }, stderr: { on() {} } }; };
    const sys = systemLib.createSystem({ platform: 'linux', home: refused.home, user: 'tv', exists: f => f === '/etc/gdm3/custom.conf', read: () => DEFAULT_GDM, spawnImpl: decline, execImpl: (f, a, o, cb) => cb(null, ''), command: () => 'x', configDir: refused.home });
    await assert.rejects(sys.enable({}), /cancelled/);
    assert.ok(!fs.existsSync(path.join(refused.home, '.config/autostart/emulator-menu.desktop')), 'nothing is left half done');

    const none = fakeSystem({ gdm: false });
    const bare = systemLib.createSystem({ platform: 'linux', home: none.home, user: 'tv', exists: () => false, command: () => 'x', configDir: none.home });
    await assert.rejects(bare.enable({}), /GDM or LightDM/);
    const noApp = systemLib.createSystem({ platform: 'linux', home: none.home, exists: () => true, command: () => null });
    await assert.rejects(noApp.enable({}), /as the app/);

    const win = systemLib.createSystem({ platform: 'win32' });
    assert.strictEqual(win.status().supported, false);
    await assert.rejects(win.enable({}), /Ubuntu/);
});

test('restart and shut down run the right command on each system, and nothing else', () => {
    const run = platform => { const calls = []; const sys = systemLib.createSystem({ platform, spawnImpl: (f, a) => { calls.push([f, ...a]); return { unref() {}, on() {} }; } }); return { sys, calls }; };
    let r = run('linux'); r.sys.power('restart'); r.sys.power('shutdown');
    assert.deepStrictEqual(r.calls, [['systemctl', 'reboot'], ['systemctl', 'poweroff']]);
    r = run('win32'); r.sys.power('restart'); r.sys.power('shutdown');
    assert.deepStrictEqual(r.calls, [['shutdown', '/r', '/t', '0'], ['shutdown', '/s', '/t', '0']]);
    assert.throws(() => r.sys.power('rm -rf'), /Unknown/);
});
