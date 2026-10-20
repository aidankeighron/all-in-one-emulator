const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const roms = require('../ui/lib/roms');
const manifest = require('../emulators.json');

function makeZip(file, entries) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        for (const [name, data] of Object.entries(entries)) zip.addBuffer(data, name);
        zip.end();
        zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

// A minimal RAR 4 archive holding stored (uncompressed) files, enough to exercise the bundled reader
function makeRar(file, entries) {
    const zlib = require('zlib');
    const withCrc = body => { const c = Buffer.alloc(2); c.writeUInt16LE(zlib.crc32(body) & 0xffff); return Buffer.concat([c, body]); };
    const parts = [Buffer.from('526172211a0700', 'hex')];
    const main = Buffer.alloc(11); main[0] = 0x73; main.writeUInt16LE(0, 1); main.writeUInt16LE(13, 3);
    parts.push(withCrc(main));
    for (const [name, data] of Object.entries(entries)) {
        const nm = Buffer.from(name);
        const h = Buffer.alloc(5 + 25 + nm.length - 2 + 2 - 5 + 5);
        let o = 0;
        h[o++] = 0x74; h.writeUInt16LE(0x8000, o); o += 2;
        h.writeUInt16LE(32 + nm.length, o); o += 2;
        h.writeUInt32LE(data.length, o); o += 4;      // packed size
        h.writeUInt32LE(data.length, o); o += 4;      // unpacked size
        h[o++] = 3;                                   // host OS
        h.writeUInt32LE(zlib.crc32(data) >>> 0, o); o += 4;
        h.writeUInt32LE(0x5a000000, o); o += 4;       // time
        h[o++] = 29; h[o++] = 0x30;                   // version, method: store
        h.writeUInt16LE(nm.length, o); o += 2;
        h.writeUInt32LE(0x20, o); o += 4;             // attributes
        nm.copy(h, o); o += nm.length;
        parts.push(withCrc(h.subarray(0, o)), data);
    }
    fs.writeFileSync(file, Buffer.concat(parts));
}

const old = file => { const t = new Date(Date.now() - 5 * 60 * 1000); fs.utimesSync(file, t, t); };

function gcImage() { const b = Buffer.alloc(0x100); b.writeUInt32BE(0xc2339f3d, 0x1c); return b; }
function wiiImage() { const b = Buffer.alloc(0x100); b.writeUInt32BE(0x5d1c9ea3, 0x18); return b; }
function rvz(type) { const b = Buffer.alloc(0x100); b.write('RVZ\x01', 0, 'latin1'); b.writeUInt32BE(type, 0x48); return b; }

async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roms-test-'));
    return dir;
}

test('loose zips are sorted by disc type', async () => {
    const dir = await setup();
    await makeZip(path.join(dir, 'a.zip'), { 'nested/Game A.iso': gcImage() });
    await makeZip(path.join(dir, 'b.zip'), { 'Game B.iso': wiiImage(), 'readme.txt': Buffer.from('x') });
    await makeZip(path.join(dir, 'c.zip'), { 'Game C.rvz': rvz(1) });
    await makeZip(path.join(dir, 'd.zip'), { 'Game D.rvz': rvz(2) });
    ['a', 'b', 'c', 'd'].forEach(n => old(path.join(dir, `${n}.zip`)));

    const result = await roms.processRoms(dir, manifest);
    assert.ok(result.ok, result.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(dir, 'gamecube', 'Game A.iso')));
    assert.ok(fs.existsSync(path.join(dir, 'wii', 'Game B.iso')));
    assert.ok(fs.existsSync(path.join(dir, 'gamecube', 'Game C.rvz')));
    assert.ok(fs.existsSync(path.join(dir, 'wii', 'Game D.rvz')));
    assert.ok(!fs.existsSync(path.join(dir, 'a.zip')), 'zip removed after import');
    assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.startsWith('.')), [], 'no temp dirs left');
});

test('a zip inside a system folder stays in that folder', async () => {
    const dir = await setup();
    fs.mkdirSync(path.join(dir, 'wii'));
    await makeZip(path.join(dir, 'wii', 'g.zip'), { 'Mystery.iso': Buffer.alloc(0x100) });
    old(path.join(dir, 'wii', 'g.zip'));

    const result = await roms.processRoms(dir, manifest);
    assert.ok(result.ok, result.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(dir, 'wii', 'Mystery.iso')));
    assert.deepStrictEqual(roms.scanGames(dir, manifest).map(g => [g.title, g.emulator]), [['Mystery', 'dolphin']]);
});

test('bad, recent and ambiguous zips are left alone with a clear message', async () => {
    const dir = await setup();
    fs.writeFileSync(path.join(dir, 'trunc.zip'), Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(50, 1)]));
    fs.writeFileSync(path.join(dir, 'rar.zip'), Buffer.concat([Buffer.from('Rar!'), Buffer.alloc(50, 1)]));
    await makeZip(path.join(dir, 'fresh.zip'), { 'Game.iso': wiiImage() });
    await makeZip(path.join(dir, 'amb.zip'), { 'Mystery.iso': Buffer.alloc(0x100) });
    ['trunc', 'rar', 'amb'].forEach(n => old(path.join(dir, `${n}.zip`)));

    const result = await roms.processRoms(dir, manifest);
    const out = result.lines.join('\n');
    assert.ok(!result.ok);
    assert.match(out, /trunc\.zip \(\d+ bytes\):/);
    assert.match(out, /rar\.zip \(\d+ bytes\):/);
    assert.match(out, /fresh\.zip: modified in the last minute/);
    assert.match(out, /Could not tell which system Mystery\.iso/);
    for (const n of ['trunc', 'rar', 'fresh', 'amb']) assert.ok(fs.existsSync(path.join(dir, `${n}.zip`)), `${n}.zip kept`);
});

test('switch zips are sorted by extension and scanned for Ryujinx', async () => {
    const dir = await setup();
    await makeZip(path.join(dir, 's.zip'), { 'Zelda.nsp': Buffer.alloc(32) });
    old(path.join(dir, 's.zip'));
    const result = await roms.processRoms(dir, manifest);
    assert.ok(result.ok, result.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(dir, 'switch', 'Zelda.nsp')));
    assert.deepStrictEqual(roms.scanGames(dir, manifest).map(g => [g.title, g.emulator]), [['Zelda', 'ryujinx']]);
});

test('scanGames maps folders to emulators and ignores other files', async () => {
    const dir = await setup();
    for (const [folder, file] of [['wii', 'Super_Mario.iso'], ['gamecube', 'Melee.rvz'], ['switch', 'Zelda.nsp'], ['wii', 'notes.txt'], ['other', 'x.iso']]) {
        fs.mkdirSync(path.join(dir, folder), { recursive: true });
        fs.writeFileSync(path.join(dir, folder, file), '');
    }
    fs.mkdirSync(path.join(dir, 'wii', 'SomeFolder'));

    const games = roms.scanGames(dir, manifest);
    assert.deepStrictEqual(
        games.map(g => `${g.console}:${g.title}:${g.emulator}`).sort(),
        ['gamecube:Melee:dolphin', 'switch:Zelda:ryujinx', 'wii:Super Mario:dolphin']
    );
});

test('cleanTitle drops parenthesised tags for display only', async () => {
    assert.strictEqual(roms.cleanTitle('Super Mario Galaxy 2 (USA) (En,Fr,Es)'), 'Super Mario Galaxy 2');
    assert.strictEqual(roms.cleanTitle('Metroid_Prime (Rev 1)'), 'Metroid Prime');
    assert.strictEqual(roms.cleanTitle('(Demo)'), '(Demo)', 'never ends up empty');

    const dir = await setup();
    fs.mkdirSync(path.join(dir, 'wii'));
    fs.writeFileSync(path.join(dir, 'wii', 'Wii Sports (USA) (Rev 1).iso'), '');
    const [game] = roms.scanGames(dir, manifest);
    assert.strictEqual(game.title, 'Wii Sports');
    assert.strictEqual(game.path, 'wii/Wii Sports (USA) (Rev 1).iso', 'file path is untouched');
});

test('cleanTitle copes with Switch dump names', async () => {
    assert.strictEqual(roms.cleanTitle('Super Mario Odyssey [0100000000010000][v0]'), 'Super Mario Odyssey');
    assert.strictEqual(roms.cleanTitle('The Legend of Zelda - Breath of the Wild [01007EF00011E000][v1.6.0] [BASE]'), 'The Legend of Zelda: Breath of the Wild');
    assert.strictEqual(roms.cleanTitle('Animal_Crossing_-_New_Horizons[0100]'), 'Animal Crossing: New Horizons');
    assert.strictEqual(roms.cleanTitle('Spider-Man'), 'Spider-Man', 'a hyphen inside a word stays');
});

test('rar archives are unpacked with no external program', async () => {
    const dir = await setup();
    makeRar(path.join(dir, 'pack.rar'), { 'sub/Game A.iso': gcImage(), 'notes.txt': Buffer.from('hi') });
    makeRar(path.join(dir, 'switch-game.rar'), { 'Zelda.nsp': Buffer.alloc(32, 7) });
    fs.mkdirSync(path.join(dir, 'switch'));
    fs.renameSync(path.join(dir, 'switch-game.rar'), path.join(dir, 'switch', 'switch-game.rar'));
    old(path.join(dir, 'pack.rar')); old(path.join(dir, 'switch', 'switch-game.rar'));

    const result = await roms.processRoms(dir, manifest);
    assert.ok(result.ok, result.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(dir, 'gamecube', 'Game A.iso')));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'switch', 'Zelda.nsp')).length, 32);
    assert.ok(!fs.existsSync(path.join(dir, 'pack.rar')), 'rar removed after import');
});
