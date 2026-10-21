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

// How long Back + Start is held in a game to open the pause menu: 0 to 2 seconds in half-second steps
const PAUSE_HOLD_STEPS = [0, 0.5, 1, 1.5, 2];
function getPauseHold() {
    const v = Number(load().pauseHold);
    return load().pauseHold !== undefined && PAUSE_HOLD_STEPS.includes(v) ? v : 1.5;
}

function setPauseHold(seconds) {
    if (PAUSE_HOLD_STEPS.includes(Number(seconds))) save({ ...load(), pauseHold: Number(seconds) });
}

// Favourite games, by their path under the ROMs folder (so a game keeps its star when its picture or title changes)
function getFavorites() {
    const list = load().favorites;
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
}

function setFavorite(gamePath, on) {
    if (typeof gamePath !== 'string' || !gamePath || gamePath.length > 500) return;
    const rest = getFavorites().filter(x => x !== gamePath);
    save({ ...load(), favorites: on ? [...rest, gamePath] : rest });
}

// How many Wii Remotes to use as real remotes in Dolphin (0-4); they take the first Wii Remote slots
function getWiiRemotes() {
    const n = Number(load().wiiRemotes);
    return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 0;
}

function setWiiRemotes(n) {
    if (Number.isInteger(n) && n >= 0 && n <= 4) save({ ...load(), wiiRemotes: n });
}

// Which controller each of the four players uses, and which mapping (see players.js)
function getPlayers() {
    return require('./players').normalize(load().players);
}

function setPlayers(players) {
    save({ ...load(), players: require('./players').normalize(players) });
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

// Cloud saves go to the "saves" branch of their own private repository, so the token that can write to it can touch
// nothing else. (cloudRepoUrl in config.json overrides it.)
const SAVES_REPO_URL = 'https://github.com/aidankeighron/all-in-one-emulator-saves.git';

function getCloud() {
    const cfg = load();
    const repoUrl = cfg.cloudRepoUrl || SAVES_REPO_URL;
    return { enabled: !!repoUrl, repoUrl, deviceName: cfg.deviceName || '' };
}

// An access token for pushing saves over https, for computers where git has no stored sign-in: cloudToken in
// config.json, else GITHUB_TOKEN / GH_TOKEN, else whatever the GitHub CLI (gh auth login) holds
// cloud-token.txt beside the program (kept out of git): the way to hand a token to someone along with a zipped copy
function tokenFile() {
    for (const dir of [path.resolve(__dirname, '..', '..'), path.dirname(configFile)]) {
        try { const t = fs.readFileSync(path.join(dir, 'cloud-token.txt'), 'utf8').trim(); if (t) return t; } catch { /* none here */ }
    }
    return '';
}

async function getCloudToken() {
    const cfg = load();
    const direct = cfg.cloudToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || tokenFile();
    if (direct) return String(direct).trim();
    return new Promise(resolve => {
        require('child_process').execFile('gh', ['auth', 'token'], { timeout: 5000, encoding: 'utf8' }, (err, out) => resolve(err ? null : String(out).trim() || null));
    });
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

// Windows: a zip address to install an emulator from, when the built-in sources don't work (emulatorUrls in config.json)
function getEmulatorUrls() {
    const urls = load().emulatorUrls;
    return urls && typeof urls === 'object' ? urls : {};
}

function setEmulatorPath(id, file) {
    const cfg = load();
    cfg.emulatorPaths = { ...cfg.emulatorPaths };
    if (file) cfg.emulatorPaths[id] = file; else delete cfg.emulatorPaths[id];
    save(cfg);
}

// Windows: a folder where unpacked emulators are found without any setup
const emulatorsDir = path.join(path.dirname(configFile), 'emulators');

const mappingsDir = path.join(path.dirname(configFile), 'mappings');

const artworkDir = path.join(path.dirname(configFile), 'artwork');
const soundsDir = process.env.SOUNDS_DIR || path.join(path.dirname(configFile), 'sounds');

module.exports = { getRomsDir, setRomsDir, getAutoControllers, setAutoControllers, getWiiRemotes, setWiiRemotes, getPauseHold, setPauseHold, PAUSE_HOLD_STEPS, getFavorites, setFavorite, getPlayers, setPlayers, getSound, setSound, getCloud, getCloudToken, getLibrary, setLibrary, libraryCacheFile, getEmulatorPaths, getEmulatorUrls, setEmulatorPath, emulatorsDir, configFile, mappingsDir, artworkDir, soundsDir };
