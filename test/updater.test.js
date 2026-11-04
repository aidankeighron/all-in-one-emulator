// Updating from GitHub: a real git "GitHub" (a bare repository), the menu's copy cloned from it, and new commits pushed there
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { createUpdater } = require('../ui/lib/updater');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();

function setup() {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
    const origin = path.join(top, 'origin.git'), dev = path.join(top, 'dev'), menu = path.join(top, 'menu');
    sh(top, 'init', '--bare', '-b', 'master', origin);
    sh(top, 'clone', origin, dev);
    fs.writeFileSync(path.join(dev, 'package.json'), '{"name":"x"}\n');
    fs.writeFileSync(path.join(dev, 'app.js'), 'v1\n');
    sh(dev, 'add', '.'); sh(dev, 'commit', '-m', 'first'); sh(dev, 'push', '-q', 'origin', 'HEAD:master');
    sh(top, 'clone', '-q', origin, menu);
    const push = (file, text, msg) => { fs.writeFileSync(path.join(dev, file), text); sh(dev, 'commit', '-qam', msg); sh(dev, 'push', '-q', 'origin', 'HEAD:master'); };
    return { menu, push };
}

// git for real; npm is a stand-in that only says it ran
function updaterFor(root, npmRuns) {
    const execImpl = (cmd, args, opts, cb) => {
        if (/npm$/.test(cmd)) { npmRuns.push(args); return cb(null, 'added 1 package', ''); }
        return execFile(cmd, args, opts, cb);
    };
    return createUpdater({ root, execImpl, env: { ...process.env, APPIMAGE: '' } });
}

test('check says what is new on GitHub, and update pulls it (npm install only when the dependencies changed)', async () => {
    const { menu, push } = setup();
    const npmRuns = [];
    const u = updaterFor(menu, npmRuns);
    let st = await u.check();
    assert.strictEqual(st.supported, true);
    assert.strictEqual(st.behind, 0);

    push('app.js', 'v2\n', 'Second version');
    st = await u.check();
    assert.strictEqual(st.behind, 1);
    assert.match(st.changes[0], /Second version/);
    let r = await u.update();
    assert.strictEqual(r.updated, true);
    assert.strictEqual(fs.readFileSync(path.join(menu, 'app.js'), 'utf8'), 'v2\n');
    assert.strictEqual(npmRuns.length, 0, 'no npm install without dependency changes');

    push('package.json', '{"name":"x","dependencies":{}}\n', 'New dependency');
    r = await u.update();
    assert.strictEqual(r.installed, true);
    assert.deepStrictEqual(npmRuns[0], ['install', '--no-audit', '--no-fund']);
    assert.strictEqual((await u.update()).updated, false, 'already up to date');
});

test('a copy with its own changes is left alone, and the AppImage is not updated this way', async () => {
    const { menu, push } = setup();
    push('app.js', 'v2\n', 'Second version');
    fs.writeFileSync(path.join(menu, 'app.js'), 'my own edit\n');
    fs.writeFileSync(path.join(menu, 'notes.txt'), 'untracked files do not count\n');
    const u = updaterFor(menu, []);
    const st = await u.check();
    assert.deepStrictEqual(st.dirty, ['app.js']);
    await assert.rejects(u.update(), /changes of its own/);
    assert.strictEqual(fs.readFileSync(path.join(menu, 'app.js'), 'utf8'), 'my own edit\n', 'nothing was touched');
    const image = createUpdater({ root: menu, env: { ...process.env, APPIMAGE: '/x/menu.AppImage' } });
    assert.strictEqual((await image.status()).supported, false);
});
