const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const build = require('../scripts/build');
const buildInfo = require('../scripts/build-info');
const pkg = require('../package.json');

test('npm run build makes an installer and a portable exe on Windows, an AppImage on Linux', () => {
    assert.deepStrictEqual(build.plan([], 'win32').args, ['--win', 'nsis', 'portable']);
    assert.deepStrictEqual(build.plan([], 'linux').args, ['--linux', 'AppImage']);
    assert.deepStrictEqual(build.plan(['win'], 'linux').args, ['--win', 'nsis', 'portable'], 'a system can be named');
    assert.deepStrictEqual(build.plan(['win', '--dir'], 'win32').args, ['--win', 'nsis', 'portable', '--dir'], 'other words go to electron-builder');
    assert.throws(() => build.plan([], 'darwin'), /no build for darwin/);
    assert.match(build.hint('win').join('\n'), /Pin to taskbar/);
});

test('the build is set up for a pinnable Windows install', () => {
    assert.strictEqual(pkg.scripts.build, 'node scripts/build.js');
    assert.deepStrictEqual(pkg.build.win.target, ['nsis', 'portable']);
    assert.strictEqual(pkg.build.nsis.createStartMenuShortcut, true);
    assert.notStrictEqual(pkg.build.nsis.artifactName, pkg.build.portable.artifactName, 'the two files are named differently');
    assert.ok(pkg.build.files.includes('electron/**') && pkg.build.files.includes('ui/**'));
    const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron/main.js'), 'utf8');
    assert.ok(main.includes(`setAppUserModelId('${pkg.build.appId}')`), 'the taskbar id is the installer’s app id');
});

test('build-info generates version, monotonic build number, and build date during builds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildinfo-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test', version: '2.3.4' }));

    const devFallback = buildInfo.readBuildInfo({ root });
    assert.strictEqual(devFallback.version, '2.3.4');
    assert.strictEqual(devFallback.source, 'dev');
    assert.strictEqual(devFallback.buildDate, null);

    const first = buildInfo.generateBuildInfo({ root, gitCount: 40, commit: 'abc1234', now: new Date('2026-11-27T12:00:00.000Z') });
    assert.strictEqual(first.version, '2.3.4');
    assert.strictEqual(first.buildNumber, 40);
    assert.strictEqual(first.buildDate, '2026-11-27T12:00:00.000Z');
    assert.strictEqual(first.commit, 'abc1234');
    assert.strictEqual(first.source, 'build');

    const second = buildInfo.generateBuildInfo({ root, gitCount: 40, commit: 'abc1234', now: new Date('2026-11-27T13:00:00.000Z') });
    assert.strictEqual(second.buildNumber, 41, 'consecutive builds increment buildNumber even on the same commit');
    assert.strictEqual(second.buildDate, '2026-11-27T13:00:00.000Z');

    const loaded = buildInfo.readBuildInfo({ root });
    assert.deepStrictEqual(loaded, second);
    assert.ok(pkg.scripts.dist.includes('build-info.js'));
    assert.ok(pkg.scripts['dist:win'].includes('build-info.js'));
});

test('packaged app files never contain unguarded requires outside bundled directories', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const serverSrc = fs.readFileSync(path.join(repoRoot, 'ui', 'server.js'), 'utf8');
    assert.ok(!serverSrc.includes('../scripts/'), 'ui/server.js must not require unpackaged scripts/');
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'electron', 'main.js'), 'utf8');
    assert.ok(!mainSrc.includes('../scripts/'), 'electron/main.js must not require unpackaged scripts/');
});
