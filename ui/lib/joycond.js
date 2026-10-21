// joycond (Linux): the counterpart of BetterJoy. The kernel shows each Joy-Con as its own controller; joycond is a small
// service that joins a left and a right Joy-Con into one "Nintendo Switch Combined Joy-Cons" controller (press L and R
// together on the two Joy-Cons) and lets a single one be used sideways (press SL + SR). Every emulator then sees one ordinary
// gamepad, which the menu lists as one controller (see the Joy-Con handling in lib/controllers.js).
//
// It has the same shape as lib/betterjoy.js so the menu can run the same setup screen on both systems:
//   installed  the joycond program is on this computer (installed from the distribution's packages, one password prompt)
//   running    its service is active; "start" turns it on now and at every boot
//   driver     the kernel has the Nintendo driver (hid-nintendo, Linux 5.16 or newer)
const fs = require('fs');
const os = require('os');
const childProcess = require('child_process');

const REPO = 'https://github.com/DanielOgorchock/joycond';
const PROGRAMS = ['/usr/sbin/joycond', '/usr/bin/joycond', '/usr/local/bin/joycond', '/usr/local/sbin/joycond', '/sbin/joycond'];

// How to install the package on each family of distributions (pacman has no official package: it is in the AUR)
function packageCommand(has) {
    if (has('apt-get')) return { name: 'apt', cmd: 'apt-get install -y joycond' };
    if (has('dnf')) return { name: 'dnf', cmd: 'dnf install -y joycond' };
    if (has('zypper')) return { name: 'zypper', cmd: 'zypper --non-interactive install joycond' };
    return null;
}

function kernelAtLeast(release, major, minor) {
    const m = /^(\d+)\.(\d+)/.exec(String(release));
    return !!m && (Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor));
}

function createJoycond({ platform = process.platform === 'win32' ? 'win32' : 'linux', exists = fs.existsSync, execImpl = childProcess.execFile, spawnImpl = childProcess.spawn, release = os.release(), log = () => {} } = {}) {
    const supported = platform === 'linux';
    const has = name => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].some(d => exists(`${d}/${name}`));
    const installed = () => supported && PROGRAMS.some(p => exists(p));
    const driverInstalled = () => supported && kernelAtLeast(release, 5, 16);

    const run = (file, args) => new Promise(resolve => execImpl(file, args, { timeout: 15000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() })));

    async function running() {
        if (!supported || !installed()) return false;
        const r = await run('systemctl', ['is-active', 'joycond']);
        return r.ok && r.out === 'active';
    }

    async function status() {
        return { supported, driver: driverInstalled(), installed: installed(), running: await running() };
    }

    // Runs commands as an administrator through the system's password prompt (pkexec)
    function asAdmin(steps, onLine) {
        return new Promise(resolve => {
            const child = spawnImpl('pkexec', ['sh', '-c', steps.join(' ; ')], { stdio: ['ignore', 'pipe', 'pipe'] });
            const feed = d => String(d).split(/[\r\n]+/).filter(Boolean).forEach(onLine);
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', err => { onLine(err.code === 'ENOENT' ? 'pkexec is not available on this system' : err.message); resolve(127); });
            child.on('close', resolve);
        });
    }

    // There is no driver to install on Linux; the step only checks the kernel
    async function installDriver({ onLine = () => {} } = {}) {
        if (!driverInstalled()) throw new Error(`This system's Linux kernel (${release}) is older than 5.16, so it cannot use Switch controllers. Update the system to a newer kernel.`);
        onLine('The kernel can use Switch controllers');
        return { ok: true, restart: false };
    }

    async function install({ onLine = () => {} } = {}) {
        if (!supported) throw new Error('joycond is only for Linux');
        if (installed()) { onLine('joycond is already installed'); return { ok: true }; }
        const pm = packageCommand(has);
        if (!pm) throw new Error(`This system has no package joycond can be installed from. Build it yourself: ${REPO}`);
        onLine('Asking for permission to install joycond…');
        const code = await asAdmin([pm.cmd], line => { onLine(line); log(`[JOYCON] ${line}`); });
        if (code === 126) throw new Error('The password prompt was cancelled');
        if (code === 127) throw new Error('Could not ask for permission to install. Install the “joycond” package yourself');
        if (!installed()) throw new Error(`Your system's package list does not have joycond. Build it yourself: ${REPO}`);
        onLine('joycond installed');
        return { ok: true };
    }

    // On now and at every boot (the service belongs to the system, so this needs permission once)
    async function start({ onLine = () => {} } = {}) {
        if (!supported) throw new Error('joycond is only for Linux');
        if (!installed()) throw new Error('joycond is not installed yet');
        if (await running()) return { started: false };
        const code = await asAdmin(['systemctl enable --now joycond'], onLine);
        if (code === 126) throw new Error('The password prompt was cancelled');
        if (!await running()) throw new Error('joycond could not be started. Run “systemctl status joycond” to see why');
        return { started: true };
    }

    async function stop({ onLine = () => {} } = {}) {
        if (!supported || !installed()) return;
        await asAdmin(['systemctl disable --now joycond'], onLine);
    }

    // Removing a system package is left to the person; the menu only switches the service off
    async function uninstall() { await stop(); }

    return { status, installDriver, install, start, stop, uninstall, running, driverInstalled, installed, supported, name: 'joycond' };
}

module.exports = { createJoycond, packageCommand, kernelAtLeast, REPO };
