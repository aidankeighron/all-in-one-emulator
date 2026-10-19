// Serves one file with HTTP Range support, so players can seek and downloads can resume.
const fs = require('fs');

function serveFile(req, res, file, type) {
    let size;
    try { size = fs.statSync(file).size; } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{"error":"not found"}');
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = size - 1, status = 200;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    if (range && (range[1] || range[2])) {
        start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
        end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
        start = Math.max(0, start);
        if (start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}

module.exports = { serveFile };
