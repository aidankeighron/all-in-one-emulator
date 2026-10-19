const fs = require('fs');
const os = require('os');
const path = require('path');

const configFile = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'all-in-one-emulator',
    'config.json'
);

function load() {
    try {
        return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
        return {};
    }
}

function save(cfg) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}

// From a source checkout the ROMs live in <repo>/roms (the original layout);
// the packaged AppImage is read-only, so it defaults to ~/ROMs instead.
function defaultRomsDir() {
    const packaged = __dirname.includes('app.asar') || process.env.APPIMAGE;
    return packaged
        ? path.join(os.homedir(), 'ROMs')
        : path.resolve(__dirname, '..', '..', 'roms');
}

function getRomsDir() {
    return path.resolve(process.env.ROMS_DIR || load().romsDir || defaultRomsDir());
}

function setRomsDir(dir) {
    save({ ...load(), romsDir: path.resolve(dir) });
}

// Auto-configuring emulator controllers before a game starts is on unless turned off
function getAutoControllers() {
    return load().autoControllers !== false;
}

function setAutoControllers(on) {
    save({ ...load(), autoControllers: !!on });
}

const artworkDir = path.join(path.dirname(configFile), 'artwork');

module.exports = { getRomsDir, setRomsDir, getAutoControllers, setAutoControllers, configFile, artworkDir };
