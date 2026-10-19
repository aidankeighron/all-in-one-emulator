// Minimal INI editor that keeps everything it does not touch (comments, order, other sections),
// so rewriting an emulator's config only changes the entries we mean to change.
const fs = require('fs');

class Ini {
    constructor(text = '') {
        this.lines = text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    }

    static read(file) {
        try { return new Ini(fs.readFileSync(file, 'utf8')); } catch { return new Ini(''); }
    }

    // [start, end) of the section's body lines, or null if there is no such section
    range(section) {
        const start = this.lines.findIndex(l => l.trim() === `[${section}]`);
        if (start < 0) return null;
        let end = this.lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l));
        if (end < 0) end = this.lines.length;
        return [start + 1, end];
    }

    has(section) {
        return this.range(section) !== null;
    }

    get(section, key) {
        const r = this.range(section);
        if (!r) return undefined;
        for (let i = r[0]; i < r[1]; i++) {
            const m = this.lines[i].match(/^\s*([^=]+?)\s*=\s*(.*)$/);
            if (m && m[1] === key) return m[2];
        }
        return undefined;
    }

    // Sets one key, adding the section if needed
    set(section, key, value) {
        let r = this.range(section);
        if (!r) {
            if (this.lines.length && this.lines[this.lines.length - 1].trim() !== '') this.lines.push('');
            this.lines.push(`[${section}]`);
            r = [this.lines.length, this.lines.length];
        }
        for (let i = r[0]; i < r[1]; i++) {
            const m = this.lines[i].match(/^\s*([^=]+?)\s*=/);
            if (m && m[1] === key) { this.lines[i] = `${key} = ${value}`; return this; }
        }
        let at = r[1];
        while (at > r[0] && this.lines[at - 1].trim() === '') at--; // stay above the blank gap before the next section
        this.lines.splice(at, 0, `${key} = ${value}`);
        return this;
    }

    // Replaces the whole section body with these [key, value] pairs
    replaceSection(section, entries) {
        const body = entries.map(([k, v]) => `${k} = ${v}`);
        const r = this.range(section);
        if (!r) {
            if (this.lines.length && this.lines[this.lines.length - 1].trim() !== '') this.lines.push('');
            this.lines.push(`[${section}]`, ...body);
            return this;
        }
        const trailingBlank = r[1] > r[0] && this.lines[r[1] - 1].trim() === '' ? [''] : [];
        this.lines.splice(r[0], r[1] - r[0], ...body, ...trailingBlank);
        return this;
    }

    toString() {
        return this.lines.join('\n') + '\n';
    }
}

// Writes the file only if it changed, keeping a one-time copy of the original next to it.
// Returns true when something was written.
function save(file, ini, backupSuffix = '.emulator-menu.bak') {
    const next = ini.toString();
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
    if (current !== null && current.replace(/\r\n/g, '\n') === next) return false;
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    if (current !== null && !fs.existsSync(file + backupSuffix)) fs.copyFileSync(file, file + backupSuffix);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    return true;
}

module.exports = { Ini, save };
