// @ts-check

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const { RomValidator, validateFile } = require('../ui/lib/validate');
const { ValidationCache } = require('../ui/lib/validation-cache');

/**
 * Creates a temporary directory for test fixtures.
 * @param {string} prefix
 * @returns {string}
 */
function createTempDirectory(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `validate-${prefix}-`));
}

/**
 * Writes a minimal ZIP archive containing the provided entries.
 * @param {string} filePath
 * @param {Record<string, Buffer>} entries
 * @returns {Promise<void>}
 */
function createZipFile(filePath, entries) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        for (const [name, data] of Object.entries(entries)) {
            zip.addBuffer(data, name);
        }
        zip.end();
        zip.outputStream.pipe(fs.createWriteStream(filePath)).on('close', resolve).on('error', reject);
    });
}

/**
 * Builds a minimal valid GameCube ISO header buffer.
 * @returns {Buffer}
 */
function createGameCubeIsoBuffer() {
    const buffer = Buffer.alloc(0x100);
    buffer.write('GALE01', 0, 'latin1');
    buffer.writeUInt32BE(0xc2339f3d, 0x1c);
    return buffer;
}

/**
 * Builds a minimal valid Wii ISO header buffer.
 * @returns {Buffer}
 */
function createWiiIsoBuffer() {
    const buffer = Buffer.alloc(0x100);
    buffer.write('RSPE01', 0, 'latin1');
    buffer.writeUInt32BE(0x5d1c9ea3, 0x18);
    return buffer;
}

/**
 * Builds a minimal valid RVZ or WIA header buffer.
 * @param {'RVZ\x01' | 'WIA\x01'} magic
 * @param {number} discType
 * @param {bigint} [declaredSize]
 * @returns {Buffer}
 */
function createRvzOrWiaBuffer(magic, discType, declaredSize = 0n) {
    const buffer = Buffer.alloc(0x100);
    buffer.write(magic, 0, 'latin1');
    buffer.writeBigUInt64BE(declaredSize, 0x2c);
    buffer.writeUInt32BE(discType, 0x48);
    return buffer;
}

/**
 * Builds a minimal valid NSP (PFS0) buffer with one file entry.
 * @param {number} payloadSize
 * @param {boolean} [truncatePayload]
 * @returns {Buffer}
 */
function createNspBuffer(payloadSize, truncatePayload = false) {
    const fileName = Buffer.from('main.nca\x00', 'utf8');
    const header = Buffer.alloc(16 + 24 + fileName.length);
    header.write('PFS0', 0, 'latin1');
    header.writeUInt32LE(1, 0x04);
    header.writeUInt32LE(fileName.length, 0x08);
    header.writeBigUInt64LE(0n, 16);
    header.writeBigUInt64LE(BigInt(payloadSize), 24);
    header.writeUInt32LE(0, 32);
    fileName.copy(header, 16 + 24);
    const actualPayloadLength = truncatePayload ? Math.max(0, payloadSize - 8) : payloadSize;
    return Buffer.concat([header, Buffer.alloc(actualPayloadLength, 1)]);
}

test('validateFile detects missing, empty, invalid path, and unsupported files', async () => {
    const directory = createTempDirectory('basic');
    const missingPath = path.join(directory, 'missing.iso');
    const emptyPath = path.join(directory, 'empty.iso');
    const unknownPath = path.join(directory, 'readme.txt');
    fs.writeFileSync(emptyPath, '');
    fs.writeFileSync(unknownPath, 'hello');

    const missingResult = await validateFile(missingPath);
    assert.strictEqual(missingResult.status, 'error');
    assert.strictEqual(missingResult.code, 'MISSING_FILE');
    assert.strictEqual(typeof missingResult.checkedAt, 'number');

    const invalidPathResult = await validateFile('bad\0path.iso');
    assert.strictEqual(invalidPathResult.status, 'error');
    assert.strictEqual(invalidPathResult.code, 'MISSING_FILE');

    const emptyResult = await validateFile(emptyPath);
    assert.strictEqual(emptyResult.status, 'error');
    assert.strictEqual(emptyResult.code, 'EMPTY_FILE');

    const unknownResult = await validateFile(unknownPath);
    assert.strictEqual(unknownResult.status, 'unknown');
    assert.strictEqual(unknownResult.code, 'UNSUPPORTED_FORMAT');
});

test('validateFile validates Dolphin formats (iso, gcm, rvz, wia, wbfs, ciso, gcz, wad)', async () => {
    const directory = createTempDirectory('dolphin');

    const wiiIso = path.join(directory, 'wii.iso');
    const gcGcm = path.join(directory, 'gc.gcm');
    const badIso = path.join(directory, 'bad.iso');
    const htmlIso = path.join(directory, 'html.iso');
    const rvzFile = path.join(directory, 'game.rvz');
    const truncatedRvz = path.join(directory, 'trunc.rvz');
    const wbfsFile = path.join(directory, 'game.wbfs');
    const cisoFile = path.join(directory, 'game.ciso');
    const gczFile = path.join(directory, 'game.gcz');
    const wadFile = path.join(directory, 'channel.wad');

    fs.writeFileSync(wiiIso, createWiiIsoBuffer());
    fs.writeFileSync(gcGcm, createGameCubeIsoBuffer());
    fs.writeFileSync(badIso, Buffer.alloc(0x100, 0xaa));
    fs.writeFileSync(htmlIso, '<!DOCTYPE html><html><body>404</body></html>');
    fs.writeFileSync(rvzFile, createRvzOrWiaBuffer('RVZ\x01', 2, 0x100n));
    fs.writeFileSync(truncatedRvz, createRvzOrWiaBuffer('RVZ\x01', 2, 0x1000n));

    const wbfsBuffer = Buffer.alloc(0x300);
    wbfsBuffer.write('WBFS', 0, 'latin1');
    wbfsBuffer.writeUInt32BE(0x5d1c9ea3, 0x218);
    fs.writeFileSync(wbfsFile, wbfsBuffer);

    const cisoBuffer = Buffer.alloc(0x8000);
    cisoBuffer.write('CISO', 0, 'latin1');
    cisoBuffer.writeUInt32LE(0x8000, 0x04);
    fs.writeFileSync(cisoFile, cisoBuffer);

    const gczBuffer = Buffer.alloc(0x40);
    gczBuffer.writeUInt32LE(0xb10bc001, 0x00);
    gczBuffer.writeUInt32LE(0x4000, 0x18);
    gczBuffer.writeUInt32LE(1, 0x1c);
    fs.writeFileSync(gczFile, gczBuffer);

    const wadBuffer = Buffer.alloc(128);
    wadBuffer.writeUInt32BE(0x20, 0x00);
    wadBuffer.write('Is\x00\x00', 0x04, 'latin1');
    wadBuffer.writeUInt32BE(32, 0x08);
    fs.writeFileSync(wadFile, wadBuffer);

    assert.strictEqual((await validateFile(wiiIso)).status, 'ok');
    assert.strictEqual((await validateFile(gcGcm)).status, 'ok');
    assert.strictEqual((await validateFile(rvzFile)).status, 'ok');
    assert.strictEqual((await validateFile(wbfsFile)).status, 'ok');
    assert.strictEqual((await validateFile(cisoFile)).status, 'ok');
    assert.strictEqual((await validateFile(gczFile)).status, 'ok');
    assert.strictEqual((await validateFile(wadFile)).status, 'ok');

    const badIsoResult = await validateFile(badIso);
    assert.strictEqual(badIsoResult.status, 'error');
    assert.strictEqual(badIsoResult.code, 'BAD_HEADER');

    const htmlResult = await validateFile(htmlIso);
    assert.strictEqual(htmlResult.status, 'error');
    assert.strictEqual(htmlResult.code, 'BAD_HEADER');
    assert.match(htmlResult.reason, /HTML/i);

    const truncatedResult = await validateFile(truncatedRvz);
    assert.strictEqual(truncatedResult.status, 'error');
    assert.strictEqual(truncatedResult.code, 'BAD_HEADER');
    assert.match(truncatedResult.reason, /truncated/i);
});

test('validateFile validates Switch formats and prod.keys requirements', async () => {
    const directory = createTempDirectory('switch');
    const ryujinxRoot = createTempDirectory('ryujinx');
    fs.mkdirSync(path.join(ryujinxRoot, 'system'), { recursive: true });

    const validNsp = path.join(directory, 'valid.nsp');
    const truncatedNsp = path.join(directory, 'truncated.nsp');
    const validXci = path.join(directory, 'valid.xci');
    const validNro = path.join(directory, 'homebrew.nro');
    const validNso = path.join(directory, 'module.nso');
    const validNca = path.join(directory, 'content.nca');

    fs.writeFileSync(validNsp, createNspBuffer(32, false));
    fs.writeFileSync(truncatedNsp, createNspBuffer(32, true));

    const xciBuffer = Buffer.alloc(0x200);
    xciBuffer.write('HEAD', 0x100, 'latin1');
    fs.writeFileSync(validXci, xciBuffer);

    const nroBuffer = Buffer.alloc(0x80);
    nroBuffer.write('NRO0', 0x10, 'latin1');
    nroBuffer.writeUInt32LE(0x80, 0x18);
    fs.writeFileSync(validNro, nroBuffer);

    const nsoBuffer = Buffer.alloc(0x100);
    nsoBuffer.write('NSO0', 0x00, 'latin1');
    fs.writeFileSync(validNso, nsoBuffer);

    fs.writeFileSync(validNca, Buffer.alloc(0xc00, 0x55));

    // Without prod.keys: encrypted Switch formats report MISSING_KEYS, homebrew NRO/NSO pass
    const missingKeysResult = await validateFile(validNsp, { ryujinxDataRoot: ryujinxRoot });
    assert.strictEqual(missingKeysResult.status, 'error');
    assert.strictEqual(missingKeysResult.code, 'MISSING_KEYS');

    assert.strictEqual((await validateFile(validNro, { ryujinxDataRoot: ryujinxRoot })).status, 'ok');
    assert.strictEqual((await validateFile(validNso, { ryujinxDataRoot: ryujinxRoot })).status, 'ok');

    // Truncated NSP still reports BAD_HEADER even if keys are missing
    const truncatedResult = await validateFile(truncatedNsp, { ryujinxDataRoot: ryujinxRoot });
    assert.strictEqual(truncatedResult.status, 'error');
    assert.strictEqual(truncatedResult.code, 'BAD_HEADER');

    // Add prod.keys and re-validate
    fs.writeFileSync(path.join(ryujinxRoot, 'system', 'prod.keys'), 'header_key = 00\n');
    assert.strictEqual((await validateFile(validNsp, { ryujinxDataRoot: ryujinxRoot })).status, 'ok');
    assert.strictEqual((await validateFile(validXci, { ryujinxDataRoot: ryujinxRoot })).status, 'ok');

    const ncaWithoutTool = await validateFile(validNca, { ryujinxDataRoot: ryujinxRoot, useCliTools: false });
    assert.strictEqual(ncaWithoutTool.status, 'unknown');
    assert.strictEqual(ncaWithoutTool.code, null);
});

test('validateFile detects corrupt or misnamed archives', async () => {
    const directory = createTempDirectory('archives');
    const goodZip = path.join(directory, 'good.zip');
    const badZip = path.join(directory, 'bad.zip');
    const zipAsIso = path.join(directory, 'unextracted.iso');

    await createZipFile(goodZip, { 'game.iso': createWiiIsoBuffer() });
    fs.writeFileSync(badZip, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(32, 1)]));
    fs.copyFileSync(goodZip, zipAsIso);

    assert.strictEqual((await validateFile(goodZip)).status, 'ok');

    const badZipResult = await validateFile(badZip);
    assert.strictEqual(badZipResult.status, 'error');
    assert.strictEqual(badZipResult.code, 'CORRUPT_ARCHIVE');

    const zipAsIsoResult = await validateFile(zipAsIso);
    assert.strictEqual(zipAsIsoResult.status, 'error');
    assert.strictEqual(zipAsIsoResult.code, 'CORRUPT_ARCHIVE');
});

test('ValidationCache reuses entries and invalidates on file or prod.keys changes', async () => {
    const romsDir = createTempDirectory('cache-roms');
    const cacheDir = createTempDirectory('cache-cfg');
    const ryujinxRoot = createTempDirectory('cache-ryujinx');
    fs.mkdirSync(path.join(romsDir, 'wii'), { recursive: true });
    fs.mkdirSync(path.join(romsDir, 'switch'), { recursive: true });
    fs.mkdirSync(path.join(ryujinxRoot, 'system'), { recursive: true });

    const wiiPath = path.join(romsDir, 'wii', 'Sports.iso');
    const switchPath = path.join(romsDir, 'switch', 'Odyssey.nsp');
    fs.writeFileSync(wiiPath, createWiiIsoBuffer());
    fs.writeFileSync(switchPath, createNspBuffer(16, false));

    let callCount = 0;
    const baseValidator = new RomValidator();
    const countingValidator = /** @type {RomValidator} */ ({
        validateFile(filePath, options) {
            callCount++;
            return baseValidator.validateFile(filePath, options);
        }
    });

    const cacheFile = path.join(cacheDir, 'validation-cache.json');
    const cache = new ValidationCache({ cacheFile, validator: countingValidator });
    const games = [
        { id: '1', title: 'Sports', console: 'wii', emulator: 'dolphin', path: 'wii/Sports.iso' },
        { id: '2', title: 'Odyssey', console: 'switch', emulator: 'ryujinx', path: 'switch/Odyssey.nsp' }
    ];

    const first = await cache.validateGames(romsDir, games, { ryujinxDataRoot: ryujinxRoot });
    assert.strictEqual(callCount, 2);
    assert.strictEqual(first.get('wii/Sports.iso')?.status, 'ok');
    assert.strictEqual(first.get('switch/Odyssey.nsp')?.code, 'MISSING_KEYS');

    // Second run with unchanged files and keys uses cache (0 new validateFile calls)
    const second = await cache.validateGames(romsDir, games, { ryujinxDataRoot: ryujinxRoot });
    assert.strictEqual(callCount, 2);
    assert.strictEqual(second.get('wii/Sports.iso')?.status, 'ok');

    // Adding prod.keys invalidates only Switch entry
    fs.writeFileSync(path.join(ryujinxRoot, 'system', 'prod.keys'), 'header_key = 00\n');
    const third = await cache.validateGames(romsDir, games, { ryujinxDataRoot: ryujinxRoot });
    assert.strictEqual(callCount, 3);
    assert.strictEqual(third.get('switch/Odyssey.nsp')?.status, 'ok');

    // Reloading from disk in a fresh ValidationCache instance still hits cache
    const reloadedCache = new ValidationCache({ cacheFile, validator: countingValidator });
    const fourth = await reloadedCache.validateGames(romsDir, games, { ryujinxDataRoot: ryujinxRoot });
    assert.strictEqual(callCount, 3);
    assert.strictEqual(fourth.get('switch/Odyssey.nsp')?.status, 'ok');
});
