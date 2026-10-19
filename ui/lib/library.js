// Sharing a game library between your own computers.
//
//   Host   "Share this computer's games" starts a small HTTP server (separate from the menu's own, which stays on
//          localhost) that serves an index of the library plus the game files, to anyone holding the access key.
//          The index is generated fresh on every request, so it is always up to date.
//   Client the other computer is given the host's address and key in Settings, downloads the index, shows the
//          games it doesn't have as downloadable, and fetches a chosen one (resuming if interrupted).
//
// Only files the menu itself lists as games can be requested, nothing else on the host. Use it on your home
// network or over a private network such as Tailscale: the key stops other people, but plain HTTP is not
// encrypted, so don't expose the port to the internet.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const roms = require('./roms');
const { serveFile } = require('./serve');

const DEFAULT_PORT = 8765;
const SPACE_MARGIN = 200 * 1024 * 1024;   // leave this much free after a download

class LibraryError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest();
const keyMatches = (given, key) => !!key && crypto.timingSafeEqual(sha256(given), sha256(key));
const newKey = () => crypto.randomBytes(24).toString('hex');

// "folder/file" for a game this menu would list, with nothing that could escape the ROMs folder
function isSafeGamePath(rel, manifest) {
    if (typeof rel !== 'string' || rel.includes('\\') || rel.includes('\0')) return false;
    const parts = rel.split('/');
    if (parts.length !== 2 || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return false;
    const emu = roms.folderMap(manifest).get(parts[0]);
    return !!emu && emu.extensions.includes(path.extname(parts[1]).slice(1).toLowerCase());
}

// ---------- Host ----------

function buildIndex({ romsDir, manifest, name = os.hostname() }) {
    const games = roms.scanGames(romsDir, manifest).map(g => {
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(romsDir, g.path)); size = st.size; mtime = Math.round(st.mtimeMs); } catch { /* vanished */ }
        return { id: g.id, title: g.title, console: g.console, emulator: g.emulator, path: g.path, size, mtime };
    });
    return { version: 1, name, generatedAt: new Date().toISOString(), games };
}

function createShareServer({ getKey, getRomsDir, manifest, name = () => os.hostname(), log = () => {} }) {
    let server = null;

    const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

    async function handle(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
        const url = new URL(req.url, 'http://x');
        if (!url.pathname.startsWith('/library/')) return json(res, 404, { error: 'not found' });

        const key = getKey();
        const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!keyMatches(given, key)) {
            await new Promise(r => setTimeout(r, 400));   // slow down guessing
            return json(res, 401, { error: 'bad key' });
        }

        const romsDir = getRomsDir();
        if (url.pathname === '/library/ping') {
            return json(res, 200, { name: name(), version: 1, games: roms.scanGames(romsDir, manifest).length });
        }
        if (url.pathname === '/library/index.json') {
            return json(res, 200, buildIndex({ romsDir, manifest, name: name() }));
        }
        const f = url.pathname.match(/^\/library\/files\/(.+)$/);
        if (f) {
            let rel;
            try { rel = decodeURIComponent(f[1]); } catch { return json(res, 400, { error: 'bad path' }); }
            const game = isSafeGamePath(rel, manifest) && roms.scanGames(romsDir, manifest).find(g => g.path === rel);
            if (!game) return json(res, 404, { error: 'no such game' });
            log(`[LIBRARY] sending ${rel}`);
            return serveFile(req, res, path.join(romsDir, rel), 'application/octet-stream');
        }
        return json(res, 404, { error: 'not found' });
    }

    return {
        running: () => !!server,
        port: () => (server ? server.address().port : null),
        start(port) {
            return new Promise((resolve, reject) => {
                if (server) return resolve(server.address().port);
                const s = http.createServer((req, res) => { handle(req, res).catch(err => { log(`[LIBRARY] ${err.message}`); if (!res.headersSent) json(res, 500, { error: 'failed' }); }); });
                s.once('error', err => reject(new LibraryError(err.code === 'EADDRINUSE' ? 'PORT_BUSY' : 'LISTEN', err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message)));
                s.listen(port, '0.0.0.0', () => { server = s; log(`[LIBRARY] sharing on port ${s.address().port}`); resolve(s.address().port); });
            });
        },
        stop() {
            return new Promise(resolve => {
                if (!server) return resolve();
                const s = server;
                server = null;
                s.close(() => resolve());
                s.closeAllConnections();
            });
        }
    };
}

// The addresses other computers can try, with the port: ["192.168.1.20:8765", ...]
function localAddresses(port) {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`${i.address}:${port}`);
    }
    return out;
}

// ---------- Client ----------

// "192.168.1.20", "pc:9000" or "http://pc:9000" -> "http://host:port"
function baseUrl(address) {
    let a = String(address || '').trim();
    if (!a) throw new LibraryError('NO_ADDRESS', 'Enter the server address in Settings');
    if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
    let u;
    try { u = new URL(a); } catch { throw new LibraryError('BAD_ADDRESS', `“${address}” is not a valid address`); }
    if (!u.port && u.protocol === 'http:') u.port = String(DEFAULT_PORT);
    return u.origin;
}

async function request(address, key, pathname, { timeoutMs = 8000, headers = {}, signal, fetchImpl = globalThis.fetch } = {}) {
    const url = `${baseUrl(address)}${pathname}`;
    let res;
    try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, ...headers }, signal: signal || AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        if (err.name === 'AbortError' && signal && signal.aborted) throw new LibraryError('CANCELLED', 'Download cancelled');
        throw new LibraryError('UNREACHABLE', `Could not reach ${address}. Is it on, and on the same network?`);
    }
    if (res.status === 401) throw new LibraryError('BAD_KEY', 'The server did not accept the access key');
    if (!res.ok && res.status !== 206) throw new LibraryError('SERVER', `The server answered ${res.status}`);
    return res;
}

// The host's game list, with anything unsafe or malformed dropped
async function fetchIndex({ address, key, manifest, timeoutMs, fetchImpl }) {
    const res = await request(address, key, '/library/index.json', { timeoutMs, fetchImpl });
    let data;
    try { data = await res.json(); } catch { throw new LibraryError('SERVER', 'That does not look like a game library server'); }
    if (!data || !Array.isArray(data.games)) throw new LibraryError('SERVER', 'That does not look like a game library server');
    const games = data.games.filter(g => g && typeof g.title === 'string' && typeof g.console === 'string' && typeof g.id === 'string'
        && Number.isFinite(g.size) && isSafeGamePath(g.path, manifest));
    return { name: String(data.name || address).slice(0, 60), generatedAt: data.generatedAt, games };
}

// Downloads one game into the ROMs folder, resuming a partial file if there is one.
// onProgress({received, total, bytesPerSec}); signal cancels (the partial file is kept for next time).
async function downloadGame({ address, key, game, romsDir, manifest, onProgress = () => {}, signal, fetchImpl }) {
    if (!isSafeGamePath(game.path, manifest)) throw new LibraryError('BAD_PATH', 'That game has an unsafe name');
    const dest = path.join(romsDir, game.path);
    const partial = `${dest}.part`;
    if (fs.existsSync(dest)) throw new LibraryError('EXISTS', 'That game is already on this computer');
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    let have = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (have > game.size) { fs.rmSync(partial); have = 0; }
    try {
        const free = fs.statfsSync(path.dirname(dest));
        if (free.bavail * free.bsize < game.size - have + SPACE_MARGIN) {
            throw new LibraryError('NO_SPACE', `Not enough free space for ${(game.size / 1073741824).toFixed(1)} GB`);
        }
    } catch (err) {
        if (err instanceof LibraryError) throw err;   // statfs unavailable: carry on
    }

    if (have < game.size) {
        const res = await request(address, key, `/library/files/${encodeURIComponent(game.path)}`, {
            signal, fetchImpl, headers: have ? { Range: `bytes=${have}-` } : {}
        });
        if (have && res.status !== 206) have = 0;   // the server sent the whole file: start over
        let received = have;
        let lastAt = Date.now(), lastBytes = received, speed = 0;
        const report = () => {
            const now = Date.now();
            if (now - lastAt >= 500) { speed = ((received - lastBytes) * 1000) / (now - lastAt); lastAt = now; lastBytes = received; }
            onProgress({ received, total: game.size, bytesPerSec: speed });
        };
        try {
            await pipeline(
                Readable.fromWeb(res.body),
                async function* count(source) { for await (const chunk of source) { received += chunk.length; report(); yield chunk; } },
                fs.createWriteStream(partial, { flags: have ? 'a' : 'w' }),
                signal ? { signal } : {}
            );
        } catch (err) {
            if (signal && signal.aborted) throw new LibraryError('CANCELLED', 'Download cancelled');
            throw new LibraryError('INTERRUPTED', `The download was interrupted: ${err.message}. Try again to continue where it stopped.`);
        }
    }
    if (fs.statSync(partial).size !== game.size) {
        throw new LibraryError('INCOMPLETE', 'The download is incomplete. Try again to continue where it stopped.');
    }
    fs.renameSync(partial, dest);
    onProgress({ received: game.size, total: game.size, bytesPerSec: 0 });
    return dest;
}

module.exports = { LibraryError, DEFAULT_PORT, buildIndex, createShareServer, localAddresses, baseUrl, fetchIndex, downloadGame, isSafeGamePath, newKey, keyMatches };
