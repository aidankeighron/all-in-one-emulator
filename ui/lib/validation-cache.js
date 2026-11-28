// @ts-check

const fs = require('fs');
const path = require('path');

/** @typedef {import('./validate').ValidationResult} ValidationResult */
/** @typedef {import('./validate').ValidatorOptions} ValidatorOptions */
/** @typedef {import('./validate').RomValidator} RomValidator */

/**
 * Minimal game metadata needed to locate and validate a ROM file.
 * @typedef {object} GameEntry
 * @property {string} id
 * @property {string} title
 * @property {string} console
 * @property {string} emulator
 * @property {string} path
 */

/**
 * Cached validation record keyed by relative game path.
 * @typedef {object} ValidationCacheEntry
 * @property {number} size
 * @property {number} mtimeMs
 * @property {string} keysSignature
 * @property {ValidationResult} result
 */

/**
 * Persisted JSON structure for the validation cache file.
 * @typedef {object} ValidationCacheStore
 * @property {number} version
 * @property {Record<string, ValidationCacheEntry>} entries
 */

const CACHE_VERSION = 1;

/**
 * Computes a lightweight signature for Ryujinx prod.keys so adding or replacing keys invalidates cached Switch results.
 * @param {string | undefined} ryujinxDataRoot
 * @returns {string}
 */
function computeKeysSignature(ryujinxDataRoot) {
    if (!ryujinxDataRoot) {
        return 'none';
    }
    const keysFile = path.join(ryujinxDataRoot, 'system', 'prod.keys');
    try {
        const stat = fs.statSync(keysFile);
        if (!stat.isFile()) {
            return 'missing';
        }
        return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    }
    catch (error) {
        return 'missing';
    }
}

/**
 * Caches static ROM validation results on disk keyed by file path, size, mtime, and key state.
 */
class ValidationCache {
    /**
     * Creates a new ValidationCache instance.
     * @param {{ cacheFile: string, validator: RomValidator }} options
     */
    constructor({ cacheFile, validator }) {
        this.cacheFile = cacheFile;
        this.validator = validator;
        /** @type {Map<string, ValidationCacheEntry>} */
        this.entries = new Map();
        this.loaded = false;
        /** @type {Promise<unknown>} */
        this.queue = Promise.resolve();
    }

    /**
     * Loads cached entries from disk once if present and valid.
     * @returns {void}
     */
    load() {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        try {
            const raw = fs.readFileSync(this.cacheFile, 'utf8');
            /** @type {ValidationCacheStore} */
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
                return;
            }
            for (const [gamePath, entry] of Object.entries(parsed.entries)) {
                if (
                    entry &&
                    Number.isFinite(entry.size) &&
                    Number.isFinite(entry.mtimeMs) &&
                    typeof entry.keysSignature === 'string' &&
                    entry.result &&
                    typeof entry.result.status === 'string'
                ) {
                    this.entries.set(gamePath, entry);
                }
            }
        }
        catch (error) {
            this.entries.clear();
        }
    }

    /**
     * Atomically writes the current validation cache to disk.
     * @returns {void}
     */
    save() {
        const directory = path.dirname(this.cacheFile);
        fs.mkdirSync(directory, { recursive: true });
        /** @type {ValidationCacheStore} */
        const payload = {
            version: CACHE_VERSION,
            entries: Object.fromEntries(this.entries.entries())
        };
        const temporaryFile = `${this.cacheFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        fs.writeFileSync(temporaryFile, JSON.stringify(payload, null, 2));
        fs.renameSync(temporaryFile, this.cacheFile);
    }

    /**
     * Clears all cached validation entries in memory and removes the cache file if present.
     * @returns {void}
     */
    clear() {
        this.entries.clear();
        this.loaded = true;
        try {
            fs.rmSync(this.cacheFile, { force: true });
        }
        catch (error) {
            /* ignore removal errors when cache file is already absent */
        }
    }

    /**
     * Validates all scanned games, reusing cached results when size, mtime, and key signature are unchanged.
     * Serializes concurrent calls so startup pre-warming and API requests never race on cache writes.
     * @param {string} romsDir
     * @param {GameEntry[]} games
     * @param {ValidatorOptions} [options]
     * @returns {Promise<Map<string, ValidationResult>>}
     */
    validateGames(romsDir, games, options = {}) {
        const nextRun = this.queue.then(() => this._validateGamesInternal(romsDir, games, options));
        this.queue = nextRun.catch(() => undefined);
        return nextRun;
    }

    /**
     * Internal single-flight implementation for validateGames.
     * @param {string} romsDir
     * @param {GameEntry[]} games
     * @param {ValidatorOptions} [options]
     * @returns {Promise<Map<string, ValidationResult>>}
     */
    async _validateGamesInternal(romsDir, games, options = {}) {
        this.load();
        /** @type {Map<string, ValidationResult>} */
        const results = new Map();
        const activePaths = new Set(games.map((game) => game.path));
        let dirty = false;

        for (const cachedPath of [...this.entries.keys()]) {
            if (!activePaths.has(cachedPath)) {
                this.entries.delete(cachedPath);
                dirty = true;
            }
        }

        const switchKeysSignature = computeKeysSignature(options.ryujinxDataRoot);

        for (const game of games) {
            const absolutePath = path.join(romsDir, game.path);
            const keysSignature = game.emulator === 'ryujinx' ? switchKeysSignature : 'n/a';
            let stat;
            try {
                stat = fs.statSync(absolutePath);
            }
            catch (error) {
                const missingResult = await this.validator.validateFile(absolutePath, {
                    ...options,
                    emulator: game.emulator,
                    consoleName: game.console
                });
                results.set(game.path, missingResult);
                continue;
            }

            const mtimeMs = Math.round(stat.mtimeMs);
            const cached = this.entries.get(game.path);
            if (
                cached &&
                cached.size === stat.size &&
                cached.mtimeMs === mtimeMs &&
                cached.keysSignature === keysSignature
            ) {
                results.set(game.path, cached.result);
                continue;
            }

            const result = await this.validator.validateFile(absolutePath, {
                ...options,
                emulator: game.emulator,
                consoleName: game.console
            });
            this.entries.set(game.path, {
                size: stat.size,
                mtimeMs,
                keysSignature,
                result
            });
            results.set(game.path, result);
            dirty = true;
        }

        if (dirty) {
            try {
                this.save();
            }
            catch (error) {
                /* cache persistence failure should not break game listing */
            }
        }

        return results;
    }
}

module.exports = {
    ValidationCache,
    computeKeysSignature
};
