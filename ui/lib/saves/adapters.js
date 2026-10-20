// How each emulator is given its own, separate save data for one slot.
//
// The trick is a per-slot data root: a folder that links back to the emulator's real data folder for
// everything (settings, firmware, keys, caches) except the few folders that hold game saves, which are
// real folders owned by the slot. The emulator is started pointed at that root (Ryujinx: -r, Dolphin: -u),
// so each slot is a complete, isolated set of saves and no game files need to be located or parsed.
//
// Linux: the emulators are Flatpaks, and the roots live inside each Flatpak's own data folder so the sandbox can
// see them and their links. Windows: the emulators keep their data in %APPDATA% (or beside the program when it
// is portable) and the roots live in the menu's own folder. Windows does not let ordinary users make symbolic
// links, so folders are linked with junctions (no special rights needed) and single files are copied.
const fs = require('fs');
const os = require('os');
const path = require('path');
const platformLib = require('../platform');

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

const sameTarget = (a, b) => path.resolve(String(a).replace(/^\\\\\?\\/, '')) === path.resolve(b);

// Makes `link` give access to `target`
function linkEntry(target, link, win) {
    let existing = null;
    try { existing = fs.lstatSync(link); } catch { /* not there yet */ }
    const isDir = fs.statSync(target).isDirectory();
    if (existing) {
        if (existing.isSymbolicLink()) {
            if (isDir && sameTarget(fs.readlinkSync(link), target)) return;
            fs.rmSync(link);
        } else if (win && !isDir) {
            fs.rmSync(link);                       // an earlier copy of a file: refresh it
        } else {
            return;                                // something the emulator made inside the slot: leave it
        }
    }
    if (isDir) fs.symlinkSync(target, link, win ? 'junction' : 'dir');
    else if (win) fs.copyFileSync(target, link);
    else fs.symlinkSync(target, link);
}

// Links every entry of realDir into slotDir except the named ones
function linkExcept(realDir, slotDir, except, win = platformLib.current() === 'win32') {
    mkdir(slotDir);
    let names = [];
    try { names = fs.readdirSync(realDir); } catch { return; }
    for (const name of names) {
        if (except.includes(name)) continue;
        try { linkEntry(path.join(realDir, name), path.join(slotDir, name), win); } catch (err) {
            if (!(win && err.code === 'EBUSY')) throw err;   // a copied file the emulator has open: keep the old copy
        }
    }
}

const hasFiles = dir => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).some(e => !e.isDirectory() || hasFiles(path.join(dir, e.name))); } catch { return false; }
};

// Which of the save folders under `root` hold something
function existingIn(root, perSlot) {
    return perSlot.map(rel => ({ rel, abs: path.join(root, rel) })).filter(x => hasFiles(x.abs));
}

const firstRun = name => Object.assign(new Error(`Open ${name} once from Settings first, so it can create its folders`), { code: 'FIRST_RUN' });
const appData = ctx => ctx.env.APPDATA || path.join(ctx.home, 'AppData', 'Roaming');

function ryujinx(ctx) {
    const win = ctx.platform === 'win32';
    const perSlot = [path.join('bis', 'user', 'save'), path.join('bis', 'user', 'saveMeta'), path.join('bis', 'system', 'save')];

    // The emulator's real data folder: Flatpak config on Linux, %APPDATA%\Ryujinx (or "portable" beside the program) on Windows
    function realRoot() {
        if (!win) return path.join(ctx.home, '.var', 'app', 'io.github.ryubing.Ryujinx', 'config', 'Ryujinx');
        const exe = ctx.exePath('ryujinx');
        const portable = exe && path.join(path.dirname(exe), 'portable');
        return portable && fs.existsSync(portable) ? portable : path.join(appData(ctx), 'Ryujinx');
    }
    const slotsBase = () => (win
        ? path.join(ctx.menuDir, 'slots', 'ryujinx')
        : path.join(ctx.home, '.var', 'app', 'io.github.ryubing.Ryujinx', 'data', 'emulator-menu-slots'));

    return {
        id: 'ryujinx',
        perSlot,
        dataRoot: realRoot,
        slotRoot: slotId => path.join(slotsBase(), slotId),
        args: slotRoot => ['-r', slotRoot],
        // The saves the emulator already had before slots existed: [{rel, abs}] for each save folder that has files in it
        existing: () => existingIn(realRoot(), perSlot),
        assemble(slotRoot) {
            const real = realRoot();
            if (!fs.existsSync(real)) throw firstRun('Ryujinx');
            linkExcept(real, slotRoot, ['bis'], win);
            linkExcept(path.join(real, 'bis'), path.join(slotRoot, 'bis'), ['user', 'system'], win);
            linkExcept(path.join(real, 'bis', 'user'), path.join(slotRoot, 'bis', 'user'), ['save', 'saveMeta'], win);
            linkExcept(path.join(real, 'bis', 'system'), path.join(slotRoot, 'bis', 'system'), ['save'], win);
            for (const d of perSlot) mkdir(path.join(slotRoot, d));
        }
    };
}

// Where Dolphin keeps its user folder on Windows: %APPDATA%\Dolphin Emulator, or "User" beside a portable copy
function dolphinWindowsUser(ctx) {
    const exe = ctx.exePath('dolphin');
    if (exe && fs.existsSync(path.join(path.dirname(exe), 'portable.txt'))) return path.join(path.dirname(exe), 'User');
    return path.join(appData(ctx), 'Dolphin Emulator');
}

function dolphin(ctx) {
    const win = ctx.platform === 'win32';
    const perSlot = ['GC', path.join('Wii', 'title', '00010000')];
    const flatpakApp = path.join(ctx.home, '.var', 'app', 'org.DolphinEmu.dolphin-emu');
    const slotsBase = () => (win ? path.join(ctx.menuDir, 'slots', 'dolphin') : path.join(flatpakApp, 'data', 'emulator-menu-slots'));

    function link(target, at) {
        mkdir(target);
        linkEntry(target, at, win);
    }

    return {
        id: 'dolphin',
        perSlot,
        slotRoot: slotId => path.join(slotsBase(), slotId),
        args: slotRoot => ['-u', slotRoot],
        existing: () => existingIn(win ? dolphinWindowsUser(ctx) : path.join(flatpakApp, 'data', 'dolphin-emu'), perSlot),
        assemble(slotRoot) {
            mkdir(slotRoot);
            if (win) {
                const user = dolphinWindowsUser(ctx);
                if (!fs.existsSync(user)) throw firstRun('Dolphin');
                linkExcept(user, slotRoot, ['GC', 'Wii'], win);       // Config, Cache, Load ... stay shared
                linkExcept(path.join(user, 'Wii'), path.join(slotRoot, 'Wii'), ['title'], win);
                linkExcept(path.join(user, 'Wii', 'title'), path.join(slotRoot, 'Wii', 'title'), ['00010000'], win);
            } else {
                const data = path.join(flatpakApp, 'data', 'dolphin-emu');
                link(path.join(flatpakApp, 'config', 'dolphin-emu'), path.join(slotRoot, 'Config'));
                link(path.join(flatpakApp, 'cache', 'dolphin-emu'), path.join(slotRoot, 'Cache'));
                linkExcept(data, slotRoot, ['GC', 'Wii', 'Config', 'Cache'], win);
                linkExcept(path.join(data, 'Wii'), path.join(slotRoot, 'Wii'), ['title'], win);
                linkExcept(path.join(data, 'Wii', 'title'), path.join(slotRoot, 'Wii', 'title'), ['00010000'], win);
            }
            for (const d of perSlot) mkdir(path.join(slotRoot, d));
        }
    };
}

// emulator id -> adapter. `context` is a home folder, or {platform, home, env, menuDir, exePath(id)}.
function create(context = os.homedir()) {
    const c = typeof context === 'string' ? { home: context } : context;
    const platform = c.platform || platformLib.current();
    const home = c.home || os.homedir();
    const env = c.env || process.env;
    const ctx = { platform, home, env, menuDir: c.menuDir || platformLib.configDir({ platform, env, home }), exePath: c.exePath || (() => null) };
    return new Map([ryujinx(ctx), dolphin(ctx)].map(a => [a.id, a]));
}

module.exports = { create, linkExcept, dolphinWindowsUser };
