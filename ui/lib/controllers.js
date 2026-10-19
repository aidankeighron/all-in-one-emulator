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
    playstation: 'PlayStation Controller',
    generic: 'Game Controller'
};

// Kinds that look like a normal gamepad to SDL, so the emulators can all map them the same way
const PAD_KINDS = new Set(['xbox', 'switch', 'playstation', 'generic']);

// Input devices that sit next to a gamepad but are not one (the Wii Remote exposes several)
const NOT_A_PAD = /keyboard|mouse|touchpad|trackpad|consumer control|system control|power button|sleep button|video bus|lid switch|hdmi|speaker|headphone|headset|webcam|camera|\bir\b|accelerometer|motion ?plus|motion sensors|gyro|imu|nunchuk|classic controller|balance board|touchscreen|pen\b|stylus/i;

// Parses the text of /proc/bus/input/devices into [{name, vendor, product, bus, handlers, js, event}]
function parseProc(text) {
    const devices = [];
    for (const block of String(text || '').split(/\n\s*\n/)) {
        const id = block.match(/^I: Bus=(\w+) Vendor=(\w+) Product=(\w+)/m);
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
    if (vendor === '054c' || /dualshock|dualsense|playstation|wireless controller/i.test(name)) return 'playstation';
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
    const found = procDevices
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

function detect({ procFile = '/proc/bus/input/devices', usbRoot } = {}) {
    let text = '';
    try { text = fs.readFileSync(procFile, 'utf8'); } catch { /* not Linux, or no input subsystem */ }
    return build(parseProc(text), readUsbIds(usbRoot));
}

module.exports = { parseProc, classify, build, detect, hasGcAdapter, KIND_LABELS, PAD_KINDS };
