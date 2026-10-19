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
    dev('Sony Interactive Entertainment Wireless Controller', { bus: '0005', vendor: '054c', product: '0ce6', handlers: 'event10 js5' })
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
    assert.strictEqual(controllers.classify({ name: 'Wireless Controller', vendor: '054c' }), 'playstation');
    assert.strictEqual(controllers.classify({ name: 'Some Pad', vendor: '1234' }), 'generic');
});

test('build keeps real controllers, drops keyboards, mice and Wii Remote sub-devices', () => {
    const list = controllers.build(controllers.parseProc(PROC));
    assert.deepStrictEqual(list.map(c => c.kind), ['xbox', 'switch', 'wiimote', 'playstation']);
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
