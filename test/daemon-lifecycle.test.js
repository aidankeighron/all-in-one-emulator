// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fileSystem = require('node:fs');
const operatingSystem = require('node:os');
const path = require('node:path');

const daemonLifecycleModule = require('../ui/lib/daemon-lifecycle');
const { DaemonLifecycle } = daemonLifecycleModule;

/**
 * Creates a temporary workspace root for isolated binary resolution tests.
 *
 * @returns {string} Path to the temporary directory.
 */
function createTemporaryWorkspace() {
    return fileSystem.mkdtempSync(path.join(operatingSystem.tmpdir(), 'daemon-lifecycle-test-'));
}

/**
 * Removes a temporary workspace directory recursively.
 *
 * @param {string} directoryPath - Directory to delete.
 * @returns {void}
 */
function removeTemporaryWorkspace(directoryPath) {
    fileSystem.rmSync(directoryPath, { recursive: true, force: true });
}

/**
 * Creates a mock ChildProcess emitter with stdout/stderr streams and recorded kill signals.
 *
 * @param {number} [processIdentifier=4242] - Numeric PID for the mock process.
 * @returns {{ process: any, stdout: EventEmitter, stderr: EventEmitter, killCalls: Array<string|undefined> }} Mock child process wrapper.
 */
function createMockChildProcess(processIdentifier = 4242) {
    const mockProcess = /** @type {any} */ (new EventEmitter());
    const stdoutStream = new EventEmitter();
    const stderrStream = new EventEmitter();
    /** @type {Array<string|undefined>} */
    const killCalls = [];

    mockProcess.pid = processIdentifier;
    mockProcess.exitCode = null;
    mockProcess.signalCode = null;
    mockProcess.stdout = stdoutStream;
    mockProcess.stderr = stderrStream;
    mockProcess.kill = (/** @type {string|undefined} */ signalName) => {
        killCalls.push(signalName);
        return true;
    };

    return {
        process: mockProcess,
        stdout: stdoutStream,
        stderr: stderrStream,
        killCalls
    };
}

test('binaryPath resolves development, canonical, and packaged daemon binary paths per platform', () => {
    const workspaceRoot = createTemporaryWorkspace();
    const resourcesDirectory = path.join(workspaceRoot, 'packaged-resources');

    try {
        const linuxLifecycle = new DaemonLifecycle({
            platform: 'linux',
            projectRoot: workspaceRoot,
            resourcesPath: resourcesDirectory,
            executableDirectory: workspaceRoot
        });
        assert.strictEqual(linuxLifecycle.binaryPath(), null);

        const devLinuxBinary = path.join(workspaceRoot, 'daemon', 'target', 'release', 'virtualpad-daemon');
        fileSystem.mkdirSync(path.dirname(devLinuxBinary), { recursive: true });
        fileSystem.writeFileSync(devLinuxBinary, 'linux-dev', 'utf8');
        assert.strictEqual(linuxLifecycle.binaryPath(), devLinuxBinary);

        const canonicalLinuxBinary = path.join(workspaceRoot, 'ui', 'bin', 'virtualpad-daemon');
        fileSystem.mkdirSync(path.dirname(canonicalLinuxBinary), { recursive: true });
        fileSystem.writeFileSync(canonicalLinuxBinary, 'linux-canonical', 'utf8');
        assert.strictEqual(linuxLifecycle.binaryPath(), canonicalLinuxBinary);

        const packagedLinuxBinary = path.join(resourcesDirectory, 'bin', 'virtualpad-daemon');
        fileSystem.mkdirSync(path.dirname(packagedLinuxBinary), { recursive: true });
        fileSystem.writeFileSync(packagedLinuxBinary, 'linux-packaged', 'utf8');
        assert.strictEqual(linuxLifecycle.binaryPath(), packagedLinuxBinary);

        const windowsLifecycle = new DaemonLifecycle({
            platform: 'win32',
            projectRoot: workspaceRoot,
            resourcesPath: resourcesDirectory,
            executableDirectory: workspaceRoot
        });
        assert.strictEqual(windowsLifecycle.binaryPath(), null);

        const devWindowsBinary = path.join(workspaceRoot, 'daemon', 'target', 'release', 'virtualpad-daemon.exe');
        fileSystem.mkdirSync(path.dirname(devWindowsBinary), { recursive: true });
        fileSystem.writeFileSync(devWindowsBinary, 'win-dev', 'utf8');
        assert.strictEqual(windowsLifecycle.binaryPath(), devWindowsBinary);

        const unsupportedLifecycle = new DaemonLifecycle({
            platform: 'darwin',
            projectRoot: workspaceRoot,
            resourcesPath: resourcesDirectory,
            executableDirectory: workspaceRoot
        });
        assert.strictEqual(unsupportedLifecycle.binaryPath(), null);
    }
    finally {
        removeTemporaryWorkspace(workspaceRoot);
    }
});

test('start returns binary_not_found and logs warning when binary is missing', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    /** @type {string[]} */
    const loggedMessages = [];

    try {
        const lifecycle = new DaemonLifecycle({
            platform: operatingSystem.platform() === 'win32' ? 'win32' : 'linux',
            projectRoot: workspaceRoot,
            resourcesPath: path.join(workspaceRoot, 'missing-resources'),
            executableDirectory: workspaceRoot
        });

        const result = await lifecycle.start({
            wsPort: 26880,
            dsuPort: 26860,
            log: (message) => loggedMessages.push(String(message))
        });

        assert.deepStrictEqual(result, {
            started: false,
            port: 26880,
            dsuPort: 26860,
            reason: 'binary_not_found'
        });
        assert.strictEqual(lifecycle.isRunning(), false);
        assert.strictEqual(lifecycle.pid(), null);
        assert.ok(loggedMessages.some((entry) => entry.includes('[DAEMON]') && entry.toLowerCase().includes('not found')));
    }
    finally {
        removeTemporaryWorkspace(workspaceRoot);
    }
});

test('start validates input options and rejects invalid ports or logger types', async () => {
    const lifecycle = new DaemonLifecycle();

    await assert.rejects(() => lifecycle.start(/** @type {any} */ ('invalid')), /plain object/);
    await assert.rejects(() => lifecycle.start({ wsPort: 0 }), /wsPort/);
    await assert.rejects(() => lifecycle.start({ wsPort: 70000 }), /wsPort/);
    await assert.rejects(() => lifecycle.start({ dsuPort: -1 }), /dsuPort/);
    await assert.rejects(() => lifecycle.start(/** @type {any} */ ({ log: 'not-a-fn' })), /log must be a function/);
});

test('start spawns daemon with port arguments, prefixes output with [DAEMON], and detects ready signal', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    const binaryFile = path.join(workspaceRoot, 'ui', 'bin', 'virtualpad-daemon');
    fileSystem.mkdirSync(path.dirname(binaryFile), { recursive: true });
    fileSystem.writeFileSync(binaryFile, 'stub', 'utf8');

    /** @type {Array<{ command: string, args: string[] }>} */
    const spawnCalls = [];
    /** @type {string[]} */
    const loggedMessages = [];
    const mockChild = createMockChildProcess(5150);

    try {
        const lifecycle = new DaemonLifecycle({
            platform: 'linux',
            projectRoot: workspaceRoot,
            resourcesPath: path.join(workspaceRoot, 'missing-resources'),
            executableDirectory: workspaceRoot,
            startupTimeoutMilliseconds: 500,
            isProcessAlive: () => true,
            spawnProcess: (command, commandArguments) => {
                spawnCalls.push({ command, args: commandArguments });
                setImmediate(() => {
                    mockChild.stdout.emit('data', 'Starting subsystem\n');
                    mockChild.stderr.emit('data', 'INFO WebSocket server listening on ws://127.0.0.1:26900\n');
                });
                return mockChild.process;
            }
        });

        const result = await lifecycle.start({
            wsPort: 26900,
            dsuPort: 26901,
            log: (message) => loggedMessages.push(String(message))
        });

        assert.deepStrictEqual(result, {
            started: true,
            port: 26900,
            dsuPort: 26901
        });
        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].command, binaryFile);
        assert.deepStrictEqual(spawnCalls[0].args, ['--port', '26900', '--dsu-port', '26901']);
        assert.strictEqual(lifecycle.isRunning(), true);
        assert.strictEqual(lifecycle.pid(), 5150);
        assert.ok(loggedMessages.includes('[DAEMON] Starting subsystem'));
        assert.ok(loggedMessages.includes('[DAEMON] INFO WebSocket server listening on ws://127.0.0.1:26900'));

        // Unexpected crash logs an error and does not restart
        mockChild.process.exitCode = 1;
        mockChild.process.emit('exit', 1, null);

        assert.strictEqual(lifecycle.isRunning(), false);
        assert.strictEqual(lifecycle.pid(), null);
        assert.strictEqual(spawnCalls.length, 1);
        assert.ok(loggedMessages.some((entry) => entry.includes('[DAEMON]') && entry.toLowerCase().includes('crashed')));
    }
    finally {
        removeTemporaryWorkspace(workspaceRoot);
    }
});

test('start times out after configured startup timeout and stops hung daemon', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    const binaryFile = path.join(workspaceRoot, 'ui', 'bin', 'virtualpad-daemon');
    fileSystem.mkdirSync(path.dirname(binaryFile), { recursive: true });
    fileSystem.writeFileSync(binaryFile, 'stub', 'utf8');

    const mockChild = createMockChildProcess(6161);
    /** @type {string[]} */
    const loggedMessages = [];

    try {
        const lifecycle = new DaemonLifecycle({
            platform: 'linux',
            projectRoot: workspaceRoot,
            resourcesPath: path.join(workspaceRoot, 'missing-resources'),
            executableDirectory: workspaceRoot,
            startupTimeoutMilliseconds: 50,
            stopTimeoutMilliseconds: 50,
            isProcessAlive: () => true,
            spawnProcess: () => {
                mockChild.process.kill = (/** @type {string|undefined} */ signalName) => {
                    mockChild.killCalls.push(signalName);
                    mockChild.process.exitCode = 0;
                    mockChild.process.emit('exit', 0, signalName || null);
                    return true;
                };
                return mockChild.process;
            }
        });

        const result = await lifecycle.start({
            log: (message) => loggedMessages.push(String(message))
        });

        assert.deepStrictEqual(result, {
            started: false,
            port: 26780,
            dsuPort: 26760,
            reason: 'startup_timeout'
        });
        assert.strictEqual(lifecycle.isRunning(), false);
        assert.deepStrictEqual(mockChild.killCalls, ['SIGTERM']);
        assert.ok(loggedMessages.some((entry) => entry.toLowerCase().includes('timed out')));
    }
    finally {
        removeTemporaryWorkspace(workspaceRoot);
    }
});

test('stop escalates from SIGTERM to SIGKILL on Linux when process does not exit within timeout', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    const binaryFile = path.join(workspaceRoot, 'ui', 'bin', 'virtualpad-daemon');
    fileSystem.mkdirSync(path.dirname(binaryFile), { recursive: true });
    fileSystem.writeFileSync(binaryFile, 'stub', 'utf8');

    const mockChild = createMockChildProcess(7171);

    try {
        const lifecycle = new DaemonLifecycle({
            platform: 'linux',
            projectRoot: workspaceRoot,
            resourcesPath: path.join(workspaceRoot, 'missing-resources'),
            executableDirectory: workspaceRoot,
            stopTimeoutMilliseconds: 40,
            isProcessAlive: () => true,
            spawnProcess: () => {
                setImmediate(() => {
                    mockChild.stdout.emit('data', 'WebSocket server listening on 127.0.0.1:26780\n');
                });
                mockChild.process.kill = (/** @type {string|undefined} */ signalName) => {
                    mockChild.killCalls.push(signalName);
                    if (signalName === 'SIGKILL') {
                        mockChild.process.signalCode = 'SIGKILL';
                        mockChild.process.emit('exit', null, 'SIGKILL');
                    }

                    return true;
                };
                return mockChild.process;
            }
        });

        await lifecycle.start({ log: () => {} });
        assert.strictEqual(lifecycle.isRunning(), true);

        await lifecycle.stop();
        assert.deepStrictEqual(mockChild.killCalls, ['SIGTERM', 'SIGKILL']);
        assert.strictEqual(lifecycle.isRunning(), false);
        assert.strictEqual(lifecycle.pid(), null);
    }
    finally {
        removeTemporaryWorkspace(workspaceRoot);
    }
});

test('stop uses taskkill and escalates to taskkill /f on Windows when process does not exit within timeout', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    const binaryFile = path.join(workspaceRoot, 'ui', 'bin', 'virtualpad-daemon.exe');
    fileSystem.mkdirSync(path.dirname(binaryFile), { recursive: true });
    fileSystem.writeFileSync(binaryFile, 'stub', 'utf8');

    const mockChild = createMockChildProcess(8181);
    /** @type {Array<{ command: string, args: string[] }>} */
    const taskkillCalls = [];

    try {
        const lifecycle = new DaemonLifecycle({
            platform: 'win32',
            projectRoot: workspaceRoot,
            resourcesPath: path.join(workspaceRoot, 'missing-resources'),
            executableDirectory: workspaceRoot,
            stopTimeoutMilliseconds: 40,
            isProcessAlive: () => true,
            spawnProcess: (command, commandArguments) => {
                if (command === 'taskkill') {
                    taskkillCalls.push({ command, args: commandArguments });
                    const killerEmitter = /** @type {any} */ (new EventEmitter());
                    if (commandArguments.includes('/f')) {
                        setImmediate(() => {
                            mockChild.process.exitCode = 1;
                            mockChild.process.emit('exit', 1, null);
                        });
                    }

                    return killerEmitter;
                }

                setImmediate(() => {
                    mockChild.stderr.emit('data', 'WebSocket server listening on ws://127.0.0.1:26780\n');
                });
                return mockChild.process;
            }
        });

        await lifecycle.start({ log: () => {} });
        await lifecycle.stop();

        assert.strictEqual(taskkillCalls.length, 2);
        assert.deepStrictEqual(taskkillCalls[0], {
            command: 'taskkill',
            args: ['/pid', '8181', '/t']
        });
        assert.deepStrictEqual(taskkillCalls[1], {
            command: 'taskkill',
            args: ['/pid', '8181', '/t', '/f']
        });
        assert.strictEqual(lifecycle.isRunning(), false);
    }
    finally {
        removeTemporaryWorkspace(workspaceRoot);
    }
});

test('works with real child process startup, health check, and graceful stop', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    const binaryName = operatingSystem.platform() === 'win32'
        ? 'virtualpad-daemon.exe'
        : 'virtualpad-daemon';
    const binaryFile = path.join(workspaceRoot, 'ui', 'bin', binaryName);
    fileSystem.mkdirSync(path.dirname(binaryFile), { recursive: true });
    fileSystem.writeFileSync(binaryFile, 'placeholder', 'utf8');

    /** @type {string[]} */
    const loggedMessages = [];

    try {
        const lifecycle = new DaemonLifecycle({
            projectRoot: workspaceRoot,
            resourcesPath: path.join(workspaceRoot, 'missing-resources'),
            executableDirectory: workspaceRoot,
            startupTimeoutMilliseconds: 3000,
            stopTimeoutMilliseconds: 1500,
            spawnProcess: (command, commandArguments, spawnOptions) => {
                if (command === 'taskkill') {
                    return require('child_process').spawn(command, commandArguments, spawnOptions);
                }
                const script = [
                    'console.error("WebSocket server listening on ws://127.0.0.1:" + process.argv[2]);',
                    'setInterval(() => {}, 1000);'
                ].join(' ');
                return require('child_process').spawn(process.execPath, ['-e', script, '--', ...commandArguments], spawnOptions);
            }
        });

        const startResult = await lifecycle.start({
            wsPort: 26785,
            dsuPort: 26765,
            log: (message) => loggedMessages.push(String(message))
        });

        assert.deepStrictEqual(startResult, {
            started: true,
            port: 26785,
            dsuPort: 26765
        });
        assert.strictEqual(lifecycle.isRunning(), true);
        const childPid = lifecycle.pid();
        assert.ok(typeof childPid === 'number' && childPid > 0);
        assert.ok(loggedMessages.some((entry) => entry.includes('[DAEMON] WebSocket server listening on ws://127.0.0.1:26785')));

        await lifecycle.stop();
        assert.strictEqual(lifecycle.isRunning(), false);
        assert.strictEqual(lifecycle.pid(), null);
    }
    finally {
        removeTemporaryWorkspace(workspaceRoot);
    }
});

test('module exports expected singleton lifecycle interface', () => {
    assert.strictEqual(typeof daemonLifecycleModule.start, 'function');
    assert.strictEqual(typeof daemonLifecycleModule.stop, 'function');
    assert.strictEqual(typeof daemonLifecycleModule.isRunning, 'function');
    assert.strictEqual(typeof daemonLifecycleModule.pid, 'function');
    assert.strictEqual(typeof daemonLifecycleModule.binaryPath, 'function');
    assert.strictEqual(daemonLifecycleModule.isRunning(), false);
    assert.strictEqual(daemonLifecycleModule.pid(), null);
});
