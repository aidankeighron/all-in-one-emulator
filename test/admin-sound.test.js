// The administrator password from the menu's own keyboard, the computer's volume, and the TV's over HDMI-CEC
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const admin = require('../ui/lib/admin');
const { createAudio, parseSinks } = require('../ui/lib/audio');
const { createCec } = require('../ui/lib/cec');

// a stand-in process that answers with an exit code; written input is kept
function fakeSpawn(codeFor) {
    const calls = [];
    const spawnImpl = (cmd, args) => {
        const call = { cmd, args, input: '' };
        calls.push(call);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { write: t => { call.input += t; }, end() {} };
        setTimeout(() => child.emit('close', codeFor(call)), 5);
        return child;
    };
    return { spawnImpl, calls };
}

test('the password is checked with sudo, kept for a while, and then used instead of the system dialog', async () => {
    admin.forget();
    const exists = f => f === '/usr/bin/sudo';
    const { spawnImpl, calls } = fakeSpawn(c => (c.input === 'right\n' ? 0 : 1));
    assert.strictEqual(admin.spawn(spawnImpl, 'echo hi', { exists }) && calls[0].cmd, 'pkexec', 'without it: the system asks');
    assert.strictEqual(await admin.remember('wrong', { spawnImpl, exists }), false);
    assert.strictEqual(admin.password(), null);
    assert.strictEqual(await admin.remember('right', { spawnImpl, exists }), true);
    admin.spawn(spawnImpl, 'systemctl reboot', { exists });
    const last = calls[calls.length - 1];
    assert.deepStrictEqual([last.cmd, ...last.args], ['/usr/bin/sudo', '-S', '-k', '-p', '', 'sh', '-c', 'systemctl reboot']);
    assert.strictEqual(last.input, 'right\n');
    assert.strictEqual(admin.password(Date.now() + admin.KEEP_MS + 1), null, 'forgotten after a while');
    admin.forget();
});

const SINKS = `Sink #47
\tState: RUNNING
\tName: alsa_output.pci-0000_00_1f.3.hdmi-stereo
\tDescription: Built-in Audio Digital Stereo (HDMI)
\tMute: no
\tVolume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB
Sink #48
\tState: SUSPENDED
\tName: alsa_output.pci-0000_00_1f.3.analog-stereo
\tDescription: Built-in Audio Analog Stereo
\tMute: yes
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
`;

test('the computer volume, mute and output come from pactl and are set through it', async () => {
    assert.deepStrictEqual(parseSinks(SINKS).map(s => [s.description, s.volume, s.muted]), [['Built-in Audio Digital Stereo (HDMI)', 40, false], ['Built-in Audio Analog Stereo', 100, true]]);
    const calls = [];
    const execImpl = (cmd, args, opts, cb) => {
        calls.push([cmd, ...args].join(' '));
        if (args[0] === 'info') return cb(null, 'Server Name: PulseAudio (on PipeWire 1.0.5)\nDefault Sink: alsa_output.pci-0000_00_1f.3.hdmi-stereo\n', '');
        if (args[0] === 'list' && args[1] === 'sinks') return cb(null, SINKS, '');
        if (args[0] === 'list' && args[1] === 'short') return cb(null, '12\t47\t71\tPipeWire\tfloat32le 2ch 48000Hz\n', '');
        return cb(null, '', '');
    };
    const audio = createAudio({ platform: 'linux', execImpl });
    const st = await audio.status();
    assert.strictEqual(st.volume, 40);
    assert.strictEqual(st.output, 'alsa_output.pci-0000_00_1f.3.hdmi-stereo');
    await audio.setVolume(250);
    assert.ok(calls.includes('pactl set-sink-volume @DEFAULT_SINK@ 100%'), 'never above 100%');
    await audio.setMute(true);
    assert.ok(calls.includes('pactl set-sink-mute @DEFAULT_SINK@ 1'));
    await audio.setOutput('alsa_output.pci-0000_00_1f.3.analog-stereo');
    assert.ok(calls.includes('pactl set-default-sink alsa_output.pci-0000_00_1f.3.analog-stereo'));
    assert.ok(calls.includes('pactl move-sink-input 12 alsa_output.pci-0000_00_1f.3.analog-stereo'), 'what plays now moves over too');
    await assert.rejects(audio.setOutput('nope'), /not there/);
});

test('TV volume: sent with cec-ctl when the computer has a CEC link, explained when it has none', async () => {
    const calls = [];
    const execImpl = (cmd, args, opts, cb) => { calls.push([cmd, ...args].join(' ')); cb(null, '', ''); return { stdin: null }; };
    const tv = createCec({ platform: 'linux', exists: f => f === '/usr/bin/cec-ctl', list: () => ['cec0', 'null'], execImpl });
    assert.deepStrictEqual(await tv.status(), { supported: true, via: 'cec-ctl', device: '/dev/cec0' });
    await tv.press('up');
    await tv.press('down');
    assert.deepStrictEqual(calls, [
        'cec-ctl -d /dev/cec0 --playback --osd-name Emulator Menu',
        'cec-ctl -d /dev/cec0 --to 0 --user-control-pressed ui-cmd=volume-up', 'cec-ctl -d /dev/cec0 --to 0 --user-control-released',
        'cec-ctl -d /dev/cec0 --to 0 --user-control-pressed ui-cmd=volume-down', 'cec-ctl -d /dev/cec0 --to 0 --user-control-released'
    ]);
    const none = createCec({ platform: 'linux', exists: () => false, list: () => ['null'], execImpl });
    const st = await none.status();
    assert.strictEqual(st.supported, false);
    assert.match(st.reason, /no HDMI-CEC/);
    const needsTool = await createCec({ platform: 'linux', exists: () => false, list: () => ['cec0'], execImpl }).status();
    assert.strictEqual(needsTool.install, 'v4l-utils');
});
