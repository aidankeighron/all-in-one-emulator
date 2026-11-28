// @ts-check

const path = require('path');
const fileSystem = require('fs');
const childProcess = require('child_process');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');
const DAEMON_BINARY_BASENAME = 'virtualpad-daemon';
const MAXIMUM_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 300000;

/**
 * @typedef {'linux' | 'win32'} SupportedPlatform
 */

/**
 * @typedef {Object} PlatformDetails
 * @property {SupportedPlatform} platform - Normalized Node.js platform identifier.
 * @property {string} label - Human-readable operating system name.
 * @property {string} binaryName - Expected daemon executable filename for the platform.
 */

/**
 * @typedef {Object} CommandExecutionOptions
 * @property {string} [workingDirectory] - Directory in which to execute the command.
 * @property {number} [timeoutMilliseconds] - Maximum allowed execution time in milliseconds.
 * @property {number} [maximumBufferBytes] - Maximum stdout and stderr buffer size in bytes.
 */

/**
 * @typedef {Object} CommandExecutionResult
 * @property {string} stdout - Standard output captured from the command.
 * @property {string} stderr - Standard error captured from the command.
 */

/**
 * @callback ExecuteFileFunction
 * @param {string} command - Executable name or path to invoke.
 * @param {string[]} commandArguments - Argument list passed to the executable.
 * @param {CommandExecutionOptions} [options] - Execution options.
 * @returns {Promise<CommandExecutionResult>} Command output streams.
 */

/**
 * @typedef {Object} BuildOptions
 * @property {string} [platform] - Target platform override ('linux', 'win32', or 'windows').
 * @property {string} [projectRoot] - Project root directory override.
 * @property {boolean} [quiet] - When true, suppresses progress, success, and failure messages.
 * @property {ExecuteFileFunction} [executeFile] - Optional command runner override for testing.
 */

/**
 * @typedef {Object} BuildResult
 * @property {SupportedPlatform} platform - Target platform that was built.
 * @property {string} cargoVersion - Detected Cargo version string.
 * @property {string} sourcePath - Path to the compiled binary inside daemon/target/release.
 * @property {string} destinationPath - Path to the copied binary inside ui/bin.
 */

/**
 * @typedef {Object} ParsedCommandLineOptions
 * @property {string | undefined} platform - Optional target platform from command line arguments.
 * @property {boolean} quiet - Whether output should be suppressed.
 */

/**
 * @typedef {Object} NormalizedBuildOptions
 * @property {PlatformDetails} platform - Validated target platform details.
 * @property {string} projectRoot - Validated absolute project root directory.
 * @property {boolean} quiet - Whether console output is suppressed.
 * @property {ExecuteFileFunction} executeFile - Command execution function.
 */

/** @type {Readonly<Record<SupportedPlatform, PlatformDetails>>} */
const PLATFORM_MAP = Object.freeze({
    linux: {
        platform: 'linux',
        label: 'Linux',
        binaryName: DAEMON_BINARY_BASENAME
    },
    win32: {
        platform: 'win32',
        label: 'Windows',
        binaryName: `${DAEMON_BINARY_BASENAME}.exe`
    }
});

/**
 * Validates that a value is a non-empty string without null bytes.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} fieldName - Descriptive name for error reporting.
 * @returns {string} Trimmed valid string.
 */
function validateNonEmptyString(value, fieldName) {
    if (typeof value !== 'string') {
        throw new TypeError(`${fieldName} must be a string.`);
    }

    if (value.includes('\0')) {
        throw new Error(`${fieldName} must not contain null bytes.`);
    }

    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) {
        throw new Error(`${fieldName} must not be empty.`);
    }

    return trimmedValue;
}

/**
 * Resolves and validates a target platform string to supported platform metadata.
 *
 * @param {string} [platform=process.platform] - Platform identifier ('linux', 'win32', or 'windows').
 * @returns {PlatformDetails} Platform details for the validated target.
 */
function resolvePlatform(platform = process.platform) {
    const normalizedInput = validateNonEmptyString(platform, 'platform').toLowerCase();

    if (normalizedInput === 'linux') {
        return PLATFORM_MAP.linux;
    }
    else if (normalizedInput === 'win32' || normalizedInput === 'windows') {
        return PLATFORM_MAP.win32;
    }
    else {
        throw new Error(`Unsupported platform "${platform}". Only Linux and Windows are supported.`);
    }
}

/**
 * Validates and resolves the project root path.
 *
 * @param {string} [projectRoot=DEFAULT_PROJECT_ROOT] - Candidate project root directory path.
 * @returns {string} Resolved absolute path to the project root.
 */
function validateProjectRoot(projectRoot = DEFAULT_PROJECT_ROOT) {
    const validatedPath = validateNonEmptyString(projectRoot, 'projectRoot');
    return path.resolve(validatedPath);
}

/**
 * Validates and normalizes options passed to the build function.
 *
 * @param {BuildOptions} [options] - Raw build options provided by the caller.
 * @returns {NormalizedBuildOptions} Normalized build configuration.
 */
function validateBuildOptions(options) {
    if (options === undefined) {
        return {
            platform: resolvePlatform(process.platform),
            projectRoot: DEFAULT_PROJECT_ROOT,
            quiet: false,
            executeFile: executeFileDefault
        };
    }

    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Build options must be a plain object.');
    }

    const platformDetails = options.platform !== undefined
        ? resolvePlatform(options.platform)
        : resolvePlatform(process.platform);

    const projectRoot = options.projectRoot !== undefined
        ? validateProjectRoot(options.projectRoot)
        : DEFAULT_PROJECT_ROOT;

    let quiet = false;
    if (options.quiet !== undefined) {
        if (typeof options.quiet !== 'boolean') {
            throw new TypeError('options.quiet must be a boolean.');
        }

        quiet = options.quiet;
    }

    let executeFile = executeFileDefault;
    if (options.executeFile !== undefined) {
        if (typeof options.executeFile !== 'function') {
            throw new TypeError('options.executeFile must be a function.');
        }

        executeFile = options.executeFile;
    }

    return {
        platform: platformDetails,
        projectRoot,
        quiet,
        executeFile
    };
}

/**
 * Executes an external command using child_process.execFile and returns its output.
 *
 * @param {string} command - Executable name or path to run.
 * @param {string[]} commandArguments - Arguments passed to the executable.
 * @param {CommandExecutionOptions} [options={}] - Execution configuration.
 * @returns {Promise<CommandExecutionResult>} Resolved stdout and stderr output.
 */
function executeFileDefault(command, commandArguments, options = {}) {
    const validatedCommand = validateNonEmptyString(command, 'command');
    if (!Array.isArray(commandArguments)) {
        throw new TypeError('commandArguments must be an array of strings.');
    }

    const validatedArguments = commandArguments.map((argument, index) => {
        return validateNonEmptyString(argument, `commandArguments[${index}]`);
    });

    /** @type {import('child_process').ExecFileOptions} */
    const executionOptions = {
        maxBuffer: options.maximumBufferBytes || MAXIMUM_COMMAND_OUTPUT_BYTES,
        timeout: options.timeoutMilliseconds || COMMAND_TIMEOUT_MILLISECONDS,
        windowsHide: true
    };

    if (options.workingDirectory !== undefined) {
        executionOptions.cwd = validateNonEmptyString(options.workingDirectory, 'workingDirectory');
    }

    return new Promise((resolve, reject) => {
        childProcess.execFile(validatedCommand, validatedArguments, executionOptions, (error, stdout, stderr) => {
            const stdoutText = typeof stdout === 'string' ? stdout : String(stdout || '');
            const stderrText = typeof stderr === 'string' ? stderr : String(stderr || '');

            if (error) {
                const detailMessage = stderrText.trim() || stdoutText.trim() || error.message;
                const wrappedError = new Error(`Command "${validatedCommand} ${validatedArguments.join(' ')}" failed: ${detailMessage}`);
                Object.assign(wrappedError, { cause: error, stdout: stdoutText, stderr: stderrText });
                reject(wrappedError);
                return;
            }

            resolve({ stdout: stdoutText, stderr: stderrText });
        });
    });
}

/**
 * Returns the expected path of the compiled daemon binary for the specified platform.
 *
 * @param {string} [platform=process.platform] - Target platform identifier.
 * @param {string} [projectRoot=DEFAULT_PROJECT_ROOT] - Project root directory path.
 * @returns {string} Absolute path to the expected daemon binary in ui/bin.
 */
function daemonPath(platform = process.platform, projectRoot = DEFAULT_PROJECT_ROOT) {
    const platformDetails = resolvePlatform(platform);
    const validatedRoot = validateProjectRoot(projectRoot);
    return path.join(validatedRoot, 'ui', 'bin', platformDetails.binaryName);
}

/**
 * Checks whether the daemon binary has been built and exists at its expected path.
 *
 * @param {string} [platform=process.platform] - Target platform identifier.
 * @param {string} [projectRoot=DEFAULT_PROJECT_ROOT] - Project root directory path.
 * @returns {boolean} True if the daemon binary exists as a regular file, otherwise false.
 */
function isDaemonBuilt(platform = process.platform, projectRoot = DEFAULT_PROJECT_ROOT) {
    const expectedPath = daemonPath(platform, projectRoot);

    try {
        const statistics = fileSystem.statSync(expectedPath);
        return statistics.isFile();
    }
    catch (error) {
        return false;
    }
}

/**
 * Verifies that Rust and Cargo are installed and callable on the current system.
 *
 * @param {ExecuteFileFunction} executeFile - Command execution function.
 * @returns {Promise<string>} Detected Cargo version string.
 */
async function ensureCargoInstalled(executeFile) {
    try {
        const result = await executeFile('cargo', ['--version'], {});
        const versionLine = result.stdout.trim();

        if (versionLine.length === 0) {
            throw new Error('cargo --version returned empty output.');
        }

        return versionLine;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Rust/Cargo is not installed or unavailable in PATH (${errorMessage}). Install Rust from https://rustup.rs and try again.`);
    }
}

/**
 * Verifies that the daemon crate directory and Cargo.toml exist before building.
 *
 * @param {string} projectRoot - Validated project root path.
 * @returns {Promise<string>} Validated path to the daemon directory.
 */
async function validateDaemonDirectory(projectRoot) {
    const daemonDirectory = path.join(projectRoot, 'daemon');
    const cargoManifestPath = path.join(daemonDirectory, 'Cargo.toml');

    let daemonStats;
    try {
        daemonStats = await fileSystem.promises.stat(daemonDirectory);
    }
    catch (error) {
        throw new Error(`Daemon directory not found at "${daemonDirectory}".`);
    }

    if (!daemonStats.isDirectory()) {
        throw new Error(`Expected "${daemonDirectory}" to be a directory.`);
    }

    try {
        const manifestStats = await fileSystem.promises.stat(cargoManifestPath);
        if (!manifestStats.isFile()) {
            throw new Error(`Expected "${cargoManifestPath}" to be a file.`);
        }
    }
    catch (error) {
        throw new Error(`Cargo manifest not found at "${cargoManifestPath}".`);
    }

    return daemonDirectory;
}

/**
 * Builds the Rust virtual controller daemon for the current or requested platform
 * and copies the release binary into ui/bin.
 *
 * @param {BuildOptions} [options] - Optional build configuration overrides.
 * @returns {Promise<BuildResult>} Details about the completed daemon build.
 */
async function build(options) {
    const validatedOptions = validateBuildOptions(options);
    const { platform: platformDetails, projectRoot, quiet, executeFile } = validatedOptions;

    try {
        const cargoVersion = await ensureCargoInstalled(executeFile);
        const daemonDirectory = await validateDaemonDirectory(projectRoot);

        if (!quiet) {
            console.log(`Building virtualpad-daemon for ${platformDetails.label} using ${cargoVersion}...`);
        }

        await executeFile('cargo', ['build', '--release'], {
            workingDirectory: daemonDirectory
        });

        const sourcePath = path.join(daemonDirectory, 'target', 'release', platformDetails.binaryName);
        let sourceStatistics;

        try {
            sourceStatistics = await fileSystem.promises.stat(sourcePath);
        }
        catch (error) {
            throw new Error(`Cargo build completed, but expected binary was not found at "${sourcePath}".`);
        }

        if (!sourceStatistics.isFile()) {
            throw new Error(`Expected compiled binary at "${sourcePath}" to be a regular file.`);
        }

        const destinationPath = daemonPath(platformDetails.platform, projectRoot);
        const destinationDirectory = path.dirname(destinationPath);

        await fileSystem.promises.mkdir(destinationDirectory, { recursive: true });
        await fileSystem.promises.copyFile(sourcePath, destinationPath);

        if (platformDetails.platform === 'linux') {
            await fileSystem.promises.chmod(destinationPath, 0o755);
        }

        if (!quiet) {
            console.log(`Build succeeded: copied ${sourcePath} to ${destinationPath}`);
        }

        return {
            platform: platformDetails.platform,
            cargoVersion,
            sourcePath,
            destinationPath
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (!quiet) {
            console.error(`Daemon build failed for ${platformDetails.label}: ${errorMessage}`);
        }

        throw error;
    }
}

/**
 * Parses and validates command-line arguments for standalone script execution.
 *
 * @param {string[]} rawArguments - Command-line arguments excluding Node and script paths.
 * @returns {ParsedCommandLineOptions} Validated CLI options.
 */
function parseCommandLineArguments(rawArguments) {
    if (!Array.isArray(rawArguments)) {
        throw new TypeError('Command line arguments must be an array.');
    }

    /** @type {string | undefined} */
    let platform;
    let quiet = false;

    for (let index = 0; index < rawArguments.length; index += 1) {
        const currentArgument = validateNonEmptyString(rawArguments[index], `arguments[${index}]`);

        if (currentArgument === '--quiet') {
            quiet = true;
        }
        else if (currentArgument.startsWith('--platform=')) {
            if (platform !== undefined) {
                throw new Error('Platform specified multiple times.');
            }

            const candidatePlatform = currentArgument.slice('--platform='.length);
            platform = resolvePlatform(candidatePlatform).platform;
        }
        else if (currentArgument === '--platform') {
            if (platform !== undefined) {
                throw new Error('Platform specified multiple times.');
            }

            const nextIndex = index + 1;
            if (nextIndex >= rawArguments.length) {
                throw new Error('Missing value after --platform.');
            }

            platform = resolvePlatform(rawArguments[nextIndex]).platform;
            index = nextIndex;
        }
        else if (currentArgument.startsWith('-')) {
            throw new Error(`Unknown flag "${currentArgument}". Supported flags: --platform <linux|win32|windows>, --quiet.`);
        }
        else {
            if (platform !== undefined) {
                throw new Error(`Unexpected argument "${currentArgument}".`);
            }

            platform = resolvePlatform(currentArgument).platform;
        }
    }

    return { platform, quiet };
}

/**
 * Entry point when invoked directly from the command line.
 *
 * @param {string[]} [rawArguments=process.argv.slice(2)] - Command-line arguments.
 * @returns {Promise<void>} Resolves once execution finishes.
 */
async function main(rawArguments = process.argv.slice(2)) {
    /** @type {ParsedCommandLineOptions} */
    let parsedArguments;

    try {
        parsedArguments = parseCommandLineArguments(rawArguments);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Invalid arguments: ${errorMessage}`);
        process.exitCode = 1;
        return;
    }

    try {
        await build({
            platform: parsedArguments.platform,
            quiet: parsedArguments.quiet
        });
    }
    catch (error) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    daemonPath,
    isDaemonBuilt,
    build,
    parseCommandLineArguments,
    resolvePlatform
};
