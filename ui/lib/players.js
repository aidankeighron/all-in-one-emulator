// Who plays with what. Four players, each with a controller and a mapping per kind of emulated controller:
//   { device: 'auto' | 'none' | 'real' | 'pad:<id>', wii: <mapping id or 'auto'>, gc: <mapping id or 'auto'> }
//   auto  takes the next connected controller nobody has asked for (the order they were plugged in)
//   none  this player is not playing
//   real  a real Wii Remote (Dolphin connects to it itself when the game starts)
//   pad   one particular controller, remembered by name so it stays with this player when plugged in again
const mappings = require('./mappings');

const PLAYERS = 4;
const DEVICE = /^(auto|none|real|pad:.{1,200})$/;
const PROFILE = /^(auto|[a-z0-9][a-z0-9-]{0,47})$/;

const defaults = () => Array.from({ length: PLAYERS }, () => ({ device: 'auto', wii: 'auto', gc: 'auto' }));

// A controller's lasting identity (its js/event number changes between plugs)
const padKey = c => `pad:${c.vendor || ''}:${c.product || ''}:${c.name}#${c.nameIndex || 0}`;

// Checks players coming from a file or the UI and returns four clean entries
function normalize(input) {
    const list = Array.isArray(input) ? input : [];
    return Array.from({ length: PLAYERS }, (_, i) => {
        const p = list[i] || {};
        return {
            device: typeof p.device === 'string' && DEVICE.test(p.device) ? p.device : 'auto',
            wii: typeof p.wii === 'string' && PROFILE.test(p.wii) ? p.wii : 'auto',
            gc: typeof p.gc === 'string' && PROFILE.test(p.gc) ? p.gc : 'auto'
        };
    });
}

// Works out what each player has right now.
// controllers: the detected list; settings: {players, wiiRemotes}; getProfile(id) -> profile or null
// Returns four slots: {index, mode: 'pad' | 'real' | 'none' | 'empty', controller, missing, wii, gc}
function resolve(controllers, settings, getProfile) {
    const players = normalize(settings.players);
    const wiiRemotes = settings.wiiRemotes || 0;
    const pool = controllers.filter(c => !c.adapter && (c.pad || c.kind === 'wiimote'));
    const claimed = new Set();
    const slots = players.map((p, index) => ({ index, mode: 'empty', controller: null, missing: null, request: p }));

    // Players that asked for a particular controller get it first
    for (const s of slots) {
        const d = s.request.device;
        if (!d.startsWith('pad:')) continue;
        const hit = pool.find(c => !claimed.has(c) && c.pad && padKey(c) === d);
        if (hit) { claimed.add(hit); s.mode = 'pad'; s.controller = hit; } else { s.mode = 'empty'; s.missing = d; }
    }
    for (const s of slots) {
        if (s.request.device === 'real') s.mode = 'real';
        else if (s.request.device === 'none') s.mode = 'none';
        // The "real Wii Remotes" count from the Bluetooth screen holds the first automatic players
        else if (s.request.device === 'auto' && s.index < wiiRemotes) s.mode = 'real';
    }
    // Everyone else on automatic takes the next free controller
    const free = pool.filter(c => !claimed.has(c));
    for (const s of slots) {
        if (s.request.device !== 'auto' || s.mode !== 'empty') continue;
        const next = free.shift();
        if (!next) continue;
        if (next.kind === 'wiimote') s.mode = 'real';
        else { s.mode = 'pad'; s.controller = next; }
    }

    for (const s of slots) {
        const pick = (id, target) => getProfile(id === 'auto' ? mappings.DEFAULT_PROFILE[target] : id) || getProfile(mappings.DEFAULT_PROFILE[target]);
        s.wii = pick(s.request.wii, 'wii');
        s.gc = pick(s.request.gc, 'gamecube');
        // A mapping of the wrong kind (a deleted or edited file) falls back to the standard one
        if (s.wii.target !== 'wii') s.wii = getProfile(mappings.DEFAULT_PROFILE.wii);
        if (s.gc.target !== 'gamecube') s.gc = getProfile(mappings.DEFAULT_PROFILE.gamecube);
    }
    return slots;
}

module.exports = { PLAYERS, defaults, normalize, resolve, padKey };
