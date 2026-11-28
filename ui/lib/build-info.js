// @ts-check
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * @typedef {Object} BuildInfo
 * @property {string} version Semantic version from package.json.
 * @property {number} buildNumber Monotonically increasing build number.
 * @property {string | null} buildDate ISO 8601 UTC timestamp of when the build ran, or null in dev mode.
 * @property {string | null} commit Short git commit hash if available.
 * @property {'build' | 'dev'} source Whether this metadata came from a packaged build or live dev checkout.
 */

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const BUILD_INFO_REL = path.join('ui', 'build-info.json');

/**
 * Runs a git command synchronously and returns trimmed stdout, or null if unavailable.
 * @param {string} root Repository root directory.
 * @param {string[]} args Git arguments.
 * @returns {string | null}
 */
function runGitSync(root, args) {
    try {
        const out = execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
        const trimmed = String(out || '').trim();
        return trimmed || null;
    }
    catch (error) {
        return null;
    }
}

/**
 * Reads package.json version safely from the project root.
 * @param {string} root Project root directory.
 * @returns {string}
 */
function readPackageVersion(root) {
    try {
        const pkgPath = path.join(root, 'package.json');
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) {
            return parsed.version.trim();
        }
    }
    catch (error) {
        return '0.0.0';
    }
    return '0.0.0';
}

/**
 * Reads an existing build-info.json file if valid.
 * @param {string} filePath Absolute path to build-info.json.
 * @returns {BuildInfo | null}
 */
function readExistingFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        if (typeof parsed.version !== 'string' || !Number.isInteger(parsed.buildNumber) || parsed.buildNumber < 1) {
            return null;
        }
        return {
            version: parsed.version,
            buildNumber: parsed.buildNumber,
            buildDate: typeof parsed.buildDate === 'string' ? parsed.buildDate : null,
            commit: typeof parsed.commit === 'string' ? parsed.commit : null,
            source: parsed.source === 'dev' ? 'dev' : 'build'
        };
    }
    catch (error) {
        return null;
    }
}

/**
 * Generates and writes ui/build-info.json during the build process.
 * @param {{ root?: string, now?: Date, gitCount?: number | null, commit?: string | null }} [options]
 * @returns {BuildInfo}
 */
function generateBuildInfo(options = {}) {
    const root = options.root ? path.resolve(options.root) : DEFAULT_ROOT;
    const targetPath = path.join(root, BUILD_INFO_REL);
    const version = readPackageVersion(root);
    const previous = readExistingFile(targetPath);

    let gitCount = 0;
    if (typeof options.gitCount === 'number' && Number.isInteger(options.gitCount) && options.gitCount >= 0) {
        gitCount = options.gitCount;
    }
    else {
        const rawCount = runGitSync(root, ['rev-list', '--count', 'HEAD']);
        const parsedCount = rawCount ? Number.parseInt(rawCount, 10) : 0;
        gitCount = Number.isInteger(parsedCount) && parsedCount > 0 ? parsedCount : 0;
    }

    const previousNumber = previous ? previous.buildNumber : 0;
    const buildNumber = Math.max(1, gitCount, previousNumber + 1);
    const buildDate = (options.now instanceof Date ? options.now : new Date()).toISOString();
    const commit = options.commit !== undefined ? options.commit : runGitSync(root, ['rev-parse', '--short', 'HEAD']);

    /** @type {BuildInfo} */
    const info = {
        version,
        buildNumber,
        buildDate,
        commit: commit || null,
        source: 'build'
    };

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    return info;
}

/**
 * Reads current build metadata for display in the app; falls back to live git metadata in dev checkouts.
 * @param {{ root?: string }} [options]
 * @returns {BuildInfo}
 */
function readBuildInfo(options = {}) {
    const root = options.root ? path.resolve(options.root) : DEFAULT_ROOT;
    const targetPath = path.join(root, BUILD_INFO_REL);
    const existing = readExistingFile(targetPath);
    if (existing) {
        return existing;
    }

    const version = readPackageVersion(root);
    const rawCount = runGitSync(root, ['rev-list', '--count', 'HEAD']);
    const parsedCount = rawCount ? Number.parseInt(rawCount, 10) : 0;
    const buildNumber = Number.isInteger(parsedCount) && parsedCount > 0 ? parsedCount : 0;
    const commit = runGitSync(root, ['rev-parse', '--short', 'HEAD']);

    return {
        version,
        buildNumber,
        buildDate: null,
        commit,
        source: 'dev'
    };
}

module.exports = {
    BUILD_INFO_REL,
    generateBuildInfo,
    readBuildInfo
};
