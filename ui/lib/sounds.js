// The sound pack: the user's own audio files in <config>/sounds (and sounds/music for background tracks).
// Anything missing falls back to the built-in synthesised sounds in the menu itself, so the menu is never silent.
const fs = require('fs');
const path = require('path');

// Menu events that can have a sound. A file named <event>.<ext> replaces the built-in one.
const EVENTS = {
    boot: 'the menu starting up',
    move: 'moving the selection',
    select: 'pressing a button',
    back: 'going back or closing',
    page: 'changing page',
    open: 'opening Settings',
    close: 'closing Settings',
    launch: 'starting a game',
    error: 'something went wrong',
    toggle: 'switching an option on or off'
};

const AUDIO_TYPES = {
    wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac'
};

const extOf = name => path.extname(name).slice(1).toLowerCase();
const isAudio = name => !name.startsWith('.') && Object.hasOwn(AUDIO_TYPES, extOf(name));

function readdir(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && isAudio(d.name)).map(d => d.name).sort(); } catch { return []; }
}

// {effects: {event: filename}, music: [filename]}
function scan(dir) {
    const effects = {};
    for (const name of readdir(dir)) {
        const event = path.basename(name, path.extname(name)).toLowerCase();
        if (Object.hasOwn(EVENTS, event) && !effects[event]) effects[event] = name;
    }
    return { effects, music: readdir(path.join(dir, 'music')) };
}

// Creates the folder and a short how-to on first use
function ensureDir(dir) {
    try {
        fs.mkdirSync(path.join(dir, 'music'), { recursive: true });
        const readme = path.join(dir, 'README.txt');
        if (!fs.existsSync(readme)) {
            const lines = Object.entries(EVENTS).map(([k, v]) => `  ${k}.wav   ${v}`);
            fs.writeFileSync(readme, [
                'Put your own sounds here. The menu uses them instead of its built-in ones.',
                '',
                'Sound effects: name the file after the event (wav, mp3, ogg, m4a, flac or opus):',
                ...lines,
                '',
                'Background music: put any number of audio files in the "music" folder.',
                'They play in name order and repeat. Remove them to get the built-in music back.',
                '',
                'Press the refresh button in the menu, or reopen Settings, after adding files.',
                ''
            ].join('\n'));
        }
    } catch { /* read-only config folder: the built-in sounds still work */ }
}

// Absolute path of a file in the pack, only if the scan lists it (no path tricks)
function resolve(dir, kind, name) {
    const pack = scan(dir);
    if (kind === 'effects' && Object.values(pack.effects).includes(name)) return path.join(dir, name);
    if (kind === 'music' && pack.music.includes(name)) return path.join(dir, 'music', name);
    return null;
}

// What the menu needs: URLs for each custom effect and music track
function describe(dir) {
    const pack = scan(dir);
    const url = (kind, name) => `/api/sounds/${kind}/${encodeURIComponent(name)}`;
    return {
        dir,
        events: Object.keys(EVENTS),
        effects: Object.fromEntries(Object.entries(pack.effects).map(([e, f]) => [e, url('effects', f)])),
        music: pack.music.map(f => ({ name: f, url: url('music', f) }))
    };
}

// Serves a file with Range support (audio elements ask for ranges to stream and loop)
function serve(req, res, file) {
    const type = AUDIO_TYPES[extOf(file)] || 'application/octet-stream';
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
        let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
        let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
        start = Math.max(0, start);
        if (start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
        }
        res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
}

module.exports = { EVENTS, scan, ensureDir, resolve, describe, serve };
