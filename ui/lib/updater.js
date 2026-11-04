// Updating the menu from GitHub, for a copy run from a git checkout (npm start, and kiosk mode, which starts that same
// checkout with Electron). check() fetches and says what is new; update() pulls it (fast-forward only), runs npm install when
// the dependencies changed, and the app then restarts itself on the new code. The AppImage is updated by downloading a new one.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const DEPENDENCY_FILES = ['package.json', 'package-lock.json'];

function createUpdater({ root = path.resolve(__dirname, '..', '..'), env = process.env, execImpl = childProcess.execFile, exists = fs.existsSync, platform = process.platform } = {}) {
    const run = (cmd, args, { timeout = 120000, extraPath = null } = {}) => new Promise(resolve => {
        const PATH = extraPath ? [extraPath, env.PATH].filter(Boolean).join(path.delimiter) : env.PATH;
        execImpl(cmd, args, { cwd: root, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...env, PATH, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => resolve({
            ok: !err, out: String(stdout || '').trim(), raw: String(stdout || ''), err: String(stderr || '').trim(), missing: !!err && err.code === 'ENOENT'
        }));
    });
    const git = (...args) => run('git', args);

    // Why this copy cannot update itself, or null
    function blocked() {
        if (env.APPIMAGE) return 'This is the AppImage: download the new AppImage to update it.';
        if (!exists(path.join(root, '.git'))) return 'This copy of the menu is not a git checkout, so it cannot pull updates.';
        return null;
    }

    async function status() {
        const reason = blocked();
        if (reason) return { supported: false, reason };
        const head = await git('log', '-1', '--format=%h%x09%cs%x09%s');
        if (head.missing) return { supported: false, reason: 'git is not installed on this computer.' };
        if (!head.ok) return { supported: false, reason: `git could not read this copy: ${head.err || head.out}` };
        const [sha, date, subject] = head.out.split('\t');
        const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out;
        const up = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
        // only changes to files git tracks count: an untracked file (a ROM folder, say) is left alone by a pull
        // (each line is two status letters, a space and the path: read untrimmed, a leading space is one of the letters)
        const dirty = (await git('status', '--porcelain', '--untracked-files=no')).raw.split('\n').filter(Boolean).map(l => l.slice(3));
        return { supported: true, version: { sha, date, subject }, branch, upstream: up.ok ? up.out : null, dirty };
    }

    // Fetches, then says how many changes are new on GitHub and what they are
    async function check() {
        const st = await status();
        if (!st.supported) return st;
        if (!st.upstream) return { ...st, error: `The branch "${st.branch}" does not follow a branch on GitHub, so there is nothing to pull.` };
        const fetched = await git('fetch', '--quiet');
        if (!fetched.ok) return { ...st, error: `Could not reach GitHub: ${fetched.err || fetched.out || 'no answer'}` };
        const behind = Number((await git('rev-list', '--count', 'HEAD..@{u}')).out) || 0;
        const ahead = Number((await git('rev-list', '--count', '@{u}..HEAD')).out) || 0;
        const changes = behind ? (await git('log', '--format=%cs  %s', '-n', '8', 'HEAD..@{u}')).out.split('\n').filter(Boolean) : [];
        return { ...st, checked: true, behind, ahead, changes };
    }

    // npm, which a desktop session may not have on its PATH (node installed with nvm, say): try the PATH, then next to the
    // node the menu runs on, then the usual places
    function npmCommand() {
        const candidates = ['npm', path.join(path.dirname(process.execPath), platform === 'win32' ? 'npm.cmd' : 'npm'), '/usr/bin/npm', '/usr/local/bin/npm'];
        const nvm = path.join(env.HOME || '', '.nvm', 'versions', 'node');
        try { for (const v of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, v, 'bin', 'npm')); } catch { /* no nvm */ }
        return candidates;
    }

    async function update({ onLine = () => {} } = {}) {
        const st = await check();
        if (!st.supported) throw new Error(st.reason);
        if (st.error) throw new Error(st.error);
        if (st.dirty.length) throw new Error(`This copy has changes of its own (${st.dirty.slice(0, 3).join(', ')}${st.dirty.length > 3 ? ', …' : ''}), so the menu leaves updating to you: run git pull in ${root}.`);
        if (st.ahead) throw new Error(`This copy has ${st.ahead} change${st.ahead === 1 ? '' : 's'} that are not on GitHub, so it cannot simply take GitHub's. Run git pull in ${root}.`);
        if (!st.behind) return { updated: false, message: 'Already up to date' };
        const from = (await git('rev-parse', 'HEAD')).out;
        onLine(`Downloading ${st.behind} change${st.behind === 1 ? '' : 's'}…`);
        const pulled = await git('pull', '--ff-only', '--quiet');
        if (!pulled.ok) throw new Error(`git pull did not work: ${pulled.err || pulled.out}`);
        const to = (await git('rev-parse', 'HEAD')).out;
        const changed = (await git('diff', '--name-only', from, to, '--', ...DEPENDENCY_FILES)).out.split('\n').filter(Boolean);
        let installed = false;
        if (changed.length) {
            onLine('The dependencies changed: running npm install (this can take a few minutes)…');
            let done = null;
            for (const npm of npmCommand()) {
                // npm is a node script: its own folder goes first on the PATH so the node next to it runs it
                const r = await run(npm, ['install', '--no-audit', '--no-fund'], { timeout: 15 * 60 * 1000, extraPath: path.isAbsolute(npm) ? path.dirname(npm) : null });
                if (r.missing) continue;
                done = r;
                break;
            }
            if (!done) throw new Error(`Updated, but npm was not found to install the new dependencies. Run npm install in ${root}, then restart the menu.`);
            if (!done.ok) throw new Error(`Updated, but npm install failed: ${(done.err || done.out).split('\n').slice(-3).join(' ')}. Run npm install in ${root}, then restart the menu.`);
            installed = true;
        }
        const now = await status();
        return { updated: true, installed, from: from.slice(0, 7), to: to.slice(0, 7), version: now.version };
    }

    return { status, check, update, root };
}

module.exports = { createUpdater };
