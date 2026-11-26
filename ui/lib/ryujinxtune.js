// Ryujinx settings for smoother play, written into its Config.json before each Switch game while the menu's
// "Smoother Switch games" option is on (Settings → Emulators). Checked against Ryubing's source
// (src/Ryujinx/Systems/Configuration/ConfigurationFileFormat.cs, AppHost.cs).
//
// What a computer with plenty of memory can do about stutter in Ryujinx:
//   gclow_latency       Ryujinx is a .NET program, and .NET stops it for a moment from time to time to collect unused memory
//                       (a "garbage collection"). In low-latency mode, the big collections are put off while a game plays (Ryujinx
//                       turns it off again when the game is paused or stopped), so those pauses go away and Ryujinx uses
//                       more memory instead. This is the one setting that uses spare memory to stop stutter.
//   enable_shader_cache Shaders the game has used before are kept on disk and loaded at the start, instead of being built again
//                       the moment something new appears on screen. Most of the stutter "while moving through a level" is
//                       a new shader being built: it goes away as you play, and stays away the next time.
//   enable_ptc          The same for the game's own code, translated for this computer's processor (PPTC)
//   enable_low_power_ptc  false: load that cache with every processor core, not a few
//   logging_*           Debug, trace and graphics-debug logs write to disk all the time; the normal ones stay
//
// Only keys the file already has are changed: their names and values differ between Ryujinx versions, and a key an older
// version does not know means nothing to it.
const fs = require('fs');
const path = require('path');

const TUNE = {
    gclow_latency: true,
    enable_shader_cache: true,
    enable_ptc: true,
    enable_low_power_ptc: false,
    logging_enable_debug: false,
    logging_enable_trace: false,
    logging_enable_fs_access_log: false,
    logging_graphics_debug_level: 'None'
};

// Changes Config.json in `root` (Ryujinx's real data folder). Returns the keys it changed; never throws.
function apply(root) {
    const file = path.join(root, 'Config.json');
    try {
        const text = fs.readFileSync(file, 'utf8');
        const config = JSON.parse(text);
        const changed = Object.entries(TUNE).filter(([k, v]) => Object.prototype.hasOwnProperty.call(config, k) && config[k] !== v).map(([k]) => k);
        if (!changed.length) return [];
        for (const k of changed) config[k] = TUNE[k];
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
        fs.renameSync(tmp, file);
        return changed;
    } catch {
        return [];
    }
}

module.exports = { apply, TUNE };
