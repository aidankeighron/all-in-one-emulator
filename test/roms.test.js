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

test('a zip inside a system folder stays in that folder; cue sheets keep their bin', async () => {
    const dir = await setup();
    fs.mkdirSync(path.join(dir, 'ps1'));
    await makeZip(path.join(dir, 'ps1', 'g.zip'), { 'Crash.cue': Buffer.from('FILE'), 'Crash.bin': Buffer.alloc(16) });
    old(path.join(dir, 'ps1', 'g.zip'));

    const result = await roms.processRoms(dir, manifest);
    assert.ok(result.ok, result.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(dir, 'ps1', 'Crash.cue')));
    assert.ok(fs.existsSync(path.join(dir, 'ps1', 'Crash.bin')));
    const games = roms.scanGames(dir, manifest);
    assert.deepStrictEqual(games.map(g => [g.title, g.emulator]), [['Crash', 'duckstation']]);
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
    assert.match(out, /trunc\.zip \(\d+ bytes\): the archive is corrupt or incomplete/);
    assert.match(out, /rar\.zip: it is a RAR archive/);
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
    for (const [folder, file] of [['wii', 'Super_Mario.iso'], ['gamecube', 'Melee.rvz'], ['psp', 'GTA.cso'], ['wii', 'notes.txt'], ['other', 'x.iso']]) {
        fs.mkdirSync(path.join(dir, folder), { recursive: true });
        fs.writeFileSync(path.join(dir, folder, file), '');
    }
    fs.mkdirSync(path.join(dir, 'ps3', 'Demon', 'PS3_GAME'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ps3', 'NotAGame'));

    const games = roms.scanGames(dir, manifest);
    assert.deepStrictEqual(
        games.map(g => `${g.console}:${g.title}:${g.emulator}`).sort(),
        ['gamecube:Melee:dolphin', 'ps3:Demon:rpcs3', 'psp:GTA:ppsspp', 'wii:Super Mario:dolphin']
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
