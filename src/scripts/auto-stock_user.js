// ==UserScript==
// @name         ShippingManager - Auto Stock
// @namespace    http://tampermonkey.net/
// @description  IPO Alerts and Investments tabs in Finance modal
// @version      2.99
// @order        16
// @author       RebelShip
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @RequireRebelShipMenu true
// @background-job-required true
// @enabled      false
// @RequireRebelShipStorage true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AutoStock';
    var STORE_NAME = 'data';
    var API_BASE = 'https://shippingmanager.cc/api';

    // Default Settings
    var DEFAULT_SETTINGS = {
        ipoMaxAgeDays: 7,
        ipoCheckLimit: 10,
        autoBuyEnabled: false,
        minCashReserve: 1000000,
        maxStockPrice: 500,
        autoSellEnabled: false,
        autoSellFallingDays: 3,
        autoSellDropPercent: 15,
        inAppAlerts: true,
        desktopNotifications: false,
        buyBlacklist: []
    };

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

    var purchasedIpoIds = new Set();

    // State
    var settings = Object.assign({}, DEFAULT_SETTINGS);
    var tabsInjected = false;
    var bridgeReady = false;
    var isModalOpen = false;
    var modalListenerAttached = false;
    var CHECK_INTERVAL_MS = 6 * 60 * 1000; // 6 minutes

    // Cached data
    var cachedData = {
        freshIpos: [],
        seenIpoIds: [],
        lastUpdate: 0
    };

    function log(msg) {
        console.log('[AutoStock] ' + msg);
    }

    // ============================================
    // PINIA STORE ACCESS
    // ============================================
    function getPinia() {
        var appEl = document.querySelector('#app');
        if (!appEl || !appEl.__vue_app__) return null;
        var app = appEl.__vue_app__;
        return app._context.provides.pinia || app.config.globalProperties.$pinia;
    }

    function getStore(name) {
        var pinia = getPinia();
        if (!pinia || !pinia._s) return null;
        return pinia._s.get(name);
    }

    function getModalStore() {
        return getStore('modal');
    }

    function getToastStore() {
        return getStore('toast');
    }

    function showToast(message, type) {
        type = type || 'success';
        var toastStore = getToastStore();
        if (toastStore) {
            try {
                if (type === 'error' && toastStore.error) {
                    toastStore.error(message);
                } else if (type === 'warning' && toastStore.warning) {
                    toastStore.warning(message);
                } else if (toastStore.success) {
                    toastStore.success(message);
                }
            } catch (err) {
                log('Toast error: ' + err.message);
            }
        }
    }

    function sendSystemNotification(title, message) {
        if (!settings.desktopNotifications) return;

        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(title + ': ' + message);
                log('System notification sent');
                return;
            } catch (e) {
                log('System notification failed: ' + e.message);
            }
        }

        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(title, {
                        body: message,
                        icon: 'https://shippingmanager.cc/favicon.ico',
                        tag: 'auto-stock'
                    });
                    log('Web notification sent');
                } catch (e) {
                    log('Web notification failed: ' + e.message);
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

    function hasUserIPO() {
        var userStore = getStore('user');
        return userStore && userStore.user && userStore.user.ipo === 1;
    }

    function getUserId() {
        var userStore = getStore('user');
        return userStore && userStore.user ? userStore.user.id : null;
    }

    // ============================================
    // STORAGE (RebelShipBridge)
    // ============================================
    async function dbGet(key) {
        if (!window.RebelShipBridge) return null;
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            log('dbGet error: ' + e);
            return null;
        }
    }

    async function dbSet(key, value) {
        if (!window.RebelShipBridge) return false;
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            log('dbSet error: ' + e);
            return false;
        }
    }

    async function loadSettings() {
        var data = await dbGet('settings');
        if (data) {
            settings = Object.assign({}, DEFAULT_SETTINGS, data);
            log('Settings loaded');
        }
    }

    async function saveSettings() {
        await dbSet('settings', settings);
        log('Settings saved');
    }

    async function addToBlacklist(id, companyName) {
        if (!settings.buyBlacklist) settings.buyBlacklist = [];
        var exists = settings.buyBlacklist.some(function(b) { return b.id === id; });
        if (exists) {
            log('Blacklist: ' + companyName + ' already blacklisted');
            return;
        }
        settings.buyBlacklist.push({ id: id, name: companyName });
        await saveSettings();
        log('Blacklist: Added ' + companyName + ' (#' + id + ')');
    }

    async function removeFromBlacklist(id) {
        if (!settings.buyBlacklist) settings.buyBlacklist = [];
        var entry = settings.buyBlacklist.find(function(b) { return b.id === id; });
        settings.buyBlacklist = settings.buyBlacklist.filter(function(b) { return b.id !== id; });
        await saveSettings();
        log('Blacklist: Removed ' + (entry ? entry.name : '#' + id));
    }

    async function loadCachedData() {
        var data = await dbGet('cachedData');
        if (data) {
            cachedData = Object.assign({
                freshIpos: [],
                seenIpoIds: [],
                lastUpdate: 0
            }, data);
            log('Loaded cached data: ' + cachedData.freshIpos.length + ' IPOs, ' + cachedData.seenIpoIds.length + ' seen, last update: ' + formatLastUpdate(cachedData.lastUpdate));
        }
    }

    async function saveCachedData() {
        await dbSet('cachedData', cachedData);
    }

    function formatLastUpdate(timestamp) {
        if (!timestamp) return 'never';
        var ageMs = Date.now() - timestamp;
        var minutes = Math.floor(ageMs / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return minutes + ' min ago';
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm ago';
        var days = Math.floor(hours / 24);
        return days + 'd ago';
    }

    // ============================================
    // API FUNCTIONS
    // ============================================
    async function apiPost(endpoint, body) {
        try {
            var response = await fetch(API_BASE + endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                log('API error: ' + response.status);
                return null;
            }
            return await response.json();
        } catch (e) {
            log('API error: ' + e);
            return null;
        }
    }

    async function getRecentIpos() {
        var result = await apiPost('/stock/get-market', {
            filter: 'recent-ipo',
            page: 1,
            limit: 40,
            search_by: ''
        });

        // Validate API response structure
        if (result && result.data && Array.isArray(result.data.market)) {
            result.data.market = result.data.market.filter(function(ipo) {
                return ipo &&
                       typeof ipo.id === 'number' &&
                       typeof ipo.company_name === 'string' &&
                       typeof ipo.stock === 'number';
            });
        }

        return result;
    }

    async function getCompanyAge(userId) {
        var result = await apiPost('/user/get-company', { user_id: userId });
        if (result && result.data && result.data.company && result.data.company.created_at) {
            var createdAt = new Date(result.data.company.created_at).getTime();
            if (isNaN(createdAt)) return null;

            var ageMs = Date.now() - createdAt;
            var ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
            var stockForSale = result.data.company.stock_for_sale;

            // Validate types
            if (typeof stockForSale !== 'number') {
                stockForSale = parseInt(stockForSale, 10) || 0;
            }

            return {
                createdAt: result.data.company.created_at,
                ageDays: ageDays,
                stockForSale: stockForSale
            };
        }
        return null;
    }

    async function getFinanceOverview() {
        var userId = getUserId();
        if (!userId) return null;
        var result = await apiPost('/stock/get-finance-overview', { user_id: userId });

        // Validate investments structure
        if (result && result.data && result.data.investments) {
            var validatedInvestments = {};
            Object.keys(result.data.investments).forEach(function(key) {
                var inv = result.data.investments[key];
                if (inv && typeof inv.id !== 'undefined' && typeof inv.current_value !== 'undefined') {
                    validatedInvestments[key] = inv;
                }
            });
            result.data.investments = validatedInvestments;
        }

        return result;
    }

    async function sellStock(stockUserId, amount) {
        return await apiPost('/stock/sell-stock', {
            stock_user_id: stockUserId,
            amount: amount
        });
    }

    async function purchaseStock(stockIssuerUserId, amount) {
        return await apiPost('/stock/purchase-stock', {
            stock_issuer_user_id: stockIssuerUserId,
            amount: amount
        });
    }

    async function getUserCash() {
        var userStore = getStore('user');
        if (userStore && userStore.user && userStore.user.cash !== undefined) {
            return userStore.user.cash;
        }
        return null;
    }

    // ============================================
    // AUTO-BUY LOGIC
    // ============================================
    async function runAutoBuy() {
        if (!settings.autoBuyEnabled) return;

        var currentCash = await getUserCash();
        if (currentCash === null) {
            log('Auto-Buy: Could not get cash balance');
            return;
        }

        var availableCash = currentCash - settings.minCashReserve;
        if (availableCash <= 0) {
            return;
        }

        var freshIpos = cachedData.freshIpos;
        if (!freshIpos || freshIpos.length === 0) {
            return;
        }

        for (var i = 0; i < freshIpos.length; i++) {
            var ipo = freshIpos[i];

            if (purchasedIpoIds.has(ipo.id)) continue;
            if (settings.buyBlacklist && settings.buyBlacklist.some(function(b) { return b.id === ipo.id; })) {
                log('Auto-Buy: Skipping blacklisted: ' + ipo.company_name);
                continue;
            }
            if (ipo.stock > settings.maxStockPrice) continue;
            if (!ipo.stock_for_sale || ipo.stock_for_sale <= 0) continue;

            availableCash = currentCash - settings.minCashReserve;
            if (availableCash <= 0) break;

            var sharesToBuy = Math.min(ipo.stock_for_sale, Math.floor(availableCash / ipo.stock));
            if (sharesToBuy <= 0) continue;

            var totalCost = sharesToBuy * ipo.stock;

            log('Auto-Buy: Purchasing ' + sharesToBuy + ' shares of ' + ipo.company_name + ' @ $' + ipo.stock);

            var result = await purchaseStock(ipo.id, sharesToBuy);
            if (result && result.data && !result.error) {
                purchasedIpoIds.add(ipo.id);
                log('Auto-Buy: SUCCESS - Bought ' + sharesToBuy + ' shares of ' + ipo.company_name);

                // Only re-fetch cash after successful purchase
                currentCash = await getUserCash();
                if (currentCash === null) break;

                var buyMsg = 'Bought ' + formatNumber(sharesToBuy) + ' shares of ' + ipo.company_name + ' for ' + formatMoney(totalCost);
                if (settings.inAppAlerts) {
                    showToast(buyMsg, 'success');
                }
                sendSystemNotification('Auto Stock - Purchase', buyMsg);
            } else {
                var errMsg = (result && result.error ? result.error : (result && result.message ? result.message : 'Unknown error'));
                log('Auto-Buy: FAILED - ' + errMsg);
                var failMsg = 'Failed to buy ' + ipo.company_name + ': ' + errMsg;
                if (settings.inAppAlerts) {
                    showToast(failMsg, 'error');
                }
                sendSystemNotification('Auto Stock - Purchase Failed', failMsg);
            }
        }
    }

    // ============================================
    // AUTO-SELL LOGIC
    // ============================================
    async function runAutoSell() {
        if (!settings.autoSellEnabled) return;

        var financeData = await getFinanceOverview();
        if (!financeData || !financeData.data || !financeData.data.investments) {
            log('Auto-Sell: Could not get investments');
            return;
        }

        var investments = financeData.data.investments;
        var investmentList = Object.entries(investments).map(function(entry) {
            return { company_name: entry[0], ...entry[1] };
        });

        if (investmentList.length === 0) {
            log('Auto-Sell: No investments');
            return;
        }

        log('Auto-Sell: Checking ' + investmentList.length + ' investments...');

        for (var i = 0; i < investmentList.length; i++) {
            var inv = investmentList[i];
            var currentValue = parseFloat(inv.current_value);
            var boughtAt = parseFloat(inv.bought_at);
            var availableToSell = parseInt(inv.available_to_sell, 10);

            if (!availableToSell || availableToSell <= 0) continue;

            var dropPercent = 0;
            if (boughtAt > 0) {
                dropPercent = ((boughtAt - currentValue) / boughtAt) * 100;
            }

            var shouldSell = false;
            var sellReason = '';

            if (dropPercent >= settings.autoSellDropPercent) {
                shouldSell = true;
                sellReason = 'dropped ' + dropPercent.toFixed(1) + '%';
            }

            if (!shouldSell) continue;

            log('Auto-Sell: Selling ' + availableToSell + ' shares of ' + inv.company_name + ' - ' + sellReason);

            var result = await sellStock(inv.id, availableToSell);
            if (result && result.data && result.data.success) {
                var revenue = availableToSell * currentValue;
                log('Auto-Sell: SUCCESS - Sold ' + availableToSell + ' shares of ' + inv.company_name);
                var sellMsg = 'Sold ' + formatNumber(availableToSell) + ' shares of ' + inv.company_name + ' for ' + formatMoney(revenue) + ' (' + sellReason + ')';

                if (settings.inAppAlerts) {
                    showToast(sellMsg, 'warning');
                }
                sendSystemNotification('Auto Stock - Sold', sellMsg);
            } else {
                var errMsg = result && result.error ? result.error : 'Unknown error';
                if (errMsg === 'stock_is_locked') {
                    log('Auto-Sell: ' + inv.company_name + ' is still locked (48h)');
                } else {
                    log('Auto-Sell: FAILED - ' + errMsg);
                }
            }
        }
    }

    // ============================================
    // FRESH IPO FETCHING & CACHING
    // ============================================
    var refreshIpoCachePromise = null;

    async function refreshIpoCache() {
        // Deduplicate concurrent calls
        if (refreshIpoCachePromise) {
            return refreshIpoCachePromise;
        }

        refreshIpoCachePromise = (async function() {
            var result = await getRecentIpos();
        if (!result || !result.data || !result.data.market) {
            log('Failed to fetch market data');
            return false;
        }

        var allIpos = result.data.market.sort(function(a, b) { return b.id - a.id; });
        var topIpos = allIpos.slice(0, settings.ipoCheckLimit);
        var freshIpos = [];
        var newIpos = [];

        for (var i = 0; i < topIpos.length; i++) {
            var ipo = topIpos[i];
            var ageInfo = await getCompanyAge(ipo.id);

            if (ageInfo && ageInfo.ageDays <= settings.ipoMaxAgeDays && ageInfo.stockForSale > 0) {
                var ipoData = {
                    id: ipo.id,
                    company_name: ipo.company_name,
                    stock: ipo.stock,
                    stock_trend: ipo.stock_trend,
                    stock_for_sale: ageInfo.stockForSale,
                    age_days: ageInfo.ageDays,
                    created_at: ageInfo.createdAt
                };
                freshIpos.push(ipoData);

                // Track new IPOs (not seen before)
                if (cachedData.seenIpoIds.indexOf(ipo.id) === -1) {
                    cachedData.seenIpoIds.push(ipo.id);
                    newIpos.push(ipoData);
                }
            }
        }

        // Update cache
        cachedData.freshIpos = freshIpos;
        cachedData.lastUpdate = Date.now();
        await saveCachedData();

        // Notify about new IPOs
        if (newIpos.length > 0) {
            log('IPO cache: ' + freshIpos.length + ' fresh, ' + newIpos.length + ' new');
            var ipoNames = newIpos.map(function(item) { return escapeHtml(item.company_name); }).join(', ');
            var alertMsg = newIpos.length + ' new IPO' + (newIpos.length > 1 ? 's' : '') + ': ' + ipoNames;

            if (settings.inAppAlerts) {
                showToast(alertMsg, 'success');
            }
            sendSystemNotification('IPO Alert', alertMsg);
        }

        // Auto-buy immediately with fresh data — don't wait for separate timer
        if (settings.autoBuyEnabled && freshIpos.length > 0) {
            log('Running Auto-Buy immediately after IPO refresh...');
            await runAutoBuy();
        }

        return true;
        })();

        try {
            return await refreshIpoCachePromise;
        } finally {
            refreshIpoCachePromise = null;
        }
    }

    function getCachedFreshIpos() {
        return cachedData.freshIpos;
    }

    // ============================================
    // UI HELPERS
    // ============================================
    function formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toFixed(2);
    }

    function formatMoney(num) {
        return '$' + formatNumber(num);
    }

    function getTrendIcon(trend) {
        // Validate trend value to prevent potential injection
        if (trend !== 'up' && trend !== 'down') {
            return '<span style="color:#94a3b8;">&#9644;</span>';
        }
        if (trend === 'up') return '<span style="color:#22c55e;">&#9650;</span>';
        if (trend === 'down') return '<span style="color:#ef4444;">&#9660;</span>';
        return '<span style="color:#94a3b8;">&#9644;</span>';
    }

    function formatTimeRemaining(timestampSec) {
        var now = Math.floor(Date.now() / 1000);
        var remaining = timestampSec - now;

        if (remaining <= 0) return 'Now';

        var hours = Math.floor(remaining / 3600);
        var minutes = Math.floor((remaining % 3600) / 60);

        if (hours > 0) return hours + 'h ' + minutes + 'm';
        return minutes + 'm';
    }

    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ============================================
    // GAME-STYLE MODAL (1:1 from auto-repair)
    // ============================================
    function injectModalStyles() {
        if (document.getElementById('autostock-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'autostock-modal-styles';
        style.textContent = [
            '@keyframes autostock-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes autostock-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes autostock-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes autostock-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#autostock-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#autostock-modal-wrapper #autostock-modal-background{animation:autostock-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#autostock-modal-wrapper.hide #autostock-modal-background{animation:autostock-fade-out .15s linear forwards}',
            '#autostock-modal-wrapper #autostock-modal-content-wrapper{animation:autostock-drop-down .15s linear forwards,autostock-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#autostock-modal-wrapper.hide #autostock-modal-content-wrapper{animation:autostock-push-up .15s linear forwards,autostock-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#autostock-modal-wrapper #autostock-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#autostock-modal-wrapper #autostock-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#autostock-modal-wrapper #autostock-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#autostock-modal-wrapper #autostock-modal-content-wrapper{max-width:100%}}',
            '#autostock-modal-wrapper #autostock-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#autostock-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#autostock-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#autostock-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#autostock-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#autostock-modal-container #autostock-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#autostock-modal-container #autostock-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#autostock-modal-wrapper.hide{pointer-events:none}',
            '.as-input{width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box}',
            '.as-section{margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #ddd}',
            '.as-label-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;cursor:pointer}',
            '.as-checkbox{width:20px;height:20px;cursor:pointer;accent-color:#129c00}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeModal() {
        if (!isModalOpen) return;
        log('Closing modal');
        isModalOpen = false;
        removeSettingsEventListeners();
        var modalWrapper = document.getElementById('autostock-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }

    function setupModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        window.addEventListener('rebelship-menu-click', function() {
            if (isModalOpen) {
                log('RebelShip menu clicked, closing modal');
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

        var existing = document.getElementById('autostock-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#autostock-settings-content');
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
        modalWrapper.id = 'autostock-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'autostock-modal-background';
        modalBackground.onclick = function() { closeModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'autostock-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'autostock-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto Stock Settings';

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
        modalContent.id = 'autostock-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'autostock-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'autostock-settings-content';
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

    var settingsEventListeners = [];

    function updateSettingsContent() {
        var settingsContent = document.getElementById('autostock-settings-content');
        if (!settingsContent) return;

        settingsContent.innerHTML = '\
            <div style="padding:20px;max-width:420px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div class="as-section">\
                    <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:#01125d;">Autopilot - The Purser</div>\
                    <div style="font-size:12px;color:#626b90;margin-bottom:16px;">Automatically buy stocks from fresh IPOs matching your threshold. Checks every 5 minutes.</div>\
                    <label class="as-label-row">\
                        <input type="checkbox" id="as-autobuy-enabled" ' + (settings.autoBuyEnabled ? 'checked' : '') + ' class="as-checkbox">\
                        <span style="font-size:14px;">Enable Auto-Buy</span>\
                    </label>\
                    <div style="margin-bottom:16px;">\
                        <label style="display:block;margin-bottom:6px;font-size:13px;">Min Cash Reserve ($)</label>\
                        <input type="text" id="as-min-cash" inputmode="numeric" value="' + formatNumberWithSeparator(settings.minCashReserve) + '" class="as-input">\
                    </div>\
                    <div style="margin-bottom:16px;">\
                        <label style="display:block;margin-bottom:6px;font-size:13px;">Max Stock Price ($/share)</label>\
                        <input type="text" id="as-max-price" inputmode="numeric" value="' + formatNumberWithSeparator(settings.maxStockPrice) + '" class="as-input">\
                    </div>\
                    <label class="as-label-row">\
                        <input type="checkbox" id="as-autosell-enabled" ' + (settings.autoSellEnabled ? 'checked' : '') + ' class="as-checkbox">\
                        <span style="font-size:14px;">Enable Auto-Sell (sell when stock falls)</span>\
                    </label>\
                    <div style="margin-bottom:16px;">\
                        <label style="display:block;margin-bottom:6px;font-size:13px;">Auto-Sell: Drop Threshold (%)</label>\
                        <input type="number" id="as-drop-percent" min="1" max="100" value="' + settings.autoSellDropPercent + '" class="as-input">\
                        <div style="font-size:11px;color:#626b90;margin-top:4px;">Sell if stock drops X% from purchase price</div>\
                    </div>\
                </div>\
                <div class="as-section">\
                    <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:#01125d;">IPO Alert Settings</div>\
                    <div style="margin-bottom:16px;">\
                        <label style="display:block;margin-bottom:6px;font-size:13px;">IPO Max Age (days)</label>\
                        <input type="number" id="as-max-age" min="1" max="365" value="' + settings.ipoMaxAgeDays + '" class="as-input">\
                        <div style="font-size:11px;color:#626b90;margin-top:4px;">Show IPOs from accounts younger than X days</div>\
                    </div>\
                    <div style="margin-bottom:16px;">\
                        <label style="display:block;margin-bottom:6px;font-size:13px;">IPO Check Limit</label>\
                        <input type="number" id="as-check-limit" min="5" max="40" value="' + settings.ipoCheckLimit + '" class="as-input">\
                        <div style="font-size:11px;color:#626b90;margin-top:4px;">How many recent IPOs to check</div>\
                    </div>\
                </div>\
                <div class="as-section">\
                    <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <label class="as-label-row">\
                        <input type="checkbox" id="as-inapp-alerts" ' + (settings.inAppAlerts ? 'checked' : '') + ' class="as-checkbox">\
                        <span style="font-size:14px;">Enable in-app alerts</span>\
                    </label>\
                    <label class="as-label-row">\
                        <input type="checkbox" id="as-desktop-notif" ' + (settings.desktopNotifications ? 'checked' : '') + ' class="as-checkbox">\
                        <span style="font-size:14px;">Enable desktop notifications</span>\
                    </label>\
                </div>\
                <div class="as-section">\
                    <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:#01125d;">Buy Blacklist</div>\
                    <div style="font-size:12px;color:#626b90;margin-bottom:16px;">Companies that Auto-Buy will never purchase</div>\
                    <div id="as-blacklist-items">' + (function() {
                        var bl = settings.buyBlacklist;
                        if (!bl || bl.length === 0) return '<div style="color:#94a3b8;font-size:13px;">Empty</div>';
                        var items = '';
                        bl.forEach(function(entry) {
                            items += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;margin-bottom:4px;background:#fff;border-radius:4px;font-size:13px;">';
                            items += '<span>' + escapeHtml(entry.name) + ' <span style="color:#94a3b8;font-size:11px;">(#' + entry.id + ')</span></span>';
                            items += '<button class="as-bl-remove" data-id="' + entry.id + '" style="padding:2px 8px;background:#ef4444;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:11px;font-family:Lato,sans-serif;">X</button>';
                            items += '</div>';
                        });
                        return items;
                    })() + '</div>\
                </div>\
                <div style="margin-bottom:16px;">\
                    <div style="font-size:14px;color:#01125d;margin-bottom:8px;">Seen IPOs: ' + cachedData.seenIpoIds.length + ' tracked</div>\
                    <button id="as-clear-seen" style="padding:6px 12px;background:#ef4444;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:12px;font-family:Lato,sans-serif;">\
                        Clear Seen\
                    </button>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:24px;">\
                    <button id="as-cancel" style="padding:10px 24px;background:linear-gradient(90deg,#d7d8db,#95969b);border:0;border-radius:6px;color:#393939;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">\
                        Cancel\
                    </button>\
                    <button id="as-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">\
                        Save\
                    </button>\
                </div>\
            </div>';

        var minCashEl = document.getElementById('as-min-cash');
        if (minCashEl) setupThousandSeparator(minCashEl);
        var maxPriceEl = document.getElementById('as-max-price');
        if (maxPriceEl) setupThousandSeparator(maxPriceEl);

        var cancelHandler = function() {
            closeModal();
        };
        var clearSeenHandler = async function() {
            cachedData.seenIpoIds = [];
            await saveCachedData();
            this.textContent = 'Cleared!';
            this.style.background = '#22c55e';
        };
        var saveHandler = async function() {
            var maxAge = parseInt(document.getElementById('as-max-age').value, 10);
            var checkLimit = parseInt(document.getElementById('as-check-limit').value, 10);
            var minCash = getNumericValue(document.getElementById('as-min-cash'));
            var maxPrice = getNumericValue(document.getElementById('as-max-price'));

            if (isNaN(maxAge) || maxAge < 1 || maxAge > 365) {
                showToast('IPO Max Age must be between 1 and 365', 'error');
                return;
            }
            if (isNaN(checkLimit) || checkLimit < 5 || checkLimit > 40) {
                showToast('IPO Check Limit must be between 5 and 40', 'error');
                return;
            }
            if (isNaN(minCash) || minCash < 0) {
                showToast('Min Cash Reserve must be 0 or higher', 'error');
                return;
            }
            if (isNaN(maxPrice) || maxPrice < 1) {
                showToast('Max Stock Price must be at least 1', 'error');
                return;
            }

            var dropPercent = parseInt(document.getElementById('as-drop-percent').value, 10);
            if (isNaN(dropPercent) || dropPercent < 1 || dropPercent > 100) {
                showToast('Drop Threshold must be between 1 and 100', 'error');
                return;
            }

            settings.ipoMaxAgeDays = maxAge;
            settings.ipoCheckLimit = checkLimit;
            settings.minCashReserve = minCash;
            settings.maxStockPrice = maxPrice;
            settings.autoSellDropPercent = dropPercent;
            settings.autoBuyEnabled = document.getElementById('as-autobuy-enabled').checked;
            settings.autoSellEnabled = document.getElementById('as-autosell-enabled').checked;
            settings.inAppAlerts = document.getElementById('as-inapp-alerts').checked;
            settings.desktopNotifications = document.getElementById('as-desktop-notif').checked;

            await saveSettings();
            showToast('Settings saved!', 'success');
            closeModal();
        };

        var blacklistRemoveHandler = function(e) {
            var btn = e.target;
            if (!btn.classList.contains('as-bl-remove')) return;
            var id = parseInt(btn.getAttribute('data-id'));
            removeFromBlacklist(id).then(function() {
                showToast('Removed from blacklist', 'success');
                updateSettingsContent();
            });
        };

        var blacklistContainer = document.getElementById('as-blacklist-items');
        if (blacklistContainer) {
            blacklistContainer.addEventListener('click', blacklistRemoveHandler);
            settingsEventListeners.push(
                { element: 'as-blacklist-items', handler: blacklistRemoveHandler, type: 'click' }
            );
        }

        document.getElementById('as-cancel').addEventListener('click', cancelHandler);
        document.getElementById('as-clear-seen').addEventListener('click', clearSeenHandler);
        document.getElementById('as-save').addEventListener('click', saveHandler);

        settingsEventListeners.push(
            { element: 'as-cancel', handler: cancelHandler, type: 'click' },
            { element: 'as-clear-seen', handler: clearSeenHandler, type: 'click' },
            { element: 'as-save', handler: saveHandler, type: 'click' }
        );
    }

    function removeSettingsEventListeners() {
        settingsEventListeners.forEach(function(item) {
            var el = document.getElementById(item.element);
            if (el) {
                el.removeEventListener(item.type, item.handler);
            }
        });
        settingsEventListeners = [];
    }

    // ============================================
    // TAB INJECTION
    // ============================================
    function injectTabs() {
        if (tabsInjected) return;

        var bottomNav = document.getElementById('bottom-nav');
        var stockBtn = document.getElementById('stock-page-btn');

        if (!bottomNav || !stockBtn) return;
        if (!hasUserIPO()) return;

        // IPO Alerts Tab (before Stocks)
        var ipoBtn = document.createElement('div');
        ipoBtn.id = 'ipo-alerts-page-btn';
        ipoBtn.className = 'flex-centered flex-vertical';
        ipoBtn.style.cssText = 'cursor:pointer;';
        ipoBtn.innerHTML = '<img src="images/icons/stock_chart_icon.svg" alt="IPO Alerts" style="width:26px;height:26px;filter:brightness(0) invert(1);"><span class="modal-bottom-navigation-btn" style="font-size:12px;">IPO Alerts</span>';
        ipoBtn.addEventListener('click', function() { openTab('ipo-alerts'); });
        bottomNav.insertBefore(ipoBtn, stockBtn);

        // Investments Tab (after Stocks)
        var investBtn = document.createElement('div');
        investBtn.id = 'investments-page-btn';
        investBtn.className = 'flex-centered flex-vertical';
        investBtn.style.cssText = 'cursor:pointer;';
        investBtn.innerHTML = '<img src="images/icons/stock_chart_icon.svg" alt="Investments" style="width:26px;height:26px;filter:brightness(0) invert(1);"><span class="modal-bottom-navigation-btn" style="font-size:12px;">Investments</span>';
        investBtn.addEventListener('click', function() { openTab('investments'); });
        bottomNav.insertBefore(investBtn, stockBtn.nextSibling);

        // Click handlers for original tabs to close our content
        var originalTabs = bottomNav.querySelectorAll('#stock-page-btn, #marketing-page-btn, #history-page-btn');
        originalTabs.forEach(function(tab) {
            tab.addEventListener('click', function() {
                closeCustomContent();
                updateTabStyles(null);
            });
        });

        tabsInjected = true;
    }

    function removeTabs() {
        var ipoBtn = document.getElementById('ipo-alerts-page-btn');
        var investBtn = document.getElementById('investments-page-btn');
        if (ipoBtn) ipoBtn.remove();
        if (investBtn) investBtn.remove();
        tabsInjected = false;
    }

    function updateTabStyles(activeTabId) {
        var allTabs = document.querySelectorAll('#bottom-nav > div');
        allTabs.forEach(function(tab) {
            tab.classList.remove('selected-page');
        });

        if (activeTabId) {
            var activeEl = document.getElementById(activeTabId);
            if (activeEl) {
                activeEl.classList.add('selected-page');
            }
        }
    }

    // ============================================
    // CONTENT RENDERING
    // ============================================
    function getContentContainer() {
        return document.getElementById('central-container');
    }

    function hideOriginalContent() {
        var container = getContentContainer();
        if (!container) return;

        var children = container.children;
        for (var i = 0; i < children.length; i++) {
            if (children[i].id !== 'autostock-tabs-content') {
                children[i].style.display = 'none';
            }
        }
    }

    function showOriginalContent() {
        var container = getContentContainer();
        if (!container) return;

        var children = container.children;
        for (var i = 0; i < children.length; i++) {
            if (children[i].id !== 'autostock-tabs-content') {
                children[i].style.display = '';
            }
        }
    }

    function closeCustomContent() {
        stopSellTimers();
        removeTabEventListeners();
        var customContent = document.getElementById('autostock-tabs-content');
        if (customContent) customContent.remove();
        showOriginalContent();
    }

    async function openTab(tabName) {
        hideOriginalContent();
        updateTabStyles(tabName === 'ipo-alerts' ? 'ipo-alerts-page-btn' : 'investments-page-btn');

        var container = getContentContainer();
        if (!container) return;

        var existing = document.getElementById('autostock-tabs-content');
        if (existing) existing.remove();

        var content = document.createElement('div');
        content.id = 'autostock-tabs-content';
        content.style.cssText = 'padding:10px;height:100%;overflow-y:auto;';
        content.innerHTML = '<div style="text-align:center;padding:40px;color:#626b90;">Loading...</div>';
        container.appendChild(content);

        if (tabName === 'ipo-alerts') {
            await renderIpoAlertsTab(content);
        } else if (tabName === 'investments') {
            await renderInvestmentsTab(content);
        }
    }

    // ============================================
    // IPO ALERTS TAB
    // ============================================
    async function renderIpoAlertsTab(content) {
        var freshIpos = getCachedFreshIpos();
        var lastUpdate = cachedData.lastUpdate;

        // Header with last update info
        var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
        html += '<div style="color:#626b90;font-size:12px;">Fresh IPOs - accounts younger than ' + settings.ipoMaxAgeDays + ' days</div>';
        html += '<div style="display:flex;align-items:center;gap:10px;">';
        html += '<span id="as-last-update" style="color:#626b90;font-size:11px;">Updated: ' + formatLastUpdate(lastUpdate) + '</span>';
        html += '<button id="as-refresh-ipos" style="padding:4px 12px;background:linear-gradient(180deg,#0db8f4,#0284c7);border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-family:Lato,sans-serif;">Refresh</button>';
        html += '</div></div>';

        if (freshIpos.length === 0) {
            html += '<div style="text-align:center;padding:40px;color:#626b90;">No fresh IPOs found</div>';
            content.innerHTML = html;
            attachRefreshHandler(content);
            return;
        }

        html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
        html += '<thead><tr style="background:#626b90;color:#fff;">';
        html += '<th style="padding:8px;text-align:left;">Company</th>';
        html += '<th style="padding:8px;text-align:right;">Price</th>';
        html += '<th style="padding:8px;text-align:center;">Age</th>';
        html += '<th style="padding:8px;text-align:center;">Buy</th>';
        html += '<th style="padding:8px;text-align:center;width:30px;"></th>';
        html += '</tr></thead><tbody>';

        freshIpos.forEach(function(ipo, idx) {
            var bgColor = idx % 2 === 0 ? '#e9effd' : '#fff';
            var isBlacklisted = settings.buyBlacklist && settings.buyBlacklist.some(function(b) { return b.id === ipo.id; });
            html += '<tr style="background:' + bgColor + ';">';
            html += '<td style="padding:8px;"><a href="#" class="as-open-profile" data-user-id="' + ipo.id + '" style="color:#0284c7;text-decoration:none;">' + escapeHtml(ipo.company_name) + '</a> <span style="color:#94a3b8;font-size:11px;">(#' + ipo.id + ')</span></td>';
            html += '<td style="padding:8px;text-align:right;">' + formatMoney(ipo.stock) + ' ' + getTrendIcon(ipo.stock_trend) + '</td>';
            html += '<td style="padding:8px;text-align:center;">' + ipo.age_days + 'd</td>';
            html += '<td style="padding:8px;text-align:center;">';
            html += '<input type="number" class="as-buy-amount" data-id="' + ipo.id + '" value="' + ipo.stock_for_sale + '" min="1" max="' + ipo.stock_for_sale + '" style="width:60px;padding:2px 4px;border:1px solid #ccc;border-radius:4px;text-align:center;font-size:12px;">';
            html += '<button class="as-buy-btn" data-id="' + ipo.id + '" style="margin-left:4px;padding:4px 8px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">Buy</button>';
            html += '</td>';
            if (isBlacklisted) {
                html += '<td style="padding:8px;text-align:center;"><span style="color:#ef4444;font-size:11px;" title="Blacklisted">BL</span></td>';
            } else {
                html += '<td style="padding:8px;text-align:center;"><button class="as-block-btn" data-id="' + ipo.id + '" data-name="' + escapeHtml(ipo.company_name) + '" style="padding:2px 6px;background:#ef4444;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;" title="Block from Auto-Buy">X</button></td>';
            }
            html += '</tr>';
        });

        html += '</tbody></table>';
        content.innerHTML = html;
        attachRefreshHandler(content);
        attachBuyHandlers(content);
        attachBlockHandlers(content, 'ipo-alerts');
        attachProfileHandlers(content);
    }

    var tabEventListeners = [];

    function attachBuyHandlers(content) {
        var buyHandler = function(e) {
            var btn = e.target;
            if (!btn.classList.contains('as-buy-btn')) return;

            var userId = parseInt(btn.getAttribute('data-id'));
            var input = content.querySelector('.as-buy-amount[data-id="' + userId + '"]');
            var amount = parseInt(input.value);

            if (isNaN(amount) || amount <= 0) {
                showToast('Invalid amount', 'error');
                return;
            }

            var freshIpos = getCachedFreshIpos();
            var ipo = freshIpos.find(function(i) { return i.id === userId; });
            if (!ipo) {
                showToast('IPO not found', 'error');
                return;
            }

            openPurchaseDialog(ipo, amount);
        };

        content.addEventListener('click', buyHandler);
        tabEventListeners.push({ element: content, handler: buyHandler, type: 'click' });
    }

    function attachBlockHandlers(content, tabName) {
        var blockHandler = function(e) {
            var btn = e.target;
            if (!btn.classList.contains('as-block-btn')) return;

            var id = parseInt(btn.getAttribute('data-id'));
            var name = btn.getAttribute('data-name');

            addToBlacklist(id, name).then(function() {
                showToast('Blocked ' + name + ' from Auto-Buy', 'warning');
                openTab(tabName);
            });
        };

        content.addEventListener('click', blockHandler);
        tabEventListeners.push({ element: content, handler: blockHandler, type: 'click' });
    }

    function openPurchaseDialog(ipo, amount) {
        var existing = document.getElementById('as-purchase-dialog');
        if (existing) existing.remove();

        var totalCost = amount * ipo.stock;

        var overlay = document.createElement('div');
        overlay.id = 'as-purchase-dialog';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';

        var dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff;border-radius:12px;width:320px;max-width:90vw;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.3);font-family:Lato,sans-serif;';

        var header = document.createElement('div');
        header.style.cssText = 'background:#626b90;color:#fff;padding:16px 20px;font-size:16px;font-weight:700;text-transform:uppercase;';
        header.textContent = 'Purchase Stock';

        var body = document.createElement('div');
        body.style.cssText = 'padding:20px;';

        var companyRow = document.createElement('div');
        companyRow.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;';
        companyRow.innerHTML = '<span style="color:#626b90;">Company</span><span style="color:#01125d;font-weight:700;">' + escapeHtml(ipo.company_name) + '</span>';

        var priceRow = document.createElement('div');
        priceRow.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;';
        priceRow.innerHTML = '<span style="color:#626b90;">Price per Share</span><span style="color:#01125d;font-weight:700;">' + formatMoney(ipo.stock) + '</span>';

        var sharesRow = document.createElement('div');
        sharesRow.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;';
        sharesRow.innerHTML = '<span style="color:#626b90;">Shares</span><span style="color:#01125d;font-weight:700;">' + formatNumber(amount) + '</span>';

        var divider = document.createElement('div');
        divider.style.cssText = 'border-top:1px solid #e5e7eb;margin:16px 0;';

        var totalRow = document.createElement('div');
        totalRow.style.cssText = 'display:flex;justify-content:space-between;font-size:16px;';
        totalRow.innerHTML = '<span style="color:#01125d;font-weight:700;">Total Cost</span><span style="color:#ef4444;font-weight:700;">' + formatMoney(totalCost) + '</span>';

        body.appendChild(companyRow);
        body.appendChild(priceRow);
        body.appendChild(sharesRow);
        body.appendChild(divider);
        body.appendChild(totalRow);

        var footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:12px;padding:0 20px 20px;';

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'flex:1;padding:12px;background:linear-gradient(90deg,#d7d8db,#95969b);border:0;border-radius:6px;color:#393939;cursor:pointer;font-size:14px;font-weight:600;font-family:Lato,sans-serif;';
        cancelBtn.onclick = function() { overlay.remove(); };

        var confirmBtn = document.createElement('button');
        confirmBtn.id = 'as-confirm-purchase';
        confirmBtn.textContent = 'Buy Now';
        confirmBtn.style.cssText = 'flex:1;padding:12px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:600;font-family:Lato,sans-serif;';
        confirmBtn.onclick = async function() {
            confirmBtn.textContent = 'Purchasing...';
            confirmBtn.disabled = true;
            cancelBtn.disabled = true;

            var result = await purchaseStock(ipo.id, amount);
            if (result && result.data && !result.error) {
                overlay.remove();
                showToast('Purchased ' + formatNumber(amount) + ' shares of ' + ipo.company_name + ' for ' + formatMoney(totalCost), 'success');
                sendSystemNotification('Stock Purchased', formatNumber(amount) + ' shares of ' + ipo.company_name);
                setTimeout(function() { openTab('ipo-alerts'); }, 1000);
            } else {
                var errMsg = result && result.error ? result.error : (result && result.message ? result.message : 'Unknown error');
                confirmBtn.textContent = 'Failed!';
                confirmBtn.style.background = '#ef4444';
                showToast('Purchase failed: ' + errMsg, 'error');
                sendSystemNotification('Stock Purchase Failed', ipo.company_name + ': ' + errMsg);
                setTimeout(function() {
                    confirmBtn.textContent = 'Buy Now';
                    confirmBtn.style.background = 'linear-gradient(180deg,#46ff33,#129c00)';
                    confirmBtn.disabled = false;
                    cancelBtn.disabled = false;
                }, 2000);
            }
        };

        footer.appendChild(cancelBtn);
        footer.appendChild(confirmBtn);

        dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(footer);
        overlay.appendChild(dialog);

        overlay.onclick = function(e) {
            if (e.target === overlay) overlay.remove();
        };

        document.body.appendChild(overlay);
    }

    function attachProfileHandlers(content) {
        var profileHandler = function(e) {
            var link = e.target;
            if (!link.classList.contains('as-open-profile')) return;

            e.preventDefault();
            var userId = parseInt(link.getAttribute('data-user-id'));
            var modalStore = getModalStore();
            if (modalStore && modalStore.open) {
                modalStore.open('user', { user_id: userId });
            } else {
                log('Could not open profile modal');
            }
        };

        content.addEventListener('click', profileHandler);
        tabEventListeners.push({ element: content, handler: profileHandler, type: 'click' });
    }

    function removeTabEventListeners() {
        tabEventListeners.forEach(function(item) {
            if (item.element) {
                item.element.removeEventListener(item.type, item.handler);
            }
        });
        tabEventListeners = [];
    }

    function attachRefreshHandler(content) {
        var refreshBtn = document.getElementById('as-refresh-ipos');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async function() {
                refreshBtn.textContent = '...';
                refreshBtn.disabled = true;
                await refreshIpoCache();
                refreshBtn.textContent = 'Refresh';
                refreshBtn.disabled = false;
                var lastUpdateEl = document.getElementById('as-last-update');
                if (lastUpdateEl) {
                    lastUpdateEl.textContent = 'Updated: ' + formatLastUpdate(cachedData.lastUpdate);
                }
                renderIpoAlertsTab(content);
            });
        }
    }

    // ============================================
    // INVESTMENTS TAB
    // ============================================
    async function renderInvestmentsTab(content) {
        var data = await getFinanceOverview();

        if (!data || !data.data) {
            content.innerHTML = '<div style="text-align:center;padding:40px;color:#ef4444;">Failed to load investments</div>';
            return;
        }

        var investmentsObj = data.data.investments ?? {};
        var investments = Object.entries(investmentsObj).map(function(entry) {
            return { company_name: entry[0], ...entry[1] };
        });

        if (investments.length === 0) {
            content.innerHTML = '<div style="text-align:center;padding:40px;color:#626b90;">No investments yet</div>';
            return;
        }

        var totalInvested = investments.reduce(function(sum, inv) { return sum + parseFloat(inv.invested || 0); }, 0);
        var totalReturn = investments.reduce(function(sum, inv) { return sum + parseFloat(inv.return || 0); }, 0);
        var returnColor = totalReturn >= 0 ? '#22c55e' : '#ef4444';

        var html = '<div style="margin-bottom:15px;padding:10px;background:#fff;border-radius:4px;display:flex;justify-content:center;gap:20px;font-size:13px;">';
        html += '<div>Invested: <strong style="color:#ef4444;">-' + formatMoney(totalInvested) + '</strong></div>';
        html += '<div>Return: <strong style="color:' + returnColor + ';">' + formatMoney(totalReturn) + '</strong></div>';
        html += '</div>';

        html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
        html += '<thead><tr style="background:#626b90;color:#fff;">';
        html += '<th style="padding:4px 2px;text-align:left;">Company</th>';
        html += '<th style="padding:4px 2px;text-align:right;">Shares</th>';
        html += '<th style="padding:4px 2px;text-align:right;">Bought</th>';
        html += '<th style="padding:4px 2px;text-align:right;white-space:nowrap;">Current</th>';
        html += '<th style="padding:4px 2px;text-align:right;">P/L</th>';
        html += '<th style="padding:4px 2px;text-align:center;">Sell</th>';
        html += '<th style="padding:4px 2px;text-align:center;width:24px;"></th>';
        html += '</tr></thead><tbody>';

        investments.forEach(function(inv, idx) {
            var bgColor = idx % 2 === 0 ? '#e9effd' : '#fff';
            var buyPrice = parseFloat(inv.bought_at || 0);
            var currentPrice = parseFloat(inv.current_value || 0);
            var shares = parseInt(inv.total_shares || 0);
            var pl = (currentPrice - buyPrice) * shares;
            var plColor = pl >= 0 ? '#22c55e' : '#ef4444';
            var plSign = pl >= 0 ? '+' : '';

            var availableToSell = parseInt(inv.available_to_sell, 10);
            if (isNaN(availableToSell)) availableToSell = 0;
            var nextSaleTime = parseInt(inv.next_available_sale_time, 10);
            if (isNaN(nextSaleTime)) nextSaleTime = 0;
            var nowSec = Math.floor(Date.now() / 1000);
            var lockedShares = shares - availableToSell;
            var hasTimer = nextSaleTime > nowSec;

            var sellCell = '';
            if (availableToSell > 0 && hasTimer && lockedShares > 0) {
                sellCell = '<button class="as-sell-btn" data-id="' + inv.id + '" data-amount="' + availableToSell + '" style="padding:2px 6px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;">Sell ' + formatNumber(availableToSell) + '</button>';
                sellCell += ' <span class="as-timer" data-unlock="' + nextSaleTime + '" style="color:#f59e0b;font-size:10px;">+' + formatNumber(lockedShares) + '</span>';
            } else if (availableToSell > 0) {
                sellCell = '<button class="as-sell-btn" data-id="' + inv.id + '" data-amount="' + availableToSell + '" style="padding:2px 6px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;">Sell ' + formatNumber(availableToSell) + '</button>';
            } else if (hasTimer && lockedShares > 0) {
                sellCell = '<span class="as-timer" data-unlock="' + nextSaleTime + '" style="color:#f59e0b;font-size:11px;">' + formatTimeRemaining(nextSaleTime) + '</span>';
            } else if (lockedShares > 0) {
                sellCell = '<span style="color:#f59e0b;font-size:11px;">' + formatNumber(lockedShares) + ' locked</span>';
            } else {
                sellCell = '<span style="color:#94a3b8;">-</span>';
            }

            html += '<tr style="background:' + bgColor + ';">';
            html += '<td style="padding:4px 2px;">' + escapeHtml(inv.company_name) + '</td>';
            html += '<td style="padding:4px 2px;text-align:right;">' + formatNumber(shares) + '</td>';
            html += '<td style="padding:4px 2px;text-align:right;">' + formatMoney(buyPrice) + '</td>';
            html += '<td style="padding:4px 2px;text-align:right;white-space:nowrap;">' + formatMoney(currentPrice) + ' ' + getTrendIcon(inv.stock_trend) + '</td>';
            html += '<td style="padding:4px 2px;text-align:right;color:' + plColor + ';">' + plSign + formatMoney(Math.abs(pl)) + '</td>';
            html += '<td style="padding:4px 2px;text-align:center;">' + sellCell + '</td>';
            var invBlacklisted = settings.buyBlacklist && settings.buyBlacklist.some(function(b) { return b.id === inv.id; });
            if (invBlacklisted) {
                html += '<td style="padding:4px 2px;text-align:center;"><span style="color:#ef4444;font-size:10px;" title="Blacklisted">BL</span></td>';
            } else {
                html += '<td style="padding:4px 2px;text-align:center;"><button class="as-block-btn" data-id="' + inv.id + '" data-name="' + escapeHtml(inv.company_name) + '" style="padding:2px 4px;background:#ef4444;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:9px;" title="Block from Auto-Buy">X</button></td>';
            }
            html += '</tr>';
        });

        html += '</tbody></table>';

        var refreshBtn = '<div style="margin-top:15px;text-align:center;">';
        refreshBtn += '<button id="as-refresh-investments" style="padding:8px 16px;background:linear-gradient(180deg,#0db8f4,#0284c7);border:0;border-radius:4px;color:#fff;cursor:pointer;font-family:Lato,sans-serif;">Refresh</button>';
        refreshBtn += '</div>';

        content.innerHTML = html + refreshBtn;

        var sellHandler = function(e) {
            var btn = e.target;
            if (!btn.classList.contains('as-sell-btn')) return;

            (async function() {
                var id = parseInt(btn.getAttribute('data-id'));
                var amount = parseInt(btn.getAttribute('data-amount'));
                btn.textContent = '...';
                btn.disabled = true;

                var result = await sellStock(id, amount);
                if (result && result.data && result.data.success) {
                    btn.textContent = 'Sold!';
                    btn.style.background = '#22c55e';
                    setTimeout(function() { openTab('investments'); }, 1000);
                } else {
                    btn.textContent = 'Failed';
                    btn.style.background = '#ef4444';
                }
            })();
        };

        var refreshHandler = function() {
            openTab('investments');
        };

        content.addEventListener('click', sellHandler);
        document.getElementById('as-refresh-investments').addEventListener('click', refreshHandler);

        tabEventListeners.push(
            { element: content, handler: sellHandler, type: 'click' },
            { element: document.getElementById('as-refresh-investments'), handler: refreshHandler, type: 'click' }
        );

        attachBlockHandlers(content, 'investments');

        startSellTimers(content);
    }

    var sellTimerInterval = null;

    function startSellTimers(container) {
        stopSellTimers();

        var updateTimers = function() {
            // Check if page is visible using Page Visibility API
            if (document.hidden) return;

            var timers = container.querySelectorAll('.as-timer');
            var now = Math.floor(Date.now() / 1000);

            timers.forEach(function(timer) {
                var unlockTime = parseInt(timer.getAttribute('data-unlock'));
                var remaining = unlockTime - now;

                if (remaining <= 0) {
                    timer.textContent = 'Ready!';
                    timer.style.color = '#22c55e';
                } else {
                    var hours = Math.floor(remaining / 3600);
                    var minutes = Math.floor((remaining % 3600) / 60);

                    var text = timer.textContent.indexOf('+') === 0 ? '+' : '';
                    if (hours > 0) {
                        timer.textContent = text + hours + 'h ' + minutes + 'm';
                    } else {
                        timer.textContent = text + minutes + 'm';
                    }
                }
            });

            if (timers.length === 0) {
                stopSellTimers();
            }
        };

        updateTimers();
        // Increased interval to 5 seconds (was 1s)
        sellTimerInterval = setInterval(updateTimers, 5000);
    }

    function stopSellTimers() {
        if (sellTimerInterval) {
            clearInterval(sellTimerInterval);
            sellTimerInterval = null;
        }
    }

    // ============================================
    // WATCHER
    // ============================================
    function watchFinanceModal() {
        var checkModal = function() {
            // Skip check if page is hidden
            if (document.hidden) return;

            var bottomNav = document.getElementById('bottom-nav');
            var stockBtn = bottomNav && bottomNav.querySelector('#stock-page-btn');

            if (stockBtn && !tabsInjected && hasUserIPO()) {
                injectTabs();
            }

            if (!stockBtn && tabsInjected) {
                removeTabs();
                closeCustomContent();
            }
        };

        // Increased interval to 2000ms (was 500ms)
        setInterval(checkModal, 2000);

        // Stop interval when page becomes hidden
        document.addEventListener('visibilitychange', function() {
            if (document.hidden && sellTimerInterval) {
                stopSellTimers();
            }
        });
    }

    // ============================================
    // INIT
    // ============================================
    async function initBridge() {
        if (window.RebelShipBridge) {
            bridgeReady = true;
            await loadSettings();
            await loadCachedData();
            log('Bridge ready');

            // Initial IPO check only if cache is stale (older than 15 minutes)
            var cacheAgeMs = Date.now() - cachedData.lastUpdate;
            if (cacheAgeMs > CHECK_INTERVAL_MS) {
                log('Cache is stale (' + Math.round(cacheAgeMs / 60000) + ' min old), refreshing...');
                await refreshIpoCache();
            } else {
                log('Cache is fresh (' + Math.round(cacheAgeMs / 60000) + ' min old), skipping refresh');
            }

            // Run auto-buy after initial IPO check
            if (settings.autoBuyEnabled) {
                log('Running initial Auto-Buy check...');
                await runAutoBuy();
            }

            // Periodic IPO check every 6 minutes (auto-buy runs inside refreshIpoCache)
            setInterval(async function() {
                await refreshIpoCache();
                // Auto-Sell piggybacks on IPO refresh cycle
                if (settings.autoSellEnabled) {
                    await runAutoSell();
                }
            }, CHECK_INTERVAL_MS);
        } else {
            setTimeout(initBridge, 100);
        }
    }

    // Background job for Android BackgroundScriptService
    var lastBackgroundRun = 0;
    var BACKGROUND_JOB_INTERVAL_MS = 6 * 60 * 1000; // 6 minutes

    function registerBackgroundJob() {
        window.rebelshipBackgroundJobs = window.rebelshipBackgroundJobs || [];

        // Check if already registered
        var alreadyRegistered = window.rebelshipBackgroundJobs.some(function(job) {
            return job.name === 'AutoStock';
        });
        if (alreadyRegistered) {
            log('Background job already registered');
            return;
        }

        window.rebelshipBackgroundJobs.push({
            name: 'AutoStock',
            run: async function() {
                var now = Date.now();
                var timeSinceLastRun = now - lastBackgroundRun;

                // Only run if enough time has passed (6 minutes)
                if (timeSinceLastRun < BACKGROUND_JOB_INTERVAL_MS) {
                    return { skipped: true, reason: 'interval not reached', nextIn: Math.round((BACKGROUND_JOB_INTERVAL_MS - timeSinceLastRun) / 1000) + 's' };
                }

                lastBackgroundRun = now;
                log('Background job running...');

                var results = { ipoRefresh: false, autoBuy: false, autoSell: false };

                try {
                    // Load settings and data if not loaded
                    if (!bridgeReady && window.RebelShipBridge) {
                        bridgeReady = true;
                        await loadSettings();
                        await loadCachedData();
                    }

                    // IPO Refresh
                    var cacheAgeMs = Date.now() - cachedData.lastUpdate;
                    if (cacheAgeMs > CHECK_INTERVAL_MS) {
                        await refreshIpoCache();
                        results.ipoRefresh = true;
                    }

                    // Auto-Buy
                    if (settings.autoBuyEnabled) {
                        await runAutoBuy();
                        results.autoBuy = true;
                    }

                    // Auto-Sell
                    if (settings.autoSellEnabled) {
                        await runAutoSell();
                        results.autoSell = true;
                    }
                } catch (e) {
                    log('Background job error: ' + e.message);
                    return { success: false, error: e.message };
                }

                return { success: true, results: results };
            }
        });

        log('Background job registered');
    }

    function init() {
        addMenuItem('Auto Stocks', openSettingsModal, 61);
        setupModalWatcher();
        watchFinanceModal();
        registerBackgroundJob();
        initBridge();
        log('Auto Stock initialized');
    }

    if (!window.__rebelshipHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    } else {
        registerBackgroundJob();
    }
})();
