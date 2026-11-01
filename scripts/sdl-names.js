// Rebuilds ui/lib/sdlnames.json: the names SDL gives controllers, which is what Dolphin calls them ("SDL/0/<name>").
// SDL does not use the name the kernel reports: it has its own names for well-known controllers (by vendor and product),
// and a controller found in its built-in mapping database is called by the name in that database.
//
// Use the SDL that Dolphin's Flatpak is built with (its Externals/SDL/SDL submodule), since that decides the names:
//   node scripts/sdl-names.js --ref=<SDL commit>     downloads that commit's sources from GitHub (default: main)
//   node scripts/sdl-names.js <dir> [--ref=<commit>] reads controller_list.h and SDL_gamepad_db.h from a folder
// To find the commit: the `commit:` of dolphin in github.com/flathub/org.DolphinEmu.dolphin-emu, then
// `git ls-tree <that commit> Externals/SDL/SDL` in a Dolphin checkout.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const REF = (args.find(a => a.startsWith('--ref=')) || '--ref=main').slice(6);
const BASE = `https://raw.githubusercontent.com/libsdl-org/SDL/${REF}/src/joystick/`;

async function read(dir, name) {
    if (dir) return fs.readFileSync(path.join(dir, name), 'utf8');
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.text();
}

async function main() {
    const dir = args.find(a => !a.startsWith('--'));
    const list = await read(dir, 'controller_list.h');
    const db = await read(dir, 'SDL_gamepad_db.h');

    // { MAKE_CONTROLLER_ID( 0x045e, 0x028e ), k_eControllerType_XBox360Controller, "Xbox 360 Controller" }
    const names = {};
    for (const m of list.matchAll(/^\s*\{\s*MAKE_CONTROLLER_ID\(\s*0x([0-9a-f]{4}),\s*0x([0-9a-f]{4})\s*\),\s*\w+,\s*"([^"]+)"/gim)) {
        const key = `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
        if (!(key in names)) names[key] = m[3];
    }

    // The Linux part of the database: "guid,name,...,crc:xxxx,..."
    const start = db.indexOf('#if defined(SDL_JOYSTICK_LINUX)');
    if (start < 0) throw new Error('No Linux section in SDL_gamepad_db.h');
    const linuxPart = db.slice(start, db.indexOf('#endif', start));
    const linux = [];
    for (const m of linuxPart.matchAll(/^\s*"([0-9a-f]{32}),([^,]*),([^"]*)"/gim)) {
        let guid = m[1].toLowerCase();
        let crc = (/(?:^|,)crc:([0-9a-f]{4})/i.exec(m[3]) || [])[1];
        // Older databases keep the name's checksum inside the id (bytes 2-3, little-endian) instead of a crc: field
        if (guid.slice(4, 8) !== '0000') { crc = crc || guid.slice(6, 8) + guid.slice(4, 6); guid = guid.slice(0, 4) + '0000' + guid.slice(8); }
        linux.push(crc ? [guid, m[2], crc.toLowerCase()] : [guid, m[2]]);
    }

    const out = path.join(__dirname, '..', 'ui', 'lib', 'sdlnames.json');
    fs.writeFileSync(out, JSON.stringify({ source: `libsdl-org/SDL ${REF} src/joystick (controller_list.h, SDL_gamepad_db.h)`, names, linux }) + '\n');
    console.log(`${Object.keys(names).length} names, ${linux.length} Linux mappings -> ${out}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
