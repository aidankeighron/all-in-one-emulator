// The computer's sound (Linux): volume, mute and which output it goes to (the TV over HDMI, speakers, headphones), through
// PulseAudio or PipeWire's PulseAudio side (`pactl`, on Ubuntu out of the box), else WirePlumber's `wpctl` (volume and mute
// only). The menu runs in the signed-in session, so it reaches the same sound server as the desktop.
const childProcess = require('child_process');

// `pactl list sinks` -> [{name, description, volume, muted}]
function parseSinks(text) {
    const out = [];
    for (const block of String(text || '').split(/^Sink #/m).slice(1)) {
        const field = key => { const m = new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm').exec(block); return m ? m[1].trim() : ''; };
        const vol = /^\s*Volume:.*?(\d+)%/m.exec(block);
        out.push({ name: field('Name'), description: field('Description') || field('Name'), volume: vol ? Number(vol[1]) : null, muted: /^yes$/i.test(field('Mute')) });
    }
    return out.filter(s => s.name);
}

function createAudio({ platform = process.platform, execImpl = childProcess.execFile } = {}) {
    const run = (cmd, args) => new Promise(resolve => execImpl(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), missing: !!err && err.code === 'ENOENT' })));
    let tool = null;        // 'pactl' | 'wpctl' | 'none', found on first use

    async function which() {
        if (tool) return tool;
        if (platform === 'win32') return (tool = 'none');
        const p = await run('pactl', ['info']);
        if (p.ok) return (tool = 'pactl');
        const w = await run('wpctl', ['status']);
        return (tool = w.ok ? 'wpctl' : 'none');
    }

    async function status() {
        const t = await which();
        if (t === 'none') return { supported: false, reason: platform === 'win32' ? 'Use the volume on the taskbar on Windows.' : 'No sound server answered (pactl or wpctl).' };
        if (t === 'wpctl') {
            const r = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']);
            const m = /Volume:\s*([\d.]+)/.exec(r.out);
            return { supported: true, volume: m ? Math.round(Number(m[1]) * 100) : null, muted: /MUTED/.test(r.out), outputs: [], output: null };
        }
        const info = await run('pactl', ['info']);
        const def = (/^Default Sink:\s*(.*)$/m.exec(info.out) || [])[1];
        const sinks = parseSinks((await run('pactl', ['list', 'sinks'])).out);
        const current = sinks.find(s => s.name === (def || '').trim()) || sinks[0] || null;
        return { supported: true, volume: current ? current.volume : null, muted: current ? current.muted : false, output: current ? current.name : null, outputs: sinks.map(s => ({ name: s.name, description: s.description })) };
    }

    async function setVolume(percent) {
        const v = Math.max(0, Math.min(100, Math.round(Number(percent))));
        if (!Number.isFinite(v)) throw new Error('Choose a volume from 0 to 100');
        const t = await which();
        if (t === 'pactl') await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${v}%`]);
        else if (t === 'wpctl') await run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${v}%`]);
        return status();
    }

    async function setMute(on) {
        const t = await which();
        if (t === 'pactl') await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', on ? '1' : '0']);
        else if (t === 'wpctl') await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', on ? '1' : '0']);
        return status();
    }

    // Makes `name` the output, and moves what is playing now over to it
    async function setOutput(name) {
        if ((await which()) !== 'pactl') throw new Error('Choosing the output needs pactl');
        const st = await status();
        if (!st.outputs.some(o => o.name === name)) throw new Error('That output is not there any more');
        await run('pactl', ['set-default-sink', name]);
        const inputs = (await run('pactl', ['list', 'short', 'sink-inputs'])).out.split('\n').map(l => l.split('\t')[0]).filter(id => /^\d+$/.test(id));
        for (const id of inputs) await run('pactl', ['move-sink-input', id, name]);
        return status();
    }

    return { status, setVolume, setMute, setOutput };
}

module.exports = { createAudio, parseSinks };
