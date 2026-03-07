// ==UserScript==
// @name         ShippingManager - Auto Anchor Points
// @namespace    https://rebelship.org/
// @version      1.49
// @description  Auto-purchase anchor points when timer expires
// @author       https://github.com/justonlyforyou/
// @order        9
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-start
// @enabled      false
// @background-job-required true
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// ==/UserScript==
/* globals addMenuItem, XMLHttpRequest, Event */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AutoAnchor';
    var STORE_NAME = 'data';
    var CHECK_INTERVAL_MS = 15 * 60 * 1000;

    var settings = {
        enabled: false,
        buyAmount: 1,
        minCashAfterPurchase: 5000000,
        notifyIngame: true,
        notifySystem: false
    };

    var pending = {
        amount: null,
        anchorNextBuild: null
    };

    var monitorInterval = null;
    var isModalOpen = false;
    var userSettingsCache = { data: null, timestamp: 0 };
    var USER_SETTINGS_CACHE_TTL = 60000; // 1 minute
    var processedSliderInputs = new WeakSet();
    var sliderFixTimeout = null;
    var modalEventListeners = [];
    var rebelshipMenuClickHandler = null;

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

    // Check if lock exists (script reload), only reset isProcessing flag
    if (!window._autoAnchorLock) {
        window._autoAnchorLock = { isProcessing: false };
    } else {
        window._autoAnchorLock.isProcessing = false;
    }

    function log(msg, level) {
        var prefix = '[' + SCRIPT_NAME + ']';
        if (level === 'error') {
            console.error(prefix, msg);
        } else {
            console.log(prefix, msg);
        }
    }

    // ========== FETCH INTERCEPTOR ==========
    function setupFetchInterceptor() {
        var originalFetch = window.fetch;
        window.fetch = function(input, fetchInit) {
            var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

            // Skip interceptor for script-initiated requests (marked with custom header)
            var isScriptRequest = fetchInit && fetchInit.headers && fetchInit.headers['X-AutoAnchor-Script'];

            return originalFetch.apply(this, arguments).then(function(response) {
                if (!isScriptRequest) {
                    if (url.indexOf('anchor-point/purchase-anchor-points') !== -1) {
                        response.clone().json().then(function(data) {
                            handlePurchaseResponse(fetchInit, data);
                        }).catch(function(err) {
                            log('Fetch interceptor: purchase response parse error: ' + err, 'error');
                        });
                    } else if (url.indexOf('anchor-point/reset-anchor-timing') !== -1) {
                        response.clone().json().then(function(data) {
                            handleResetResponse(data);
                        }).catch(function(err) {
                            log('Fetch interceptor: reset response parse error: ' + err, 'error');
                        });
                    }
                }
                return response;
            });
        };

        var originalXHROpen = XMLHttpRequest.prototype.open;
        var originalXHRSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._anchorUrl = url;
            this._anchorMethod = method;
            return originalXHROpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function(body) {
            var xhr = this;
            var url = xhr._anchorUrl;

            if (url && url.indexOf('anchor-point/purchase-anchor-points') !== -1) {
                xhr._anchorBody = body;
                xhr.addEventListener('load', function() {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        handlePurchaseResponse({ body: xhr._anchorBody }, data);
                    } catch (err) {
                        log('XHR interceptor: purchase response parse error: ' + err, 'error');
                    }
                });
            } else if (url && url.indexOf('anchor-point/reset-anchor-timing') !== -1) {
                xhr.addEventListener('load', function() {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        handleResetResponse(data);
                    } catch (err) {
                        log('XHR interceptor: reset response parse error: ' + err, 'error');
                    }
                });
            }

            return originalXHRSend.apply(this, arguments);
        };

        log('Fetch interceptor installed');
    }

    function handlePurchaseResponse(fetchInit, data) {
        if (!data || !data.data || !data.data.success) {
            return;
        }

        var amount = 1;
        if (fetchInit && fetchInit.body) {
            try {
                var bodyData = typeof fetchInit.body === 'string' ? JSON.parse(fetchInit.body) : fetchInit.body;
                if (bodyData.amount) {
                    amount = bodyData.amount;
                }
            } catch {}
        }

        pending.amount = amount;
        pending.anchorNextBuild = data.data.anchor_next_build;

        log('Purchase intercepted: amount=' + amount + ', timer=' + pending.anchorNextBuild);
        savePending();
    }

    function handleResetResponse(data) {
        if (!data || data.error) {
            return;
        }

        var newTimer = data.data ? data.data.anchor_next_build : null;
        var now = Math.floor(Date.now() / 1000);

        if (!newTimer || newTimer <= now) {
            log('Timer reset detected, clearing pending');
            pending.amount = null;
            pending.anchorNextBuild = null;
            savePending();
        }
    }

    // ========== REBELSHIPBRIDGE STORAGE ==========
    async function dbGet(key) {
        if (!window.RebelShipBridge) return null;
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            log('dbGet error: ' + e, 'error');
            return null;
        }
    }

    async function dbSet(key, value) {
        if (!window.RebelShipBridge) return false;
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            log('dbSet error: ' + e, 'error');
            return false;
        }
    }

    async function loadSettings() {
        try {
            var record = await dbGet('settings');
            if (record) {
                settings = {
                    enabled: record.enabled !== undefined ? record.enabled : false,
                    buyAmount: record.buyAmount !== undefined ? record.buyAmount : 1,
                    minCashAfterPurchase: record.minCashAfterPurchase !== undefined ? record.minCashAfterPurchase : 5000000,
                    notifyIngame: record.notifyIngame !== undefined ? record.notifyIngame : true,
                    notifySystem: record.notifySystem !== undefined ? record.notifySystem : false
                };
            }
            return settings;
        } catch (e) {
            log('Failed to load settings: ' + e, 'error');
            return settings;
        }
    }

    async function saveSettings() {
        try {
            await dbSet('settings', settings);
            log('Settings saved');
        } catch (e) {
            log('Failed to save settings: ' + e, 'error');
        }
    }

    async function loadPending() {
        try {
            var record = await dbGet('pending');
            if (record) {
                pending.amount = record.amount;
                pending.anchorNextBuild = record.anchorNextBuild;
            }
        } catch (e) {
            log('Failed to load pending: ' + e, 'error');
        }
    }

    async function savePending() {
        try {
            if (pending.amount === null) {
                await dbSet('pending', null);
            } else {
                await dbSet('pending', pending);
            }
        } catch (e) {
            log('Failed to save pending: ' + e, 'error');
        }
    }

    // ========== API FUNCTIONS ==========
    // CSRF Note: credentials: 'include' sends cookies (session auth) automatically.
    // ShippingManager uses SameSite cookie policy for CSRF protection instead of explicit tokens.
    // External scripts cannot trigger CSRF since browser enforces SameSite=Lax/Strict on session cookies.
    function fetchWithCookie(url, options) {
        options = options || {};
        var mergedHeaders = Object.assign({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-AutoAnchor-Script': 'true' // Mark script requests to skip interceptor
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

    function getAnchorPrice() {
        return fetchWithCookie('https://shippingmanager.cc/api/anchor-point/get-anchor-price', {
            method: 'POST',
            body: JSON.stringify({})
        });
    }

    function getUserSettings() {
        var now = Date.now();
        if (userSettingsCache.data && (now - userSettingsCache.timestamp) < USER_SETTINGS_CACHE_TTL) {
            return Promise.resolve(userSettingsCache.data);
        }
        return fetchWithCookie('https://shippingmanager.cc/api/user/get-user-settings', {
            method: 'POST',
            body: JSON.stringify({})
        }).then(function(data) {
            userSettingsCache.data = data;
            userSettingsCache.timestamp = now;
            return data;
        });
    }

    function purchaseAnchorPoints(amount) {
        return fetchWithCookie('https://shippingmanager.cc/api/anchor-point/purchase-anchor-points', {
            method: 'POST',
            body: JSON.stringify({ amount: amount })
        });
    }

    // ========== CORE LOGIC ==========
    function runAnchorCheck() {
        if (!settings.enabled || window._autoAnchorLock.isProcessing) {
            return Promise.resolve({ skipped: true, reason: !settings.enabled ? 'disabled' : 'processing' });
        }

        window._autoAnchorLock.isProcessing = true;
        log('Running anchor check...');

        var result = {
            checked: true,
            purchased: false,
            amount: 0,
            cost: 0,
            error: null
        };

        return getUserSettings().then(function(userSettingsData) {
            var anchorNextBuild = userSettingsData.data && userSettingsData.data.settings
                ? userSettingsData.data.settings.anchor_next_build
                : null;
            var now = Math.floor(Date.now() / 1000);

            if (anchorNextBuild && anchorNextBuild > now) {
                var remaining = anchorNextBuild - now;
                var minutes = Math.floor(remaining / 60);
                log('Timer active: ' + minutes + 'm remaining');

                if (pending.anchorNextBuild !== anchorNextBuild) {
                    pending.anchorNextBuild = anchorNextBuild;
                    savePending();
                }

                return result;
            }

            if (pending.amount !== null) {
                log('Timer expired, clearing pending');
                pending.amount = null;
                pending.anchorNextBuild = null;
                savePending();
            }

            // Parallel API call: fetch price without waiting for settings again
            return getAnchorPrice().then(function(priceData) {
                var price = priceData.data.price;
                var cash = priceData.user ? priceData.user.cash : 0;
                var amount = settings.buyAmount;
                var totalCost = price * amount;
                var cashAfterPurchase = cash - totalCost;

                log('Price: $' + price.toLocaleString() + ' x ' + amount + ' = $' + totalCost.toLocaleString());
                log('Cash: $' + cash.toLocaleString() + ', after: $' + cashAfterPurchase.toLocaleString());

                if (cashAfterPurchase < settings.minCashAfterPurchase) {
                    log('Insufficient funds: need to keep $' + settings.minCashAfterPurchase.toLocaleString());
                    result.error = 'insufficient_funds';
                    return result;
                }

                return purchaseAnchorPoints(amount).then(function(purchaseData) {
                    if (!purchaseData.data || !purchaseData.data.success) {
                        log('Purchase failed', 'error');
                        result.error = 'purchase_failed';
                        return result;
                    }

                    result.purchased = true;
                    result.amount = amount;
                    result.cost = totalCost;

                    pending.amount = amount;
                    pending.anchorNextBuild = purchaseData.data.anchor_next_build;
                    savePending();

                    var msg = 'Purchased ' + amount + ' anchor point' + (amount > 1 ? 's' : '') + ' for $' + totalCost.toLocaleString();
                    log(msg);
                    showToast(msg);

                    return result;
                });
            });
        }).catch(function(error) {
            log('Error: ' + error.message, 'error');
            result.error = error.message;
            return result;
        }).finally(function() {
            window._autoAnchorLock.isProcessing = false;
        });
    }

    // ========== GAME MODAL UI FIX ==========
    function setupGameModalObserver() {
        var observer = new MutationObserver(function(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var mutation = mutations[i];
                for (var j = 0; j < mutation.addedNodes.length; j++) {
                    var node = mutation.addedNodes[j];
                    if (node.nodeType === 1) {
                        checkAndFixGameModal(node);
                    }
                }
            }
        });

        var modalContainer = document.getElementById('modal-container') || document.getElementById('app') || document.body;
        observer.observe(modalContainer, { childList: true, subtree: true });
        log('Game modal observer started');
    }

    function checkAndFixGameModal(node) {
        // Check classList first (fast), only querySelector if node itself doesn't match
        var anchorModal = null;
        var nodeClass = node.getAttribute ? node.getAttribute('class') : '';
        if (node.classList && (node.classList.contains('anchorPoints_purchase') || (nodeClass && nodeClass.indexOf('anchorPoints') !== -1))) {
            anchorModal = node;
        } else if (node.querySelector) {
            anchorModal = node.querySelector('.anchorPoints_purchase, [class*="anchorPoints"]');
        }

        if (!anchorModal) return;

        if (pending.amount === null) return;

        if (sliderFixTimeout) {
            clearTimeout(sliderFixTimeout);
        }
        sliderFixTimeout = setTimeout(function() {
            fixGameModalSlider(anchorModal);
            sliderFixTimeout = null;
        }, 100);
    }

    function fixGameModalSlider(anchorModal) {
        if (pending.amount === null) return;
        if (!anchorModal) return;

        // Scope to anchorModal element only
        var sliderInputs = anchorModal.querySelectorAll('input[type="range"], input');
        for (var i = 0; i < sliderInputs.length; i++) {
            var input = sliderInputs[i];
            // Skip already processed inputs
            if (processedSliderInputs.has(input)) continue;

            var parent = input.closest('.anchorPoints_purchase, [class*="anchorPoints"]');
            if (parent) {
                var targetValue = pending.amount === 10 ? 10 : 1;
                if (parseInt(input.value, 10) !== targetValue) {
                    input.value = targetValue;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    log('Fixed game modal slider to ' + targetValue);
                    processedSliderInputs.add(input);
                }
                break;
            }
        }
    }

    // ========== MONITORING ==========
    function startMonitoring() {
        if (monitorInterval) {
            clearInterval(monitorInterval);
        }
        monitorInterval = setInterval(runAnchorCheck, CHECK_INTERVAL_MS);
        log('Monitoring started (15 min interval)');
    }

    function stopMonitoring() {
        if (monitorInterval) {
            clearInterval(monitorInterval);
            monitorInterval = null;
        }
        log('Monitoring stopped');
    }

    // ========== NOTIFICATIONS ==========
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

    function showToast(message, type) {
        type = type || 'success';
        if (settings.notifyIngame) {
            var toastStore = getToastStore();
            if (toastStore) {
                try {
                    if (type === 'error' && toastStore.error) {
                        toastStore.error(message);
                    } else if (toastStore.success) {
                        toastStore.success(message);
                    }
                } catch (e) {
                    log('Toast error: ' + e.message, 'error');
                }
            }
        }

        if (settings.notifySystem) {
            sendSystemNotification(SCRIPT_NAME, message);
        }
    }

    function sendSystemNotification(title, message) {
        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(title + ': ' + message);
                return;
            } catch {}
        }

        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                new Notification(title, {
                    body: message,
                    icon: 'https://shippingmanager.cc/favicon.ico',
                    tag: 'auto-anchor'
                });
            } catch {}
        }
    }

    // ========== SETTINGS MODAL ==========
    function injectModalStyles() {
        if (document.getElementById('anchor-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'anchor-modal-styles';
        style.textContent = [
            '@keyframes anchor-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes anchor-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes anchor-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes anchor-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#anchor-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#anchor-modal-wrapper #anchor-modal-background{animation:anchor-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#anchor-modal-wrapper.hide #anchor-modal-background{animation:anchor-fade-out .15s linear forwards}',
            '#anchor-modal-wrapper #anchor-modal-content-wrapper{animation:anchor-drop-down .15s linear forwards,anchor-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#anchor-modal-wrapper.hide #anchor-modal-content-wrapper{animation:anchor-push-up .15s linear forwards,anchor-fade-out .15s linear forwards}',
            '@media screen and (min-width:769px){#anchor-modal-wrapper #anchor-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#anchor-modal-wrapper #anchor-modal-content-wrapper{max-width:100%}}',
            '#anchor-modal-wrapper #anchor-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#anchor-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#anchor-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#anchor-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#anchor-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#anchor-modal-container #anchor-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#anchor-modal-container #anchor-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#anchor-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function cleanupModalEventListeners() {
        for (var i = 0; i < modalEventListeners.length; i++) {
            var listener = modalEventListeners[i];
            listener.element.removeEventListener(listener.event, listener.handler);
        }
        modalEventListeners = [];
    }

    function closeModal() {
        if (!isModalOpen) return;
        isModalOpen = false;

        // Clear pending timeout
        if (sliderFixTimeout) {
            clearTimeout(sliderFixTimeout);
            sliderFixTimeout = null;
        }

        var modalWrapper = document.getElementById('anchor-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }

    function setupModalWatcher() {
        // Store listener function, removeEventListener before addEventListener to prevent duplicates
        if (!rebelshipMenuClickHandler) {
            rebelshipMenuClickHandler = function() {
                if (isModalOpen) {
                    closeModal();
                }
            };
        } else {
            window.removeEventListener('rebelship-menu-click', rebelshipMenuClickHandler);
        }
        window.addEventListener('rebelship-menu-click', rebelshipMenuClickHandler);
    }

    function openSettingsModal() {
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectModalStyles();

        var existing = document.getElementById('anchor-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#anchor-settings-content');
            if (contentCheck) {
                existing.classList.remove('hide');
                isModalOpen = true;
                updateSettingsContent();
                return;
            }
            // Cleanup event listeners before removing modal
            cleanupModalEventListeners();
            existing.remove();
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'anchor-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'anchor-modal-background';
        var bgClickHandler = function() { closeModal(); };
        modalBackground.onclick = bgClickHandler;
        modalEventListeners.push({ element: modalBackground, event: 'click', handler: bgClickHandler });

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'anchor-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'anchor-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto Anchor Settings';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        var closeClickHandler = function() { closeModal(); };
        closeIcon.onclick = closeClickHandler;
        modalEventListeners.push({ element: closeIcon, event: 'click', handler: closeClickHandler });
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            var fallbackHandler = function() { closeModal(); };
            fallback.onclick = fallbackHandler;
            modalEventListeners.push({ element: fallback, event: 'click', handler: fallbackHandler });
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'anchor-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'anchor-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'anchor-settings-content';
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
        var settingsContent = document.getElementById('anchor-settings-content');
        if (!settingsContent) return;

        settingsContent.innerHTML = '<div style="padding:20px;text-align:center;color:#626b90;">Loading...</div>';

        getUserSettings().then(function(userSettingsData) {
            var anchorNextBuild = userSettingsData.data && userSettingsData.data.settings
                ? userSettingsData.data.settings.anchor_next_build
                : null;

            var pendingInfo = '';
            var now = Math.floor(Date.now() / 1000);

            if (anchorNextBuild && anchorNextBuild > now) {
                var remaining = anchorNextBuild - now;
                var days = Math.floor(remaining / 86400);
                var hours = Math.floor((remaining % 86400) / 3600);
                var minutes = Math.floor((remaining % 3600) / 60);
                var timeStr = '';
                if (days > 0) timeStr += days + 'd ';
                if (hours > 0 || days > 0) timeStr += hours + 'h ';
                timeStr += minutes + 'm';
                pendingInfo = '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px;margin-bottom:20px;">' +
                    '<div style="font-weight:700;color:#856404;">Currently Building</div>' +
                    '<div style="color:#856404;margin-top:4px;">' + timeStr + ' remaining</div>' +
                    '</div>';
            }

            renderSettingsForm(settingsContent, pendingInfo);
        }).catch(function(err) {
            log('Failed to fetch timer: ' + err.message, 'error');
            renderSettingsForm(settingsContent, '');
        });
    }

    function renderSettingsForm(settingsContent, pendingInfo) {

        settingsContent.innerHTML = '\
            <div style="padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                ' + pendingInfo + '\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="anchor-enabled" ' + (settings.enabled ? 'checked' : '') + '\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span>Enable Auto-Buy</span>\
                    </label>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                        Purchase Amount\
                    </label>\
                    <div style="display:flex;gap:20px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="radio" name="anchor-amount" value="1" ' + (settings.buyAmount === 1 ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:14px;">1 Anchor Point</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="radio" name="anchor-amount" value="10" ' + (settings.buyAmount === 10 ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:14px;">10 Anchor Points</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                        Minimum Cash Balance\
                    </label>\
                    <input type="text" id="anchor-mincash" inputmode="numeric" value="' + formatNumberWithSeparator(settings.minCashAfterPurchase) + '"\
                           class="redesign" style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;">\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;">\
                        Keep at least this much cash after purchase\
                    </div>\
                </div>\
                <div style="margin-bottom:24px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="anchor-notify-ingame" ' + (settings.notifyIngame ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="anchor-notify-system" ' + (settings.notifySystem ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:30px;">\
                    <button id="anchor-cancel" class="btn btn-secondary" style="padding:10px 24px;background:linear-gradient(90deg,#d7d8db,#95969b);border:0;border-radius:6px;color:#393939;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">\
                        Cancel\
                    </button>\
                    <button id="anchor-save" class="btn btn-green" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">\
                        Save\
                    </button>\
                </div>\
            </div>';

        var mincashEl = document.getElementById('anchor-mincash');
        if (mincashEl) setupThousandSeparator(mincashEl);

        var cancelBtn = document.getElementById('anchor-cancel');
        var cancelHandler = function() {
            closeModal();
        };
        cancelBtn.addEventListener('click', cancelHandler);
        modalEventListeners.push({ element: cancelBtn, event: 'click', handler: cancelHandler });

        var saveBtn = document.getElementById('anchor-save');
        var saveHandler = function() {
            var enabled = document.getElementById('anchor-enabled').checked;
            var amountRadio = document.querySelector('input[name="anchor-amount"]:checked');
            var amount = amountRadio ? parseInt(amountRadio.value, 10) : 1;
            var minCash = getNumericValue(document.getElementById('anchor-mincash'));
            var notifyIngame = document.getElementById('anchor-notify-ingame').checked;
            var notifySystem = document.getElementById('anchor-notify-system').checked;

            if (isNaN(minCash) || minCash < 0) {
                minCash = 0;
            }

            var wasEnabled = settings.enabled;
            settings.enabled = enabled;
            settings.buyAmount = amount;
            settings.minCashAfterPurchase = minCash;
            settings.notifyIngame = notifyIngame;
            settings.notifySystem = notifySystem;

            saveSettings().then(function() {
                if (enabled && !wasEnabled) {
                    startMonitoring();
                } else if (!enabled && wasEnabled) {
                    stopMonitoring();
                }

                log('Settings saved: amount=' + amount + ', minCash=$' + minCash + ', enabled=' + enabled);
                showToast('Auto Anchor settings saved');
                closeModal();
            });
        };
        saveBtn.addEventListener('click', saveHandler);
        modalEventListeners.push({ element: saveBtn, event: 'click', handler: saveHandler });
    }

    // ========== INITIALIZATION ==========
    async function initBridge() {
        if (window.RebelShipBridge) {
            await loadSettings();
            await loadPending();
            log('Bridge ready, settings loaded');

            if (settings.enabled) {
                setTimeout(startMonitoring, 3000);
            }

            // Re-check when tab becomes visible again (Android background suspension)
            document.addEventListener('visibilitychange', function() {
                if (!document.hidden && settings.enabled) {
                    log('Tab visible - invalidating cache and running check');
                    userSettingsCache.data = null;
                    userSettingsCache.timestamp = 0;
                    runAnchorCheck();
                }
            });
        } else {
            var bridgeObserver = new MutationObserver(function() {
                if (window.RebelShipBridge) {
                    bridgeObserver.disconnect();
                    initBridge();
                }
            });
            bridgeObserver.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(function() {
                bridgeObserver.disconnect();
                if (!window.RebelShipBridge) {
                    log('RebelShipBridge not found after 5 seconds', 'error');
                }
            }, 5000);
        }
    }

    function init() {
        log('Initializing v1.0...');

        setupFetchInterceptor();

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                addMenuItem('Auto Anchor', openSettingsModal, 22);
                setupModalWatcher();
                setupGameModalObserver();
            });
        } else {
            addMenuItem('Auto Anchor', openSettingsModal, 22);
            setupModalWatcher();
            setupGameModalObserver();
        }

        initBridge();
    }

    window.rebelshipRunAutoAnchor = function() {
        return loadSettings().then(function() {
            if (!settings.enabled) {
                return { skipped: true, reason: 'disabled' };
            }
            return runAnchorCheck();
        });
    };

    if (!window.__rebelshipHeadless) {
        init();
    }

    window.rebelshipBackgroundJobs = window.rebelshipBackgroundJobs || [];
    window.rebelshipBackgroundJobs.push({
        name: 'AutoAnchor',
        run: function() { return window.rebelshipRunAutoAnchor(); }
    });
})();
