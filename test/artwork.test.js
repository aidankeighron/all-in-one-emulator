const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const artwork = require('../ui/lib/artwork');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'art-test-'));

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

async function settle(art, games) {
    art.ensure(games);
    for (let i = 0; i < 200 && art.pending() > 0; i++) await new Promise(r => setTimeout(r, 10));
}

test('create: downloads Dolphin covers once, remembers misses, honours sidecar images', async () => {
    const roms = tmp(), cache = tmp();
    fs.mkdirSync(path.join(roms, 'wii')); fs.mkdirSync(path.join(roms, 'switch'));
    fs.writeFileSync(path.join(roms, 'wii/Sports.iso'), Buffer.concat([Buffer.from('RSPE01'), Buffer.alloc(64)]));
    fs.writeFileSync(path.join(roms, 'wii/Unknown.iso'), Buffer.concat([Buffer.from('RUNE01'), Buffer.alloc(64)]));
    fs.writeFileSync(path.join(roms, 'switch/Odyssey.nsp'), 'x');
    fs.writeFileSync(path.join(roms, 'switch/Odyssey.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));

    const requested = [];
    const fetchImpl = async url => {
        requested.push(url);
        return url.endsWith('RSPE01.png')
            ? { ok: true, arrayBuffer: async () => PNG }
            : { ok: false, arrayBuffer: async () => Buffer.alloc(0) };
    };
    const games = [
        { id: 'wii1', title: 'Sports', emulator: 'dolphin', path: 'wii/Sports.iso' },
        { id: 'wii2', title: 'Unknown', emulator: 'dolphin', path: 'wii/Unknown.iso' },
        { id: 'sw1', title: 'Odyssey', emulator: 'ryujinx', path: 'switch/Odyssey.nsp' }
    ];

    const art = artwork.create({ cacheDir: cache, romsDir: roms, fetchImpl });
    assert.strictEqual(art.find(games[2]), path.join(roms, 'switch/Odyssey.jpg'));
    await settle(art, games);

    assert.ok(fs.readFileSync(art.find(games[0])).equals(PNG));
    assert.strictEqual(art.find(games[1]), null);
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
