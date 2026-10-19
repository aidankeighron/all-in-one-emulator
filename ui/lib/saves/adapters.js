// How each emulator is given its own, separate save data for one slot.
//
// The trick is a per-slot data root: a folder that links back to the emulator's real data folder for
// everything (settings, firmware, keys, caches) except the few folders that hold game saves, which are
// real folders owned by the slot. The emulator is started pointed at that root (Ryujinx: -r, Dolphin: -u),
// so each slot is a complete, isolated set of saves and no game files need to be located or parsed.
//
// The roots live inside each Flatpak's own data folder so the sandbox can see them and their links.
const fs = require('fs');
const path = require('path');

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

// Links every entry of realDir into slotDir except the named ones
function linkExcept(realDir, slotDir, except) {
    mkdir(slotDir);
    let names = [];
    try { names = fs.readdirSync(realDir); } catch { return; }
    for (const name of names) {
        if (except.includes(name)) continue;
        const target = path.join(realDir, name);
        const link = path.join(slotDir, name);
        let existing = null;
        try { existing = fs.lstatSync(link); } catch { /* not there yet */ }
        if (existing) {
            if (!existing.isSymbolicLink() || fs.readlinkSync(link) === target) continue;
            fs.rmSync(link);
        }
        fs.symlinkSync(target, link);
    }
}

function ryujinx(home) {
    const app = path.join(home, '.var', 'app', 'io.github.ryubing.Ryujinx');
    const real = path.join(app, 'config', 'Ryujinx');
    const base = path.join(app, 'data', 'emulator-menu-slots');
    const perSlot = [path.join('bis', 'user', 'save'), path.join('bis', 'user', 'saveMeta'), path.join('bis', 'system', 'save')];
    return {
        id: 'ryujinx',
        perSlot,
        slotRoot: slotId => path.join(base, slotId),
        args: slotRoot => ['-r', slotRoot],
        assemble(slotRoot) {
            if (!fs.existsSync(real)) {
                throw Object.assign(new Error('Open Ryujinx once from Settings first, so it can create its folders'), { code: 'FIRST_RUN' });
            }
            linkExcept(real, slotRoot, ['bis']);
            linkExcept(path.join(real, 'bis'), path.join(slotRoot, 'bis'), ['user', 'system']);
            linkExcept(path.join(real, 'bis', 'user'), path.join(slotRoot, 'bis', 'user'), ['save', 'saveMeta']);
            linkExcept(path.join(real, 'bis', 'system'), path.join(slotRoot, 'bis', 'system'), ['save']);
            for (const d of perSlot) mkdir(path.join(slotRoot, d));
        }
    };
}

function dolphin(home) {
    const app = path.join(home, '.var', 'app', 'org.DolphinEmu.dolphin-emu');
    const realData = path.join(app, 'data', 'dolphin-emu');
    const realConfig = path.join(app, 'config', 'dolphin-emu');
    const realCache = path.join(app, 'cache', 'dolphin-emu');
    const base = path.join(app, 'data', 'emulator-menu-slots');
    const perSlot = ['GC', path.join('Wii', 'title', '00010000')];
    const link = (target, at) => {
        let existing = null;
        try { existing = fs.lstatSync(at); } catch { /* none */ }
        if (existing && (!existing.isSymbolicLink() || fs.readlinkSync(at) === target)) return;
        if (existing) fs.rmSync(at);
        mkdir(target);
        fs.symlinkSync(target, at);
    };
    return {
        id: 'dolphin',
        perSlot,
        slotRoot: slotId => path.join(base, slotId),
        args: slotRoot => ['-u', slotRoot],
        assemble(slotRoot) {
            mkdir(slotRoot);
            link(realConfig, path.join(slotRoot, 'Config'));
            link(realCache, path.join(slotRoot, 'Cache'));
            linkExcept(realData, slotRoot, ['GC', 'Wii', 'Config', 'Cache']);
            linkExcept(path.join(realData, 'Wii'), path.join(slotRoot, 'Wii'), ['title']);
            linkExcept(path.join(realData, 'Wii', 'title'), path.join(slotRoot, 'Wii', 'title'), ['00010000']);
            for (const d of perSlot) mkdir(path.join(slotRoot, d));
        }
    };
}

// emulator id -> adapter
function create(home) {
    const list = [ryujinx(home), dolphin(home)];
    return new Map(list.map(a => [a.id, a]));
}

module.exports = { create, linkExcept };
