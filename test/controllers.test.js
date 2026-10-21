const test = require('node:test');
const assert = require('node:assert');

const controllers = require('../ui/lib/controllers');

const dev = (name, { bus = '0003', vendor, product, handlers }) =>
    `I: Bus=${bus} Vendor=${vendor} Product=${product} Version=0110\nN: Name="${name}"\nP: Phys=\nS: Sysfs=/devices/x\nU: Uniq=\nH: Handlers=${handlers}\nB: PROP=0\n`;

const PROC = [
    dev('AT Translated Set 2 keyboard', { bus: '0011', vendor: '0001', product: '0001', handlers: 'sysrq kbd event3 leds' }),
    dev('Microsoft X-Box 360 pad', { vendor: '045e', product: '028e', handlers: 'event5 js0' }),
    dev('Nintendo Switch Pro Controller', { bus: '0005', vendor: '057e', product: '2009', handlers: 'event6 js1' }),
    dev('Nintendo Wii Remote', { bus: '0005', vendor: '057e', product: '0306', handlers: 'event7 js2' }),
    dev('Nintendo Wii Remote Accelerometer', { bus: '0005', vendor: '057e', product: '0306', handlers: 'event8 js3' }),
    dev('Nintendo Wii Remote IR', { bus: '0005', vendor: '057e', product: '0306', handlers: 'event9 js4' }),
    dev('Logitech USB Optical Mouse', { vendor: '046d', product: 'c077', handlers: 'mouse0 event4' }),
    dev('8BitDo Pro 2', { bus: '0005', vendor: '2dc8', product: '6003', handlers: 'event10 js5' })
].join('\n');

test('parseProc reads names, ids and handlers', () => {
    const list = controllers.parseProc(PROC);
    assert.strictEqual(list.length, 8);
    const xbox = list.find(d => d.name === 'Microsoft X-Box 360 pad');
    assert.deepStrictEqual({ v: xbox.vendor, p: xbox.product, js: xbox.js, ev: xbox.event }, { v: '045e', p: '028e', js: 0, ev: 5 });
    assert.strictEqual(list[0].js, null);
});

test('classify recognises each family', () => {
    assert.strictEqual(controllers.classify({ name: 'Microsoft X-Box 360 pad', vendor: '045e' }), 'xbox');
    assert.strictEqual(controllers.classify({ name: 'Xbox Wireless Controller', vendor: '045e' }), 'xbox');
    assert.strictEqual(controllers.classify({ name: 'Nintendo Switch Pro Controller', vendor: '057e', product: '2009' }), 'switch');
    assert.strictEqual(controllers.classify({ name: 'Joy-Con (L)', vendor: '057e', product: '2006' }), 'switch');
    assert.strictEqual(controllers.classify({ name: 'Nintendo Wii Remote', vendor: '057e', product: '0306' }), 'wiimote');
    assert.strictEqual(controllers.classify({ name: 'Nintendo GameCube Controller Adapter', vendor: '057e', product: '0337' }), 'gamecube');
    assert.strictEqual(controllers.classify({ name: 'Some Pad', vendor: '1234' }), 'generic');
});

test('build keeps real controllers, drops keyboards, mice and Wii Remote sub-devices', () => {
    const list = controllers.build(controllers.parseProc(PROC));
    assert.deepStrictEqual(list.map(c => c.kind), ['xbox', 'switch', 'wiimote', 'generic']);
    assert.deepStrictEqual(list.map(c => c.player), [1, 2, 3, 4]);
    assert.strictEqual(list[1].connection, 'Bluetooth');
    assert.strictEqual(list[0].connection, 'USB');
    assert.deepStrictEqual(list.map(c => c.pad), [true, true, false, true]);
});

test('identical pads get increasing name indexes', () => {
    const two = [
        dev('Microsoft X-Box 360 pad', { vendor: '045e', product: '028e', handlers: 'event5 js0' }),
        dev('Microsoft X-Box 360 pad', { vendor: '045e', product: '028e', handlers: 'event6 js1' })
    ].join('\n');
    const list = controllers.build(controllers.parseProc(two));
    assert.deepStrictEqual(list.map(c => c.nameIndex), [0, 1]);
    assert.deepStrictEqual(list.map(c => c.sdlIndex), [0, 1]);
});

test('an official GameCube adapter is listed once, as the adapter', () => {
    const proc = dev('Nintendo Co., Ltd. GameCube Controller Adapter', { vendor: '057e', product: '0337', handlers: 'event5 js0' });
    const list = controllers.build(controllers.parseProc(proc), [{ vendor: '057e', product: '0337' }]);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].adapter, true);
    assert.strictEqual(list[0].kind, 'gamecube');
});

// ---- two Switch controllers as one
const joycon = (side, over = {}) => ({
    id: `js${side === 'L' ? 3 : 4}`, name: `Joy-Con (${side})`, kind: 'switch', label: 'Switch Controller', connection: 'Bluetooth',
    vendor: '057e', product: side === 'L' ? '2006' : '2007', bus: '0005', version: '0001', js: side === 'L' ? 3 : 4, sdlIndex: 0, nameIndex: 0, pad: true, player: 1, ...over
});
const xbox = () => ({ id: 'js0', name: 'Xbox 360 Controller', kind: 'xbox', label: 'Xbox Controller', connection: 'USB', vendor: '045e', product: '028e', js: 0, nameIndex: 0, pad: true, player: 1 });

test('a left and a right Joy-Con are combined into one controller on their own', () => {
    const out = controllers.combine([xbox(), joycon('R'), joycon('L')]);
    assert.deepStrictEqual(out.map(c => c.name), ['Xbox 360 Controller', 'Joy-Con pair']);
    const pair = out[1];
    assert.ok(pair.combined && pair.pad);
    assert.strictEqual(pair.kind, 'switch');
    assert.strictEqual(pair.sdlName, 'Nintendo Switch Joy-Con (L/R)');
    assert.deepStrictEqual(pair.memberNames, ['Joy-Con (L)', 'Joy-Con (R)'], 'left first, whatever order they were found in');
    assert.match(controllers.keyOf(pair), /^pad:combo:/);
    assert.deepStrictEqual(out.map(c => c.player), [1, 2]);
});

test('two Joy-Cons of the same side, or one on its own, stay as they are', () => {
    const list = [joycon('L'), joycon('L', { id: 'js5', nameIndex: 1 })];
    assert.deepStrictEqual(controllers.combine(list), list);
    const alone = [joycon('R')];
    assert.deepStrictEqual(controllers.combine(alone), alone);
});

test('the person can turn automatic combining off, split a pair, or combine any two Switch controllers', () => {
    const l = joycon('L'), r = joycon('R');
    assert.strictEqual(controllers.combine([l, r], { auto: false }).length, 2);
    // a split pair stays split, and other Joy-Cons can still be paired
    const split = controllers.combine([l, r], { splits: [[controllers.keyOf(r), controllers.keyOf(l)]] });
    assert.strictEqual(split.length, 2);
    // by hand: a Pro Controller and a Joy-Con
    const pro = { ...joycon('L'), id: 'js7', name: 'Nintendo Switch Pro Controller', product: '2009', nameIndex: 0 };
    const merged = controllers.combine([pro, r], { auto: false, merges: [[controllers.keyOf(pro), controllers.keyOf(r)]] });
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].sdlName, null, 'only two real Joy-Cons are joined by SDL');
    // a pair whose half is unplugged is just the other half
    assert.strictEqual(controllers.combine([r], { auto: false, merges: [[controllers.keyOf(pro), controllers.keyOf(r)]] }).length, 1);
});

test('detect applies the combining to what it found', () => {
    const proc = [
        dev('Nintendo Switch Left Joy-Con', { bus: '0005', vendor: '057e', product: '2006', handlers: 'event6 js1' }),
        dev('Nintendo Switch Right Joy-Con', { bus: '0005', vendor: '057e', product: '2007', handlers: 'event7 js2' })
    ].join('\n');
    const file = require('path').join(require('os').tmpdir(), `proc-${process.pid}.txt`);
    require('fs').writeFileSync(file, proc);
    assert.strictEqual(controllers.detect({ platform: 'linux', procFile: file, usbRoot: '/nonexistent' }).length, 2);
    const merged = controllers.detect({ platform: 'linux', procFile: file, usbRoot: '/nonexistent', merge: { auto: true } });
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].name, 'Joy-Con pair');
});
