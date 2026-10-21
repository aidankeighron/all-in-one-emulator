// BetterJoy (Windows): makes Switch Pro Controllers and Joy-Cons look like ordinary Xbox 360 controllers, joining a left and
// a right Joy-Con into one, and serves their motion sensors over the CemuHook (DSU) protocol on port 26760.
// With it running, every emulator sees plain Xbox pads, which is why the menu can treat them like any other controller.
//
// The menu installs and runs it:
//   1. the ViGEmBus driver (what makes the virtual Xbox pads); its installer needs Windows' permission (one prompt)
//   2. BetterJoy itself: the newest release zip, unpacked into the menu's emulators folder
//   3. starting it with the menu (and before every game) once the person has turned it on
// Sources are looked up like the emulators' (lib/emulatorinstall.js); config.json can name a download directly:
//   { "emulatorUrls": { "betterjoy": "https://.../BetterJoy.zip", "vigembus": "C:\\Users\\me\\Downloads\\ViGEmBus_setup.exe" } }
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const installer = require('./emulatorinstall');

const EXE = 'BetterJoyForCemu.exe';
const MOTION_PORT = 26760;

const SOURCES = {
    betterjoy: [{ api: 'https://api.github.com/repos/Davidobot/BetterJoy/releases/latest', asset: '\\.zip$' }],
    vigembus: [{ api: 'https://api.github.com/repos/nefarius/ViGEmBus/releases/latest', asset: '\\.exe$' }]
};

// The settings the menu needs, written only where BetterJoy's own settings file already has the key (the file's format
// differs between versions: XML app settings or JSON)
const WANTED = { ShowAsXInput: 'true', ShowAsDS4: 'false', MotionServer: 'true' };

function applySettings(text) {
    const changed = [];
    let out = text;
    for (const [key, value] of Object.entries(WANTED)) {
        const xml = new RegExp(`(<add\\s+key="${key}"\\s+value=")[^"]*(")`, 'i');
        const json = new RegExp(`("${key}"\\s*:\\s*)(true|false|"[^"]*")`, 'i');
        if (xml.test(out)) { out = out.replace(xml, `$1${value}$2`); changed.push(key); }
        else if (json.test(out)) { out = out.replace(json, `$1${value}`); changed.push(key); }
    }
    return { text: out, changed };
}

// The program inside an unpacked folder (the zip may hold it directly or inside a folder of its own)
function findExe(root, depth = 3) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
    const hit = entries.find(e => e.isFile() && e.name.toLowerCase() === EXE.toLowerCase());
    if (hit) return path.join(root, hit.name);
    if (depth <= 0) return null;
    for (const e of entries.filter(x => x.isDirectory())) {
        const found = findExe(path.join(root, e.name), depth - 1);
        if (found) return found;
    }
    return null;
}

function createBetterJoy({ platform = process.platform === 'win32' ? 'win32' : 'linux', emulatorsDir, env = process.env, getUrls = () => ({}), fetchImpl = globalThis.fetch, execImpl = childProcess.execFile, spawnImpl = childProcess.spawn } = {}) {
    const supported = platform === 'win32';
    const dir = path.join(emulatorsDir || os.tmpdir(), 'betterjoy');
    let child = null;                   // the BetterJoy this menu started (it keeps running when the menu closes, and is found again)

    const driverFile = () => path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'drivers', 'ViGEmBus.sys');
    const driverInstalled = () => supported && fs.existsSync(driverFile());
    const installed = () => supported && !!findExe(dir);

    const run = (file, args) => new Promise(resolve => execImpl(file, args, { windowsHide: true, timeout: 180000 }, (err, stdout) => resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err })));

    async function running() {
        if (!supported) return false;
        const r = await run('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH']);
        return r.ok && r.out.toLowerCase().includes(EXE.toLowerCase());
    }

    async function status() {
        return { supported, driver: driverInstalled(), installed: installed(), running: await running(), motionPort: MOTION_PORT, dir };
    }

    // Downloads a file into a fresh temporary folder; returns its path
    async function fetchFile(id, onLine, extension) {
        onLine('Looking for the latest version…');
        const found = await installer.findDownload({ sources: SOURCES[id], override: getUrls()[id], fetchImpl });
        onLine(`Downloading ${found.name}${found.version ? ` (${found.version})` : ''}…`);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
        const file = path.join(tmp, `download${extension}`);
        let shown = 0;
        await installer.download(found.url, file, {
            fetchImpl,
            onProgress: (got, total) => { const now = Date.now(); if (now - shown > 400) { shown = now; onLine(total ? `Downloading… ${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB` : `Downloading… ${Math.round(got / 1048576)} MB`); } }
        });
        return { file, tmp, found };
    }

    // Step 1: the driver. Windows asks the person's permission once; the installer then runs by itself.
    async function installDriver({ onLine = () => {} } = {}) {
        if (!supported) throw new Error('BetterJoy is only for Windows');
        if (driverInstalled()) { onLine('The driver is already installed'); return { ok: true, restart: false }; }
        const { file, tmp } = await fetchFile('vigembus', onLine, '.exe');
        try {
            onLine('Installing: choose Yes when Windows asks for permission…');
            const quoted = `'${file.replace(/'/g, "''")}'`;
            const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                `try { $p = Start-Process -FilePath ${quoted} -ArgumentList '/passive','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`]);
            if (r.code === 1223) throw new Error('Windows asked for permission and it was not given. Press Install again and choose Yes');
            const restart = r.code === 3010 || r.code === 1641;       // the installer asks for a restart
            if (!driverInstalled()) throw new Error(restart ? 'The driver is installed but Windows has to restart before it is ready. Restart the computer, then open this again' : `The driver installer finished without installing it (code ${r.code})`);
            onLine(restart ? 'Installed: restart the computer once so Windows can start it' : 'Driver installed');
            return { ok: true, restart };
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }

    // Step 2: BetterJoy itself
    async function install({ onLine = () => {} } = {}) {
        if (!supported) throw new Error('BetterJoy is only for Windows');
        const { file, tmp, found } = await fetchFile('betterjoy', onLine, '.zip');
        const staging = `${dir}.new`;
        try {
            onLine('Unpacking…');
            fs.rmSync(staging, { recursive: true, force: true });
            await installer.unzip(file, staging);
            if (!findExe(staging)) throw new Error(`the download did not contain ${EXE}`);
            await stop();
            fs.rmSync(dir, { recursive: true, force: true });
            fs.renameSync(staging, dir);
            const set = configure();
            onLine(set.length ? `Installed (settings: ${set.join(', ')})` : 'Installed');
            return { ok: true, version: found.version };
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }

    // Writes the settings the menu needs into BetterJoy's own settings file. Returns the keys it changed.
    function configure() {
        const exe = findExe(dir);
        if (!exe) return [];
        const folder = path.dirname(exe);
        const changed = [];
        for (const name of fs.readdirSync(folder)) {
            if (!/\.(exe|dll)\.config$|^appsettings\.json$/i.test(name)) continue;
            const file = path.join(folder, name);
            const { text, changed: keys } = applySettings(fs.readFileSync(file, 'utf8'));
            if (keys.length) { fs.writeFileSync(file, text); changed.push(...keys); }
        }
        return changed;
    }

    // Starts BetterJoy if it is not running already
    async function start() {
        if (!supported) throw new Error('BetterJoy is only for Windows');
        const exe = findExe(dir);
        if (!exe) throw new Error('BetterJoy is not installed yet');
        if (await running()) return { started: false };
        child = spawnImpl(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
        child.on && child.on('exit', () => { child = null; });
        child.on && child.on('error', () => { child = null; });
        if (child.unref) child.unref();
        return { started: true };
    }

    async function stop() {
        if (!supported) return;
        child = null;
        await run('taskkill', ['/IM', EXE, '/F']);
    }

    async function uninstall() {
        await stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    return { status, installDriver, install, configure, start, stop, uninstall, running, driverInstalled, installed, dir, supported, name: 'BetterJoy' };
}

module.exports = { createBetterJoy, applySettings, findExe, SOURCES, EXE, MOTION_PORT };
