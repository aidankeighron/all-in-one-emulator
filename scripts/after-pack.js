// electron-builder hook: Ubuntu 24.04 blocks Chromium's sandbox for apps like this, and Electron
// checks that before any JS runs, so it can't be disabled from main.js. Replace the real binary with
// a tiny launcher that passes --no-sandbox. (The window only ever loads our own 127.0.0.1 server.)
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'linux') return;

    const name = context.packager.executableName;
    const real = path.join(context.appOutDir, name);
    const renamed = `${real}.bin`;

    fs.renameSync(real, renamed);
    fs.writeFileSync(real, `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/${name}.bin" --no-sandbox "$@"
`);
    fs.chmodSync(real, 0o755);
};
