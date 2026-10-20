const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./lib/config');
const flatpak = require('./lib/flatpak');
const roms = require('./lib/roms');
const hotkey = require('./lib/hotkey');
const controllers = require('./lib/controllers');
const inputconfig = require('./lib/inputconfig');
const artwork = require('./lib/artwork');
const sounds = require('./lib/sounds');
const { createManager, SaveError } = require('./lib/saves/manager');
const saveAdapters = require('./lib/saves/adapters');
const library = require('./lib/library');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'emulators.json'), 'utf8'));
const emulatorsById = new Map(manifest.emulators.map(e => [e.id, e]));
const emulatorsByFolder = roms.folderMap(manifest);

const contentTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.js': 'text/javascript'
};

// ---------- State ----------

let importing = null;   // in-flight ROM import
let current = null;     // running game {emulator, path}
let lastError = null;   // last failed launch, shown once in the UI
const jobs = new Map(); // emulator install/uninstall jobs
let nextJob = 1;
let lastSetup = [];     // result of the last controller setup, per emulator
let art = null;         // artwork cache for the current ROMs folder
let gamesById = new Map();

// Save slots and cloud saves (see lib/saves)
const slotAdapters = saveAdapters.create(os.homedir());
const saves = createManager({
    dir: path.join(path.dirname(config.configFile), 'saves'),
    adapters: slotAdapters,
    getCloud: config.getCloud,
    log: console.log
});
// Game library sharing (see lib/library): this computer as a host, and another computer's games shown here
const share = library.createShareServer({
    getKey: () => config.getLibrary().sharing.key,
    getRomsDir: () => config.getRomsDir(),
    manifest,
    name: () => config.getCloud().deviceName || os.hostname(),
    log: console.log
});
let remote = { index: null, at: 0, failedAt: 0, error: null };
let download = null;   // the one game being downloaded: {game, state, received, total, bytesPerSec, message, controller}

try { remote.index = JSON.parse(fs.readFileSync(config.libraryCacheFile, 'utf8')); } catch { /* nothing cached yet */ }

// The other computer's game list: fresh if it can be had quickly, otherwise what was last seen
async function remoteIndex({ maxAgeMs = 60000, timeoutMs = 2500, force = false } = {}) {
    const { address, key } = config.getLibrary().remote;
    if (!address || !key) { remote.error = null; return null; }
    const age = Date.now() - remote.at;
    if (!force && remote.index && age < maxAgeMs) return remote.index;
    if (!force && Date.now() - remote.failedAt < 30000) return remote.index;
    try {
        remote.index = { ...await library.fetchIndex({ address, key, manifest, timeoutMs }), address };
        remote.at = Date.now();
        remote.error = null;
        fs.mkdirSync(path.dirname(config.libraryCacheFile), { recursive: true });
        fs.writeFileSync(config.libraryCacheFile, JSON.stringify(remote.index));
    } catch (err) {
        remote.failedAt = Date.now();
        remote.error = { code: err.code, message: err.message };
    }
    return remote.index && remote.index.address === address ? remote.index : null;
}

async function applyShareSettings() {
    const { sharing } = config.getLibrary();
    await share.stop();
    if (!sharing.enabled || !sharing.key) return null;
    try { await share.start(sharing.port); return null; } catch (err) { return err.message; }
}

function startDownload(game) {
    const { address, key } = config.getLibrary().remote;
    const controller = new AbortController();
    download = { game: { path: game.path, title: game.title, size: game.size }, state: 'running', received: 0, total: game.size, bytesPerSec: 0, message: '', controller };
    const job = download;
    library.downloadGame({
        address, key, game, romsDir: config.getRomsDir(), manifest, signal: controller.signal,
        onProgress: p => { job.received = p.received; job.total = p.total; job.bytesPerSec = p.bytesPerSec; }
    }).then(() => { job.state = 'done'; console.log(`[LIBRARY] downloaded ${game.path}`); })
      .catch(err => { job.state = err.code === 'CANCELLED' ? 'cancelled' : 'error'; job.message = err.message; console.error(`[LIBRARY] ${game.path}: ${err.message}`); });
}

const downloadSnapshot = () => download && ({ path: download.game.path, title: download.game.title, state: download.state, received: download.received, total: download.total, bytesPerSec: download.bytesPerSec, message: download.message });

let launching = false;   // a launch is in progress (checking the emulator, downloading the save) but the game has not started yet

function findGame(relPath) {
    return roms.scanGames(config.getRomsDir(), manifest).find(g => g.path === relPath) || null;
}

// Shows a failed save operation to the menu as {error, message}
function saveFailure(err) {
    const known = err instanceof SaveError || ['NO_GIT', 'OFFLINE', 'FIRST_RUN'].includes(err.code);
    return { status: known ? 409 : 500, body: { error: err.code || 'failed', message: err.message } };
}

function artworkFor(romsDir) {
    if (!art || art.romsDir !== romsDir) {
        art = { romsDir, ...artwork.create({ cacheDir: config.artworkDir, romsDir }) };
    }
    return art;
}

// Writes the controller settings of one emulator (or all installed ones) from what is plugged in now
function setupControllers(emulatorIds) {
    const connected = controllers.detect();
    const results = emulatorIds.map(id => {
        const result = inputconfig.apply(id, connected);
        console.log(`[PADS] ${id}: ${result.status}${result.message ? ` (${result.message})` : ''}`);
        return result;
    });
    lastSetup = [...lastSetup.filter(r => !emulatorIds.includes(r.emulator)), ...results];
    return results;
}

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

async function launchGame(relPath, slotId, onGameState) {
    if (current || launching) return { status: 409, body: { error: 'busy', message: 'A game is already running' } };
    launching = true;   // held for the whole launch, so a second click can't start another one
    try {
        return await startGame(relPath, slotId, onGameState);
    } finally {
        launching = false;
    }
}

async function startGame(relPath, slotId, onGameState) {

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
    if (config.getAutoControllers()) setupControllers([emu.id]);
    let args = emu.args.map(a => a === '{rom}' ? abs : a);

    // Pick the save slot: make this computer's copy current, then start the emulator on that slot's own data
    let slot = null;
    const game = findGame(relPath);
    if (slotId && game && slotAdapters.has(emu.id)) {
        try {
            const prep = await saves.prepare(game, slotId);
            if (prep.conflict) return { status: 409, body: { error: 'conflict', ...prep.conflict } };
            args = [...slotAdapters.get(emu.id).args(prep.slotRoot), ...args];
            slot = { game, id: slotId };
        } catch (err) {
            console.error(`[SAVES] ${err.message}`);
            return saveFailure(err);
        }
    }
    console.log(`[LAUNCH] ${emu.name}: ${abs}${slot ? ` (slot ${slot.id})` : ''}`);

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
        if (slot) saves.finish(slot.game, slot.id).catch(err => console.error(`[SAVES] ${err.message}`));   // upload what was played
    });
    if (onGameState) onGameState(true);
    return { status: 200, body: { status: 'launched', emulator: emu.id } };
}

// Back+Start held for 1.5s: quit the running game
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
    if (current || launching) return { status: 409, body: { error: 'busy', message: 'An emulator is already running' } };
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

// What Settings shows about library sharing
function librarySettings(extra = {}) {
    const { sharing, remote: r } = config.getLibrary();
    return {
        sharing: { enabled: sharing.enabled, port: sharing.port, key: sharing.key, running: share.running(), addresses: library.localAddresses(sharing.port) },
        remote: { address: r.address, hasKey: !!r.key, error: remote.error, name: remote.index && remote.index.address === r.address ? remote.index.name : null,
                  games: remote.index && remote.index.address === r.address ? remote.index.games.length : null },
        ...extra
    };
}

// /api/library/*. Returns true when it sent a response.
async function handleLibrary(route, req, res) {
    try {
        if (route === 'GET /api/library/settings') return sendJson(res, 200, librarySettings()), true;
        if (route === 'POST /api/library/settings') {
            const body = await readJson(req);
            const next = { sharing: {}, remote: {} };
            if (body.sharing) {
                if (typeof body.sharing.enabled === 'boolean') next.sharing.enabled = body.sharing.enabled;
                if (Number.isInteger(body.sharing.port)) next.sharing.port = body.sharing.port;
                if (body.sharing.newKey || (body.sharing.enabled && !config.getLibrary().sharing.key)) next.sharing.key = library.newKey();
            }
            if (body.remote) {
                if (typeof body.remote.address === 'string') next.remote.address = body.remote.address;
                if (typeof body.remote.key === 'string' && body.remote.key) next.remote.key = body.remote.key;
            }
            config.setLibrary(next);
            const shareError = body.sharing ? await applyShareSettings() : null;
            if (body.remote) { remote = { index: null, at: 0, failedAt: 0, error: null }; await remoteIndex({ force: true, timeoutMs: 6000 }); }
            return sendJson(res, 200, librarySettings({ shareError })), true;
        }
        if (route === 'POST /api/library/test') {
            const idx = await remoteIndex({ force: true, timeoutMs: 6000 });
            return sendJson(res, 200, idx ? { ok: true, name: idx.name, games: idx.games.length } : { ok: false, ...(remote.error || { message: 'Enter the server address and key first' }) }), true;
        }
        if (route === 'GET /api/library/download') return sendJson(res, 200, { download: downloadSnapshot() }), true;
        if (route === 'POST /api/library/cancel') {
            if (download && download.state === 'running') download.controller.abort();
            return sendJson(res, 200, { download: downloadSnapshot() }), true;
        }
        if (route === 'POST /api/library/download') {
            const body = await readJson(req);
            if (download && download.state === 'running') return sendJson(res, 409, { error: 'busy', message: `Already downloading ${download.game.title}` }), true;
            const idx = await remoteIndex({ force: false, timeoutMs: 6000 });
            const game = idx && idx.games.find(g => g.path === body.path);
            if (!game) return sendJson(res, 404, { error: 'unknown', message: 'That game is not on the server any more' }), true;
            if (fs.existsSync(path.join(config.getRomsDir(), game.path))) return sendJson(res, 409, { error: 'EXISTS', message: 'That game is already on this computer' }), true;
            startDownload(game);
            return sendJson(res, 200, { download: downloadSnapshot() }), true;
        }
    } catch (err) {
        console.error(`[LIBRARY] ${route}: ${err.message}`);
        return sendJson(res, 500, { error: err.code || 'failed', message: err.message }), true;
    }
    return false;
}

// /api/saves/*. Returns true when it sent a response.
async function handleSaves(route, url, req, res) {
    const needGame = body => {
        const game = findGame(url.searchParams.get('path') || body.path);
        if (!game) throw new SaveError('UNKNOWN_GAME', 'That game is no longer in the library');
        return game;
    };
    try {
        if (route === 'POST /api/saves/sync') return sendJson(res, 200, await saves.syncAll()), true;
        if (route === 'GET /api/saves') {
            const game = needGame({});
            const supported = slotAdapters.has(game.emulator);
            if (!supported) return sendJson(res, 200, { supported: false, slots: [] }), true;
            return sendJson(res, 200, { supported: true, ...await saves.listSlots(game) }), true;
        }
        const body = req.method === 'POST' ? await readJson(req) : {};
        if (route === 'POST /api/saves/create') return sendJson(res, 200, await saves.createSlot(needGame(body), body.name)), true;
        if (route === 'POST /api/saves/rename') return sendJson(res, 200, await saves.renameSlot(needGame(body), body.slot, body.name)), true;
        if (route === 'POST /api/saves/delete') return sendJson(res, 200, await saves.deleteSlot(needGame(body), body.slot)), true;
        if (route === 'POST /api/saves/resolve') return sendJson(res, 200, await saves.resolve(needGame(body), body.slot, body.choice)), true;
        if (route === 'POST /api/saves/restore') return sendJson(res, 200, await saves.restore(needGame(body), body.slot, body.sha)), true;
        if (route === 'GET /api/saves/history') return sendJson(res, 200, { versions: await saves.history(needGame({}), url.searchParams.get('slot')) }), true;
    } catch (err) {
        const failure = saveFailure(err);
        console.error(`[SAVES] ${route}: ${err.message}`);
        return sendJson(res, failure.status, failure.body), true;
    }
    return false;
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
                    const romsDir = config.getRomsDir();
                    const scanned = roms.scanGames(romsDir, manifest);
                    const covers = artworkFor(romsDir);
                    covers.ensure(scanned);
                    gamesById = new Map(scanned.map(g => [g.id, g]));
                    const games = scanned.map(g => ({ ...g, installed: installed.has(g.emulator), art: covers.find(g) ? `/api/art/${g.id}` : null }));
                    // Games that are on the other computer but not on this one
                    const theirs = await remoteIndex();
                    const have = new Set(scanned.map(g => g.path));
                    const onServer = theirs ? theirs.games.filter(g => !have.has(g.path)).map(g => ({ ...g, remote: true, installed: installed.has(g.emulator), art: null })) : [];
                    games.push(...onServer);
                    games.sort((a, b) => a.title.localeCompare(b.title));
                    return sendJson(res, 200, { games, romsDir, artPending: covers.pending(), server: theirs ? { name: theirs.name, offline: !!remote.error } : null });
                }
                const a = url.pathname.match(/^\/api\/art\/(\w+)$/);
                if (req.method === 'GET' && a) {
                    const game = gamesById.get(a[1]);
                    const file = game && artworkFor(config.getRomsDir()).find(game);
                    if (!file) return sendJson(res, 404, { error: 'no artwork' });
                    res.writeHead(200, {
                        'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream',
                        'Cache-Control': 'no-cache'
                    });
                    return fs.createReadStream(file).pipe(res);
                }
                if (route === 'GET /api/sounds') {
                    sounds.ensureDir(config.soundsDir);
                    return sendJson(res, 200, { ...sounds.describe(config.soundsDir), settings: config.getSound() });
                }
                const snd = url.pathname.match(/^\/api\/sounds\/(effects|music)\/([^/]+)$/);
                if (req.method === 'GET' && snd) {
                    const file = sounds.resolve(config.soundsDir, snd[1], decodeURIComponent(snd[2]));
                    return file ? sounds.serve(req, res, file) : sendJson(res, 404, { error: 'no such sound' });
                }
                if (url.pathname.startsWith('/api/library')) {
                    const handled = await handleLibrary(route, req, res);
                    if (handled) return;
                }
                if (url.pathname.startsWith('/api/saves')) {
                    const handled = await handleSaves(route, url, req, res);
                    if (handled) return;
                }
                if (route === 'GET /api/controllers') {
                    const list = controllers.detect();
                    const roles = inputconfig.assignments(list);
                    return sendJson(res, 200, {
                        controllers: list.map(c => ({ ...c, roles: roles[c.id] })),
                        autoSetup: config.getAutoControllers(),
                        setup: lastSetup
                    });
                }
                if (route === 'POST /api/controllers/apply') {
                    const states = await emulatorStates();
                    const ids = states.emulators.filter(e => e.installed).map(e => e.id);
                    return sendJson(res, 200, { setup: setupControllers(ids) });
                }
                if (route === 'GET /api/settings') {
                    return sendJson(res, 200, { romsDir: config.getRomsDir(), autoControllers: config.getAutoControllers(), sound: config.getSound(), ...await emulatorStates() });
                }
                if (route === 'POST /api/settings') {
                    const body = await readJson(req);
                    if (body.romsDir !== undefined) {
                        if (typeof body.romsDir !== 'string' || !path.isAbsolute(body.romsDir)) {
                            return sendJson(res, 400, { error: 'romsDir must be an absolute path' });
                        }
                        fs.mkdirSync(body.romsDir, { recursive: true });
                        config.setRomsDir(body.romsDir);
                        roms.createDefaultFolders(config.getRomsDir(), manifest);
                    }
                    if (typeof body.autoControllers === 'boolean') config.setAutoControllers(body.autoControllers);
                    if (body.sound && typeof body.sound === 'object') config.setSound(body.sound);
                    return sendJson(res, 200, { romsDir: config.getRomsDir(), autoControllers: config.getAutoControllers() });
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
                    const result = await launchGame(body.path, body.slot, onGameState);
                    return sendJson(res, result.status, result.body);
                }
                if (route === 'GET /api/status') {
                    const error = lastError;
                    lastError = null;
                    return sendJson(res, 200, { running: !!current, game: current && { emulator: current.emulator, path: current.path }, error, sync: saves.activity() });
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
        const scriptOutsideAssets = path.extname(filePath) === '.js' && !filePath.startsWith(path.join(__dirname, 'assets') + path.sep);
        if (!filePath.startsWith(__dirname + path.sep) || !contentTypes[path.extname(filePath)] || scriptOutsideAssets) {
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
            applyShareSettings().then(err => err && console.error(`[LIBRARY] ${err}`));
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
