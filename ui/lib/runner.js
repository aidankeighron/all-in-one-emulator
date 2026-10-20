// Finding, starting and stopping emulators. On Linux they are Flatpaks from Flathub and the menu installs them.
// On Windows the menu does not install anything: it finds each emulator's program (a path you chose with
// "Locate", or a folder it knows to look in) and starts that.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const flatpak = require('./flatpak');
const platformLib = require('./platform');

function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Looks for exeName in dir, then in folders inside it (an unzipped emulator often sits in its own folder)
function searchDir(dir, exeName, depth = 2) {
    const direct = path.join(dir, exeName);
    if (isFile(direct)) return direct;
    if (depth <= 0) return null;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const hit = searchDir(path.join(dir, e.name), exeName, depth - 1);
        if (hit) return hit;
    }
    return null;
}

function createRunner({ platform = platformLib.current(), env = process.env, getPaths = () => ({}), emulatorsDir, flatpakImpl = flatpak, spawnImpl = spawn, execImpl = execFile } = {}) {
    const win = platform === 'win32';

    // The program to start for an emulator on Windows, or null if it can't be found
    function exePath(emu) {
        if (!win || !emu || !emu.windows) return null;
        const chosen = getPaths()[emu.id];
        if (chosen && isFile(chosen)) return chosen;
        const dirs = [emulatorsDir && path.join(emulatorsDir, emu.id), emulatorsDir, ...(emu.windows.dirs || []).map(d => platformLib.expandEnv(d, env))].filter(Boolean);
        for (const d of dirs) {
            const hit = searchDir(d, emu.windows.exe);
            if (hit) return hit;
        }
        return null;
    }

    return {
        platform,
        manual: win,   // the menu cannot install emulators here
        exePath,
        available: async () => (win ? true : flatpakImpl.available()),
        isInstalled: async emu => (win ? !!exePath(emu) : flatpakImpl.isInstalled(emu.flatpak)),
        install: (emu, onLine) => flatpakImpl.install(emu.flatpak, onLine),
        uninstall: (emu, onLine) => flatpakImpl.uninstall(emu.flatpak, onLine),
        grantAccess: async (emu, dir) => { if (!win) await flatpakImpl.grantAccess(emu.flatpak, dir); },

        // Starts the emulator; onExit(code, stderrTail) when it ends. Returns the child process.
        launch(emu, args, onExit) {
            if (!win) return flatpakImpl.launch(emu.flatpak, args, onExit);
            const exe = exePath(emu);
            if (!exe) { setImmediate(() => onExit(1, `${emu.name} was not found`)); return { kill() {}, pid: null }; }
            const child = spawnImpl(exe, args, { cwd: path.dirname(exe), stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
            child.on('error', err => onExit(1, err.message));
            child.on('close', code => onExit(code, stderr));
            return child;
        },

        // Last resort when asking nicely did not stop it
        forceKill(emu, child) {
            if (!win) return flatpakImpl.kill(emu.flatpak);
            if (child && child.pid) execImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
        }
    };
}

module.exports = { createRunner, searchDir };
