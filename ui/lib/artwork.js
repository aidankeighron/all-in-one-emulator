// Game artwork. Where each system's picture comes from:
//   Wii / GameCube  the 6-character game ID in the disc header, then the cover from GameTDB
//                   (the same source Dolphin's own cover view downloads from)
//   Switch + any    the game's name is searched on Wikipedia, which has box art for nearly every release, and the
//   game left      match is checked (same title, a single video game, not a series page) before it is used
//   anything        a picture next to the game with the same name (game.png / .jpg / .webp) wins
// Downloaded pictures are cached, so each game is fetched once.
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const ART_BASE = 'https://art.gametdb.com';
const SIDECAR_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
// Bumped when the lookup gets better, so games that missed before are looked up again
const LOOKUP_VERSION = '2';
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

// ---------- Finding a cover by name ----------

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const SEARCH_HINT = { switch: 'Nintendo Switch', wii: 'Wii', gamecube: 'GameCube' };
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'in', 'on']);

// Words of a title, lower case, without accents, punctuation, edition tags or small words
function titleWords(text) {
    return String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
        .split(' ').filter(w => w && !STOP_WORDS.has(w));
}

// How well a Wikipedia article title matches the game: 1 is the same words, 0 is nothing in common
function titleMatch(articleTitle, gameTitle) {
    const a = new Set(titleWords(articleTitle)), g = new Set(titleWords(gameTitle));
    if (!a.size || !g.size) return 0;
    const shared = [...a].filter(w => g.has(w)).length;
    return shared / (a.size + g.size - shared);
}

// Picks the article that is this game and returns its picture URLs, best first. results: Wikipedia's page objects.
function chooseCovers(results, gameTitle) {
    return results
        .filter(p => p.thumbnail && p.thumbnail.source)
        .map(p => {
            const text = `${p.title} ${p.description || ''}`;
            const notAGame = /series|franchise|media|soundtrack|film|character|list of/i.test(`${p.title} ${p.description || ''}`);
            const isGame = /video game|\bgame\b/i.test(text);
            const score = titleMatch(p.title, gameTitle);
            // Wikipedia often has no short description: an article with exactly the game's name is accepted anyway
            return { url: p.thumbnail.source, score: !notAGame && (isGame || (!p.description && score >= 0.99)) ? score : 0, index: p.index || 99 };
        })
        .filter(c => c.score >= 0.75)
        .sort((x, y) => y.score - x.score || x.index - y.index)
        .map(c => c.url);
}

// Searches Wikipedia for the game by name. Returns picture URLs to try; throws if the network is down.
async function searchCoverUrls(game, fetchImpl, timeoutMs) {
    const hint = SEARCH_HINT[game.console] || '';
    // The precise search first, then the plain name when that finds nothing
    const queries = [`${game.title} ${hint} video game`, `${game.title} video game`];
    for (const q of queries) {
        const params = new URLSearchParams({
            action: 'query', format: 'json', generator: 'search', gsrsearch: q.replace(/\s+/g, ' ').trim(),
            gsrlimit: '8', gsrnamespace: '0', prop: 'pageimages|description', piprop: 'thumbnail', pilicense: 'any', pithumbsize: '400', redirects: '1', origin: '*'
        });
        const res = await fetchImpl(`${WIKI_API}?${params}`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'EmulatorMenu/1.0 (personal game launcher)' } });
        if (!res.ok) continue;
        const data = await res.json();
        const urls = chooseCovers(Object.values((data.query && data.query.pages) || {}), game.title);
        if (urls.length) return urls;
    }
    return [];
}

// Where to download a cover from: a list of URLs to try in order, or null
async function remoteArt(game, absPath) {
    if (game.emulator === 'dolphin') {
        const id = await dolphinGameId(absPath);
        return id && dolphinCoverUrls(id);
    }
    return null;
}

// ---------- Cache + background fetching ----------

function create({ cacheDir, romsDir, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000, concurrency = 2, search = searchCoverUrls }) {
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
        try {
            return fs.readFileSync(missFile(id), 'utf8') === LOOKUP_VERSION && now() - fs.statSync(missFile(id)).mtimeMs < MISS_RETRY_MS;
        } catch { return false; }
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
                const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'EmulatorMenu/1.0 (personal game launcher)' } });
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
            // 1. an ID read from the disc (Wii / GameCube), 2. the game's name
            const byId = await remoteArt(game, abs);
            let offline = false;
            if (byId) {
                const { buf, networkDown } = await download(byId);
                if (buf && await store(game.id, buf)) return;
                offline = !!networkDown;
            }
            if (!offline) {
                let urls = [];
                try { urls = await search(game, fetchImpl, timeoutMs); } catch { offline = true; }
                if (urls.length) {
                    const { buf, networkDown } = await download(urls);
                    if (buf && await store(game.id, buf)) return;
                    offline = offline || !!networkDown;
                }
            }
            if (offline) return; // no connection: try again next time, don't remember it as missing
        } catch (err) {
            console.warn(`[ART] ${game.title}: ${err.message}`);
        }
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(missFile(game.id), LOOKUP_VERSION);
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

    // Forget which games had no picture, so the next look-up tries them all again
    function retryMisses() {
        let n = 0;
        try {
            for (const f of fs.readdirSync(cacheDir)) if (f.endsWith('.miss')) { fs.rmSync(path.join(cacheDir, f), { force: true }); n++; }
        } catch { /* no cache folder yet */ }
        return n;
    }

    return { find, ensure, retryMisses, pending: () => pending };
}

module.exports = { create, dolphinGameId, dolphinCoverUrls, imageType, titleMatch, chooseCovers, searchCoverUrls };
