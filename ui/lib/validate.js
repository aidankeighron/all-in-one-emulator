// @ts-check

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yauzl = require('yauzl');

const fileSystemPromises = fs.promises;

/** @typedef {'ok' | 'error' | 'unknown'} ValidationStatus */
/** @typedef {'MISSING_FILE' | 'EMPTY_FILE' | 'BAD_HEADER' | 'CORRUPT_ARCHIVE' | 'MISSING_KEYS' | 'UNSUPPORTED_FORMAT' | 'TOOL_ERROR'} ValidationCode */

/**
 * Standardized static validation result for a ROM or game file.
 * @typedef {object} ValidationResult
 * @property {ValidationStatus} status
 * @property {ValidationCode | null} code
 * @property {string} reason
 * @property {number} checkedAt
 */

/**
 * Options controlling static ROM validation.
 * @typedef {object} ValidatorOptions
 * @property {string} [emulator]
 * @property {string} [consoleName]
 * @property {string} [ryujinxDataRoot]
 * @property {string} [keysPath]
 * @property {boolean} [useCliTools]
 * @property {number} [timeoutMs]
 * @property {() => number} [now]
 * @property {typeof execFile} [execFileImpl]
 */

/**
 * Normalized descriptor for an external CLI verification tool.
 * @typedef {object} CliToolCommand
 * @property {string} name
 * @property {string} binary
 * @property {string[]} args
 */

const WII_MAGIC = 0x5d1c9ea3;
const GAMECUBE_MAGIC = 0xc2339f3d;
const GCZ_MAGIC = 0xb10bc001;
const SWITCH_KEY_REQUIRED_EXTENSIONS = new Set(['nsp', 'xci', 'nca']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z']);
const SUPPORTED_ROM_EXTENSIONS = new Set([
    'iso',
    'gcm',
    'rvz',
    'wia',
    'wbfs',
    'ciso',
    'gcz',
    'wad',
    'nsp',
    'xci',
    'nca',
    'nro',
    'nso'
]);

/**
 * Reads a slice of a file without loading the entire file into memory.
 * @param {string} filePath
 * @param {number} offset
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readFileSlice(filePath, offset, length) {
    const handle = await fileSystemPromises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}

/**
 * Aligns a byte length up to a 64-byte boundary (used by Wii WAD sections).
 * @param {number} value
 * @returns {number}
 */
function alignTo64Bytes(value) {
    return Math.ceil(value / 64) * 64;
}

/**
 * Detects whether a header buffer looks like HTML or a compressed archive.
 * @param {Buffer} headerBuffer
 * @returns {{ kind: 'html' | 'zip' | 'rar' | '7z' | 'gzip', label: string } | null}
 */
function detectNonRomSignature(headerBuffer) {
    if (headerBuffer.length < 2) {
        return null;
    }
    const prefix4 = headerBuffer.subarray(0, 4).toString('hex');
    if (prefix4 === '504b0304' || prefix4 === '504b0506' || prefix4 === '504b0708') {
        return { kind: 'zip', label: 'ZIP archive' };
    }
    if (prefix4 === '52617221') {
        return { kind: 'rar', label: 'RAR archive' };
    }
    if (headerBuffer.length >= 6 && headerBuffer.subarray(0, 6).toString('hex') === '377abcaf271c') {
        return { kind: '7z', label: '7-Zip archive' };
    }
    if (headerBuffer[0] === 0x1f && headerBuffer[1] === 0x8b) {
        return { kind: 'gzip', label: 'gzip archive' };
    }
    const asciiStart = headerBuffer.subarray(0, 16).toString('utf8').trimStart().toLowerCase();
    if (asciiStart.startsWith('<!doctype') || asciiStart.startsWith('<html')) {
        return { kind: 'html', label: 'HTML page' };
    }
    return null;
}

/**
 * Validates that a ZIP archive's central directory can be opened cleanly.
 * @param {string} filePath
 * @returns {Promise<{ valid: boolean, reason: string }>}
 */
function verifyZipArchive(filePath) {
    return new Promise((resolve) => {
        yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, zipFile) => {
            if (openError || !zipFile) {
                resolve({
                    valid: false,
                    reason: `Corrupt or incomplete ZIP archive: ${openError ? openError.message : 'cannot open'}`
                });
                return;
            }
            let settled = false;
            const finish = (valid, reason) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve({ valid, reason });
            };
            zipFile.on('error', (entryError) => {
                finish(false, `Corrupt ZIP archive: ${entryError.message}`);
            });
            zipFile.on('end', () => {
                finish(true, 'ZIP central directory is valid');
            });
            zipFile.on('entry', () => {
                zipFile.readEntry();
            });
            zipFile.readEntry();
        });
    });
}

/**
 * Checks whether a binary exists on PATH (or in standard Windows/Linux locations).
 * @param {string} binaryName
 * @returns {string | null}
 */
function findExecutableOnPath(binaryName) {
    const isWindows = process.platform === 'win32';
    const fileName = isWindows && !binaryName.endsWith('.exe') ? `${binaryName}.exe` : binaryName;
    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const directory of pathEntries) {
        const candidate = path.join(directory, fileName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Static ROM and archive validator using fast pure-Node header checks and optional CLI tools.
 */
class RomValidator {
    /**
     * Creates a new RomValidator instance.
     * @param {ValidatorOptions} [defaultOptions]
     */
    constructor(defaultOptions = {}) {
        this.defaultOptions = defaultOptions;
    }

    /**
     * Builds a standardized ValidationResult object.
     * @param {ValidationStatus} status
     * @param {ValidationCode | null} code
     * @param {string} reason
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    createResult(status, code, reason, nowFn) {
        return {
            status,
            code,
            reason,
            checkedAt: nowFn()
        };
    }

    /**
     * Resolves the expected Ryujinx prod.keys path from validator options.
     * @param {ValidatorOptions} options
     * @returns {string | null}
     */
    resolveKeysPath(options) {
        if (typeof options.keysPath === 'string' && options.keysPath.length > 0) {
            return options.keysPath;
        }
        if (typeof options.ryujinxDataRoot === 'string' && options.ryujinxDataRoot.length > 0) {
            return path.join(options.ryujinxDataRoot, 'system', 'prod.keys');
        }
        return null;
    }

    /**
     * Checks if Ryujinx prod.keys exists and is non-empty.
     * @param {ValidatorOptions} options
     * @returns {Promise<{ checked: boolean, present: boolean, reason: string }>}
     */
    async checkSwitchKeys(options) {
        const keysPath = this.resolveKeysPath(options);
        if (!keysPath) {
            return { checked: false, present: true, reason: '' };
        }
        try {
            const stat = await fileSystemPromises.stat(keysPath);
            if (!stat.isFile() || stat.size === 0) {
                return {
                    checked: true,
                    present: false,
                    reason: 'Ryujinx prod.keys is empty or not a file'
                };
            }
            return { checked: true, present: true, reason: '' };
        }
        catch (error) {
            return {
                checked: true,
                present: false,
                reason: 'Missing Ryujinx prod.keys in the Ryujinx system folder'
            };
        }
    }

    /**
     * Validates a single game or archive file statically without launching an emulator.
     * @param {string} filePath
     * @param {ValidatorOptions} [options]
     * @returns {Promise<ValidationResult>}
     */
    async validateFile(filePath, options = {}) {
        const merged = { ...this.defaultOptions, ...options };
        const nowFn = typeof merged.now === 'function' ? merged.now : Date.now;

        if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath.includes('\0')) {
            return this.createResult('error', 'MISSING_FILE', 'Invalid file path', nowFn);
        }

        let stat;
        try {
            stat = await fileSystemPromises.stat(filePath);
        }
        catch (error) {
            return this.createResult('error', 'MISSING_FILE', 'Game file does not exist or cannot be read', nowFn);
        }

        if (!stat.isFile()) {
            return this.createResult('error', 'MISSING_FILE', 'Path is not a regular file', nowFn);
        }

        if (stat.size === 0) {
            return this.createResult('error', 'EMPTY_FILE', 'Game file is empty (0 bytes)', nowFn);
        }

        const extension = path.extname(filePath).slice(1).toLowerCase();

        if (ARCHIVE_EXTENSIONS.has(extension)) {
            return this.validateArchive(filePath, extension, stat.size, nowFn);
        }

        if (!SUPPORTED_ROM_EXTENSIONS.has(extension)) {
            return this.createResult(
                'unknown',
                'UNSUPPORTED_FORMAT',
                `Unsupported or unrecognized format: .${extension || '(none)'}`,
                nowFn
            );
        }

        const headerResult = await this.validateRomHeader(filePath, extension, stat.size, merged, nowFn);
        if (headerResult.status === 'error') {
            return headerResult;
        }

        if (SWITCH_KEY_REQUIRED_EXTENSIONS.has(extension)) {
            const keysStatus = await this.checkSwitchKeys(merged);
            if (keysStatus.checked && !keysStatus.present) {
                return this.createResult('error', 'MISSING_KEYS', keysStatus.reason, nowFn);
            }
        }

        if (merged.useCliTools && (extension === 'nca' || headerResult.status === 'unknown')) {
            const toolResult = await this.runOptionalCliTool(filePath, extension, merged, nowFn);
            if (toolResult) {
                return toolResult;
            }
        }

        return headerResult;
    }

    /**
     * Validates an archive file (.zip, .rar, .7z).
     * @param {string} filePath
     * @param {string} extension
     * @param {number} fileSize
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult>}
     */
    async validateArchive(filePath, extension, fileSize, nowFn) {
        const head = await readFileSlice(filePath, 0, Math.min(fileSize, 32));
        const magic4 = head.subarray(0, 4).toString('hex');

        if (extension === 'zip') {
            if (magic4 !== '504b0304' && magic4 !== '504b0506') {
                return this.createResult('error', 'CORRUPT_ARCHIVE', 'File does not start with a valid ZIP signature', nowFn);
            }
            const zipCheck = await verifyZipArchive(filePath);
            if (!zipCheck.valid) {
                return this.createResult('error', 'CORRUPT_ARCHIVE', zipCheck.reason, nowFn);
            }
            return this.createResult('ok', null, 'Valid ZIP archive', nowFn);
        }

        if (extension === 'rar') {
            if (magic4 !== '52617221' || fileSize < 20) {
                return this.createResult('error', 'CORRUPT_ARCHIVE', 'File is not a valid or complete RAR archive', nowFn);
            }
            return this.createResult('ok', null, 'Valid RAR archive header', nowFn);
        }

        if (extension === '7z') {
            if (head.length < 32 || head.subarray(0, 6).toString('hex') !== '377abcaf271c') {
                return this.createResult('error', 'CORRUPT_ARCHIVE', 'File is not a valid or complete 7z archive', nowFn);
            }
            const nextHeaderOffset = head.readBigUInt64LE(12);
            const nextHeaderSize = head.readBigUInt64LE(20);
            if (32n + nextHeaderOffset + nextHeaderSize > BigInt(fileSize)) {
                return this.createResult('error', 'CORRUPT_ARCHIVE', '7z archive appears truncated (header extends past end of file)', nowFn);
            }
            return this.createResult('ok', null, 'Valid 7z archive header', nowFn);
        }

        return this.createResult('unknown', 'UNSUPPORTED_FORMAT', `Unsupported archive format: .${extension}`, nowFn);
    }

    /**
     * Dispatches pure-Node header validation by ROM extension.
     * @param {string} filePath
     * @param {string} extension
     * @param {number} fileSize
     * @param {ValidatorOptions} options
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult>}
     */
    async validateRomHeader(filePath, extension, fileSize, options, nowFn) {
        const leading = await readFileSlice(filePath, 0, Math.min(fileSize, 64));

        if (extension === 'iso' || extension === 'gcm') {
            return this.validateIsoOrGcm(filePath, extension, fileSize, leading, nowFn);
        }
        if (extension === 'rvz' || extension === 'wia') {
            return this.validateRvzOrWia(filePath, extension, fileSize, leading, nowFn);
        }
        if (extension === 'wbfs') {
            return this.validateWbfs(filePath, fileSize, leading, nowFn);
        }
        if (extension === 'ciso') {
            return this.validateCiso(fileSize, leading, nowFn);
        }
        if (extension === 'gcz') {
            return this.validateGcz(fileSize, leading, nowFn);
        }
        if (extension === 'wad') {
            return this.validateWad(fileSize, leading, nowFn);
        }
        if (extension === 'nsp') {
            return this.validateNsp(filePath, fileSize, leading, nowFn);
        }
        if (extension === 'xci') {
            return this.validateXci(filePath, fileSize, leading, nowFn);
        }
        if (extension === 'nca') {
            return this.validateNca(fileSize, leading, options, nowFn);
        }
        if (extension === 'nro') {
            return this.validateNro(fileSize, leading, nowFn);
        }
        if (extension === 'nso') {
            return this.validateNso(fileSize, leading, nowFn);
        }

        return this.createResult('unknown', 'UNSUPPORTED_FORMAT', `Unsupported format: .${extension}`, nowFn);
    }

    /**
     * Classifies a failed ROM header using common HTML/archive signatures before falling back to BAD_HEADER.
     * @param {Buffer} leading
     * @param {string} extension
     * @param {string} defaultReason
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    classifyInvalidHeader(leading, extension, defaultReason, nowFn) {
        const detected = detectNonRomSignature(leading);
        if (detected) {
            if (detected.kind === 'html') {
                return this.createResult(
                    'error',
                    'BAD_HEADER',
                    `File appears to be an HTML page (failed download?) instead of a .${extension} image`,
                    nowFn
                );
            }
            return this.createResult(
                'error',
                'CORRUPT_ARCHIVE',
                `File is an unextracted ${detected.label} renamed or left as .${extension}`,
                nowFn
            );
        }
        return this.createResult('error', 'BAD_HEADER', defaultReason, nowFn);
    }

    /**
     * Validates GameCube/Wii .iso and .gcm disc images.
     * @param {string} filePath
     * @param {string} extension
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult>}
     */
    async validateIsoOrGcm(filePath, extension, fileSize, leading, nowFn) {
        if (fileSize < 0x20) {
            return this.classifyInvalidHeader(
                leading,
                extension,
                `File is too small (${fileSize} bytes) to contain a valid disc header`,
                nowFn
            );
        }

        const wiiMagic = leading.readUInt32BE(0x18);
        const gamecubeMagic = leading.readUInt32BE(0x1c);

        if (extension === 'gcm') {
            if (gamecubeMagic !== GAMECUBE_MAGIC) {
                return this.classifyInvalidHeader(
                    leading,
                    extension,
                    'Missing GameCube disc magic bytes (0xC2339F3D at offset 0x1C)',
                    nowFn
                );
            }
            return this.createResult('ok', null, 'Valid GameCube disc header', nowFn);
        }

        if (wiiMagic !== WII_MAGIC && gamecubeMagic !== GAMECUBE_MAGIC) {
            return this.classifyInvalidHeader(
                leading,
                extension,
                'Missing Wii/GameCube disc magic bytes in ISO header',
                nowFn
            );
        }

        return this.createResult('ok', null, 'Valid Wii/GameCube disc header', nowFn);
    }

    /**
     * Validates Dolphin .rvz and .wia compressed disc images.
     * @param {string} filePath
     * @param {string} extension
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult>}
     */
    async validateRvzOrWia(filePath, extension, fileSize, leading, nowFn) {
        if (fileSize < 0x4c) {
            return this.classifyInvalidHeader(
                leading,
                extension,
                `File is too small (${fileSize} bytes) to contain a valid ${extension.toUpperCase()} header`,
                nowFn
            );
        }

        const header = await readFileSlice(filePath, 0, 0x4c);
        const expectedMagic = extension === 'rvz' ? 'RVZ\x01' : 'WIA\x01';
        const actualMagic = header.subarray(0, 4).toString('latin1');
        if (actualMagic !== expectedMagic) {
            return this.classifyInvalidHeader(
                leading,
                extension,
                `Invalid ${extension.toUpperCase()} magic header`,
                nowFn
            );
        }

        const discType = header.readUInt32BE(0x48);
        if (discType !== 1 && discType !== 2) {
            return this.createResult(
                'error',
                'BAD_HEADER',
                `Invalid ${extension.toUpperCase()} disc type (${discType})`,
                nowFn
            );
        }

        const declaredFileSize = header.readBigUInt64BE(0x2c);
        if (declaredFileSize > 0n && BigInt(fileSize) < declaredFileSize) {
            return this.createResult(
                'error',
                'BAD_HEADER',
                `${extension.toUpperCase()} file is truncated (${fileSize} of ${declaredFileSize} bytes)`,
                nowFn
            );
        }

        return this.createResult('ok', null, `Valid ${extension.toUpperCase()} disc header`, nowFn);
    }

    /**
     * Validates Wii .wbfs images.
     * @param {string} filePath
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult>}
     */
    async validateWbfs(filePath, fileSize, leading, nowFn) {
        if (fileSize < 0x220) {
            return this.classifyInvalidHeader(
                leading,
                'wbfs',
                `File is too small (${fileSize} bytes) to contain a valid WBFS header`,
                nowFn
            );
        }

        if (leading.subarray(0, 4).toString('latin1') !== 'WBFS') {
            return this.classifyInvalidHeader(leading, 'wbfs', 'Missing WBFS magic header', nowFn);
        }

        const discHeader = await readFileSlice(filePath, 0x200, 0x20);
        if (discHeader.length < 0x20 || discHeader.readUInt32BE(0x18) !== WII_MAGIC) {
            return this.createResult('error', 'BAD_HEADER', 'WBFS container is missing a valid Wii disc header', nowFn);
        }

        return this.createResult('ok', null, 'Valid WBFS image header', nowFn);
    }

    /**
     * Validates Dolphin .ciso compact disc images.
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    validateCiso(fileSize, leading, nowFn) {
        if (fileSize < 0x8000) {
            return this.classifyInvalidHeader(
                leading,
                'ciso',
                `File is too small (${fileSize} bytes) to contain a complete CISO header`,
                nowFn
            );
        }

        if (leading.subarray(0, 4).toString('latin1') !== 'CISO') {
            return this.classifyInvalidHeader(leading, 'ciso', 'Missing CISO magic header', nowFn);
        }

        const blockSize = leading.readUInt32LE(0x04);
        if (blockSize === 0) {
            return this.createResult('error', 'BAD_HEADER', 'Invalid CISO block size (0)', nowFn);
        }

        return this.createResult('ok', null, 'Valid CISO header', nowFn);
    }

    /**
     * Validates Dolphin .gcz compressed disc images.
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    validateGcz(fileSize, leading, nowFn) {
        if (fileSize < 0x20) {
            return this.classifyInvalidHeader(
                leading,
                'gcz',
                `File is too small (${fileSize} bytes) to contain a valid GCZ header`,
                nowFn
            );
        }

        if (leading.readUInt32LE(0x00) !== GCZ_MAGIC) {
            return this.classifyInvalidHeader(leading, 'gcz', 'Missing GCZ magic header', nowFn);
        }

        const blockSize = leading.readUInt32LE(0x18);
        const blockCount = leading.readUInt32LE(0x1c);
        if (blockSize === 0 || blockCount === 0) {
            return this.createResult('error', 'BAD_HEADER', 'GCZ header has zero block size or block count', nowFn);
        }

        return this.createResult('ok', null, 'Valid GCZ header', nowFn);
    }

    /**
     * Validates Wii .wad installable channel packages.
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    validateWad(fileSize, leading, nowFn) {
        if (fileSize < 0x20) {
            return this.classifyInvalidHeader(
                leading,
                'wad',
                `File is too small (${fileSize} bytes) to contain a valid WAD header`,
                nowFn
            );
        }

        const headerSize = leading.readUInt32BE(0x00);
        const wadType = leading.subarray(0x04, 0x08).toString('latin1');
        if (headerSize !== 0x20 || !['Is\x00\x00', 'ib\x00\x00', 'Bk\x00\x00'].includes(wadType)) {
            return this.classifyInvalidHeader(leading, 'wad', 'Invalid Wii WAD header', nowFn);
        }

        const certsSize = alignTo64Bytes(leading.readUInt32BE(0x08));
        const crlSize = alignTo64Bytes(leading.readUInt32BE(0x0c));
        const ticketSize = alignTo64Bytes(leading.readUInt32BE(0x10));
        const tmdSize = alignTo64Bytes(leading.readUInt32BE(0x14));
        const dataSize = alignTo64Bytes(leading.readUInt32BE(0x18));
        const footerSize = alignTo64Bytes(leading.readUInt32BE(0x1c));
        const minimumTotal = 64 + certsSize + crlSize + ticketSize + tmdSize + dataSize + footerSize;

        if (fileSize < minimumTotal) {
            return this.createResult(
                'error',
                'BAD_HEADER',
                `WAD file is truncated (${fileSize} of ${minimumTotal} expected bytes)`,
                nowFn
            );
        }

        return this.createResult('ok', null, 'Valid Wii WAD package', nowFn);
    }

    /**
     * Validates Nintendo Switch .nsp (PFS0) packages.
     * @param {string} filePath
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult>}
     */
    async validateNsp(filePath, fileSize, leading, nowFn) {
        if (fileSize < 0x10) {
            return this.classifyInvalidHeader(
                leading,
                'nsp',
                `File is too small (${fileSize} bytes) to contain a valid NSP header`,
                nowFn
            );
        }

        if (leading.subarray(0, 4).toString('latin1') !== 'PFS0') {
            return this.classifyInvalidHeader(leading, 'nsp', 'Missing PFS0 magic header in NSP file', nowFn);
        }

        const fileCount = leading.readUInt32LE(0x04);
        const stringTableSize = leading.readUInt32LE(0x08);
        if (fileCount === 0) {
            return this.createResult('error', 'BAD_HEADER', 'NSP archive contains 0 files', nowFn);
        }

        const dataStart = 16 + fileCount * 24 + stringTableSize;
        if (dataStart > fileSize) {
            return this.createResult('error', 'BAD_HEADER', 'NSP header table extends past end of file', nowFn);
        }

        if (fileCount <= 4096) {
            const entriesBuffer = await readFileSlice(filePath, 16, fileCount * 24);
            for (let index = 0; index < fileCount; index++) {
                const entryBase = index * 24;
                const entryOffset = entriesBuffer.readBigUInt64LE(entryBase);
                const entrySize = entriesBuffer.readBigUInt64LE(entryBase + 8);
                if (BigInt(dataStart) + entryOffset + entrySize > BigInt(fileSize)) {
                    return this.createResult(
                        'error',
                        'BAD_HEADER',
                        'NSP file is truncated (content entry extends past end of file)',
                        nowFn
                    );
                }
            }
        }

        return this.createResult('ok', null, 'Valid NSP (PFS0) package', nowFn);
    }

    /**
     * Validates Nintendo Switch .xci gamecard images.
     * @param {string} filePath
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult>}
     */
    async validateXci(filePath, fileSize, leading, nowFn) {
        if (fileSize < 0x200) {
            return this.classifyInvalidHeader(
                leading,
                'xci',
                `File is too small (${fileSize} bytes) to contain a valid XCI header`,
                nowFn
            );
        }

        const standardHeader = await readFileSlice(filePath, 0x100, 0x20);
        const hasStandardMagic = standardHeader.subarray(0, 4).toString('latin1') === 'HEAD';

        let hasKeyAreaMagic = false;
        if (!hasStandardMagic && fileSize >= 0x1200) {
            const keyAreaHeader = await readFileSlice(filePath, 0x1100, 0x20);
            hasKeyAreaMagic = keyAreaHeader.subarray(0, 4).toString('latin1') === 'HEAD';
        }

        if (!hasStandardMagic && !hasKeyAreaMagic) {
            return this.classifyInvalidHeader(leading, 'xci', 'Missing HEAD magic in XCI gamecard header', nowFn);
        }

        return this.createResult('ok', null, 'Valid XCI gamecard header', nowFn);
    }

    /**
     * Performs basic static checks on encrypted Nintendo Switch .nca files.
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {ValidatorOptions} options
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    validateNca(fileSize, leading, options, nowFn) {
        const detected = detectNonRomSignature(leading);
        if (detected) {
            if (detected.kind === 'html') {
                return this.createResult(
                    'error',
                    'BAD_HEADER',
                    'File appears to be an HTML page (failed download?) instead of an NCA',
                    nowFn
                );
            }
            return this.createResult(
                'error',
                'CORRUPT_ARCHIVE',
                `File is an unextracted ${detected.label} renamed or left as .nca`,
                nowFn
            );
        }

        if (fileSize < 0xc00) {
            return this.createResult(
                'error',
                'BAD_HEADER',
                `File is too small (${fileSize} bytes) to contain an NCA header`,
                nowFn
            );
        }

        if (!options.useCliTools) {
            return this.createResult(
                'unknown',
                null,
                'Encrypted NCA header cannot be verified without nstool or hactool',
                nowFn
            );
        }

        return this.createResult('unknown', null, 'Pending CLI verification for encrypted NCA', nowFn);
    }

    /**
     * Validates Nintendo Switch .nro homebrew executables.
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    validateNro(fileSize, leading, nowFn) {
        if (fileSize < 0x20) {
            return this.classifyInvalidHeader(
                leading,
                'nro',
                `File is too small (${fileSize} bytes) to contain a valid NRO header`,
                nowFn
            );
        }

        if (leading.subarray(0x10, 0x14).toString('latin1') !== 'NRO0') {
            return this.classifyInvalidHeader(leading, 'nro', 'Missing NRO0 magic header', nowFn);
        }

        const declaredSize = leading.readUInt32LE(0x18);
        if (declaredSize < 0x20 || declaredSize > fileSize) {
            return this.createResult(
                'error',
                'BAD_HEADER',
                `NRO file appears truncated or invalid (declared size ${declaredSize}, actual ${fileSize} bytes)`,
                nowFn
            );
        }

        return this.createResult('ok', null, 'Valid NRO executable header', nowFn);
    }

    /**
     * Validates Nintendo Switch .nso executable modules.
     * @param {number} fileSize
     * @param {Buffer} leading
     * @param {() => number} nowFn
     * @returns {ValidationResult}
     */
    validateNso(fileSize, leading, nowFn) {
        if (fileSize < 0x100) {
            return this.classifyInvalidHeader(
                leading,
                'nso',
                `File is too small (${fileSize} bytes) to contain a valid NSO header`,
                nowFn
            );
        }

        if (leading.subarray(0, 4).toString('latin1') !== 'NSO0') {
            return this.classifyInvalidHeader(leading, 'nso', 'Missing NSO0 magic header', nowFn);
        }

        return this.createResult('ok', null, 'Valid NSO executable header', nowFn);
    }

    /**
     * Resolves an optional CLI verification tool (nstool or hactool) if installed.
     * @param {string} filePath
     * @param {string} extension
     * @param {ValidatorOptions} options
     * @returns {CliToolCommand | null}
     */
    resolveCliTool(filePath, extension, options) {
        if (extension === 'nca') {
            const keysPath = this.resolveKeysPath(options);
            const nstoolBinary = findExecutableOnPath('nstool');
            if (nstoolBinary && keysPath) {
                return {
                    name: 'nstool',
                    binary: nstoolBinary,
                    args: ['-k', keysPath, '-t', 'nca', filePath]
                };
            }
            const hactoolBinary = findExecutableOnPath('hactool');
            if (hactoolBinary && keysPath) {
                return {
                    name: 'hactool',
                    binary: hactoolBinary,
                    args: ['-k', keysPath, '-t', 'nca', filePath]
                };
            }
        }
        return null;
    }

    /**
     * Runs an optional CLI tool to inspect formats whose headers are encrypted.
     * @param {string} filePath
     * @param {string} extension
     * @param {ValidatorOptions} options
     * @param {() => number} nowFn
     * @returns {Promise<ValidationResult | null>}
     */
    runOptionalCliTool(filePath, extension, options, nowFn) {
        const command = this.resolveCliTool(filePath, extension, options);
        if (!command) {
            return Promise.resolve(null);
        }

        const execImpl = options.execFileImpl || execFile;
        const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 5000;

        return new Promise((resolve) => {
            execImpl(
                command.binary,
                command.args,
                { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
                (error, stdout, stderr) => {
                    if (!error) {
                        resolve(this.createResult('ok', null, `Verified with ${command.name}`, nowFn));
                        return;
                    }
                    const output = `${stderr || ''}\n${stdout || ''}`.trim();
                    if (/invalid|corrupt|magic|decrypt|signature/i.test(output)) {
                        resolve(this.createResult('error', 'BAD_HEADER', `${command.name}: ${output.split('\n')[0]}`, nowFn));
                        return;
                    }
                    resolve(
                        this.createResult(
                            'unknown',
                            'TOOL_ERROR',
                            `${command.name} failed: ${error.message}`,
                            nowFn
                        )
                    );
                }
            );
        });
    }
}

const defaultValidator = new RomValidator();

/**
 * Validates a single ROM or archive file using the default RomValidator.
 * @param {string} filePath
 * @param {ValidatorOptions} [options]
 * @returns {Promise<ValidationResult>}
 */
function validateFile(filePath, options) {
    return defaultValidator.validateFile(filePath, options);
}

module.exports = {
    RomValidator,
    defaultValidator,
    validateFile,
    detectNonRomSignature,
    SUPPORTED_ROM_EXTENSIONS,
    SWITCH_KEY_REQUIRED_EXTENSIONS
};
