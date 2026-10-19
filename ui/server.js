const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const flatpak = require('./lib/flatpak');
const roms = require('./lib/roms');
const hotkey = require('./lib/hotkey');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'emulators.json'), 'utf8'));
const emulatorsById = new Map(manifest.emulators.map(e => [e.id, e]));
const emulatorsByFolder = roms.folderMap(manifest);

const contentTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.png': 'image/png'
};

// ---------- State ----------

let importing = null;   // in-flight ROM import
let current = null;     // running game {emulator, path}
let lastError = null;   // last failed launch, shown once in the UI
const jobs = new Map(); // emulator install/uninstall jobs
let nextJob = 1;

function processRoms() {
    if (!importing) {
        importing = roms.processRoms(config.getRomsDir(), manifest)
            .catch(err => ({ ok: false, lines: [err.message] }))
            .finally(() => { importing = null; });
    }
    return importing;
}

async function emulatorStates() {
    const hasFlatpak = await flatpak.available();
    const list = await Promise.all(manifest.emulators.map(async e => ({
        id: e.id,
        name: e.name,
        description: e.description,
        folders: e.folders,
        flatpak: e.flatpak,
        installed: hasFlatpak && await flatpak.isInstalled(e.flatpak)
    })));
    return { flatpak: hasFlatpak, emulators: list };
}

function startJob(emu, action) {
    const id = String(nextJob++);
    const job = { id, emulator: emu.id, action, state: 'running', lines: [] };
    jobs.set(id, job);
    const onLine = line => { job.lines = [...job.lines, line].slice(-15); };
    (action === 'install' ? flatpak.install(emu.flatpak, onLine) : flatpak.uninstall(emu.flatpak, onLine))
        .then(code => { job.state = code === 0 ? 'done' : 'error'; });
    return job;
}

// ---------- Launching ----------

async function launchGame(relPath, onGameState) {
    if (current) return { status: 409, body: { error: 'busy', message: 'A game is already running' } };

    const romsDir = config.getRomsDir();
    const abs = path.resolve(romsDir, relPath || '');
    if (!relPath || !abs.startsWith(romsDir + path.sep) || !fs.existsSync(abs)) {
        return { status: 400, body: { error: 'invalid', message: 'Invalid ROM path' } };
    }
    const folder = path.relative(romsDir, abs).split(path.sep)[0].toLowerCase();
    const emu = emulatorsByFolder.get(folder);
    if (!emu) return { status: 400, body: { error: 'invalid', message: `No emulator for folder "${folder}"` } };

    if (!await flatpak.isInstalled(emu.flatpak)) {
        return { status: 409, body: { error: 'not_installed', emulator: emu.id, message: `${emu.name} is not installed` } };
    }

    await flatpak.grantAccess(emu.flatpak, romsDir);
    const args = emu.args.map(a => a === '{rom}' ? abs : a);
    console.log(`[LAUNCH] ${emu.name}: ${abs}`);

    current = { emulator: emu.id, path: relPath, flatpak: emu.flatpak };
    lastError = null;
    const started = Date.now();
    const stopWatching = process.env.EMU_NO_HOTKEY ? () => {} : hotkey.start(stopCurrent);
    current.child = flatpak.launch(emu.flatpak, args, (code, stderr) => {
        stopWatching();
        current = null;
        if (code !== 0 && Date.now() - started < 10000) {
            lastError = `${emu.name} exited with an error: ${(stderr || '').trim().split('\n').pop()}`;
            console.error(`[LAUNCH] ${lastError}`);
        }
        if (onGameState) onGameState(false);
    });
    if (onGameState) onGameState(true);
    return { status: 200, body: { status: 'launched', emulator: emu.id } };
}

// Back+Start (Share+Options on PlayStation pads) held for 1.5s: quit the running game
function stopCurrent() {
    if (!current || !current.child) return;
    const { flatpak: id } = current;
    console.log(`[HOTKEY] Stopping ${id}`);
    current.child.kill('SIGTERM');
    setTimeout(() => { if (current && current.flatpak === id) flatpak.kill(id); }, 3000);
}

// Opens the emulator's own window (no game) so the user can set up controllers, BIOS, etc.
async function openEmulator(id, onGameState) {
    const emu = emulatorsById.get(id);
    if (!emu) return { status: 404, body: { error: 'unknown', message: 'Unknown emulator' } };
    if (current) return { status: 409, body: { error: 'busy', message: 'An emulator is already running' } };
    if (!await flatpak.isInstalled(emu.flatpak)) {
        return { status: 409, body: { error: 'not_installed', emulator: emu.id, message: `${emu.name} is not installed` } };
    }

    await flatpak.grantAccess(emu.flatpak, config.getRomsDir());
    console.log(`[OPEN] ${emu.name}`);
    current = { emulator: emu.id, path: null, flatpak: emu.flatpak };
    lastError = null;
    const started = Date.now();
    current.child = flatpak.launch(emu.flatpak, emu.guiArgs || [], (code, stderr) => {
        current = null;
        if (code !== 0 && Date.now() - started < 10000) {
            lastError = `${emu.name} exited with an error: ${(stderr || '').trim().split('\n').pop()}`;
        }
        if (onGameState) onGameState(false);
    });
    if (onGameState) onGameState(true);
    return { status: 200, body: { status: 'opened', emulator: emu.id } };
}

// ---------- HTTP ----------

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 65536) { reject(new Error('Body too large')); req.destroy(); }
        });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
        });
    });
}

// Only this machine's own pages may use the API (blocks DNS rebinding and cross-site requests)
function allowed(req) {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return false;
    if (req.method !== 'GET' && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin || '')) return false;
    return true;
}

function createServer(onGameState) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const route = `${req.method} ${url.pathname}`;

        if (url.pathname.startsWith('/api/')) {
            if (!allowed(req)) return sendJson(res, 403, { error: 'forbidden' });
            try {
                if (route === 'GET /api/games') {
                    const states = await emulatorStates();
                    const installed = new Set(states.emulators.filter(e => e.installed).map(e => e.id));
                    const games = roms.scanGames(config.getRomsDir(), manifest)
                        .map(g => ({ ...g, installed: installed.has(g.emulator) }));
                    return sendJson(res, 200, { games, romsDir: config.getRomsDir() });
                }
                if (route === 'GET /api/settings') {
                    return sendJson(res, 200, { romsDir: config.getRomsDir(), ...await emulatorStates() });
                }
                if (route === 'POST /api/settings') {
                    const body = await readJson(req);
                    if (typeof body.romsDir !== 'string' || !path.isAbsolute(body.romsDir)) {
                        return sendJson(res, 400, { error: 'romsDir must be an absolute path' });
                    }
                    fs.mkdirSync(body.romsDir, { recursive: true });
                    config.setRomsDir(body.romsDir);
                    roms.createDefaultFolders(config.getRomsDir(), manifest);
                    return sendJson(res, 200, { romsDir: config.getRomsDir() });
                }
                const m = url.pathname.match(/^\/api\/emulators\/([\w-]+)\/(install|uninstall)$/);
                if (req.method === 'POST' && m) {
                    const emu = emulatorsById.get(m[1]);
                    if (!emu) return sendJson(res, 404, { error: 'unknown emulator' });
                    if (!await flatpak.available()) return sendJson(res, 409, { error: 'flatpak_missing' });
                    return sendJson(res, 200, startJob(emu, m[2]));
                }
                const o = url.pathname.match(/^\/api\/emulators\/([\w-]+)\/open$/);
                if (req.method === 'POST' && o) {
                    const result = await openEmulator(o[1], onGameState);
                    return sendJson(res, result.status, result.body);
                }
                const j = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
                if (req.method === 'GET' && j) {
                    const job = jobs.get(j[1]);
                    return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'unknown job' });
                }
                if (route === 'POST /api/launch') {
                    const body = await readJson(req);
                    const result = await launchGame(body.path, onGameState);
                    return sendJson(res, result.status, result.body);
                }
                if (route === 'GET /api/status') {
                    const error = lastError;
                    lastError = null;
                    return sendJson(res, 200, { running: !!current, game: current && { emulator: current.emulator, path: current.path }, error });
                }
                if (route === 'POST /api/process-roms') {
                    return sendJson(res, 200, await processRoms());
                }
                return sendJson(res, 404, { error: 'not found' });
            } catch (err) {
                console.error(`[API ERROR] ${route}: ${err.message}`);
                return sendJson(res, 500, { error: err.message });
            }
        }

        // Static UI files
        let urlPath;
        try {
            urlPath = decodeURIComponent(url.pathname);
        } catch {
            res.writeHead(400);
            return res.end('Bad Request');
        }
        const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
        if (!filePath.startsWith(__dirname + path.sep) || !contentTypes[path.extname(filePath)]) {
            res.writeHead(404);
            return res.end('Not Found');
        }
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end('Not Found');
            } else {
                res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] });
                res.end(content);
            }
        });
    });
}

// Starts the server on localhost only. port 0 picks a free port.
function start({ port = 3000, onGameState } = {}) {
    return new Promise((resolve, reject) => {
        const server = createServer(onGameState);
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const actual = server.address().port;
            console.log(`Menu running at: http://localhost:${actual}`);
            console.log(`ROMs folder: ${config.getRomsDir()}`);
            processRoms(); // pick up any zips dropped in while the app was closed
            resolve({ server, port: actual });
        });
    });
}

module.exports = { start };

if (require.main === module) {
    start({ port: Number(process.env.PORT) || 3000 }).catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
