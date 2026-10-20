const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const server = require('../ui/server');

// Note: Ubuntu 24.04 blocks Chromium's sandbox for apps like this. That is checked before any JS
// runs, so --no-sandbox is passed by `npm start` and by the AppImage launcher (scripts/after-pack.js).

const startFullscreen = process.argv.includes('--fullscreen') || process.env.FULLSCREEN === '1';
let win = null;
let hiddenForGame = false;

// A fullscreen menu would cover the emulator window, so get out of the way while a game runs
function onGameState(running) {
    if (!win) return;
    if (running && win.isFullScreen()) {
        hiddenForGame = true;
        win.minimize();
    } else if (!running && hiddenForGame) {
        hiddenForGame = false;
        win.restore();
        win.focus();
    }
}

async function createWindow() {
    const { port } = await server.start({ port: 0, onGameState });

    win = new BrowserWindow({
        width: 1280,
        height: 720,
        fullscreen: startFullscreen,
        autoHideMenuBar: true,
        backgroundColor: '#e3eaf0',
        title: 'Emulator Menu',
        icon: path.join(__dirname, '..', 'ui', 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F11') {
            win.setFullScreen(!win.isFullScreen());
            event.preventDefault();
        }
    });
    win.on('closed', () => { win = null; });
    win.loadURL(`http://127.0.0.1:${port}`);
}

// Windows: choose an emulator's program
ipcMain.handle('pick-file', async (event, filterName) => {
    const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: String(filterName || 'Program'), extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
    });
    return result.canceled ? null : result.filePaths[0];
});

// Links in Settings (an emulator's download page) open in the normal browser, https only
ipcMain.handle('open-external', async (event, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) await shell.openExternal(url);
});

// Opens a folder in the file manager (the emulators folder)
ipcMain.handle('open-path', async (event, dir) => {
    if (typeof dir === 'string' && path.isAbsolute(dir)) {
        require('fs').mkdirSync(dir, { recursive: true });
        await shell.openPath(dir);
    }
});

ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
    Menu.setApplicationMenu(null);
    app.whenReady().then(createWindow);
    app.on('window-all-closed', () => app.quit());
}
