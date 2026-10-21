// Controller mapping profiles: which button on the gamepad does what in the emulated controller.
//
// A profile is a small JSON file (built in, or yours in <config>/mappings/):
//   { id, name, description, target: 'wii' | 'gamecube' | 'switch', family: 'generic' | 'nintendo' | 'wiimote',
//     extension: 'nunchuk' | 'classic' | 'none', settings: {'Options/Sideways Wiimote': 'True'},
//     entries: {'Buttons/A': 'Button A', ...} }
// `family` is the kind of physical controller the mapping is made for: 'generic' (Xbox-style pads and anything else
// that is not Nintendo's), 'nintendo' (Switch Pro Controller, Joy-Con, a Joy-Con pair; the only ones with motion
// sensors) or 'wiimote' (a real Wii Remote, which Dolphin talks to itself, so it has nothing to map).
// For Dolphin, `entries` keys are Dolphin's own control names and values are Dolphin's names for gamepad inputs
// (SDL names), so they are written to Dolphin's files unchanged. For the Switch, the keys are the Switch's buttons and
// the same SDL names are translated to what Ryujinx calls them. Everything here was checked against Dolphin's source
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

// The Switch's own buttons. Ryujinx has no per-direction stick mapping (a stick is either the left or the right one),
// so the sticks are settings below and only buttons are mapped here.
const SWITCH_CONTROLS = [
    ...['A', 'B', 'X', 'Y'].map(b => c(`Buttons/${b}`, b, 'Face buttons')),
    ...['L', 'ZL', 'R', 'ZR'].map(b => c(`Buttons/${b}`, b, 'Shoulder buttons')),
    c('Buttons/Plus', '+ (Plus)', 'Menu buttons'), c('Buttons/Minus', '− (Minus)', 'Menu buttons'),
    c('Buttons/Left Stick Click', 'Left stick click', 'Stick clicks'), c('Buttons/Right Stick Click', 'Right stick click', 'Stick clicks'),
    ...dirs('D-Pad', 'D-pad')
];

const CONTROLS = { wii: WII_CONTROLS, gamecube: GC_CONTROLS, switch: SWITCH_CONTROLS };

const TARGETS = { wii: 'Wii', gamecube: 'GameCube', switch: 'Switch' };

// What kind of physical controller a mapping is for (see the top of this file)
const FAMILIES = {
    generic: 'Xbox / generic controller',
    nintendo: 'Nintendo controller (Switch Pro, Joy-Con)',
    wiimote: 'Official Wii Remote'
};
// Which family of mapping suits a detected controller (a combined pair is a Nintendo one)
const FAMILY_FOR_KIND = { xbox: 'generic', generic: 'generic', switch: 'nintendo', gamecube: 'generic', wiimote: 'wiimote' };
const familyOf = controller => (controller && controller.combined) ? 'nintendo' : (FAMILY_FOR_KIND[controller && controller.kind] || 'generic');

// Settings a profile may switch. `values` are [value, label]; the first is the default.
const SETTING_DEFS = {
    wii: [
        { key: 'Options/Sideways Wiimote', label: 'Hold the remote sideways', values: [['False', 'No'], ['True', 'Yes']] },
        { key: 'Options/Upright Wiimote', label: 'Hold the remote upright', values: [['False', 'No'], ['True', 'Yes']] }
    ],
    gamecube: [],
    switch: [
        { key: 'Sticks/Left', label: 'Left stick of the Switch uses', values: [['Left', 'The left stick'], ['Right', 'The right stick']] },
        { key: 'Sticks/Right', label: 'Right stick of the Switch uses', values: [['Right', 'The right stick'], ['Left', 'The left stick']] },
        { key: 'Motion/Enabled', label: 'Motion controls (gyro)', values: [['True', 'On'], ['False', 'Off']] }
    ]
};
const SETTINGS = Object.fromEntries(Object.entries(SETTING_DEFS).map(([t, defs]) => [t, defs.map(d => d.key)]));
const settingValue = (target, settings, key) => {
    const def = SETTING_DEFS[target].find(d => d.key === key);
    return def ? ((settings || {})[key] ?? def.values[0][0]) : undefined;
};

const EXTENSIONS = ['nunchuk', 'classic', 'none'];
const DOLPHIN_EXTENSION = { nunchuk: 'Nunchuk', classic: 'Classic', none: 'None' };

// ---------- What the gamepad offers ----------

// `nl` is how the same input is named on a Nintendo controller. Dolphin and Ryujinx name the face buttons by position
// (A is the bottom one), so a Switch controller's "A" button, which is on the right, is "Button B" to them.
const SOURCES = [
    { value: 'Button A', label: 'A (bottom button)', nl: 'B (bottom button)', group: 'Buttons' },
    { value: 'Button B', label: 'B (right button)', nl: 'A (right button)', group: 'Buttons' },
    { value: 'Button X', label: 'X (left button)', nl: 'Y (left button)', group: 'Buttons' },
    { value: 'Button Y', label: 'Y (top button)', nl: 'X (top button)', group: 'Buttons' },
    { value: 'Shoulder L', label: 'Left bumper', nl: 'L', group: 'Buttons' },
    { value: 'Shoulder R', label: 'Right bumper', nl: 'R', group: 'Buttons' },
    { value: 'Trigger L', label: 'Left trigger', nl: 'ZL', group: 'Buttons' },
    { value: 'Trigger R', label: 'Right trigger', nl: 'ZR', group: 'Buttons' },
    { value: 'Start', label: 'Start / Menu', nl: '+ (Plus)', group: 'Buttons' },
    { value: 'Back', label: 'Back / View', nl: '− (Minus)', group: 'Buttons' },
    { value: 'Guide', label: 'Home / Guide', nl: 'Home', group: 'Buttons' },
    { value: 'Misc 1', label: null, nl: 'Capture', group: 'Buttons' },       // only Nintendo pads have this one
    { value: 'Thumb L', label: 'Left stick click', nl: 'Left stick click', group: 'Buttons' },
    { value: 'Thumb R', label: 'Right stick click', nl: 'Right stick click', group: 'Buttons' },
    { value: 'Pad N', label: 'D-pad up', nl: 'D-pad up', group: 'D-pad' },
    { value: 'Pad S', label: 'D-pad down', nl: 'D-pad down', group: 'D-pad' },
    { value: 'Pad W', label: 'D-pad left', nl: 'D-pad left', group: 'D-pad' },
    { value: 'Pad E', label: 'D-pad right', nl: 'D-pad right', group: 'D-pad' },
    ...[['Left', 'Left'], ['Right', 'Right']].flatMap(([side, label]) => [
        { value: `${side} Y+`, label: `${label} stick up`, nl: `${label} stick up`, group: `${label} stick`, stick: true },
        { value: `${side} Y-`, label: `${label} stick down`, nl: `${label} stick down`, group: `${label} stick`, stick: true },
        { value: `${side} X-`, label: `${label} stick left`, nl: `${label} stick left`, group: `${label} stick`, stick: true },
        { value: `${side} X+`, label: `${label} stick right`, nl: `${label} stick right`, group: `${label} stick`, stick: true }
    ]),
    ...['Up', 'Down', 'Left', 'Right', 'Forward', 'Backward'].map(d => ({ value: `Accel ${d}`, label: null, nl: `Move ${d.toLowerCase()} (motion sensor)`, group: 'Motion sensors', motion: true })),
    ...['Pitch Up', 'Pitch Down', 'Roll Left', 'Roll Right', 'Yaw Left', 'Yaw Right'].map(d => ({ value: `Gyro ${d}`, label: null, nl: `Turn: ${d.toLowerCase()} (motion sensor)`, group: 'Motion sensors', motion: true }))
];
const SOURCE_VALUES = new Set(SOURCES.map(s => s.value));
const MOTION_VALUES = new Set(SOURCES.filter(s => s.motion).map(s => s.value));

// What the Switch side can read: single buttons, which Ryujinx calls by these names
const RYUJINX_INPUT = {
    'Button A': 'A', 'Button B': 'B', 'Button X': 'X', 'Button Y': 'Y',
    'Shoulder L': 'LeftShoulder', 'Shoulder R': 'RightShoulder', 'Trigger L': 'LeftTrigger', 'Trigger R': 'RightTrigger',
    'Start': 'Start', 'Back': 'Back', 'Guide': 'Guide', 'Misc 1': 'Misc1', 'Thumb L': 'LeftStick', 'Thumb R': 'RightStick',
    'Pad N': 'DpadUp', 'Pad S': 'DpadDown', 'Pad W': 'DpadLeft', 'Pad E': 'DpadRight'
};

// The inputs offered to a mapping for this kind of controller and emulated console, named the way that controller's
// own buttons are labelled. A Nintendo pad has motion sensors and a Capture button; an Xbox-style pad has neither.
function sourcesFor(family = 'generic', target = 'gamecube') {
    const nintendo = family === 'nintendo';
    return SOURCES
        .filter(s => (nintendo || (!s.motion && s.label !== null)) && (target !== 'switch' || RYUJINX_INPUT[s.value]))
        .map(s => ({ value: s.value, label: nintendo ? s.nl : s.label, group: s.group }));
}

const sourceLabel = (value, family = 'generic') => {
    const hit = SOURCES.find(s => s.value === value);
    return hit ? ((family === 'nintendo' ? hit.nl : hit.label) || hit.nl || hit.value) : value;
};

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
    ...stickDirs('Nunchuk/Stick', 'Left')
};

const motionEntries = () => ({
    ...Object.fromEntries(['Up', 'Down', 'Left', 'Right', 'Forward', 'Backward'].map(d => [`IMUAccelerometer/${d}`, `Accel ${d}`])),
    ...Object.fromEntries(['Pitch Up', 'Pitch Down', 'Roll Left', 'Roll Right', 'Yaw Left', 'Yaw Right'].map(d => [`IMUGyroscope/${d}`, `Gyro ${d}`]))
});

// Pointers and motion (aiming, shaking, tilting) are not part of the built-in mappings except the gyro one: make those
// yourself in the editor, where every one of them is available.
const BUILTIN = [
    {
        id: 'wii-remote', target: 'wii', family: 'wiimote', extension: 'none', name: 'Official Wii Remote',
        description: 'A real Wii Remote is used as it is: Dolphin talks to it directly (press 1 + 2 when a game starts), so there is nothing to map.',
        entries: {}
    },
    {
        id: 'wii-classic', target: 'wii', family: 'generic', extension: 'classic', name: 'Wii Classic Controller (Xbox / generic)',
        description: 'The pad acts as a Wii Classic Controller, button for button: A is A, B is B, X is X, Y is Y. Bumpers are L and R, triggers are ZL and ZR.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Button B', 'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            'Classic/Buttons/A': 'Button A', 'Classic/Buttons/B': 'Button B', 'Classic/Buttons/X': 'Button X', 'Classic/Buttons/Y': 'Button Y',
            'Classic/Buttons/ZL': 'Trigger L', 'Classic/Buttons/ZR': 'Trigger R',
            'Classic/Buttons/-': 'Back', 'Classic/Buttons/+': 'Start', 'Classic/Buttons/Home': 'Guide',
            ...stickDirs('Classic/Left Stick', 'Left'), ...stickDirs('Classic/Right Stick', 'Right'),
            'Classic/Triggers/L': 'Shoulder L', 'Classic/Triggers/R': 'Shoulder R',
            'Classic/Triggers/L-Analog': 'Trigger L', 'Classic/Triggers/R-Analog': 'Trigger R',
            ...dpadPad('Classic/D-Pad')
        }
    },
    {
        id: 'wii-classic-nintendo', target: 'wii', family: 'nintendo', extension: 'classic', name: 'Wii Classic Controller (Nintendo)',
        description: 'For Switch Pro Controller and Joy-Con: the buttons labelled A, B, X, Y act as the Classic Controller’s A, B, X, Y. L and R are L and R, ZL and ZR are ZL and ZR.',
        entries: {
            'Buttons/A': 'Button B', 'Buttons/B': 'Button A', 'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
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
        id: 'wii-nunchuk', target: 'wii', family: 'generic', extension: 'nunchuk', name: 'Wii Remote + Nunchuk (Xbox / generic)',
        description: 'Buttons only, no pointer or motion: left stick is the Nunchuk stick, bumper and trigger on the left are C and Z. Add a pointer or shake yourself by making a copy.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Trigger R', 'Buttons/1': 'Button X', 'Buttons/2': 'Button Y',
            'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            ...dpadPad('D-Pad'), ...NUNCHUK_PART
        }
    },
    {
        id: 'wii-nunchuk-gyro', target: 'wii', family: 'nintendo', extension: 'nunchuk', name: 'Wii Remote + Nunchuk + gyro (Nintendo)',
        description: 'For Switch Pro Controller and Joy-Con: the buttons labelled A, B act as the remote’s A, B; the controller’s motion sensors drive the remote’s motion (swings and tilts). No pointer. Dolphin must be able to see the sensors, which it does for a Pro Controller or Joy-Con connected over Bluetooth.',
        entries: {
            'Buttons/A': 'Button B', 'Buttons/B': 'Trigger R', 'Buttons/1': 'Button X', 'Buttons/2': 'Button Y',
            'Buttons/-': 'Back', 'Buttons/+': 'Start', 'Buttons/Home': 'Guide',
            ...motionEntries(), ...dpadPad('D-Pad'), ...NUNCHUK_PART
        }
    },
    {
        id: 'gc-default', target: 'gamecube', family: 'generic', extension: 'none', name: 'GameCube (Xbox / generic)',
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
        id: 'gc-nintendo', target: 'gamecube', family: 'nintendo', extension: 'none', name: 'GameCube (Nintendo)',
        description: 'For Switch Pro Controller and Joy-Con: the buttons labelled A, B, X, Y act as A, B, X, Y.',
        entries: {
            'Buttons/A': 'Button B', 'Buttons/B': 'Button A', 'Buttons/X': 'Button Y', 'Buttons/Y': 'Button X',
            'Buttons/Z': 'Shoulder R', 'Buttons/Start': 'Start',
            ...stickDirs('Main Stick', 'Left'), ...stickDirs('C-Stick', 'Right'),
            'Triggers/L': 'Trigger L', 'Triggers/R': 'Trigger R', 'Triggers/L-Analog': 'Trigger L', 'Triggers/R-Analog': 'Trigger R',
            ...dpadPad('D-Pad')
        }
    },
    {
        id: 'switch-generic', target: 'switch', family: 'generic', extension: 'none', name: 'Switch (Xbox / generic)',
        description: 'The standard layout: A is A, B is B, X is X, Y is Y, bumpers are L and R, triggers are ZL and ZR, Menu is + and View is −.',
        entries: {
            'Buttons/A': 'Button A', 'Buttons/B': 'Button B', 'Buttons/X': 'Button X', 'Buttons/Y': 'Button Y',
            'Buttons/L': 'Shoulder L', 'Buttons/R': 'Shoulder R', 'Buttons/ZL': 'Trigger L', 'Buttons/ZR': 'Trigger R',
            'Buttons/Plus': 'Start', 'Buttons/Minus': 'Back',
            'Buttons/Left Stick Click': 'Thumb L', 'Buttons/Right Stick Click': 'Thumb R',
            ...dpadPad('D-Pad')
        }
    },
    {
        id: 'switch-nintendo', target: 'switch', family: 'nintendo', extension: 'none', name: 'Switch (Nintendo)',
        description: 'For Switch Pro Controller and Joy-Con: every button does what its label says. Motion controls are on.',
        entries: {
            'Buttons/A': 'Button B', 'Buttons/B': 'Button A', 'Buttons/X': 'Button Y', 'Buttons/Y': 'Button X',
            'Buttons/L': 'Shoulder L', 'Buttons/R': 'Shoulder R', 'Buttons/ZL': 'Trigger L', 'Buttons/ZR': 'Trigger R',
            'Buttons/Plus': 'Start', 'Buttons/Minus': 'Back',
            'Buttons/Left Stick Click': 'Thumb L', 'Buttons/Right Stick Click': 'Thumb R',
            ...dpadPad('D-Pad')
        }
    }
];

// The mapping a controller gets when its player has not chosen one
const DEFAULT_BY_FAMILY = {
    wii: { generic: 'wii-classic', nintendo: 'wii-nunchuk-gyro', wiimote: 'wii-remote' },
    gamecube: { generic: 'gc-default', nintendo: 'gc-nintendo', wiimote: 'gc-default' },
    switch: { generic: 'switch-generic', nintendo: 'switch-nintendo', wiimote: 'switch-generic' }
};
const defaultFor = (target, family) => (DEFAULT_BY_FAMILY[target] || {})[family] || (DEFAULT_BY_FAMILY[target] || {}).generic;
// The standard ones, for a player with no controller yet
const DEFAULT_PROFILE = { wii: DEFAULT_BY_FAMILY.wii.generic, gamecube: DEFAULT_BY_FAMILY.gamecube.generic, switch: DEFAULT_BY_FAMILY.switch.generic };

// ---------- Validation ----------

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'mapping';
}

// Checks a profile coming from a file or from the UI and returns a clean copy
function normalize(input, { builtin = false } = {}) {
    if (!input || typeof input !== 'object') throw new MappingError('BAD_PROFILE', 'That is not a mapping');
    const target = input.target;
    if (!CONTROLS[target]) throw new MappingError('BAD_PROFILE', 'A mapping is for the Wii, the GameCube or the Switch');
    const name = String(input.name || '').trim().slice(0, 40);
    if (!name) throw new MappingError('BAD_PROFILE', 'Give the mapping a name');
    if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) throw new MappingError('BAD_PROFILE', 'Bad mapping id');
    const extension = target === 'wii' ? (input.extension || 'none') : 'none';
    if (!EXTENSIONS.includes(extension)) throw new MappingError('BAD_PROFILE', 'Unknown extension');

    // Mappings saved before there were kinds of controller: any that uses motion sensors was for a Nintendo pad
    const usesMotion = Object.values(input.entries || {}).some(v => typeof v === 'string' && v.split(' | ').some(p => MOTION_VALUES.has(p)));
    const family = input.family === undefined ? (usesMotion ? 'nintendo' : 'generic') : input.family;
    if (!FAMILIES[family]) throw new MappingError('BAD_PROFILE', 'Unknown kind of controller');
    if (family === 'wiimote' && target !== 'wii') throw new MappingError('BAD_PROFILE', 'Only the Wii has a real Wii Remote');
    if (family === 'wiimote' && !builtin) throw new MappingError('BAD_PROFILE', 'A real Wii Remote needs no mapping of its own');

    const known = new Set(CONTROLS[target].map(x => x.key));
    const entries = {};
    for (const [key, value] of Object.entries(input.entries || {})) {
        if (!known.has(key)) throw new MappingError('BAD_PROFILE', `Unknown control “${key}”`);
        if (!validSource(value)) throw new MappingError('BAD_PROFILE', `“${value}” is not an input a gamepad has`);
        if (value === '') continue;
        if (target === 'switch' && !RYUJINX_INPUT[value]) throw new MappingError('BAD_PROFILE', `“${sourceLabel(value, family)}” cannot be used for a Switch button`);
        if (family !== 'nintendo' && value.split(' | ').some(p => MOTION_VALUES.has(p))) throw new MappingError('BAD_PROFILE', 'Only a Nintendo controller has motion sensors');
        entries[key] = value;
    }
    const settings = {};
    for (const [key, value] of Object.entries(input.settings || {})) {
        const def = SETTING_DEFS[target].find(d => d.key === key);
        if (!def || !def.values.some(([v]) => v === value)) throw new MappingError('BAD_PROFILE', `Unknown setting “${key}”`);
        settings[key] = value;
    }
    return { id: input.id, name, description: String(input.description || '').slice(0, 300), target, family, extension, settings, entries, builtin };
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
            // Copying "Official Wii Remote" gives a mapping for a normal pad, since a real remote has nothing to edit
            const family = src.family === 'wiimote' ? 'generic' : src.family;
            return this.save({ ...src, family, id: undefined, name: name || `Copy of ${src.name}` });
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
// A Joy-Con pair has its sensors on each half; the right one is the hand that points, so it drives the motion
const expression = (value, pair) => value.split(' | ').map(part => q(pair ? part.replace(/^(Accel|Gyro) /, '$1 R ') : part)).join(' | ');

// The lines of a [Wiimote N] or [GCPadN] section for this profile and gamepad (device: Dolphin's device name)
function dolphinSection(profile, device, { pair = false } = {}) {
    const out = [];
    if (profile.target === 'wii') out.push(['Source', '1']);
    out.push(['Device', device]);
    if (profile.target === 'wii') out.push(['Extension', DOLPHIN_EXTENSION[profile.extension]]);
    for (const [key, value] of Object.entries(profile.settings)) out.push([key, value]);
    const controls = CONTROLS[profile.target];
    for (const ctl of controls) {
        if (ctl.ext && ctl.ext !== profile.extension) continue;
        const value = profile.entries[ctl.key];
        if (value) out.push([ctl.key, expression(value, pair)]);
    }
    return out;
}

// ---------- Writing to Ryujinx ----------

// Where each Switch button lives in a Ryujinx input_config entry
const RYUJINX_SLOT = {
    'Buttons/A': ['right_joycon', 'button_a'], 'Buttons/B': ['right_joycon', 'button_b'], 'Buttons/X': ['right_joycon', 'button_x'], 'Buttons/Y': ['right_joycon', 'button_y'],
    'Buttons/R': ['right_joycon', 'button_r'], 'Buttons/ZR': ['right_joycon', 'button_zr'], 'Buttons/Plus': ['right_joycon', 'button_plus'],
    'Buttons/L': ['left_joycon', 'button_l'], 'Buttons/ZL': ['left_joycon', 'button_zl'], 'Buttons/Minus': ['left_joycon', 'button_minus'],
    'D-Pad/Up': ['left_joycon', 'dpad_up'], 'D-Pad/Down': ['left_joycon', 'dpad_down'], 'D-Pad/Left': ['left_joycon', 'dpad_left'], 'D-Pad/Right': ['left_joycon', 'dpad_right'],
    'Buttons/Left Stick Click': ['left_joycon_stick', 'stick_button'], 'Buttons/Right Stick Click': ['right_joycon_stick', 'stick_button']
};

// What a Switch mapping changes in a Ryujinx input_config entry: the buttons, which stick is which, and motion.
// Anything the mapping leaves unmapped is unbound.
function ryujinxPatch(profile) {
    const patch = { left_joycon: {}, right_joycon: {}, left_joycon_stick: {}, right_joycon_stick: {}, motion: {} };
    for (const [key, [group, field]] of Object.entries(RYUJINX_SLOT)) {
        const source = profile.entries[key];
        patch[group][field] = source && RYUJINX_INPUT[source] ? RYUJINX_INPUT[source] : 'Unbound';
    }
    patch.left_joycon_stick.joystick = settingValue('switch', profile.settings, 'Sticks/Left');
    patch.right_joycon_stick.joystick = settingValue('switch', profile.settings, 'Sticks/Right');
    patch.motion.enable_motion = settingValue('switch', profile.settings, 'Motion/Enabled') === 'True';
    return patch;
}

module.exports = {
    MappingError, CONTROLS, SETTINGS, SETTING_DEFS, SOURCES, EXTENSIONS, TARGETS, FAMILIES, DEFAULT_PROFILE, BUILTIN,
    createStore, normalize, validSource, sourceLabel, sourcesFor, dolphinSection, ryujinxPatch, slug, familyOf, defaultFor, settingValue
};
