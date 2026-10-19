const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createManager } = require('../ui/lib/saves/manager');
const adaptersLib = require('../ui/lib/saves/adapters');
const archive = require('../ui/lib/saves/archive');
const crypto = require('../ui/lib/saves/crypto');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `saves-${p}-`));
const game = { title: 'Super Mario Odyssey', console: 'switch', emulator: 'ryujinx', path: 'switch/Odyssey.nsp' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function remoteRepo() {
    const dir = tmp('remote');
    execFileSync('git', ['init', '-q', '--bare', dir]);
    return dir;
}

// One simulated computer: its own home folder (with a Ryujinx data folder), config dir and manager
function computer(name, url, cloud = {}) {
    const home = tmp(`home-${name}`);
    fs.mkdirSync(path.join(home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx/system'), { recursive: true });
    fs.writeFileSync(path.join(home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx/system/prod.keys'), 'keys');
    const settings = { enabled: true, repoUrl: url, passphrase: '', deviceName: name, ...cloud };
    const adapters = adaptersLib.create(home);
    const manager = createManager({ dir: tmp(`cfg-${name}`), adapters, getCloud: () => settings, visibility: async () => settings.visible || 'private' });
    const adapter = adapters.get('ryujinx');
    // What the emulator would do while the game runs
    const play = (slotId, files) => {
        const root = adapter.slotRoot(slotId);
        for (const [rel, data] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, 'bis/user/save', rel)), { recursive: true });
            fs.writeFileSync(path.join(root, 'bis/user/save', rel), data);
        }
    };
    const read = (slotId, rel) => fs.readFileSync(path.join(adapter.slotRoot(slotId), 'bis/user/save', rel), 'utf8');
    return { home, manager, adapter, settings, play, read, name };
}

async function playSession(c, slotId, files) {
    const prep = await c.manager.prepare(game, slotId);
    assert.ok(prep.ok, 'prepare should succeed');
    c.play(slotId, files);
    return c.manager.finish(game, slotId);
}

test('adapter: slot root links shared data and owns the save folders (Ryujinx)', () => {
    const c = computer('a', 'x');
    const root = c.adapter.slotRoot('s1');
    c.adapter.assemble(root);
    assert.ok(fs.lstatSync(path.join(root, 'system')).isSymbolicLink(), 'keys and firmware are shared');
    assert.ok(fs.lstatSync(path.join(root, 'bis/user/save')).isDirectory() && !fs.lstatSync(path.join(root, 'bis/user/save')).isSymbolicLink());
    assert.deepStrictEqual(c.adapter.args(root), ['-r', root]);
});

test('adapter: Ryujinx must have been opened once', () => {
    const c = computer('a', 'x');
    fs.rmSync(path.join(c.home, '.var'), { recursive: true });
    assert.throws(() => c.adapter.assemble(c.adapter.slotRoot('s1')), /Open Ryujinx once/);
});

test('adapter: Dolphin slot keeps GameCube cards and Wii game saves per slot, shares the rest', () => {
    const home = tmp('dolphin');
    const app = path.join(home, '.var/app/org.DolphinEmu.dolphin-emu');
    fs.mkdirSync(path.join(app, 'data/dolphin-emu/Wii/title/00010001'), { recursive: true });
    fs.mkdirSync(path.join(app, 'data/dolphin-emu/GC'), { recursive: true });
    fs.mkdirSync(path.join(app, 'data/dolphin-emu/Load'), { recursive: true });
    const a = adaptersLib.create(home).get('dolphin');
    const root = a.slotRoot('s1');
    a.assemble(root);
    const isLink = p => fs.lstatSync(path.join(root, p)).isSymbolicLink();
    assert.ok(isLink('Config') && isLink('Cache') && isLink('Load') && isLink('Wii/title/00010001'));
    assert.ok(!isLink('GC') && !isLink('Wii') && !isLink('Wii/title') && !isLink('Wii/title/00010000'));
    assert.deepStrictEqual(a.args(root), ['-u', root]);
});

test('a save made on one computer shows up and plays on another', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote), b = computer('Living Room PC', remote);
    const slot = await a.manager.createSlot(game, 'Main run');
    const r = await playSession(a, slot.id, { '0001/progress.bin': 'moons=12' });
    assert.strictEqual(r.status, 'saved');

    const listed = await b.manager.listSlots(game);
    assert.strictEqual(listed.online, true);
    assert.deepStrictEqual(listed.slots.map(s => [s.name, s.device, s.rev]), [['Main run', 'Desk PC', 1]]);

    const prep = await b.manager.prepare(game, slot.id);
    assert.ok(prep.ok);
    assert.strictEqual(b.read(slot.id, '0001/progress.bin'), 'moons=12');

    // B plays on, A comes back and gets B's progress before starting
    await playSession(b, slot.id, { '0001/progress.bin': 'moons=30' });
    await a.manager.prepare(game, slot.id);
    assert.strictEqual(a.read(slot.id, '0001/progress.bin'), 'moons=30');
});

test('a game that changed nothing uploads nothing', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote);
    const slot = await a.manager.createSlot(game, 'Empty');
    assert.strictEqual((await a.manager.prepare(game, slot.id)).ok, true);
    assert.strictEqual((await a.manager.finish(game, slot.id)).status, 'unchanged');
    assert.strictEqual(git(remote, 'branch', '--list').trim(), '');
});

test('conflict: the same save changed on two computers asks, and each answer works', async () => {
    for (const choice of ['cloud', 'local', 'both']) {
        const remote = remoteRepo();
        const a = computer('Desk PC', remote), b = computer('Living Room PC', remote);
        const slot = await a.manager.createSlot(game, 'Main run');
        await playSession(a, slot.id, { 'f.bin': 'base' });
        await b.manager.prepare(game, slot.id);

        await playSession(b, slot.id, { 'f.bin': 'from-b' });           // B uploads rev 2
        a.play(slot.id, { 'f.bin': 'from-a' });                          // A changes it from rev 1
        const r = await a.manager.finish(game, slot.id);
        assert.strictEqual(r.status, 'conflict', 'upload must not overwrite B');

        const prep = await a.manager.prepare(game, slot.id);
        assert.ok(prep.conflict, 'prepare reports the conflict');
        assert.strictEqual(prep.conflict.remote.device, 'Living Room PC');

        await a.manager.resolve(game, slot.id, choice);
        const fresh = computer('Third', remote);
        const slots = (await fresh.manager.listSlots(game)).slots;
        if (choice === 'cloud') {
            assert.strictEqual(a.read(slot.id, 'f.bin'), 'from-b');
            assert.strictEqual(slots.length, 1);
        } else if (choice === 'local') {
            assert.strictEqual(a.read(slot.id, 'f.bin'), 'from-a');
            await fresh.manager.prepare(game, slot.id);
            assert.strictEqual(fresh.read(slot.id, 'f.bin'), 'from-a');
        } else {
            assert.strictEqual(a.read(slot.id, 'f.bin'), 'from-b');
            assert.deepStrictEqual(slots.map(s => s.name).sort(), ['Main run', 'Main run (this computer)']);
            const copy = slots.find(s => s.name.includes('this computer'));
            await fresh.manager.prepare(game, copy.id);
            assert.strictEqual(fresh.read(copy.id, 'f.bin'), 'from-a');
        }
    }
});

test('offline: the save is queued, and goes up on the next sync', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', path.join(os.tmpdir(), 'definitely-not-a-repo'));
    const slot = await a.manager.createSlot(game, 'Main run');
    const listed = await a.manager.listSlots(game);
    assert.strictEqual(listed.online, false);
    assert.strictEqual(listed.slots.length, 1, 'local saves still listed offline');

    const r = await playSession(a, slot.id, { 'f.bin': 'offline-progress' });
    assert.strictEqual(r.status, 'queued');
    assert.strictEqual(a.manager.activity().state, 'queued');

    a.settings.repoUrl = remote;                          // back online
    const sync = await a.manager.syncAll();
    assert.deepStrictEqual(sync.uploaded, ['Main run']);
    const b = computer('Other', remote);
    await b.manager.prepare(game, slot.id);
    assert.strictEqual(b.read(slot.id, 'f.bin'), 'offline-progress');
});

test('syncAll downloads newer saves for slots already on this computer', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote), b = computer('Living Room PC', remote);
    const slot = await a.manager.createSlot(game, 'Main run');
    await playSession(a, slot.id, { 'f.bin': 'one' });
    await b.manager.prepare(game, slot.id);
    await playSession(a, slot.id, { 'f.bin': 'two' });
    const sync = await b.manager.syncAll();
    assert.deepStrictEqual(sync.updated, [{ name: 'Main run', device: 'Desk PC' }]);
    assert.strictEqual(b.read(slot.id, 'f.bin'), 'two');
});

test('encrypted: the repository holds no readable names or data, and needs the right passphrase', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote, { passphrase: 'correct horse' });
    const slot = await a.manager.createSlot(game, 'Secret slot name');
    await playSession(a, slot.id, { 'f.bin': 'TOP-SECRET-PROGRESS' });

    const files = git(remote, 'ls-tree', '-r', '--name-only', 'saves');
    assert.ok(!/odyssey|switch|secret/i.test(files), `names should be opaque: ${files}`);
    const everything = git(remote, 'log', '-p', '--all', '--format=%an %ae %s');
    assert.ok(!everything.includes('TOP-SECRET') && !everything.includes('Secret slot') && !everything.includes('Desk PC'));

    const good = computer('Other', remote, { passphrase: 'correct horse' });
    assert.strictEqual((await good.manager.listSlots(game)).slots[0].name, 'Secret slot name');
    await good.manager.prepare(game, slot.id);
    assert.strictEqual(good.read(slot.id, 'f.bin'), 'TOP-SECRET-PROGRESS');

    const bad = computer('Intruder', remote, { passphrase: 'wrong' });
    const listed = await bad.manager.listSlots(game);
    assert.strictEqual(listed.problem.code, 'BAD_PASSPHRASE');
    const none = computer('Nobody', remote);
    assert.strictEqual((await none.manager.listSlots(game)).problem.code, 'NEED_PASSPHRASE');
});

test('a public repository refuses unencrypted saves', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote, { visible: 'public' });
    const slot = await a.manager.createSlot(game, 'Main run');
    const r = await playSession(a, slot.id, { 'f.bin': 'data' });
    assert.strictEqual(r.status, 'queued');
    assert.strictEqual(a.manager.activity().state, 'error');
    assert.match(a.manager.activity().message, /public/);
    assert.strictEqual(git(remote, 'branch', '--list').trim(), '', 'nothing was pushed');
});

test('rename and delete reach the cloud', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote), b = computer('Other', remote);
    const slot = await a.manager.createSlot(game, 'Old name');
    await playSession(a, slot.id, { 'f.bin': 'x' });
    await a.manager.renameSlot(game, slot.id, 'New name');
    assert.strictEqual((await b.manager.listSlots(game)).slots[0].name, 'New name');
    await a.manager.deleteSlot(game, slot.id);
    assert.strictEqual((await b.manager.listSlots(game)).slots.length, 0);
});

test('history keeps older versions and restore brings one back as a new version', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote);
    const slot = await a.manager.createSlot(game, 'Main run');
    await playSession(a, slot.id, { 'f.bin': 'v1' });
    await playSession(a, slot.id, { 'f.bin': 'v2' });
    await playSession(a, slot.id, { 'f.bin': 'v3' });
    const versions = await a.manager.history(game, slot.id);
    assert.deepStrictEqual(versions.map(v => v.rev), [3, 2, 1]);
    await a.manager.restore(game, slot.id, versions[2].sha);
    assert.strictEqual(a.read(slot.id, 'f.bin'), 'v1');
    const after = await a.manager.history(game, slot.id);
    assert.strictEqual(after[0].rev, 4, 'restoring is itself a new version');
});

test('local backup is kept before a download replaces a changed save', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote), b = computer('Other', remote);
    const slot = await a.manager.createSlot(game, 'Main run');
    await playSession(a, slot.id, { 'f.bin': 'base' });
    await b.manager.prepare(game, slot.id);
    await playSession(b, slot.id, { 'f.bin': 'b' });
    a.play(slot.id, { 'f.bin': 'local-edit' });
    await a.manager.finish(game, slot.id);
    await a.manager.resolve(game, slot.id, 'cloud');
    const backups = fs.readdirSync(path.join(a.manager.dir, 'backups'));
    assert.strictEqual(backups.length, 1);
    const restored = path.join(tmp('restore'), 'x');
    await archive.unzipTo(path.join(a.manager.dir, 'backups', backups[0]), restored);
    assert.strictEqual(fs.readFileSync(path.join(restored, 'bis/user/save/f.bin'), 'utf8'), 'local-edit');
});

test('crypto round trip and tamper detection', () => {
    const keys = crypto.deriveKeys('pw', crypto.newSalt());
    const box = crypto.encrypt(Buffer.from('hello'), keys.enc);
    assert.strictEqual(crypto.decrypt(box, keys.enc).toString(), 'hello');
    box[box.length - 1] ^= 1;
    assert.throws(() => crypto.decrypt(box, keys.enc), /wrong passphrase/);
});

