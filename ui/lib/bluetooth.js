// Connecting Wii Remotes and Switch controllers (Pro Controller, Joy-Cons) from inside the menu.
//
// Linux: talks to BlueZ through `bluetoothctl`. If Bluetooth is not set up, `setup()` installs and starts what is
//        missing (one password prompt from the system, via pkexec).
//   Switch controllers are paired with the computer (pair + trust + connect) and then behave like any gamepad.
//   Wii Remotes are NOT paired with the computer: Dolphin connects to them itself, and it cannot if the operating
//   system has already taken the remote. So the menu only checks that one is in range ("found"), makes sure
//   Bluetooth is ready, and tells Dolphin to use real Wii Remotes (see inputconfig).
// Windows: Windows owns Bluetooth pairing and has no command line for it, so the menu opens its Bluetooth page
//   and shows the steps.
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|[\x01\x02]/g;
// bluetoothctl puts its prompt ("[bluetooth]# ", or "[bluetoothctl]> " in newer versions) in front of lines that arrive while it is waiting for a command; the line
// is what follows it. Several can pile up in front of one line.
const PROMPT = /^(?:\[[^\]\n]*\][#>$]\s*)+/gm;
const clean = s => String(s).replace(ANSI, '').replace(/\r/g, '').replace(PROMPT, '');

// What a Bluetooth device name says it is
function classifyDevice(name = '') {
    if (/RVL-WBC/i.test(name)) return 'balance-board';
    if (/RVL-CNT|Nintendo Wii Remote/i.test(name)) return 'wiimote';
    if (/Joy-Con\s*\(L\)/i.test(name)) return 'joycon-l';
    if (/Joy-Con\s*\(R\)/i.test(name)) return 'joycon-r';
    if (/Pro Controller|Switch Pro|Nintendo Switch/i.test(name)) return 'pro';
    if (/Wireless Gamepad/i.test(name)) return 'pro';
    return null;
}

const KIND_TYPES = {
    wiimote: ['wiimote'],
    switch: ['pro', 'joycon-l', 'joycon-r'],
    pro: ['pro'],
    joycon: ['joycon-l', 'joycon-r']
};

const TYPE_LABELS = { wiimote: 'Wii Remote', pro: 'Switch Pro Controller', 'joycon-l': 'Joy-Con (L)', 'joycon-r': 'Joy-Con (R)', 'balance-board': 'Balance Board' };

// One line of bluetoothctl output -> {event, address, name} or null
function parseLine(raw) {
    const line = clean(raw).trim();
    let m = line.match(/^\[(NEW|CHG|DEL)\]\s+Device\s+((?:[0-9A-F]{2}:){5}[0-9A-F]{2})\s*(.*)$/i);
    if (!m) return null;
    const address = m[2].toUpperCase();
    const rest = m[3];
    if (m[1] === 'DEL') return { event: 'del', address };
    if (m[1] === 'NEW') return { event: 'new', address, name: rest };
    const named = rest.match(/^(?:Name|Alias):\s*(.+)$/);
    return named ? { event: 'name', address, name: named[1] } : { event: 'prop', address, text: rest };
}

// "Device AA:BB:... Name" lines from `bluetoothctl devices`
function parseDevices(text) {
    const out = [];
    for (const raw of clean(text).split('\n')) {
        const m = raw.trim().match(/^Device\s+((?:[0-9A-F]{2}:){5}[0-9A-F]{2})\s+(.*)$/i);
        if (m) out.push({ address: m[1].toUpperCase(), name: m[2].trim() });
    }
    return out;
}

function kernelAtLeast(release, major, minor) {
    const m = String(release).match(/^(\d+)\.(\d+)/);
    return !!m && (Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor));
}

function packageCommand(has) {
    if (has('apt-get')) return { name: 'apt', cmd: 'apt-get install -y bluez rfkill' };
    if (has('dnf')) return { name: 'dnf', cmd: 'dnf install -y bluez' };
    if (has('pacman')) return { name: 'pacman', cmd: 'pacman -S --noconfirm bluez bluez-utils' };
    if (has('zypper')) return { name: 'zypper', cmd: 'zypper --non-interactive install bluez' };
    return null;
}

function createBluetooth({ platform = process.platform, execImpl = execFile, spawnImpl = spawn, exists = fs.existsSync, release = os.release(), log = () => {}, scanSeconds = 30, stepSeconds = 20 } = {}) {
    const win = platform === 'win32';
    let job = null;       // the one thing happening now: {kind, phase, message, lines, device}
    let session = null;   // the running bluetoothctl for a pairing job

    const run = (cmd, args, timeout = 8000) => new Promise(resolve => {
        execImpl(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: !!err && err.code === 'ENOENT' }));
    });

    // ---------- State ----------

    async function status() {
        if (win) return { platform, supported: true, manual: true, ready: true, problems: [] };
        const problems = [];
        const ctl = await run('bluetoothctl', ['--version']);
        const installed = ctl.ok;
        let adapter = false, powered = false;
        if (installed) {
            const show = await run('bluetoothctl', ['show']);
            adapter = show.ok && /Controller\s+[0-9A-F:]{17}/i.test(show.stdout);
            powered = /Powered:\s*yes/i.test(show.stdout);
        }
        if (!installed) problems.push('not_installed');
        else if (!adapter) problems.push('no_adapter');
        else if (!powered) problems.push('off');
        // The Switch controllers' driver is part of Linux 5.16 and newer
        const nintendoDriver = kernelAtLeast(release, 5, 16) || exists('/sys/module/hid_nintendo');
        return { platform, supported: true, manual: false, installed, adapter, powered, nintendoDriver, kernel: release, ready: installed && adapter && powered, problems, job: snapshot() };
    }

    function snapshot() {
        return job ? { kind: job.kind, phase: job.phase, message: job.message, lines: job.lines.slice(-12), device: job.device || null } : null;
    }

    // ---------- Setup (install and turn on) ----------

    // Installs BlueZ if it is missing, starts the service and switches the adapter on. One system password prompt.
    async function setup() {
        if (win) throw Object.assign(new Error('Bluetooth is set up in Windows settings'), { code: 'MANUAL' });
        if (job && job.phase === 'running') throw Object.assign(new Error('Something is already in progress'), { code: 'BUSY' });
        job = { kind: 'setup', phase: 'running', message: 'Setting up Bluetooth…', lines: [] };
        const mine = job;
        const add = line => { mine.lines.push(String(line)); log(`[BT] ${line}`); };

        (async () => {
            const st = await status();
            const steps = [];
            if (!st.installed) {
                const pm = packageCommand(name => exists(`/usr/bin/${name}`) || exists(`/bin/${name}`) || exists(`/usr/sbin/${name}`) || exists(`/sbin/${name}`));
                if (!pm) throw new Error('Could not tell how to install packages on this system. Install the “bluez” package yourself, then try again.');
                steps.push(pm.cmd);
            }
            steps.push('systemctl enable --now bluetooth', 'rfkill unblock bluetooth');
            add('Asking for permission to install and turn on Bluetooth…');
            const code = await new Promise(resolve => {
                const child = spawnImpl('pkexec', ['sh', '-c', steps.join(' ; ')], { stdio: ['ignore', 'pipe', 'pipe'] });
                const feed = d => String(d).split(/[\r\n]+/).filter(Boolean).forEach(add);
                child.stdout.on('data', feed);
                child.stderr.on('data', feed);
                child.on('error', err => { add(err.code === 'ENOENT' ? 'pkexec is not available: run the commands in the README by hand' : err.message); resolve(127); });
                child.on('close', resolve);
            });
            if (code === 126) throw new Error('The password prompt was cancelled');
            if (code === 127) throw new Error('Could not ask for permission to install');
            await run('bluetoothctl', ['power', 'on']);
            const after = await status();
            if (!after.installed) throw new Error('Bluetooth could not be installed');
            if (!after.adapter) throw new Error('No Bluetooth adapter was found on this computer. Plug in a USB Bluetooth adapter and try again.');
            if (!after.powered) throw new Error('Bluetooth could not be switched on (is it blocked by a hardware switch?)');
            mine.phase = 'done';
            mine.message = 'Bluetooth is ready';
        })().catch(err => { mine.phase = 'failed'; mine.message = err.message; add(err.message); });
        return snapshot();
    }

    // ---------- Pairing ----------

    // kind: 'switch' pairs the first Switch controller that appears; 'wiimote' only looks for one.
    function startPairing(kind) {
        if (win) throw Object.assign(new Error('Pair in Windows settings'), { code: 'MANUAL' });
        if (!KIND_TYPES[kind]) throw Object.assign(new Error('Unknown controller type'), { code: 'BAD_KIND' });
        if (job && job.phase === 'running') throw Object.assign(new Error('Something is already in progress'), { code: 'BUSY' });
        const mine = job = { kind, phase: 'running', stage: 'scanning', message: 'Looking for your controller…', lines: [], device: null };
        const add = line => { mine.lines.push(line); log(`[BT] ${line}`); };
        const wanted = KIND_TYPES[kind];

        // bluetoothctl prints through a pipe in big blocks, so what it finds can arrive minutes late. stdbuf makes it
        // hand over every line at once.
        const lineBuffered = platform === 'linux' && ['/usr/bin/stdbuf', '/bin/stdbuf'].some(f => exists(f));
        const child = lineBuffered ? spawnImpl('stdbuf', ['-oL', '-eL', 'bluetoothctl'], { stdio: ['pipe', 'pipe', 'pipe'] })
            : spawnImpl('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });

        session = child;
        const send = cmd => { try { child.stdin.write(`${cmd}\n`); } catch { /* already gone */ } };
        const names = new Map();
        let timer = null, pending = null, finished = false, infoFor = null;
        const connected = new Set();      // controllers that are connected already: not the one being looked for

        const finish = (phase, message) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            mine.phase = phase;
            mine.message = message;
            send('scan off');
            send('quit');
            setTimeout(() => { try { child.kill(); } catch { /* done */ } }, 500);
            if (session === child) session = null;
        };
        const arm = (seconds, message) => { clearTimeout(timer); timer = setTimeout(() => finish('failed', message), seconds * 1000); };

        // A step of the pairing conversation waits for one of these lines
        const expect = (ok, bad, then) => { pending = { ok, bad, then }; };

        function found(address, name) {
            const type = classifyDevice(name);
            if (!type || !wanted.includes(type) || mine.device || connected.has(address)) return;
            mine.device = { address, name, type, label: TYPE_LABELS[type] };
            if (kind === 'wiimote') {
                add(`Found ${name}`);
                return finish('done', 'Wii Remote found. It connects by itself when a game starts: press 1 + 2 then.');
            }
            mine.stage = 'pairing';
            mine.message = `Connecting ${TYPE_LABELS[type]}…`;
            add(`Found ${name}, pairing`);
            send('scan off');
            arm(stepSeconds, 'The controller did not finish pairing. Hold its sync button again and retry.');
            expect(/Pairing successful|AlreadyExists|Already Exists/i, /Failed to pair/i, () => {
                send(`trust ${address}`);
                expect(/trust succeeded|trusted: yes/i, /Failed to trust/i, () => {
                    send(`connect ${address}`);
                    arm(stepSeconds, 'Paired, but it did not connect. Press a button on the controller, or retry.');
                    expect(/Connection successful/i, /Failed to connect/i, () => finish('done', `${TYPE_LABELS[type]} connected`));
                });
            });
            send(`pair ${address}`);
        }

        let buffer = '';
        const onData = chunk => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const raw of lines) {
                const line = clean(raw).trim();
                if (!line) continue;
                // Confirmation prompts from the pairing agent are answered for the user
                if (/Confirm passkey|Request confirmation|Authorize service|Accept pairing/i.test(line)) send('yes');
                if (pending) {
                    if (pending.ok.test(line)) { const next = pending.then; pending = null; next(); continue; }
                    if (pending.bad.test(line)) {
                        // A controller that is already paired is fine: carry on to connecting it
                        if (/AlreadyExists|Already Exists/i.test(line)) { const next = pending.then; pending = null; next(); continue; }
                        return finish('failed', line.replace(/^.*Failed to \w+:?\s*/i, 'Failed: '));
                    }
                }
                // The answer to `devices`: controllers BlueZ already knows from an earlier scan (it announces those
                // with property changes, not "[NEW]", so they would never be noticed otherwise)
                const known = line.match(/^Device\s+((?:[0-9A-F]{2}:){5}[0-9A-F]{2})\s+(.*)$/i);
                if (known && !known[2].startsWith('(')) {
                    const addr = known[1].toUpperCase();
                    names.set(addr, known[2].trim());
                    // Listed by `devices`: ask whether it is connected or advertising right now (a controller added from
                    // the system's Bluetooth settings is already here and never announces itself again)
                    const t = classifyDevice(known[2]);
                    if (t && wanted.includes(t) && !mine.device && !finished) send(`info ${addr}`);
                    continue;
                }
                if (known) { infoFor = known[1].toUpperCase(); continue; }       // the header of an `info` answer
                if (infoFor && /^Connected:\s*yes/i.test(line)) { connected.add(infoFor); infoFor = null; continue; }
                if (infoFor && /^RSSI:\s*-?\d+/i.test(line) && names.has(infoFor)) {
                    const addr = infoFor; infoFor = null;
                    found(addr, names.get(addr));
                    continue;
                }
                const ev = parseLine(line);
                if (!ev) continue;
                // Anything a known controller reports means it is in range right now
                if (ev.event === 'prop' && /Connected: yes/i.test(ev.text)) { connected.add(ev.address); continue; }
                if (ev.event === 'prop' && /Connected: no/i.test(ev.text)) connected.delete(ev.address);
                if (ev.event === 'prop' && names.has(ev.address) && /RSSI:/i.test(ev.text)) { found(ev.address, names.get(ev.address)); continue; }
                if (ev.event === 'new') { names.set(ev.address, ev.name); found(ev.address, ev.name); }
                else if (ev.event === 'name') { names.set(ev.address, ev.name); found(ev.address, ev.name); }
            }
        };
        child.stdout.on('data', d => onData(String(d)));
        child.stderr.on('data', d => add(clean(d).trim()));
        child.on('error', err => finish('failed', err.code === 'ENOENT' ? 'Bluetooth is not installed yet. Use “Set up Bluetooth” first.' : err.message));
        child.on('close', () => { if (!finished) finish('failed', 'Bluetooth stopped unexpectedly'); });

        send('power on');
        send('agent NoInputNoOutput');
        send('default-agent');
        // First find out which controllers are connected already (so the same one is not picked again), then search
        send('devices');
        setTimeout(() => { if (!finished) send('scan on'); }, 800);
        arm(scanSeconds, kind === 'wiimote'
            ? 'No Wii Remote found. Press 1 + 2 together (not the red sync button) and keep them held, then try again.'
            : 'No controller found. Hold the small sync button on the controller until its lights sweep back and forth, then try again.');
        return snapshot();
    }

    function cancel() {
        if (session) { try { session.stdin.write('scan off\nquit\n'); } catch { /* gone */ } try { session.kill(); } catch { /* gone */ } session = null; }
        if (job && job.phase === 'running') { job.phase = 'cancelled'; job.message = 'Cancelled'; }
        return snapshot();
    }

    // ---------- Already known controllers ----------

    async function paired() {
        if (win) return [];
        let r = await run('bluetoothctl', ['devices', 'Paired']);
        if (!r.ok || !r.stdout.trim()) r = await run('bluetoothctl', ['paired-devices']);
        const list = [];
        for (const d of parseDevices(r.stdout)) {
            const type = classifyDevice(d.name);
            if (!type) continue;
            const info = await run('bluetoothctl', ['info', d.address]);
            list.push({ ...d, type, label: TYPE_LABELS[type], connected: /Connected:\s*yes/i.test(info.stdout) });
        }
        return list;
    }

    async function forget(address) {
        if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(address)) throw Object.assign(new Error('Bad address'), { code: 'BAD_ADDRESS' });
        const r = await run('bluetoothctl', ['remove', address.toUpperCase()]);
        return { ok: r.ok };
    }

    // Windows: opens the page where controllers are paired
    function openSystemSettings() {
        if (!win) return false;
        spawnImpl('explorer.exe', ['ms-settings:bluetooth'], { detached: true, stdio: 'ignore' }).unref();
        return true;
    }

    return { status, setup, startPairing, cancel, paired, forget, openSystemSettings, snapshot };
}

module.exports = { createBluetooth, classifyDevice, parseLine, parseDevices, kernelAtLeast, packageCommand, KIND_TYPES, TYPE_LABELS };
