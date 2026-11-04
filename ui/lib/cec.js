// The TV's own volume, over HDMI-CEC (the link over the HDMI cable that lets one remote work everything).
//
// Most PC graphics cards cannot send CEC; some can (certain laptops and mini PCs, and USB-C/DisplayPort to HDMI adapters
// with CEC, which Linux shows as /dev/cec*), and a USB-CEC adapter (Pulse-Eight) adds it to any computer. Two ways in:
//   cec-ctl     (v4l-utils) for the kernel's CEC devices, /dev/cec0 ...
//   cec-client  (cec-utils, libcec) for the USB adapter
// The keys go to the TV (logical address 0), which passes them on to a sound bar on HDMI ARC.
const fs = require('fs');
const childProcess = require('child_process');
const admin = require('./admin');

const KEYS = { up: { ctl: 'volume-up', client: 'volup' }, down: { ctl: 'volume-down', client: 'voldown' }, mute: { ctl: 'mute', client: 'mute' } };
const has = (exists, name) => ['/usr/bin', '/bin', '/usr/local/bin'].some(d => exists(`${d}/${name}`));

function createCec({ platform = process.platform, exists = fs.existsSync, list = () => fs.readdirSync('/dev'), execImpl = childProcess.execFile, spawnImpl = childProcess.spawn } = {}) {
    const run = (cmd, args, input) => new Promise(resolve => {
        const child = execImpl(cmd, args, { timeout: 12000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || ''), missing: !!err && err.code === 'ENOENT' }));
        if (input !== undefined && child && child.stdin) { child.stdin.write(input); child.stdin.end(); }
    });
    let claimed = null;     // the /dev/cec device the menu has set up as a player (needed once before it can send keys)
    let adapter = null;     // cec-client: whether a USB adapter answered (asked once)

    async function status() {
        if (platform !== 'linux') return { supported: false, reason: 'TV volume over HDMI-CEC is for Linux.' };
        let devices = [];
        try { devices = list().filter(n => /^cec\d+$/.test(n)).map(n => `/dev/${n}`); } catch { /* none */ }
        if (devices.length && has(exists, 'cec-ctl')) return { supported: true, via: 'cec-ctl', device: devices[0] };
        if (has(exists, 'cec-client')) {
            if (adapter === null) adapter = /Found devices:\s*[1-9]/i.test((await run('cec-client', ['-l'])).out);
            if (adapter) return { supported: true, via: 'cec-client' };
        }
        if (devices.length) return { supported: false, install: 'v4l-utils', reason: 'This computer can talk to the TV over HDMI-CEC; it needs the v4l-utils package for that.' };
        return { supported: false, reason: 'This computer has no HDMI-CEC link to the TV (most PC graphics cards do not; a USB-CEC adapter adds it). Use the TV remote, or the computer volume above.' };
    }

    // One key to the TV: 'up', 'down' or 'mute'
    async function press(key) {
        const k = KEYS[key];
        if (!k) throw new Error('Unknown key');
        const st = await status();
        if (!st.supported) throw new Error(st.reason);
        if (st.via === 'cec-ctl') {
            if (claimed !== st.device) {
                const r = await run('cec-ctl', ['-d', st.device, '--playback', '--osd-name', 'Emulator Menu']);
                if (!r.ok) throw new Error('The TV link could not be set up (is another program using it?)');
                claimed = st.device;
            }
            const down = await run('cec-ctl', ['-d', st.device, '--to', '0', '--user-control-pressed', `ui-cmd=${k.ctl}`]);
            await run('cec-ctl', ['-d', st.device, '--to', '0', '--user-control-released']);
            if (!down.ok) throw new Error('The TV did not take it');
            return true;
        }
        // cec-client opens the adapter, sends the key and exits (takes a second or two)
        const r = await run('cec-client', ['-s', '-d', '1'], `${k.client}\n`);
        if (!r.ok) throw new Error('The TV did not take it');
        return true;
    }

    // Installs v4l-utils (cec-ctl) for a computer that has the CEC link but not the program. One password prompt.
    function install({ onLine = () => {} } = {}) {
        return new Promise((resolve, reject) => {
            const child = admin.spawn(spawnImpl, 'apt-get install -y v4l-utils || dnf install -y v4l-utils || pacman -S --noconfirm v4l-utils');
            const feed = d => String(d).split(/[\r\n]+/).filter(Boolean).forEach(onLine);
            if (child.stdout) child.stdout.on('data', feed);
            if (child.stderr) child.stderr.on('data', feed);
            child.on('error', err => reject(err));
            child.on('close', code => (code === 0 ? resolve(true) : reject(new Error(code === 126 ? 'The password was not accepted' : 'v4l-utils could not be installed'))));
        });
    }

    return { status, press, install };
}

module.exports = { createCec };
