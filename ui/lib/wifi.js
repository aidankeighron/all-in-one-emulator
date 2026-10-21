// Wi-Fi that dies when the computer sleeps (Linux). Three things:
//   diagnose()  what the system can see: the Wi-Fi card, its driver, rfkill, NetworkManager, and the kernel's recent complaints,
//               boiled down to one plain sentence
//   repair      one administrator prompt, then a ladder that stops at the first step that brings Wi-Fi back:
//                 1 unblock + radio on, 2 restart NetworkManager, 3 reload the driver, 4 reset the card on its bus
//               (step 4 is what works when unloading and reloading the driver does not: a card that went to sleep badly is
//                taken off the PCI bus and found again, which powers it back up)
//   sleep fix   a small systemd hook: the driver is unloaded before sleep and the ladder runs after waking, plus Wi-Fi power
//               saving switched off, which is the usual cause. It writes what it did to the system journal (tag emulator-menu-wifi).
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const HOOK_FILE = '/usr/lib/systemd/system-sleep/emulator-menu-wifi';
const REPAIR_FILE = '/usr/local/lib/emulator-menu/wifi-repair.sh';
const NM_CONF = '/etc/NetworkManager/conf.d/99-emulator-menu-wifi.conf';
const TAG = 'emulator-menu-wifi';
const COMPLAINTS = /iwlwifi|ath\d|ath1|rtw\d|rtl8|mt79|mt76|brcm|cfg80211|wlan|wifi|firmware|microcode|pcie.*(error|aer)|aer:|timed out|d3cold/i;

const shq = s => `'${String(s).replace(/'/g, "'\\''")}'`;
const safe = s => /^[A-Za-z0-9_.:\-]+$/.test(String(s || '')) ? String(s) : '';

// ---------- the repair ladder (a shell script; sys is /sys, a folder of stand-ins in the tests) ----------

function repairScript({ sys = '/sys', module = '', address = '', bus = 'pci' } = {}) {
    const mod = safe(module), addr = safe(address);
    const usbDev = addr.split(':')[0];
    return `#!/bin/sh
# Brings Wi-Fi back, trying the gentlest thing first. Made by Emulator Menu.
SYS=${shq(sys)}
MOD=${shq(mod)}
ADDR=${shq(addr)}
say() { echo "$*"; logger -t ${TAG} "$*" 2>/dev/null; }
wifi_ok() { nmcli -t -f TYPE,STATE device 2>/dev/null | grep -Eq '^wifi:(connected|disconnected|connecting)'; }
wait_ok() { i=0; while [ "$i" -lt "$1" ]; do wifi_ok && return 0; sleep 1; i=$((i+1)); done; return 1; }
done_ok() { say "Wi-Fi is back ($1)"; exit 0; }

say "Step 1: unblock Wi-Fi and switch its radio on"
rfkill unblock wifi 2>/dev/null
nmcli radio wifi on 2>/dev/null
wait_ok 4 && done_ok "the radio was off"

say "Step 2: restart NetworkManager"
systemctl restart NetworkManager 2>/dev/null
wait_ok 10 && done_ok "NetworkManager had lost it"

if [ -n "$MOD" ]; then
    say "Step 3: reload the driver ($MOD)"
    for h in "$SYS"/module/"$MOD"/holders/*; do [ -e "$h" ] && modprobe -r "$(basename "$h")" 2>/dev/null; done
    modprobe -r "$MOD" 2>/dev/null
    case "$MOD" in ath10k_pci) modprobe -r ath10k_core 2>/dev/null ;; esac     # ath10k: its core module is unloaded too, so the next load starts clean
    sleep 2
    modprobe "$MOD" 2>/dev/null
    systemctl restart NetworkManager 2>/dev/null
    wait_ok 12 && done_ok "the driver was reloaded"
fi

if [ -n "$ADDR" ]; then
${bus === 'usb' ? `    say "Step 4: reset the USB adapter ($ADDR)"
    echo ${shq(usbDev)} > "$SYS"/bus/usb/drivers/usb/unbind 2>/dev/null
    sleep 2
    echo ${shq(usbDev)} > "$SYS"/bus/usb/drivers/usb/bind 2>/dev/null` : `    say "Step 4: reset the card on the PCI bus ($ADDR)"
    [ -w "$SYS/bus/pci/devices/$ADDR/reset" ] && echo 1 > "$SYS/bus/pci/devices/$ADDR/reset" 2>/dev/null
    sleep 1
    echo 1 > "$SYS/bus/pci/devices/$ADDR/remove" 2>/dev/null
    sleep 2
    echo 1 > "$SYS/bus/pci/rescan" 2>/dev/null`}
    sleep 3
    [ -n "$MOD" ] && modprobe "$MOD" 2>/dev/null
    systemctl restart NetworkManager 2>/dev/null
    wait_ok 15 && done_ok "the card was reset"
fi

say "Wi-Fi did not come back. The card is stuck in a state only cutting its power fixes: shut the computer down (not restart), unplug it from the wall for 30 seconds, and start it again."
exit 1
`;
}

// The hook systemd runs around sleep: unload before, run the ladder after (in the background, so waking is not held up)
function hookScript({ sys = '/sys', module = '', repairFile = REPAIR_FILE } = {}) {
    const mod = safe(module);
    return `#!/bin/sh
# Keeps Wi-Fi alive across sleep. Made by Emulator Menu; remove it from the menu (Settings -> System).
MOD=${shq(mod)}
case "$1" in
    pre)
        logger -t ${TAG} "going to sleep: unloading $MOD"
        for h in ${shq(sys)}/module/"$MOD"/holders/*; do [ -e "$h" ] && modprobe -r "$(basename "$h")" 2>/dev/null; done
        [ -n "$MOD" ] && modprobe -r "$MOD" 2>/dev/null
        case "$MOD" in ath10k_pci) modprobe -r ath10k_core 2>/dev/null ;; esac
        ;;
    post)
        logger -t ${TAG} "woke up: bringing Wi-Fi back"
        ( sleep 2; ${shq(repairFile)} ) >/dev/null 2>&1 &
        ;;
esac
exit 0
`;
}

const nmConf = () => '[connection]\n# Written by Emulator Menu: Wi-Fi power saving is the usual reason Wi-Fi does not wake up\nwifi.powersave = 2\n';

// ---------- what the system can see ----------

function parseRfkill(text) {
    const soft = /Soft blocked:\s*yes/i.test(text), hard = /Hard blocked:\s*yes/i.test(text);
    return { soft, hard, known: /Soft blocked/i.test(text) };
}

function verdict(d) {
    if (d.rfkill.hard) return { level: 'bad', text: 'Wi-Fi is switched off by a hardware switch or key (a Wi-Fi / airplane key on the keyboard). Press it.' };
    if (d.rfkill.soft) return { level: 'bad', text: 'Wi-Fi is blocked by software. Repair unblocks it.' };
    if (!d.adapters.length && !d.cards.length) return { level: 'bad', text: 'The system cannot see a Wi-Fi card at all: it has dropped off the bus. Repair tries to bring it back; if that fails the card needs its power cut (shut down and unplug for 30 seconds).' };
    if (!d.adapters.length) {
        const c = d.cards[0];
        return { level: 'bad', text: c.driver ? `The card is there but the driver (${c.driver}) has no Wi-Fi interface: the driver lost it. Repair reloads the driver, then resets the card.` : 'The card is there but no driver is loaded for it. Repair loads the driver and resets the card if needed.' };
    }
    if (d.networkManager !== 'active') return { level: 'bad', text: 'NetworkManager is not running. Repair restarts it.' };
    const a = d.adapters[0];
    if (a.state === 'unavailable' || a.state === 'unmanaged') return { level: 'bad', text: `Wi-Fi (${a.name}) is ${a.state}. Repair resets it.` };
    return a.state === 'connected' ? { level: 'ok', text: `Wi-Fi works (${a.name}, ${a.driver || 'driver unknown'}).` } : { level: 'warn', text: `Wi-Fi (${a.name}) is there but not connected (${a.state || 'unknown'}).` };
}

function createWifi({ platform = process.platform === 'win32' ? 'win32' : 'linux', sys = '/sys', exists = fs.existsSync, readdir = d => fs.readdirSync(d), read = f => fs.readFileSync(f, 'utf8'), readlink = f => fs.readlinkSync(f), execImpl = childProcess.execFile, spawnImpl = childProcess.spawn, tmpdir = os.tmpdir(), release = os.release() } = {}) {
    const supported = platform === 'linux';
    const run = (file, args) => new Promise(resolve => execImpl(file, args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') })));
    const tryRead = f => { try { return read(f).trim(); } catch { return ''; } };
    const link = f => { try { return path.basename(readlink(f)); } catch { return ''; } };
    const list = d => { try { return readdir(d); } catch { return []; } };

    // Wi-Fi interfaces the kernel has
    function adapters() {
        return list(path.join(sys, 'class/net')).filter(n => exists(path.join(sys, 'class/net', n, 'wireless')) || exists(path.join(sys, 'class/net', n, 'phy80211'))).map(name => {
            const dev = path.join(sys, 'class/net', name, 'device');
            return { name, driver: link(path.join(dev, 'driver')), bus: link(path.join(dev, 'subsystem')) || 'pci', address: link(dev), module: link(path.join(dev, 'driver/module')) || link(path.join(dev, 'driver')), state: tryRead(path.join(sys, 'class/net', name, 'operstate')) };
        });
    }

    // PCI cards that look like Wi-Fi (class 0x0280xx: "other network controller"), even when no interface exists any more
    function cards() {
        return list(path.join(sys, 'bus/pci/devices')).filter(a => tryRead(path.join(sys, 'bus/pci/devices', a, 'class')).startsWith('0x0280')).map(address => {
            const dir = path.join(sys, 'bus/pci/devices', address);
            return { address, vendor: tryRead(path.join(dir, 'vendor')), device: tryRead(path.join(dir, 'device')), driver: link(path.join(dir, 'driver')), module: link(path.join(dir, 'driver/module')) || link(path.join(dir, 'driver')) };
        });
    }

    async function diagnose() {
        if (!supported) return { supported: false, reason: 'This is for Linux. On Windows, use Settings -> Network & internet -> Wi-Fi, or Device Manager.' };
        const a = adapters(), c = cards();
        const rf = await run('rfkill', ['list', 'wifi']);
        const nm = await run('systemctl', ['is-active', 'NetworkManager']);
        const dev = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device']);
        for (const ad of a) {
            const row = dev.out.split('\n').map(l => l.split(':')).find(x => x[0] === ad.name);
            if (row && row[2]) ad.state = row[2];
        }
        const kernel = await run('journalctl', ['-k', '-b', '--no-pager', '-o', 'short', '-n', '800']);
        const mine = await run('journalctl', ['-t', TAG, '-b', '--no-pager', '-o', 'short', '-n', '12']);
        const d = {
            supported: true, kernelRelease: release, adapters: a, cards: c, rfkill: parseRfkill(rf.out),
            networkManager: nm.out.trim() || 'not running',
            kernel: kernel.out.split('\n').filter(l => COMPLAINTS.test(l)).slice(-12),
            history: mine.out.split('\n').filter(l => l && !l.startsWith('--')).slice(-8),
            sleepFix: exists(HOOK_FILE)
        };
        d.verdict = verdict(d);
        return d;
    }

    // The card to fix: the working interface, else a Wi-Fi card on the PCI bus
    function target() {
        const a = adapters()[0];
        if (a) return { module: a.module, address: a.address, bus: a.bus === 'usb' ? 'usb' : 'pci' };
        const c = cards()[0];
        if (c) return { module: c.module, address: c.address, bus: 'pci' };
        return null;
    }

    function asAdmin(script, onLine) {
        return new Promise(resolve => {
            const child = spawnImpl('pkexec', ['sh', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
            const feed = d => String(d).split(/[\r\n]+/).filter(Boolean).forEach(onLine);
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', err => { onLine(err.code === 'ENOENT' ? 'pkexec is not available on this system' : err.message); resolve(127); });
            child.on('close', resolve);
        });
    }

    async function repair({ onLine = () => {} } = {}) {
        if (!supported) throw new Error('This is for Linux');
        const t = target() || {};
        const file = path.join(fs.mkdtempSync(path.join(tmpdir, 'wifi-')), 'repair.sh');
        fs.writeFileSync(file, repairScript({ sys, ...t }), { mode: 0o755 });
        onLine('Asking for permission to repair Wi-Fi…');
        const code = await asAdmin(`sh ${shq(file)}`, onLine);
        if (code === 126) throw new Error('The password prompt was cancelled');
        if (code === 127) throw new Error('Could not ask for permission (pkexec is missing)');
        if (code !== 0) throw new Error('Wi-Fi did not come back. Shut the computer down (not restart), unplug it for 30 seconds, then start it again');
        return { ok: true };
    }

    // The fix for Wi-Fi that dies in sleep: the hook, the repair script it runs, and Wi-Fi power saving off
    async function setSleepFix(on, { onLine = () => {} } = {}) {
        if (!supported) throw new Error('This is for Linux');
        let script;
        if (on) {
            const t = target();
            if (!t) throw new Error('The system cannot see the Wi-Fi card right now, so it cannot tell which driver to look after. Repair it first (or restart), then turn this on');
            const dir = fs.mkdtempSync(path.join(tmpdir, 'wifi-'));
            fs.writeFileSync(path.join(dir, 'repair.sh'), repairScript({ sys, ...t }));
            fs.writeFileSync(path.join(dir, 'hook.sh'), hookScript({ sys, module: t.module }));
            fs.writeFileSync(path.join(dir, 'nm.conf'), nmConf());
            script = [`mkdir -p ${shq(path.dirname(REPAIR_FILE))} ${shq(path.dirname(HOOK_FILE))} ${shq(path.dirname(NM_CONF))}`,
                `cp ${shq(path.join(dir, 'repair.sh'))} ${shq(REPAIR_FILE)} && chmod 755 ${shq(REPAIR_FILE)}`,
                `cp ${shq(path.join(dir, 'hook.sh'))} ${shq(HOOK_FILE)} && chmod 755 ${shq(HOOK_FILE)}`,
                `cp ${shq(path.join(dir, 'nm.conf'))} ${shq(NM_CONF)}`, 'systemctl reload NetworkManager 2>/dev/null || true'].join(' ; ');
        } else script = `rm -f ${shq(HOOK_FILE)} ${shq(REPAIR_FILE)} ${shq(NM_CONF)} ; systemctl reload NetworkManager 2>/dev/null || true`;
        onLine('Asking for permission…');
        const code = await asAdmin(script, onLine);
        if (code === 126) throw new Error('The password prompt was cancelled');
        if (code !== 0) throw new Error(`That did not work (code ${code})`);
        onLine(on ? 'Done: Wi-Fi is unloaded before sleep and brought back after it' : 'Removed');
        return { ok: true };
    }

    return { diagnose, repair, setSleepFix, target, supported };
}

module.exports = { createWifi, repairScript, hookScript, nmConf, verdict, parseRfkill, HOOK_FILE, REPAIR_FILE, NM_CONF, TAG };
