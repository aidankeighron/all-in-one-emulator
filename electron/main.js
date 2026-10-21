const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } = require('electron');
const path = require('path');
const server = require('../ui/server');

// Note: Ubuntu 24.04 blocks Chromium's sandbox for apps like this. That is checked before any JS
// runs, so --no-sandbox is passed by `npm start` and by the AppImage launcher (scripts/after-pack.js).

const startFullscreen = process.argv.includes('--fullscreen') || process.env.FULLSCREEN === '1';
let win = null;
let pauseWin = null;       // the pause menu: a transparent window over everything, so it shows on top of the game
let serverPort = 0;
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

// The pause menu (Back + Start held in a game) is its own frameless, transparent window that covers the screen and sits above
// everything, so the frozen game stays visible behind it. The menu window is left alone.
function createPauseWindow() {
    if (pauseWin) return pauseWin;
    pauseWin = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        skipTaskbar: true,
        resizable: false,
        alwaysOnTop: true,
        title: 'Emulator Menu: paused',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });
    pauseWin.on('closed', () => { pauseWin = null; });
    pauseWin.loadURL(`http://127.0.0.1:${serverPort}/?pause=1`);
    return pauseWin;
}

function onPause(paused) {
    if (paused) {
        const w = createPauseWindow();
        const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        w.setBounds(bounds);
        w.setAlwaysOnTop(true, 'screen-saver');
        w.show();
        w.setFullScreen(true);       // exactly the whole screen: the desktop may otherwise leave a gap (a top bar) in a corner
        w.moveTop();
        w.focus();
    } else if (pauseWin) {
        pauseWin.setFullScreen(false);
        pauseWin.hide();
    }
}

async function createWindow() {
    const { port } = await server.start({ port: 0, onGameState, onPause });
    serverPort = port;

    win = new BrowserWindow({
        width: 1280,
        height: 720,
        fullscreen: startFullscreen,
        autoHideMenuBar: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1218' : '#e3eaf0',   // matches the page's first paint (the saved Light/Dark choice then applies)
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
    win.on('closed', () => { win = null; if (pauseWin) pauseWin.destroy(); });   // the hidden pause window must not keep the app open
    win.loadURL(`http://127.0.0.1:${port}`);
    win.webContents.once('did-finish-load', createPauseWindow);   // ready (hidden) before it is needed
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
    // Windows groups the taskbar icon (and keeps a pinned one working) by this id: it matches the installer's appId
    if (process.platform === 'win32') app.setAppUserModelId('com.aidankeighron.emulatormenu');
    app.whenReady().then(createWindow);
    app.on('window-all-closed', () => app.quit());
}
