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

  // ── Modal registry (supports multiple concurrent modals) ─────
  window.PiratesTreasureModalRegistry = window.PiratesTreasureModalRegistry || {
    openModals: new Set(),
    register:   function (n) { this.openModals.add(n); },
    unregister: function (n) { this.openModals.delete(n); },
    isOpen:     function (n) { return this.openModals.has(n); },
    hasAnyOpen: function ()  { return this.openModals.size > 0; },
    closeAll:   function ()  {
      this.openModals.forEach(function (name) {
        window.dispatchEvent(new CustomEvent('piratestreasure-close-modal', { detail: { name: name } }));
      });
    }
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

  // ── Error logger ────────────────────────────────────────────
  window.PirateLog = window.PirateLog || {
    warn: function (source, msg, err) {
      console.warn('[' + source + ']', msg, err || '');
    },
    error: function (source, msg, err) {
      console.error('[' + source + ']', msg, err || '');
    }
  };

  // ── API base URL ────────────────────────────────────────────
  window.PIRATE_API_BASE = 'https://shippingmanager.cc/api';

  // ── Shared utilities ─────────────────────────────────────────
  window.PirateUtils = window.PirateUtils || {
    formatNumberWithSeparator: function (value) {
      var num = Number(String(value).replace(/,/g, ''));
      if (isNaN(num)) return String(value);
      return new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 }).format(num);
    },
    formatNumber: function (num) {
      if (num == null || isNaN(num)) return '0';
      return new Intl.NumberFormat('en-US').format(num);
    },
    setupThousandSeparator: function (input) {
      if (!input) return;
      input.type = 'text';
      input.inputMode = 'numeric';
      input.addEventListener('input', function (e) {
        var raw = e.target.value.replace(/[^\d]/g, '');
        e.target.value = window.PirateUtils.formatNumberWithSeparator(raw);
      });
      if (input.value) {
        input.value = window.PirateUtils.formatNumberWithSeparator(input.value);
      }
    },
    getNumericValue: function (input) {
      return parseInt(String(input.value).replace(/,/g, ''), 10);
    },
    getPinia: function () {
      var appEl = document.querySelector('#app');
      if (!appEl || !appEl.__vue_app__) return null;
      var app = appEl.__vue_app__;
      return app._context.provides.pinia || app.config.globalProperties.$pinia;
    },
    getStore: function (name) {
      var pinia = window.PirateUtils.getPinia();
      if (!pinia || !pinia._s) return null;
      return pinia._s.get(name);
    }
  };

  // ── Script lifecycle cleanup ─────────────────────────────────
  // Scripts register cleanup handlers; all are called on page unload
  window.PirateCleanup = window.PirateCleanup || {
    _handlers: [],
    register: function (name, fn) { this._handlers.push({ name: name, fn: fn }); },
    runAll: function () {
      for (var i = 0; i < this._handlers.length; i++) {
        try { this._handlers[i].fn(); } catch (e) {
          console.warn('[PirateCleanup] Error in ' + this._handlers[i].name + ':', e);
        }
      }
    }
  };
  window.addEventListener('beforeunload', function () { window.PirateCleanup.runAll(); });

  console.log('[PirateBridge] v1.3 Ready ✓');

})();
