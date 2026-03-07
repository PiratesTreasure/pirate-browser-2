// ==UserScript==
// @name         ShippingManager - Captain Blackbeard
// @namespace    https://rebelship.org/
// @version      1.24
// @description  Auto-negotiate hijacked vessels: bid twice at 25%, accept third pirate price
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

    console.log('[Blackbeard] Script loading...');

    // ========== CONFIGURATION ==========
    var SCRIPT_NAME = 'CaptainBlackbeard';
    var STORE_NAME = 'data';
    var OFFER_PERCENTAGE = 0.25;                // 25% of pirate price
    var WAIT_TIME_MS = 2 * 60 * 1000;          // 2 minutes between offers

    // ========== STATE ==========
    var settings = {
        enabled: false,
        checkIntervalMinutes: 5,  // 5, 15, or 30
        notifyIngame: true,
        notifySystem: false
    };
    var monitorInterval = null;
    var isModalOpen = false;
    var modalListenerAttached = false;

    // Global lock + active negotiations tracker (survives script reload)
    if (!window._blackbeardLock) {
        window._blackbeardLock = { isProcessing: false, lastRunTime: 0, lastCheckTime: 0 };
    }
    if (!window._blackbeardNegotiations) {
        window._blackbeardNegotiations = new Map();
    }

    // Case status cache with TTL (30 seconds)
    var caseStatusCache = new Map(); // { caseId: { status: 'solved', timestamp: Date.now() } }
    var CASE_STATUS_TTL = 30000; // 30 seconds

    // Pinia cache with TTL (60 seconds)
    var cachedPinia = null;
    var piniaCacheTime = 0;
    var PINIA_CACHE_TTL = 60000; // 60 seconds

    // ========== REBELSHIPBRIDGE STORAGE ==========
    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[Blackbeard] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[Blackbeard] dbSet error:', e);
            return false;
        }
    }

    async function loadSettings() {
        try {
            var record = await dbGet('settings');
            if (record) {
                settings = {
                    enabled: record.enabled !== undefined ? record.enabled : false,
                    checkIntervalMinutes: record.checkIntervalMinutes !== undefined ? record.checkIntervalMinutes : 5,
                    notifyIngame: record.notifyIngame !== undefined ? record.notifyIngame : true,
                    notifySystem: record.notifySystem !== undefined ? record.notifySystem : false
                };
            }
            return settings;
        } catch (e) {
            console.error('[Blackbeard] Failed to load settings:', e);
            return settings;
        }
    }

    async function saveSettings() {
        try {
            await dbSet('settings', settings);
            log('Settings saved');
        } catch (e) {
            console.error('[Blackbeard] Failed to save settings:', e);
        }
    }

    // ========== DIRECT API FUNCTIONS ==========
    function fetchWithCookie(url, options) {
        options = options || {};
        var mergedHeaders = Object.assign({
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }, options.headers);

        return fetch(url, Object.assign({
            credentials: 'include'
        }, options, {
            headers: mergedHeaders
        })).then(function(response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        });
    }

    function getAllHijackingCases() {
        // Early exit if active negotiations exist and last check < 60 seconds ago
        var now = Date.now();
        if (window._blackbeardNegotiations.size > 0 &&
            (now - window._blackbeardLock.lastCheckTime) < 60000) {
            log('Active negotiation in progress, skipping getAllHijackingCases (last check: ' +
                Math.floor((now - window._blackbeardLock.lastCheckTime) / 1000) + 's ago)');
            return Promise.resolve([]);
        }

        return fetchWithCookie('https://shippingmanager.cc/api/game/index', {
            method: 'GET'
        }).then(function(data) {
            window._blackbeardLock.lastCheckTime = Date.now();
            var messages = (data && data.data && data.data.messages) || [];
            var hijackCases = [];
            for (var i = 0; i < messages.length; i++) {
                var msg = messages[i];
                if (msg.system_chat && msg.body === 'vessel_got_hijacked' && msg.values && msg.values.case_id) {
                    hijackCases.push({
                        case_id: msg.values.case_id,
                        vessel_name: msg.values.vessel_name || 'Unknown Vessel',
                        user_vessel_id: msg.values.user_vessel_id,
                        status: 'open'
                    });
                }
            }
            return hijackCases;
        });
    }

    function getCase(caseId) {
        return fetchWithCookie('https://shippingmanager.cc/api/hijacking/get-case', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ case_id: caseId })
        }).then(function(data) {
            // Update cache
            if (data && data.data && data.data.status) {
                caseStatusCache.set(caseId, {
                    status: data.data.status,
                    timestamp: Date.now()
                });
            }
            return data;
        });
    }

    function getCachedCaseStatus(caseId) {
        var cached = caseStatusCache.get(caseId);
        if (!cached) return null;

        var age = Date.now() - cached.timestamp;
        // If solved/paid, cache is permanent. Otherwise 30s TTL.
        if (cached.status === 'solved' || cached.status === 'paid') {
            return cached.status;
        }
        if (age < CASE_STATUS_TTL) {
            return cached.status;
        }

        // Expired
        caseStatusCache.delete(caseId);
        return null;
    }

    function submitOffer(caseId, amount) {
        return fetchWithCookie('https://shippingmanager.cc/api/hijacking/submit-offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ case_id: caseId, amount: amount })
        }).then(function(data) {
            return data;
        });
    }

    function payRansom(caseId) {
        return fetchWithCookie('https://shippingmanager.cc/api/hijacking/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ case_id: caseId })
        }).then(function(data) {
            return data;
        });
    }

    // ========== HELPER ==========
    function wait(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    // ========== CORE LOGIC ==========

    /**
     * Process a single hijacking case through the full negotiation flow:
     * 1. Offer 25% of initial demand
     * 2. Wait 2 min, offer 25% of pirate counter
     * 3. Wait 2 min, pay final pirate price
     */
    async function processCase(caseId, vesselName) {
        // Prevent duplicate negotiation
        if (window._blackbeardNegotiations.has(caseId)) {
            log('Case ' + caseId + ' already negotiating, skip');
            return { success: false, reason: 'already_negotiating' };
        }

        // Get current case data
        var caseResponse;
        try {
            caseResponse = await getCase(caseId);
        } catch (e) {
            log('Case ' + caseId + ': Failed to get case data - ' + e.message, 'error');
            return { success: false, reason: 'failed_to_get_case' };
        }

        if (!caseResponse || !caseResponse.data) {
            log('Case ' + caseId + ': No case data returned', 'error');
            return { success: false, reason: 'no_case_data' };
        }

        var status = caseResponse.data.status;
        if (status === 'solved' || status === 'paid') {
            return { success: true, reason: 'already_resolved' };
        }

        var initialDemand = caseResponse.data.requested_amount;
        log('=== START Case ' + caseId + ' for ' + vesselName + ' ===');
        log('Case ' + caseId + ': Initial demand $' + initialDemand.toLocaleString() + ', status=' + status);

        // Mark as active
        window._blackbeardNegotiations.set(caseId, 'offer1');

        try {
            // ========== OFFER 1 ==========
            var offer1 = Math.floor(initialDemand * OFFER_PERCENTAGE);
            log('Case ' + caseId + ': OFFER 1: $' + offer1.toLocaleString() + ' (25% of $' + initialDemand.toLocaleString() + ')');

            var response1;
            try {
                response1 = await submitOffer(caseId, offer1);
            } catch (e) {
                log('Case ' + caseId + ': OFFER 1 failed - ' + e.message, 'error');
                return { success: false, reason: 'offer1_failed' };
            }

            if (!response1 || !response1.data) {
                log('Case ' + caseId + ': OFFER 1 no response data', 'error');
                return { success: false, reason: 'offer1_no_data' };
            }

            var pirateCounter1 = response1.data.requested_amount;
            log('Case ' + caseId + ': Pirate counter 1: $' + pirateCounter1.toLocaleString());
            showToast('Blackbeard: Negotiating ' + vesselName + '... Offer 1: $' + offer1.toLocaleString());

            // WAIT 2 MINUTES
            window._blackbeardNegotiations.set(caseId, 'waiting1');
            log('Case ' + caseId + ': Waiting 2 minutes...');
            await wait(WAIT_TIME_MS);

            // ========== OFFER 2 ==========
            var offer2 = Math.floor(pirateCounter1 * OFFER_PERCENTAGE);
            log('Case ' + caseId + ': OFFER 2: $' + offer2.toLocaleString() + ' (25% of $' + pirateCounter1.toLocaleString() + ')');
            window._blackbeardNegotiations.set(caseId, 'offer2');

            var response2;
            try {
                response2 = await submitOffer(caseId, offer2);
            } catch (e) {
                log('Case ' + caseId + ': OFFER 2 failed - ' + e.message, 'error');
                return { success: false, reason: 'offer2_failed' };
            }

            if (!response2 || !response2.data) {
                log('Case ' + caseId + ': OFFER 2 no response data', 'error');
                return { success: false, reason: 'offer2_no_data' };
            }

            var pirateCounter2 = response2.data.requested_amount;
            var cashBefore = response2.user ? response2.user.cash : 0; // Reuse cash from response2
            log('Case ' + caseId + ': Pirate counter 2 (FINAL): $' + pirateCounter2.toLocaleString());
            showToast('Blackbeard: Offer 2 sent for ' + vesselName);

            // WAIT 2 MINUTES
            window._blackbeardNegotiations.set(caseId, 'waiting2');
            log('Case ' + caseId + ': Waiting 2 minutes before payment...');
            await wait(WAIT_TIME_MS);

            // ========== PAYMENT ==========
            window._blackbeardNegotiations.set(caseId, 'paying');
            var finalPrice = pirateCounter2;

            log('Case ' + caseId + ': Ready to pay $' + finalPrice.toLocaleString() + '. Cash: $' + cashBefore.toLocaleString());

            if (cashBefore < finalPrice) {
                log('Case ' + caseId + ': Insufficient funds!', 'error');
                showToast('Blackbeard: Cannot pay ransom for ' + vesselName + '! Need $' + finalPrice.toLocaleString() + ', have $' + cashBefore.toLocaleString(), 'error');
                return { success: false, reason: 'insufficient_funds' };
            }

            // PAY
            var paymentResponse;
            try {
                paymentResponse = await payRansom(caseId);
            } catch (e) {
                log('Case ' + caseId + ': Payment failed - ' + e.message, 'error');
                showToast('Blackbeard: Payment failed for ' + vesselName + '!', 'error');
                return { success: false, reason: 'payment_failed' };
            }

            // Reuse cash from payment response instead of extra getCase() call
            var cashAfter = paymentResponse && paymentResponse.user ? paymentResponse.user.cash : cashBefore;
            var actualPaid = cashBefore - cashAfter;
            var saved = initialDemand - actualPaid;

            // Update cache to mark as solved
            if (paymentResponse && paymentResponse.data && paymentResponse.data.status) {
                caseStatusCache.set(caseId, {
                    status: paymentResponse.data.status,
                    timestamp: Date.now()
                });
            }

            log('=== END Case ' + caseId + ': Paid $' + actualPaid.toLocaleString() + ', Saved $' + saved.toLocaleString() + ' ===');
            showToast('Blackbeard: ' + vesselName + ' released! Paid $' + actualPaid.toLocaleString() + ' (saved $' + saved.toLocaleString() + ')');

            return { success: true, initialDemand: initialDemand, finalPayment: actualPaid, saved: saved };

        } finally {
            window._blackbeardNegotiations.delete(caseId);
        }
    }

    /**
     * Main check: fetch all hijacking cases and process open ones.
     */
    async function runHijackingCheck() {
        if (!settings.enabled || window._blackbeardLock.isProcessing) {
            return { skipped: true, reason: !settings.enabled ? 'disabled' : 'processing' };
        }

        window._blackbeardLock.isProcessing = true;
        var result = { checked: true, casesFound: 0, casesProcessed: 0, error: null };

        try {
            var cases = await getAllHijackingCases();

            if (cases.length === 0) {
                log('No hijacking messages found');
                return result;
            }

            log('Found ' + cases.length + ' hijacking message(s), checking status...');

            // Check actual status for each case via API (with caching)
            var activeCases = [];
            for (var i = 0; i < cases.length; i++) {
                var c = cases[i];
                if (!c.case_id || window._blackbeardNegotiations.has(c.case_id)) continue;

                // Check cache first
                var cachedStatus = getCachedCaseStatus(c.case_id);
                if (cachedStatus) {
                    if (cachedStatus !== 'solved' && cachedStatus !== 'paid') {
                        c.status = cachedStatus;
                        activeCases.push(c);
                    }
                    continue;
                }

                // Cache miss - fetch from API
                try {
                    var caseData = await getCase(c.case_id);
                    if (caseData && caseData.data) {
                        var st = caseData.data.status;
                        if (st !== 'solved' && st !== 'paid') {
                            c.status = st;
                            activeCases.push(c);
                        }
                    }
                } catch (e) {
                    log('Case ' + c.case_id + ': status check failed - ' + e.message, 'error');
                }
            }

            result.casesFound = activeCases.length;

            if (activeCases.length === 0) {
                log('No active hijacking cases');
                return result;
            }

            log(activeCases.length + ' active hijacking case(s)');

            for (var j = 0; j < activeCases.length; j++) {
                var hijackCase = activeCases[j];
                var caseId = hijackCase.case_id;
                var vesselName = hijackCase.vessel_name || 'Unknown Vessel';

                // Skip if already being negotiated
                if (window._blackbeardNegotiations.has(caseId)) {
                    log('Case ' + caseId + ' (' + vesselName + ') already in negotiation, skip');
                    continue;
                }

                try {
                    var caseResult = await processCase(caseId, vesselName);
                    if (caseResult.success) result.casesProcessed++;
                } catch (err) {
                    log('Case ' + caseId + ' error: ' + err.message, 'error');
                }
            }

            return result;
        } catch (error) {
            log('Error fetching cases: ' + error.message, 'error');
            result.error = error.message;
            return result;
        } finally {
            window._blackbeardLock.isProcessing = false;
        }
    }

    // ========== MONITORING ==========
    function getCheckIntervalMs() {
        return settings.checkIntervalMinutes * 60 * 1000;
    }

    function startMonitoring() {
        if (monitorInterval) {
            clearInterval(monitorInterval);
        }
        var intervalMs = getCheckIntervalMs();
        monitorInterval = setInterval(runHijackingCheck, intervalMs);
        log('Monitoring started (' + settings.checkIntervalMinutes + ' min interval)');
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
        var prefix = '[Blackbeard]';
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
                        tag: 'captain-blackbeard'
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
        // Check cache with TTL
        if (cachedPinia && (Date.now() - piniaCacheTime < PINIA_CACHE_TTL)) {
            return cachedPinia;
        }

        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;

            // Cache the result
            if (pinia) {
                cachedPinia = pinia;
                piniaCacheTime = Date.now();
            }

            return pinia;
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

    // ========== CUSTOM MODAL (Game-style) ==========
    function injectModalStyles() {
        if (document.getElementById('blackbeard-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'blackbeard-modal-styles';
        style.textContent = [
            '@keyframes bb-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes bb-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes bb-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes bb-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#bb-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#bb-modal-wrapper #bb-modal-background{animation:bb-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#bb-modal-wrapper.hide #bb-modal-background{animation:bb-fade-out .15s linear forwards}',
            '#bb-modal-wrapper #bb-modal-content-wrapper{animation:bb-drop-down .15s linear forwards,bb-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#bb-modal-wrapper.hide #bb-modal-content-wrapper{animation:bb-push-up .15s linear forwards,bb-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#bb-modal-wrapper #bb-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#bb-modal-wrapper #bb-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#bb-modal-wrapper #bb-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#bb-modal-wrapper #bb-modal-content-wrapper{max-width:100%}}',
            '#bb-modal-wrapper #bb-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#bb-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#bb-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#bb-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#bb-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#bb-modal-container #bb-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#bb-modal-container #bb-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#bb-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeModal() {
        if (!isModalOpen) return;
        log('Closing modal');
        isModalOpen = false;
        var modalWrapper = document.getElementById('bb-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');

            // Remove modal from DOM after animation completes
            setTimeout(function() {
                var wrapper = document.getElementById('bb-modal-wrapper');
                if (wrapper && wrapper.classList.contains('hide')) {
                    wrapper.remove();
                }
            }, 200); // 200ms matches animation duration
        }
    }

    // Named function for cleanup
    function handleMenuClick() {
        if (isModalOpen) {
            log('RebelShip menu clicked, closing modal');
            closeModal();
        }
    }

    function setupModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;
        window.addEventListener('rebelship-menu-click', handleMenuClick);
    }

    function openSettingsModal() {
        // Close any open game modal first
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectModalStyles();

        var existing = document.getElementById('bb-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#bb-settings-content');
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
        modalWrapper.id = 'bb-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'bb-modal-background';
        modalBackground.onclick = function() { closeModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'bb-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'bb-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Captain Blackbeard Settings';

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
        modalContent.id = 'bb-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'bb-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'bb-settings-content';
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
        var settingsContent = document.getElementById('bb-settings-content');
        if (!settingsContent) return;

        settingsContent.innerHTML = '\
            <div style="padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="bb-enabled" ' + (settings.enabled ? 'checked' : '') + '\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span>Enable Captain Blackbeard</span>\
                    </label>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                        Check Interval\
                    </label>\
                    <select id="bb-interval" class="redesign" style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;cursor:pointer;">\
                        <option value="5" ' + (settings.checkIntervalMinutes === 5 ? 'selected' : '') + '>5 minutes</option>\
                        <option value="15" ' + (settings.checkIntervalMinutes === 15 ? 'selected' : '') + '>15 minutes</option>\
                        <option value="30" ' + (settings.checkIntervalMinutes === 30 ? 'selected' : '') + '>30 minutes</option>\
                    </select>\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;">\
                        How often to check for hijacked vessels\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;padding:14px;background:#f4f6fb;border-radius:8px;border-left:4px solid #626b90;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:8px;color:#01125d;">How it works:</div>\
                    <div style="font-size:13px;color:#626b90;line-height:1.6;">\
                        When a vessel gets hijacked, Blackbeard auto-negotiates:<br>\
                        <span style="color:#01125d;font-weight:600;">1.</span> Offers 25% of pirate price<br>\
                        <span style="color:#01125d;font-weight:600;">2.</span> Waits 2 min, offers 25% of counter<br>\
                        <span style="color:#01125d;font-weight:600;">3.</span> Waits 2 min, pays final pirate price\
                    </div>\
                </div>\
                <div style="margin-bottom:24px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="bb-notify-ingame" ' + (settings.notifyIngame ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="bb-notify-system" ' + (settings.notifySystem ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:30px;">\
                    <button id="bb-cancel" class="btn btn-secondary" style="padding:10px 24px;background:linear-gradient(90deg,#d7d8db,#95969b);border:0;border-radius:6px;color:#393939;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">\
                        Cancel\
                    </button>\
                    <button id="bb-save" class="btn btn-green" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">\
                        Save\
                    </button>\
                </div>\
            </div>';

        document.getElementById('bb-cancel').addEventListener('click', function() {
            closeModal();
        });

        document.getElementById('bb-save').addEventListener('click', function() {
            var enabled = document.getElementById('bb-enabled').checked;
            var intervalMinutes = parseInt(document.getElementById('bb-interval').value, 10);
            var notifyIngame = document.getElementById('bb-notify-ingame').checked;
            var notifySystem = document.getElementById('bb-notify-system').checked;

            // Update settings
            var wasEnabled = settings.enabled;
            var intervalChanged = settings.checkIntervalMinutes !== intervalMinutes;
            settings.enabled = enabled;
            settings.checkIntervalMinutes = intervalMinutes;
            settings.notifyIngame = notifyIngame;
            settings.notifySystem = notifySystem;

            saveSettings().then(function() {
                // Start/stop/restart monitoring based on state changes
                if (enabled && !wasEnabled) {
                    startMonitoring();
                } else if (!enabled && wasEnabled) {
                    stopMonitoring();
                } else if (enabled && intervalChanged) {
                    startMonitoring(); // restart with new interval
                }

                log('Settings saved: enabled=' + enabled + ', interval=' + intervalMinutes + 'min');
                showToast('Captain Blackbeard settings saved');
                closeModal();
            });
        });
    }

    // ========== INITIALIZATION ==========
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
            log('Max UI retries reached, running in background mode');
            return;
        }

        uiInitialized = true;
    }

    async function init() {
        log('Initializing v1.0...');

        // Register menu immediately
        addMenuItem('Captain Blackbeard', openSettingsModal, 22);
        initUI();

        await loadSettings();
        setupModalWatcher();

        if (settings.enabled) {
            setTimeout(startMonitoring, 3000);
        }
    }

    // Expose for Android BackgroundScriptService
    window.rebelshipRunCaptainBlackbeard = function() {
        return loadSettings().then(function() {
            if (!settings.enabled) {
                return { skipped: true, reason: 'disabled' };
            }
            return runHijackingCheck();
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
        name: 'CaptainBlackbeard',
        run: function() { return window.rebelshipRunCaptainBlackbeard(); }
    });
})();
