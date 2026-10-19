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
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });   // may hold the saves passphrase
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

// Save slots and cloud saves. Saves go to the "saves" branch of repoUrl (this project's own repository by default).
function getCloud() {
    const cfg = load();
    return {
        slotsEnabled: cfg.slotsEnabled !== false,
        enabled: cfg.cloudEnabled !== false,
        repoUrl: cfg.cloudRepoUrl || defaultRepoUrl(),
        passphrase: cfg.cloudPassphrase || '',
        deviceName: cfg.deviceName || ''
    };
}

function setCloud(next) {
    const cfg = load();
    if (typeof next.slotsEnabled === 'boolean') cfg.slotsEnabled = next.slotsEnabled;
    if (typeof next.enabled === 'boolean') cfg.cloudEnabled = next.enabled;
    if (typeof next.repoUrl === 'string') cfg.cloudRepoUrl = next.repoUrl.trim();
    if (typeof next.passphrase === 'string') cfg.cloudPassphrase = next.passphrase;
    save(cfg);
}

const artworkDir = path.join(path.dirname(configFile), 'artwork');
const soundsDir = process.env.SOUNDS_DIR || path.join(path.dirname(configFile), 'sounds');

module.exports = { getRomsDir, setRomsDir, getAutoControllers, setAutoControllers, getSound, setSound, getCloud, setCloud, configFile, artworkDir, soundsDir };
