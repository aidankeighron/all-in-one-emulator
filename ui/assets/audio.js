// Menu audio: sound effects and background music.
// Files from the user's sound pack (see ui/lib/sounds.js) are used when present; otherwise the menu
// synthesises its own small sounds and soft music-box phrases, so it is never silent.
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

    function tone(freq, at, dur, { type = 'sine', gain = 0.3, slideTo = null, dest = sfxGain, attack = 0.01 } = {}) {
        const t0 = ctx.currentTime + at;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(attack, dur / 4));
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
    // Music only plays while the menu is the thing on screen: not during a game, not while another window is in front or
    // the menu is minimised, and not once nobody has touched anything for a while (the next press brings it back).

    const IDLE_MS = 5 * 60 * 1000;
    let away = false;                 // the menu window is hidden or another window has the focus
    let idleQuiet = false;            // faded out after IDLE_MS without input
    let lastActivity = performance.now();
    let currentTrackUrl = null;
    let elFade = null;
    const silenced = () => ducked || away || idleQuiet;

    // Built-in music: short music-box phrases over a chord progression, with a rest between them. Every note dies away
    // on its own, so nothing sustains under the menu (no drone), and stop() silences what is already scheduled at once.
    const N = { A3: 220.0, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25 };
    const CHORDS = {
        C: [N.C4, N.E4, N.G4, N.C5], Am: [N.A3, N.C4, N.E4, N.A4], F: [N.A3, N.C4, N.F4, N.A4],
        G: [N.B3, N.D4, N.G4, N.B4], Em: [N.B3, N.E4, N.G4, N.B4], Dm: [N.A3, N.D4, N.F4, N.A4]
    };
    const PROGRESSIONS = [['C', 'Am', 'F', 'G'], ['Am', 'F', 'C', 'G'], ['F', 'G', 'Em', 'Am'], ['C', 'G', 'Am', 'F'], ['Dm', 'G', 'C', 'Am']];
    const PATTERNS = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 1, 2, 1], [3, 2, 1, 2]];
    const pick = list => list[Math.floor(Math.random() * list.length)];

    function startSynthMusic() {
        const c = context();
        if (!c || synthMusic) return;
        const bus = c.createGain();
        const soft = c.createBiquadFilter();
        soft.type = 'lowpass';
        soft.frequency.value = 2800;
        bus.connect(soft).connect(synthMusicGain);
        const opts = (gain, type = 'triangle') => ({ type, gain, dest: bus, attack: 0.02 });

        // Returns how long the phrase lasts, in seconds
        function phrase() {
            const beat = 0.6;
            const chords = pick(PROGRESSIONS);
            const pattern = pick(PATTERNS);
            chords.forEach((name, ci) => {
                const notes = CHORDS[name];
                const last = ci === chords.length - 1;
                pattern.forEach((n, bi) => {
                    const at = (ci * 4 + bi) * beat;
                    tone(notes[n], at, last && bi === 3 ? 2.8 : 1.6, opts(0.05));
                });
                if (Math.random() < 0.6) tone(notes[3] * 2, ci * 4 * beat, 2, opts(0.03, 'sine'));
            });
            return chords.length * 4 * beat + 3;
        }

        let timer = null;
        const next = () => {
            if (c.state !== 'running') { timer = setTimeout(next, 1000); return; }   // don't pile up phrases while suspended
            const length = phrase();
            timer = setTimeout(next, (length + 6 + Math.random() * 8) * 1000);      // a rest of 6-14 s between phrases
        };
        next();
        synthMusic = {
            stop(fade = 0.15) {
                clearTimeout(timer);
                const t = c.currentTime;
                bus.gain.cancelScheduledValues(t);
                bus.gain.setValueAtTime(bus.gain.value, t);
                bus.gain.linearRampToValueAtTime(0, t + fade);
                setTimeout(() => { try { bus.disconnect(); } catch { /* already gone */ } }, fade * 1000 + 100);
            }
        };
    }

    function playTrack() {
        const track = pack.music[trackIndex % pack.music.length];
        if (!musicEl) {
            musicEl = new Audio();
            musicEl.addEventListener('ended', () => { trackIndex++; if (musicWanted && !silenced()) playTrack(); });
        }
        if (currentTrackUrl !== track.url) { musicEl.src = track.url; currentTrackUrl = track.url; }   // a paused song resumes where it was
        clearInterval(elFade);
        applyVolumes();
        musicEl.play().then(() => { musicBlocked = false; }, err => { if (err && err.name === 'NotAllowedError') musicBlocked = true; });
    }

    function stopMusicNow(fade = 0.15) {
        if (musicEl && !musicEl.paused) {
            clearInterval(elFade);
            const steps = Math.max(1, Math.round(fade * 20));
            const from = musicEl.volume;
            let i = 0;
            elFade = setInterval(() => {
                i++;
                musicEl.volume = Math.max(0, from * (1 - i / steps));
                if (i >= steps) { clearInterval(elFade); musicEl.pause(); applyVolumes(); }
            }, 50);
        }
        if (synthMusic) { synthMusic.stop(fade); synthMusic = null; }
    }

    function startMusic() {
        musicWanted = true;
        if (!settings.enabled || settings.musicVolume === 0 || silenced()) return stopMusicNow();
        if (pack.music.length) {
            if (synthMusic) { synthMusic.stop(); synthMusic = null; }
            if (!musicEl || musicEl.paused || elFade) playTrack();
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
        lastActivity = performance.now();
        if (on) stopMusicNow(); else if (musicWanted) startMusic();
    }

    // The menu window went to the background (another window in front, minimised, hidden) or came back
    function setAway(on) {
        if (away === on) return;
        away = on;
        if (on) stopMusicNow(0.5); else if (musicWanted) { lastActivity = performance.now(); startMusic(); }
    }

    // Fades the music out when the menu has sat untouched for a while
    setInterval(() => {
        if (idleQuiet || !musicWanted || silenced() || performance.now() - lastActivity < IDLE_MS) return;
        idleQuiet = true;
        stopMusicNow(3);
    }, 10000);

    // Any input: the first one unlocks sound in a browser that blocks autoplay, and any one brings idle-faded music back
    function unlock() {
        context();
        lastActivity = performance.now();
        if (idleQuiet) { idleQuiet = false; if (musicWanted) return startMusic(); }
        if (musicBlocked && musicWanted) startMusic();
        else if (musicWanted && !synthMusic && !pack.music.length && !silenced()) startMusic();
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

    return { load, play, startMusic, stopMusic, duck, setAway, unlock, setSettings, nextLevel, get settings() { return settings; } };
})();

window.Sfx = Sfx;
