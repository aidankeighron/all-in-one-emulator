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
    assert.match(on, /\[daemon\]\n# emulator-menu kiosk: begin\nAutomaticLoginEnable=true\nAutomaticLogin=tv\nTimedLoginEnable=true\nTimedLogin=tv\nTimedLoginDelay=3\n# emulator-menu kiosk: end/);
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
    assert.match(fs.readFileSync(path.join(home, '.config/autostart/emulator-menu.desktop'), 'utf8'), /Exec=\/bin\/sh ".*kiosk-start\.sh"/);
    assert.match(fs.readFileSync(path.join(home, 'cfg/kiosk-start.sh'), 'utf8'), /\n    "\/x\/app" --fullscreen\n/, 'the launcher starts the app');
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
    await assert.rejects(bare.enable({}), /GDM, LightDM or SDDM/);
    const noApp = systemLib.createSystem({ platform: 'linux', home: none.home, exists: () => true, command: () => null });
    await assert.rejects(noApp.enable({}), /as the app/);

    const win = systemLib.createSystem({ platform: 'win32' });
    assert.strictEqual(win.status().supported, false);
    await assert.rejects(win.enable({}), /Ubuntu/);
});

test('restart, sleep and shut down run the right command, and say when the computer wants the administrator', async () => {
    const { EventEmitter } = require('events');
    // a stand-in for the command: answers with an exit code and what it printed
    const run = (platform, answer = { code: 0, text: '' }) => {
        const calls = [];
        const spawnImpl = (f, a) => {
            calls.push([f, ...a]);
            const child = new EventEmitter();
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            child.stdin = { write() {}, end() {} };
            child.unref = () => {};
            setTimeout(() => { if (answer.text) child.stderr.emit('data', answer.text); child.emit('close', answer.code); }, 5);
            return child;
        };
        return { sys: systemLib.createSystem({ platform, spawnImpl }), calls };
    };
    let r = run('linux');
    assert.deepStrictEqual(await r.sys.power('restart'), { ok: true });
    await r.sys.power('shutdown'); await r.sys.power('sleep');
    assert.deepStrictEqual(r.calls, [['systemctl', '--no-ask-password', 'reboot'], ['systemctl', '--no-ask-password', 'poweroff'], ['systemctl', '--no-ask-password', 'suspend']]);
    // another session signed in (the sign-in screen's, say): Ubuntu wants the administrator, which the menu then asks for
    r = run('linux', { code: 1, text: 'Call to Reboot failed: Interactive authentication required.\n' });
    const refused = await r.sys.power('restart');
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.admin, true);
    r = run('linux', { code: 1, text: 'Failed to suspend system via logind: Sleep verb "suspend" not supported\n' });
    const other = await r.sys.power('sleep');
    assert.strictEqual(other.admin, false);
    assert.match(other.message, /not supported/);
    r = run('win32'); await r.sys.power('restart'); await r.sys.power('shutdown'); await r.sys.power('sleep');
    assert.deepStrictEqual(r.calls, [['shutdown', '/r', '/t', '0'], ['shutdown', '/s', '/t', '0'], ['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0']]);
    await assert.rejects(r.sys.power('rm -rf'), /Unknown/);
});

test('next start: an encrypted disk and Wi-Fi kept in the keyring are found, and the Wi-Fi password is stored for the computer', async () => {
    const { EventEmitter } = require('events');
    const answers = {
        'lsblk -nro TYPE': 'disk\npart\ncrypt\n',
        'nmcli -t -f TYPE,NAME connection show': '802-11-wireless:Home\\:5G\n802-3-ethernet:Wired\n802-11-wireless:Cafe\n',
        'nmcli -g 802-11-wireless-security.psk-flags connection show id Home:5G': '1 (agent-owned)',
        'nmcli -g 802-11-wireless-security.psk-flags connection show id Cafe': '0 (none)'
    };
    const execImpl = (f, a, o, cb) => { const out = answers[[f, ...a].join(' ')]; cb(out === undefined ? new Error('no') : null, out || ''); };
    const scripts = [];
    const spawnImpl = (cmd, args) => {
        scripts.push(args[args.length - 1]);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0), 5);
        return child;
    };
    const sys = systemLib.createSystem({ platform: 'linux', execImpl, spawnImpl, exists: () => false, read: () => '' });
    const c = await sys.nextStart();
    assert.strictEqual(c.encrypted, true);
    assert.deepStrictEqual(c.wifi, ['Home:5G'], 'only the network whose password is in the keyring');
    await assert.rejects(sys.fixWifi('Home:5G', 'short'), /8 to 63/);
    await sys.fixWifi('Home:5G', "it's-a-secret");
    assert.strictEqual(scripts[0], "nmcli connection modify id 'Home:5G' 802-11-wireless-security.psk-flags 0 802-11-wireless-security.psk 'it'\\''s-a-secret'");
});

test('the sign-in screen: Xorg for NVIDIA, the one that really runs is written, and the diagnosis says why it might not sign in', async () => {
    const xorg = systemLib.gdmConfig(DEFAULT_GDM, 'tv', { xorg: true });
    assert.match(xorg, /TimedLoginDelay=3\nWaylandEnable=false\n# emulator-menu kiosk: end/);
    assert.strictEqual(systemLib.gdmConfig(xorg, null), DEFAULT_GDM, 'all of it comes off again');
    assert.strictEqual(systemLib.gdmConfig(xorg, 'tv'), systemLib.gdmConfig(DEFAULT_GDM, 'tv'), 'repairing without Xorg takes Wayland back');
    assert.match(systemLib.sddmConfig('tv', 'plasma'), /\[Autologin\]\nUser=tv\nSession=plasma.desktop/);

    // GDM is installed but LightDM is the one that runs: LightDM is written
    const files = { '/etc/X11/default-display-manager': '/usr/sbin/lightdm\n', '/etc/gdm3/custom.conf': DEFAULT_GDM };
    const sys = systemLib.createSystem({ platform: 'linux', user: 'tv', exists: f => f in files, read: f => files[f], execImpl: (f, a, o, cb) => cb(null, ''), command: () => 'x' });
    assert.strictEqual(sys.displayManager().name, 'lightdm');

    // GDM with NVIDIA and Wayland, and what GDM logged
    const g = { '/etc/gdm3/custom.conf': systemLib.gdmConfig(DEFAULT_GDM, 'tv').replace(/TimedLogin.*\n/g, ''), '/sys/module/nvidia': '' };
    const answers = { 'systemctl show -p Id --value display-manager.service': 'gdm.service', 'journalctl -b -q --no-pager -o cat -u gdm.service -n 400': 'Gdm: Child process -1234 was already dead.\nGdm: GdmDisplay: Session never registered, failing\nGdm: autologin failed, falling back to the greeter\n' };
    const diag = await systemLib.createSystem({ platform: 'linux', user: 'tv', exists: f => f in g, read: f => g[f], execImpl: (f, a, o, cb) => cb(null, answers[[f, ...a].join(' ')] || ''), command: () => 'x' }).loginDiagnosis();
    assert.strictEqual(diag.running, 'gdm');
    assert.strictEqual(diag.mismatch, false);
    assert.strictEqual(diag.autologin, true);
    assert.strictEqual(diag.timed, false, 'an older kiosk mode: no backup yet');
    assert.strictEqual(diag.nvidia && diag.wayland, true);
    assert.deepStrictEqual(diag.log, ['Gdm: GdmDisplay: Session never registered, failing', 'Gdm: autologin failed, falling back to the greeter']);
});

test('kiosk launcher: the menu is started again after an accidental close, and stays closed after Close menu', () => {
    const dir = tmp();
    const counter = path.join(dir, 'runs'), note = path.join(dir, 'menu-closed');
    // a stand-in for the app: the first run "crashes", the second is closed with Close menu (which leaves the note)
    const app = path.join(dir, 'app.sh');
    fs.writeFileSync(app, `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; [ $n -ge 2 ] && echo closed > "${note}"; [ "$EMULATOR_MENU_KIOSK" = 1 ] || exit 9; exit 1\n`);
    const script = path.join(dir, 'kiosk-start.sh');
    fs.writeFileSync(script, systemLib.launcherScript(`/bin/sh "${app}"`, note));
    require('child_process').execFileSync('/bin/sh', [script], { timeout: 10000 });
    assert.strictEqual(fs.readFileSync(counter, 'utf8').trim(), '2', 'started again once after the crash, then stopped');
    assert.ok(!fs.existsSync(note), 'the note is cleared for next time');
});

test('kiosk: Close menu leaves the note, and an older kiosk mode is switched to the launcher', () => {
    const home = tmp();
    const cfg = path.join(home, 'cfg');
    const auto = path.join(home, '.config/autostart/emulator-menu.desktop');
    fs.mkdirSync(path.dirname(auto), { recursive: true });
    fs.writeFileSync(auto, systemLib.desktopEntry('"/x/app" --fullscreen'));       // as kiosk mode wrote it before
    const sys = systemLib.createSystem({ platform: 'linux', home, user: 'tv', configDir: cfg, command: () => '"/x/app" --fullscreen' });
    assert.strictEqual(sys.refreshKiosk(), true);
    assert.match(fs.readFileSync(auto, 'utf8'), /kiosk-start\.sh/);
    assert.strictEqual(sys.refreshKiosk(), false, 'once is enough');
    sys.markClosed();
    assert.ok(fs.existsSync(path.join(cfg, 'menu-closed')));
});
