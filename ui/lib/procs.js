// Pausing a running game: stopping and continuing the emulator's processes (Linux). The emulator window
// keeps its picture; its game, sound and input stand still until it is continued.
const fs = require('fs');
const { execFile } = require('child_process');

// pid -> [child pids], from /proc
function childMap(procDir = '/proc') {
    const map = new Map();
    let names = [];
    try { names = fs.readdirSync(procDir).filter(n => /^\d+$/.test(n)); } catch { return map; }
    for (const n of names) {
        try {
            const stat = fs.readFileSync(`${procDir}/${n}/stat`, 'utf8');
            const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
            if (!map.has(ppid)) map.set(ppid, []);
            map.get(ppid).push(Number(n));
        } catch { /* it ended while we looked */ }
    }
    return map;
}

// pid and everything below it
function tree(pid, map = childMap()) {
    const out = [];
    const walk = p => { out.push(p); for (const c of map.get(p) || []) walk(c); };
    if (Number.isInteger(pid) && pid > 1) walk(pid);
    return out;
}

// The sandbox processes of a running Flatpak app, as the host sees them
function flatpakPids(appId, execImpl = execFile) {
    return new Promise(resolve => {
        execImpl('flatpak', ['ps', '--columns=application,pid,child-pid'], (err, stdout) => {
            if (err) return resolve([]);
            const pids = [];
            for (const line of String(stdout).split('\n')) {
                const cols = line.trim().split(/\s+/);
                if (cols[0] !== appId) continue;
                for (const v of cols.slice(1)) if (/^\d+$/.test(v)) pids.push(Number(v));
            }
            resolve(pids);
        });
    });
}

// Every process to pause for a launched emulator (child: what we spawned)
async function pidsFor(child, flatpakId, execImpl) {
    const map = childMap();
    const roots = [child && child.pid, ...(flatpakId ? await flatpakPids(flatpakId, execImpl) : [])].filter(Boolean);
    return [...new Set(roots.flatMap(p => tree(p, map)))];
}

function signal(pids, sig) {
    let n = 0;
    for (const pid of pids) { try { process.kill(pid, sig); n++; } catch { /* gone */ } }
    return n;
}

module.exports = { childMap, tree, flatpakPids, pidsFor, signal };
