// ==UserScript==
// @name         ShippingManager - Auto Repair
// @namespace    https://rebelship.org/
// @version      2.47
// @description  Auto-repair vessels when wear reaches threshold
// @author       https://github.com/justonlyforyou/
// @order        7
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

    console.log('[AutoRepair] Script loading...');

    // ========== CONFIGURATION ==========
    var SCRIPT_NAME = 'AutoRepair';
    var STORE_NAME = 'data';
    var CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (background service minimum)

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

    // ========== STATE ==========
    var settings = {
        enabled: false,
        wearThreshold: 5,      // Repair when wear >= this %
        minCashAfterRepair: 1000000,  // Keep at least this much cash (min 1M)
        notifyIngame: true,    // Show in-game toast notifications
        notifySystem: false    // Send system/push notifications
    };
    var monitorInterval = null;
    var isRepairModalOpen = false;
    var modalListenerAttached = false;
    var cachedModalElement = null;
    var activeAbortController = null;
    var inputDebounceTimers = {};

    // Global lock to prevent duplicate runs (survives script reload)
    if (!window._autoRepairLock) {
        window._autoRepairLock = { isProcessing: false, lastRunTime: 0 };
    }

    // ========== REBELSHIPBRIDGE STORAGE ==========
    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[AutoRepair] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[AutoRepair] dbSet error:', e);
            return false;
        }
    }

    async function loadSettings() {
        try {
            var record = await dbGet('settings');
            if (record) {
                Object.assign(settings, {
                    enabled: record.enabled !== undefined ? record.enabled : settings.enabled,
                    wearThreshold: record.wearThreshold !== undefined ? record.wearThreshold : settings.wearThreshold,
                    minCashAfterRepair: record.minCashAfterRepair !== undefined ? Math.max(record.minCashAfterRepair, 1000000) : settings.minCashAfterRepair,
                    notifyIngame: record.notifyIngame !== undefined ? record.notifyIngame : settings.notifyIngame,
                    notifySystem: record.notifySystem !== undefined ? record.notifySystem : settings.notifySystem
                });
            }
            return settings;
        } catch (e) {
            console.error('[AutoRepair] Failed to load settings:', e);
            return settings;
        }
    }

    async function saveSettings() {
        try {
            await dbSet('settings', settings);
            log('Settings saved');
        } catch (e) {
            console.error('[AutoRepair] Failed to save settings:', e);
        }
    }

    // ========== DIRECT API FUNCTIONS ==========
    function fetchWithCookie(url, options) {
        // URL whitelist validation
        if (!url.startsWith('https://shippingmanager.cc/')) {
            return Promise.reject(new Error('Invalid URL: only shippingmanager.cc allowed'));
        }

        options = options || {};
        var mergedHeaders = Object.assign({
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }, options.headers);

        // Abort previous request if exists
        if (activeAbortController) {
            activeAbortController.abort();
        }

        // Create AbortController with 15s timeout
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

    function fetchVessels() {
        return fetchWithCookie('https://shippingmanager.cc/api/vessel/get-all-user-vessels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ include_routes: false })
        }).then(function(data) {
            return data.data && data.data.user_vessels ? data.data.user_vessels : [];
        });
    }

    function fetchMaintenanceCost(vesselIds) {
        if (!Array.isArray(vesselIds) || vesselIds.length === 0) {
            log('fetchMaintenanceCost called with invalid vesselIds', 'error');
            return Promise.reject(new Error('invalid vessel ids'));
        }
        return fetchWithCookie('https://shippingmanager.cc/api/maintenance/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
        }).then(function(data) {
            var totalCost = 0;
            var vessels = data.data && data.data.vessels ? data.data.vessels : [];
            for (var i = 0; i < vessels.length; i++) {
                var vessel = vessels[i];
                var wearMaintenance = null;
                if (vessel.maintenance_data) {
                    for (var j = 0; j < vessel.maintenance_data.length; j++) {
                        if (vessel.maintenance_data[j].type === 'wear') {
                            wearMaintenance = vessel.maintenance_data[j];
                            break;
                        }
                    }
                }
                if (wearMaintenance) {
                    // Use discounted_price if available (subsidy applied), otherwise regular price
                    var cost = wearMaintenance.discounted_price || wearMaintenance.price || 0;
                    totalCost += cost;
                }
            }
            return { vessels: vessels, totalCost: totalCost, cash: data.user ? data.user.cash : 0 };
        });
    }

    function bulkRepairVessels(vesselIds) {
        if (!Array.isArray(vesselIds) || vesselIds.length === 0) {
            log('bulkRepairVessels called with invalid vesselIds', 'error');
            return Promise.reject(new Error('invalid vessel ids'));
        }
        return fetchWithCookie('https://shippingmanager.cc/api/maintenance/do-wear-maintenance-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
        }).then(function(data) {
            return {
                success: data.success,
                count: vesselIds.length,
                totalCost: data.data && data.data.total_cost ? data.data.total_cost : 0
            };
        });
    }

    function getUserCash() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;
            var userStore = pinia._s.get('user');
            return userStore ? (userStore.cash || (userStore.user ? userStore.user.cash : null)) : null;
        } catch {
            return null;
        }
    }

    // ========== CORE LOGIC ==========
    function runRepairCheck() {
        if (!settings.enabled || window._autoRepairLock.isProcessing) {
            return Promise.resolve({ skipped: true, reason: !settings.enabled ? 'disabled' : 'processing' });
        }

        window._autoRepairLock.isProcessing = true;
        var result = {
            checked: true,
            vesselsFound: 0,
            vesselsRepaired: 0,
            totalCost: 0,
            error: null
        };

        return fetchVessels().then(function(vessels) {
            // Filter by wear threshold
            var vesselsNeedingRepair = vessels.filter(function(v) {
                return v.wear >= settings.wearThreshold &&
                    v.status !== 'maintenance' &&
                    v.status !== 'sailing';
            });

            result.vesselsFound = vesselsNeedingRepair.length;

            if (vesselsNeedingRepair.length === 0) {
                log('No vessels need repair (threshold: ' + settings.wearThreshold + '%)');
                return result;
            }

            log('Found ' + vesselsNeedingRepair.length + ' vessels with wear >= ' + settings.wearThreshold + '%');

            // Get repair cost and check cash
            var vesselIds = vesselsNeedingRepair.map(function(v) { return v.id; });

            return fetchMaintenanceCost(vesselIds).then(function(costData) {
                // Get cash from Pinia or API response
                var cash = getUserCash() || costData.cash || 0;
                log('Repair cost: $' + costData.totalCost.toLocaleString() + ' | Cash: $' + cash.toLocaleString());

                // Check if we can afford it
                if (settings.minCashAfterRepair > 0) {
                    var cashAfterRepair = cash - costData.totalCost;
                    if (cashAfterRepair < settings.minCashAfterRepair) {
                        log('Cannot repair: would leave $' + cashAfterRepair.toLocaleString() + ', need $' + settings.minCashAfterRepair.toLocaleString());
                        result.error = 'insufficient_funds';
                        return result;
                    }
                }

                // Execute repair
                return bulkRepairVessels(vesselIds).then(function(repairResult) {
                    result.vesselsRepaired = repairResult.count;
                    // Use actual cost from API, not estimated cost
                    result.totalCost = repairResult.totalCost;

                    // Only show notification if ships were actually repaired (cost > 0)
                    // This prevents duplicate notification when ships were already repaired
                    if (result.totalCost > 0) {
                        var toastMessage = 'Repaired ' + repairResult.count + ' vessels for $' + result.totalCost.toLocaleString();
                        log(toastMessage);
                        showToast(toastMessage);
                    } else {
                        log('Repair returned $0 cost - ships may have been repaired by another process');
                    }

                    return result;
                });
            });
        }).catch(function(error) {
            log('Error: ' + error.message, 'error');
            result.error = error.message;
            return result;
        }).finally(function() {
            window._autoRepairLock.isProcessing = false;
        });
    }

    // ========== MONITORING ==========
    function startMonitoring() {
        if (monitorInterval) {
            clearInterval(monitorInterval);
        }
        monitorInterval = setInterval(runRepairCheck, CHECK_INTERVAL_MS);
        log('Monitoring started (15 min interval) - waiting for first interval');
    }

    function stopMonitoring() {
        if (monitorInterval) {
            clearInterval(monitorInterval);
            monitorInterval = null;
        }
        log('Monitoring stopped');
    }

    // ========== LOGGING & NOTIFICATIONS ==========
    function log(message, level) {
        var prefix = '[' + SCRIPT_NAME + ']';
        if (level === 'error') {
            console.error(prefix, message);
        } else {
            console.log(prefix, message);
        }
    }

    function sendSystemNotification(title, message) {
        if (!settings.notifySystem) return;

        // 1. Android bridge notification
        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(title + ': ' + message);
                log('System notification sent');
                return;
            } catch (e) {
                log('System notification failed: ' + e.message, 'error');
            }
        }

        // 2. Web Notification API fallback
        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(title, {
                        body: message,
                        icon: 'https://shippingmanager.cc/favicon.ico',
                        tag: 'auto-repair'
                    });
                    log('Web notification sent');
                } catch (e) {
                    log('Web notification failed: ' + e.message, 'error');
                }
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(function(permission) {
                    if (permission === 'granted') {
                        sendSystemNotification(title, message);
                    }
                });
            }
        }
    }

    // ========== UI: PINIA STORES ==========
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
            log('Failed to get modalStore', 'error');
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

    // ========== CUSTOM MODAL (Game-style) ==========
    function injectRepairModalStyles() {
        var existingStyle = document.getElementById('repair-modal-styles');
        var newContent = [
            '@keyframes repair-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes repair-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes repair-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes repair-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#repair-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#repair-modal-wrapper #repair-modal-background{animation:repair-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#repair-modal-wrapper.hide #repair-modal-background{animation:repair-fade-out .15s linear forwards}',
            '#repair-modal-wrapper #repair-modal-content-wrapper{animation:repair-drop-down .15s linear forwards,repair-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#repair-modal-wrapper.hide #repair-modal-content-wrapper{animation:repair-push-up .15s linear forwards,repair-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#repair-modal-wrapper #repair-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#repair-modal-wrapper #repair-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#repair-modal-wrapper #repair-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#repair-modal-wrapper #repair-modal-content-wrapper{max-width:100%}}',
            '#repair-modal-wrapper #repair-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#repair-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#repair-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#repair-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#repair-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#repair-modal-container #repair-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#repair-modal-container #repair-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#repair-modal-wrapper.hide{pointer-events:none}',
            '.repair-container{padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d}',
            '.repair-section{margin-bottom:20px}',
            '.repair-checkbox-label{display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px}',
            '.repair-checkbox{width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer}',
            '.repair-field-label{display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d}',
            '.repair-input{width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box}',
            '.repair-hint{font-size:12px;color:#626b90;margin-top:6px}',
            '.repair-notify-group{display:flex;gap:24px}',
            '.repair-notify-label{display:flex;align-items:center;cursor:pointer}',
            '.repair-notify-checkbox{width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer}',
            '.repair-notify-text{font-size:13px}',
            '.repair-buttons{display:flex;gap:12px;justify-content:space-between;margin-top:30px}',
            '.repair-btn{padding:10px 24px;border:0;border-radius:6px;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif}',
            '.repair-btn-secondary{background:linear-gradient(90deg,#d7d8db,#95969b);color:#393939}',
            '.repair-btn-green{background:linear-gradient(180deg,#46ff33,#129c00);color:#fff}'
        ].join('');

        if (existingStyle) {
            if (existingStyle.textContent !== newContent) {
                existingStyle.remove();
                existingStyle = null;
            } else {
                return; // Content matches, no update needed
            }
        }

        if (!existingStyle) {
            var style = document.createElement('style');
            style.id = 'repair-modal-styles';
            style.textContent = newContent;
            document.head.appendChild(style);
        }
    }

    function closeRepairModal() {
        if (!isRepairModalOpen) return;
        log('Closing modal');
        isRepairModalOpen = false;
        var modalWrapper = cachedModalElement || document.getElementById('repair-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
            // Remove from DOM after animation completes (150ms)
            setTimeout(function() {
                if (modalWrapper.parentNode) {
                    modalWrapper.remove();
                    cachedModalElement = null;
                }
            }, 150);
        }
    }

    function setupRepairModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        window.addEventListener('rebelship-menu-click', function() {
            if (isRepairModalOpen) {
                log('RebelShip menu clicked, closing modal');
                closeRepairModal();
            }
        });
    }

    function showToast(message, type) {
        type = type || 'success';
        // 1. In-game toast (Pinia) - if enabled
        if (settings.notifyIngame) {
            var toastStore = getToastStore();
            if (toastStore) {
                try {
                    if (type === 'error' && toastStore.error) {
                        toastStore.error(message);
                    } else if (toastStore.success) {
                        toastStore.success(message);
                    }
                    log('Toast shown: ' + message);
                } catch (err) {
                    log('Toast error: ' + err.message, 'error');
                }
            }
        }

        // 2. System notification (if enabled)
        sendSystemNotification(SCRIPT_NAME, message);
    }

    function openSettingsModal() {
        // Close any open game modal first
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectRepairModalStyles();

        // Check if modal already exists with content
        if (cachedModalElement) {
            var contentCheck = cachedModalElement.querySelector('#repair-settings-content');
            if (contentCheck && contentCheck.hasChildNodes()) {
                cachedModalElement.classList.remove('hide');
                isRepairModalOpen = true;
                return; // Content exists, no re-render needed
            }
        }

        var existing = document.getElementById('repair-modal-wrapper');
        if (existing) {
            existing.remove();
            cachedModalElement = null;
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'repair-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'repair-modal-background';
        modalBackground.onclick = function() { closeRepairModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'repair-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'repair-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto Repair Settings';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeRepairModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeRepairModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'repair-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'repair-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'repair-settings-content';
        centralContainer.appendChild(settingsContent);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        cachedModalElement = modalWrapper;
        isRepairModalOpen = true;
        updateRepairSettingsContent();
    }

    function debounceInput(inputId, callback, delay) {
        return function() {
            if (inputDebounceTimers[inputId]) {
                clearTimeout(inputDebounceTimers[inputId]);
            }
            inputDebounceTimers[inputId] = setTimeout(callback, delay);
        };
    }

    function updateRepairSettingsContent() {
        var settingsContent = document.getElementById('repair-settings-content');
        if (!settingsContent) return;

        // Clear existing content
        settingsContent.textContent = '';

        // Main container
        var container = document.createElement('div');
        container.className = 'repair-container';

        // Enable checkbox section
        var enableSection = document.createElement('div');
        enableSection.className = 'repair-section';
        var enableLabel = document.createElement('label');
        enableLabel.className = 'repair-checkbox-label';
        var enableCheckbox = document.createElement('input');
        enableCheckbox.type = 'checkbox';
        enableCheckbox.id = 'yf-enabled';
        enableCheckbox.className = 'repair-checkbox';
        enableCheckbox.checked = settings.enabled;
        var enableText = document.createElement('span');
        enableText.textContent = 'Enable Auto-Repair';
        enableLabel.appendChild(enableCheckbox);
        enableLabel.appendChild(enableText);
        enableSection.appendChild(enableLabel);

        // Wear threshold section
        var thresholdSection = document.createElement('div');
        thresholdSection.className = 'repair-section';
        var thresholdLabel = document.createElement('label');
        thresholdLabel.className = 'repair-field-label';
        thresholdLabel.textContent = 'Wear Threshold (%)';
        var thresholdInput = document.createElement('input');
        thresholdInput.type = 'number';
        thresholdInput.id = 'yf-threshold';
        thresholdInput.className = 'redesign repair-input';
        thresholdInput.min = '1';
        thresholdInput.max = '99';
        thresholdInput.value = settings.wearThreshold;
        var thresholdHint = document.createElement('div');
        thresholdHint.className = 'repair-hint';
        thresholdHint.textContent = 'Repair vessels when wear reaches this percentage (1-99)';
        thresholdSection.appendChild(thresholdLabel);
        thresholdSection.appendChild(thresholdInput);
        thresholdSection.appendChild(thresholdHint);

        // Min cash section
        var minCashSection = document.createElement('div');
        minCashSection.className = 'repair-section';
        var minCashLabel = document.createElement('label');
        minCashLabel.className = 'repair-field-label';
        minCashLabel.textContent = 'Minimum Cash Balance';
        var minCashInput = document.createElement('input');
        minCashInput.id = 'yf-mincash';
        minCashInput.className = 'redesign repair-input';
        minCashInput.value = formatNumberWithSeparator(settings.minCashAfterRepair);
        setupThousandSeparator(minCashInput);
        var minCashHint = document.createElement('div');
        minCashHint.className = 'repair-hint';
        minCashHint.textContent = 'Keep at least this much cash after repairs (minimum $1,000,000)';
        minCashSection.appendChild(minCashLabel);
        minCashSection.appendChild(minCashInput);
        minCashSection.appendChild(minCashHint);

        // Notifications section
        var notifySection = document.createElement('div');
        notifySection.className = 'repair-section';
        notifySection.style.marginBottom = '24px';
        var notifyTitle = document.createElement('div');
        notifyTitle.className = 'repair-field-label';
        notifyTitle.textContent = 'Notifications';
        notifyTitle.style.marginBottom = '12px';
        var notifyGroup = document.createElement('div');
        notifyGroup.className = 'repair-notify-group';

        var ingameLabel = document.createElement('label');
        ingameLabel.className = 'repair-notify-label';
        var ingameCheckbox = document.createElement('input');
        ingameCheckbox.type = 'checkbox';
        ingameCheckbox.id = 'yf-notify-ingame';
        ingameCheckbox.className = 'repair-notify-checkbox';
        ingameCheckbox.checked = settings.notifyIngame;
        var ingameText = document.createElement('span');
        ingameText.className = 'repair-notify-text';
        ingameText.textContent = 'Ingame';
        ingameLabel.appendChild(ingameCheckbox);
        ingameLabel.appendChild(ingameText);

        var systemLabel = document.createElement('label');
        systemLabel.className = 'repair-notify-label';
        var systemCheckbox = document.createElement('input');
        systemCheckbox.type = 'checkbox';
        systemCheckbox.id = 'yf-notify-system';
        systemCheckbox.className = 'repair-notify-checkbox';
        systemCheckbox.checked = settings.notifySystem;
        var systemText = document.createElement('span');
        systemText.className = 'repair-notify-text';
        systemText.textContent = 'System';
        systemLabel.appendChild(systemCheckbox);
        systemLabel.appendChild(systemText);

        notifyGroup.appendChild(ingameLabel);
        notifyGroup.appendChild(systemLabel);
        notifySection.appendChild(notifyTitle);
        notifySection.appendChild(notifyGroup);

        // Buttons section
        var buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'repair-buttons';
        var cancelBtn = document.createElement('button');
        cancelBtn.id = 'yf-cancel';
        cancelBtn.className = 'btn btn-secondary repair-btn repair-btn-secondary';
        cancelBtn.textContent = 'Cancel';
        var saveBtn = document.createElement('button');
        saveBtn.id = 'yf-save';
        saveBtn.className = 'btn btn-green repair-btn repair-btn-green';
        saveBtn.textContent = 'Save';
        buttonsDiv.appendChild(cancelBtn);
        buttonsDiv.appendChild(saveBtn);

        // Assemble
        container.appendChild(enableSection);
        container.appendChild(thresholdSection);
        container.appendChild(minCashSection);
        container.appendChild(notifySection);
        container.appendChild(buttonsDiv);
        settingsContent.appendChild(container);

        // Event delegation on container instead of individual listeners
        settingsContent.addEventListener('click', function(e) {
            if (e.target.id === 'yf-cancel') {
                closeRepairModal();
            } else if (e.target.id === 'yf-save') {
                handleSaveSettings();
            }
        });

        // Debounced input validation
        thresholdInput.addEventListener('input', debounceInput('threshold', function() {
            var val = parseInt(thresholdInput.value, 10);
            if (Number.isInteger(val) && val >= 1 && val <= 99) {
                thresholdInput.style.borderColor = '';
            } else {
                thresholdInput.style.borderColor = '#ff0000';
            }
        }, 300));

        minCashInput.addEventListener('input', debounceInput('minCash', function() {
            var val = getNumericValue(minCashInput);
            if (Number.isInteger(val) && val >= 1000000) {
                minCashInput.style.borderColor = '';
            } else {
                minCashInput.style.borderColor = '#ff0000';
            }
        }, 300));
    }

    function handleSaveSettings() {
        var enabled = document.getElementById('yf-enabled').checked;
        var thresholdVal = document.getElementById('yf-threshold').value;
        var notifyIngame = document.getElementById('yf-notify-ingame').checked;
        var notifySystem = document.getElementById('yf-notify-system').checked;

        var threshold = parseInt(thresholdVal, 10);
        var minCash = getNumericValue(document.getElementById('yf-mincash'));

        // Validate with Number.isInteger and whitelisted ranges
        if (!Number.isInteger(threshold) || threshold < 1 || threshold > 99) {
            alert('Wear threshold must be between 1 and 99');
            return;
        }
        if (!Number.isInteger(minCash) || minCash < 1000000) {
            alert('Minimum cash must be at least $1,000,000');
            return;
        }

        // Update settings using Object.assign
        var wasEnabled = settings.enabled;
        Object.assign(settings, {
            enabled: enabled,
            wearThreshold: threshold,
            minCashAfterRepair: minCash,
            notifyIngame: notifyIngame,
            notifySystem: notifySystem
        });

        saveSettings().then(function() {
            // Start/stop monitoring based on enabled state
            if (enabled && !wasEnabled) {
                startMonitoring();
            } else if (!enabled && wasEnabled) {
                stopMonitoring();
            }

            log('Settings saved: threshold=' + threshold + '%, minCash=$' + minCash + ', enabled=' + enabled);
            showToast('Auto Repair settings saved');
            closeRepairModal();
        });
    }

    // ========== INITIALIZATION ==========
    var uiInitialized = false;
    var uiRetryCount = 0;
    var MAX_UI_RETRIES = 30; // Try for 30 seconds

    function initUI() {
        if (uiInitialized) return;

        var hasApp = document.getElementById('app');
        if (!hasApp) {
            uiRetryCount++;
            if (uiRetryCount < MAX_UI_RETRIES) {
                setTimeout(initUI, 1000);
                return;
            }
            log('Max UI retries reached, running in background mode');
            return;
        }

        uiInitialized = true;
    }

    async function init() {
        log('Initializing v2.43...');

        // Register menu immediately - no DOM needed for IPC call
        addMenuItem('Auto Repair', openSettingsModal, 21);
        initUI();

        await loadSettings();
        setupRepairModalWatcher();

        // Cleanup fetch on page unload
        window.addEventListener('beforeunload', function() {
            if (activeAbortController) {
                activeAbortController.abort();
                activeAbortController = null;
            }
        });

        if (settings.enabled) {
            setTimeout(startMonitoring, 3000);
        }
    }

    // Expose for Android BackgroundScriptService
    window.rebelshipRunYardForeman = function() {
        return loadSettings().then(function() {
            if (!settings.enabled) {
                return { skipped: true, reason: 'disabled' };
            }
            return runRepairCheck();
        });
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
        name: 'YardForeman',
        run: function() { return window.rebelshipRunYardForeman(); }
    });
})();
