// Pausing a running game: stopping and continuing the emulator's processes. The emulator window keeps its picture; its game,
// sound and input stand still until it is continued. Linux: SIGSTOP and SIGCONT. Windows has no such signals: there a
// PowerShell started once (see winFreezer) suspends and resumes the processes.
const fs = require('fs');
const { execFile, spawn } = require('child_process');

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

// Windows: one PowerShell that waits for lines like "S 1234 5678" (suspend) or "R 1234" (resume), started ahead of time so a
// pause takes effect at once (making the PowerShell type takes a second or so). Lines are handled in the order written, so a
// resume sent right after a suspend never overtakes it.
const FREEZER_SCRIPT = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class EmuMenuFreeze {',
    '    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);',
    '    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);',
    '}',
    '"@',
    'while ($null -ne ($line = [Console]::In.ReadLine())) {',
    "    $parts = $line.Trim().Split(' ')",
    '    foreach ($id in ($parts | Select-Object -Skip 1)) {',
    '        try {',
    '            $p = [System.Diagnostics.Process]::GetProcessById([int]$id)',
    "            if ($parts[0] -eq 'S') { [void][EmuMenuFreeze]::NtSuspendProcess($p.Handle) } else { [void][EmuMenuFreeze]::NtResumeProcess($p.Handle) }",
    '        } catch { }',
    '    }',
    '}'
].join('\r\n');

let freezer = null;
function winFreezer(spawnImpl = spawn) {
    if (freezer) return freezer;
    try {
        const encoded = Buffer.from(FREEZER_SCRIPT, 'utf16le').toString('base64');
        const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        const gone = () => { if (freezer === child) freezer = null; };
        child.on('error', gone);
        child.on('exit', gone);
        if (child.stdin) child.stdin.on('error', gone);
        if (child.unref) child.unref();
        freezer = child;
    } catch { freezer = null; }
    return freezer;
}

// Stops (on = true) or continues the processes. Returns how many were sent the request.
function freeze(pids, on, { platform = process.platform, spawnImpl } = {}) {
    if (!pids || !pids.length) return 0;
    if (platform !== 'win32') return signal(pids, on ? 'SIGSTOP' : 'SIGCONT');
    const f = winFreezer(spawnImpl);
    if (!f || !f.stdin || f.stdin.destroyed) return 0;
    try { f.stdin.write(`${on ? 'S' : 'R'} ${pids.join(' ')}\n`); } catch { return 0; }
    return pids.length;
}

module.exports = { childMap, tree, flatpakPids, pidsFor, signal, freeze, winFreezer, FREEZER_SCRIPT };
