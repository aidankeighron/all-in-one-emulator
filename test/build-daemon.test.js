// @ts-check

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fileSystem = require('fs');
const operatingSystem = require('os');

const buildDaemon = require('../scripts/build-daemon');

/**
 * Creates a temporary project directory structure for testing daemon builds.
 *
 * @param {boolean} [includeDaemonCrate=true] - Whether to create daemon/Cargo.toml.
 * @returns {string} Path to the created temporary directory.
 */
function createTemporaryProject(includeDaemonCrate = true) {
    const temporaryRoot = fileSystem.mkdtempSync(path.join(operatingSystem.tmpdir(), 'build-daemon-test-'));

    if (includeDaemonCrate) {
        const daemonDirectory = path.join(temporaryRoot, 'daemon');
        fileSystem.mkdirSync(daemonDirectory, { recursive: true });
        fileSystem.writeFileSync(path.join(daemonDirectory, 'Cargo.toml'), '[package]\nname = "virtualpad-daemon"\nversion = "0.1.0"\n', 'utf8');
    }

    return temporaryRoot;
}

/**
 * Removes a temporary directory created during testing.
 *
 * @param {string} directoryPath - Path to delete recursively.
 * @returns {void}
 */
function removeTemporaryProject(directoryPath) {
    fileSystem.rmSync(directoryPath, { recursive: true, force: true });
}

test('daemonPath returns expected binary path for Linux and Windows and rejects unsupported platforms', () => {
    const fakeRoot = path.resolve('/tmp/fake-emulator-project');

    assert.strictEqual(
        buildDaemon.daemonPath('linux', fakeRoot),
        path.join(fakeRoot, 'ui', 'bin', 'virtualpad-daemon')
    );

    assert.strictEqual(
        buildDaemon.daemonPath('win32', fakeRoot),
        path.join(fakeRoot, 'ui', 'bin', 'virtualpad-daemon.exe')
    );

    assert.strictEqual(
        buildDaemon.daemonPath('windows', fakeRoot),
        path.join(fakeRoot, 'ui', 'bin', 'virtualpad-daemon.exe')
    );

    assert.throws(() => buildDaemon.daemonPath('darwin', fakeRoot), /Unsupported platform/);
    assert.throws(() => buildDaemon.daemonPath('', fakeRoot), /must not be empty/);
    assert.throws(() => buildDaemon.daemonPath('linux', ''), /must not be empty/);
});

test('isDaemonBuilt reflects whether the binary exists as a file', () => {
    const temporaryRoot = createTemporaryProject(false);

    try {
        assert.strictEqual(buildDaemon.isDaemonBuilt('linux', temporaryRoot), false);
        assert.strictEqual(buildDaemon.isDaemonBuilt('win32', temporaryRoot), false);

        const expectedWindowsPath = buildDaemon.daemonPath('win32', temporaryRoot);
        fileSystem.mkdirSync(path.dirname(expectedWindowsPath), { recursive: true });
        fileSystem.writeFileSync(expectedWindowsPath, 'binary-content', 'utf8');

        assert.strictEqual(buildDaemon.isDaemonBuilt('win32', temporaryRoot), true);
        assert.strictEqual(buildDaemon.isDaemonBuilt('linux', temporaryRoot), false);
    }
    finally {
        removeTemporaryProject(temporaryRoot);
    }
});

test('build validates options and rejects malformed inputs', async () => {
    await assert.rejects(
        () => buildDaemon.build(/** @type {any} */ ('invalid')),
        /plain object/
    );

    await assert.rejects(
        () => buildDaemon.build(/** @type {any} */ ({ quiet: 'yes' })),
        /boolean/
    );

    await assert.rejects(
        () => buildDaemon.build(/** @type {any} */ ({ executeFile: 'not-a-function' })),
        /function/
    );

    await assert.rejects(
        () => buildDaemon.build({ platform: 'darwin', quiet: true }),
        /Unsupported platform/
    );
});

test('build checks cargo, runs cargo build --release in daemon/, creates ui/bin/, and copies binary', async () => {
    const temporaryRoot = createTemporaryProject(true);
    /** @type {Array<{ command: string, commandArguments: string[], workingDirectory: string | undefined }>} */
    const recordedCommands = [];

    try {
        const result = await buildDaemon.build({
            platform: 'win32',
            projectRoot: temporaryRoot,
            quiet: true,
            executeFile: async (command, commandArguments, options = {}) => {
                recordedCommands.push({
                    command,
                    commandArguments,
                    workingDirectory: options.workingDirectory
                });

                if (command === 'cargo' && commandArguments[0] === '--version') {
                    return { stdout: 'cargo 1.80.0 (12345678 2026-01-01)\n', stderr: '' };
                }

                if (command === 'cargo' && commandArguments[0] === 'build') {
                    const releaseDirectory = path.join(temporaryRoot, 'daemon', 'target', 'release');
                    fileSystem.mkdirSync(releaseDirectory, { recursive: true });
                    fileSystem.writeFileSync(path.join(releaseDirectory, 'virtualpad-daemon.exe'), 'compiled-windows-binary', 'utf8');
                    return { stdout: 'Finished release target\n', stderr: '' };
                }

                throw new Error(`Unexpected command: ${command}`);
            }
        });

        assert.strictEqual(recordedCommands.length, 2);
        assert.deepStrictEqual(recordedCommands[0], {
            command: 'cargo',
            commandArguments: ['--version'],
            workingDirectory: undefined
        });
        assert.deepStrictEqual(recordedCommands[1], {
            command: 'cargo',
            commandArguments: ['build', '--release'],
            workingDirectory: path.join(temporaryRoot, 'daemon')
        });

        const expectedDestination = buildDaemon.daemonPath('win32', temporaryRoot);
        assert.strictEqual(result.destinationPath, expectedDestination);
        assert.strictEqual(buildDaemon.isDaemonBuilt('win32', temporaryRoot), true);
        assert.strictEqual(fileSystem.readFileSync(expectedDestination, 'utf8'), 'compiled-windows-binary');
    }
    finally {
        removeTemporaryProject(temporaryRoot);
    }
});

test('build fails cleanly when cargo is unavailable or daemon directory is missing', async () => {
    const temporaryRoot = createTemporaryProject(false);

    try {
        await assert.rejects(
            () => buildDaemon.build({
                platform: 'linux',
                projectRoot: temporaryRoot,
                quiet: true,
                executeFile: async () => {
                    throw new Error('ENOENT');
                }
            }),
            /Rust\/Cargo is not installed/
        );

        await assert.rejects(
            () => buildDaemon.build({
                platform: 'linux',
                projectRoot: temporaryRoot,
                quiet: true,
                executeFile: async () => ({ stdout: 'cargo 1.80.0\n', stderr: '' })
            }),
            /Daemon directory not found/
        );
    }
    finally {
        removeTemporaryProject(temporaryRoot);
    }
});

test('parseCommandLineArguments validates flags and positional platform arguments', () => {
    assert.deepStrictEqual(buildDaemon.parseCommandLineArguments([]), {
        platform: undefined,
        quiet: false
    });

    assert.deepStrictEqual(buildDaemon.parseCommandLineArguments(['--quiet', '--platform=linux']), {
        platform: 'linux',
        quiet: true
    });

    assert.deepStrictEqual(buildDaemon.parseCommandLineArguments(['windows']), {
        platform: 'win32',
        quiet: false
    });

    assert.throws(() => buildDaemon.parseCommandLineArguments(['--unknown']), /Unknown flag/);
    assert.throws(() => buildDaemon.parseCommandLineArguments(['--platform']), /Missing value/);
    assert.throws(() => buildDaemon.parseCommandLineArguments(['darwin']), /Unsupported platform/);
});
