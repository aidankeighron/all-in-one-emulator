// Client-side encryption for saves pushed to a repository other people may be able to read.
// AES-256-GCM, with keys derived from a passphrase by scrypt. Names of folders in the repo are HMACs,
// so the repo shows only random-looking names and ciphertext.
const crypto = require('crypto');

const MAGIC = Buffer.from('EMS1');
const keyCache = new Map();

function deriveKeys(passphrase, saltHex) {
    const id = `${saltHex}\0${passphrase}`;
    if (keyCache.has(id)) return keyCache.get(id);
    const master = crypto.scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    const sub = label => crypto.createHmac('sha256', master).update(label).digest();
    const keys = { enc: sub('enc'), name: sub('name') };
    keyCache.set(id, keys);
    return keys;
}

function encrypt(buf, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(buf), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function decrypt(buf, key) {
    if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('not an encrypted save file');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
    decipher.setAuthTag(buf.subarray(16, 32));
    try {
        return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
    } catch {
        throw new Error('wrong passphrase, or the file is damaged');
    }
}

// Stable, meaningless-looking folder name for a game
function opaqueName(nameKey, text) {
    return crypto.createHmac('sha256', nameKey).update(text).digest('hex').slice(0, 24);
}

const newSalt = () => crypto.randomBytes(16).toString('hex');

module.exports = { deriveKeys, encrypt, decrypt, opaqueName, newSalt };
