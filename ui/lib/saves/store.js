// The cloud: saves live on a branch ("saves") of a git repository, in a local clone the menu manages.
// The working copy always mirrors origin/saves; changes are made on top of the freshest remote state and
// pushed at once, and a push that loses a race is simply redone. If a passphrase is set, everything in
// the branch is encrypted and folder names are opaque (see crypto.js).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('./crypto');

const BRANCH = 'saves';
const MAX_ATTEMPTS = 3;
const MAX_BLOB_BYTES = 90 * 1024 * 1024;   // GitHub rejects files over 100 MB

class StoreError extends Error {
    constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra); }
}

function git(args, { cwd, buffer = false, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
        execFile('git', args, { cwd, env, timeout, maxBuffer: 512 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
            if (!err) return resolve(stdout);
            const text = String(stderr || err.message).trim();
            reject(new StoreError(err.code === 'ENOENT' ? 'NO_GIT' : 'GIT', err.code === 'ENOENT' ? 'git is not installed' : text));
        });
    });
}

class Store {
    // dir: where the local clone lives; url: the remote; passphrase: '' for no encryption
    constructor({ dir, url, passphrase = '' }) {
        this.dir = dir;
        this.url = url;
        this.passphrase = passphrase;
        this.keys = null;
        this.format = null;
    }

    p(...parts) { return path.join(this.dir, ...parts); }

    async ensureRepo() {
        if (!fs.existsSync(this.p('.git'))) {
            fs.mkdirSync(this.dir, { recursive: true });
            await git(['init', '-q'], { cwd: this.dir });
            await git(['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`], { cwd: this.dir });
        }
        await git(['config', 'user.name', 'Emulator Menu'], { cwd: this.dir });
        await git(['config', 'user.email', 'emulator-menu@localhost'], { cwd: this.dir });
        let remote = null;
        try { remote = (await git(['remote', 'get-url', 'origin'], { cwd: this.dir })).trim(); } catch { /* none yet */ }
        if (remote === null) await git(['remote', 'add', 'origin', this.url], { cwd: this.dir });
        else if (remote !== this.url) await git(['remote', 'set-url', 'origin', this.url], { cwd: this.dir });
    }

    // Brings the working copy level with the remote. Throws OFFLINE when the remote can't be reached.
    async refresh() {
        await this.ensureRepo();
        let hasRemote = true;
        try {
            await git(['fetch', '-q', 'origin', `+${BRANCH}:refs/remotes/origin/${BRANCH}`], { cwd: this.dir, timeout: 60000 });
        } catch (err) {
            if (/couldn't find remote ref/i.test(err.message)) hasRemote = false;
            else if (err.code === 'NO_GIT') throw err;
            else throw new StoreError('OFFLINE', err.message);
        }
        if (hasRemote) {
            await git(['checkout', '-q', '-f', '-B', BRANCH, `origin/${BRANCH}`], { cwd: this.dir });
            await git(['clean', '-fdq'], { cwd: this.dir });
        }
        this.hasRemote = hasRemote;
        this.loadFormat();
        return { hasRemote };
    }

    // ---- encryption format ----

    loadFormat() {
        let fmt = null;
        try { fmt = JSON.parse(fs.readFileSync(this.p('format.json'), 'utf8')); } catch { /* new repo or plain */ }
        this.format = fmt;
        this.keys = null;
        if (fmt && fmt.salt) {
            if (!this.passphrase) throw new StoreError('NEED_PASSPHRASE', 'These saves are encrypted: enter the passphrase in Settings');
            this.keys = crypto.deriveKeys(this.passphrase, fmt.salt);
            try {
                if (crypto.decrypt(Buffer.from(fmt.check, 'base64'), this.keys.enc).toString() !== 'emulator-menu') throw new Error();
            } catch {
                throw new StoreError('BAD_PASSPHRASE', 'That passphrase does not match the one these saves were encrypted with');
            }
        }
    }

    // First write into an empty branch: decide plain or encrypted
    initFormat() {
        if (this.format) return;
        if (!this.passphrase) { this.format = { v: 1 }; return; }
        const salt = crypto.newSalt();
        this.keys = crypto.deriveKeys(this.passphrase, salt);
        const check = crypto.encrypt(Buffer.from('emulator-menu'), this.keys.enc).toString('base64');
        this.format = { v: 1, salt, check };
    }

    get encrypted() { return !!(this.format && this.format.salt); }

    // ---- layout ----

    gameDir(gameKey) {
        const name = this.keys ? crypto.opaqueName(this.keys.name, gameKey) : gameKey.replace(/\//g, '__');
        return path.join('saves', name);
    }

    slotRel(gameKey, slotId) { return path.join(this.gameDir(gameKey), slotId); }
    fileNames() { return this.keys ? { meta: 'meta.enc', data: 'data.enc' } : { meta: 'meta.json', data: 'data.zip' }; }

    decodeMeta(buf) {
        try { return JSON.parse((this.keys ? crypto.decrypt(buf, this.keys.enc) : buf).toString('utf8')); } catch { return null; }
    }

    encodeMeta(meta) {
        const buf = Buffer.from(JSON.stringify(meta));
        return this.keys ? crypto.encrypt(buf, this.keys.enc) : buf;
    }

    readMeta(gameKey, slotId) {
        try { return this.decodeMeta(fs.readFileSync(this.p(this.slotRel(gameKey, slotId), this.fileNames().meta))); } catch { return null; }
    }

    // Every slot of one game, or of every game when gameKey is omitted
    listSlots(gameKey) {
        const out = [];
        const gameDirs = gameKey ? [this.gameDir(gameKey)] : (() => {
            try { return fs.readdirSync(this.p('saves')).map(n => path.join('saves', n)); } catch { return []; }
        })();
        for (const g of gameDirs) {
            let ids = [];
            try { ids = fs.readdirSync(this.p(g)); } catch { continue; }
            for (const id of ids) {
                const meta = this.decodeMeta(readOrNull(this.p(g, id, this.fileNames().meta)) || Buffer.alloc(0));
                if (meta && meta.id === id) out.push(meta);
            }
        }
        return out;
    }

    // Writes the decrypted zip of a slot (current version, or an older commit) to destZip
    async readData(gameKey, slotId, destZip, ref) {
        const rel = path.join(this.slotRel(gameKey, slotId), this.fileNames().data);
        const raw = ref
            ? await git(['show', `${ref}:${rel.split(path.sep).join('/')}`], { cwd: this.dir, buffer: true })
            : fs.readFileSync(this.p(rel));
        fs.mkdirSync(path.dirname(destZip), { recursive: true });
        fs.writeFileSync(destZip, this.keys ? crypto.decrypt(raw, this.keys.enc) : raw);
    }

    // ---- writing ----

    // Runs change() on a freshly refreshed working copy, commits and pushes; redoes it if the push loses a race
    async commitAndPush(message, change) {
        let lastError;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            await this.refresh();
            this.initFormat();
            await change();
            if (this.format && !fs.existsSync(this.p('format.json'))) fs.writeFileSync(this.p('format.json'), JSON.stringify(this.format));
            await git(['add', '-A'], { cwd: this.dir });
            const dirty = (await git(['status', '--porcelain'], { cwd: this.dir })).trim();
            if (!dirty) return;
            await git(['commit', '-q', '-m', message], { cwd: this.dir });
            try {
                await git(['push', '-q', '-u', 'origin', BRANCH], { cwd: this.dir, timeout: 180000 });
                return;
            } catch (err) {
                lastError = err;
                if (/rejected|non-fast-forward|fetch first|failed to update ref/i.test(err.message)) continue;   // lost a race: redo
                throw new StoreError('PUSH', err.message);
            }
        }
        throw new StoreError('PUSH', lastError ? lastError.message : 'could not push');
    }

    // Uploads a new version of a slot. expectRev: the remote rev this upload is based on (0 = new slot).
    async put({ gameKey, meta, zipFile, expectRev }) {
        const zip = fs.readFileSync(zipFile);
        if (zip.length > MAX_BLOB_BYTES) throw new StoreError('TOO_BIG', 'This save is too big for GitHub (limit about 90 MB)');
        await this.commitAndPush(`update ${meta.id.slice(0, 8)} rev ${meta.rev}`, () => {
            const existing = this.readMeta(gameKey, meta.id);
            if ((existing ? existing.rev : 0) !== expectRev) throw new StoreError('CONFLICT', 'The cloud save changed on another computer', { remote: existing });
            const rel = this.slotRel(gameKey, meta.id);
            fs.mkdirSync(this.p(rel), { recursive: true });
            const names = this.fileNames();
            fs.writeFileSync(this.p(rel, names.data), this.keys ? crypto.encrypt(zip, this.keys.enc) : zip);
            fs.writeFileSync(this.p(rel, names.meta), this.encodeMeta(meta));
        });
    }

    // Changes only a slot's metadata (rename)
    async putMeta({ gameKey, meta }) {
        await this.commitAndPush(`rename ${meta.id.slice(0, 8)}`, () => {
            const rel = this.slotRel(gameKey, meta.id);
            if (!fs.existsSync(this.p(rel))) return;
            fs.writeFileSync(this.p(rel, this.fileNames().meta), this.encodeMeta(meta));
        });
    }

    async remove(gameKey, slotId) {
        await this.commitAndPush(`delete ${slotId.slice(0, 8)}`, () => {
            fs.rmSync(this.p(this.slotRel(gameKey, slotId)), { recursive: true, force: true });
        });
    }

    // Older versions of a slot, newest first: [{sha, date, meta}]
    async history(gameKey, slotId, limit = 15) {
        const metaRel = path.join(this.slotRel(gameKey, slotId), this.fileNames().meta).split(path.sep).join('/');
        let log = '';
        try { log = await git(['log', `-n${limit}`, '--format=%H%x09%cI', '--', metaRel], { cwd: this.dir }); } catch { return []; }
        const out = [];
        for (const line of log.split('\n').filter(Boolean)) {
            const [sha, date] = line.split('\t');
            try {
                const meta = this.decodeMeta(await git(['show', `${sha}:${metaRel}`], { cwd: this.dir, buffer: true }));
                if (meta) out.push({ sha, date, meta });
            } catch { /* this commit deleted the slot */ }
        }
        return out;
    }
}

function readOrNull(file) {
    try { return fs.readFileSync(file); } catch { return null; }
}

module.exports = { Store, StoreError, BRANCH };
