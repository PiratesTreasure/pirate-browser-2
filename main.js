// ============================================================
//  Pirate Browser 2.0 — Main Process
//  Uses <webview> tags in renderer (Electron 28 compatible)
// ============================================================
'use strict';

const { app, BrowserWindow, ipcMain, session, dialog, shell, powerSaveBlocker, powerMonitor } = require('electron');
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
const TARGET_URL      = 'https://shippingmanager.cc';
const SCRIPTS_DIR     = path.join(__dirname, 'src', 'scripts');
const USER_SCRIPTS_DIR = path.join(app.getPath('userData'), 'scripts');
const isDev           = process.argv.includes('--dev');

// Ensure user scripts directory exists
if (!fs.existsSync(USER_SCRIPTS_DIR)) fs.mkdirSync(USER_SCRIPTS_DIR, { recursive: true });

// ── Script registry ───────────────────────────────────────────
function parseScriptEntry(dir, filename) {
  const src   = fs.readFileSync(path.join(dir, filename), 'utf8');
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
}

function loadScriptRegistry() {
  const map = new Map();

  // Load bundled scripts first
  if (fs.existsSync(SCRIPTS_DIR)) {
    fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.js'))
      .forEach(f => map.set(f, parseScriptEntry(SCRIPTS_DIR, f)));
  }

  // User scripts override bundled ones with the same filename
  if (fs.existsSync(USER_SCRIPTS_DIR)) {
    fs.readdirSync(USER_SCRIPTS_DIR).filter(f => f.endsWith('.js'))
      .forEach(f => map.set(f, parseScriptEntry(USER_SCRIPTS_DIR, f)));
  }

  return Array.from(map.values()).sort((a, b) => a.order - b.order);
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
      backgroundThrottling: false, // keep scripts running when minimized
    }
  });

  // Prevent the display from sleeping and the OS from suspending the process
  powerSaveBlocker.start('prevent-display-sleep');

  // Wake up webviews when system resumes from sleep or screen unlock
  powerMonitor.on('resume', () => {
    console.log('[PowerMonitor] System resumed from sleep');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:resumed');
    }
  });
  powerMonitor.on('unlock-screen', () => {
    console.log('[PowerMonitor] Screen unlocked');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:resumed');
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
    fs.copyFileSync(src, path.join(USER_SCRIPTS_DIR, path.basename(src)));
    added.push(path.basename(src));
  }
  scriptRegistry = loadScriptRegistry();
  return added;
});

ipcMain.handle('scripts:remove', (_e, { filename }) => {
  // Remove from user scripts dir first, then bundled dir
  const userFp    = path.join(USER_SCRIPTS_DIR, filename);
  const bundledFp = path.join(SCRIPTS_DIR, filename);
  if (fs.existsSync(userFp))    fs.unlinkSync(userFp);
  else if (fs.existsSync(bundledFp)) fs.unlinkSync(bundledFp);
  scriptRegistry = loadScriptRegistry();
  return true;
});

ipcMain.handle('scripts:open-folder', () => {
  shell.openPath(USER_SCRIPTS_DIR);
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
  if (autoUpdater) {
    // Delay to let IPC response complete before quitting
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
  }
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

  // Strip CSP from ShippingManager responses so injected scripts can make
  // cross-origin requests (e.g. fetching piratebunker.netlify.app data).
  // Also inject permissive CORS headers on piratebunker responses so the
  // fetch response body is readable from the ShippingManager webview context.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.assign({}, details.responseHeaders);

    // Remove CSP — partition isolation is the security boundary here
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];

    // Allow scripts to read piratebunker responses cross-origin
    if (details.url.startsWith('https://piratebunker.netlify.app')) {
      headers['access-control-allow-origin']  = ['*'];
      headers['access-control-allow-methods'] = ['GET'];
    }

    callback({ responseHeaders: headers });
  });
});

// ── Open external links in system browser ────────────────────
ipcMain.on('shell:open-external', (_e, url) => shell.openExternal(url));

// ============================================================
//  Prevent Chrome from throttling or freezing background renderers
//  Must be set before app.whenReady()
// ============================================================
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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
  // Auto-check for updates 5s after launch, then every 30 min (production only)
  if (!isDev && autoUpdater) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(e => console.error('[Updater] Check failed:', e.message)), 5000);
    setInterval(() => autoUpdater.checkForUpdates().catch(e => console.error('[Updater] Periodic check failed:', e.message)), 30 * 60 * 1000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});
