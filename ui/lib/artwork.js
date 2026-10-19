// Game artwork. Where each system's picture comes from:
//   Wii / GameCube  the 6-character game ID in the disc header, then the cover from GameTDB
//                   (the same source Dolphin's own cover view downloads from)
//   PS2             the serial in SYSTEM.CNF on the disc, then the cover from GameTDB
//   PSP             ICON0.PNG stored inside the ISO / EBOOT.PBP (read locally, no download)
//   PS3             PS3_GAME/ICON0.PNG in a game folder or ISO (read locally)
//   anything        a picture next to the game with the same name (game.png / .jpg / .webp) wins
// Downloaded pictures are cached, so each game is fetched once.
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const ART_BASE = 'https://art.gametdb.com';
const SIDECAR_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const MISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// ---------- Reading bytes ----------

async function readAt(fh, offset, length) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
}

async function withFile(file, fn) {
    const fh = await fsp.open(file, 'r');
    try { return await fn(fh); } finally { await fh.close(); }
}

const extOf = name => path.extname(name).slice(1).toLowerCase();

function imageType(buf) {
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return null;
}

// ---------- ISO 9660 (just enough to find a file) ----------

const SECTOR = 2048;

// Returns {offset, size} of a file inside a 2048-byte-sector ISO, or null. Path like "PSP_GAME/ICON0.PNG".
async function isoFind(fh, filePath) {
    const pvd = await readAt(fh, 16 * SECTOR, SECTOR);
    if (pvd.length < SECTOR || pvd.toString('latin1', 1, 6) !== 'CD001') return null;
    let dir = { lba: pvd.readUInt32LE(156 + 2), size: pvd.readUInt32LE(156 + 10) };

    const parts = filePath.split('/');
    for (let i = 0; i < parts.length; i++) {
        const want = parts[i].toUpperCase();
        const data = await readAt(fh, dir.lba * SECTOR, Math.min(dir.size, 1024 * 1024));
        let found = null;
        for (let pos = 0; pos < data.length;) {
            const len = data[pos];
            if (len === 0) { pos = (Math.floor(pos / SECTOR) + 1) * SECTOR; continue; } // entries never straddle sectors
            const nameLen = data[pos + 32];
            const name = data.toString('latin1', pos + 33, pos + 33 + nameLen).replace(/;\d+$/, '').toUpperCase();
            if (name === want) {
                found = { lba: data.readUInt32LE(pos + 2), size: data.readUInt32LE(pos + 10), isDir: !!(data[pos + 25] & 2) };
                break;
            }
            pos += len;
        }
        if (!found || (i < parts.length - 1 && !found.isDir)) return null;
        if (i === parts.length - 1) return { offset: found.lba * SECTOR, size: found.size };
        dir = found;
    }
    return null;
}

async function isoReadFile(file, filePath, maxBytes = MAX_IMAGE_BYTES) {
    return withFile(file, async fh => {
        const hit = await isoFind(fh, filePath);
        if (!hit || hit.size === 0 || hit.size > maxBytes) return null;
        return readAt(fh, hit.offset, hit.size);
    });
}

// ---------- Per-system identification ----------

const DISC_ID = /^[A-Z0-9]{6}$/;

async function dolphinGameId(file) {
    const ext = extOf(file);
    const at = ext === 'wbfs' ? 0x200 : (ext === 'rvz' || ext === 'wia') ? 0x58 : ext === 'iso' || ext === 'gcm' ? 0 : null;
    if (at === null) return null;   // ciso / gcz / wad: compressed or not a disc
    const id = (await withFile(file, fh => readAt(fh, at, 6))).toString('latin1');
    return DISC_ID.test(id) ? id : null;
}

// GameTDB sorts covers by region; the 4th character of the ID says which
const DOLPHIN_REGIONS = { E: 'US', J: 'JA', K: 'KO', P: 'EN', D: 'DE', F: 'FR', S: 'ES', I: 'IT', H: 'NL', R: 'RU', U: 'AU', W: 'ZHTW', X: 'EN', Y: 'EN', Z: 'EN' };

function dolphinCoverUrls(id) {
    const regions = [...new Set([DOLPHIN_REGIONS[id[3]], 'US', 'EN'].filter(Boolean))];
    return regions.map(r => `${ART_BASE}/wii/cover/${r}/${id}.png`);
}

async function ps2Serial(file) {
    if (extOf(file) !== 'iso') return null;
    const cnf = await isoReadFile(file, 'SYSTEM.CNF', 4096);
    const m = cnf && cnf.toString('latin1').match(/BOOT2\s*=\s*cdrom0:\\?([A-Z]{4})_(\d{3})\.(\d{2})/i);
    return m ? `${m[1]}-${m[2]}${m[3]}`.toUpperCase() : null;
}

const PS2_REGIONS = { SLUS: 'US', SCUS: 'US', SLES: 'EN', SCES: 'EN', SLPS: 'JA', SLPM: 'JA', SCPS: 'JA', SCAJ: 'JA', SLKA: 'KO', SCKA: 'KO' };

function ps2CoverUrls(serial) {
    const region = PS2_REGIONS[serial.slice(0, 4)] || 'US';
    return [`${ART_BASE}/ps2/cover/${region}/${serial}.jpg`];
}

// EBOOT.PBP header: "\0PBP", version, then 8 offsets (PARAM.SFO, ICON0.PNG, ICON1, PIC0, PIC1, SND0, DATA.PSP, DATA.PSAR)
async function pbpIcon(fh) {
    const head = await readAt(fh, 0, 0x28);
    if (head.length < 0x28 || head.toString('latin1', 1, 4) !== 'PBP') return null;
    const start = head.readUInt32LE(0x0c), end = head.readUInt32LE(0x10);
    if (end <= start || end - start > MAX_IMAGE_BYTES) return null;
    return readAt(fh, start, end - start);
}

// Embedded art (PSP, PS3): returns image bytes or null
async function embeddedArt(game, absPath) {
    const stat = await fsp.stat(absPath);
    if (game.emulator === 'rpcs3' && stat.isDirectory()) {
        return fsp.readFile(path.join(absPath, 'PS3_GAME', 'ICON0.PNG')).catch(() => null);
    }
    if (stat.isDirectory()) return null;
    const ext = extOf(absPath);
    if (game.emulator === 'ppsspp') {
        if (ext === 'pbp') return withFile(absPath, pbpIcon);
        if (ext === 'iso') return isoReadFile(absPath, 'PSP_GAME/ICON0.PNG');
    }
    if (game.emulator === 'rpcs3' && ext === 'iso') return isoReadFile(absPath, 'PS3_GAME/ICON0.PNG');
    return null;
}

// Where to download a cover from: a list of URLs to try in order, or null
async function remoteArt(game, absPath) {
    if (game.emulator === 'dolphin') {
        const id = await dolphinGameId(absPath);
        return id && dolphinCoverUrls(id);
    }
    if (game.emulator === 'pcsx2') {
        const serial = await ps2Serial(absPath);
        return serial && ps2CoverUrls(serial);
    }
    return null;
}

// ---------- Cache + background fetching ----------

function create({ cacheDir, romsDir, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000, concurrency = 2 }) {
    const queued = new Set();
    const waiting = [];
    let active = 0;
    let pending = 0;

    const cacheFile = (id, ext) => path.join(cacheDir, `${id}.${ext}`);
    const missFile = id => path.join(cacheDir, `${id}.miss`);

    // A picture beside the game (Game.iso + Game.png) overrides everything
    function sidecar(game) {
        const base = path.join(romsDir, game.path).replace(/\.[^./\\]+$/, '');
        for (const ext of SIDECAR_EXTS) {
            if (fs.existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
        }
        return null;
    }

    // The picture file for a game if we already have it
    function find(game) {
        const side = sidecar(game);
        if (side) return side;
        for (const ext of ['png', 'jpg', 'webp']) {
            const f = cacheFile(game.id, ext);
            if (fs.existsSync(f)) return f;
        }
        return null;
    }

    function recentlyMissed(id) {
        try { return now() - fs.statSync(missFile(id)).mtimeMs < MISS_RETRY_MS; } catch { return false; }
    }

    async function store(id, buf) {
        const ext = imageType(buf);
        if (!ext || buf.length > MAX_IMAGE_BYTES) return false;
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(cacheFile(id, ext), buf);
        return true;
    }

    async function download(urls) {
        let networkDown = false;
        for (const url of urls) {
            try {
                const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
                if (!res.ok) continue;
                const buf = Buffer.from(await res.arrayBuffer());
                if (imageType(buf)) return { buf };
            } catch {
                networkDown = true;
            }
        }
        return { networkDown };
    }

    async function fetchOne(game) {
        const abs = path.join(romsDir, game.path);
        try {
            const embedded = await embeddedArt(game, abs);
            if (embedded && await store(game.id, embedded)) return;

            const urls = await remoteArt(game, abs);
            if (urls) {
                const { buf, networkDown } = await download(urls);
                if (buf && await store(game.id, buf)) return;
                if (networkDown) return; // offline: try again next time, don't remember it as missing
            }
        } catch (err) {
            console.warn(`[ART] ${game.title}: ${err.message}`);
        }
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(missFile(game.id), '');
    }

    function pump() {
        while (active < concurrency && waiting.length) {
            const game = waiting.shift();
            active++;
            fetchOne(game).finally(() => {
                active--;
                pending--;
                queued.delete(game.id);
                pump();
            });
        }
    }

    // Queues background lookups for games that have no picture yet
    function ensure(games) {
        for (const game of games) {
            if (queued.has(game.id) || find(game) || recentlyMissed(game.id)) continue;
            queued.add(game.id);
            pending++;
            waiting.push(game);
        }
        pump();
    }

    return { find, ensure, pending: () => pending };
}

module.exports = { create, isoFind, isoReadFile, dolphinGameId, dolphinCoverUrls, ps2Serial, ps2CoverUrls, pbpIcon, imageType };
