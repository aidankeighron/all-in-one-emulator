// Controller mapping profiles: which button on the gamepad does what in the emulated controller.
//
// A profile is a small JSON file (built in, or yours in <config>/mappings/):
//   { id, name, description, target: 'wii' | 'gamecube', extension: 'nunchuk' | 'classic' | 'none',
//     settings: {'Options/Sideways Wiimote': 'True'}, entries: {'Buttons/A': 'Button A', ...} }
// `entries` keys are Dolphin's own control names and values are Dolphin's names for gamepad inputs (SDL names),
// so they are written to Dolphin's files unchanged. Everything here was checked against Dolphin's source
// (InputCommon/ControllerInterface/SDL and Core/HW/WiimoteEmu). One thing to know about those names: SDL's vertical
// stick axes are inverted, so pushing a stick UP is "Y+".
const fs = require('fs');
const path = require('path');

class MappingError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

// ---------- What can be mapped ----------

const dirs = (prefix, group, ext = null) => ['Up', 'Down', 'Left', 'Right'].map(d => ({ key: `${prefix}/${d}`, label: d, group, ext }));
const c = (key, label, group, ext = null) => ({ key, label, group, ext });

const WII_CONTROLS = [
    ...['A', 'B', '1', '2', '-', '+', 'Home'].map(b => c(`Buttons/${b}`, b === 'Home' ? 'Home' : b, 'Wii Remote buttons')),
    ...dirs('D-Pad', 'Wii Remote D-pad'),
    ...dirs('IR', 'Pointer (stick)'),
    c('IR/Recenter', 'Recenter', 'Pointer (stick)'), c('IR/Hide', 'Hide', 'Pointer (stick)'),
    ...['X', 'Y', 'Z'].map(a => c(`Shake/${a}`, `Shake ${a}`, 'Shake')),
    ...['Forward', 'Backward', 'Left', 'Right', 'Modifier'].map(d => c(`Tilt/${d}`, d, 'Tilt')),
    ...['Up', 'Down', 'Left', 'Right', 'Forward', 'Backward'].map(d => c(`Swing/${d}`, d, 'Swing')),
    ...['Up', 'Down', 'Left', 'Right', 'Forward', 'Backward'].map(d => c(`IMUAccelerometer/${d}`, d, 'Motion: accelerometer')),
    ...['Pitch Up', 'Pitch Down', 'Roll Left', 'Roll Right', 'Yaw Left', 'Yaw Right'].map(d => c(`IMUGyroscope/${d}`, d, 'Motion: gyroscope')),
    c('IMUIR/Recenter', 'Recenter', 'Motion: gyro pointer'),
    c('Nunchuk/Buttons/C', 'C', 'Nunchuk', 'nunchuk'), c('Nunchuk/Buttons/Z', 'Z', 'Nunchuk', 'nunchuk'),
    ...dirs('Nunchuk/Stick', 'Nunchuk stick', 'nunchuk'),
    ...['X', 'Y', 'Z'].map(a => c(`Nunchuk/Shake/${a}`, `Shake ${a}`, 'Nunchuk shake', 'nunchuk')),
    ...['A', 'B', 'X', 'Y', 'ZL', 'ZR', '-', '+', 'Home'].map(b => c(`Classic/Buttons/${b}`, b, 'Classic Controller buttons', 'classic')),
    ...dirs('Classic/Left Stick', 'Classic left stick', 'classic'),
    ...dirs('Classic/Right Stick', 'Classic right stick', 'classic'),
    ...['L', 'R', 'L-Analog', 'R-Analog'].map(t => c(`Classic/Triggers/${t}`, t, 'Classic triggers', 'classic')),
    ...dirs('Classic/D-Pad', 'Classic D-pad', 'classic')
];

const GC_CONTROLS = [
    ...['A', 'B', 'X', 'Y', 'Z', 'Start'].map(b => c(`Buttons/${b}`, b, 'Buttons')),
    ...dirs('Main Stick', 'Main stick'),
    ...dirs('C-Stick', 'C-stick'),
    ...['L', 'R', 'L-Analog', 'R-Analog'].map(t => c(`Triggers/${t}`, t, 'Triggers')),
    ...dirs('D-Pad', 'D-pad')
];

const CONTROLS = { wii: WII_CONTROLS, gamecube: GC_CONTROLS };

// Settings a profile may switch (value 'True' or 'False')
const SETTINGS = { wii: ['Options/Sideways Wiimote', 'Options/Upright Wiimote'], gamecube: [] };

const EXTENSIONS = ['nunchuk', 'classic', 'none'];
const DOLPHIN_EXTENSION = { nunchuk: 'Nunchuk', classic: 'Classic', none: 'None' };

// ---------- What the gamepad offers ----------

const SOURCES = [
    { value: 'Button A', label: 'A (bottom button)', group: 'Buttons' },
    { value: 'Button B', label: 'B (right button)', group: 'Buttons' },
    { value: 'Button X', label: 'X (left button)', group: 'Buttons' },
    { value: 'Button Y', label: 'Y (top button)', group: 'Buttons' },
    { value: 'Shoulder L', label: 'Left bumper', group: 'Buttons' },
    { value: 'Shoulder R', label: 'Right bumper', group: 'Buttons' },
    { value: 'Trigger L', label: 'Left trigger', group: 'Buttons' },
    { value: 'Trigger R', label: 'Right trigger', group: 'Buttons' },
    { value: 'Start', label: 'Start / Menu', group: 'Buttons' },
    { value: 'Back', label: 'Back / View', group: 'Buttons' },
    { value: 'Guide', label: 'Home / Guide', group: 'Buttons' },
    { value: 'Thumb L', label: 'Left stick click', group: 'Buttons' },
    { value: 'Thumb R', label: 'Right stick click', group: 'Buttons' },
    { value: 'Pad N', label: 'D-pad up', group: 'D-pad' },
    { value: 'Pad S', label: 'D-pad down', group: 'D-pad' },
    { value: 'Pad W', label: 'D-pad left', group: 'D-pad' },
    { value: 'Pad E', label: 'D-pad right', group: 'D-pad' },
    ...[['Left', 'Left'], ['Right', 'Right']].flatMap(([side, label]) => [
        { value: `${side} Y+`, label: `${label} stick up`, group: `${label} stick` },
        { value: `${side} Y-`, label: `${label} stick down`, group: `${label} stick` },
        { value: `${side} X-`, label: `${label} stick left`, group: `${label} stick` },
        { value: `${side} X+`, label: `${label} stick right`, group: `${label} stick` }
    ]),
    ...['Up', 'Down', 'Left', 'Right', 'Forward', 'Backward'].map(d => ({ value: `Accel ${d}`, label: `Tilt/move ${d.toLowerCase()} (needs a motion controller)`, group: 'Motion sensors' })),
    ...['Pitch Up', 'Pitch Down', 'Roll Left', 'Roll Right', 'Yaw Left', 'Yaw Right'].map(d => ({ value: `Gyro ${d}`, label: `Turn: ${d.toLowerCase()} (needs a motion controller)`, group: 'Motion sensors' }))
];
const SOURCE_VALUES = new Set(SOURCES.map(s => s.value));
const sourceLabel = value => (SOURCES.find(s => s.value === value) || {}).label || value;

// A value is "" (not mapped), one source, or several joined with " | " (any of them)
function validSource(value) {
    if (value === '') return true;
    if (typeof value !== 'string') return false;
    return value.split(' | ').every(part => SOURCE_VALUES.has(part));
}

// ---------- Built-in profiles ----------

const stickDirs = (prefix, side) => ({ [`${prefix}/Up`]: `${side} Y+`, [`${prefix}/Down`]: `${side} Y-`, [`${prefix}/Left`]: `${side} X-`, [`${prefix}/Right`]: `${side} X+` });
const dpadPad = prefix => ({ [`${prefix}/Up`]: 'Pad N', [`${prefix}/Down`]: 'Pad S', [`${prefix}/Left`]: 'Pad W', [`${prefix}/Right`]: 'Pad E' });

const NUNCHUK_PART = {
    'Nunchuk/Buttons/C': 'Shoulder L', 'Nunchuk/Buttons/Z': 'Trigger L',
    ...stickDirs('Nunchuk/Stick', 'Left'),
    'Nunchuk/Shake/X': 'Thumb L', 'Nunchuk/Shake/Y': 'Thumb L', 'Nunchuk/Shake/Z': 'Thumb L'
};

const BUILTIN = [
    {
        id: 'wii-nunchuk', target: 'wii', extension: 'nunchuk', name: 'Wii Remote + Nunchuk',
        description: 'Right stick points at the screen, left stick is the Nunchuk stick. Click a stick to shake.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Trigger R', 'Buttons/1': 'Button X', 'Buttons/2': 'Button Y',
            'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            ...stickDirs('IR', 'Right'),
            'Shake/X': 'Thumb R', 'Shake/Y': 'Thumb R', 'Shake/Z': 'Thumb R',
            ...dpadPad('D-Pad'), ...NUNCHUK_PART
        }
    },
    {
        id: 'wii-pointer', target: 'wii', extension: 'none', name: 'Wii Remote only (no Nunchuk)',
        description: 'For games that use just the Wii Remote: left stick is the D-pad, right stick points.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Trigger R', 'Buttons/1': 'Button X', 'Buttons/2': 'Button Y',
            'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            ...stickDirs('IR', 'Right'),
            'Shake/X': 'Thumb R', 'Shake/Y': 'Thumb R', 'Shake/Z': 'Thumb R',
            'D-Pad/Up': 'Pad N | Left Y+', 'D-Pad/Down': 'Pad S | Left Y-', 'D-Pad/Left': 'Pad W | Left X-', 'D-Pad/Right': 'Pad E | Left X+'
        }
    },
    {
        id: 'wii-sideways', target: 'wii', extension: 'none', name: 'Wii Remote sideways',
        description: 'For games played with the remote held sideways (like a NES pad). The D-pad is turned to match: up is the remote’s right.',
        settings: { 'Options/Sideways Wiimote': 'True' },
        entries: {
            'Buttons/2': 'Button A', 'Buttons/1': 'Button X', 'Buttons/A': 'Button B', 'Buttons/B': 'Trigger R',
            'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            'D-Pad/Right': 'Pad N | Left Y+', 'D-Pad/Left': 'Pad S | Left Y-', 'D-Pad/Up': 'Pad W | Left X-', 'D-Pad/Down': 'Pad E | Left X+',
            'Shake/X': 'Thumb R', 'Shake/Y': 'Thumb R', 'Shake/Z': 'Thumb R'
        }
    },
    {
        id: 'wii-wheel', target: 'wii', extension: 'none', name: 'Wii wheel (steer by tilting)',
        description: 'Sideways remote, steering is the left stick (it tilts the remote). 2 is the right trigger.',
        settings: { 'Options/Sideways Wiimote': 'True' },
        entries: {
            'Buttons/2': 'Trigger R', 'Buttons/1': 'Trigger L', 'Buttons/A': 'Button A', 'Buttons/B': 'Button B',
            'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            'Tilt/Left': 'Left X-', 'Tilt/Right': 'Left X+',
            ...dpadPad('D-Pad'),
            'Shake/X': 'Thumb R', 'Shake/Y': 'Thumb R', 'Shake/Z': 'Thumb R'
        }
    },
    {
        id: 'wii-gyro', target: 'wii', extension: 'nunchuk', name: 'Wii Remote + Nunchuk, gyro pointer',
        description: 'Point and swing by moving a Switch Pro Controller or Joy-Con (they have motion sensors; Xbox pads do not). Y recenters. Not tested on real controllers.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Trigger R', 'Buttons/1': 'Button X', 'Buttons/2': 'Shoulder R',
            'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            'IMUIR/Recenter': 'Button Y',
            ...Object.fromEntries(['Up', 'Down', 'Left', 'Right', 'Forward', 'Backward'].map(d => [`IMUAccelerometer/${d}`, `Accel ${d}`])),
            ...Object.fromEntries(['Pitch Up', 'Pitch Down', 'Roll Left', 'Roll Right', 'Yaw Left', 'Yaw Right'].map(d => [`IMUGyroscope/${d}`, `Gyro ${d}`])),
            ...dpadPad('D-Pad'), ...NUNCHUK_PART
        }
    },
    {
        id: 'wii-classic', target: 'wii', extension: 'classic', name: 'Classic Controller',
        description: 'The Wii Classic Controller: bumpers are L and R, triggers are ZL and ZR.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Button B', 'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            'Classic/Buttons/A': 'Button B', 'Classic/Buttons/B': 'Button A', 'Classic/Buttons/X': 'Button Y', 'Classic/Buttons/Y': 'Button X',
            'Classic/Buttons/ZL': 'Trigger L', 'Classic/Buttons/ZR': 'Trigger R',
            'Classic/Buttons/-': 'Back', 'Classic/Buttons/+': 'Start', 'Classic/Buttons/Home': 'Guide',
            ...stickDirs('Classic/Left Stick', 'Left'), ...stickDirs('Classic/Right Stick', 'Right'),
            'Classic/Triggers/L': 'Shoulder L', 'Classic/Triggers/R': 'Shoulder R',
            'Classic/Triggers/L-Analog': 'Trigger L', 'Classic/Triggers/R-Analog': 'Trigger R',
            ...dpadPad('Classic/D-Pad')
        }
    },
    {
        id: 'gc-default', target: 'gamecube', extension: 'none', name: 'GameCube controller',
        description: 'The usual layout: left stick moves, right stick is the C-stick, triggers are L and R, right bumper is Z.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Button X', 'Buttons/X': 'Button B', 'Buttons/Y': 'Button Y',
            'Buttons/Z': 'Shoulder R', 'Buttons/Start': 'Start',
            ...stickDirs('Main Stick', 'Left'), ...stickDirs('C-Stick', 'Right'),
            'Triggers/L': 'Trigger L', 'Triggers/R': 'Trigger R', 'Triggers/L-Analog': 'Trigger L', 'Triggers/R-Analog': 'Trigger R',
            ...dpadPad('D-Pad')
        }
    },
    {
        id: 'gc-nintendo', target: 'gamecube', extension: 'none', name: 'GameCube, Nintendo button positions',
        description: 'For Switch Pro Controller and Joy-Con: the buttons labelled A, B, X, Y act as A, B, X, Y.',
        entries: {
            'Buttons/A': 'Button B', 'Buttons/B': 'Button A', 'Buttons/X': 'Button Y', 'Buttons/Y': 'Button X',
            'Buttons/Z': 'Shoulder R', 'Buttons/Start': 'Start',
            ...stickDirs('Main Stick', 'Left'), ...stickDirs('C-Stick', 'Right'),
            'Triggers/L': 'Trigger L', 'Triggers/R': 'Trigger R', 'Triggers/L-Analog': 'Trigger L', 'Triggers/R-Analog': 'Trigger R',
            ...dpadPad('D-Pad')
        }
    }
];

const DEFAULT_PROFILE = { wii: 'wii-nunchuk', gamecube: 'gc-default' };

// ---------- Validation ----------

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'mapping';
}

// Checks a profile coming from a file or from the UI and returns a clean copy
function normalize(input, { builtin = false } = {}) {
    if (!input || typeof input !== 'object') throw new MappingError('BAD_PROFILE', 'That is not a mapping');
    const target = input.target;
    if (!CONTROLS[target]) throw new MappingError('BAD_PROFILE', 'A mapping is for the Wii or the GameCube');
    const name = String(input.name || '').trim().slice(0, 40);
    if (!name) throw new MappingError('BAD_PROFILE', 'Give the mapping a name');
    if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) throw new MappingError('BAD_PROFILE', 'Bad mapping id');
    const extension = target === 'wii' ? (input.extension || 'none') : 'none';
    if (!EXTENSIONS.includes(extension)) throw new MappingError('BAD_PROFILE', 'Unknown extension');

    const known = new Set(CONTROLS[target].map(x => x.key));
    const entries = {};
    for (const [key, value] of Object.entries(input.entries || {})) {
        if (!known.has(key)) throw new MappingError('BAD_PROFILE', `Unknown control “${key}”`);
        if (!validSource(value)) throw new MappingError('BAD_PROFILE', `“${value}” is not an input a gamepad has`);
        if (value !== '') entries[key] = value;
    }
    const settings = {};
    for (const [key, value] of Object.entries(input.settings || {})) {
        if (!SETTINGS[target].includes(key) || !['True', 'False'].includes(value)) throw new MappingError('BAD_PROFILE', `Unknown setting “${key}”`);
        settings[key] = value;
    }
    return { id: input.id, name, description: String(input.description || '').slice(0, 200), target, extension, settings, entries, builtin };
}

// ---------- Your own profiles ----------

function createStore(dir) {
    const fileFor = id => path.join(dir, `${id}.json`);
    const builtins = BUILTIN.map(p => normalize(p, { builtin: true }));
    const byId = new Map(builtins.map(p => [p.id, p]));

    function readCustom() {
        let names = [];
        try { names = fs.readdirSync(dir); } catch { return []; }
        const out = [];
        for (const file of names.filter(n => n.endsWith('.json'))) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                const id = path.basename(file, '.json');
                if (byId.has(id)) continue;                          // a built-in id cannot be shadowed
                out.push(normalize({ ...data, id }));
            } catch { /* a file that is not a valid mapping is ignored */ }
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
        list: () => [...builtins, ...readCustom()],
        get(id) {
            if (byId.has(id)) return byId.get(id);
            if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
            try { return normalize({ ...JSON.parse(fs.readFileSync(fileFor(id), 'utf8')), id }); } catch { return null; }
        },
        // Saves your own mapping. Without an id a new one is made from the name.
        save(input) {
            let id = input.id;
            if (id && byId.has(id)) throw new MappingError('READ_ONLY', 'The built-in mappings cannot be changed. Duplicate one first.');
            if (!id) {
                const base = slug(input.name);
                id = base;
                for (let n = 2; byId.has(id) || fs.existsSync(fileFor(id)); n++) id = `${base}-${n}`;
            }
            const clean = normalize({ ...input, id });
            fs.mkdirSync(dir, { recursive: true });
            const { builtin, id: _id, ...data } = clean;
            fs.writeFileSync(fileFor(id), JSON.stringify(data, null, 2));
            return clean;
        },
        duplicate(id, name) {
            const src = this.get(id);
            if (!src) throw new MappingError('NOT_FOUND', 'No such mapping');
            return this.save({ ...src, id: undefined, name: name || `Copy of ${src.name}` });
        },
        remove(id) {
            if (byId.has(id)) throw new MappingError('READ_ONLY', 'The built-in mappings cannot be deleted');
            if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new MappingError('NOT_FOUND', 'No such mapping');
            fs.rmSync(fileFor(id), { force: true });
        },
        dir
    };
}

// ---------- Writing to Dolphin ----------

// Dolphin writes names that contain spaces or symbols between backticks
const q = name => (/^\w+$/.test(name) ? name : `\`${name}\``);
const expression = value => value.split(' | ').map(q).join(' | ');

// The lines of a [Wiimote N] or [GCPadN] section for this profile and gamepad (device: Dolphin's device name)
function dolphinSection(profile, device) {
    const out = [];
    if (profile.target === 'wii') out.push(['Source', '1']);
    out.push(['Device', device]);
    if (profile.target === 'wii') out.push(['Extension', DOLPHIN_EXTENSION[profile.extension]]);
    for (const [key, value] of Object.entries(profile.settings)) out.push([key, value]);
    const controls = CONTROLS[profile.target];
    for (const ctl of controls) {
        if (ctl.ext && ctl.ext !== profile.extension) continue;
        const value = profile.entries[ctl.key];
        if (value) out.push([ctl.key, expression(value)]);
    }
    return out;
}

module.exports = {
    MappingError, CONTROLS, SETTINGS, SOURCES, EXTENSIONS, DEFAULT_PROFILE, BUILTIN,
    createStore, normalize, validSource, sourceLabel, dolphinSection, slug
};
