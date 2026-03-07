// ==UserScript==
// @name         ShippingManager - Auto Speed Boost
// @namespace    https://rebelship.org/
// @version      1.5
// @description  Automatically buys 4x Speed Boost from the shop when timer expires
// @author       https://github.com/justonlyforyou/
// @order        8
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// @background-job-required true
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AutoSpeedBoost';
    var STORE_NAME = 'data';
    var LOG_PREFIX = '[AutoSpeedBoost]';
    var CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
    var API_BASE = 'https://shippingmanager.cc/api';
    var SPEED_SKU = 'speed_up';
    var SPEED_COST = 1200;

    // ========== THOUSAND SEPARATOR UTILITIES ==========
    function formatNumberWithSeparator(value) {
        var num = Number(String(value).replace(/,/g, ''));
        if (isNaN(num)) return String(value);
        return new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 }).format(num);
    }

    function setupThousandSeparator(input) {
        input.type = 'text';
        input.inputMode = 'numeric';
        input.addEventListener('input', function(e) {
            var raw = e.target.value.replace(/[^\d]/g, '');
            e.target.value = formatNumberWithSeparator(raw);
        });
        if (input.value) {
            input.value = formatNumberWithSeparator(input.value);
        }
    }

    function getNumericValue(input) {
        return parseInt(String(input.value).replace(/,/g, ''), 10);
    }

    var DEFAULT_SETTINGS = {
        enabled: false,
        minPointsReserve: 0,
        notifyIngame: true,
        notifySystem: false
    };

    var cachedSettings = null;
    var isModalOpen = false;
    var modalListenerAttached = false;
    var monitoringInterval = null;
    var isRunning = false;
    var activeAbortController = null;

    // ============================================
    // RebelShipBridge Storage
    // ============================================

    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error(LOG_PREFIX, 'dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error(LOG_PREFIX, 'dbSet error:', e);
            return false;
        }
    }

    // ============================================
    // Settings
    // ============================================

    async function loadSettingsAsync() {
        try {
            var stored = await dbGet('settings');
            if (stored) {
                var result = {};
                for (var k in DEFAULT_SETTINGS) {
                    result[k] = stored[k] !== undefined ? stored[k] : DEFAULT_SETTINGS[k];
                }
                cachedSettings = result;
                return result;
            }
            cachedSettings = Object.assign({}, DEFAULT_SETTINGS);
            return cachedSettings;
        } catch (e) {
            console.error(LOG_PREFIX, 'Failed to load settings:', e);
            cachedSettings = Object.assign({}, DEFAULT_SETTINGS);
            return cachedSettings;
        }
    }

    function loadSettings() {
        if (cachedSettings) {
            return cachedSettings;
        }
        return Object.assign({}, DEFAULT_SETTINGS);
    }

    async function saveSettingsToStorage(newSettings) {
        cachedSettings = newSettings;
        try {
            await dbSet('settings', newSettings);
            console.log(LOG_PREFIX, 'Settings saved');
        } catch (e) {
            console.error(LOG_PREFIX, 'Failed to save settings:', e);
        }
    }

    // ============================================
    // API Functions
    // ============================================

    function fetchWithCookie(url, options) {
        if (!url.startsWith('https://shippingmanager.cc/')) {
            return Promise.reject(new Error('Invalid URL: only shippingmanager.cc allowed'));
        }

        options = options || {};
        var mergedHeaders = Object.assign({
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }, options.headers);

        if (activeAbortController) {
            activeAbortController.abort();
        }

        activeAbortController = new window.AbortController();
        var timeoutId = setTimeout(function() {
            activeAbortController.abort();
        }, 15000);

        return fetch(url, Object.assign({
            credentials: 'include',
            signal: activeAbortController.signal
        }, options, {
            headers: mergedHeaders
        })).then(function(response) {
            clearTimeout(timeoutId);
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        }).catch(function(error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timeout (15s)');
            }
            throw error;
        });
    }

    function fetchUserSettings() {
        return fetchWithCookie(API_BASE + '/user/get-user-settings', {
            method: 'POST',
            body: JSON.stringify({})
        }).then(function(data) {
            var speed = data.data && data.data.settings ? data.data.settings.speed : null;
            var points = data.user ? data.user.points : null;
            return { speed: speed, points: points };
        });
    }

    function buySpeedBoost() {
        return fetchWithCookie(API_BASE + '/shop/buy-point-product', {
            method: 'POST',
            body: JSON.stringify({ sku: SPEED_SKU })
        });
    }

    // ============================================
    // Pinia Helpers (Foreground only)
    // ============================================

    function getPinia() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            return app._context.provides.pinia || app.config.globalProperties.$pinia;
        } catch {
            return null;
        }
    }

    function getModalStore() {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('modal');
        } catch {
            return null;
        }
    }

    function getToastStore() {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('toast');
        } catch {
            return null;
        }
    }

    function getUserStore() {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('user');
        } catch {
            return null;
        }
    }

    function refreshUIAfterPurchase() {
        var userStore = getUserStore();
        if (userStore && userStore.fetchUserSettings) {
            userStore.fetchUserSettings();
            console.log(LOG_PREFIX, 'UI refreshed (userStore.fetchUserSettings)');
        }
    }

    // ============================================
    // Notifications
    // ============================================

    function notify(message, type) {
        type = type || 'success';
        console.log(LOG_PREFIX, type.toUpperCase() + ':', message);

        var currentSettings = loadSettings();
        if (currentSettings.notifyIngame) {
            var toastStore = getToastStore();
            if (toastStore) {
                try {
                    if (type === 'error' && toastStore.error) {
                        toastStore.error(message);
                    } else if (toastStore.success) {
                        toastStore.success(message);
                    }
                } catch (err) {
                    console.error(LOG_PREFIX, 'Toast error:', err.message);
                }
            }
        }

        sendSystemNotification(message);
    }

    function sendSystemNotification(message) {
        var currentSettings = loadSettings();
        if (!currentSettings.notifySystem) return;

        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(SCRIPT_NAME + ': ' + message);
                return;
            } catch (e) {
                console.error(LOG_PREFIX, 'System notification failed:', e.message);
            }
        }

        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(SCRIPT_NAME, {
                        body: message,
                        icon: 'https://shippingmanager.cc/favicon.ico',
                        tag: 'auto-speed-boost'
                    });
                } catch (e) {
                    console.error(LOG_PREFIX, 'Web notification failed:', e.message);
                }
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(function(permission) {
                    if (permission === 'granted') {
                        sendSystemNotification(message);
                    }
                });
            }
        }
    }

    // ============================================
    // Core Logic
    // ============================================

    function formatTimeRemaining(ms) {
        if (ms <= 0) return 'expired';
        var totalSeconds = Math.floor(ms / 1000);
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        if (hours > 0) return hours + 'h ' + minutes + 'm';
        return minutes + 'm';
    }

    async function checkAndBuy(manual) {
        if (isRunning) {
            if (manual) notify('Already running, please wait', 'error');
            return { skipped: true, reason: 'running' };
        }

        var settings = loadSettings();
        if (!manual && !settings.enabled) {
            return { skipped: true, reason: 'disabled' };
        }

        isRunning = true;

        try {
            var userData = await fetchUserSettings();
            var speedTimestamp = userData.speed;
            var points = userData.points;

            console.log(LOG_PREFIX, 'Speed timestamp:', speedTimestamp, '| Points:', points);

            // Check if speed is still active
            if (speedTimestamp && speedTimestamp * 1000 > Date.now()) {
                var remaining = speedTimestamp * 1000 - Date.now();
                var msg = '4x Speed active (' + formatTimeRemaining(remaining) + ' remaining)';
                console.log(LOG_PREFIX, msg);
                if (manual) notify(msg, 'success');
                return { skipped: true, reason: 'still_active', remaining: remaining };
            }

            // Speed expired or inactive - check points
            if (points === null || points === undefined) {
                console.log(LOG_PREFIX, 'Cannot read points balance');
                if (manual) notify('Cannot read points balance', 'error');
                return { error: 'no_points_data' };
            }

            var requiredPoints = SPEED_COST + settings.minPointsReserve;
            if (points < requiredPoints) {
                var pointsMsg = 'Not enough points: ' + points + ' available, need ' + requiredPoints + ' (' + SPEED_COST + ' + ' + settings.minPointsReserve + ' reserve)';
                console.log(LOG_PREFIX, pointsMsg);
                if (manual) notify(pointsMsg, 'error');
                return { error: 'insufficient_points', points: points, required: requiredPoints };
            }

            // Buy speed boost
            console.log(LOG_PREFIX, 'Buying 4x Speed Boost for ' + SPEED_COST + ' points...');
            var result = await buySpeedBoost();

            if (result && result.data && result.data.success) {
                var newPoints = result.user ? result.user.points : (points - SPEED_COST);
                var successMsg = '4x Speed Boost purchased! (' + SPEED_COST + ' points, ' + newPoints + ' remaining)';
                console.log(LOG_PREFIX, successMsg);
                notify(successMsg, 'success');
                refreshUIAfterPurchase();
                return { success: true, pointsSpent: SPEED_COST, pointsRemaining: newPoints };
            }

            var failMsg = 'Purchase failed: ' + JSON.stringify(result);
            console.error(LOG_PREFIX, failMsg);
            if (manual) notify('Purchase failed', 'error');
            return { error: failMsg };

        } catch (err) {
            console.error(LOG_PREFIX, 'Error:', err);
            if (manual) notify('Error: ' + err.message, 'error');
            return { error: err.message };
        } finally {
            isRunning = false;
        }
    }

    // ============================================
    // Monitoring
    // ============================================

    function startMonitoring() {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
        }
        console.log(LOG_PREFIX, 'Monitoring started (' + (CHECK_INTERVAL / 60000) + ' min interval)');
        checkAndBuy();
        monitoringInterval = setInterval(checkAndBuy, CHECK_INTERVAL);
    }

    function stopMonitoring() {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = null;
            console.log(LOG_PREFIX, 'Monitoring stopped');
        }
    }

    // ============================================
    // Settings Modal (Game-style)
    // ============================================

    function injectModalStyles() {
        if (document.getElementById('asbst-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'asbst-modal-styles';
        style.textContent = [
            '@keyframes asbst-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes asbst-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes asbst-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes asbst-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#asbst-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#asbst-modal-wrapper #asbst-modal-background{animation:asbst-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#asbst-modal-wrapper.hide #asbst-modal-background{animation:asbst-fade-out .15s linear forwards}',
            '#asbst-modal-wrapper #asbst-modal-content-wrapper{animation:asbst-drop-down .15s linear forwards,asbst-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#asbst-modal-wrapper.hide #asbst-modal-content-wrapper{animation:asbst-push-up .15s linear forwards,asbst-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#asbst-modal-wrapper #asbst-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#asbst-modal-wrapper #asbst-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#asbst-modal-wrapper #asbst-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#asbst-modal-wrapper #asbst-modal-content-wrapper{max-width:100%}}',
            '#asbst-modal-wrapper #asbst-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#asbst-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#asbst-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#asbst-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#asbst-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#asbst-modal-container #asbst-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#asbst-modal-container #asbst-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#asbst-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeModal() {
        if (!isModalOpen) return;
        console.log(LOG_PREFIX, 'Closing modal');
        isModalOpen = false;
        var modalWrapper = document.getElementById('asbst-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }

    function setupModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        window.addEventListener('rebelship-menu-click', function() {
            if (isModalOpen) {
                console.log(LOG_PREFIX, 'RebelShip menu clicked, closing modal');
                closeModal();
            }
        });
    }

    function openSettingsModal() {
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectModalStyles();

        var existing = document.getElementById('asbst-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#asbst-settings-content');
            if (contentCheck) {
                existing.classList.remove('hide');
                isModalOpen = true;
                updateSettingsContent();
                return;
            }
            existing.remove();
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'asbst-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'asbst-modal-background';
        modalBackground.onclick = function() { closeModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'asbst-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'asbst-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto Speed Boost';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'asbst-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'asbst-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'asbst-settings-content';
        centralContainer.appendChild(settingsContent);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isModalOpen = true;
        updateSettingsContent();
    }

    function updateSettingsContent() {
        var settingsContent = document.getElementById('asbst-settings-content');
        if (!settingsContent) return;

        var currentSettings = loadSettings();

        // Fetch live status for display
        fetchUserSettings().then(function(userData) {
            var speedTimestamp = userData.speed;
            var points = userData.points;
            var speedActive = speedTimestamp && speedTimestamp * 1000 > Date.now();
            var remaining = speedActive ? speedTimestamp * 1000 - Date.now() : 0;
            var statusText = speedActive ? '4x Active (' + formatTimeRemaining(remaining) + ' remaining)' : 'Inactive';
            var statusColor = speedActive ? '#129c00' : '#e53e3e';
            var pointsText = points !== null && points !== undefined ? points.toLocaleString() + ' points' : 'unknown';

            renderSettingsUI(settingsContent, currentSettings, statusText, statusColor, pointsText);
        }).catch(function() {
            renderSettingsUI(settingsContent, currentSettings, 'Could not fetch', '#e53e3e', 'unknown');
        });
    }

    function renderSettingsUI(container, currentSettings, statusText, statusColor, pointsText) {
        container.innerHTML = '\
            <div style="padding:20px;max-width:450px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="asbst-enabled" ' + (currentSettings.enabled ? 'checked' : '') + '\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span>Enable Auto Speed Boost</span>\
                    </label>\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;margin-left:32px;">\
                        Automatically buys 4x Speed Boost (' + SPEED_COST + ' points) when the timer expires.\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;padding:12px;background:#f0f4f8;border-radius:8px;">\
                    <div style="font-size:13px;color:#626b90;margin-bottom:6px;">Speed Status: <strong style="color:' + statusColor + ';">' + statusText + '</strong></div>\
                    <div style="font-size:13px;color:#626b90;">Points: <strong style="color:#01125d;">' + pointsText + '</strong></div>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:block;font-weight:700;font-size:14px;margin-bottom:8px;">Min Points Reserve</label>\
                    <input type="text" id="asbst-min-reserve" inputmode="numeric" value="' + formatNumberWithSeparator(currentSettings.minPointsReserve) + '"\
                           style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;">\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;">\
                        Keep at least this many points after buying. Cost: ' + SPEED_COST + ' + reserve = minimum needed.\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="asbst-notify-ingame" ' + (currentSettings.notifyIngame ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="asbst-notify-system" ' + (currentSettings.notifySystem ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:30px;">\
                    <button id="asbst-run-now" style="padding:10px 24px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:500;">Run Now</button>\
                    <button id="asbst-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;">Save</button>\
                </div>\
            </div>';

        var reserveEl = document.getElementById('asbst-min-reserve');
        if (reserveEl) setupThousandSeparator(reserveEl);

        document.getElementById('asbst-run-now').onclick = async function() {
            this.disabled = true;
            this.textContent = 'Running...';
            await checkAndBuy(true);
            this.textContent = 'Run Now';
            this.disabled = false;
            updateSettingsContent();
        };

        document.getElementById('asbst-save').onclick = function() {
            var reserveVal = getNumericValue(document.getElementById('asbst-min-reserve'));
            if (!Number.isInteger(reserveVal) || reserveVal < 0) {
                reserveVal = 0;
            }

            var newSettings = {
                enabled: document.getElementById('asbst-enabled').checked,
                minPointsReserve: reserveVal,
                notifyIngame: document.getElementById('asbst-notify-ingame').checked,
                notifySystem: document.getElementById('asbst-notify-system').checked
            };

            saveSettingsToStorage(newSettings);

            if (newSettings.enabled) {
                startMonitoring();
            } else {
                stopMonitoring();
            }

            notify('Auto Speed Boost settings saved', 'success');
            closeModal();
        };
    }

    // ============================================
    // Initialization
    // ============================================

    var uiInitialized = false;
    var uiRetryCount = 0;
    var MAX_UI_RETRIES = 30;

    function initUI() {
        if (uiInitialized) return;

        var hasApp = document.getElementById('app');
        if (!hasApp) {
            uiRetryCount++;
            if (uiRetryCount < MAX_UI_RETRIES) {
                setTimeout(initUI, 1000);
                return;
            }
            console.log(LOG_PREFIX, 'Max retries reached, background mode');
            return;
        }

        uiInitialized = true;
    }

    async function init() {
        console.log(LOG_PREFIX, 'Initializing v1.4...');

        addMenuItem('Auto Speed Boost', openSettingsModal, 25);
        initUI();

        await loadSettingsAsync();
        setupModalWatcher();

        window.addEventListener('beforeunload', function() {
            if (activeAbortController) {
                activeAbortController.abort();
                activeAbortController = null;
            }
        });

        var settings = loadSettings();
        if (settings.enabled) {
            setTimeout(startMonitoring, 3000);
        }
    }

    // Expose for Android BackgroundScriptService
    window.rebelshipRunAutoSpeedBoost = async function() {
        await loadSettingsAsync();
        var settings = loadSettings();
        if (!settings.enabled) {
            return { skipped: true, reason: 'disabled' };
        }
        return await checkAndBuy();
    };

    if (!window.__rebelshipHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    // Register for background job system
    window.rebelshipBackgroundJobs = window.rebelshipBackgroundJobs || [];
    window.rebelshipBackgroundJobs.push({
        name: 'AutoSpeedBoost',
        run: async function() { return await window.rebelshipRunAutoSpeedBoost(); }
    });
})();
