// Who plays with what. Four players, each with a controller and a mapping per emulated console:
//   { device: 'auto' | 'none' | 'real' | 'pad:<id>', wii: <mapping id or 'auto'>, gc: <mapping id or 'auto'>, sw: <mapping id or 'auto'> }
//   An automatic mapping is the standard one for the kind of controller the player has (Xbox-style, Nintendo, real Wii Remote)
//   auto  takes the next connected controller nobody has asked for (the order they were plugged in)
//   none  this player is not playing
//   real  a real Wii Remote (Dolphin connects to it itself when the game starts)
//   pad   one particular controller, remembered by name so it stays with this player when plugged in again
const mappings = require('./mappings');
const { keyOf } = require('./controllers');

const PLAYERS = 4;
const DEVICE = /^(auto|none|real|pad:.{1,400})$/;
const PROFILE = /^(auto|[a-z0-9][a-z0-9-]{0,47})$/;

const defaults = () => Array.from({ length: PLAYERS }, () => ({ device: 'auto', wii: 'auto', gc: 'auto', sw: 'auto' }));

// A controller's lasting identity (its js/event number changes between plugs)
const padKey = keyOf;

// Checks players coming from a file or the UI and returns four clean entries
function normalize(input) {
    const list = Array.isArray(input) ? input : [];
    return Array.from({ length: PLAYERS }, (_, i) => {
        const p = list[i] || {};
        return {
            device: typeof p.device === 'string' && DEVICE.test(p.device) ? p.device : 'auto',
            wii: typeof p.wii === 'string' && PROFILE.test(p.wii) ? p.wii : 'auto',
            gc: typeof p.gc === 'string' && PROFILE.test(p.gc) ? p.gc : 'auto',
            sw: typeof p.sw === 'string' && PROFILE.test(p.sw) ? p.sw : 'auto'
        };
    });
}

// Works out what each player has right now.
// controllers: the detected list; settings: {players, wiiRemotes}; getProfile(id) -> profile or null
// Returns four slots: {index, mode: 'pad' | 'real' | 'none' | 'empty', controller, missing, family, wii, gc, sw, auto}
// where `auto` is the id of the standard mapping for this player's controller, for each console
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

    const TARGET_KEY = { wii: 'wii', gamecube: 'gc', switch: 'sw' };
    for (const s of slots) {
        // A real Wii Remote is its own kind; an empty player is judged as an ordinary pad
        s.family = s.mode === 'real' ? 'wiimote' : mappings.familyOf(s.controller);
        s.auto = {};
        for (const [target, field] of Object.entries(TARGET_KEY)) {
            const standard = mappings.defaultFor(target, s.family);
            s.auto[field] = standard;
            const chosen = s.request[field] === 'auto' ? null : getProfile(s.request[field]);
            // A mapping of the wrong console or for a real Wii Remote (a deleted or edited file) falls back to the standard one
            const ok = chosen && chosen.target === target && (chosen.family !== 'wiimote' || s.family === 'wiimote');
            s[field] = ok ? chosen : getProfile(standard) || getProfile(mappings.DEFAULT_PROFILE[target]);
        }
    }
    return slots;
}

// ---------- Changing the order ----------
// Both work on the saved players and the slots resolve() made from them. A mapping choice goes with its controller.

// What to write as a player's controller so it stays with whoever has it now, even if it was only on automatic
const pinned = slot => (slot.controller ? padKey(slot.controller) : slot.mode === 'real' ? 'real' : null);

// Everyone keeps what they have now, so that moving one controller does not shuffle the others
const pinAll = (list, slots) => list.map((p, i) => ({ ...p, device: p.device === 'auto' ? pinned(slots[i]) || 'auto' : p.device }));

// Swaps player a and player b (0-3) with everything they have
function swap(players, slots, a, b) {
    if (!(a >= 0 && a < PLAYERS && b >= 0 && b < PLAYERS) || a === b) return normalize(players);
    const list = pinAll(normalize(players), slots);
    const [ea, eb] = [list[a], list[b]];
    list[a] = { ...eb, device: pinned(slots[b]) || eb.device };
    list[b] = { ...ea, device: pinned(slots[a]) || ea.device };
    return list;
}

// Two controllers became one (or one became two): the player that had them keeps the result. `from` are the keys they
// had, `to` the key they have now; if two players had one each, the first keeps it and the other goes back to automatic.
function repin(players, from, to) {
    let done = false;
    return normalize(players).map(p => {
        if (!from.includes(p.device)) return p;
        if (done) return { ...p, device: 'auto' };
        done = true;
        return { ...p, device: to };
    });
}

// Puts a controller that no player has (by its key) on player `to`; whoever was there loses it
function place(players, slots, key, to) {
    if (!(to >= 0 && to < PLAYERS) || !DEVICE.test(key) || !key.startsWith('pad:')) return normalize(players);
    const list = pinAll(normalize(players), slots);
    list.forEach((p, i) => { if (i !== to && p.device === key) list[i] = { ...p, device: 'auto' }; });
    list[to] = { ...list[to], device: key };
    return list;
}

module.exports = { PLAYERS, defaults, normalize, resolve, swap, place, repin, padKey };
