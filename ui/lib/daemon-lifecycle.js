// @ts-check
'use strict';

const childProcessModule = require('child_process');
const fileSystemModule = require('fs');
const operatingSystem = require('os');
const path = require('path');

const DEFAULT_WEBSOCKET_PORT = 26780;
const DEFAULT_DSU_PORT = 26760;
const DEFAULT_STARTUP_TIMEOUT_MILLISECONDS = 5000;
const DEFAULT_STOP_TIMEOUT_MILLISECONDS = 3000;
const FORCE_KILL_FALLBACK_MILLISECONDS = 2000;
const MAXIMUM_LINE_BUFFER_BYTES = 65536;
const DAEMON_BINARY_BASENAME = 'virtualpad-daemon';
const DAEMON_LOG_PREFIX = '[DAEMON]';
const READY_SIGNAL_PATTERN = /websocket\s+server\s+listening/i;
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * @typedef {(...argumentsList: any[]) => void} LogFunction
 */

/**
 * @typedef {Object} DaemonStartOptions
 * @property {number} [wsPort] - WebSocket server port (default 26780).
 * @property {number} [dsuPort] - DSU/Cemuhook UDP server port (default 26760).
 * @property {LogFunction} [log] - Optional logger callback.
 */

/**
 * @typedef {Object} DaemonStartResult
 * @property {boolean} started - Whether the daemon started and reported ready.
 * @property {number} port - Configured WebSocket port.
 * @property {number} dsuPort - Configured DSU UDP port.
 * @property {string} [reason] - Failure or status reason when not freshly started.
 */

/**
 * @typedef {(command: string, commandArguments: string[], options?: import('child_process').SpawnOptions) => import('child_process').ChildProcess} SpawnProcessFunction
 */

/**
 * @typedef {(processIdentifier: number) => boolean} IsProcessAliveFunction
 */

/**
 * @typedef {Object} DaemonLifecycleOptions
 * @property {string} [platform] - Operating system platform override ('linux' or 'win32').
 * @property {string} [projectRoot] - Project root directory override.
 * @property {string} [resourcesPath] - Electron resources directory override.
 * @property {string} [executableDirectory] - Directory of the host executable.
 * @property {number} [startupTimeoutMilliseconds] - Startup ready wait timeout in milliseconds.
 * @property {number} [stopTimeoutMilliseconds] - Graceful stop timeout before force kill in milliseconds.
 * @property {SpawnProcessFunction} [spawnProcess] - Spawn function override for testing.
 * @property {IsProcessAliveFunction} [isProcessAlive] - Liveness probe function override for testing.
 * @property {typeof import('fs')} [fileSystem] - File system module override for testing.
 */

/**
 * @typedef {Object} ValidatedStartOptions
 * @property {number} websocketPort - Validated WebSocket port.
 * @property {number} dsuPort - Validated DSU UDP port.
 * @property {LogFunction|null} customLogger - Optional custom logger callback.
 */

/**
 * Validates that a port number is an integer between 1 and 65535.
 *
 * @param {unknown} candidatePort - Candidate port value.
 * @param {string} fieldName - Option name for error reporting.
 * @param {number} defaultPort - Default port used when candidatePort is undefined.
 * @returns {number} Validated port number.
 */
function validatePort(candidatePort, fieldName, defaultPort) {
    if (candidatePort === undefined) {
        return defaultPort;
    }

    if (typeof candidatePort !== 'number' || !Number.isInteger(candidatePort) || candidatePort < 1 || candidatePort > 65535) {
        throw new RangeError(`${fieldName} must be an integer between 1 and 65535.`);
    }

    return candidatePort;
}

/**
 * Validates that a timeout value is a positive finite number.
 *
 * @param {unknown} candidateTimeout - Candidate timeout in milliseconds.
 * @param {string} fieldName - Option name for error reporting.
 * @param {number} defaultTimeout - Default timeout when candidateTimeout is undefined.
 * @returns {number} Validated timeout in milliseconds.
 */
function validateTimeoutMilliseconds(candidateTimeout, fieldName, defaultTimeout) {
    if (candidateTimeout === undefined) {
        return defaultTimeout;
    }

    if (typeof candidateTimeout !== 'number' || !Number.isFinite(candidateTimeout) || candidateTimeout <= 0) {
        throw new RangeError(`${fieldName} must be a positive finite number.`);
    }

    return candidateTimeout;
}

/**
 * Validates that a value is a non-empty string without null bytes.
 *
 * @param {unknown} candidateString - Candidate path or string value.
 * @param {string} fieldName - Field name for error reporting.
 * @returns {string} Trimmed valid string.
 */
function validateNonEmptyString(candidateString, fieldName) {
    if (typeof candidateString !== 'string') {
        throw new TypeError(`${fieldName} must be a string.`);
    }

    if (candidateString.includes('\0')) {
        throw new Error(`${fieldName} must not contain null bytes.`);
    }

    const trimmedValue = candidateString.trim();
    if (trimmedValue.length === 0) {
        throw new Error(`${fieldName} must not be empty.`);
    }

    return trimmedValue;
}

/**
 * Validates options passed to `start(options)`.
 *
 * @param {DaemonStartOptions} [options] - Raw start options.
 * @returns {ValidatedStartOptions} Validated start configuration.
 */
function validateStartOptions(options) {
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
        throw new TypeError('options must be a plain object.');
    }

    const source = options || {};
    const websocketPort = validatePort(source.wsPort, 'wsPort', DEFAULT_WEBSOCKET_PORT);
    const dsuPort = validatePort(source.dsuPort, 'dsuPort', DEFAULT_DSU_PORT);

    /** @type {LogFunction|null} */
    let customLogger = null;
    if (source.log !== undefined) {
        if (typeof source.log !== 'function') {
            throw new TypeError('log must be a function.');
        }

        customLogger = source.log;
    }

    return {
        websocketPort,
        dsuPort,
        customLogger
    };
}

/**
 * Checks whether a process with the given numeric identifier is alive using signal 0.
 *
 * @param {number} processIdentifier - OS process ID.
 * @returns {boolean} True when the process exists, otherwise false.
 */
function defaultIsProcessAlive(processIdentifier) {
    try {
        process.kill(processIdentifier, 0);
        return true;
    }
    catch (error) {
        const errorCode = error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        return errorCode === 'EPERM';
    }
}

/**
 * Loads `scripts/build-daemon.js` if present (it may be absent in packaged builds).
 *
 * @returns {{ daemonPath?: (platform?: string, projectRoot?: string) => string }|null} Loaded module or null.
 */
function loadBuildDaemonModule() {
    try {
        return require('../../scripts/build-daemon');
    }
    catch (error) {
        return null;
    }
}

/**
 * Checks whether a filesystem path exists and points to a regular file.
 *
 * @param {string} candidatePath - Candidate file path.
 * @param {typeof import('fs')} fileSystem - File system implementation.
 * @returns {boolean} True if candidatePath is an existing regular file.
 */
function isRegularFile(candidatePath, fileSystem) {
    try {
        return fileSystem.statSync(candidatePath).isFile();
    }
    catch (error) {
        return false;
    }
}

/**
 * Manages the lifecycle of the virtualpad-daemon child process.
 */
class DaemonLifecycle {
    /**
     * Creates a new DaemonLifecycle manager instance.
     *
     * @param {DaemonLifecycleOptions} [options={}] - Lifecycle configuration overrides.
     */
    constructor(options = {}) {
        if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
            throw new TypeError('DaemonLifecycle options must be a plain object.');
        }

        const source = options || {};

        /** @private @type {string} */
        this._platform = source.platform !== undefined
            ? validateNonEmptyString(source.platform, 'platform')
            : operatingSystem.platform();

        /** @private @type {string} */
        this._projectRoot = source.projectRoot !== undefined
            ? path.resolve(validateNonEmptyString(source.projectRoot, 'projectRoot'))
            : DEFAULT_PROJECT_ROOT;

        const defaultResourcesPath = typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
            ? process.resourcesPath
            : '';

        /** @private @type {string} */
        this._resourcesPath = source.resourcesPath !== undefined
            ? path.resolve(validateNonEmptyString(source.resourcesPath, 'resourcesPath'))
            : defaultResourcesPath;

        /** @private @type {string} */
        this._executableDirectory = source.executableDirectory !== undefined
            ? path.resolve(validateNonEmptyString(source.executableDirectory, 'executableDirectory'))
            : path.dirname(process.execPath);

        /** @private @type {number} */
        this._startupTimeoutMilliseconds = validateTimeoutMilliseconds(
            source.startupTimeoutMilliseconds,
            'startupTimeoutMilliseconds',
            DEFAULT_STARTUP_TIMEOUT_MILLISECONDS
        );

        /** @private @type {number} */
        this._stopTimeoutMilliseconds = validateTimeoutMilliseconds(
            source.stopTimeoutMilliseconds,
            'stopTimeoutMilliseconds',
            DEFAULT_STOP_TIMEOUT_MILLISECONDS
        );

        if (source.spawnProcess !== undefined && typeof source.spawnProcess !== 'function') {
            throw new TypeError('spawnProcess must be a function.');
        }

        if (source.isProcessAlive !== undefined && typeof source.isProcessAlive !== 'function') {
            throw new TypeError('isProcessAlive must be a function.');
        }

        if (source.fileSystem !== undefined && (source.fileSystem === null || typeof source.fileSystem !== 'object')) {
            throw new TypeError('fileSystem must be an object.');
        }

        /** @private @type {SpawnProcessFunction} */
        this._spawnProcess = source.spawnProcess || childProcessModule.spawn;

        /** @private @type {IsProcessAliveFunction} */
        this._isProcessAlive = source.isProcessAlive || defaultIsProcessAlive;

        /** @private @type {typeof import('fs')} */
        this._fileSystem = source.fileSystem || fileSystemModule;

        /** @private @type {import('child_process').ChildProcess|null} */
        this._process = null;

        /** @private @type {number} */
        this._websocketPort = DEFAULT_WEBSOCKET_PORT;

        /** @private @type {number} */
        this._dsuPort = DEFAULT_DSU_PORT;

        /** @private @type {LogFunction|null} */
        this._customLogger = null;

        /** @private @type {boolean} */
        this._stopping = false;

        /** @private @type {boolean} */
        this._startupCompleted = false;

        /** @private @type {Promise<DaemonStartResult>|null} */
        this._startPromise = null;

        /** @private @type {Promise<void>|null} */
        this._stopPromise = null;
    }

    /**
     * Logs an informational message with the `[DAEMON]` prefix.
     *
     * @private
     * @param {string} message - Log message content.
     * @returns {void}
     */
    _logInfo(message) {
        const formattedMessage = `${DAEMON_LOG_PREFIX} ${message}`;
        if (this._customLogger !== null) {
            this._customLogger(formattedMessage);
        }
        else {
            console.log(formattedMessage);
        }
    }

    /**
     * Logs a warning message with the `[DAEMON]` prefix.
     *
     * @private
     * @param {string} message - Warning message content.
     * @returns {void}
     */
    _logWarning(message) {
        const formattedMessage = `${DAEMON_LOG_PREFIX} ${message}`;
        if (this._customLogger !== null) {
            this._customLogger(formattedMessage);
        }
        else {
            console.warn(formattedMessage);
        }
    }

    /**
     * Logs an error message with the `[DAEMON]` prefix.
     *
     * @private
     * @param {string} message - Error message content.
     * @returns {void}
     */
    _logError(message) {
        const formattedMessage = `${DAEMON_LOG_PREFIX} ${message}`;
        if (this._customLogger !== null) {
            this._customLogger(formattedMessage);
        }
        else {
            console.error(formattedMessage);
        }
    }

    /**
     * Resolves the platform-specific daemon binary filename, or null on unsupported platforms.
     *
     * @private
     * @returns {string|null} Expected executable filename or null.
     */
    _resolveBinaryFilename() {
        const normalizedPlatform = this._platform.toLowerCase();
        if (normalizedPlatform === 'win32') {
            return `${DAEMON_BINARY_BASENAME}.exe`;
        }
        else if (normalizedPlatform === 'linux') {
            return DAEMON_BINARY_BASENAME;
        }
        else {
            return null;
        }
    }

    /**
     * Builds the ordered list of candidate daemon binary paths for packaged and development modes.
     *
     * @private
     * @returns {string[]} Deduplicated candidate binary paths.
     */
    _buildCandidateBinaryPaths() {
        const binaryFilename = this._resolveBinaryFilename();
        if (binaryFilename === null) {
            return [];
        }

        /** @type {Set<string>} */
        const candidates = new Set();

        if (this._resourcesPath.length > 0) {
            candidates.add(path.join(this._resourcesPath, 'bin', binaryFilename));
        }

        candidates.add(path.join(this._executableDirectory, 'resources', 'bin', binaryFilename));
        candidates.add(path.join(this._projectRoot, 'resources', 'bin', binaryFilename));

        const buildDaemon = loadBuildDaemonModule();
        if (buildDaemon !== null && typeof buildDaemon.daemonPath === 'function') {
            try {
                candidates.add(buildDaemon.daemonPath(this._platform, this._projectRoot));
            }
            catch (error) {
                // Ignore unsupported platform errors from build-daemon helper.
            }
        }

        candidates.add(path.join(this._projectRoot, 'ui', 'bin', binaryFilename));
        candidates.add(path.join(this._projectRoot, 'daemon', 'target', 'release', binaryFilename));

        return Array.from(candidates);
    }

    /**
     * Finds the path to the daemon binary, or returns null if not found.
     *
     * @returns {string|null} Path to the daemon executable, or null when missing.
     */
    binaryPath() {
        const candidatePaths = this._buildCandidateBinaryPaths();
        for (const candidatePath of candidatePaths) {
            if (isRegularFile(candidatePath, this._fileSystem)) {
                return candidatePath;
            }
        }

        return null;
    }

    /**
     * Attaches line-buffered logging and ready-signal detection to a daemon output stream.
     *
     * @private
     * @param {NodeJS.ReadableStream|null|undefined} stream - Process stdout or stderr stream.
     * @param {(line: string) => void} onLine - Callback invoked for each complete line.
     * @returns {() => void} Flush function to emit any trailing partial line on close.
     */
    _attachOutputStream(stream, onLine) {
        if (!stream) {
            return () => {};
        }

        let lineBuffer = '';

        /**
         * Emits complete lines from the internal buffer.
         *
         * @param {boolean} flushRemainder - Whether to flush trailing partial text.
         * @returns {void}
         */
        const processBuffer = (flushRemainder) => {
            let newlineIndex = lineBuffer.indexOf('\n');
            while (newlineIndex !== -1) {
                const rawLine = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
                lineBuffer = lineBuffer.slice(newlineIndex + 1);
                if (rawLine.length > 0) {
                    onLine(rawLine);
                }

                newlineIndex = lineBuffer.indexOf('\n');
            }

            if (flushRemainder && lineBuffer.length > 0) {
                const remainingLine = lineBuffer.replace(/\r$/, '');
                lineBuffer = '';
                if (remainingLine.length > 0) {
                    onLine(remainingLine);
                }
            }
        };

        stream.on('data', (chunk) => {
            lineBuffer += String(chunk);
            if (lineBuffer.length > MAXIMUM_LINE_BUFFER_BYTES) {
                lineBuffer = lineBuffer.slice(-MAXIMUM_LINE_BUFFER_BYTES);
            }

            processBuffer(false);
        });

        stream.on('end', () => {
            processBuffer(true);
        });

        return () => {
            processBuffer(true);
        };
    }

    /**
     * Starts the virtual controller daemon child process.
     *
     * @param {DaemonStartOptions} [options={}] - Optional WebSocket port, DSU port, and logger.
     * @returns {Promise<DaemonStartResult>} Startup result indicating whether the daemon is running.
     */
    async start(options = {}) {
        const validated = validateStartOptions(options);
        if (validated.customLogger !== null) {
            this._customLogger = validated.customLogger;
        }

        if (this._startPromise !== null) {
            return this._startPromise;
        }

        if (this.isRunning()) {
            this._logInfo(`Daemon already running (PID ${this.pid()}) on port ${this._websocketPort}.`);
            return {
                started: true,
                port: this._websocketPort,
                dsuPort: this._dsuPort
            };
        }

        const resolvedBinaryPath = this.binaryPath();
        if (resolvedBinaryPath === null) {
            this._logWarning('Daemon binary not found; starting without virtual controller daemon.');
            return {
                started: false,
                port: validated.websocketPort,
                dsuPort: validated.dsuPort,
                reason: 'binary_not_found'
            };
        }

        this._websocketPort = validated.websocketPort;
        this._dsuPort = validated.dsuPort;
        this._stopping = false;
        this._startupCompleted = false;

        this._startPromise = this._launchDaemonProcess(resolvedBinaryPath, validated.websocketPort, validated.dsuPort);

        try {
            return await this._startPromise;
        }
        finally {
            this._startPromise = null;
        }
    }

    /**
     * Spawns the daemon binary and waits for its ready log line, early exit, or timeout.
     *
     * @private
     * @param {string} resolvedBinaryPath - Path to the daemon executable.
     * @param {number} websocketPort - WebSocket server port.
     * @param {number} dsuPort - DSU UDP server port.
     * @returns {Promise<DaemonStartResult>} Startup outcome.
     */
    _launchDaemonProcess(resolvedBinaryPath, websocketPort, dsuPort) {
        const commandArguments = ['--port', String(websocketPort), '--dsu-port', String(dsuPort)];

        /** @type {import('child_process').ChildProcess} */
        let spawnedProcess;
        try {
            spawnedProcess = this._spawnProcess(resolvedBinaryPath, commandArguments, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this._logError(`Failed to spawn daemon binary "${resolvedBinaryPath}": ${errorMessage}`);
            return Promise.resolve({
                started: false,
                port: websocketPort,
                dsuPort,
                reason: 'spawn_error'
            });
        }

        this._process = spawnedProcess;

        return new Promise((resolve) => {
            let settled = false;
            let timedOut = false;
            /** @type {ReturnType<typeof setTimeout>|null} */
            let startupTimer = null;

            /**
             * Settles the startup promise once and clears the startup timeout.
             *
             * @param {DaemonStartResult} result - Startup result payload.
             * @returns {void}
             */
            const finishStartup = (result) => {
                if (settled) {
                    return;
                }

                settled = true;
                if (startupTimer !== null) {
                    clearTimeout(startupTimer);
                    startupTimer = null;
                }

                resolve(result);
            };

            /**
             * Handles each log line from daemon stdout or stderr.
             *
             * @param {string} line - Single output line.
             * @returns {void}
             */
            const handleOutputLine = (line) => {
                this._logInfo(line);
                if (!settled && READY_SIGNAL_PATTERN.test(line)) {
                    this._startupCompleted = true;
                    finishStartup({
                        started: true,
                        port: websocketPort,
                        dsuPort
                    });
                }
            };

            const flushStdout = this._attachOutputStream(spawnedProcess.stdout, handleOutputLine);
            const flushStderr = this._attachOutputStream(spawnedProcess.stderr, handleOutputLine);

            spawnedProcess.on('error', (error) => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this._logError(`Daemon process error: ${errorMessage}`);
                if (this._process === spawnedProcess) {
                    this._process = null;
                }

                if (!settled) {
                    finishStartup({
                        started: false,
                        port: websocketPort,
                        dsuPort,
                        reason: 'spawn_error'
                    });
                }
            });

            spawnedProcess.on('exit', (exitCode, signalName) => {
                flushStdout();
                flushStderr();

                if (this._process === spawnedProcess) {
                    this._process = null;
                }

                if (!settled && !timedOut) {
                    this._logError(`Daemon exited before becoming ready (code=${exitCode}, signal=${signalName}).`);
                    finishStartup({
                        started: false,
                        port: websocketPort,
                        dsuPort,
                        reason: 'exited_early'
                    });
                }
                else if (this._startupCompleted && !this._stopping) {
                    this._logError(`Daemon crashed or exited unexpectedly (code=${exitCode}, signal=${signalName}); not restarting.`);
                }
            });

            startupTimer = setTimeout(async () => {
                if (settled) {
                    return;
                }

                timedOut = true;
                this._logWarning(`Daemon startup timed out after ${this._startupTimeoutMilliseconds}ms waiting for ready signal.`);
                await this.stop();
                finishStartup({
                    started: false,
                    port: websocketPort,
                    dsuPort,
                    reason: 'startup_timeout'
                });
            }, this._startupTimeoutMilliseconds);
        });
    }

    /**
     * Stops the daemon process gracefully (SIGTERM on Linux, taskkill on Windows),
     * escalating to force kill after the stop timeout if needed.
     *
     * @returns {Promise<void>} Resolves once the daemon has exited or been force killed.
     */
    async stop() {
        if (this._stopPromise !== null) {
            return this._stopPromise;
        }

        const targetProcess = this._process;
        if (targetProcess === null) {
            return;
        }

        if (targetProcess.exitCode !== null || targetProcess.signalCode !== null) {
            this._process = null;
            return;
        }

        this._stopping = true;
        this._stopPromise = this._terminateProcess(targetProcess);

        try {
            await this._stopPromise;
        }
        finally {
            if (this._process === targetProcess) {
                this._process = null;
            }

            this._stopping = false;
            this._stopPromise = null;
        }
    }

    /**
     * Executes graceful termination followed by force kill if the process does not exit in time.
     *
     * @private
     * @param {import('child_process').ChildProcess} targetProcess - Running daemon process.
     * @returns {Promise<void>} Resolves when termination completes.
     */
    _terminateProcess(targetProcess) {
        const targetIdentifier = targetProcess.pid;

        return new Promise((resolve) => {
            let resolved = false;
            /** @type {ReturnType<typeof setTimeout>|null} */
            let gracefulTimer = null;
            /** @type {ReturnType<typeof setTimeout>|null} */
            let forceKillFallbackTimer = null;

            /**
             * Cleans up timers and listeners and resolves the stop promise.
             *
             * @returns {void}
             */
            const completeStop = () => {
                if (resolved) {
                    return;
                }

                resolved = true;
                if (gracefulTimer !== null) {
                    clearTimeout(gracefulTimer);
                    gracefulTimer = null;
                }

                if (forceKillFallbackTimer !== null) {
                    clearTimeout(forceKillFallbackTimer);
                    forceKillFallbackTimer = null;
                }

                targetProcess.removeListener('exit', onProcessExit);
                resolve();
            };

            /**
             * Handles the target process exit event.
             *
             * @returns {void}
             */
            const onProcessExit = () => {
                completeStop();
            };

            targetProcess.once('exit', onProcessExit);

            if (targetProcess.exitCode !== null || targetProcess.signalCode !== null) {
                completeStop();
                return;
            }

            this._sendGracefulStopSignal(targetProcess, targetIdentifier);

            gracefulTimer = setTimeout(() => {
                if (resolved) {
                    return;
                }

                this._logWarning(`Daemon did not exit within ${this._stopTimeoutMilliseconds}ms; force killing process.`);
                this._sendForceKillSignal(targetProcess, targetIdentifier);

                forceKillFallbackTimer = setTimeout(() => {
                    completeStop();
                }, FORCE_KILL_FALLBACK_MILLISECONDS);
            }, this._stopTimeoutMilliseconds);
        });
    }

    /**
     * Sends a platform-appropriate graceful termination request to the daemon process.
     *
     * @private
     * @param {import('child_process').ChildProcess} targetProcess - Daemon child process.
     * @param {number|undefined} targetIdentifier - Daemon numeric PID.
     * @returns {void}
     */
    _sendGracefulStopSignal(targetProcess, targetIdentifier) {
        if (this._platform === 'win32' && typeof targetIdentifier === 'number') {
            this._runWindowsTaskkill(targetIdentifier, false, () => {
                try {
                    targetProcess.kill();
                }
                catch (error) {
                    // Process already exited.
                }
            });
        }
        else {
            try {
                targetProcess.kill('SIGTERM');
            }
            catch (error) {
                // Process already exited.
            }
        }
    }

    /**
     * Sends a platform-appropriate force kill signal to the daemon process.
     *
     * @private
     * @param {import('child_process').ChildProcess} targetProcess - Daemon child process.
     * @param {number|undefined} targetIdentifier - Daemon numeric PID.
     * @returns {void}
     */
    _sendForceKillSignal(targetProcess, targetIdentifier) {
        if (this._platform === 'win32' && typeof targetIdentifier === 'number') {
            this._runWindowsTaskkill(targetIdentifier, true, () => {
                try {
                    targetProcess.kill('SIGKILL');
                }
                catch (error) {
                    // Process already exited.
                }
            });
        }
        else {
            try {
                targetProcess.kill('SIGKILL');
            }
            catch (error) {
                // Process already exited.
            }
        }
    }

    /**
     * Invokes Windows `taskkill` on the daemon process tree.
     *
     * @private
     * @param {number} processIdentifier - Target process ID.
     * @param {boolean} force - Whether to pass `/f` for forced termination.
     * @param {() => void} onFallback - Fallback callback if `taskkill` fails to spawn.
     * @returns {void}
     */
    _runWindowsTaskkill(processIdentifier, force, onFallback) {
        const taskkillArguments = ['/pid', String(processIdentifier), '/t'];
        if (force) {
            taskkillArguments.push('/f');
        }

        try {
            const killerProcess = this._spawnProcess('taskkill', taskkillArguments, {
                stdio: 'ignore',
                windowsHide: true
            });
            killerProcess.on('error', () => {
                onFallback();
            });
        }
        catch (error) {
            onFallback();
        }
    }

    /**
     * Checks whether the managed daemon process is currently alive.
     *
     * @returns {boolean} True when the daemon process is running, otherwise false.
     */
    isRunning() {
        if (this._process === null) {
            return false;
        }

        if (this._process.exitCode !== null || this._process.signalCode !== null) {
            this._process = null;
            return false;
        }

        const processIdentifier = this._process.pid;
        if (typeof processIdentifier !== 'number' || !Number.isInteger(processIdentifier) || processIdentifier <= 0) {
            return false;
        }

        if (!this._isProcessAlive(processIdentifier)) {
            if (!this._stopping && this._startupCompleted) {
                this._logError(`Daemon process (PID ${processIdentifier}) is no longer alive; not restarting.`);
            }

            this._process = null;
            return false;
        }

        return true;
    }

    /**
     * Returns the running daemon process identifier, or null if not running.
     *
     * @returns {number|null} Process PID or null.
     */
    pid() {
        if (!this.isRunning() || this._process === null || typeof this._process.pid !== 'number') {
            return null;
        }

        return this._process.pid;
    }
}

const defaultLifecycle = new DaemonLifecycle();

/**
 * Start the virtual controller daemon.
 *
 * @param {DaemonStartOptions} [options] - Optional port and logger configuration.
 * @returns {Promise<DaemonStartResult>} Startup status and port configuration.
 */
async function start(options) {
    return defaultLifecycle.start(options);
}

/**
 * Stop the virtual controller daemon.
 *
 * @returns {Promise<void>} Resolves once the daemon has exited.
 */
async function stop() {
    return defaultLifecycle.stop();
}

/**
 * Check if the daemon is currently running.
 *
 * @returns {boolean} True if the daemon process is alive.
 */
function isRunning() {
    return defaultLifecycle.isRunning();
}

/**
 * Get the daemon process PID (or null if not running).
 *
 * @returns {number|null} Numeric process ID or null.
 */
function pid() {
    return defaultLifecycle.pid();
}

/**
 * Path to the daemon binary (or null if not found).
 *
 * @returns {string|null} Resolved path to the daemon executable or null.
 */
function binaryPath() {
    return defaultLifecycle.binaryPath();
}

module.exports = {
    start,
    stop,
    isRunning,
    pid,
    binaryPath,
    DaemonLifecycle,
    DEFAULT_WEBSOCKET_PORT,
    DEFAULT_DSU_PORT,
    DEFAULT_STARTUP_TIMEOUT_MILLISECONDS,
    DEFAULT_STOP_TIMEOUT_MILLISECONDS
};
