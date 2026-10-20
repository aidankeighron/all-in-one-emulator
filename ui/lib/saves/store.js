// The cloud: saves live on a branch ("saves") of a git repository, in a local clone the menu manages.
// The working copy always mirrors origin/saves; changes are made on top of the freshest remote state and
// pushed at once, and a push that loses a race is simply redone. Everything is stored as plain files:
//   saves/<console>__<game>/<slot id>/meta.json   name, rev, who saved it and when
//   saves/<console>__<game>/<slot id>/data.zip    the slot's save folders
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BRANCH = 'saves';
const MAX_ATTEMPTS = 3;
const MAX_BLOB_BYTES = 90 * 1024 * 1024;   // GitHub rejects files over 100 MB
const META = 'meta.json';
const DATA = 'data.zip';

class StoreError extends Error {
    constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra); }
}

function git(args, { cwd, buffer = false, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
        execFile('git', args, { cwd, env, timeout, maxBuffer: 512 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
            if (!err) return resolve(stdout);
            const text = String(stderr || err.message).trim();
            const timedOut = err.killed || err.signal === 'SIGTERM';
            reject(new StoreError(err.code === 'ENOENT' ? 'NO_GIT' : 'GIT', err.code === 'ENOENT' ? 'git is not installed' : timedOut ? `git took too long (it may be waiting for a GitHub sign-in): ${text}`.trim() : text));
        });
    });
}

const AUTH_FAILURE = /could not read (username|password)|terminal prompts disabled|authentication failed|permission denied|publickey|invalid username or password|returned error: 40[13]|repository not found|access denied/i;

// "https://github.com/owner/repo(.git)" -> "git@github.com:owner/repo.git"
function sshUrlOf(url) {
    const m = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url || '');
    return m ? `git@${m[1]}:${m[2]}.git` : null;
}

class Store {
    // dir: where the local clone lives; url: the remote; getToken: optional async () => access token for https remotes
    constructor({ dir, url, getToken = async () => null }) {
        this.dir = dir;
        this.url = url;
        this.getToken = getToken;
        this.mode = null;   // how the remote was last reached successfully: 'plain' | 'token' | 'ssh'
    }

    // Runs a network git command (fetch / push) against the remote, trying the ways of signing in one after the other:
    // whatever git itself has (credential helper, ssh agent), then an access token, then the ssh form of the address.
    // The way that worked is tried first next time. Throws AUTH when none of them is allowed in.
    async network(build, opts) {
        const token = await this.getToken().catch(() => null);
        const tried = [];
        const ways = {
            plain: () => build(this.url, []),
            token: token && /^https:\/\//.test(this.url)
                ? () => build(this.url, ['-c', `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`])
                : null,
            ssh: sshUrlOf(this.url) ? () => build(sshUrlOf(this.url), []) : null
        };
        const order = [this.mode, ...(token ? ['token'] : []), 'plain', 'token', 'ssh'].filter((m, i, all) => m && ways[m] && all.indexOf(m) === i);
        let authError = null;
        for (const mode of order) {
            const { args, cwd = this.dir } = ways[mode]();
            try {
                const out = await git(args, { cwd, ...opts });
                this.mode = mode;
                return out;
            } catch (err) {
                tried.push(mode);
                if (!AUTH_FAILURE.test(err.message)) throw err;
                authError = err;
            }
        }
        throw new StoreError('AUTH', `GitHub did not let the menu sign in (${tried.join(', ')}). Sign in once so git can save: run “gh auth login”, or put a token in config.json as cloudToken, or set up an SSH key. (${authError.message.split('\n').pop()})`);
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
            await this.network((url, pre) => ({ args: [...pre, 'fetch', '-q', url, `+${BRANCH}:refs/remotes/origin/${BRANCH}`] }), { timeout: 60000 });
        } catch (err) {
            if (/couldn't find remote ref/i.test(err.message)) hasRemote = false;
            else if (err.code === 'NO_GIT' || err.code === 'AUTH') throw err;
            else throw new StoreError('OFFLINE', err.message);
        }
        if (hasRemote) {
            await git(['checkout', '-q', '-f', '-B', BRANCH, `origin/${BRANCH}`], { cwd: this.dir });
            await git(['clean', '-fdq'], { cwd: this.dir });
        } else {
            // Nothing in the cloud yet: drop anything a push that never arrived left behind, so a retry starts from empty
            try { await git(['update-ref', '-d', `refs/heads/${BRANCH}`], { cwd: this.dir }); } catch { /* none */ }
            await git(['read-tree', '--empty'], { cwd: this.dir });
            fs.rmSync(this.p('saves'), { recursive: true, force: true });
        }
        return { hasRemote };
    }

    // ---- layout ----

    slotRel(gameKey, slotId) { return path.join('saves', gameKey.replace(/\//g, '__'), slotId); }

    readMeta(gameKey, slotId) {
        try { return JSON.parse(fs.readFileSync(this.p(this.slotRel(gameKey, slotId), META), 'utf8')); } catch { return null; }
    }

    // Every slot of one game, or of every game when gameKey is omitted
    listSlots(gameKey) {
        const out = [];
        let gameDirs;
        try { gameDirs = gameKey ? [path.dirname(this.slotRel(gameKey, 'x'))] : fs.readdirSync(this.p('saves')).map(n => path.join('saves', n)); } catch { return out; }
        for (const g of gameDirs) {
            let ids = [];
            try { ids = fs.readdirSync(this.p(g)); } catch { continue; }
            for (const id of ids) {
                let meta = null;
                try { meta = JSON.parse(fs.readFileSync(this.p(g, id, META), 'utf8')); } catch { /* not a slot */ }
                if (meta && meta.id === id) out.push(meta);
            }
        }
        return out;
    }

    // Copies the zip of a slot (current version, or an older commit) to destZip
    async readData(gameKey, slotId, destZip, ref) {
        const rel = path.join(this.slotRel(gameKey, slotId), DATA);
        const raw = ref
            ? await git(['show', `${ref}:${rel.split(path.sep).join('/')}`], { cwd: this.dir, buffer: true })
            : fs.readFileSync(this.p(rel));
        fs.mkdirSync(path.dirname(destZip), { recursive: true });
        fs.writeFileSync(destZip, raw);
    }

    // ---- writing ----

    // Runs change() on a freshly refreshed working copy, commits and pushes; redoes it if the push loses a race
    async commitAndPush(message, change) {
        let lastError;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            await this.refresh();
            await change();
            await git(['add', '-A'], { cwd: this.dir });
            const dirty = (await git(['status', '--porcelain'], { cwd: this.dir })).trim();
            if (!dirty) return;
            await git(['commit', '-q', '-m', message], { cwd: this.dir });
            try {
                await this.network((url, pre) => ({ args: [...pre, 'push', '-q', url, `${BRANCH}:${BRANCH}`] }), { timeout: 180000 });
                return;
            } catch (err) {
                lastError = err;
                if (err.code === 'AUTH' || err.code === 'NO_GIT') throw err;
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
            fs.writeFileSync(this.p(rel, DATA), zip);
            fs.writeFileSync(this.p(rel, META), JSON.stringify(meta, null, 2));
        });
    }

    // Changes only a slot's metadata (rename)
    async putMeta({ gameKey, meta }) {
        await this.commitAndPush(`rename ${meta.id.slice(0, 8)}`, () => {
            const rel = this.slotRel(gameKey, meta.id);
            if (!fs.existsSync(this.p(rel))) return;
            fs.writeFileSync(this.p(rel, META), JSON.stringify(meta, null, 2));
        });
    }

    async remove(gameKey, slotId) {
        await this.commitAndPush(`delete ${slotId.slice(0, 8)}`, () => {
            fs.rmSync(this.p(this.slotRel(gameKey, slotId)), { recursive: true, force: true });
        });
    }

    // Older versions of a slot, newest first: [{sha, date, meta}]
    async history(gameKey, slotId, limit = 15) {
        const metaRel = path.join(this.slotRel(gameKey, slotId), META).split(path.sep).join('/');
        let log = '';
        try { log = await git(['log', `-n${limit}`, '--format=%H%x09%cI', '--', metaRel], { cwd: this.dir }); } catch { return []; }
        const out = [];
        for (const line of log.split('\n').filter(Boolean)) {
            const [sha, date] = line.split('\t');
            try {
                const meta = JSON.parse(await git(['show', `${sha}:${metaRel}`], { cwd: this.dir }));
                if (meta) out.push({ sha, date, meta });
            } catch { /* this commit deleted the slot */ }
        }
        return out;
    }
}

module.exports = { Store, StoreError, BRANCH, sshUrlOf, AUTH_FAILURE };
