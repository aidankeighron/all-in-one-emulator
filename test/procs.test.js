const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawn } = require('child_process');

const procs = require('../ui/lib/procs');

const stateOf = pid => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0];
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 20)); } return check(); };

test('a game and everything it started can be frozen and continued', { skip: process.platform !== 'linux' }, async () => {
    // a shell that starts a child, like a launcher starting an emulator
    const parent = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    try {
        await until(() => procs.tree(parent.pid).length >= 2);
        const pids = await procs.pidsFor(parent, null);
        assert.ok(pids.length >= 2, 'the launcher and its child are both found');
        procs.signal(pids, 'SIGSTOP');
        assert.ok(await until(() => pids.every(p => stateOf(p) === 'T')), 'all stopped');
        procs.signal(pids, 'SIGCONT');
        assert.ok(await until(() => pids.every(p => stateOf(p) !== 'T')), 'all running again');
    } finally {
        for (const p of procs.tree(parent.pid)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    }
});

test('flatpak ps output is read for the app’s sandbox processes', async () => {
    const fake = (cmd, args, cb) => cb(null, 'org.DolphinEmu.dolphin-emu\t1200\t1234\nother.app\t9\t10\n');
    assert.deepStrictEqual(await procs.flatpakPids('org.DolphinEmu.dolphin-emu', fake), [1200, 1234]);
    assert.deepStrictEqual(await procs.flatpakPids('x', (c, a, cb) => cb(new Error('no flatpak'))), []);
});
