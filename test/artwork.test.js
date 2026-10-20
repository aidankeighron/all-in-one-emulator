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

// ---------- finding covers by name ----------

const page = (title, description, index, thumb = `https://upload.wikimedia.org/${index}.png`) => ({ title, description, index, thumbnail: { source: thumb } });

test('the right article is picked: same game, not a series, not a different game', () => {
    const results = [
        page('Super Mario (series)', 'Video game series', 1),
        page('Super Mario Odyssey', '2017 video game', 2),
        page('Super Mario Odyssey (soundtrack)', 'Soundtrack album for the video game', 3),
        page('Super Mario Bros.', '1985 video game', 4),
        { title: 'Mario Kart', description: 'Racing video game' , index: 5 }            // no picture
    ];
    assert.deepStrictEqual(artwork.chooseCovers(results, 'Super Mario Odyssey'), ['https://upload.wikimedia.org/2.png']);
});

test('punctuation, case, small words and edition tags do not stop a match', () => {
    assert.ok(artwork.titleMatch('The Legend of Zelda: Breath of the Wild', 'The Legend of Zelda Breath of the Wild') === 1);
    assert.ok(artwork.titleMatch('Pokémon Sword and Shield', 'Pokemon Sword & Shield') === 1);
    assert.ok(artwork.titleMatch('Mario Kart 8 Deluxe', 'Mario Kart 8 Deluxe (USA)') === 1);
    assert.ok(artwork.titleMatch('Mario Kart 8', 'Mario Kart 8 Deluxe') < 0.9);
    assert.strictEqual(artwork.titleMatch('Zelda', 'Metroid'), 0);
});

test('no game article, or one that is not about a game, means no picture', () => {
    assert.deepStrictEqual(artwork.chooseCovers([page('Odyssey', 'Epic poem by Homer', 1)], 'Super Mario Odyssey'), []);
    assert.deepStrictEqual(artwork.chooseCovers([page('Mario Kart 8 Deluxe', '2017 video game', 1)], 'Totally Different Game'), []);
    assert.deepStrictEqual(artwork.chooseCovers([], 'Anything'), []);
});

test('Switch games get their cover by name, once, with a polite user agent', async () => {
    const roms = tmp(), cache = tmp();
    fs.mkdirSync(path.join(roms, 'switch'));
    fs.writeFileSync(path.join(roms, 'switch/Super Mario Odyssey [0100000000010000][v0].nsp'), 'x');
    fs.writeFileSync(path.join(roms, 'switch/Obscure Game.nsp'), 'x');
    const game = { id: 'sw1', title: 'Super Mario Odyssey', console: 'switch', emulator: 'ryujinx', path: 'switch/Super Mario Odyssey [0100000000010000][v0].nsp' };
    const obscure = { id: 'sw2', title: 'Obscure Game', console: 'switch', emulator: 'ryujinx', path: 'switch/Obscure Game.nsp' };

    const requests = [];
    const fetchImpl = async (url, opts = {}) => {
        requests.push({ url: String(url), ua: opts.headers && opts.headers['User-Agent'] });
        if (String(url).startsWith('https://en.wikipedia.org/w/api.php')) {
            const q = new URL(url).searchParams.get('gsrsearch');
            const pages = /Odyssey/.test(q) ? { 1: page('Super Mario Odyssey', '2017 video game', 1, 'https://upload.wikimedia.org/odyssey.png') } : {};
            return { ok: true, json: async () => ({ query: { pages } }) };
        }
        return url.endsWith('odyssey.png') ? { ok: true, arrayBuffer: async () => PNG } : { ok: false, arrayBuffer: async () => Buffer.alloc(0) };
    };
    const art = artwork.create({ cacheDir: cache, romsDir: roms, fetchImpl });
    await settle(art, [game, obscure]);

    assert.ok(fs.readFileSync(art.find(game)).equals(PNG));
    assert.strictEqual(art.find(obscure), null);
    const search = requests.find(r => r.url.includes('Odyssey') && r.url.includes('wikipedia'));
    assert.match(new URL(search.url).searchParams.get('gsrsearch'), /^Super Mario Odyssey Nintendo Switch video game$/);
    assert.ok(requests.every(r => r.ua && /EmulatorMenu/.test(r.ua)), 'every request names the app');

    const before = requests.length;
    await settle(art, [game, obscure]);
    assert.strictEqual(requests.length, before, 'found covers and known misses are not searched again');

    // The refresh button forgets the misses so the next look tries them again
    assert.strictEqual(art.retryMisses(), 1);
    await settle(art, [game, obscure]);
    assert.ok(requests.length > before);
});

test('a search that cannot reach the network is retried later, not remembered as a miss', async () => {
    const roms = tmp(), cache = tmp();
    fs.mkdirSync(path.join(roms, 'switch'));
    fs.writeFileSync(path.join(roms, 'switch/Game.nsp'), 'x');
    const game = { id: 'sw9', title: 'Super Mario Odyssey', console: 'switch', emulator: 'ryujinx', path: 'switch/Game.nsp' };
    let online = false;
    const fetchImpl = async url => {
        if (!online) throw new Error('offline');
        if (String(url).includes('wikipedia')) return { ok: true, json: async () => ({ query: { pages: { 1: page('Super Mario Odyssey', 'video game', 1, 'https://upload.wikimedia.org/o.png') } } }) };
        return { ok: true, arrayBuffer: async () => PNG };
    };
    const art = artwork.create({ cacheDir: cache, romsDir: roms, fetchImpl });
    await settle(art, [game]);
    assert.strictEqual(art.find(game), null);
    online = true;
    await settle(art, [game]);
    assert.ok(art.find(game));
});
