const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const sounds = require('../ui/lib/sounds');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-test-'));

test('scan matches files to events and lists music in name order', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'music'));
    for (const f of ['Move.WAV', 'select.mp3', 'bogus.wav', 'notes.txt', '.hidden.wav']) fs.writeFileSync(path.join(dir, f), 'x');
    for (const f of ['b.ogg', 'a.mp3', 'cover.png']) fs.writeFileSync(path.join(dir, 'music', f), 'x');
    const pack = sounds.scan(dir);
    assert.deepStrictEqual(pack.effects, { move: 'Move.WAV', select: 'select.mp3' });
    assert.deepStrictEqual(pack.music, ['a.mp3', 'b.ogg']);
});

test('ensureDir creates the folders and a how-to once, without overwriting', () => {
    const dir = path.join(tmp(), 'sounds');
    sounds.ensureDir(dir);
    assert.ok(fs.statSync(path.join(dir, 'music')).isDirectory());
    const readme = path.join(dir, 'README.txt');
    assert.match(fs.readFileSync(readme, 'utf8'), /launch\.wav/);
    fs.writeFileSync(readme, 'mine');
    sounds.ensureDir(dir);
    assert.strictEqual(fs.readFileSync(readme, 'utf8'), 'mine');
});

test('resolve only returns files the scan lists', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'music'));
    fs.writeFileSync(path.join(dir, 'move.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'music', 'song.mp3'), 'x');
    fs.writeFileSync(path.join(path.dirname(dir), 'outside.wav'), 'x');
    assert.strictEqual(sounds.resolve(dir, 'effects', 'move.wav'), path.join(dir, 'move.wav'));
    assert.strictEqual(sounds.resolve(dir, 'music', 'song.mp3'), path.join(dir, 'music', 'song.mp3'));
    assert.strictEqual(sounds.resolve(dir, 'effects', '../outside.wav'), null);
    assert.strictEqual(sounds.resolve(dir, 'music', 'move.wav'), null);
    assert.strictEqual(sounds.resolve(dir, 'effects', 'secret.txt'), null);
});

test('serve supports whole files and byte ranges', async () => {
    const dir = tmp();
    const file = path.join(dir, 'song.mp3');
    fs.writeFileSync(file, '0123456789');
    const server = http.createServer((req, res) => sounds.serve(req, res, file));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const whole = await fetch(base);
        assert.strictEqual(whole.status, 200);
        assert.strictEqual(whole.headers.get('content-type'), 'audio/mpeg');
        assert.strictEqual(await whole.text(), '0123456789');

        const part = await fetch(base, { headers: { Range: 'bytes=2-5' } });
        assert.strictEqual(part.status, 206);
        assert.strictEqual(part.headers.get('content-range'), 'bytes 2-5/10');
        assert.strictEqual(await part.text(), '2345');

        const tail = await fetch(base, { headers: { Range: 'bytes=7-' } });
        assert.strictEqual(await tail.text(), '789');
        const last = await fetch(base, { headers: { Range: 'bytes=-3' } });
        assert.strictEqual(await last.text(), '789');
        assert.strictEqual((await fetch(base, { headers: { Range: 'bytes=50-60' } })).status, 416);
    } finally {
        server.close();
    }
});
