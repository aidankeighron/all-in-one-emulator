const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const PORT = 3000;
const ROMS_DIR = path.resolve(__dirname, '../roms');

// Scan roms directory dynamically
function getGames() {
    const games = [];
    if (!fs.existsSync(ROMS_DIR)) return games;

    const consoles = fs.readdirSync(ROMS_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
        .map(dirent => dirent.name);

    consoles.forEach(consoleName => {
        const consolePath = path.join(ROMS_DIR, consoleName);
        const files = fs.readdirSync(consolePath);

        files.forEach(file => {
            // Ignore hidden files and metadata text files
            if (file.startsWith('.') || file.endsWith('.txt') || file.toLowerCase().endsWith('.zip')) return;

            const ext = path.extname(file);
            const rawTitle = path.basename(file, ext);
            
            // Clean title: replace underscores/dashes with spaces
            const cleanTitle = rawTitle.replace(/[-_]/g, ' ').trim();
            // Generate ID: alphanumeric only
            const id = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

            games.push({
                id: id || Math.random().toString(36).substring(2, 9),
                title: cleanTitle,
                console: consoleName.toLowerCase(),
                filename: file,
                fullPath: `/roms/${consoleName}/${file}`
            });
        });
    });

    return games;
}

// Unzip and file any new ROM archives via process-roms.sh (one run at a time)
let importing = null;
function processRoms() {
    if (!importing) {
        importing = new Promise(resolve => {
            execFile(path.resolve(__dirname, '../process-roms.sh'), (err, stdout, stderr) => {
                importing = null;
                const output = (stdout + stderr).trim();
                console.log(output);
                resolve({ ok: !err, output });
            });
        });
    }
    return importing;
}

const server = http.createServer((req, res) => {
    // API: Dynamic game list
    if (req.url === '/api/games') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getGames()));
    }

    // API: Unzip new ROM archives
    if (req.url === '/api/process-roms') {
        return processRoms().then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        });
    }

    // API: Launch Game Container
    if (req.url.startsWith('/api/launch')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const consoleType = urlParams.get('console');
        const romPath = urlParams.get('path');

        console.log(`[LAUNCH] Running: ../run-${consoleType}.sh "${romPath}"`);
        exec(`../run-dolphin.sh "${romPath}"`, (err) => {
            if (err) console.error(`[EXEC ERROR] ${err.message}`);
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'launched', console: consoleType, path: romPath }));
    }

    // Serve Static UI Files
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.png': 'image/png'
    };

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    processRoms();
    console.log(`Wii System Menu running at: http://localhost:${PORT}`);
});