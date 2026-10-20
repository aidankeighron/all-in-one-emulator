// Hashing, zipping and unzipping of a slot's save folders. Symlinks are never followed or stored.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');

const fsp = fs.promises;

async function walk(root, rel, out) {
    let entries;
    try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const childRel = path.join(rel, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(root, childRel, out);
        else if (e.isFile()) {
            const stat = await fsp.stat(path.join(root, childRel));
            out.push({ rel: childRel, abs: path.join(root, childRel), size: stat.size, mtime: stat.mtime });
        }
    }
    return out;
}

async function listFiles(root, relDirs) {
    const files = [];
    for (const d of relDirs) await walk(root, d, files);
    return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// One hash for everything in the folders: changes when any file is added, removed or edited
async function hashDirs(root, relDirs) {
    const h = crypto.createHash('sha256');
    for (const f of await listFiles(root, relDirs)) {
        h.update(`${f.rel}\0${f.size}\0`);
        for await (const chunk of fs.createReadStream(f.abs)) h.update(chunk);
    }
    return h.digest('hex');
}

async function zipDirs(root, relDirs, outFile, maxBytes = Infinity) {
    const files = await listFiles(root, relDirs);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > maxBytes) throw Object.assign(new Error(`The save is ${(total / 1048576).toFixed(0)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB limit`), { code: 'TOO_BIG' });
    const zip = new yazl.ZipFile();
    for (const f of files) zip.addFile(f.abs, f.rel.split(path.sep).join('/'), { mtime: f.mtime });
    zip.end();
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await pipeline(zip.outputStream, fs.createWriteStream(outFile));
    return { files: files.length, bytes: total };
}

function unzipTo(zipFile, destRoot) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zf) => {
            if (err) return reject(err);
            zf.on('error', reject);
            zf.on('end', resolve);
            zf.on('entry', entry => {
                if (entry.fileName.endsWith('/')) return zf.readEntry();
                const target = path.resolve(destRoot, entry.fileName);
                if (!target.startsWith(path.resolve(destRoot) + path.sep)) return reject(new Error(`unsafe path in save: ${entry.fileName}`));
                fsp.mkdir(path.dirname(target), { recursive: true }).then(() => {
                    zf.openReadStream(entry, (e, stream) => {
                        if (e) return reject(e);
                        pipeline(stream, fs.createWriteStream(target)).then(() => zf.readEntry(), reject);
                    });
                }, reject);
            });
            zf.readEntry();
        });
    });
}

// Empties the slot's save folders (they are recreated empty)
function clearDirs(root, relDirs) {
    for (const d of relDirs) {
        fs.rmSync(path.join(root, d), { recursive: true, force: true });
        fs.mkdirSync(path.join(root, d), { recursive: true });
    }
}

module.exports = { hashDirs, zipDirs, unzipTo, clearDirs, listFiles };
