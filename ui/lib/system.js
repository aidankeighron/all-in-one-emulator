// The computer itself: restart and shut down (Windows and Linux), and kiosk mode (Ubuntu): the computer starts, signs in by
// itself with no password, opens the menu full screen and never locks or sleeps. All of it can be undone from the menu.
//
// Kiosk mode is three things, written in this order:
//   1. an autostart entry in the user's own folder that starts the menu when the desktop comes up (no permission needed)
//   2. the desktop's lock screen, screen blanking and sleep switched off (the old values are kept and put back)
//   3. automatic sign-in in the display manager (GDM on Ubuntu, or LightDM): the only part that needs an administrator,
//      done through the system's password prompt (pkexec) once, with the original file kept next to it
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const MARK_BEGIN = '# emulator-menu kiosk: begin';
const MARK_END = '# emulator-menu kiosk: end';
const OFF_TAG = '#emulator-menu kiosk, was: ';
const GDM_FILES = ['/etc/gdm3/custom.conf', '/etc/gdm/custom.conf'];
const LIGHTDM_DIR = '/etc/lightdm/lightdm.conf.d';
const LIGHTDM_FILE = `${LIGHTDM_DIR}/50-emulator-menu-kiosk.conf`;

// What the desktop does by itself that a kiosk must not: [schema, key, value to set]
const GNOME_SETTINGS = [
    ['org.gnome.desktop.screensaver', 'lock-enabled', 'false'],
    ['org.gnome.desktop.session', 'idle-delay', 'uint32 0'],
    ['org.gnome.settings-daemon.plugins.power', 'sleep-inactive-ac-type', "'nothing'"],
    ['org.gnome.settings-daemon.plugins.power', 'sleep-inactive-battery-type', "'nothing'"]
];

// ---------- pure helpers (tested without touching the system) ----------

// GDM's custom.conf with automatic sign-in on (user) or off (null). Only the block between the markers is ever ours.
function gdmConfig(text, user) {
    const lines = String(text || '').split('\n');
    const out = [];
    let skipping = false;
    for (const line of lines) {
        if (line.trim() === MARK_BEGIN) { skipping = true; continue; }
        if (line.trim() === MARK_END) { skipping = false; continue; }
        if (!skipping) out.push(line);
    }
    // Any automatic sign-in the file already has would fight ours: it is commented out while ours is there, and put back after
    let cleaned = out.map(l => {
        if (user && /^\s*AutomaticLogin(Enable)?\s*=/i.test(l)) return `${OFF_TAG}${l}`;
        if (!user && l.startsWith(OFF_TAG)) return l.slice(OFF_TAG.length);
        return l;
    });
    if (!user) return cleaned.join('\n');
    const block = [MARK_BEGIN, 'AutomaticLoginEnable=true', `AutomaticLogin=${user}`, MARK_END];
    const at = cleaned.findIndex(l => l.trim().toLowerCase() === '[daemon]');
    if (at >= 0) cleaned.splice(at + 1, 0, ...block);
    else cleaned = ['[daemon]', ...block, '', ...cleaned];
    return cleaned.join('\n');
}

const lightdmConfig = user => `${MARK_BEGIN}\n[Seat:*]\nautologin-user=${user}\nautologin-user-timeout=0\n${MARK_END}\n`;

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
    command = () => appCommand(), tmpdir = os.tmpdir()
} = {}) {
    const linux = platform === 'linux';
    const autostartFile = path.join(home, '.config', 'autostart', 'emulator-menu.desktop');
    const stateFile = path.join(configDir || path.join(home, '.config', 'all-in-one-emulator'), 'kiosk-state.json');

    const run = (file, args) => new Promise(resolve => execImpl(file, args, { timeout: 10000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() })));

    // Restart or shut down. Both run for a signed-in person without a password (Ubuntu and Windows).
    function power(action) {
        if (!['restart', 'shutdown'].includes(action)) throw new Error('Unknown power action');
        const [file, args] = platform === 'win32'
            ? ['shutdown', [action === 'restart' ? '/r' : '/s', '/t', '0']]
            : ['systemctl', [action === 'restart' ? 'reboot' : 'poweroff']];
        const child = spawnImpl(file, args, { detached: true, stdio: 'ignore' });
        if (child && child.unref) child.unref();
        if (child && child.on) child.on('error', () => {});
        return true;
    }

    function displayManager() {
        const gdm = GDM_FILES.find(f => exists(f));
        if (gdm) return { name: 'gdm', file: gdm };
        if (exists('/etc/lightdm')) return { name: 'lightdm', file: LIGHTDM_FILE };
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
            const child = spawnImpl('pkexec', ['sh', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
            const feed = d => String(d).split(/[\r\n]+/).filter(Boolean).forEach(onLine);
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', err => { onLine(err.code === 'ENOENT' ? 'pkexec is not available on this system' : err.message); resolve(127); });
            child.on('close', resolve);
        });
    }

    // Writes (or removes) the display manager's automatic sign-in
    async function setAutologin(dm, on, onLine) {
        const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
        let script;
        if (dm.name === 'gdm') {
            const next = gdmConfig(exists(dm.file) ? read(dm.file) : '', on ? user : null);
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
        if (!dm) throw new Error('This system’s sign-in screen is not one the menu knows (GDM or LightDM), so it cannot sign in by itself. Set automatic login in the system settings');
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

    return { power, status, enable, disable, autostartFile, displayManager };
}

module.exports = { createSystem, gdmConfig, lightdmConfig, desktopEntry, appCommand, GNOME_SETTINGS, MARK_BEGIN, MARK_END };
