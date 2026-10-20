// The two platforms the menu supports: Linux (emulators from Flathub) and Windows (emulators you unpack or install yourself).
const os = require('os');
const path = require('path');

const current = () => (process.platform === 'win32' ? 'win32' : 'linux');

// Where the menu keeps its settings, caches, saves clone and downloaded artwork
function configDir({ platform = current(), env = process.env, home = os.homedir() } = {}) {
    if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'all-in-one-emulator');
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'all-in-one-emulator');
}

// "%APPDATA%/x" -> the real path. Windows variable names are not case sensitive.
function expandEnv(text, env = process.env) {
    return String(text).replace(/%([^%]+)%/g, (whole, name) => {
        const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
        return key ? env[key] : whole;
    });
}

module.exports = { current, configDir, expandEnv };
