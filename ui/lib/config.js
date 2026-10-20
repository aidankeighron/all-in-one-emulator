const fs = require('fs');
const os = require('os');
const path = require('path');

const platformLib = require('./platform');

const configFile = path.join(platformLib.configDir(), 'config.json');

function load() {
    try {
        return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
        return {};
    }
}

function save(cfg) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });   // holds the library access keys
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

const clamp01 = (v, fallback) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : fallback);

function getSound() {
    const cfg = load();
    return {
        enabled: cfg.soundEnabled !== false,
        sfxVolume: clamp01(cfg.sfxVolume, 0.7),
        musicVolume: clamp01(cfg.musicVolume, 0.35)
    };
}

// Accepts any of {enabled, sfxVolume, musicVolume}; invalid values are ignored
function setSound(next) {
    const cfg = load();
    if (typeof next.enabled === 'boolean') cfg.soundEnabled = next.enabled;
    if (clamp01(next.sfxVolume, null) !== null) cfg.sfxVolume = next.sfxVolume;
    if (clamp01(next.musicVolume, null) !== null) cfg.musicVolume = next.musicVolume;
    save(cfg);
}

// The repository the menu was cloned from, if it is running from a git checkout
let projectRemote;
function defaultRepoUrl() {
    if (projectRemote === undefined) {
        try {
            projectRemote = require('child_process').execFileSync('git', ['-C', path.resolve(__dirname, '..', '..'), 'remote', 'get-url', 'origin'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
        } catch { projectRemote = ''; }
    }
    return projectRemote;
}

// Cloud saves go to the "saves" branch of this project's own repository: the remote the menu was cloned from,
// or the repository named in package.json when running as a packaged app. (cloudRepoUrl in config.json overrides it.)
function packageRepoUrl() {
    try {
        const repo = require('../../package.json').repository;
        const url = typeof repo === 'string' ? repo : repo && repo.url;
        return url ? String(url).replace(/^git\+/, '') : '';
    } catch { return ''; }
}

function getCloud() {
    const cfg = load();
    const repoUrl = cfg.cloudRepoUrl || defaultRepoUrl() || packageRepoUrl();
    return { enabled: !!repoUrl, repoUrl, deviceName: cfg.deviceName || '' };
}

// Sharing this computer's games, and the other computer whose games to show
function getLibrary() {
    const cfg = load();
    return {
        sharing: { enabled: !!cfg.libShare, port: Number(cfg.libPort) || 8765, key: cfg.libKey || '' },
        remote: { address: cfg.libAddress || '', key: cfg.libRemoteKey || '' }
    };
}

function setLibrary(next) {
    const cfg = load();
    const sh = next.sharing || {};
    if (typeof sh.enabled === 'boolean') cfg.libShare = sh.enabled;
    if (Number.isInteger(sh.port) && sh.port >= 1024 && sh.port <= 65535) cfg.libPort = sh.port;
    if (typeof sh.key === 'string') cfg.libKey = sh.key;
    const rm = next.remote || {};
    if (typeof rm.address === 'string') cfg.libAddress = rm.address.trim();
    if (typeof rm.key === 'string') cfg.libRemoteKey = rm.key.trim();
    save(cfg);
}

const libraryCacheFile = path.join(path.dirname(configFile), 'library-cache.json');

// Windows: where each emulator's program is, when the person chose it with "Locate"
function getEmulatorPaths() {
    return load().emulatorPaths || {};
}

function setEmulatorPath(id, file) {
    const cfg = load();
    cfg.emulatorPaths = { ...cfg.emulatorPaths };
    if (file) cfg.emulatorPaths[id] = file; else delete cfg.emulatorPaths[id];
    save(cfg);
}

// Windows: a folder where unpacked emulators are found without any setup
const emulatorsDir = path.join(path.dirname(configFile), 'emulators');

const artworkDir = path.join(path.dirname(configFile), 'artwork');
const soundsDir = process.env.SOUNDS_DIR || path.join(path.dirname(configFile), 'sounds');

module.exports = { getRomsDir, setRomsDir, getAutoControllers, setAutoControllers, getSound, setSound, getCloud, getLibrary, setLibrary, libraryCacheFile, getEmulatorPaths, setEmulatorPath, emulatorsDir, configFile, artworkDir, soundsDir };
