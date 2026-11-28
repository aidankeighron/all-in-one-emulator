// @ts-check

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Creates a temporary directory for server validation tests.
 * @param {string} prefix
 * @returns {string}
 */
function createTempDirectory(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `srvval-${prefix}-`));
}

const home = createTempDirectory('home');
const configHome = createTempDirectory('cfg');
const romsDir = createTempDirectory('roms');
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = configHome;
process.env.APPDATA = configHome;
process.env.ROMS_DIR = romsDir;

fs.mkdirSync(path.join(romsDir, 'wii'), { recursive: true });
fs.mkdirSync(path.join(romsDir, 'switch'), { recursive: true });

const validWiiIso = Buffer.alloc(0x100);
validWiiIso.write('RSPE01', 0, 'latin1');
validWiiIso.writeUInt32BE(0x5d1c9ea3, 0x18);
fs.writeFileSync(path.join(romsDir, 'wii', 'Valid Game.iso'), validWiiIso);
fs.writeFileSync(path.join(romsDir, 'wii', 'Broken Game.iso'), '');
fs.writeFileSync(path.join(romsDir, 'switch', 'Corrupt.nsp'), 'not an nsp');

const server = require('../ui/server');

/**
 * Sends a JSON HTTP request to the local test server.
 * @param {number} port
 * @param {string} method
 * @param {string} urlPath
 * @returns {Promise<{ status: number, body: any }>}
 */
async function requestJson(port, method, urlPath) {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Origin: `http://127.0.0.1:${port}`
        }
    });
    return { status: response.status, body: await response.json() };
}

test('GET /api/games attaches validation results and POST /api/games/validate re-checks', async () => {
    const { server: httpServer, port } = await server.start({ port: 0 });
    try {
        const gamesResponse = await requestJson(port, 'GET', '/api/games');
        assert.strictEqual(gamesResponse.status, 200);
        const byTitle = Object.fromEntries(gamesResponse.body.games.map((/** @type {any} */ game) => [game.title, game]));

        assert.strictEqual(byTitle['Valid Game'].validation.status, 'ok');
        assert.strictEqual(byTitle['Valid Game'].validation.code, null);

        assert.strictEqual(byTitle['Broken Game'].validation.status, 'error');
        assert.strictEqual(byTitle['Broken Game'].validation.code, 'EMPTY_FILE');

        assert.strictEqual(byTitle['Corrupt'].validation.status, 'error');
        assert.strictEqual(byTitle['Corrupt'].validation.code, 'BAD_HEADER');

        // Fix Broken Game on disk and trigger POST /api/games/validate
        fs.writeFileSync(path.join(romsDir, 'wii', 'Broken Game.iso'), validWiiIso);
        const validateResponse = await requestJson(port, 'POST', '/api/games/validate');
        assert.strictEqual(validateResponse.status, 200);
        assert.strictEqual(validateResponse.body.count, 3);
        assert.strictEqual(validateResponse.body.errors, 1);

        const refreshed = await requestJson(port, 'GET', '/api/games');
        const refreshedByTitle = Object.fromEntries(refreshed.body.games.map((/** @type {any} */ game) => [game.title, game]));
        assert.strictEqual(refreshedByTitle['Broken Game'].validation.status, 'ok');
    }
    finally {
        httpServer.close();
    }
});

test('server.start runs fresh static validation on load and ignores stale cache from prior sessions', async () => {
    const cacheFile = path.join(configHome, 'all-in-one-emulator', 'validation-cache.json');
    const validPath = path.join(romsDir, 'wii', 'Valid Game.iso');
    const brokenPath = path.join(romsDir, 'wii', 'Broken Game.iso');
    const brokenStat = fs.statSync(brokenPath);

    // Seed a deliberately stale "error" result matching the current file size/mtime in the disk cache.
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
        cacheFile,
        JSON.stringify({
            version: 1,
            entries: {
                'wii/Broken Game.iso': {
                    size: brokenStat.size,
                    mtimeMs: Math.round(brokenStat.mtimeMs),
                    keysSignature: 'n/a',
                    result: {
                        status: 'error',
                        code: 'EMPTY_FILE',
                        reason: 'Stale cached error from previous run',
                        checkedAt: 1
                    }
                }
            }
        })
    );

    // Server start clears prior session cache and runs static validation proactively on load.
    const { server: httpServer } = await server.start({ port: 0 });
    try {
        let written = null;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            if (fs.existsSync(cacheFile)) {
                const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                if (parsed.entries && parsed.entries['wii/Broken Game.iso'] && parsed.entries['wii/Valid Game.iso']) {
                    written = parsed.entries;
                    break;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        assert.ok(written, 'expected startup load validation to populate validation-cache.json without hitting /api/games');
        assert.strictEqual(written['wii/Valid Game.iso'].result.status, 'ok');
        assert.strictEqual(written['wii/Broken Game.iso'].result.status, 'ok');
        assert.strictEqual(fs.existsSync(validPath), true);
    }
    finally {
        httpServer.close();
    }
});
