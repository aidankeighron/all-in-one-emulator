const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createManager } = require('../ui/lib/saves/manager');
const adaptersLib = require('../ui/lib/saves/adapters');
const archive = require('../ui/lib/saves/archive');

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
    const settings = { enabled: true, repoUrl: url, deviceName: name, ...cloud };
    const adapters = adaptersLib.create(home);
    const manager = createManager({ dir: tmp(`cfg-${name}`), adapters, getCloud: () => settings });
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

test('saves are pushed as plain files, and nothing but save data goes up', async () => {
    const remote = remoteRepo();
    const a = computer('Desk PC', remote);
    const slot = await a.manager.createSlot(game, 'Main run');
    const r = await playSession(a, slot.id, { 'f.bin': 'moons=12' });
    assert.strictEqual(r.status, 'saved');
    const files = git(remote, 'ls-tree', '-r', '--name-only', 'saves');
    assert.ok(/^saves\/switch__super-mario-odyssey\/[0-9a-f]+\/(data\.zip|meta\.json)$/m.test(files), files);
    assert.ok(!/prod\.keys|firmware|\.nsp|\.iso/i.test(files), 'no keys, firmware or games are ever uploaded');
    const author = git(remote, 'log', '-1', '--format=%an <%ae>', 'saves').trim();
    assert.strictEqual(author, 'Emulator Menu <emulator-menu@localhost>', 'no personal identity in commits');
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



test('a push that was refused leaves nothing behind: the save uploads on the next sync', async () => {
    const remote = remoteRepo();
    // The remote refuses every push (as GitHub does without a sign-in), then is fixed
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "fatal: could not read Username for github.com: terminal prompts disabled" >&2\nexit 1\n', { mode: 0o755 });
    const a = computer('a', remote);
    const slot = await a.manager.createSlot(game, 'First');
    await a.manager.prepare(game, slot.id);
    a.play(slot.id, { 'x.dat': 'progress' });
    const first = await a.manager.finish(game, slot.id);
    assert.notStrictEqual(first.status, 'saved');
    fs.rmSync(hook);
    const synced = await a.manager.syncAll();
    assert.deepStrictEqual(synced.uploaded, ['First'], 'the queued save goes up once the remote accepts it');
    const b = computer('b', remote);
    const list = await b.manager.listSlots(game);
    assert.strictEqual(list.slots.length, 1);
    assert.strictEqual(list.slots[0].rev, 1);
});

test('a save the emulator already had can become a slot, and is not offered again', async () => {
    const c = computer('a', 'x', { enabled: false });
    const real = path.join(c.home, '.var/app/io.github.ryubing.Ryujinx/config/Ryujinx/bis/user/save/0000000000000001');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'file.bin'), 'old progress');
    assert.strictEqual((await c.manager.listSlots(game)).existing, true);
    const slot = await c.manager.importExisting(game, 'Original');
    assert.strictEqual(c.read(slot.id, '0000000000000001/file.bin'), 'old progress');
    assert.ok(fs.existsSync(path.join(real, 'file.bin')), 'the original is left in place');
    assert.strictEqual((await c.manager.listSlots(game)).existing, false);
});
