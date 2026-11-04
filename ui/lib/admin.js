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

function forget() { kept = null; }

// Checks the password with sudo (nothing is run) and keeps it when it is right. Resolves true or false.
function remember(pw, { spawnImpl = childProcess.spawn, exists = fs.existsSync, now = Date.now() } = {}) {
    const sudo = sudoPath(exists);
    if (!sudo || typeof pw !== 'string' || !pw || pw.length > 200) return Promise.resolve(false);
    return new Promise(resolve => {
        const child = spawnImpl(sudo, ['-S', '-k', '-p', '', 'true'], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => resolve(false));
        child.on('close', code => {
            if (code === 0) kept = { password: pw, until: now + KEEP_MS };
            resolve(code === 0);
        });
        try { child.stdin.write(`${pw}\n`); child.stdin.end(); } catch { /* it has gone */ }
    });
}

// Starts `sh -c script` as the administrator: through sudo with the kept password, else through pkexec (its own dialog).
// Returns the child process; exit codes as pkexec's (126: cancelled or refused, 127: could not ask).
function spawn(spawnImpl, script, { exists = fs.existsSync } = {}) {
    const pw = password();
    const sudo = pw ? sudoPath(exists) : null;
    if (!sudo) return spawnImpl('pkexec', ['sh', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const child = spawnImpl(sudo, ['-S', '-k', '-p', '', 'sh', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    try { child.stdin.write(`${pw}\n`); child.stdin.end(); } catch { /* it has gone */ }
    return child;
}

// What the menu window needs to know: can it ask for the password itself, and does it have it now
const status = ({ platform = process.platform, exists = fs.existsSync } = {}) => ({ supported: platform === 'linux' && !!sudoPath(exists), ready: !!password() });

module.exports = { spawn, remember, password, forget, status, KEEP_MS };
