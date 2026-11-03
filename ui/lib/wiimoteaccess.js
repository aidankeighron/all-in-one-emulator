// Lets Dolphin use a Wii Remote that is connected to the computer (Linux).
//
// The menu connects a Wii Remote to the computer so it can drive the menu. Dolphin then reaches that remote through its raw
// device (/dev/hidraw*), which only the administrator may open out of the box, so in a game the remote does nothing until it
// is connected again. One small udev rule fixes that for good: it gives the person signed in at the computer (and so Dolphin)
// access to the raw device of a Wii Remote, the same way the system already gives them their gamepads. Installing it asks for
// the administrator password once (pkexec).
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const RULE_FILE = '/etc/udev/rules.d/72-emulator-menu-wiimote.rules';
// Wii Remote (RVL-CNT-01, 057e:0306) and Wii Remote Plus (RVL-CNT-01-TR, 057e:0330) over Bluetooth. The number is below 73 so
// that systemd's seat rules see the "uaccess" tag.
const RULES = [
    '# Written by the emulator menu: lets the person at the computer (and Dolphin) use a Wii Remote connected over Bluetooth.',
    '# Delete this file to undo it.',
    'KERNEL=="hidraw*", KERNELS=="*057E:0306*", MODE="0660", TAG+="uaccess"',
    'KERNEL=="hidraw*", KERNELS=="*057E:0330*", MODE="0660", TAG+="uaccess"'
];
const WIIMOTE_HID = /^HID_ID=0005:0000057E:0000(0306|0330)$/im;

function createWiimoteAccess({ platform = process.platform, sysRoot = '/sys/class/hidraw', devRoot = '/dev', ruleFile = RULE_FILE, exists = fs.existsSync, canOpen, spawnImpl = childProcess.spawn } = {}) {
    const supported = platform === 'linux';
    const openable = canOpen || (file => { try { fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; } });

    // The raw devices of the Wii Remotes connected now, and whether this user may open each
    function remotes() {
        if (!supported) return [];
        let names = [];
        try { names = fs.readdirSync(sysRoot); } catch { return []; }
        const out = [];
        for (const name of names) {
            let uevent = '';
            try { uevent = fs.readFileSync(path.join(sysRoot, name, 'device', 'uevent'), 'utf8'); } catch { continue; }
            if (!WIIMOTE_HID.test(uevent)) continue;
            const node = path.join(devRoot, name);
            out.push({ node, usable: openable(node) });
        }
        return out;
    }

    function status() {
        const list = remotes();
        const installed = supported && exists(ruleFile);
        // Needed when a connected remote cannot be opened (or none is connected and the rule is not there yet)
        return { supported, installed, remotes: list.length, blocked: list.filter(r => !r.usable).length, needed: supported && (list.some(r => !r.usable) || (!installed && !list.length)) };
    }

    // Writes the rule and applies it to the remotes connected now. One password prompt.
    function install({ onLine = () => {} } = {}) {
        if (!supported) return Promise.reject(new Error('This is for Linux'));
        const quoted = RULES.map(l => `'${l}'`).join(' ');
        const steps = [`printf '%s\\n' ${quoted} > ${ruleFile}`, 'udevadm control --reload-rules', 'udevadm trigger --subsystem-match=hidraw --action=change'];
        return new Promise((resolve, reject) => {
            const child = spawnImpl('pkexec', ['sh', '-c', steps.join(' && ')], { stdio: ['ignore', 'pipe', 'pipe'] });
            const feed = d => String(d).split(/[\r\n]+/).filter(Boolean).forEach(onLine);
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', err => reject(new Error(err.code === 'ENOENT' ? 'pkexec is not available on this system' : err.message)));
            child.on('close', code => {
                if (code === 126) return reject(new Error('The password prompt was cancelled'));
                if (code !== 0) return reject(new Error('The permission could not be added'));
                resolve(status());
            });
        });
    }

    return { supported, status, remotes, install };
}

module.exports = { createWiimoteAccess, RULE_FILE, RULES };
