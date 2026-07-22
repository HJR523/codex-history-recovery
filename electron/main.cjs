const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { createServer } = require('../server.cjs');

let mainWindow = null;
let serverHandle = null;
function openDialog(options) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

function saveDialog(options) {
  return mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options);
}

ipcMain.handle('history-recovery:select-folder', async () => {
  const result = await openDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('history-recovery:select-export-file', async () => {
  const result = await saveDialog({
    defaultPath: path.join(app.getPath('documents'), 'codex-history-transfer.codex-history'),
    filters: [{ name: 'Codex History Migration', extensions: ['codex-history'] }],
  });
  return result.canceled ? null : result.filePath || null;
});

ipcMain.handle('history-recovery:select-import-file', async () => {
  const result = await openDialog({
    properties: ['openFile'],
    filters: [{ name: 'Codex History Migration', extensions: ['codex-history'] }],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});


function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

async function createMainWindow() {
  serverHandle = await createServer(47321, {
    openBrowser: false,
    log: !app.isPackaged,
    mode: 'desktop',
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    title: 'Codex History Recovery',
    backgroundColor: '#f7f8fb',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(serverHandle.url);
}

function closeServer() {
  if (!serverHandle?.server) return;
  serverHandle.server.close();
  serverHandle = null;
}

app.setAppUserModelId('com.hjr523.codex-history-recovery');

app.whenReady()
  .then(createMainWindow)
  .catch((error) => {
    dialog.showErrorBox(
      'Codex History Recovery failed to start',
      error?.message || String(error),
    );
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', closeServer);

app.on('window-all-closed', () => {
  closeServer();
  if (process.platform !== 'darwin') app.quit();
});
