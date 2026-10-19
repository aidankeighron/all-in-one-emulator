// Save slots and their syncing.
//
//   menu starts / "Sync now"   syncAll(): fetch, upload anything queued, download newer saves for slots already here
//   click a game               listSlots() shows the slots; prepare() downloads a newer cloud save before the game starts
//   game closes                finish() uploads the slot that was played (queued if offline)
//
// A slot is a named save with its own folder on each computer. Each upload bumps the slot's rev. A computer
// remembers the rev and content hash it last synced; if the cloud moved on while this computer also changed
// the save, that is a conflict and the person chooses (resolve()). Nothing is overwritten silently: the local
// copy is zipped to backups/ before any download replaces it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archive = require('./archive');
const { Store, StoreError } = require('./store');

const KEEP_BACKUPS = 5;
const MAX_ZIP_BYTES = 90 * 1024 * 1024;

class SaveError extends Error {
    constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra); }
}

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
const gameKeyOf = game => `${game.console}/${slug(game.title)}`;

// Is this repository readable by anyone? 'unknown' when it isn't on GitHub or GitHub can't be reached.
async function repoVisibility(url, fetchImpl = globalThis.fetch) {
    const m = String(url).match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (!m) return 'unknown';
    try {
        const res = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}`, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'emulator-menu' } });
        return res.status === 200 ? 'public' : res.status === 404 ? 'private' : 'unknown';
    } catch {
        return 'unknown';
    }
}

function createManager({ dir, adapters, getCloud, deviceName = os.hostname(), visibility = repoVisibility, log = () => {} }) {
    const stateFile = path.join(dir, 'state.json');
    const tmpDir = path.join(dir, 'tmp');
    const backupDir = path.join(dir, 'backups');

    let state = { device: { id: crypto.randomBytes(4).toString('hex') }, slots: {} };
    try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
    const saveState = () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    };

    let activity = { state: 'idle', message: '', slotName: '', at: 0 };
    const setActivity = (s, message = '', slotName = '') => { activity = { state: s, message, slotName, at: Date.now() }; log(`[SAVES] ${s} ${message}`); };

    let chain = Promise.resolve();
    const locked = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

    let store = null;
    let storeKey = '';
    let lastSync = null;
    let lastError = null;
    const visibilityCache = new Map();

    const device = () => ({ id: state.device.id, name: getCloud().deviceName || deviceName });

    function currentStore() {
        const cfg = getCloud();
        if (!cfg.enabled || !cfg.repoUrl) return null;
        const key = `${cfg.repoUrl}\0${cfg.passphrase || ''}`;
        if (key !== storeKey) {
            store = new Store({ dir: path.join(dir, 'repo'), url: cfg.repoUrl, passphrase: cfg.passphrase || '' });
            storeKey = key;
        }
        return store;
    }

    async function visibilityOf(url) {
        const hit = visibilityCache.get(url);
        if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
        const value = await visibility(url);
        visibilityCache.set(url, { value, at: Date.now() });
        return value;
    }

    const adapterFor = game => {
        const a = adapters.get(game.emulator);
        if (!a) throw new SaveError('UNSUPPORTED', 'Save slots are not available for this emulator');
        return a;
    };

    async function refreshRemote() {
        const s = currentStore();
        if (!s) return null;
        try {
            await s.refresh();
            lastSync = Date.now();
            lastError = null;
            return s;
        } catch (err) {
            lastError = { code: err.code, message: err.message };
            if (err.code === 'OFFLINE' || err.code === 'NO_GIT') return null;
            if (err.code === 'NEED_PASSPHRASE' || err.code === 'BAD_PASSPHRASE') throw new SaveError(err.code, err.message);
            throw err;
        }
    }

    function slotRecord(game, meta, name) {
        return {
            id: meta ? meta.id : crypto.randomBytes(6).toString('hex'),
            name: name || meta.name,
            game: game.title,
            gameKey: gameKeyOf(game),
            console: game.console,
            emulator: game.emulator,
            rev: 0,
            baseHash: null,
            pending: false,
            conflict: false,
            createdAt: new Date().toISOString()
        };
    }

    function backupLocal(adapter, slotId, root) {
        const file = path.join(backupDir, `${slotId}-${Date.now()}.zip`);
        return archive.zipDirs(root, adapter.perSlot, file).then(({ files }) => {
            if (!files) { fs.rmSync(file, { force: true }); return; }
            const mine = fs.readdirSync(backupDir).filter(n => n.startsWith(`${slotId}-`)).sort();
            for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) fs.rmSync(path.join(backupDir, old), { force: true });
        });
    }

    // Replaces the slot's local save with the cloud version (or an older commit of it)
    async function download(adapter, st, remoteMeta, s, ref) {
        const root = adapter.slotRoot(st.id);
        const zip = path.join(tmpDir, `${st.id}.zip`);
        setActivity('downloading', `Downloading “${st.name}”…`, st.name);
        await s.readData(st.gameKey, st.id, zip, ref);
        adapter.assemble(root);
        await backupLocal(adapter, st.id, root);
        archive.clearDirs(root, adapter.perSlot);
        await archive.unzipTo(zip, root);
        fs.rmSync(zip, { force: true });
        st.rev = remoteMeta.rev;
        st.baseHash = await archive.hashDirs(root, adapter.perSlot);
        st.pending = false;
        st.conflict = false;
        st.updatedAt = remoteMeta.updatedAt;
        saveState();
    }

    // Zips the slot and uploads it as the next rev. Throws StoreError CONFLICT if the cloud moved on.
    async function upload(adapter, st, s, expectRev, hash) {
        const root = adapter.slotRoot(st.id);
        const zip = path.join(tmpDir, `${st.id}-up.zip`);
        try {
            const { bytes } = await archive.zipDirs(root, adapter.perSlot, zip, MAX_ZIP_BYTES);
            const meta = {
                id: st.id, name: st.name, game: st.game, gameKey: st.gameKey, console: st.console, emulator: st.emulator,
                rev: expectRev + 1, updatedAt: new Date().toISOString(), device: device().name, sizeBytes: bytes, hash
            };
            await s.put({ gameKey: st.gameKey, meta, zipFile: zip, expectRev });
            st.rev = meta.rev;
            st.baseHash = hash;
            st.pending = false;
            st.conflict = false;
            st.updatedAt = meta.updatedAt;
            saveState();
            return meta;
        } finally {
            fs.rmSync(zip, { force: true });
        }
    }

    const describe = (st, meta) => ({
        id: st.id, name: st.name, updatedAt: (meta && meta.updatedAt) || st.updatedAt || st.createdAt,
        device: meta ? meta.device : device().name, sizeBytes: meta ? meta.sizeBytes : null,
        rev: meta ? meta.rev : 0, localRev: st.rev, inCloud: !!meta, pending: !!st.pending, conflict: !!st.conflict
    });

    // ---------- public API ----------

    return {
        dir,
        activity: () => activity,
        device,

        // The slots of a game, newest first, from the cloud when reachable and from this computer otherwise
        listSlots(game) {
            return locked(async () => {
                adapterFor(game);
                const key = gameKeyOf(game);
                setActivity('checking', 'Checking for newer saves…');
                let s = null, online = false, problem = null;
                try { s = await refreshRemote(); online = !!s; } catch (err) { problem = { code: err.code, message: err.message }; }
                const remote = new Map(online ? s.listSlots(key).map(m => [m.id, m]) : []);
                const local = Object.values(state.slots).filter(x => x.gameKey === key);
                const ids = new Set([...remote.keys(), ...local.map(x => x.id)]);
                const slots = [...ids].map(id => describe(state.slots[id] || { id, name: remote.get(id).name, rev: 0 }, remote.get(id)));
                slots.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
                setActivity('idle');
                return { slots, online, configured: !!currentStore(), problem, checkedAt: Date.now() };
            });
        },

        createSlot(game, name) {
            return locked(async () => {
                const adapter = adapterFor(game);
                const clean = String(name || '').trim().slice(0, 24);
                if (!clean) throw new SaveError('BAD_NAME', 'Give the save a name');
                const st = slotRecord(game, null, clean);
                const root = adapter.slotRoot(st.id);
                fs.mkdirSync(root, { recursive: true });
                for (const d of adapter.perSlot) fs.mkdirSync(path.join(root, d), { recursive: true });
                st.baseHash = await archive.hashDirs(root, adapter.perSlot);
                state.slots[st.id] = st;
                saveState();
                return describe(st, null);
            });
        },

        renameSlot(game, slotId, name) {
            return locked(async () => {
                const clean = String(name || '').trim().slice(0, 24);
                if (!clean) throw new SaveError('BAD_NAME', 'Give the save a name');
                const key = gameKeyOf(game);
                const st = state.slots[slotId];
                if (st) { st.name = clean; saveState(); }
                const s = await refreshRemote().catch(() => null);
                const meta = s && s.readMeta(key, slotId);
                if (meta) { await s.putMeta({ gameKey: key, meta: { ...meta, name: clean } }); }
                return { id: slotId, name: clean, renamedInCloud: !!meta };
            });
        },

        deleteSlot(game, slotId) {
            return locked(async () => {
                const adapter = adapterFor(game);
                const key = gameKeyOf(game);
                const s = await refreshRemote().catch(() => null);
                if (s && s.readMeta(key, slotId)) { await s.remove(key, slotId); }
                else if (getCloud().enabled && state.slots[slotId] && state.slots[slotId].rev > 0 && !s) {
                    throw new SaveError('OFFLINE', 'Connect to the internet to delete a save that is in the cloud');
                }
                fs.rmSync(adapter.slotRoot(slotId), { recursive: true, force: true });
                delete state.slots[slotId];
                saveState();
                return { id: slotId };
            });
        },

        // Called when a slot is chosen: makes this computer's copy current. Returns {ok} or {conflict}.
        prepare(game, slotId) {
            return locked(async () => {
                const adapter = adapterFor(game);
                const key = gameKeyOf(game);
                let s = null;
                setActivity('checking', 'Checking for newer saves…');
                try { s = await refreshRemote(); } catch (err) { setActivity('error', err.message); throw err; }
                const remote = s ? s.readMeta(key, slotId) : null;
                let st = state.slots[slotId];
                if (!st && !remote) throw new SaveError('UNKNOWN_SLOT', 'That save no longer exists');
                if (!st) {
                    st = slotRecord(game, remote);
                    st.id = slotId;
                    fs.mkdirSync(adapter.slotRoot(slotId), { recursive: true });
                    adapter.assemble(adapter.slotRoot(slotId));
                    st.baseHash = await archive.hashDirs(adapter.slotRoot(slotId), adapter.perSlot);
                    state.slots[slotId] = st;
                }
                const root = adapter.slotRoot(slotId);
                adapter.assemble(root);
                const localHash = await archive.hashDirs(root, adapter.perSlot);
                const changed = localHash !== st.baseHash;
                if (remote && remote.rev > st.rev) {
                    if (changed) {
                        st.conflict = true;
                        saveState();
                        setActivity('conflict', `“${st.name}” is different on two computers`, st.name);
                        return { conflict: { slotId, name: st.name, local: { updatedAt: st.updatedAt || st.createdAt, device: device().name }, remote } };
                    }
                    await download(adapter, st, remote, s);
                }
                saveState();
                setActivity('idle');
                return { ok: true, slotRoot: root, online: !!s };
            });
        },

        // The person's answer to a conflict: 'cloud' | 'local' | 'both'
        resolve(game, slotId, choice) {
            return locked(async () => {
                const adapter = adapterFor(game);
                const key = gameKeyOf(game);
                const s = await refreshRemote();
                if (!s) throw new SaveError('OFFLINE', 'Connect to the internet to choose between the two saves');
                const st = state.slots[slotId];
                const remote = s.readMeta(key, slotId);
                if (!st || !remote) throw new SaveError('UNKNOWN_SLOT', 'That save no longer exists');
                const root = adapter.slotRoot(slotId);
                adapter.assemble(root);
                const localHash = await archive.hashDirs(root, adapter.perSlot);

                if (choice === 'cloud') {
                    await download(adapter, st, remote, s);
                } else if (choice === 'local') {
                    await upload(adapter, st, s, remote.rev, localHash);
                } else if (choice === 'both') {
                    const copy = slotRecord(game, null, `${st.name} (this computer)`.slice(0, 24));
                    const copyRoot = adapter.slotRoot(copy.id);
                    fs.mkdirSync(copyRoot, { recursive: true });
                    for (const d of adapter.perSlot) fs.cpSync(path.join(root, d), path.join(copyRoot, d), { recursive: true });
                    copy.baseHash = await archive.hashDirs(copyRoot, adapter.perSlot);
                    copy.pending = true;
                    state.slots[copy.id] = copy;
                    await upload(adapter, copy, s, 0, copy.baseHash);
                    await download(adapter, st, remote, s);
                } else {
                    throw new SaveError('BAD_CHOICE', 'Unknown choice');
                }
                setActivity('idle');
                return { ok: true };
            });
        },

        // The game closed: send the slot's save to the cloud (or queue it)
        finish(game, slotId) {
            return locked(async () => {
                const adapter = adapters.get(game.emulator);
                const st = state.slots[slotId];
                if (!adapter || !st) return { status: 'none' };
                const root = adapter.slotRoot(slotId);
                const hash = await archive.hashDirs(root, adapter.perSlot);
                if (hash === st.baseHash) { setActivity('idle'); return { status: 'unchanged' }; }
                const cfg = getCloud();
                if (!cfg.enabled || !cfg.repoUrl) { setActivity('idle'); return { status: 'local' }; }
                setActivity('uploading', `Saving “${st.name}” to the cloud…`, st.name);
                try {
                    const s = await refreshRemote();
                    if (!s) throw new StoreError('OFFLINE', 'offline');
                    const remote = s.readMeta(st.gameKey, st.id);
                    if (remote && remote.rev > st.rev) throw new StoreError('CONFLICT', 'The cloud save changed on another computer', { remote });
                    const meta = await upload(adapter, st, s, remote ? remote.rev : 0, hash);
                    setActivity('saved', `Saved “${st.name}” · ${(meta.sizeBytes / 1048576).toFixed(1)} MB`, st.name);
                    return { status: 'saved', meta };
                } catch (err) {
                    st.pending = true;
                    if (err.code === 'CONFLICT') {
                        st.conflict = true;
                        setActivity('conflict', `“${st.name}” changed on another computer: choose which to keep next time you play it`, st.name);
                    } else if (err.code === 'OFFLINE' || err.code === 'NO_GIT') {
                        setActivity('queued', `No connection: “${st.name}” will be saved to the cloud later`, st.name);
                    } else {
                        setActivity('error', err.message, st.name);
                    }
                    saveState();
                    return { status: err.code === 'CONFLICT' ? 'conflict' : 'queued', error: err.message };
                }
            });
        },

        // Menu start / "Sync now": send queued saves, fetch newer ones for slots that are already on this computer
        syncAll() {
            return locked(async () => {
                const result = { online: false, updated: [], uploaded: [], conflicts: [], problem: null };
                let s = null;
                try { s = await refreshRemote(); } catch (err) { result.problem = { code: err.code, message: err.message }; return result; }
                if (!s) return result;
                result.online = true;
                for (const st of Object.values(state.slots)) {
                    const adapter = adapters.get(st.emulator);
                    if (!adapter) continue;
                    const root = adapter.slotRoot(st.id);
                    if (!fs.existsSync(root)) continue;
                    const remote = s.readMeta(st.gameKey, st.id);
                    const hash = await archive.hashDirs(root, adapter.perSlot);
                    const changed = hash !== st.baseHash;
                    try {
                        if (remote && remote.rev > st.rev) {
                            if (changed) { st.conflict = true; result.conflicts.push(st.name); continue; }
                            await download(adapter, st, remote, s);
                            result.updated.push({ name: st.name, device: remote.device });
                        } else if (changed && st.pending && !st.conflict) {
                            await upload(adapter, st, s, remote ? remote.rev : 0, hash);
                            result.uploaded.push(st.name);
                        }
                    } catch (err) {
                        log(`[SAVES] sync ${st.name}: ${err.message}`);
                        if (err.code === 'UNENCRYPTED_PUBLIC') result.problem = { code: err.code, message: err.message };
                    }
                }
                saveState();
                setActivity('idle');
                return result;
            });
        },

        history(game, slotId) {
            return locked(async () => {
                const s = await refreshRemote();
                if (!s) throw new SaveError('OFFLINE', 'Connect to the internet to see older versions');
                return (await s.history(gameKeyOf(game), slotId)).map(v => ({ sha: v.sha, date: v.date, rev: v.meta.rev, device: v.meta.device, sizeBytes: v.meta.sizeBytes }));
            });
        },

        // Makes an older version the current one (uploaded as a new rev, so nothing is lost)
        restore(game, slotId, sha) {
            return locked(async () => {
                const adapter = adapterFor(game);
                const key = gameKeyOf(game);
                const s = await refreshRemote();
                if (!s) throw new SaveError('OFFLINE', 'Connect to the internet to restore an older version');
                const st = state.slots[slotId];
                const remote = s.readMeta(key, slotId);
                if (!st || !remote) throw new SaveError('UNKNOWN_SLOT', 'That save no longer exists');
                await download(adapter, st, { ...remote }, s, sha);
                st.rev = remote.rev;          // based on the current cloud rev, so this upload is the next one
                const hash = await archive.hashDirs(adapter.slotRoot(slotId), adapter.perSlot);
                await upload(adapter, st, s, remote.rev, hash);
                return { ok: true };
            });
        },

        // Cloud status for Settings
        async status() {
            const cfg = getCloud();
            const s = currentStore();
            const slots = Object.values(state.slots);
            const devices = new Map();
            if (s && fs.existsSync(path.join(dir, 'repo', '.git'))) {
                try {
                    s.loadFormat();
                    for (const m of s.listSlots()) {
                        const seen = devices.get(m.device);
                        if (!seen || m.updatedAt > seen) devices.set(m.device, m.updatedAt);
                    }
                } catch { /* locked or not synced yet */ }
            }
            return {
                enabled: !!cfg.enabled,
                configured: !!(cfg.enabled && cfg.repoUrl),
                repoUrl: String(cfg.repoUrl || '').replace(/\/\/[^/@]*@/, '//'),   // never show a token embedded in the URL
                encrypted: !!cfg.passphrase,
                visibility: cfg.repoUrl ? await visibilityOf(cfg.repoUrl) : 'unknown',
                device: device().name,
                deviceName: cfg.deviceName || '',
                lastSync,
                lastError,
                pending: slots.filter(x => x.pending).length,
                devices: [...devices].map(([name, lastSeen]) => ({ name, lastSeen })).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
            };
        }
    };
}

module.exports = { createManager, SaveError, gameKeyOf, repoVisibility };
