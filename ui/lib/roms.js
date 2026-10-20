const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const fsp = fs.promises;
const MIN_AGE_MS = 60 * 1000;          // zips modified more recently may still be copying
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

// Display name only: the file on disk is never renamed. Drops tags such as "(USA)", "(Rev 1)", "[0100...][v0]"
// (Switch dumps carry the title ID and version in brackets), turns "Name - Subtitle" into "Name: Subtitle", and
// never ends up empty.
function cleanTitle(name) {
    const spaced = name.replace(/_/g, ' ').replace(/\s+-\s+/g, ': ').replace(/\s+/g, ' ').trim();
    const stripped = spaced.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').replace(/\s+:/g, ':').trim();
    return stripped || spaced;
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

            if (stat.isDirectory() || !emu.extensions.includes(extOf(entry))) continue;
            const title = path.basename(entry, path.extname(entry));

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

// What an archive really is, going by its first bytes rather than its name
async function archiveKind(file) {
    const m = hex(await readMagic(file, 0, 4));
    if (m === '504b0304' || m === '504b0506') return 'zip';
    if (m === '52617221') return 'rar';
    if (m.startsWith('377abcaf')) return '7z';
    return 'unknown';
}

// Why an archive can't be opened as a zip, rar or 7z (undefined if it looks like one)
async function describeNonZip(file) {
    const m = hex(await readMagic(file, 0, 4));
    if (m === '504b0304' || m === '504b0506' || m === '52617221' || m.startsWith('377abcaf')) return undefined;
    if (m.startsWith('1f8b')) return 'it is a gzip file, not a zip';
    if (m === '3c21444f' || m === '3c68746d' || m === '3c48544d') return 'it is an HTML page (a failed download?), not a zip';
    if (m === '') return 'it is empty';
    return 'it does not start like a zip file (incomplete or corrupt download/copy?)';
}

function findSevenZip() {
    const win = process.platform === 'win32';
    const dirs = (process.env.PATH || '').split(path.delimiter);
    if (win) {
        for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) dirs.push(path.join(base, '7-Zip'));
    }
    for (const name of ['7z', '7zz', '7za']) {
        for (const dir of dirs) {
            const p = path.join(dir, win ? `${name}.exe` : name);
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
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

// RAR is read by a bundled library, so nothing has to be installed. Entries are flattened and renamed by position
// (no folder structure from the archive reaches the disk).
async function extractRar(archive, tmpDir, wanted) {
    const { createExtractorFromFile } = require('node-unrar-js');
    const extractor = await createExtractorFromFile({ filepath: archive, targetPath: tmpDir, filenameTransform: name => path.basename(name) });
    const names = [...extractor.getFileList().fileHeaders]
        .filter(h => !h.flags.directory && wanted.has(extOf(h.name)))
        .map(h => h.name);
    if (names.length === 0) return [];
    const { files } = extractor.extract({ files: names });
    for (const _ of files) { /* extraction happens as the iterator is consumed */ }
    return (await walkFiles(tmpDir)).filter(i => wanted.has(extOf(i.name)));
}

// Command-line tools that can unpack a RAR, best first. The bundled library below runs in WebAssembly and fails
// ("File read error") on big archives such as Switch games, so a real tool is used when the computer has one.
function findRarTool() {
    const seven = findSevenZip();
    if (seven) return { bin: seven, args: (a, t) => ['x', '-y', `-o${t}`, a] };
    const win = process.platform === 'win32';
    const dirs = (process.env.PATH || '').split(path.delimiter);
    const find = name => { for (const d of dirs) { const p = path.join(d, win ? `${name}.exe` : name); if (fs.existsSync(p)) return p; } return null; };
    const unrar = find('unrar') || (win && fs.existsSync('C:\\Program Files\\WinRAR\\UnRAR.exe') ? 'C:\\Program Files\\WinRAR\\UnRAR.exe' : null);
    if (unrar) return { bin: unrar, args: (a, t) => ['x', '-y', '-o+', a, t + path.sep] };
    const unar = find('unar');
    if (unar) return { bin: unar, args: (a, t) => ['-q', '-f', '-o', t, a] };
    const bsdtar = find('bsdtar');
    if (bsdtar) return { bin: bsdtar, args: (a, t) => ['-xf', a, '-C', t] };
    return null;
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
        else if (e.isFile() && /\.(zip|rar|7z)$/i.test(e.name)) zips.push(p);
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
// A zip already inside a known folder (roms/switch/x.zip) stays in that folder.
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
        const kind = why ? 'unknown' : await archiveKind(zip);
        if (why || (kind === '7z' && !sevenZip)) {
            log(`FAILED ${rel}: ${why || `it is a 7z archive (install ${process.platform === 'win32' ? '7-Zip' : 'p7zip-full'} to import it)`}`);
            failed++;
            continue;
        }

        log(`Extracting ${rel}`);
        const tmp = await fsp.mkdtemp(path.join(romsDir, '.extract-'));
        try {
            let items;
            if (kind === 'rar') {
                const tool = findRarTool();
                if (tool) {
                    await new Promise((resolve, reject) => execFile(tool.bin, tool.args(zip, tmp), { maxBuffer: 64 * 1024 * 1024 }, err => err ? reject(err) : resolve()));
                    items = (await walkFiles(tmp)).filter(i => gameExts.has(extOf(i.name)));
                } else {
                    try {
                        items = await extractRar(zip, tmp, gameExts);
                    } catch (err) {
                        throw new Error(`${err.message}. Big RAR files need 7-Zip or unrar: ${process.platform === 'win32' ? 'install 7-Zip' : 'sudo apt install p7zip-full (or unrar)'} and try again`);
                    }
                }
            } else if (kind === '7z') {
                await extractWithSevenZip(sevenZip, zip, tmp);
                items = (await walkFiles(tmp)).filter(i => gameExts.has(extOf(i.name)));
            } else {
                items = await extractZip(zip, tmp, gameExts);
            }

            if (items.length === 0) {
                log(`No game files in ${rel}; leaving it alone`);
                failed++;
                continue;
            }

            let ok = true;
            for (const item of items) {
                const folder = forced || await detectFolder(item.file, extOf(item.name), manifest);
                if (!folder) {
                    log(`Could not tell which system ${item.name} is for; skipping it. Put the archive inside roms/<system>/ (e.g. roms/switch/) to choose.`);
                    ok = false;
                    continue;
                }
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
            log(`FAILED to extract ${rel} (${size} bytes): ${err.message || 'the archive is corrupt or incomplete'}. Re-download or re-copy it and compare its size`);
            failed++;
        } finally {
            await fsp.rm(tmp, { recursive: true, force: true });
        }
    }

    log(`Done: ${added} game(s) added, ${failed} problem(s)`);
    return { ok: failed === 0, added, failed, lines };
}

module.exports = { cleanTitle, scanGames, processRoms, createDefaultFolders, folderMap };
