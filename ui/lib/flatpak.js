const { execFile, spawn } = require('child_process');

function run(args) {
    return new Promise(resolve => {
        execFile('flatpak', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout, stderr, notFound: err && err.code === 'ENOENT' });
        });
    });
}

async function available() {
    const r = await run(['--version']);
    return r.ok;
}

async function isInstalled(id) {
    return (await run(['info', id])).ok;
}

// Streams `flatpak <args>` output line by line (progress uses \r) and resolves with the exit code
function stream(args, onLine) {
    return new Promise(resolve => {
        const child = spawn('flatpak', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const feed = chunk => chunk.toString().split(/[\r\n]+/).filter(Boolean).forEach(onLine);
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', err => { onLine(err.message); resolve(1); });
        child.on('close', code => resolve(code));
    });
}

async function install(id, onLine) {
    await run(['remote-add', '--if-not-exists', '--user', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo']);
    return stream(['install', '-y', '--noninteractive', '--user', 'flathub', id], onLine);
}

function uninstall(id, onLine) {
    return stream(['uninstall', '-y', '--noninteractive', id], onLine);
}

// Flatpak apps are sandboxed: let this emulator read the ROMs folder (read-only)
function grantAccess(id, dir) {
    return run(['override', '--user', `--filesystem=${dir}:ro`, id]);
}

// Real Wii Remotes: Dolphin's sandbox needs permission to use Bluetooth
function allowBluetooth(id) {
    return run(['override', '--user', '--allow=bluetooth', id]);
}

// Forcefully stops every running instance of this app
function kill(id) {
    return run(['kill', id]);
}

// Starts the emulator; resolves once it has exited
// env: extra environment variables for the app inside its sandbox. What the app prints (both streams) is kept, last part only.
function launch(id, args, onExit, env = {}) {
    const envArgs = Object.entries(env || {}).map(([k, v]) => `--env=${k}=${v}`);
    const child = spawn('flatpak', ['run', ...envArgs, id, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const keep = d => { stderr = (stderr + d).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', err => onExit(1, err.message));
    child.on('close', code => onExit(code, stderr));
    return child;
}

module.exports = { available, isInstalled, install, uninstall, grantAccess, allowBluetooth, launch, kill };
