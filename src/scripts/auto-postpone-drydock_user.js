// ==UserScript==
// @name         ShippingManager - Auto Postpone Drydock
// @namespace    https://github.com/PiratesTreasure
// @version      2.0
// @description  Automatically postpones drydock every 7 days via direct API call
// @author       https://github.com/PiratesTreasure
// @order        9
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// @RequirePiratesTreasureMenu true
// @RequirePiratesTreasureStorage true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AutoPostponeDrydock';
    var STORE_NAME = 'data';
    var LOG_PREFIX = '[AutoPostponeDrydock]';
    var INTERVAL_DAYS = 7;
    var INTERVAL_MS = INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    var CHECK_POLL_MS = 60 * 60 * 1000; // check every hour
    var API_URL = 'https://shippingmanager.cc/api/shop/buy-point-product';

    var DEFAULT_SETTINGS = {
        enabled: false,
        notifyIngame: true,
        notifySystem: false,
        lastPostponed: null
    };

    var cachedSettings = null;
    var isModalOpen = false;
    var pollTimer = null;

    // ============================================
    // Storage
    // ============================================

    async function dbGet(key) {
        try {
            var r = await window.PiratesTreasureBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            return r ? JSON.parse(r) : null;
        } catch(e) { console.error(LOG_PREFIX, 'dbGet error:', e); return null; }
    }

    async function dbSet(key, value) {
        try {
            await window.PiratesTreasureBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
        } catch(e) { console.error(LOG_PREFIX, 'dbSet error:', e); }
    }

    async function loadSettings() {
        var stored = await dbGet('settings');
        var result = Object.assign({}, DEFAULT_SETTINGS);
        if (stored) Object.assign(result, stored);
        cachedSettings = result;
        return result;
    }

    function getSettings() {
        return cachedSettings || Object.assign({}, DEFAULT_SETTINGS);
    }

    async function saveSettings(s) {
        cachedSettings = s;
        await dbSet('settings', s);
    }

    // ============================================
    // Pinia helpers
    // ============================================

    function getToastStore() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            return pinia && pinia._s ? pinia._s.get('toast') : null;
        } catch(e) { return null; }
    }

    // ============================================
    // Notifications
    // ============================================

    function notify(msg, type) {
        type = type || 'success';
        console.log(LOG_PREFIX, type.toUpperCase() + ':', msg);
        var s = getSettings();
        if (s.notifyIngame) {
            try {
                var t = getToastStore();
                if (t) {
                    if (type === 'error' && t.error) t.error('[PostponeDrydock] ' + msg);
                    else if (t.success) t.success('[PostponeDrydock] ' + msg);
                }
            } catch(e) {}
        }
        if (s.notifySystem && window.PiratesTreasureNotify && window.PiratesTreasureNotify.notify) {
            try { window.PiratesTreasureNotify.notify('[PostponeDrydock] ' + msg); } catch(e) {}
        }
    }

    // ============================================
    // Core: API call
    // ============================================

    async function callPostponeApi() {
        var resp = await fetch(API_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'Game-Version': '1.0.328'
            },
            body: JSON.stringify({ sku: 'postpone_drydocking' })
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        if (!data || !data.data || !data.data.success) {
            throw new Error('API returned success=false: ' + JSON.stringify(data && data.data));
        }
        return data;
    }

    async function runPostpone(manual) {
        var s = getSettings();

        if (!manual) {
            if (s.lastPostponed) {
                var elapsed = Date.now() - new Date(s.lastPostponed).getTime();
                if (elapsed < INTERVAL_MS) {
                    var daysLeft = ((INTERVAL_MS - elapsed) / 86400000).toFixed(1);
                    console.log(LOG_PREFIX, 'Not yet due — ' + daysLeft + 'd remaining');
                    return { skipped: true, reason: 'not_due', daysLeft: daysLeft };
                }
            }
        }

        console.log(LOG_PREFIX, 'Calling postpone API' + (manual ? ' (manual)' : '') + '...');

        try {
            var result = await callPostponeApi();
            var rewards = result.data.rewards || [];
            var hoursGained = 0;
            rewards.forEach(function(r) { if (r.type === 'postpone_drydocking') hoursGained = r.amount || r.hours || 0; });

            var now = new Date().toISOString();
            s.lastPostponed = now;
            await saveSettings(s);
            updateModalStatusCard();

            var msg = 'Drydock postponed' + (hoursGained ? ' (+' + hoursGained + 'h)' : '') + '! Next due in ' + INTERVAL_DAYS + ' days.';
            notify(msg, 'success');
            console.log(LOG_PREFIX, 'Postpone complete. Hours gained:', hoursGained);
            return { success: true, hoursGained: hoursGained };

        } catch(e) {
            console.error(LOG_PREFIX, 'API call failed:', e.message);
            if (manual) notify('Failed: ' + e.message, 'error');
            return { error: e.message };
        }
    }

    // ============================================
    // Scheduler
    // ============================================

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(function() {
            var s = getSettings();
            if (s.enabled) runPostpone(false);
        }, CHECK_POLL_MS);
        console.log(LOG_PREFIX, 'Polling started (checks every hour for 7-day interval)');
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        console.log(LOG_PREFIX, 'Polling stopped');
    }

    // ============================================
    // Modal
    // ============================================

    function closeModal() {
        if (!isModalOpen) return;
        isModalOpen = false;
        var w = document.getElementById('apd-modal-wrapper');
        if (w) w.classList.add('hide');
    }

    function injectStyles() {
        if (document.getElementById('apd-modal-styles')) return;
        var style = document.createElement('style');
        style.id = 'apd-modal-styles';
        style.textContent = [
            '@keyframes apd-fi{0%{opacity:0}to{opacity:1}}',
            '@keyframes apd-fo{0%{opacity:1}to{opacity:0}}',
            '@keyframes apd-dd{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes apd-pu{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#apd-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#apd-modal-wrapper #apd-modal-bg{animation:apd-fi .15s linear forwards;background:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#apd-modal-wrapper.hide #apd-modal-bg{animation:apd-fo .15s linear forwards}',
            '#apd-modal-wrapper #apd-modal-cw{animation:apd-dd .15s linear forwards,apd-fi .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#apd-modal-wrapper.hide #apd-modal-cw{animation:apd-pu .15s linear forwards,apd-fo .15s linear forwards}',
            '@media screen and (min-width:1200px){#apd-modal-wrapper #apd-modal-cw{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#apd-modal-wrapper #apd-modal-cw{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#apd-modal-wrapper #apd-modal-cw{max-width:460px}}',
            '@media screen and (max-width:768px){#apd-modal-wrapper #apd-modal-cw{max-width:100%}}',
            '#apd-modal-con{background:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#apd-modal-con .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#apd-modal-con .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#apd-modal-con .header-icon.closeModal{cursor:pointer;height:19px;width:19px;margin:0 .5rem}',
            '#apd-modal-con #apd-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#apd-central{background:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#apd-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function formatDate(iso) {
        if (!iso) return '—';
        var d = new Date(iso);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatNextDue(lastIso) {
        if (!lastIso) return 'Now (never run)';
        var next = new Date(new Date(lastIso).getTime() + INTERVAL_MS);
        var diff = next.getTime() - Date.now();
        if (diff <= 0) return 'Now (overdue)';
        var days = Math.floor(diff / 86400000);
        var hours = Math.floor((diff % 86400000) / 3600000);
        return 'In ' + days + 'd ' + hours + 'h (' + next.toLocaleDateString() + ')';
    }

    function updateModalStatusCard() {
        var card = document.getElementById('apd-status-card');
        if (!card) return;
        var s = getSettings();
        card.innerHTML =
            '<div style="font-size:12px;color:#129c00;font-weight:600;margin-bottom:8px;">✓ Uses direct API — works on any page, no shop required</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' +
                '<div style="font-size:12px;color:#626b90;">Last postponed: <strong style="color:#01125d;">' + formatDate(s.lastPostponed) + '</strong></div>' +
                '<div style="font-size:12px;color:#626b90;">Next due: <strong style="color:#01125d;">' + formatNextDue(s.lastPostponed) + '</strong></div>' +
            '</div>';
    }

    function openSettingsModal() {
        try {
            var appEl = document.querySelector('#app');
            if (appEl && appEl.__vue_app__) {
                var pinia = appEl.__vue_app__._context.provides.pinia;
                if (pinia) { var ms = pinia._s.get('modal'); if (ms && ms.closeAll) ms.closeAll(); }
            }
        } catch(e) {}

        injectStyles();

        var existing = document.getElementById('apd-modal-wrapper');
        if (existing) {
            var cc = existing.querySelector('#apd-settings-content');
            if (cc) {
                existing.classList.remove('hide');
                isModalOpen = true;
                updateModalStatusCard();
                return;
            }
            existing.remove();
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var wrap = document.createElement('div'); wrap.id = 'apd-modal-wrapper';
        var bg = document.createElement('div'); bg.id = 'apd-modal-bg'; bg.onclick = closeModal;
        var cw = document.createElement('div'); cw.id = 'apd-modal-cw';
        var con = document.createElement('div'); con.id = 'apd-modal-con'; con.className = 'font-lato';
        con.style.top = headerHeight + 'px';
        con.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        con.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var hdr = document.createElement('div'); hdr.className = 'modal-header';
        var titleEl = document.createElement('span'); titleEl.className = 'header-title';
        titleEl.textContent = 'Auto Postpone Drydock';
        var closeImg = document.createElement('img');
        closeImg.className = 'header-icon closeModal';
        closeImg.src = '/images/icons/close_icon_new.svg';
        closeImg.onclick = closeModal;
        closeImg.onerror = function() {
            this.style.display = 'none';
            var fb = document.createElement('span');
            fb.textContent = 'X'; fb.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fb.onclick = closeModal; this.parentNode.appendChild(fb);
        };
        hdr.appendChild(titleEl); hdr.appendChild(closeImg);

        var content = document.createElement('div'); content.id = 'apd-modal-content';
        var central = document.createElement('div'); central.id = 'apd-central';
        var sc = document.createElement('div'); sc.id = 'apd-settings-content';
        central.appendChild(sc); content.appendChild(central);
        con.appendChild(hdr); con.appendChild(content);
        cw.appendChild(con); wrap.appendChild(bg); wrap.appendChild(cw);
        document.body.appendChild(wrap);

        isModalOpen = true;
        renderSettingsUI(sc);
    }

    function renderSettingsUI(container) {
        var s = getSettings();

        container.innerHTML = '\
            <div style="padding:20px;max-width:450px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="apd-enabled" ' + (s.enabled ? 'checked' : '') + '\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span>Enable Auto Postpone Drydock</span>\
                    </label>\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;margin-left:32px;">\
                        Calls the postpone API every ' + INTERVAL_DAYS + ' days (costs 1,200 points each time).\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;padding:12px;background:#f0f4f8;border-radius:8px;" id="apd-status-card"></div>\
                <div style="margin-bottom:20px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="apd-notify-ingame" ' + (s.notifyIngame ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="apd-notify-system" ' + (s.notifySystem ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="display:flex;gap:8px;justify-content:space-between;margin-top:24px;">\
                    <button id="apd-run-now" style="padding:10px 18px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:500;">Run Now</button>\
                    <button id="apd-forget" style="padding:10px 12px;background:none;border:1px solid #e53e3e;border-radius:6px;color:#e53e3e;cursor:pointer;font-size:12px;" title="Reset last-run timestamp">↺ Reset timer</button>\
                    <button id="apd-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;">Save</button>\
                </div>\
            </div>';

        updateModalStatusCard();

        document.getElementById('apd-run-now').onclick = async function() {
            var btn = this;
            btn.disabled = true; btn.textContent = 'Running...';
            var result = await runPostpone(true);
            btn.textContent = 'Run Now'; btn.disabled = false;
            if (result && result.success) closeModal();
        };

        document.getElementById('apd-forget').onclick = async function() {
            if (!confirm('Reset the last-run timestamp? This will make the script run again on the next check.')) return;
            var s2 = getSettings();
            s2.lastPostponed = null;
            await saveSettings(s2);
            updateModalStatusCard();
        };

        document.getElementById('apd-save').onclick = async function() {
            var s2 = getSettings();
            s2.enabled = document.getElementById('apd-enabled').checked;
            s2.notifyIngame = document.getElementById('apd-notify-ingame').checked;
            s2.notifySystem = document.getElementById('apd-notify-system').checked;
            await saveSettings(s2);
            if (s2.enabled) startPolling(); else stopPolling();
            notify('Settings saved', 'success');
            closeModal();
        };
    }

    // ============================================
    // Initialization
    // ============================================

    async function init() {
        console.log(LOG_PREFIX, 'Initializing v2.0...');
        addMenuItem('Auto Postpone Drydock', openSettingsModal, 26);
        window.addEventListener('piratestreasure-menu-click', function() { if (isModalOpen) closeModal(); });
        await loadSettings();
        var s = getSettings();
        if (s.enabled) {
            setTimeout(function() { runPostpone(false); startPolling(); }, 5000);
        }
    }

    if (!window.__piratestreasureHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }
})();
