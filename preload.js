// ============================================================
//  Pirate Browser 2.0 — Preload (contextBridge)
// ============================================================
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pirate', {

  // ── Window controls ───────────────────────────────────────
  window: {
    minimize:    ()  => ipcRenderer.send('window:minimize'),
    maximize:    ()  => ipcRenderer.send('window:maximize'),
    close:       ()  => ipcRenderer.send('window:close'),
    isMaximized: ()  => ipcRenderer.invoke('window:is-maximized'),
  },

  // ── Accounts ─────────────────────────────────────────────
  accounts: {
    list:           ()              => ipcRenderer.invoke('accounts:list'),
    add:            (label)         => ipcRenderer.invoke('accounts:add',    { label }),
    remove:         (id)            => ipcRenderer.invoke('accounts:remove', { id }),
    rename:         (id, label)     => ipcRenderer.invoke('accounts:rename', { id, label }),
    setupPartition: (partition)     => ipcRenderer.send('accounts:setup-partition', { partition }),
  },

  // ── Scripts ───────────────────────────────────────────────
  scripts: {
    list:           (accountId)               => ipcRenderer.invoke('scripts:list',            { accountId }),
    getAllEnabled:   (accountId)               => ipcRenderer.invoke('scripts:get-all-enabled', { accountId }),
    toggle:         (accountId, filename, en) => ipcRenderer.invoke('scripts:toggle',          { accountId, filename, enabled: en }),
    toggleAll:      (accountId, enabled)      => ipcRenderer.invoke('scripts:toggle-all',      { accountId, enabled }),
    reloadRegistry: ()                        => ipcRenderer.invoke('scripts:reload-registry'),
    add:            ()                        => ipcRenderer.invoke('scripts:add'),
    remove:         (filename)                => ipcRenderer.invoke('scripts:remove',           { filename }),
    openFolder:     ()                        => ipcRenderer.invoke('scripts:open-folder'),
  },

  // ── Shell ─────────────────────────────────────────────────
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  },

  // ── App ───────────────────────────────────────────────────
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },

  // ── Updater ───────────────────────────────────────────────
  updater: {
    check:     ()  => ipcRenderer.invoke('updater:check'),
    download:  ()  => ipcRenderer.invoke('updater:download'),
    install:   ()  => ipcRenderer.invoke('updater:install'),
    on:        (event, cb) => ipcRenderer.on(event, (_e, data) => cb(data)),
    off:       (event, cb) => ipcRenderer.off(event, cb),
  },

  // ── System events ─────────────────────────────────────────
  system: {
    on:  (event, cb) => ipcRenderer.on(event,  (_e, data) => cb(data)),
    off: (event, cb) => ipcRenderer.off(event, cb),
  }
});
