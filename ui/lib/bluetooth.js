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
    joycon: ['joycon-l', 'joycon-r'],
    // one side only: the steps that connect a left and then a right Joy-Con to be joined
    'joycon-l': ['joycon-l'],
    'joycon-r': ['joycon-r'],
    // everyone at once (like the Switch's controller screen): every Switch controller and Wii Remote that turns up, one
    // after another, until the screen is closed
    all: ['pro', 'joycon-l', 'joycon-r', 'wiimote']
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

function createBluetooth({ platform = process.platform, execImpl = execFile, spawnImpl = spawn, exists = fs.existsSync, release = os.release(), log = () => {}, scanSeconds = 30, stepSeconds = 20, retryMs = 2500, selfWaitMs = 0, pollMs = 250, inputPresent = null } = {}) {
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
        if (!job) return null;
        const out = { kind: job.kind, phase: job.phase, message: job.message, lines: job.lines.slice(-12), device: job.device || null };
        if (job.multi) { out.multi = true; out.devices = job.devices.map(d => ({ ...d })); out.waiting = (job.queue || []).map(q => ({ address: q.address, type: classifyDevice(q.name), label: TYPE_LABELS[classifyDevice(q.name)] })); }
        return out;
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

    // kind: 'switch' pairs the first Switch controller that appears; 'wiimote' the first Wii Remote. 'all' keeps going: every
    // Switch controller and Wii Remote that turns up is paired in turn (job.devices), until cancel() or a long quiet spell.
    function startPairing(kind) {
        if (win) throw Object.assign(new Error('Pair in Windows settings'), { code: 'MANUAL' });
        if (!KIND_TYPES[kind]) throw Object.assign(new Error('Unknown controller type'), { code: 'BAD_KIND' });
        if (job && job.phase === 'running') throw Object.assign(new Error('Something is already in progress'), { code: 'BUSY' });
        const multi = kind === 'all';
        const mine = job = { kind, multi, phase: 'running', stage: 'scanning', message: multi ? 'Waiting for controllers…' : 'Looking for your controller…', lines: [], device: null, devices: [] };
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
        const knownPaired = new Map();    // what `info` said: is it paired with this computer already
        let timer = null, pending = null, finished = false, infoFor = null;
        const connected = new Set();      // controllers that are connected already: not the one being looked for
        const queue = [];                 // everyone at once: controllers that turned up while another one was being paired

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
        mine.finish = finish;
        mine.queue = queue;
        // What everyone at once ends with: who was connected
        const summary = () => {
            const ok = mine.devices.filter(d => d.ok);
            return ok.length ? `Connected: ${ok.map(d => d.label).join(', ')}` : 'No new controller was connected';
        };
        mine.summary = summary;
        // A Wii Remote that cannot be connected to the computer still works in games (Dolphin connects it itself), so that is
        // not a failure, only a remote the menu cannot be driven with
        const WII_LATER = 'Wii Remote found. The menu could not connect it, but Dolphin connects it by itself when a game starts: press 1 + 2 then.';
        const arm = (seconds, message) => { clearTimeout(timer); timer = setTimeout(() => fail(message), seconds * 1000); };
        // Everyone at once waits this long for the next controller before it stops by itself
        const MULTI_IDLE = scanSeconds * 6;
        const idle = () => arm(MULTI_IDLE, null);

        // One controller is finished with (connected, or not): a single search ends there, everyone at once goes on looking
        function settle(ok, message) {
            const d = mine.device;
            if (!multi) return finish(ok ? 'done' : (kind === 'wiimote' && d ? 'done' : 'failed'), ok ? message : (kind === 'wiimote' && d ? WII_LATER : message));
            if (d) {
                const later = !ok && d.type === 'wiimote';
                mine.devices.push({ ...d, ok: ok || later, note: ok ? 'connected' : later ? 'Dolphin connects it when a game starts' : message });
                connected.add(d.address);
                add(ok ? `${d.label} connected` : later ? `${d.label} found (Dolphin connects it in a game)` : `${d.label}: ${message}`);
            }
            mine.device = null;
            mine.stage = 'scanning';
            pending = null;
            const next = queue.shift();
            if (next) return found(next.address, next.name);
            mine.message = mine.devices.length ? `${summary()}. Connect more, or press Done.` : 'Waiting for controllers…';
            send('scan on');
            idle();
        }
        function fail(message) {
            if (multi && !mine.device) return finish(mine.devices.length ? 'done' : 'failed', mine.devices.length ? summary() : 'No controller turned up. Hold the sync button (Switch) or press 1 + 2 (Wii Remote), then try again.');
            return settle(false, message);
        }

        // A step of the pairing conversation waits for one of these lines (onBad: what to do instead of failing)
        const expect = (ok, bad, then, onBad) => { pending = { ok, bad, then, onBad }; };
        const repaired = new Set();       // controllers whose old pairing was thrown away once already (never loops)
        const connectedText = type => (type === 'wiimote' ? 'Wii Remote connected. Use the D-pad and A in the menu; in a game Dolphin uses it as a real Wii Remote.' : `${TYPE_LABELS[type]} connected`);

        // Sends a command and waits for its answer: {answer: 'ok' | 'bad' | 'timeout', line}
        const ask = (cmd, ok, bad, ms) => new Promise(resolve => {
            const t = setTimeout(() => { if (pending && pending.ok === ok) pending = null; resolve({ answer: 'timeout', line: '' }); }, ms);
            expect(ok, bad, () => { clearTimeout(t); resolve({ answer: 'ok', line: '' }); }, line => { clearTimeout(t); pending = null; resolve({ answer: 'bad', line }); });
            send(cmd);
        });

        // Throws away BlueZ's pairing with a Switch controller and looks for it again, so it is paired afresh. Holding the sync
        // button starts a new pairing on the controller's side, so the old one (from before it was used with a Switch, or
        // put in sync mode again) does not work any more: every connection to it is refused. Never done to a Wii Remote, and
        // once per controller.
        function pairAfresh(device, why) {
            repaired.add(device.address);
            add(`${device.label}: ${why}, pairing it again`);
            pending = null;
            clearTimeout(timer);
            send(`remove ${device.address}`);
            mine.device = null;
            mine.stage = 'scanning';
            const next = queue.shift();
            if (next) found(next.address, next.name);
            else send('scan on');
            return multi ? idle() : arm(scanSeconds, 'The controller did not connect. Hold its sync button until the lights sweep, then try again.');
        }
        const freshable = device => device.type !== 'wiimote' && !repaired.has(device.address);
        // True as soon as the controller is on the computer as a controller (an input device with its address), false when
        // it is not within `ms`. Without a way to look (inputPresent), bluetoothctl's own answer is all there is.
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        async function present(device, ms) {
            if (!inputPresent) return false;
            const end = Date.now() + ms;
            for (;;) {
                if (mine.device !== device || finished) return false;
                try { if (inputPresent(device.address)) return true; } catch { /* look again */ }
                if (Date.now() >= end) return false;
                await sleep(pollMs);
            }
        }

        // The last step: the controller has to turn up on the computer as a controller. Bluetooth says "Connected: yes" as soon
        // as the radio link is up (during pairing already), which is not enough: the controller part has to connect too. A Switch
        // controller sometimes does that itself right after pairing, and an explicit "connect" at that moment can fail
        // ("br-connection-create-socket") although it works out, so a refusal is looked at again a moment later, up to three
        // times. A Switch controller that is refused every time is paired afresh once.
        async function connectStep(device) {
            const alive = () => mine.device === device && !finished;
            mine.stage = 'connecting';
            clearTimeout(timer);
            if (await present(device, selfWaitMs)) return alive() && settle(true, connectedText(device.type));
            let last = '';
            for (let attempt = 1; attempt <= 3 && alive(); attempt++) {
                const { answer, line } = await ask(`connect ${device.address}`, /Connection successful/i, /Failed to connect/i, stepSeconds * 1000);
                if (!alive()) return;
                if (!inputPresent && answer === 'ok') return settle(true, connectedText(device.type));
                if (await present(device, answer === 'ok' ? stepSeconds * 500 : retryMs)) return alive() && settle(true, connectedText(device.type));
                if (!alive()) return;
                last = answer === 'bad' ? line.replace(/^.*Failed to connect:?\s*/i, '') : answer === 'ok' ? 'connected, but no controller appeared' : 'no answer';
                add(`${device.label}: not connected yet (${last})${attempt < 3 ? ', trying again' : ''}`);
            }
            if (!alive()) return;
            if (freshable(device)) return pairAfresh(device, 'every connection was refused');
            fail(`Paired, but it did not connect (${last}). Hold its sync button again.`);
        }

        function found(address, name) {
            const type = classifyDevice(name);
            if (!type || !wanted.includes(type) || finished || connected.has(address)) return;
            if (mine.device) {
                if (multi && mine.device.address !== address && !queue.some(q => q.address === address)) queue.push({ address, name });
                return;
            }
            // a controller that connected is done; one that did not is tried again when it turns up again
            if (multi && mine.devices.some(d => d.address === address && d.ok)) return;
            if (multi) mine.devices = mine.devices.filter(d => d.address !== address);
            mine.device = { address, name, type, label: TYPE_LABELS[type], stale: false };      // stale: BlueZ said it is paired already
            const device = mine.device;
            // A Wii Remote is connected to the computer too (BlueZ knows how to pair one), so it can drive the menu; Dolphin
            // still finds it when a game starts
            mine.stage = 'pairing';
            mine.message = `Connecting ${TYPE_LABELS[type]}…`;
            add(`Found ${name}, pairing`);
            send('scan off');
            arm(stepSeconds, type === 'wiimote' ? 'The Wii Remote did not finish pairing. Press 1 + 2 again and retry.' : 'The controller did not finish pairing. Hold its sync button again and retry.');
            expect(/Pairing successful|AlreadyExists|Already Exists/i, /Failed to pair/i, () => {
                // Its sync button was held, so its side of the old pairing is gone: start over instead of trying a dead one
                if (device.stale && freshable(device)) return pairAfresh(device, 'it was paired before');
                send(`trust ${address}`);
                expect(/trust succeeded|trusted: yes/i, /Failed to trust/i, () => connectStep(device));
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
                    if (/AlreadyExists|Already Exists/i.test(line) && mine.device) mine.device.stale = true;
                    if (pending.ok.test(line)) { const next = pending.then; pending = null; next(); continue; }
                    if (pending.bad.test(line)) {
                        // A controller that is already paired is fine: carry on to connecting it
                        if (/AlreadyExists|Already Exists/i.test(line)) { const next = pending.then; pending = null; next(); continue; }
                        if (pending.onBad) { pending.onBad(line); continue; }
                        return fail(line.replace(/^.*Failed to \w+:?\s*/i, 'Failed: '));
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
                    if (t && wanted.includes(t) && (multi || !mine.device) && !finished) send(`info ${addr}`);
                    continue;
                }
                if (known) { infoFor = known[1].toUpperCase(); continue; }       // the header of an `info` answer
                if (infoFor && /^Paired:\s*(yes|no)/i.test(line)) { knownPaired.set(infoFor, /yes/i.test(line)); continue; }
                if (infoFor && /^Connected:\s*yes/i.test(line)) { connected.add(infoFor); infoFor = null; continue; }
                if (infoFor && /^RSSI:\s*-?\d+/i.test(line) && names.has(infoFor)) {
                    const addr = infoFor; infoFor = null;
                    // BlueZ keeps the last signal strength of a controller for a while after it was last heard, so for one
                    // that is paired already it says nothing about now (it reconnects with a button press anyway). One
                    // that is put in sync mode is heard again while the menu searches.
                    if (!knownPaired.get(addr)) found(addr, names.get(addr));
                    continue;
                }
                const ev = parseLine(line);
                if (!ev) continue;
                // Anything a known controller reports means it is in range right now
                // (the controller being paired says so while pairing already: that is only the radio link, see connectStep)
                if (ev.event === 'prop' && /Connected: yes/i.test(ev.text)) { if (!(mine.device && mine.device.address === ev.address)) connected.add(ev.address); continue; }
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
        if (multi) idle();
        else arm(scanSeconds, kind === 'wiimote'
            ? 'No Wii Remote found. Press 1 + 2 together (not the red sync button) and keep them held, then try again.'
            : 'No controller found. Hold the small sync button on the controller until its lights sweep back and forth, then try again.');
        return snapshot();
    }

    // Stops the search. Everyone at once ends as done with whoever was connected by then.
    function cancel() {
        if (job && job.phase === 'running' && job.multi && job.finish) { job.finish('done', job.summary()); return snapshot(); }
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

    const checkAddress = address => {
        if (typeof address !== 'string' || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(address)) throw Object.assign(new Error('Bad address'), { code: 'BAD_ADDRESS' });
        return address.toUpperCase();
    };

    // Unpairs it: it has to be paired again (sync button, or 1 + 2) before it can be used
    async function forget(address) {
        const r = await run('bluetoothctl', ['remove', checkAddress(address)]);
        return { ok: r.ok };
    }

    // Drops the connection but stays paired, like the Switch's "Disconnect controllers": pressing a button on it connects it again
    async function disconnect(address) {
        const r = await run('bluetoothctl', ['disconnect', checkAddress(address)]);
        return { ok: r.ok || /not connected/i.test(r.stdout + r.stderr) };
    }

    // Windows: opens the page where controllers are paired
    function openSystemSettings() {
        if (!win) return false;
        spawnImpl('explorer.exe', ['ms-settings:bluetooth'], { detached: true, stdio: 'ignore' }).unref();
        return true;
    }

    return { status, setup, startPairing, cancel, paired, forget, disconnect, openSystemSettings, snapshot };
}

module.exports = { createBluetooth, classifyDevice, parseLine, parseDevices, kernelAtLeast, packageCommand, KIND_TYPES, TYPE_LABELS };
