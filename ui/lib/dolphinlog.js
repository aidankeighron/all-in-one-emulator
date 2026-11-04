// Dolphin's own account of what it did with real Wii Remotes (Linux). Before a game the menu turns on Dolphin's Wii Remote
// log (Logger.ini: the "Wiimote" category, written to a file), and after it prints the lines about Wii Remotes from that file,
// so a Wii Remote that does nothing in a game can be traced: found or not, opened or not, why it was let go.
const fs = require('fs');
const path = require('path');
const { Ini, save } = require('./ini');

const ID = 'org.DolphinEmu.dolphin-emu';
const dirs = home => {
    const base = path.join(home, '.var', 'app', ID);
    return { config: path.join(base, 'config', 'dolphin-emu'), logs: ['data', 'config', 'cache'].map(d => path.join(base, d, 'dolphin-emu', 'Logs', 'dolphin.log')) };
};

// Turns on the Wii Remote log in Dolphin's Logger.ini; everything else in the file is kept
function enable({ home, platform }) {
    if (platform === 'win32') return false;
    try {
        const file = path.join(dirs(home).config, 'Logger.ini');
        const ini = Ini.read(file);
        // the category's short name differs between Dolphin versions; an unknown key is ignored
        for (const key of ['Wiimote', 'WIIMOTE']) ini.set('Logs', key, 'True');
        ini.set('Options', 'WriteToFile', 'True');
        if (!Number(ini.get('Options', 'Verbosity')) || Number(ini.get('Options', 'Verbosity')) < 4) ini.set('Options', 'Verbosity', '4');
        save(file, ini);
        return true;
    } catch { return false; }
}

// The latest lines about Wii Remotes from Dolphin's log, written since `since` (ms)
function wiimoteLines({ home, platform }, since = 0, max = 30) {
    if (platform === 'win32') return [];
    for (const file of dirs(home).logs) {
        try {
            if (fs.statSync(file).mtimeMs < since) continue;
            const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
            return lines.filter(l => /wiimote|wii remote|hidapi|bluetooth|\bW\[/i.test(l)).slice(-max);
        } catch { /* not this one */ }
    }
    return [];
}

module.exports = { enable, wiimoteLines };
