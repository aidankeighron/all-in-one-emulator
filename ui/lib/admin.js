// Running commands as the administrator without a keyboard (Linux).
//
// The system's own password prompt (pkexec's dialog) has to be typed into with a keyboard, which a kiosk with only
// controllers does not have. So the menu can ask for the password itself, with its on-screen keyboard: once checked it is
// kept in memory for a few minutes, and commands run through `sudo -S` with it on their input. Without it they run through
// pkexec as before (its dialog). The password is never written anywhere.
const fs = require('fs');
const childProcess = require('child_process');

const KEEP_MS = 10 * 60 * 1000;
let kept = null;        // {password, until}

const sudoPath = (exists = fs.existsSync) => ['/usr/bin/sudo', '/bin/sudo'].find(f => exists(f)) || null;

function password(now = Date.now()) {
    if (kept && now < kept.until) return kept.password;
    kept = null;
    return null;
}

function forget() { kept = null; form = null; }

// The ways of asking sudo to read the password from its input, most specific first. Newer Ubuntu releases ship sudo-rs,
// which does not take every option of the classic sudo: an option it does not know made every password look wrong. The
// first one that works is used from then on.
const FORMS = [['-S', '-k', '-p', ''], ['-S', '-k'], ['-S']];
let form = null;
const OPTION_TROUBLE = /unexpected argument|unknown option|invalid option|unrecognized|usage:|not supported/i;

// Checks the password with sudo (nothing is run) and keeps it when it is right.
// Resolves {ok: true} or {ok: false, reason} with sudo's own words (a wrong password, not allowed to use sudo, ...).
function remember(pw, { spawnImpl = childProcess.spawn, exists = fs.existsSync, now = Date.now() } = {}) {
    const sudo = sudoPath(exists);
    if (!sudo) return Promise.resolve({ ok: false, reason: 'sudo is not installed' });
    if (typeof pw !== 'string' || !pw || pw.length > 200) return Promise.resolve({ ok: false, reason: 'Type the password' });
    const attempt = opts => new Promise(resolve => {
        let err = '';
        const child = spawnImpl(sudo, [...opts, 'true'], { stdio: ['pipe', 'ignore', 'pipe'] });
        if (child.stderr) child.stderr.on('data', d => { err += String(d); });
        child.on('error', e => resolve({ code: -1, err: e.message }));
        child.on('close', code => resolve({ code, err }));
        try { child.stdin.write(`${pw}\n`); child.stdin.end(); } catch { /* it has gone */ }
    });
    return (async () => {
        let last = null;
        for (const opts of form ? [form] : FORMS) {
            last = await attempt(opts);
            if (last.code === 0) { form = opts; kept = { password: pw, until: now + KEEP_MS }; return { ok: true }; }
            if (!OPTION_TROUBLE.test(last.err)) break;      // sudo understood the question: the answer was no
        }
        const words = last.err.split('\n').map(l => l.trim()).filter(l => l && !/password.*:\s*$/i.test(l));
        return { ok: false, reason: words.length ? words[words.length - 1] : `sudo said no (exit code ${last.code})` };
    })();
}

// Starts `sh -c script` as the administrator: through sudo with the kept password, else through pkexec (its own dialog).
// Returns the child process; exit codes as pkexec's (126: cancelled or refused, 127: could not ask).
function spawn(spawnImpl, script, { exists = fs.existsSync } = {}) {
    const pw = password();
    const sudo = pw ? sudoPath(exists) : null;
    if (!sudo) return spawnImpl('pkexec', ['sh', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const child = spawnImpl(sudo, [...(form || FORMS[0]), 'sh', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    try { child.stdin.write(`${pw}\n`); child.stdin.end(); } catch { /* it has gone */ }
    return child;
}

// What the menu window needs to know: can it ask for the password itself, and does it have it now
const status = ({ platform = process.platform, exists = fs.existsSync } = {}) => ({ supported: platform === 'linux' && !!sudoPath(exists), ready: !!password() });

module.exports = { spawn, remember, password, forget, status, KEEP_MS };
