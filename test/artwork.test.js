const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const artwork = require('../ui/lib/artwork');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const SECTOR = 2048;

// Builds a tiny ISO 9660 image holding the given files (paths like "PSP_GAME/ICON0.PNG")
function makeIso(files) {
    const tree = { dirs: {}, files: {} };
    for (const [p, data] of Object.entries(files)) {
        const parts = p.split('/');
        let node = tree;
        for (const d of parts.slice(0, -1)) node = node.dirs[d] = node.dirs[d] || { dirs: {}, files: {} };
        node.files[parts[parts.length - 1]] = data;
    }
    const sectors = Array.from({ length: 17 }, () => Buffer.alloc(SECTOR)); // 16 system sectors + PVD at 16
    const alloc = buf => { sectors.push(buf); return sectors.length - 1; };
    const record = (name, lba, size, isDir) => {
        const n = Buffer.from(isDir ? name : `${name};1`, 'latin1');
        let len = 33 + n.length; if (len % 2) len++;
        const r = Buffer.alloc(len);
        r[0] = len; r.writeUInt32LE(lba, 2); r.writeUInt32LE(size, 10); r[25] = isDir ? 2 : 0; r[32] = n.length; n.copy(r, 33);
        return r;
    };
    function writeDir(node) {
        const placed = [];
        for (const [name, data] of Object.entries(node.files)) {
            const padded = Buffer.alloc(Math.ceil(data.length / SECTOR) * SECTOR); data.copy(padded);
            const first = sectors.length; sectors.push(padded);
            placed.push(record(name, first, data.length, false));
        }
        for (const [name, child] of Object.entries(node.dirs)) {
            const lba = writeDir(child);
            placed.push(record(name, lba, SECTOR, true));
        }
        const buf = Buffer.alloc(SECTOR);
        Buffer.concat(placed).copy(buf);
        return alloc(buf);
    }
    const rootLba = writeDir(tree);
    const pvd = Buffer.alloc(SECTOR);
    pvd[0] = 1; pvd.write('CD001', 1, 'latin1');
    record('', rootLba, SECTOR, true).copy(pvd, 156);
    sectors[16] = pvd;
    return Buffer.concat(sectors);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'art-test-'));

test('isoReadFile finds nested files case-insensitively', async () => {
    const dir = tmp();
    const iso = path.join(dir, 'g.iso');
    fs.writeFileSync(iso, makeIso({ 'PSP_GAME/ICON0.PNG': PNG, 'PSP_GAME/PARAM.SFO': Buffer.from('x') }));
    const got = await artwork.isoReadFile(iso, 'PSP_GAME/ICON0.PNG');
    assert.ok(got.equals(PNG));
    assert.strictEqual(await artwork.isoReadFile(iso, 'PSP_GAME/MISSING.PNG'), null);
});

test('Wii/GameCube game IDs come from iso, wbfs and rvz headers', async () => {
    const dir = tmp();
    const iso = path.join(dir, 'a.iso'); fs.writeFileSync(iso, Buffer.concat([Buffer.from('RSPE01'), Buffer.alloc(64)]));
    const wbfs = path.join(dir, 'b.wbfs'); fs.writeFileSync(wbfs, Buffer.concat([Buffer.alloc(0x200), Buffer.from('GALE01'), Buffer.alloc(64)]));
    const rvz = path.join(dir, 'c.rvz'); fs.writeFileSync(rvz, Buffer.concat([Buffer.alloc(0x58), Buffer.from('R3OP01'), Buffer.alloc(64)]));
    assert.strictEqual(await artwork.dolphinGameId(iso), 'RSPE01');
    assert.strictEqual(await artwork.dolphinGameId(wbfs), 'GALE01');
    assert.strictEqual(await artwork.dolphinGameId(rvz), 'R3OP01');
    const junk = path.join(dir, 'd.iso'); fs.writeFileSync(junk, Buffer.alloc(64));
    assert.strictEqual(await artwork.dolphinGameId(junk), null);
});

test('cover URLs follow the region letter', () => {
    assert.strictEqual(artwork.dolphinCoverUrls('RSPE01')[0], 'https://art.gametdb.com/wii/cover/US/RSPE01.png');
    assert.strictEqual(artwork.dolphinCoverUrls('R3OP01')[0], 'https://art.gametdb.com/wii/cover/EN/R3OP01.png');
    assert.strictEqual(artwork.dolphinCoverUrls('RSPJ01')[0], 'https://art.gametdb.com/wii/cover/JA/RSPJ01.png');
});

test('PS2 serial is read from SYSTEM.CNF', async () => {
    const dir = tmp();
    const iso = path.join(dir, 'p.iso');
    fs.writeFileSync(iso, makeIso({ 'SYSTEM.CNF': Buffer.from('BOOT2 = cdrom0:\\SLUS_200.02;1\r\nVER = 1.00\r\n') }));
    assert.strictEqual(await artwork.ps2Serial(iso), 'SLUS-20002');
    assert.strictEqual(artwork.ps2CoverUrls('SLUS-20002')[0], 'https://art.gametdb.com/ps2/cover/US/SLUS-20002.jpg');
});

test('PBP icon is cut out using the header offsets', async () => {
    const dir = tmp();
    const head = Buffer.alloc(0x28); head.write('\0PBP', 0, 'latin1');
    head.writeUInt32LE(0x28, 0x08); head.writeUInt32LE(0x28 + 4, 0x0c); head.writeUInt32LE(0x28 + 4 + PNG.length, 0x10);
    const pbp = path.join(dir, 'EBOOT.PBP');
    fs.writeFileSync(pbp, Buffer.concat([head, Buffer.from('sfo!'), PNG, Buffer.alloc(16)]));
    const fh = await fs.promises.open(pbp, 'r');
    const icon = await artwork.pbpIcon(fh); await fh.close();
    assert.ok(icon.equals(PNG));
});

async function settle(art, games) {
    art.ensure(games);
    for (let i = 0; i < 200 && art.pending() > 0; i++) await new Promise(r => setTimeout(r, 10));
}

test('create: embeds PSP icons, downloads Dolphin covers once, remembers misses, honours sidecar images', async () => {
    const roms = tmp(), cache = tmp();
    fs.mkdirSync(path.join(roms, 'psp')); fs.mkdirSync(path.join(roms, 'wii')); fs.mkdirSync(path.join(roms, 'ps1'));
    fs.writeFileSync(path.join(roms, 'psp/Game.iso'), makeIso({ 'PSP_GAME/ICON0.PNG': PNG }));
    fs.writeFileSync(path.join(roms, 'wii/Sports.iso'), Buffer.concat([Buffer.from('RSPE01'), Buffer.alloc(64)]));
    fs.writeFileSync(path.join(roms, 'wii/Unknown.iso'), Buffer.concat([Buffer.from('RUNE01'), Buffer.alloc(64)]));
    fs.writeFileSync(path.join(roms, 'ps1/Crash.cue'), 'x');
    fs.writeFileSync(path.join(roms, 'ps1/Crash.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));

    const requested = [];
    const fetchImpl = async url => {
        requested.push(url);
        return url.endsWith('RSPE01.png')
            ? { ok: true, arrayBuffer: async () => PNG }
            : { ok: false, arrayBuffer: async () => Buffer.alloc(0) };
    };
    const games = [
        { id: 'psp1', title: 'Game', emulator: 'ppsspp', path: 'psp/Game.iso' },
        { id: 'wii1', title: 'Sports', emulator: 'dolphin', path: 'wii/Sports.iso' },
        { id: 'wii2', title: 'Unknown', emulator: 'dolphin', path: 'wii/Unknown.iso' },
        { id: 'ps11', title: 'Crash', emulator: 'duckstation', path: 'ps1/Crash.cue' }
    ];

    const art = artwork.create({ cacheDir: cache, romsDir: roms, fetchImpl });
    assert.strictEqual(art.find(games[3]), path.join(roms, 'ps1/Crash.jpg'));
    await settle(art, games);

    assert.ok(fs.readFileSync(art.find(games[0])).equals(PNG));
    assert.ok(fs.readFileSync(art.find(games[1])).equals(PNG));
    assert.strictEqual(art.find(games[2]), null);
    assert.ok(requested.includes('https://art.gametdb.com/wii/cover/US/RSPE01.png'));

    const before = requested.length;
    await settle(art, games);
    assert.strictEqual(requested.length, before, 'covers and known misses are not fetched again');
});

test('create: being offline is not remembered as a miss', async () => {
    const roms = tmp(), cache = tmp();
    fs.mkdirSync(path.join(roms, 'wii'));
    fs.writeFileSync(path.join(roms, 'wii/Sports.iso'), Buffer.concat([Buffer.from('RSPE01'), Buffer.alloc(64)]));
    const game = { id: 'wii1', title: 'Sports', emulator: 'dolphin', path: 'wii/Sports.iso' };
    let online = false;
    const fetchImpl = async () => { if (!online) throw new Error('offline'); return { ok: true, arrayBuffer: async () => PNG }; };
    const art = artwork.create({ cacheDir: cache, romsDir: roms, fetchImpl });
    await settle(art, [game]);
    assert.strictEqual(art.find(game), null);
    online = true;
    await settle(art, [game]);
    assert.ok(art.find(game));
});
