// ==UserScript==
// @name         Pirate Bridge (PiratesTreasure Compatibility Layer)
// @description  Provides PiratesTreasureBridge storage, addMenuItem, addSubMenu and modal registry
// @version      1.2.0
// @match        https://shippingmanager.cc/*
// @order        0
// ==/UserScript==

(function () {
  'use strict';

  if (window._pirateBridgeActive) return;
  window._pirateBridgeActive = true;

  // ── Storage (localStorage-backed) ────────────────────────────
  const storage = {
    _key: (s, t, k) => `pirate:${s}:${t}:${k}`,
    get: async function (scriptName, storeName, key) {
      try { return localStorage.getItem(storage._key(scriptName, storeName, key)); } catch { return null; }
    },
    set: async function (scriptName, storeName, key, value) {
      try { localStorage.setItem(storage._key(scriptName, storeName, key), value); return true; } catch { return false; }
    },
    delete: async function (scriptName, storeName, key) {
      try { localStorage.removeItem(storage._key(scriptName, storeName, key)); return true; } catch { return false; }
    }
  };
  window.PiratesTreasureBridge = { storage };

  // ── Menu registry ─────────────────────────────────────────────
  window._pirateMenuItems = window._pirateMenuItems || [];
  window._pirateSubMenus  = window._pirateSubMenus  || [];

  window.addMenuItem = function (label, callback, order) {
    if (window._pirateMenuItems.find(i => i.label === label)) return;
    window._pirateMenuItems.push({ label, callback, order: order || 999 });
    window._pirateMenuItems.sort((a, b) => a.order - b.order);
    window.dispatchEvent(new CustomEvent('pirate:menu-updated'));
  };

  window.addSubMenu = function (label, items, order) {
    if (window._pirateSubMenus.find(i => i.label === label)) return;
    window._pirateSubMenus.push({ label, items, order: order || 999 });
    window._pirateSubMenus.sort((a, b) => a.order - b.order);
    window.dispatchEvent(new CustomEvent('pirate:menu-updated'));
  };

  // ── Modal registry ────────────────────────────────────────────
  window.PiratesTreasureModalRegistry = window.PiratesTreasureModalRegistry || {
    _open: null,
    register:   function (n) { this._open = n; },
    unregister: function (n) { if (this._open === n) this._open = null; },
    isOpen:     function (n) { return this._open === n; },
  };

  // ── Notifications ─────────────────────────────────────────────
  window.PiratesTreasureNotify = window.PiratesTreasureNotify || {
    show: function (title, msg) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999999;background:#111820;border:1px solid #e8912a;border-radius:6px;padding:10px 16px;color:#e2e8f0;font-family:Inter,sans-serif;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.5);display:flex;gap:8px;align-items:center;max-width:320px;';
      el.innerHTML = `<span style="color:#e8912a">◆</span><div><strong>${title}</strong>${msg ? '<br><span style="color:#7a90a8;font-size:11px">' + msg + '</span>' : ''}</div>`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    }
  };
  window.sendSystemNotification = (t, m) => window.PiratesTreasureNotify.show(t, m);

  console.log('[PirateBridge] v1.2 Ready ✓');

})();
