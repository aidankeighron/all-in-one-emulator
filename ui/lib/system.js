// The computer itself: restart and shut down (Windows and Linux), and kiosk mode (Ubuntu): the computer starts, signs in by
// itself with no password, opens the menu full screen and never locks or sleeps. All of it can be undone from the menu.
//
// Kiosk mode is three things, written in this order:
//   1. an autostart entry in the user's own folder that starts the menu when the desktop comes up (no permission needed)
//   2. the desktop's lock screen, screen blanking and sleep switched off (the old values are kept and put back)
//   3. automatic sign-in in the display manager (GDM on Ubuntu, or LightDM): the only part that needs an administrator,
//      done through the system's password prompt (pkexec) once, with the original file kept next to it
const fs = require('fs');
const admin = require('./admin');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const MARK_BEGIN = '# emulator-menu kiosk: begin';
const MARK_END = '# emulator-menu kiosk: end';
const OFF_TAG = '#emulator-menu kiosk, was: ';
const GDM_FILES = ['/etc/gdm3/custom.conf', '/etc/gdm/custom.conf'];
const LIGHTDM_DIR = '/etc/lightdm/lightdm.conf.d';
const LIGHTDM_FILE = `${LIGHTDM_DIR}/50-emulator-menu-kiosk.conf`;
const SDDM_DIR = '/etc/sddm.conf.d';
const SDDM_FILE = `${SDDM_DIR}/50-emulator-menu-kiosk.conf`;

// What the desktop does by itself that a kiosk must not: [schema, key, value to set]
const GNOME_SETTINGS = [
    ['org.gnome.desktop.screensaver', 'lock-enabled', 'false'],
    ['org.gnome.desktop.session', 'idle-delay', 'uint32 0'],
    ['org.gnome.settings-daemon.plugins.power', 'sleep-inactive-ac-type', "'nothing'"],
    ['org.gnome.settings-daemon.plugins.power', 'sleep-inactive-battery-type', "'nothing'"]
];

// ---------- pure helpers (tested without touching the system) ----------

// GDM's custom.conf with automatic sign-in on (user) or off (null). Only the block between the markers is ever ours.
// Besides automatic sign-in it sets timed sign-in (after 3 seconds): GDM's automatic sign-in can lose a race at start
// (NVIDIA graphics with Wayland are known for it) and fall back to the sign-in screen, which timed sign-in then signs in from
// by itself. xorg: the sign-in screen (and so the desktop) use Xorg instead of Wayland, the usual cure for that race.
function gdmConfig(text, user, { xorg = false } = {}) {
    const lines = String(text || '').split('\n');
    const out = [];
    let skipping = false;
    for (const line of lines) {
        if (line.trim() === MARK_BEGIN) { skipping = true; continue; }
        if (line.trim() === MARK_END) { skipping = false; continue; }
        if (!skipping) out.push(line);
    }
    // Settings of the file's own that would fight ours are commented out while ours are there, and put back after
    let cleaned = out.map(l => (l.startsWith(OFF_TAG) ? l.slice(OFF_TAG.length) : l));
    if (!user) return cleaned.join('\n');
    const fights = xorg ? /^\s*(AutomaticLogin(Enable)?|TimedLogin(Enable|Delay)?|WaylandEnable)\s*=/i : /^\s*(AutomaticLogin(Enable)?|TimedLogin(Enable|Delay)?)\s*=/i;
    cleaned = cleaned.map(l => (fights.test(l) ? `${OFF_TAG}${l}` : l));
    const block = [MARK_BEGIN, 'AutomaticLoginEnable=true', `AutomaticLogin=${user}`, 'TimedLoginEnable=true', `TimedLogin=${user}`, 'TimedLoginDelay=3', ...(xorg ? ['WaylandEnable=false'] : []), MARK_END];
    const at = cleaned.findIndex(l => l.trim().toLowerCase() === '[daemon]');
    if (at >= 0) cleaned.splice(at + 1, 0, ...block);
    else cleaned = ['[daemon]', ...block, '', ...cleaned];
    return cleaned.join('\n');
}
const lightdmConfig = user => `${MARK_BEGIN}\n[Seat:*]\nautologin-user=${user}\nautologin-user-timeout=0\n${MARK_END}\n`;
// SDDM (Kubuntu and other KDE systems) needs the desktop session to start as well
const sddmConfig = (user, session) => `${MARK_BEGIN}\n[Autologin]\nUser=${user}\n${session ? `Session=${session}.desktop\n` : ''}Relogin=false\n${MARK_END}\n`;

const quoteDesktop = s => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;

function desktopEntry(command) {
    return `[Desktop Entry]\nType=Application\nName=Emulator Menu\nComment=Starts the Emulator Menu when the computer starts (kiosk mode)\nExec=${command}\nTerminal=false\nX-GNOME-Autostart-enabled=true\nX-GNOME-Autostart-Delay=0\n`;
}

// The command that starts this menu again: the AppImage, or the app run by Electron from a source checkout
function appCommand({ env = process.env, execPath = process.execPath, electron = !!process.versions.electron, root = path.resolve(__dirname, '..', '..') } = {}) {
    if (env.APPIMAGE) return `${quoteDesktop(env.APPIMAGE)} --fullscreen`;
    if (electron) return `${quoteDesktop(execPath)} ${quoteDesktop(root)} --no-sandbox --fullscreen`;
    return null;
}

function createSystem({
    platform = process.platform === 'win32' ? 'win32' : 'linux', home = os.homedir(), user = os.userInfo().username, configDir,
    exists = fs.existsSync, read = file => fs.readFileSync(file, 'utf8'), execImpl = childProcess.execFile, spawnImpl = childProcess.spawn,
    command = () => appCommand(), tmpdir = os.tmpdir(), env = process.env
} = {}) {
    const linux = platform === 'linux';
    const autostartFile = path.join(home, '.config', 'autostart', 'emulator-menu.desktop');
    const stateFile = path.join(configDir || path.join(home, '.config', 'all-in-one-emulator'), 'kiosk-state.json');

    const run = (file, args) => new Promise(resolve => execImpl(file, args, { timeout: 10000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() })));

    // Restart, shut down or sleep. Resolves {ok} once the system took it, or {ok: false, admin, message}: Ubuntu lets the
    // signed-in person do these without a password only while theirs is the one session (the sign-in screen's own session,
    // or a program holding a block on it, can count against that), and otherwise wants the administrator, which systemctl
    // would ask for in a dialog the full-screen menu may hide. So it is asked not to ask (--no-ask-password) and says so;
    // with asAdmin it runs as the administrator (the password from the menu's keyboard, see lib/admin.js).
    function power(action, { asAdmin = false } = {}) {
        if (!['restart', 'shutdown', 'sleep'].includes(action)) return Promise.reject(new Error('Unknown power action'));
        if (platform === 'win32') {
            const [file, args] = action === 'sleep' ? ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']] : ['shutdown', [action === 'restart' ? '/r' : '/s', '/t', '0']];
            const child = spawnImpl(file, args, { detached: true, stdio: 'ignore' });
            if (child && child.unref) child.unref();
            if (child && child.on) child.on('error', () => {});
            return Promise.resolve({ ok: true });
        }
        const verb = { restart: 'reboot', shutdown: 'poweroff', sleep: 'suspend' }[action];
        return new Promise(resolve => {
            const child = asAdmin ? admin.spawn(spawnImpl, `systemctl ${verb}`) : spawnImpl('systemctl', ['--no-ask-password', verb], { stdio: ['ignore', 'pipe', 'pipe'] });
            let text = '';
            const keep = d => { text += String(d); };
            if (child.stdout) child.stdout.on('data', keep);
            if (child.stderr) child.stderr.on('data', keep);
            // a restart that goes ahead may never answer: the menu is closed with everything else
            const quiet = setTimeout(() => resolve({ ok: true }), 5000);
            child.on('error', err => { clearTimeout(quiet); resolve({ ok: false, message: err.message }); });
            child.on('close', code => {
                clearTimeout(quiet);
                if (code === 0) return resolve({ ok: true });
                const why = text.trim().split('\n').pop() || `exit code ${code}`;
                const needsAdmin = !asAdmin && /interactive authentication required|access denied|not authorized|inhibit|other users/i.test(text);
                resolve({ ok: false, admin: needsAdmin, message: needsAdmin ? 'The computer wants the administrator password for this.' : `It did not work: ${why}` });
            });
        });
    }

    // The sign-in screen this computer starts: the one /etc/X11/default-display-manager names when it says (a computer can
    // have several installed, and writing the one that does not run changes nothing), else the first one found
    function displayManager() {
        let active = '';
        try { if (exists('/etc/X11/default-display-manager')) active = path.basename(read('/etc/X11/default-display-manager').trim()); } catch { /* not said */ }
        const gdm = GDM_FILES.find(f => exists(f));
        if (/^gdm/.test(active) && gdm) return { name: 'gdm', file: gdm };
        if (active === 'lightdm') return { name: 'lightdm', file: LIGHTDM_FILE };
        if (active === 'sddm') return { name: 'sddm', file: SDDM_FILE };
        if (gdm) return { name: 'gdm', file: gdm };
        if (exists('/etc/lightdm')) return { name: 'lightdm', file: LIGHTDM_FILE };
        if (exists('/etc/sddm.conf.d') || exists('/etc/sddm.conf')) return { name: 'sddm', file: SDDM_FILE };
        return null;
    }

    const autologinOn = dm => {
        if (!dm) return false;
        try { return dm.name === 'gdm' ? read(dm.file).includes(MARK_BEGIN) : exists(dm.file); } catch { return false; }
    };

    function status() {
        if (!linux) return { supported: false, reason: 'Kiosk mode is set up for Ubuntu (Linux) only' };
        const dm = displayManager();
        const autologin = autologinOn(dm);
        const autostart = exists(autostartFile);
        return { supported: true, displayManager: dm ? dm.name : null, autologin, autostart, enabled: autologin && autostart, user, canStart: !!command() };
    }

    // Runs a script as an administrator through the system's password prompt
    function asAdmin(script, onLine) {
        return new Promise(resolve => {
            const child = admin.spawn(spawnImpl, script);
            const feed = d => String(d).split(/[\r\n]+/).filter(Boolean).forEach(onLine);
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', err => { onLine(err.code === 'ENOENT' ? 'pkexec is not available on this system' : err.message); resolve(127); });
            child.on('close', resolve);
        });
    }

    // Writes (or removes) the display manager's automatic sign-in
    async function setAutologin(dm, on, onLine, { xorg = false } = {}) {
        const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
        let script;
        if (dm.name === 'sddm') {
            if (on) {
                const tmp = path.join(fs.mkdtempSync(path.join(tmpdir, 'kiosk-')), 'kiosk.conf');
                fs.writeFileSync(tmp, sddmConfig(user, env.DESKTOP_SESSION || null));
                script = `mkdir -p ${q(SDDM_DIR)} ; cp ${q(tmp)} ${q(SDDM_FILE)}`;
            } else script = `rm -f ${q(SDDM_FILE)}`;
        } else if (dm.name === 'gdm') {
            const next = gdmConfig(exists(dm.file) ? read(dm.file) : '', on ? user : null, { xorg });
            const tmp = path.join(fs.mkdtempSync(path.join(tmpdir, 'kiosk-')), 'custom.conf');
            fs.writeFileSync(tmp, next);
            script = `cp -n ${q(dm.file)} ${q(dm.file + '.emulator-menu.bak')} ; cp ${q(tmp)} ${q(dm.file)}`;
        } else if (on) {
            const tmp = path.join(fs.mkdtempSync(path.join(tmpdir, 'kiosk-')), 'kiosk.conf');
            fs.writeFileSync(tmp, lightdmConfig(user));
            script = `mkdir -p ${q(LIGHTDM_DIR)} ; cp ${q(tmp)} ${q(LIGHTDM_FILE)}`;
        } else script = `rm -f ${q(LIGHTDM_FILE)}`;
        onLine('Asking for permission to change the sign-in settings…');
        const code = await asAdmin(script, onLine);
        if (code === 126) throw new Error('The password prompt was cancelled');
        if (code === 127) throw new Error('Could not ask for permission (pkexec is missing)');
        if (code !== 0) throw new Error(`Changing the sign-in settings failed (code ${code})`);
    }

    async function setDesktopSettings(on, onLine) {
        let saved = {};
        try { saved = JSON.parse(read(stateFile)); } catch { /* nothing saved yet */ }
        if (on) {
            const before = { ...saved };
            for (const [schema, key, value] of GNOME_SETTINGS) {
                const id = `${schema} ${key}`;
                const cur = await run('gsettings', ['get', schema, key]);
                if (!cur.ok) continue;                                   // not GNOME, or no such setting: skip it
                if (!(id in before)) before[id] = cur.out;
                await run('gsettings', ['set', schema, key, value]);
            }
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            fs.writeFileSync(stateFile, JSON.stringify(before, null, 2));
            onLine('Screen lock and sleep are off');
        } else {
            for (const [id, value] of Object.entries(saved)) {
                const [schema, key] = id.split(' ');
                await run('gsettings', ['set', schema, key, value]);
            }
            fs.rmSync(stateFile, { force: true });
            onLine('Screen lock and sleep are back as they were');
        }
    }

    async function enable({ onLine = () => {} } = {}) {
        if (!linux) throw new Error('Kiosk mode is set up for Ubuntu (Linux) only');
        const cmd = command();
        if (!cmd) throw new Error('Start the menu as the app (npm start, or the AppImage) to set up kiosk mode');
        const dm = displayManager();
        if (!dm) throw new Error('This system’s sign-in screen is not one the menu knows (GDM, LightDM or SDDM), so it cannot sign in by itself. Set automatic login in the system settings');
        // The part that can be refused comes first, so nothing is left half done
        await setAutologin(dm, true, onLine);
        fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
        fs.writeFileSync(autostartFile, desktopEntry(cmd));
        onLine('The menu will start when the computer does');
        await setDesktopSettings(true, onLine);
        onLine('Kiosk mode is on. From the next start the computer signs in by itself and opens the menu');
        return status();
    }

    async function disable({ onLine = () => {} } = {}) {
        if (!linux) throw new Error('Kiosk mode is set up for Ubuntu (Linux) only');
        fs.rmSync(autostartFile, { force: true });
        await setDesktopSettings(false, onLine);
        const dm = displayManager();
        if (dm && autologinOn(dm)) await setAutologin(dm, false, onLine);
        onLine('Kiosk mode is off. The computer asks for a password at the next start again');
        return status();
    }

    // What could still stop the next start from going straight into the menu without a keyboard:
    //   encrypted   the disk is encrypted: its passphrase is asked before Ubuntu starts (nothing can skip that but removing it)
    //   wifi        Wi-Fi networks whose password is kept in the signed-in person's keyring: after an automatic sign-in the
    //               keyring is locked, so the network cannot connect (or asks for it). fixWifi stores it for the computer.
    async function nextStart() {
        if (!linux) return null;
        const st = status();
        const blk = await run('lsblk', ['-nro', 'TYPE']);
        const encrypted = blk.ok && /^crypt$/m.test(blk.out);
        const wifi = [];
        const act = await run('nmcli', ['-t', '-f', 'TYPE,NAME', 'connection', 'show']);
        for (const line of act.ok ? act.out.split('\n') : []) {
            const at = line.indexOf(':');
            if (at < 0 || line.slice(0, at) !== '802-11-wireless') continue;
            const name = line.slice(at + 1).replace(/\\(.)/g, '$1');
            const flags = await run('nmcli', ['-g', '802-11-wireless-security.psk-flags', 'connection', 'show', 'id', name]);
            if (flags.ok && /^1\b/.test(flags.out)) wifi.push(name);      // 1: "agent-owned", kept in the keyring
        }
        return { autologin: st.autologin, autostart: st.autostart, encrypted, wifi };
    }

    // Stores a Wi-Fi network's password for the whole computer (not in the keyring), so it connects before anyone signs in.
    // The password is typed on the menu's keyboard: reading it from a locked keyring would put up the very box this avoids.
    async function fixWifi(name, psk, { onLine = () => {} } = {}) {
        if (typeof name !== 'string' || !name || typeof psk !== 'string' || psk.length < 8 || psk.length > 63) throw new Error('A Wi-Fi password has 8 to 63 characters');
        const q = v => `'${String(v).replace(/'/g, "'\\''")}'`;
        const code = await asAdmin(`nmcli connection modify id ${q(name)} 802-11-wireless-security.psk-flags 0 802-11-wireless-security.psk ${q(psk)}`, onLine);
        if (code !== 0) throw new Error(code === 126 ? 'The administrator password was not accepted' : `The Wi-Fi network could not be changed (code ${code})`);
        return true;
    }

    // Why the computer might still show the sign-in screen with kiosk mode on, from the computer itself: which sign-in screen
    // really runs (systemd's display-manager service) against the one the menu wrote, what that file says, NVIDIA graphics
    // with Wayland (a known reason GDM's automatic sign-in falls back to the sign-in screen), an encrypted home folder
    // (cannot be opened without the password), and what the sign-in screen itself logged about it at this start.
    async function loginDiagnosis() {
        if (!linux) return null;
        const unit = (await run('systemctl', ['show', '-p', 'Id', '--value', 'display-manager.service'])).out;
        const running = /gdm/.test(unit) ? 'gdm' : /lightdm/.test(unit) ? 'lightdm' : /sddm/.test(unit) ? 'sddm' : null;
        const dm = displayManager();
        let text = '';
        try { if (dm && exists(dm.file)) text = read(dm.file); } catch { /* cannot read it */ }
        const block = text.includes(MARK_BEGIN) ? text.slice(text.indexOf(MARK_BEGIN), text.indexOf(MARK_END) + MARK_END.length) : '';
        const journal = unit ? await run('journalctl', ['-b', '-q', '--no-pager', '-o', 'cat', '-u', unit, '-n', '400']) : { ok: false, out: '' };
        const log = journal.ok ? journal.out.split('\n').filter(l => /autolog|automatic|timed|login.*fail|fail.*login|session.*(fail|error)|nvidia/i.test(l)).slice(-8) : [];
        return {
            running, configured: dm ? dm.name : null, file: dm ? dm.file : null,
            mismatch: !!(running && dm && running !== dm.name),
            autologin: /AutomaticLogin=/.test(block) || (dm && dm.name !== 'gdm' && !!text),
            timed: /TimedLoginEnable=true/.test(block),
            nvidia: exists('/sys/module/nvidia'),
            wayland: dm && dm.name === 'gdm' ? !/^\s*WaylandEnable\s*=\s*false/im.test(text) : null,
            ecryptfs: exists(path.join('/home/.ecryptfs', user)),
            log, logReadable: journal.ok
        };
    }

    // Writes automatic sign-in again, with the timed sign-in backup, for the sign-in screen that really runs; xorg as above
    async function repairLogin({ xorg = false, onLine = () => {} } = {}) {
        if (!linux) throw new Error('Kiosk mode is set up for Ubuntu (Linux) only');
        const dm = displayManager();
        if (!dm) throw new Error('This system’s sign-in screen is not one the menu knows (GDM, LightDM or SDDM)');
        await setAutologin(dm, true, onLine, { xorg });
        onLine(xorg ? 'Automatic sign-in written again, with the sign-in screen on Xorg' : 'Automatic sign-in written again');
        return loginDiagnosis();
    }

    return { power, status, enable, disable, autostartFile, displayManager, nextStart, fixWifi, loginDiagnosis, repairLogin };
}

module.exports = { sddmConfig, createSystem, gdmConfig, lightdmConfig, desktopEntry, appCommand, GNOME_SETTINGS, MARK_BEGIN, MARK_END };
