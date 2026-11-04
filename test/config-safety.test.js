// config.json is never written back empty because it could not be read, and is never seen half-written
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgsafe-'));
process.env.APPDATA = process.env.XDG_CONFIG_HOME;
const config = require('../ui/lib/config');

test('a config file that cannot be read does not wipe the favorites on the next change', () => {
    config.setFavorite('wii/Game A.iso', true);
    config.setFavorite('wii/Game B.iso', true);
    config.setTheme('dark');
    assert.ok(fs.existsSync(`${config.configFile}.bak`), 'the previous file is kept');
    // something leaves the file broken (half written by another copy of the menu, a crash, a full disk)
    fs.writeFileSync(config.configFile, '{"favorites": ["wii/Gam');
    config.setPauseHold(1);                 // the next change
    assert.deepStrictEqual(config.getFavorites(), ['wii/Game A.iso', 'wii/Game B.iso']);
    assert.strictEqual(config.getTheme(), 'dark');
    assert.strictEqual(JSON.parse(fs.readFileSync(config.configFile, 'utf8')).pauseHold, 1);
    assert.ok(!fs.readdirSync(path.dirname(config.configFile)).some(f => f.includes('.tmp-')), 'no temporary files left behind');
});

test('deleting config.json on purpose starts over', () => {
    fs.rmSync(config.configFile);
    assert.deepStrictEqual(config.getFavorites(), []);
});
