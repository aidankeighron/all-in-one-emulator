const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const fsp = fs.promises;
const MIN_AGE_MS = 60 * 1000;          // zips modified more recently may still be copying
const COMPANION_EXTS = new Set(['bin']); // .cue sheets need their .bin files alongside
const MAX_DEPTH = 3;

function extOf(name) {
    return path.extname(name).slice(1).toLowerCase();
}

function folderMap(manifest) {
    const map = new Map();
    for (const emu of manifest.emulators) {
        for (const folder of emu.folders) map.set(folder, emu);
    }
    return map;
}

function createDefaultFolders(romsDir, manifest) {
    for (const folder of folderMap(manifest).keys()) {
        try { fs.mkdirSync(path.join(romsDir, folder), { recursive: true }); } catch { /* reported when importing */ }
    }
}

// ---------- Game list ----------

function cleanTitle(name) {
    return name.replace(/[-_]/g, ' ').trim();
}

function scanGames(romsDir, manifest) {
    const games = [];
    if (!fs.existsSync(romsDir)) return games;
    const byFolder = folderMap(manifest);

    for (const d of fs.readdirSync(romsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const emu = byFolder.get(d.name.toLowerCase());
        if (!emu) continue;
        const dir = path.join(romsDir, d.name);

        for (const entry of fs.readdirSync(dir)) {
            if (entry.startsWith('.')) continue;
            let stat;
            try { stat = fs.statSync(path.join(dir, entry)); } catch { continue; }

            let title;
            if (stat.isDirectory()) {
                if (!emu.directoryMarker || !fs.existsSync(path.join(dir, entry, emu.directoryMarker))) continue;
                title = entry;
            } else {
                if (!emu.extensions.includes(extOf(entry))) continue;
                title = path.basename(entry, path.extname(entry));
            }

            const rel = `${d.name}/${entry}`;
            games.push({
                id: crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12),
                title: cleanTitle(title),
                console: d.name.toLowerCase(),
                emulator: emu.id,
                path: rel
            });
        }
    }
    return games.sort((a, b) => a.title.localeCompare(b.title));
}

// ---------- Zip import ----------

function hex(buf) {
    return buf.toString('hex');
}

async function readMagic(file, offset, length) {
    const fh = await fsp.open(file, 'r');
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

// Why a ".zip" can't be opened as a zip (undefined if it looks like one)
async function describeNonZip(file) {
    const m = hex(await readMagic(file, 0, 4));
    if (m === '504b0304' || m === '504b0506') return undefined;
    if (m.startsWith('377abcaf')) return 'it is a 7z archive renamed to .zip';
    if (m === '52617221') return 'it is a RAR archive renamed to .zip';
    if (m.startsWith('1f8b')) return 'it is a gzip file, not a zip';
    if (m === '3c21444f' || m === '3c68746d' || m === '3c48544d') return 'it is an HTML page (a failed download?), not a zip';
    if (m === '') return 'it is empty';
    return 'it does not start like a zip file (incomplete or corrupt download/copy?)';
}

function findSevenZip() {
    const dirs = (process.env.PATH || '').split(path.delimiter);
    for (const name of ['7z', '7zz', '7za']) {
        for (const dir of dirs) {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

function listZip(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
            if (err) return reject(err);
            const names = [];
            zf.on('error', reject);
            zf.on('end', () => resolve(names));
            zf.on('entry', e => { names.push(e.fileName); zf.readEntry(); });
            zf.readEntry();
        });
    });
}

// Extracts entries with the wanted extensions (flattened) into tmpDir; returns [{file, name}]
function extractZip(zipPath, tmpDir, wanted) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
            if (err) return reject(err);
            const out = [];
            zf.on('error', reject);
            zf.on('end', () => resolve(out));
            zf.on('entry', entry => {
                if (entry.fileName.endsWith('/') || !wanted.has(extOf(entry.fileName))) return zf.readEntry();
                zf.openReadStream(entry, (err, stream) => {
                    if (err) return reject(err);
                    const name = path.basename(entry.fileName); // basename only: no zip-slip
                    const file = path.join(tmpDir, `${out.length}-${name}`);
                    pipeline(stream, fs.createWriteStream(file)).then(() => {
                        out.push({ file, name });
                        zf.readEntry();
                    }, reject);
                });
            });
            zf.readEntry();
        });
    });
}

function extractWithSevenZip(bin, archive, tmpDir) {
    return new Promise((resolve, reject) => {
        execFile(bin, ['x', '-y', `-o${tmpDir}`, archive], { maxBuffer: 64 * 1024 * 1024 }, err => err ? reject(err) : resolve());
    });
}

async function walkFiles(dir) {
    const out = [];
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await walkFiles(p));
        else out.push({ file: p, name: e.name });
    }
    return out;
}

// Works out which roms/<folder> a loose file belongs in, or undefined if it can't tell
async function detectFolder(file, ext, manifest) {
    const folders = folderMap(manifest);
    const has = f => folders.has(f) ? f : undefined;

    if (ext === 'wbfs' || ext === 'wad') return has('wii');
    if (ext === 'gcm') return has('gamecube');
    if (ext === 'rvz' || ext === 'wia') {
        // disc type is a big-endian u32 at 0x48: 1 = GameCube, 2 = Wii
        const type = (await readMagic(file, 0x48, 4)).readUInt32BE(0);
        return has(type === 1 ? 'gamecube' : type === 2 ? 'wii' : undefined);
    }
    if (ext === 'iso') {
        if (hex(await readMagic(file, 0x1c, 4)) === 'c2339f3d') return has('gamecube');
        if (hex(await readMagic(file, 0x18, 4)) === '5d1c9ea3') return has('wii');
    }
    const candidates = [...folders].filter(([, emu]) => emu.extensions.includes(ext)).map(([f]) => f);
    return candidates.length === 1 ? candidates[0] : undefined;
}

async function findZips(dir, depth = 0) {
    const zips = [];
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < MAX_DEPTH) zips.push(...await findZips(p, depth + 1));
        else if (e.isFile() && e.name.toLowerCase().endsWith('.zip')) zips.push(p);
    }
    return zips;
}

async function placeFile(src, name, folder, romsDir, log) {
    const destDir = path.join(romsDir, folder);
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, name);
    if (fs.existsSync(dest)) {
        log(`Skipping ${name}: already exists in ${folder}/`);
        return false;
    }
    await fsp.rename(src, dest);
    log(`Added ${folder}/${name}`);
    return true;
}

// Unzips every .zip under romsDir and files the games into romsDir/<folder>/.
// A zip already inside a known folder (roms/ps1/x.zip) stays in that folder.
async function processRoms(romsDir, manifest, { keepZips = !!process.env.KEEP_ZIPS } = {}) {
    const lines = [];
    const log = msg => { lines.push(msg); console.log(`[ROMS] ${msg}`); };
    let added = 0, failed = 0;

    if (!fs.existsSync(romsDir)) {
        log(`ROMs folder ${romsDir} does not exist`);
        return { ok: false, added, failed: 1, lines };
    }
    createDefaultFolders(romsDir, manifest);

    const folders = folderMap(manifest);
    const gameExts = new Set(manifest.emulators.flatMap(e => e.extensions));
    const sevenZip = findSevenZip();

    for (const zip of await findZips(romsDir)) {
        const rel = path.relative(romsDir, zip);
        const parent = path.relative(romsDir, path.dirname(zip)).split(path.sep)[0].toLowerCase();
        const forced = folders.has(parent) ? parent : undefined;
        const stat = await fsp.stat(zip);

        if (Date.now() - stat.mtimeMs < MIN_AGE_MS) {
            log(`Skipping ${rel}: modified in the last minute (still copying?)`);
            continue;
        }

        const why = await describeNonZip(zip);
        if (why && !sevenZip) {
            log(`FAILED ${rel}: ${why}${why.includes('7z') || why.includes('RAR') ? ' (install p7zip-full to import it)' : ''}`);
            failed++;
            continue;
        }

        log(`Extracting ${rel}`);
        const tmp = await fsp.mkdtemp(path.join(romsDir, '.extract-'));
        try {
            let items;
            if (why) {
                await extractWithSevenZip(sevenZip, zip, tmp);
                items = (await walkFiles(tmp)).filter(i => gameExts.has(extOf(i.name)) || COMPANION_EXTS.has(extOf(i.name)));
            } else {
                const names = await listZip(zip);
                const wanted = new Set(gameExts);
                if (names.some(n => extOf(n) === 'cue')) COMPANION_EXTS.forEach(x => wanted.add(x));
                items = await extractZip(zip, tmp, wanted);
            }

            const primary = items.filter(i => !COMPANION_EXTS.has(extOf(i.name)) || gameExts.has(extOf(i.name)));
            if (primary.length === 0) {
                log(`No game files in ${rel}; leaving it alone`);
                failed++;
                continue;
            }

            let ok = true, firstFolder;
            for (const item of items) {
                const ext = extOf(item.name);
                const companion = COMPANION_EXTS.has(ext) && !gameExts.has(ext);
                const folder = companion ? firstFolder : (forced || await detectFolder(item.file, ext, manifest));
                if (!folder) {
                    log(`Could not tell which system ${item.name} is for; skipping it. Put the zip inside roms/<system>/ (e.g. roms/ps2/) to choose.`);
                    ok = false;
                    continue;
                }
                firstFolder = firstFolder || folder;
                try {
                    if (await placeFile(item.file, item.name, folder, romsDir, log)) added++;
                } catch (err) {
                    log(`FAILED to move ${item.name}: ${err.message}`);
                    ok = false;
                }
            }

            if (ok) {
                if (!keepZips) await fsp.rm(zip, { force: true });
            } else {
                failed++;
            }
        } catch (err) {
            const size = stat.size;
            log(`FAILED to extract ${rel} (${size} bytes): ${why || 'the archive is corrupt or incomplete; re-download or re-copy it and compare its size'}`);
            failed++;
        } finally {
            await fsp.rm(tmp, { recursive: true, force: true });
        }
    }

    log(`Done: ${added} game(s) added, ${failed} problem(s)`);
    return { ok: failed === 0, added, failed, lines };
}

module.exports = { scanGames, processRoms, createDefaultFolders, folderMap };
