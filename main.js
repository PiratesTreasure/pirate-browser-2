// ============================================================
//  Pirate Browser 2.0 — Main Process
//  Uses <webview> tags in renderer (Electron 28 compatible)
// ============================================================
'use strict';

const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Auto-updater ──────────────────────────────────────────────
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload    = false;
  autoUpdater.autoInstallOnAppQuit = false;
} catch {
  // electron-updater not available (dev install without it)
}

// ── Config store ─────────────────────────────────────────────
let store;
try {
  const Store = require('electron-store');
  store = new Store({ name: 'pirate-browser-config' });
} catch {
  const _m = {};
  store = {
    get:    (k, d) => (k in _m ? _m[k] : d),
    set:    (k, v) => { _m[k] = v; },
    delete: (k)    => { delete _m[k]; }
  };
}

// ── Constants ─────────────────────────────────────────────────
const TARGET_URL  = 'https://shippingmanager.cc';
const SCRIPTS_DIR = path.join(__dirname, 'src', 'scripts');
const isDev       = process.argv.includes('--dev');

// ── Script registry ───────────────────────────────────────────
function loadScriptRegistry() {
  if (!fs.existsSync(SCRIPTS_DIR)) return [];
  return fs.readdirSync(SCRIPTS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(filename => {
      const src   = fs.readFileSync(path.join(SCRIPTS_DIR, filename), 'utf8');
      const meta  = {};
      const block = src.match(/==UserScript==([\s\S]*?)==\/UserScript==/);
      if (block) {
        for (const line of block[1].split('\n')) {
          const m = line.match(/\/\/\s*@(\w[\w-]*)\s+(.*)/);
          if (m) meta[m[1]] = m[2].trim();
        }
      }
      return {
        filename,
        name:        meta.name        || filename.replace('_user.js', ''),
        description: meta.description || '',
        version:     meta.version     || '?',
        order:       parseInt(meta.order || '999', 10),
        src
      };
    })
    .sort((a, b) => a.order - b.order);
}

let scriptRegistry = loadScriptRegistry();

// ── Script state helpers ──────────────────────────────────────
function getScriptStates(accountId) {
  return store.get(`scriptStates.${accountId}`, {});
}
function setScriptState(accountId, filename, enabled) {
  const s = getScriptStates(accountId);
  s[filename] = enabled;
  store.set(`scriptStates.${accountId}`, s);
}

// ── Main window ───────────────────────────────────────────────
let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:  1400, height: 900,
    minWidth: 900, minHeight: 600,
    frame:           false,
    backgroundColor: '#080b10',
    show:            false,
    webPreferences: {
      preload:           path.join(__dirname, 'preload.js'),
      nodeIntegration:   false,
      contextIsolation:  true,
      sandbox:           false,
      webviewTag:        true,   // enable <webview> tags
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ============================================================
//  IPC — Window controls
// ============================================================
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () =>
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
);
ipcMain.on('window:close', () => mainWindow?.destroy());
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

// ============================================================
//  IPC — Accounts (config persistence only, webviews handle rendering)
// ============================================================
ipcMain.handle('accounts:list', () => {
  return store.get('accounts', []);
});

ipcMain.handle('accounts:add', (_e, { label }) => {
  const id    = `acc-${Date.now()}`;
  const saved = store.get('accounts', []);
  saved.push({ id, label });
  store.set('accounts', saved);
  return { id, label };
});

ipcMain.handle('accounts:remove', (_e, { id }) => {
  store.set('accounts', store.get('accounts', []).filter(a => a.id !== id));
  // Also clear script states for this account
  store.delete(`scriptStates.${id}`);
  return true;
});

ipcMain.handle('accounts:rename', (_e, { id, label }) => {
  store.set('accounts', store.get('accounts', []).map(a => a.id === id ? { ...a, label } : a));
  return true;
});

// ============================================================
//  IPC — Scripts
// ============================================================
ipcMain.handle('scripts:list', (_e, { accountId }) => {
  const states = getScriptStates(accountId);
  return scriptRegistry.map(s => ({
    filename:    s.filename,
    name:        s.name,
    description: s.description,
    version:     s.version,
    order:       s.order,
    enabled:     s.filename in states ? states[s.filename] : false,
  }));
});

ipcMain.handle('scripts:get-src', (_e, { filename }) => {
  const script = scriptRegistry.find(s => s.filename === filename);
  return script ? script.src : null;
});

ipcMain.handle('scripts:get-all-enabled', (_e, { accountId }) => {
  const states = getScriptStates(accountId);
  return scriptRegistry
    .filter(s => states[s.filename])
    .map(s => ({ filename: s.filename, src: s.src }));
});

ipcMain.handle('scripts:toggle', (_e, { accountId, filename, enabled }) => {
  setScriptState(accountId, filename, enabled);
  return true;
});

ipcMain.handle('scripts:toggle-all', (_e, { accountId, enabled }) => {
  const states = Object.fromEntries(scriptRegistry.map(s => [s.filename, enabled]));
  store.set(`scriptStates.${accountId}`, states);
  return true;
});

ipcMain.handle('scripts:reload-registry', () => {
  scriptRegistry = loadScriptRegistry();
  return scriptRegistry.map(({ filename, name, description, version, order }) =>
    ({ filename, name, description, version, order })
  );
});

ipcMain.handle('scripts:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Userscript',
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled) return null;
  const added = [];
  for (const src of filePaths) {
    fs.copyFileSync(src, path.join(SCRIPTS_DIR, path.basename(src)));
    added.push(path.basename(src));
  }
  scriptRegistry = loadScriptRegistry();
  return added;
});

ipcMain.handle('scripts:remove', (_e, { filename }) => {
  const fp = path.join(SCRIPTS_DIR, filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  scriptRegistry = loadScriptRegistry();
  return true;
});

ipcMain.handle('scripts:open-folder', () => {
  shell.openPath(SCRIPTS_DIR);
  return true;
});

ipcMain.handle('app:version', () => app.getVersion());

// ============================================================
//  IPC — Auto-updater
// ============================================================
ipcMain.handle('updater:check', async () => {
  if (!autoUpdater) return { error: 'Updater not available' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return result ? { updateInfo: result.updateInfo } : { noUpdate: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('updater:download', async () => {
  if (!autoUpdater) return { error: 'Updater not available' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('updater:install', () => {
  if (autoUpdater) autoUpdater.quitAndInstall(false, true);
});

function setupUpdaterEvents() {
  if (!autoUpdater) return;
  autoUpdater.on('update-available',    info     => mainWindow?.webContents.send('updater:update-available', info));
  autoUpdater.on('update-not-available',()       => mainWindow?.webContents.send('updater:no-update'));
  autoUpdater.on('download-progress',   progress => mainWindow?.webContents.send('updater:progress', progress));
  autoUpdater.on('update-downloaded',   info     => mainWindow?.webContents.send('updater:downloaded', info));
  autoUpdater.on('error',               err      => mainWindow?.webContents.send('updater:error', err.message));
}

// ── Set correct user-agent for a webview partition ───────────
ipcMain.on('accounts:setup-partition', (_e, { partition }) => {
  const ses = session.fromPartition(partition);
  ses.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  // Add Content Security Policy for webview sessions
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' https://shippingmanager.cc https://*.shippingmanager.cc; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://shippingmanager.cc https://*.shippingmanager.cc; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data: https: blob:; " +
          "connect-src 'self' https://shippingmanager.cc https://*.shippingmanager.cc wss://*.shippingmanager.cc;"
        ]
      }
    });
  });
});

// ── Open external links in system browser ────────────────────
ipcMain.on('shell:open-external', (_e, url) => shell.openExternal(url));

// ============================================================
//  App lifecycle
// ============================================================
app.whenReady().then(() => {
  // Ensure at least one account exists
  const saved = store.get('accounts', []);
  if (saved.length === 0) {
    store.set('accounts', [{ id: 'acc-default', label: 'Account 1' }]);
  }
  createMainWindow();
  setupUpdaterEvents();
  // Auto-check for updates 5s after launch (production only)
  if (!isDev && autoUpdater) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});
