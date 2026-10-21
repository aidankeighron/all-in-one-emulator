const test = require('node:test');
const assert = require('node:assert');
const build = require('../scripts/build');
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
