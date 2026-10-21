// Finds the controllers plugged into this machine and works out what kind each one is.
// Reads /proc/bus/input/devices (readable by everyone, unlike /dev/input/event*) and the USB
// device list, so it needs no special permissions and no extra packages.
const fs = require('fs');
const path = require('path');

const NINTENDO = '057e';
const GC_ADAPTER_PRODUCT = '0337';   // official Nintendo GameCube Controller Adapter (Wii U / Switch)

const KIND_LABELS = {
    xbox: 'Xbox Controller',
    switch: 'Switch Controller',
    gamecube: 'GameCube Controller',
    wiimote: 'Wii Remote',
    generic: 'Game Controller'
};

// Kinds that look like a normal gamepad to SDL, so the emulators can all map them the same way
const PAD_KINDS = new Set(['xbox', 'switch', 'generic']);

// Input devices that sit next to a gamepad but are not one (the Wii Remote exposes several)
const NOT_A_PAD = /keyboard|mouse|touchpad|trackpad|consumer control|system control|power button|sleep button|video bus|lid switch|hdmi|speaker|headphone|headset|webcam|camera|\bir\b|accelerometer|motion ?plus|motion sensors|gyro|imu|nunchuk|classic controller|balance board|touchscreen|pen\b|stylus/i;

// Parses the text of /proc/bus/input/devices into [{name, vendor, product, bus, handlers, js, event}]
function parseProc(text) {
    const devices = [];
    for (const block of String(text || '').split(/\n\s*\n/)) {
        const id = block.match(/^I: Bus=(\w+) Vendor=(\w+) Product=(\w+)(?: Version=(\w+))?/m);
        const name = block.match(/^N: Name="(.*)"$/m);
        const handlers = block.match(/^H: Handlers=(.*)$/m);
        if (!id || !name || !handlers) continue;
        const list = handlers[1].trim().split(/\s+/);
        const js = list.find(h => /^js\d+$/.test(h));
        const event = list.find(h => /^event\d+$/.test(h));
        devices.push({
            name: name[1],
            bus: id[1].toLowerCase(),
            vendor: id[2].toLowerCase(),
            product: id[3].toLowerCase(),
            version: (id[4] || '0000').toLowerCase(),
            js: js ? Number(js.slice(2)) : null,
            event: event ? Number(event.slice(5)) : null
        });
    }
    return devices;
}

// What kind of controller is this?
function classify({ name = '', vendor = '', product = '' }) {
    if (/^nintendo wii remote$/i.test(name) || /rvl-cnt/i.test(name)) return 'wiimote';
    if (vendor === NINTENDO && product === GC_ADAPTER_PRODUCT) return 'gamecube';
    if (/gamecube|gc\/n64|gc adapter/i.test(name)) return 'gamecube';
    if (vendor === NINTENDO || /nintendo|switch|joy-?con|pro controller/i.test(name)) return 'switch';
    if (vendor === '045e' || /xbox|x-box|xinput/i.test(name)) return 'xbox';
    return 'generic';
}

function isController(dev) {
    if (NOT_A_PAD.test(dev.name)) return false;
    if (dev.js === null) return false;
    return true;
}

// Is an official GameCube adapter plugged in? Dolphin talks to it over USB directly, so it never
// shows up as a gamepad. usbIds: [{vendor, product}]
function hasGcAdapter(usbIds) {
    return usbIds.some(d => d.vendor === NINTENDO && d.product === GC_ADAPTER_PRODUCT);
}

function readUsbIds(root = '/sys/bus/usb/devices') {
    const out = [];
    let names;
    try { names = fs.readdirSync(root); } catch { return out; }
    for (const n of names) {
        try {
            out.push({
                vendor: fs.readFileSync(path.join(root, n, 'idVendor'), 'utf8').trim().toLowerCase(),
                product: fs.readFileSync(path.join(root, n, 'idProduct'), 'utf8').trim().toLowerCase()
            });
        } catch { /* an interface entry, not a device */ }
    }
    return out;
}

// Turns raw device lists into the list the menu and the emulator writers work with.
// Players are numbered in the order the system registered the devices (the order they were plugged in).
function build(procDevices, usbIds = []) {
    const adapter = hasGcAdapter(usbIds);
    // joycond joins two Joy-Cons into one "Combined Joy-Cons" controller and grabs the halves: only the combined one counts
    const combinedCount = procDevices.filter(d => /combined joy-?cons/i.test(d.name)).length;
    let halvesToDrop = combinedCount * 2;
    const found = procDevices
        .filter(d => !(halvesToDrop > 0 && /joy-?con/i.test(d.name) && !/combined/i.test(d.name) && halvesToDrop--))
        // The kernel may also expose the adapter as a gamepad; it is shown once, as the adapter
        .filter(d => !(adapter && d.vendor === NINTENDO && d.product === GC_ADAPTER_PRODUCT))
        .filter(d => isController(d) || /^nintendo wii remote$/i.test(d.name))
        .sort((a, b) => (a.js ?? 1e6 + a.event) - (b.js ?? 1e6 + b.event));

    // The same name can appear twice (two identical pads); emulators tell them apart by this count
    const seen = new Map();
    const sdlOrder = found.filter(d => d.js !== null);
    const controllers = found.map((d, i) => {
        const kind = classify(d);
        const nth = seen.get(d.name) || 0;
        seen.set(d.name, nth + 1);
        return {
            id: d.js !== null ? `js${d.js}` : `event${d.event}`,
            name: d.name,
            kind,
            label: KIND_LABELS[kind],
            connection: d.bus === '0005' ? 'Bluetooth' : d.bus === '0003' ? 'USB' : 'Wired',
            vendor: d.vendor,
            product: d.product,
            bus: d.bus,
            version: d.version,
            js: d.js,
            sdlIndex: d.js !== null ? sdlOrder.indexOf(d) : null,
            nameIndex: nth,
            pad: PAD_KINDS.has(kind),
            player: i + 1
        };
    });

    if (adapter) {
        controllers.push({
            id: 'gc-adapter',
            name: 'Nintendo GameCube Controller Adapter',
            kind: 'gamecube',
            label: KIND_LABELS.gamecube,
            connection: 'USB',
            vendor: NINTENDO,
            product: GC_ADAPTER_PRODUCT,
            js: null,
            sdlIndex: null,
            nameIndex: 0,
            pad: false,
            adapter: true,
            player: controllers.length + 1
        });
    }
    return controllers;
}

// ---------- Windows ----------
// Windows has no /proc to read, so the menu window reports the gamepads it can see (the browser's Gamepad API)
// and this turns that list into the same controller records. Chrome names them like
//   "Xbox 360 Controller (XInput STANDARD GAMEPAD)"  or  "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)"

// pads: [{index, id, mapping}] as reported by navigator.getGamepads()
function fromGamepadApi(pads) {
    const usable = (pads || []).filter(p => p && typeof p.id === 'string')
        .map(p => {
            const ids = p.id.match(/Vendor:\s*([0-9a-f]{4})\s+Product:\s*([0-9a-f]{4})/i);
            const name = p.id.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '').trim() || p.id;
            return { index: p.index, name, vendor: ids ? ids[1].toLowerCase() : '', product: ids ? ids[2].toLowerCase() : '', xinput: /xinput/i.test(p.id), js: null };
        })
        .filter(p => !NOT_A_PAD.test(p.name))
        .sort((a, b) => a.index - b.index);

    const seen = new Map();
    let xinputs = 0, order = 0;
    return usable.map((p, i) => {
        const kind = p.xinput ? 'xbox' : classify(p);
        const nth = seen.get(p.name) || 0;
        seen.set(p.name, nth + 1);
        const isPad = PAD_KINDS.has(kind);
        return {
            id: `pad${p.index}`,
            name: p.name,
            kind,
            label: KIND_LABELS[kind],
            connection: 'Connected',
            vendor: p.vendor,
            product: p.product,
            js: null,
            sdlIndex: isPad ? order++ : null,
            nameIndex: nth,
            xinputIndex: p.xinput ? xinputs++ : null,     // Dolphin reaches Xbox pads through XInput on Windows
            pad: isPad,
            player: i + 1
        };
    });
}

// The list last reported by the window. It is only trusted for a short while: if the window stops reporting
// (closed, or minimised while a game runs) the controllers are treated as unknown rather than stale.
let reported = { at: 0, pads: [] };
const REPORT_TTL_MS = 60 * 1000;

function report(pads, now = Date.now()) {
    reported = { at: now, pads: Array.isArray(pads) ? pads.slice(0, 16) : [] };
}

// merge: {merges, splits, auto} as kept in config.json (see combine), applied to whatever was found
// hideNintendo: leave out the real Switch controllers (BetterJoy's virtual Xbox pads stand in for them)
function detect({ platform = process.platform, procFile = '/proc/bus/input/devices', usbRoot, now = Date.now(), merge, hideNintendo = false } = {}) {
    let found;
    if (platform === 'win32') found = now - reported.at < REPORT_TTL_MS ? fromGamepadApi(reported.pads) : [];
    else {
        let text = '';
        try { text = fs.readFileSync(procFile, 'utf8'); } catch { /* no input subsystem */ }
        found = build(parseProc(text), readUsbIds(usbRoot));
    }
    if (hideNintendo) found = found.filter(c => !(c.kind === 'switch' && c.vendor === NINTENDO));
    return merge ? combine(found, merge) : found;
}

// ---------- Two Switch controllers as one ----------
// Windows (and Bluetooth in general) shows a pair of Joy-Cons as two separate controllers. A pair can be combined so that
// the menu, the players and the emulators treat the two as one gamepad. Dolphin does the actual joining (it has SDL put the
// two halves together, which then shows up as one "Nintendo Switch Joy-Con (L/R)" device); Ryujinx can only read one
// device per player (see lib/inputconfig.js).

const JOYCON_PAIR_SDL_NAME = 'Nintendo Switch Joy-Con (L/R)';

// A controller's lasting identity (its js/event number changes between plugs)
const keyOf = c => (c.combined ? `pad:combo:${c.memberKeys.map(k => k.replace(/^pad:/, '')).join('+')}` : `pad:${c.vendor || ''}:${c.product || ''}:${c.name}#${c.nameIndex || 0}`);

// 'L' or 'R' for the two halves of a Joy-Con pair; null for anything else
function joyconSide(c) {
    if (c.combined || c.kind !== 'switch') return null;
    if (c.vendor === NINTENDO && c.product === '2006') return 'L';
    if (c.vendor === NINTENDO && c.product === '2007') return 'R';
    if (/\(l\)|left joy-?con/i.test(c.name)) return 'L';
    if (/\(r\)|right joy-?con/i.test(c.name)) return 'R';
    return null;
}

// Joins controllers into pairs. merges: [[keyA, keyB], ...] the person asked for; splits: [[keyA, keyB], ...] pairs they
// separated again; auto: join a left and a right Joy-Con (the first left with the first right, ...) without being asked.
function combine(list, { merges = [], splits = [], auto = true } = {}) {
    const byKey = new Map(list.map(c => [keyOf(c), c]));
    const used = new Set();
    const pairs = [];
    const sameSet = (a, b, x, y) => (a === x && b === y) || (a === y && b === x);
    const isSplit = (a, b) => splits.some(([x, y]) => sameSet(keyOf(a), keyOf(b), x, y));
    const add = (a, b) => { used.add(a); used.add(b); pairs.push([a, b]); };

    for (const [ka, kb] of merges) {
        const a = byKey.get(ka), b = byKey.get(kb);
        if (a && b && a !== b && a.pad && b.pad && !used.has(a) && !used.has(b)) add(a, b);
    }
    if (auto) {
        const left = list.filter(c => joyconSide(c) === 'L' && !used.has(c));
        for (const l of left) {
            const r = list.find(c => joyconSide(c) === 'R' && !used.has(c) && !isSplit(l, c));
            if (r) add(l, r);
        }
    }
    if (!pairs.length) return list;

    const out = [];
    let nth = 0;
    for (const c of list) {
        if (!used.has(c)) { out.push(c); continue; }
        const pair = pairs.find(([x, y]) => x === c || y === c);
        if (pair.some(m => list.indexOf(m) < list.indexOf(c))) continue;          // already placed where its partner was
        const [a, b] = pair;
        const joycons = joyconSide(a) && joyconSide(b) && joyconSide(a) !== joyconSide(b);
        const left = joyconSide(b) === 'L' ? b : a;
        out.push({
            id: `combo-${a.id}-${b.id}`,
            name: joycons ? 'Joy-Con pair' : `${a.name} + ${b.name}`,
            sdlName: joycons ? JOYCON_PAIR_SDL_NAME : null,
            kind: 'switch',
            label: 'Switch Controller (combined)',
            connection: a.connection === b.connection ? a.connection : 'Bluetooth',
            vendor: NINTENDO, product: joycons ? '2008' : left.product, bus: left.bus, version: left.version,
            js: left.js, sdlIndex: left.sdlIndex,
            nameIndex: nth++,
            xinputIndex: null,
            pad: true,
            combined: true,
            members: [a.id, b.id],
            memberKeys: [keyOf(a), keyOf(b)],
            memberNames: [a.name, b.name],
            player: Math.min(a.player, b.player)
        });
    }
    return out.map((c, i) => ({ ...c, player: i + 1 }));
}

module.exports = { parseProc, classify, build, detect, hasGcAdapter, fromGamepadApi, report, combine, keyOf, joyconSide, KIND_LABELS, PAD_KINDS, JOYCON_PAIR_SDL_NAME };
