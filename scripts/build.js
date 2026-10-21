// npm run build: builds the app for this computer into dist/.
//   Windows  an installer (Emulator-Menu-Setup-<version>.exe: installs for the current user, adds Start menu and desktop
//            shortcuts, and starts it) and a portable program (Emulator-Menu-Portable-<version>.exe, no install)
//   Linux    an AppImage
// `npm run build:win` and `npm run build:linux` name the system; extra words are passed on to electron-builder
// (for example --dir to only unpack the app without making the installer). Building for Windows needs a Windows computer
// (or Wine); the program has to be built on the system it is for.
const path = require('path');
const { spawnSync } = require('child_process');

const BUILDS = {
    win: { flag: '--win', targets: ['nsis', 'portable'], label: 'Windows' },
    linux: { flag: '--linux', targets: ['AppImage'], label: 'Linux' }
};

function plan(argv = process.argv.slice(2), platform = process.platform) {
    const named = argv.find(a => BUILDS[a]);
    const key = named || (platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : null);
    if (!key) throw new Error(`There is no build for ${platform}. Use npm run build:win or npm run build:linux`);
    const build = BUILDS[key];
    const rest = argv.filter(a => !BUILDS[a]);
    return { key, label: build.label, args: [build.flag, ...build.targets, ...rest] };
}

function hint(key) {
    return key === 'win'
        ? ['Done. In dist/:',
           '  Emulator-Menu-Setup-<version>.exe   run it once: it installs the menu, adds a Start menu entry and starts it',
           '  Emulator-Menu-Portable-<version>.exe  runs without installing',
           'To pin it: start the menu (from the Start menu), right-click its icon on the taskbar and choose "Pin to taskbar".']
        : ['Done. The AppImage is in dist/. Run it with --fullscreen for full screen.'];
}

if (require.main === module) {
    let p;
    try { p = plan(); } catch (err) { console.error(err.message); process.exit(1); }
    console.log(`Building the ${p.label} app: electron-builder ${p.args.join(' ')}`);
    const cli = require.resolve('electron-builder/cli.js');
    const res = spawnSync(process.execPath, [cli, ...p.args], { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
    if (res.status === 0 && !p.args.includes('--dir')) hint(p.key).forEach(l => console.log(l));
    process.exit(res.status === null ? 1 : res.status);
}

module.exports = { plan, hint, BUILDS };
