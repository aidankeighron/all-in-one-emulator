// Installing an emulator from inside the menu on Windows: find the newest release, download its zip and unpack it
// into the menu's own emulators folder (where the runner already looks). On Linux emulators are Flatpaks instead.
//
// Where the zip comes from is a list of sources in emulators.json (windows.release), tried in order, because a
// project's download server can be down or move. A source is
//   { "api": url }     a releases API in the format GitHub, Forgejo and Gitea share: { assets: [{ name, browser_download_url }] }
//   { "query": url }   an update server that answers with JSON (or text) holding the zip's address
// plus, optionally, "asset": a regular expression the zip's file name must match. config.json can also name a zip
// directly: "emulatorUrls": { "ryujinx": "https://.../ryujinx-win_x64.zip" }, which is tried first. It can
// also be the path of a zip you downloaded yourself, for when the servers cannot be reached.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const yauzl = require('yauzl');

const API_TIMEOUT_MS = 15000;
const STALL_MS = 30000;
const ZIP = /\.zip(\?|$)/i;

// First string anywhere inside a JSON value that looks like the address of a zip
function findZipUrl(value) {
    if (typeof value === 'string') return /^https?:\/\//i.test(value) && ZIP.test(value) ? value : null;
    if (value && typeof value === 'object') {
        for (const v of Object.values(value)) { const hit = findZipUrl(v); if (hit) return hit; }
    }
    return null;
}

// An override can also be a zip already on this computer (C:\Users\me\Downloads\ryujinx.zip or a file:// address)
const isLocal = value => /^file:/i.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/');
const localPath = value => /^file:/i.test(value) ? require('url').fileURLToPath(value) : value;

const headers = { 'User-Agent': 'EmulatorMenu/1.0 (personal game launcher)', Accept: 'application/json' };

async function fromApi(source, fetchImpl) {
    const res = await fetchImpl(source.api, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${new URL(source.api).host} answered ${res.status}`);
    const release = await res.json();
    const pattern = new RegExp(source.asset || 'win.*x64.*\\.zip$|x64.*win.*\\.zip$', 'i');
    const asset = (release.assets || []).find(a => pattern.test(a.name || '') && a.browser_download_url);
    if (!asset) throw new Error(`${new URL(source.api).host} has no Windows zip in its latest release`);
    return { url: asset.browser_download_url, name: asset.name, version: release.tag_name || release.name || '' };
}

async function fromQuery(source, fetchImpl) {
    const res = await fetchImpl(source.query, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${new URL(source.query).host} answered ${res.status}`);
    const text = await res.text();
    let url = null;
    try { url = findZipUrl(JSON.parse(text)); } catch { url = ZIP.test(text.trim()) && /^https?:\/\//i.test(text.trim()) ? text.trim() : null; }
    if (!url) throw new Error(`${new URL(source.query).host} did not give a download address`);
    return { url, name: path.basename(new URL(url).pathname), version: '' };
}

// The first source that answers. Throws one error listing why each failed.
async function findDownload({ sources = [], override, fetchImpl = globalThis.fetch }) {
    if (override) return isLocal(override) ? { url: override, name: path.basename(localPath(override)), version: '' } : { url: override, name: path.basename(new URL(override).pathname), version: '' };
    const failures = [];
    for (const source of sources) {
        try {
            return source.api ? await fromApi(source, fetchImpl) : await fromQuery(source, fetchImpl);
        } catch (err) {
            const host = (() => { try { return new URL(source.api || source.query).host; } catch { return 'a source'; } })();
            // Node's fetch only says "fetch failed"; the real reason (DNS, TLS, refused...) is on err.cause
            const why = err.cause && (err.cause.code || err.cause.message);
            const text = why && err.message === 'fetch failed' ? `could not connect (${why})` : err.message;
            failures.push(err.name === 'TimeoutError' ? `${host} did not answer in time` : text.includes(host) ? text : `${host}: ${text}`);
        }
    }
    throw new Error(failures.length ? failures.join('; ') : 'No download source is set for this emulator');
}

// Saves the url to file, reporting progress. Gives up if nothing arrives for STALL_MS.
async function download(url, file, { fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
    if (isLocal(url)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(localPath(url), file);
        return;
    }
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), STALL_MS);
    const poke = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), STALL_MS); };
    try {
        const res = await fetchImpl(url, { headers: { 'User-Agent': headers['User-Agent'] }, signal: ctl.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`the download server answered ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        let received = 0;
        const count = new Transform({ transform(chunk, _enc, cb) { received += chunk.length; poke(); onProgress(received, total); cb(null, chunk); } });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(file));
    } catch (err) {
        fs.rmSync(file, { force: true });
        throw err.name === 'AbortError' ? new Error('the download stopped arriving') : err;
    } finally {
        clearTimeout(timer);
    }
}

// Unpacks the zip into destDir (nothing may land outside it)
function unzip(zipFile, destDir) {
    return new Promise((resolve, reject) => {
        const root = path.resolve(destDir);
        yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zf) => {
            if (err) return reject(err);
            zf.on('error', reject);
            zf.on('end', resolve);
            zf.on('entry', entry => {
                const target = path.resolve(root, entry.fileName);
                if (target !== root && !target.startsWith(root + path.sep)) return zf.readEntry();   // zip-slip
                if (entry.fileName.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); return zf.readEntry(); }
                zf.openReadStream(entry, (err2, stream) => {
                    if (err2) return reject(err2);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    pipeline(stream, fs.createWriteStream(target)).then(() => zf.readEntry(), reject);
                });
            });
            zf.readEntry();
        });
    });
}

// Installs one emulator. Resolves 0 on success, 1 on failure (like the Flatpak installer); onLine reports progress.
async function install(emu, { emulatorsDir, override, fetchImpl = globalThis.fetch, onLine = () => {}, findExe }) {
    const release = emu.windows && emu.windows.release;
    const dest = path.join(emulatorsDir, emu.id);
    const tmp = path.join(emulatorsDir, `.${emu.id}-download.zip`);
    try {
        onLine('Looking for the latest version…');
        const found = await findDownload({ sources: release, override, fetchImpl });
        onLine(`Downloading ${found.name}${found.version ? ` (${found.version})` : ''}…`);
        let lastShown = 0;
        await download(found.url, tmp, {
            fetchImpl,
            onProgress: (got, total) => {
                const now = Date.now();
                if (now - lastShown < 400) return;
                lastShown = now;
                onLine(total ? `Downloading… ${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB` : `Downloading… ${Math.round(got / 1048576)} MB`);
            }
        });
        onLine('Unpacking…');
        const staging = `${dest}.new`;
        fs.rmSync(staging, { recursive: true, force: true });
        await unzip(tmp, staging);
        if (findExe && !findExe(staging)) throw new Error(`the download did not contain ${emu.windows.exe}`);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(staging, dest);
        onLine('Installed');
        return 0;
    } catch (err) {
        onLine(`Failed: ${err.message}. You can still download it yourself, unzip it into ${dest} and it is found automatically, or press Locate.`);
        return 1;
    } finally {
        fs.rmSync(tmp, { force: true });
        fs.rmSync(`${dest}.new`, { recursive: true, force: true });
    }
}

// Removes an emulator the menu installed (only ever inside its own emulators folder)
function uninstall(emu, { emulatorsDir, onLine = () => {} }) {
    fs.rmSync(path.join(emulatorsDir, emu.id), { recursive: true, force: true });
    onLine('Removed');
    return Promise.resolve(0);
}

module.exports = { install, uninstall, findDownload, download, unzip, findZipUrl };
