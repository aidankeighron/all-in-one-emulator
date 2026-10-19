// Menu audio: sound effects and background music.
// Files from the user's sound pack (see ui/lib/sounds.js) are used when present; otherwise the menu
// synthesises its own small sounds and a quiet ambient loop, so it is never silent.
const Sfx = (() => {
    const LEVELS = [0, 0.25, 0.5, 0.75, 1];

    let ctx = null;
    let sfxGain = null;
    let synthMusicGain = null;
    let settings = { enabled: true, sfxVolume: 0.7, musicVolume: 0.35 };
    let pack = { effects: {}, music: [] };
    const buffers = new Map();        // event -> decoded custom effect
    let musicEl = null;
    let trackIndex = 0;
    let ducked = false;               // true while a game is running
    let musicWanted = false;
    let musicBlocked = false;         // the browser refused to autoplay; retried on the first input
    let synthMusic = null;            // {stop} while the built-in ambient loop plays
    let lastMove = 0;

    function context() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
            sfxGain = ctx.createGain();
            sfxGain.connect(ctx.destination);
            synthMusicGain = ctx.createGain();
            synthMusicGain.connect(ctx.destination);
            applyVolumes();
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return ctx;
    }

    function applyVolumes() {
        if (sfxGain) sfxGain.gain.value = settings.enabled ? settings.sfxVolume : 0;
        if (synthMusicGain) synthMusicGain.gain.value = settings.enabled ? settings.musicVolume : 0;
        if (musicEl) musicEl.volume = settings.enabled ? settings.musicVolume : 0;
    }

    // ---------- Built-in sounds ----------

    function tone(freq, at, dur, { type = 'sine', gain = 0.3, slideTo = null, dest = sfxGain } = {}) {
        const t0 = ctx.currentTime + at;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.01, dur / 4));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(dest);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
    }

    function swoosh(at, dur, gain) {
        const t0 = ctx.currentTime + at;
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 2;
        filter.frequency.setValueAtTime(500, t0);
        filter.frequency.exponentialRampToValueAtTime(2600, t0 + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(filter).connect(g).connect(sfxGain);
        src.start(t0);
    }

    const arpeggio = (notes, step, dur, opts) => notes.forEach((f, i) => tone(f, i * step, dur, opts));

    const SYNTH = {
        move: () => { tone(1240, 0, 0.05, { gain: 0.16 }); tone(1860, 0, 0.03, { gain: 0.05 }); },
        select: () => { tone(660, 0, 0.07, { gain: 0.25 }); tone(990, 0.06, 0.16, { gain: 0.3 }); },
        back: () => { tone(740, 0, 0.07, { gain: 0.22 }); tone(520, 0.06, 0.14, { gain: 0.25 }); },
        page: () => swoosh(0, 0.2, 0.22),
        open: () => arpeggio([523, 659, 784], 0.06, 0.2, { gain: 0.22, type: 'triangle' }),
        close: () => arpeggio([784, 659, 523], 0.06, 0.2, { gain: 0.22, type: 'triangle' }),
        toggle: () => { tone(880, 0, 0.05, { gain: 0.2 }); tone(1175, 0.05, 0.1, { gain: 0.22 }); },
        error: () => tone(190, 0, 0.3, { type: 'sawtooth', gain: 0.16, slideTo: 130 }),
        launch: () => {
            arpeggio([523, 659, 784, 1047, 1319], 0.07, 0.35, { gain: 0.2, type: 'triangle' });
            [523, 659, 784, 1047].forEach(f => tone(f, 0.38, 1.1, { gain: 0.1 }));
        },
        boot: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.05, 1.6, { gain: 0.12 }))
    };

    // ---------- Effects ----------

    function play(name) {
        if (!settings.enabled || settings.sfxVolume === 0) return;
        const c = context();
        if (!c || c.state !== 'running') return;
        if (name === 'move') {   // hovering across tiles can fire very fast
            const now = performance.now();
            if (now - lastMove < 35) return;
            lastMove = now;
        }
        const buffer = buffers.get(name);
        if (buffer) {
            const src = c.createBufferSource();
            src.buffer = buffer;
            src.connect(sfxGain);
            src.start();
        } else if (SYNTH[name]) {
            SYNTH[name]();
        }
    }

    // ---------- Music ----------

    function startSynthMusic() {
        const c = context();
        if (!c || synthMusic) return;
        const pad = [130.81, 196.0, 329.63].map((f, i) => {
            const osc = c.createOscillator();
            const g = c.createGain();
            const lfo = c.createOscillator();
            const lfoGain = c.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            g.gain.value = 0.05;
            lfo.frequency.value = 0.05 + i * 0.03;
            lfoGain.gain.value = 0.03;
            lfo.connect(lfoGain).connect(g.gain);
            osc.connect(g).connect(synthMusicGain);
            osc.start();
            lfo.start();
            return { osc, lfo };
        });
        const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
        let timer = null;
        const next = () => {
            if (c.state === 'running') {
                const f = scale[Math.floor(Math.random() * scale.length)];
                tone(f, 0, 3, { type: 'triangle', gain: 0.07, dest: synthMusicGain });
                if (Math.random() < 0.35) tone(f / 2, 0.25, 3.5, { type: 'sine', gain: 0.05, dest: synthMusicGain });
            }
            timer = setTimeout(next, 1300 + Math.random() * 2200);
        };
        next();
        synthMusic = {
            stop() {
                clearTimeout(timer);
                pad.forEach(({ osc, lfo }) => { try { osc.stop(); lfo.stop(); } catch { /* already stopped */ } });
            }
        };
    }

    function playTrack() {
        const track = pack.music[trackIndex % pack.music.length];
        if (!musicEl) {
            musicEl = new Audio();
            musicEl.addEventListener('ended', () => { trackIndex++; if (musicWanted) playTrack(); });
        }
        musicEl.src = track.url;
        applyVolumes();
        musicEl.play().then(() => { musicBlocked = false; }, err => { if (err && err.name === 'NotAllowedError') musicBlocked = true; });
    }

    function stopMusicNow() {
        if (musicEl) musicEl.pause();
        if (synthMusic) { synthMusic.stop(); synthMusic = null; }
    }

    function startMusic() {
        musicWanted = true;
        if (!settings.enabled || settings.musicVolume === 0 || ducked) return stopMusicNow();
        if (pack.music.length) {
            if (synthMusic) { synthMusic.stop(); synthMusic = null; }
            if (!musicEl || musicEl.paused) playTrack();
        } else {
            if (musicEl) musicEl.pause();
            startSynthMusic();
        }
    }

    function stopMusic() {
        musicWanted = false;
        stopMusicNow();
    }

    // Quiet while a game runs, back when it closes
    function duck(on) {
        ducked = on;
        if (on) stopMusicNow(); else if (musicWanted) startMusic();
    }

    // First input in a browser that blocks autoplay
    function unlock() {
        context();
        if (musicBlocked && musicWanted) startMusic();
        else if (musicWanted && !synthMusic && !pack.music.length && !ducked) startMusic();
    }

    // ---------- Loading the user's sound pack ----------

    async function load() {
        const data = await (await fetch('/api/sounds')).json();
        settings = { ...settings, ...data.settings };
        const musicChanged = JSON.stringify(pack.music) !== JSON.stringify(data.music);
        pack = { effects: data.effects, music: data.music };
        buffers.clear();
        const c = context();
        if (c) {
            await Promise.all(Object.entries(data.effects).map(async ([event, url]) => {
                try {
                    buffers.set(event, await c.decodeAudioData(await (await fetch(url)).arrayBuffer()));
                } catch (err) {
                    console.warn(`Could not use the ${event} sound:`, err.message);
                }
            }));
        }
        applyVolumes();
        if (musicChanged) {   // reopening Settings must not restart the song that is playing
            trackIndex = 0;
            if (musicWanted) { stopMusicNow(); startMusic(); }
        }
        return { dir: data.dir, effects: Object.keys(data.effects).length, tracks: data.music.length };
    }

    function setSettings(next) {
        settings = { ...settings, ...next };
        applyVolumes();
        if (musicWanted) startMusic();
    }

    // Next level up the ladder 0, 25, 50, 75, 100 % (wraps around)
    function nextLevel(current) {
        const i = LEVELS.findIndex(l => l > current + 0.001);
        return i < 0 ? LEVELS[0] : LEVELS[i];
    }

    return { load, play, startMusic, stopMusic, duck, unlock, setSettings, nextLevel, get settings() { return settings; } };
})();

window.Sfx = Sfx;
