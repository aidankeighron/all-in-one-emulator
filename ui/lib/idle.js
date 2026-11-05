// What the computer does when nobody uses it (Linux, GNOME): nothing, the screen off, or sleep, after a while in the menu.
//
// The desktop's own idle timer only sees the keyboard and mouse, not controllers, so left to itself it would put the computer
// to sleep in the middle of a game played with a controller (kiosk mode switches it off for that reason). The menu sees the
// controllers, so it keeps the time itself: idle is the shorter of "since a controller was used" and the desktop's own
// "since the keyboard or mouse was used" (GNOME's idle monitor). Never while a game runs.
//   screen  the screen goes dark (GNOME's screen saver, which kiosk mode does not lock); any controller, key or the mouse
//           brings it back
//   sleep   the computer sleeps (systemctl suspend); the power button wakes it (see the README for controllers)
const childProcess = require('child_process');

const ACTIONS = ['off', 'screen', 'sleep'];
const MINUTES = [10, 15, 30, 60];

function createIdle({ getSettings, gameRunning = () => false, sleep, execImpl = childProcess.execFile, now = Date.now, log = () => {} } = {}) {
    const run = (cmd, args) => new Promise(resolve => execImpl(cmd, args, { timeout: 4000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') })));
    let lastController = now();
    let dark = false;            // the menu turned the screen off
    let acted = false;           // already slept or went dark for this idle spell
    let lastTick = now();

    // Milliseconds since the keyboard or mouse was used, from GNOME (Infinity where it cannot say)
    async function desktopIdle() {
        const r = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor', '--object-path', '/org/gnome/Mutter/IdleMonitor/Core', '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime']);
        const m = r.ok && /uint64\s+(\d+)/.exec(r.out);
        return m ? Number(m[1]) : Infinity;
    }
    const screenSaver = on => run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.SetActive', on ? 'true' : 'false']);

    // A controller was used: idle starts again, and a screen the menu turned off comes back
    function controllerUsed() {
        lastController = now();
        acted = false;
        if (dark) { dark = false; screenSaver(false); }
    }

    async function tick() {
        const t = now();
        // the computer was asleep (the clock jumped): it just woke, so it is not idle
        if (t - lastTick > 60 * 1000) { lastController = t; acted = false; }
        lastTick = t;
        const { action, minutes } = getSettings();
        if (action === 'off' || gameRunning()) { acted = false; return null; }
        const idle = Math.min(t - lastController, await desktopIdle());
        if (idle < minutes * 60 * 1000) { acted = false; if (dark && idle < 5000) dark = false; return null; }
        if (acted) return null;
        acted = true;
        if (action === 'screen') { dark = true; log('[IDLE] screen off'); await screenSaver(true); return 'screen'; }
        log('[IDLE] going to sleep');
        lastController = t;
        await sleep();
        return 'sleep';
    }

    return { controllerUsed, tick, desktopIdle, isDark: () => dark };
}

module.exports = { createIdle, ACTIONS, MINUTES };
