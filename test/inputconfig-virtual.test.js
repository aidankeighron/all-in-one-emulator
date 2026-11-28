// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Ini } = require('../ui/lib/ini');
const mappings = require('../ui/lib/mappings');
const inputconfigVirtual = require('../ui/lib/inputconfig-virtual');

/**
 * Creates a temporary isolated home directory for test assertions.
 * @returns {string} Path to the created temporary directory
 */
function createTempHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'inputcfg-virtual-'));
}

/**
 * Returns the Linux Flatpak Dolphin config directory inside a test home.
 * @param {string} home - Temporary home directory
 * @returns {string} Dolphin configuration directory
 */
function linuxDolphinDirectory(home) {
    return path.join(home, '.var', 'app', 'org.DolphinEmu.dolphin-emu', 'config', 'dolphin-emu');
}

/**
 * Returns the Linux Flatpak Ryujinx data root inside a test home.
 * @param {string} home - Temporary home directory
 * @returns {string} Ryujinx configuration directory
 */
function linuxRyujinxDirectory(home) {
    return path.join(home, '.var', 'app', 'io.github.ryubing.Ryujinx', 'config', 'Ryujinx');
}

test('virtualDeviceName returns static names for slots 0-3 and rejects invalid slots', () => {
    assert.strictEqual(inputconfigVirtual.virtualDeviceName(0), 'Virtual Pad 1');
    assert.strictEqual(inputconfigVirtual.virtualDeviceName(1), 'Virtual Pad 2');
    assert.strictEqual(inputconfigVirtual.virtualDeviceName(2), 'Virtual Pad 3');
    assert.strictEqual(inputconfigVirtual.virtualDeviceName(3), 'Virtual Pad 4');

    assert.throws(() => inputconfigVirtual.virtualDeviceName(-1), RangeError);
    assert.throws(() => inputconfigVirtual.virtualDeviceName(4), RangeError);
    assert.throws(() => inputconfigVirtual.virtualDeviceName(1.5), TypeError);
    assert.throws(() => inputconfigVirtual.virtualDeviceName(/** @type {any} */ ('0')), TypeError);
});

test('virtualDeviceGuid returns static Xbox 360 SDL GUIDs for slots 0-3 and rejects invalid slots', () => {
    assert.strictEqual(inputconfigVirtual.virtualDeviceGuid(0), '0-00000003-045e-0000-8e02-000010010000');
    assert.strictEqual(inputconfigVirtual.virtualDeviceGuid(1), '1-00000003-045e-0000-8e02-000010010000');
    assert.strictEqual(inputconfigVirtual.virtualDeviceGuid(2), '2-00000003-045e-0000-8e02-000010010000');
    assert.strictEqual(inputconfigVirtual.virtualDeviceGuid(3), '3-00000003-045e-0000-8e02-000010010000');

    assert.throws(() => inputconfigVirtual.virtualDeviceGuid(-1), RangeError);
    assert.throws(() => inputconfigVirtual.virtualDeviceGuid(4), RangeError);
    assert.throws(() => inputconfigVirtual.virtualDeviceGuid(/** @type {any} */ (null)), TypeError);
});

test('Dolphin writes all 4 static virtual pads, Nunchuk extension, and DSU motion server', () => {
    const home = createTempHome();
    const profiles = mappings.createStore(createTempHome());
    const result = inputconfigVirtual.apply(
        'dolphin',
        { home, platform: 'linux', env: {} },
        {
            activePlayers: 4,
            realWiimotes: [false, false, false, false],
            dsuPort: 26760,
            profiles,
            players: []
        }
    );

    assert.strictEqual(result.emulator, 'dolphin');
    assert.strictEqual(result.status, 'configured');
    assert.strictEqual(result.changed, true);

    const configDirectory = linuxDolphinDirectory(home);
    const mainIni = Ini.read(path.join(configDirectory, 'Dolphin.ini'));
    assert.strictEqual(mainIni.get('Input', 'DSUServerAddress'), '127.0.0.1');
    assert.strictEqual(mainIni.get('Input', 'DSUServerPort'), '26760');
    assert.deepStrictEqual(
        [0, 1, 2, 3].map(index => mainIni.get('Core', `SIDevice${index}`)),
        ['6', '6', '6', '6']
    );

    const gamecubeIni = Ini.read(path.join(configDirectory, 'GCPadNew.ini'));
    for (let index = 0; index < 4; index += 1) {
        const section = `GCPad${index + 1}`;
        assert.strictEqual(gamecubeIni.get(section, 'Device'), `SDL/${index}/Virtual Pad ${index + 1}`);
        assert.strictEqual(gamecubeIni.get(section, 'Buttons/A'), '`Button A`');
    }

    const wiimoteIni = Ini.read(path.join(configDirectory, 'WiimoteNew.ini'));
    for (let index = 0; index < 4; index += 1) {
        const section = `Wiimote${index + 1}`;
        assert.strictEqual(wiimoteIni.get(section, 'Source'), '1');
        assert.strictEqual(wiimoteIni.get(section, 'Device'), `SDL/${index}/Virtual Pad ${index + 1}`);
        assert.strictEqual(wiimoteIni.get(section, 'Extension'), 'Nunchuk');
    }
});

test('Dolphin honors realWiimotes Source = 2 and game scope (wii vs gamecube)', () => {
    const home = createTempHome();
    const profiles = mappings.createStore(createTempHome());

    // 2 virtual pads + slot 2 is a real Wii Remote (index 1)
    const wiiResult = inputconfigVirtual.apply(
        'dolphin',
        { home, platform: 'linux', env: {} },
        {
            activePlayers: 3,
            realWiimotes: [false, true, false, false],
            game: 'wii',
            dsuPort: 26765,
            profiles,
            players: []
        }
    );

    assert.strictEqual(wiiResult.status, 'configured');
    assert.strictEqual(wiiResult.changed, true);

    const configDirectory = linuxDolphinDirectory(home);
    const mainIni = Ini.read(path.join(configDirectory, 'Dolphin.ini'));
    assert.strictEqual(mainIni.get('Input', 'DSUServerPort'), '26765');
    assert.strictEqual(mainIni.get('Core', 'WiimoteContinuousScanning'), 'False');
    assert.deepStrictEqual(
        [0, 1, 2, 3].map(index => mainIni.get('Core', `SIDevice${index}`)),
        ['0', '0', '0', '0'],
        'Wii game disables GameCube ports to avoid duplicate inputs'
    );

    const wiimoteIni = Ini.read(path.join(configDirectory, 'WiimoteNew.ini'));
    assert.strictEqual(wiimoteIni.get('Wiimote1', 'Source'), '1');
    assert.strictEqual(wiimoteIni.get('Wiimote1', 'Device'), 'SDL/0/Virtual Pad 1');
    assert.strictEqual(wiimoteIni.get('Wiimote2', 'Source'), '2');
    assert.strictEqual(wiimoteIni.get('Wiimote3', 'Source'), '1');
    assert.strictEqual(wiimoteIni.get('Wiimote3', 'Device'), 'SDL/2/Virtual Pad 3');
    assert.strictEqual(wiimoteIni.get('Wiimote4', 'Source'), '0');

    // Now switch to GameCube game: real Wii Remote disabled on Wiimotes, virtual pads fill GCPad1 & GCPad2
    const gamecubeResult = inputconfigVirtual.apply(
        'dolphin',
        { home, platform: 'linux', env: {} },
        {
            activePlayers: 3,
            realWiimotes: [false, true, false, false],
            game: 'gamecube',
            profiles,
            players: []
        }
    );

    assert.strictEqual(gamecubeResult.status, 'configured');
    const updatedMainIni = Ini.read(path.join(configDirectory, 'Dolphin.ini'));
    assert.deepStrictEqual(
        [0, 1, 2, 3].map(index => updatedMainIni.get('Core', `SIDevice${index}`)),
        ['6', '6', '0', '0']
    );

    const gamecubeIni = Ini.read(path.join(configDirectory, 'GCPadNew.ini'));
    assert.strictEqual(gamecubeIni.get('GCPad1', 'Device'), 'SDL/0/Virtual Pad 1');
    assert.strictEqual(gamecubeIni.get('GCPad2', 'Device'), 'SDL/2/Virtual Pad 3');

    const updatedWiimoteIni = Ini.read(path.join(configDirectory, 'WiimoteNew.ini'));
    assert.strictEqual(updatedWiimoteIni.get('Wiimote1', 'Source'), '0');
    assert.strictEqual(updatedWiimoteIni.get('Wiimote2', 'Source'), '0');
});

test('Dolphin respects Windows config path, custom player profiles, and idempotency', () => {
    const home = createTempHome();
    const appData = path.join(home, 'AppData', 'Roaming');
    const dolphinConfigDirectory = path.join(appData, 'Dolphin Emulator', 'Config');
    fs.mkdirSync(dolphinConfigDirectory, { recursive: true });
    fs.writeFileSync(path.join(dolphinConfigDirectory, 'Dolphin.ini'), '[General]\nFullscreen = True\n');

    const profiles = mappings.createStore(createTempHome());
    const options = {
        activePlayers: 1,
        realWiimotes: [false, false, false, false],
        profiles,
        players: [{ wii: 'wii-classic', gc: 'gc-nintendo', sw: 'switch-nintendo' }]
    };
    const context = { home, platform: 'win32', env: { APPDATA: appData } };

    const firstResult = inputconfigVirtual.apply('dolphin', context, options);
    assert.strictEqual(firstResult.status, 'configured');
    assert.strictEqual(firstResult.changed, true);

    const mainIni = Ini.read(path.join(dolphinConfigDirectory, 'Dolphin.ini'));
    assert.strictEqual(mainIni.get('General', 'Fullscreen'), 'True', 'Unrelated Dolphin.ini settings stay intact');
    assert.strictEqual(mainIni.get('Input', 'DSUServerAddress'), '127.0.0.1');
    assert.strictEqual(mainIni.get('Input', 'DSUServerPort'), '26760');
    assert.ok(fs.existsSync(path.join(dolphinConfigDirectory, 'Dolphin.ini.emulator-menu.bak')));

    const wiimoteIni = Ini.read(path.join(dolphinConfigDirectory, 'WiimoteNew.ini'));
    assert.strictEqual(wiimoteIni.get('Wiimote1', 'Extension'), 'Classic');

    const gamecubeIni = Ini.read(path.join(dolphinConfigDirectory, 'GCPadNew.ini'));
    assert.strictEqual(gamecubeIni.get('GCPad1', 'Buttons/A'), '`Button B`');

    const secondResult = inputconfigVirtual.apply('dolphin', context, options);
    assert.strictEqual(secondResult.status, 'configured');
    assert.strictEqual(secondResult.changed, false, 'Repeated calls with identical arguments report changed: false');
});

test('Ryujinx skips when Config.json does not exist yet', () => {
    const home = createTempHome();
    const result = inputconfigVirtual.apply(
        'ryujinx',
        { home, platform: 'linux', env: {} },
        {
            activePlayers: 2,
            realWiimotes: [false, false, false, false],
            profiles: mappings.createStore(createTempHome()),
            players: []
        }
    );

    assert.strictEqual(result.emulator, 'ryujinx');
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.changed, false);
});

test('Ryujinx configures Player1..Player4 virtual GUIDs, CemuHook DSU motion, and is idempotent', () => {
    const home = createTempHome();
    const ryujinxDirectory = linuxRyujinxDirectory(home);
    fs.mkdirSync(ryujinxDirectory, { recursive: true });
    const configPath = path.join(ryujinxDirectory, 'Config.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 70,
        docked_mode: true,
        input_config: []
    }, null, 2));

    const profiles = mappings.createStore(createTempHome());
    const context = { home, platform: 'linux', env: {} };
    const options = {
        activePlayers: 4,
        realWiimotes: [false, false, false, false],
        dsuPort: 26760,
        profiles,
        players: [{}, { sw: 'switch-nintendo' }, {}, {}]
    };

    const firstResult = inputconfigVirtual.apply('ryujinx', context, options);
    assert.strictEqual(firstResult.emulator, 'ryujinx');
    assert.strictEqual(firstResult.status, 'configured');
    assert.strictEqual(firstResult.changed, true);

    assert.ok(fs.existsSync(`${configPath}.emulator-menu.bak`));
    const writtenConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(writtenConfig.docked_mode, true, 'Unrelated settings stay intact');
    assert.strictEqual(writtenConfig.input_config.length, 4);

    for (let index = 0; index < 4; index += 1) {
        const entry = writtenConfig.input_config[index];
        assert.strictEqual(entry.player_index, `Player${index + 1}`);
        assert.strictEqual(entry.id, inputconfigVirtual.virtualDeviceGuid(index));
        assert.strictEqual(entry.name, `Virtual Pad ${index + 1} (${index})`);
        assert.strictEqual(entry.backend, 'GamepadSDL2');
        assert.strictEqual(entry.controller_type, 'ProController');
        assert.strictEqual(entry.motion.motion_backend, 'CemuHook');
        assert.strictEqual(entry.motion.dsu_server_host, '127.0.0.1');
        assert.strictEqual(entry.motion.dsu_server_port, 26760);
        assert.strictEqual(entry.motion.slot, index);
        assert.strictEqual(entry.motion.enable_motion, true);
    }

    assert.strictEqual(writtenConfig.input_config[0].right_joycon.button_a, 'A');
    assert.strictEqual(writtenConfig.input_config[1].right_joycon.button_a, 'B', 'Player 2 uses switch-nintendo layout');

    const secondResult = inputconfigVirtual.apply('ryujinx', context, options);
    assert.strictEqual(secondResult.status, 'configured');
    assert.strictEqual(secondResult.changed, false, 'Repeated calls do not rewrite identical Config.json');
});

test('Ryujinx removes deactivated virtual slots while preserving Minus/Plus spelling and physical entries', () => {
    const home = createTempHome();
    const ryujinxDirectory = linuxRyujinxDirectory(home);
    fs.mkdirSync(ryujinxDirectory, { recursive: true });
    const configPath = path.join(ryujinxDirectory, 'Config.json');
    fs.writeFileSync(configPath, JSON.stringify({
        input_config: [
            {
                player_index: 'Player1',
                id: inputconfigVirtual.virtualDeviceGuid(0),
                backend: 'GamepadSDL2',
                left_joycon: { button_minus: 'Minus' },
                right_joycon: { button_plus: 'Plus' }
            },
            {
                player_index: 'Player3',
                id: inputconfigVirtual.virtualDeviceGuid(2),
                backend: 'GamepadSDL2'
            },
            {
                player_index: 'Player4',
                id: '0-00000003-24c6-0000-2a59-000001010000',
                name: 'Physical Pad',
                backend: 'GamepadSDL2'
            }
        ]
    }, null, 2));

    const result = inputconfigVirtual.apply(
        'ryujinx',
        { home, platform: 'linux', env: {} },
        {
            activePlayers: 1,
            realWiimotes: [false, false, false, false],
            dsuPort: 26799,
            profiles: mappings.createStore(createTempHome()),
            players: []
        }
    );

    assert.strictEqual(result.status, 'configured');
    assert.strictEqual(result.changed, true);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(written.input_config.length, 2);
    assert.strictEqual(written.input_config[0].player_index, 'Player1');
    assert.strictEqual(written.input_config[0].left_joycon.button_minus, 'Minus');
    assert.strictEqual(written.input_config[0].right_joycon.button_plus, 'Plus');
    assert.strictEqual(written.input_config[0].motion.dsu_server_port, 26799);
    assert.strictEqual(written.input_config[1].id, '0-00000003-24c6-0000-2a59-000001010000');
});

test('apply skips when zero active players and handles unsupported emulators and invalid options cleanly', () => {
    const home = createTempHome();
    const profiles = mappings.createStore(createTempHome());

    const skippedDolphin = inputconfigVirtual.apply(
        'dolphin',
        { home, platform: 'linux', env: {} },
        { activePlayers: 0, realWiimotes: [false, false, false, false], profiles, players: [] }
    );
    assert.strictEqual(skippedDolphin.status, 'skipped');
    assert.strictEqual(skippedDolphin.changed, false);

    const unsupportedResult = inputconfigVirtual.apply(
        'pcsx2',
        { home, platform: 'linux', env: {} },
        { activePlayers: 1, realWiimotes: [false, false, false, false], profiles, players: [] }
    );
    assert.strictEqual(unsupportedResult.status, 'unsupported');
    assert.strictEqual(unsupportedResult.changed, false);

    const badPortResult = inputconfigVirtual.apply(
        'dolphin',
        { home, platform: 'linux', env: {} },
        { activePlayers: 1, realWiimotes: [false, false, false, false], dsuPort: 70000, profiles, players: [] }
    );
    assert.strictEqual(badPortResult.status, 'error');
    assert.strictEqual(badPortResult.changed, false);
    assert.match(badPortResult.message, /dsuPort/);

    const badPlayersResult = inputconfigVirtual.apply(
        'dolphin',
        { home, platform: 'linux', env: {} },
        { activePlayers: 5, realWiimotes: [false, false, false, false], profiles, players: [] }
    );
    assert.strictEqual(badPlayersResult.status, 'error');
    assert.strictEqual(badPlayersResult.changed, false);
    assert.match(badPlayersResult.message, /activePlayers/);
});
