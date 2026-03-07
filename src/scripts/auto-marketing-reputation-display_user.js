// ==UserScript==
// @name        ShippingManager - Auto Marketing & Reputation Header Display
// @description Shows reputation in header, auto-renews campaigns when expired with the most expensive possible one.
// @version     5.35
// @author      joseywales - Pimped by https://github.com/justonlyforyou/
// @order        6
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// @background-job-required true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    console.log('[AutoReputation] Script loading...');

    var SCRIPT_NAME = 'AutoReputation';
    var STORE_NAME = 'data';

    // API base URL (best practice: centralized API endpoint management)
    var API_BASE = 'https://shippingmanager.cc/api';

    var reputationElement = null;
    var reputationValueElement = null;
    var isProcessing = false;
    var isUpdating = false;
    var displayRetries = 0;
    var isReputationModalOpen = false;
    var modalListenerAttached = false;

    // Campaign cache with 5 min TTL
    var campaignCache = { data: null, timestamp: 0, ttl: 5 * 60 * 1000 };

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

    // ========== SETTINGS ==========
    var settings = {
        autoRenewalEnabled: false,
        minCash: 0,
        notifyIngame: true,
        notifySystem: false
    };

    // ========== RebelShipBridge Storage ==========
    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[AutoReputation] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[AutoReputation] dbSet error:', e);
            return false;
        }
    }

    // ========== Load/Save Functions ==========
    async function loadSettingsAsync() {
        try {
            var stored = await dbGet('settings');
            if (stored) {
                settings = {
                    autoRenewalEnabled: stored.autoRenewalEnabled !== undefined ? stored.autoRenewalEnabled : false,
                    minCash: stored.minCash !== undefined ? stored.minCash : 0,
                    notifyIngame: stored.notifyIngame !== undefined ? stored.notifyIngame : true,
                    notifySystem: stored.notifySystem !== undefined ? stored.notifySystem : false
                };
            }
            return settings;
        } catch (e) {
            console.error('[AutoReputation] Failed to load settings:', e);
            return settings;
        }
    }

    async function saveSettings() {
        try {
            await dbSet('settings', settings);
            console.log('[AutoReputation] Settings saved');
        } catch (e) {
            console.error('[AutoReputation] Failed to save settings:', e);
        }
    }

    // ========== API FUNCTIONS ==========
    function fetchWithCookie(url, options) {
        return fetch(url, {
            method: options.method,
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: options.body
        }).then(function(response) {
            return response.json();
        });
    }

    function fetchUserSettings() {
        return fetchWithCookie(API_BASE + '/user/get-user-settings', {
            method: 'GET'
        });
    }

    function fetchCampaigns() {
        return fetchWithCookie(API_BASE + '/marketing-campaign/get-marketing', {
            method: 'POST',
            body: JSON.stringify({})
        });
    }

    function getCachedCampaigns() {
        if (campaignCache.data && Date.now() - campaignCache.timestamp < campaignCache.ttl) {
            return Promise.resolve(campaignCache.data);
        }
        return fetchCampaigns().then(function(data) {
            campaignCache.data = data;
            campaignCache.timestamp = Date.now();
            return data;
        });
    }

    function activateCampaign(campaignId) {
        return fetchWithCookie(API_BASE + '/marketing-campaign/activate-marketing-campaign', {
            method: 'POST',
            body: JSON.stringify({ campaign_id: campaignId })
        });
    }

    // ========== AUTO RENEWAL LOGIC ==========
    function runAutoRenewal(manual, cachedUserSettings) {
        if (isProcessing) {
            log('Already processing, skipping');
            return Promise.resolve({ skipped: true });
        }

        if (!manual && !settings.autoRenewalEnabled) {
            return Promise.resolve({ skipped: true });
        }

        isProcessing = true;
        log('Starting auto campaign renewal...');

        return getCachedCampaigns()
            .then(function(campaignData) {
                if (!campaignData || !campaignData.data) {
                    log('Failed to fetch campaigns');
                    return { error: 'Failed to fetch campaigns' };
                }

                var activeCampaigns = campaignData.data.active_campaigns ?? [];
                var availableCampaigns = campaignData.data.marketing_campaigns ?? [];

                log('Active campaigns: ' + activeCampaigns.length + ', Available: ' + availableCampaigns.length);

                var activeCampaignTypes = {};
                activeCampaigns.forEach(function(c) {
                    activeCampaignTypes[c.option_name] = true;
                });

                var allPossibleTypes = ['reputation', 'awareness', 'green'];
                var typesToRenew = allPossibleTypes.filter(function(type) {
                    return !activeCampaignTypes[type];
                });

                log('Types needing renewal: ' + (typesToRenew.join(', ') || 'none'));

                if (typesToRenew.length === 0) {
                    log('All campaign types are active');
                    if (manual) {
                        showToast('All campaigns active', 'success');
                        sendSystemNotification('Auto Reputation', 'All campaigns already active');
                    }
                    return { renewed: [] };
                }

                var userSettingsPromise = cachedUserSettings
                    ? Promise.resolve(cachedUserSettings)
                    : fetchUserSettings();

                return userSettingsPromise.then(function(userSettings) {
                    var currentCash = userSettings.user ? userSettings.user.cash : 0;

                    if (currentCash < settings.minCash) {
                        log('Cash ' + currentCash + ' below minimum ' + settings.minCash);
                        if (manual) {
                            showToast('Cash below minimum: $' + currentCash.toLocaleString(), 'warning');
                            sendSystemNotification('Auto Reputation', 'Cash $' + currentCash.toLocaleString() + ' below minimum $' + settings.minCash.toLocaleString());
                        }
                        return { skipped: true, reason: 'low_cash' };
                    }

                    var renewed = [];

                    function processType(index) {
                        if (index >= typesToRenew.length) {
                            return Promise.resolve(renewed);
                        }

                        var type = typesToRenew[index];
                        var campaignsOfType = availableCampaigns
                            .filter(function(c) { return c.option_name === type && c.price <= currentCash; })
                            .sort(function(a, b) { return b.price - a.price; });

                        if (campaignsOfType.length > 0) {
                            var campaign = campaignsOfType[0];

                            return activateCampaign(campaign.id)
                                .then(function() {
                                    renewed.push({
                                        type: type,
                                        name: campaign.name,
                                        price: campaign.price,
                                        duration: campaign.campaign_duration
                                    });
                                    currentCash -= campaign.price;
                                    log('Renewed "' + campaign.name + '" - Cost: $' + campaign.price.toLocaleString());
                                    return processType(index + 1);
                                })
                                .catch(function(e) {
                                    log('Failed to renew ' + type + ': ' + e.message);
                                    return processType(index + 1);
                                });
                        } else {
                            log('No affordable ' + type + ' campaigns');
                            return processType(index + 1);
                        }
                    }

                    return processType(0).then(function(renewedList) {
                        if (renewedList.length > 0) {
                            var summary = renewedList.map(function(r) { return r.name; }).join(', ');
                            var totalCost = renewedList.reduce(function(sum, r) { return sum + r.price; }, 0);

                            showToast('Renewed ' + renewedList.length + ' campaign(s): ' + summary, 'success');

                            if (settings.notifySystem || manual) {
                                sendSystemNotification('Campaigns Renewed', renewedList.length + ' campaign(s) renewed - $' + totalCost.toLocaleString());
                            }
                        } else if (manual) {
                            showToast('No campaigns could be renewed (not enough cash)', 'warning');
                        }

                        return { renewed: renewedList };
                    });
                });
            })
            .catch(function(e) {
                log('Error: ' + e.message);
                showToast('Renewal Error: ' + e.message, 'error');
                return { error: e.message };
            })
            .finally(function() {
                isProcessing = false;
            });
    }

    // ========== LOGGING & NOTIFICATIONS ==========
    function log(message) {
        console.log('[AutoReputation] ' + message);
    }

    function getToastStore() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('toast');
        } catch (e) { // eslint-disable-line no-unused-vars
            return null;
        }
    }

    function getStores() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;
            return {
                modalStore: pinia._s.get('modal')
            };
        } catch (e) { // eslint-disable-line no-unused-vars
            return null;
        }
    }

    // ========== CUSTOM MODAL (Game-style) ==========
    function injectReputationModalStyles() {
        if (document.getElementById('reputation-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'reputation-modal-styles';
        style.textContent = [
            '@keyframes reputation-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes reputation-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes reputation-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes reputation-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#reputation-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#reputation-modal-wrapper #reputation-modal-background{animation:reputation-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#reputation-modal-wrapper.hide #reputation-modal-background{animation:reputation-fade-out .15s linear forwards}',
            '#reputation-modal-wrapper #reputation-modal-content-wrapper{animation:reputation-drop-down .15s linear forwards,reputation-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#reputation-modal-wrapper.hide #reputation-modal-content-wrapper{animation:reputation-push-up .15s linear forwards,reputation-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#reputation-modal-wrapper #reputation-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#reputation-modal-wrapper #reputation-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#reputation-modal-wrapper #reputation-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#reputation-modal-wrapper #reputation-modal-content-wrapper{max-width:100%}}',
            '#reputation-modal-wrapper #reputation-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#reputation-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#reputation-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#reputation-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#reputation-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#reputation-modal-container #reputation-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#reputation-modal-container #reputation-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#reputation-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeReputationModal() {
        if (!isReputationModalOpen) return;
        log('Closing modal');
        isReputationModalOpen = false;
        var modalWrapper = document.getElementById('reputation-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
            setTimeout(function() {
                if (modalWrapper.parentNode) {
                    modalWrapper.parentNode.removeChild(modalWrapper);
                }
            }, 200);
        }
    }

    function setupReputationModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        window.addEventListener('rebelship-menu-click', function() {
            if (isReputationModalOpen) {
                log('RebelShip menu clicked, closing modal');
                closeReputationModal();
            }
        });
    }

    function showToast(message, type) {
        if (settings.notifyIngame) {
            var toastStore = getToastStore();
            if (toastStore && toastStore.add) {
                toastStore.add({ message: message, type: type || 'info' });
            }
        }
    }

    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    function sendSystemNotification(title, message) {
        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(title + ': ' + message);
                return;
            } catch (e) { // eslint-disable-line no-unused-vars
            }
        }

        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(title, { body: message, icon: 'https://shippingmanager.cc/favicon.ico', tag: 'reputation' });
                } catch (e) { // eslint-disable-line no-unused-vars
                }
            } else if (Notification.permission === 'default') {
                Notification.requestPermission().then(function(permission) {
                    if (permission === 'granted') {
                        new Notification(title, { body: message, icon: 'https://shippingmanager.cc/favicon.ico', tag: 'reputation' });
                    }
                });
            }
        }
    }

    // ========== UI: DISPLAY ==========
    function getReputationColor(rep) {
        if (rep >= 80) return '#4ade80';
        if (rep >= 50) return '#fbbf24';
        return '#ef4444';
    }

    function openFinanceMarketing() {
        var stockInfo = document.querySelector('.stockInfo');
        if (stockInfo) {
            stockInfo.click();
            setTimeout(function() {
                var marketingBtn = document.getElementById('marketing-page-btn');
                if (marketingBtn) {
                    marketingBtn.click();
                }
            }, 300);
        }
    }

    function createReputationDisplay() {
        if (reputationElement) return reputationElement;

        var coopDisplay = document.getElementById('coop-tickets-display');
        var insertAfter = coopDisplay;

        if (!insertAfter) {
            insertAfter = document.querySelector('.content.led.cursor-pointer');
        }

        if (!insertAfter || !insertAfter.parentNode) {
            log('Could not find insertion point, retrying...');
            return null;
        }

        reputationElement = document.createElement('div');
        reputationElement.id = 'reputation-display';
        reputationElement.style.cssText = 'display:flex;flex-direction:column;align-items:center;line-height:1.2;cursor:pointer;margin-left:8px;';
        reputationElement.addEventListener('click', openFinanceMarketing);

        var fragment = document.createDocumentFragment();

        var label = document.createElement('span');
        label.style.cssText = 'display:block;color:#9ca3af;font-size:12px;';
        label.textContent = 'Rep';
        fragment.appendChild(label);

        reputationValueElement = document.createElement('span');
        reputationValueElement.id = 'reputation-value';
        reputationValueElement.style.cssText = 'display:block;font-weight:bold;font-size:12px;';
        reputationValueElement.textContent = '...%';
        fragment.appendChild(reputationValueElement);

        reputationElement.appendChild(fragment);
        insertAfter.parentNode.insertBefore(reputationElement, insertAfter.nextSibling);

        return reputationElement;
    }

    function updateReputationDisplay(rep) {
        if (!reputationElement) {
            createReputationDisplay();
        }
        if (!reputationElement) {
            displayRetries++;
            if (displayRetries < 10) {
                var retryDelay = Math.min(1000 * Math.pow(2, displayRetries), 10000);
                setTimeout(function() { updateReputationDisplay(rep); }, retryDelay);
            }
            return;
        }
        if (reputationValueElement) {
            reputationValueElement.textContent = rep + '%';
            reputationValueElement.style.color = getReputationColor(rep);
        }
    }

    // ========== UI: SETTINGS MODAL (Custom Game-style) ==========
    function openSettingsModal() {
        var dropdown = document.getElementById('rebelship-dropdown');
        if (dropdown) dropdown.style.display = 'none';

        // Close any open game modal first
        var stores = getStores();
        var modalStore = stores ? stores.modalStore : null;
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectReputationModalStyles();

        var existing = document.getElementById('reputation-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#reputation-settings-content');
            if (contentCheck) {
                existing.classList.remove('hide');
                isReputationModalOpen = true;
                updateReputationSettingsContent();
                return;
            }
            existing.remove();
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'reputation-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'reputation-modal-background';
        modalBackground.onclick = function() { closeReputationModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'reputation-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'reputation-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto Reputation Settings';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeReputationModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeReputationModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'reputation-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'reputation-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'reputation-settings-content';
        centralContainer.appendChild(settingsContent);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isReputationModalOpen = true;
        updateReputationSettingsContent();
    }

    function updateReputationSettingsContent() {
        var settingsContent = document.getElementById('reputation-settings-content');
        if (!settingsContent) return;

        settingsContent.textContent = '';

        var container = document.createElement('div');
        container.style.cssText = 'padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;';

        // Auto-renewal section
        var autoRenewalSection = document.createElement('div');
        autoRenewalSection.style.cssText = 'margin-bottom:20px;';

        var autoRenewalLabel = document.createElement('label');
        autoRenewalLabel.style.cssText = 'display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;';

        var autoRenewalCheckbox = document.createElement('input');
        autoRenewalCheckbox.type = 'checkbox';
        autoRenewalCheckbox.id = 'rep-auto-renewal';
        autoRenewalCheckbox.checked = settings.autoRenewalEnabled;
        autoRenewalCheckbox.style.cssText = 'width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;';

        var autoRenewalText = document.createElement('span');
        autoRenewalText.textContent = 'Auto-Renew Campaigns';

        autoRenewalLabel.appendChild(autoRenewalCheckbox);
        autoRenewalLabel.appendChild(autoRenewalText);

        var autoRenewalDesc = document.createElement('div');
        autoRenewalDesc.style.cssText = 'font-size:12px;color:#626b90;margin-top:6px;margin-left:32px;';
        autoRenewalDesc.textContent = 'Automatically renews reputation, awareness, and green campaigns when they expire. Buys the most expensive campaign you can afford while respecting your minimum cash balance.';

        autoRenewalSection.appendChild(autoRenewalLabel);
        autoRenewalSection.appendChild(autoRenewalDesc);

        // Min cash section
        var minCashSection = document.createElement('div');
        minCashSection.style.cssText = 'margin-bottom:20px;';

        var minCashLabel = document.createElement('label');
        minCashLabel.style.cssText = 'display:block;font-weight:700;font-size:14px;margin-bottom:8px;';
        minCashLabel.textContent = 'Minimum Cash Balance';

        var minCashInput = document.createElement('input');
        minCashInput.id = 'rep-min-cash';
        minCashInput.value = formatNumberWithSeparator(settings.minCash);
        minCashInput.placeholder = '0';
        minCashInput.style.cssText = 'width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box;';
        setupThousandSeparator(minCashInput);

        var minCashDesc = document.createElement('div');
        minCashDesc.style.cssText = 'font-size:12px;color:#626b90;margin-top:6px;';
        minCashDesc.textContent = 'Only renew campaigns if cash balance is above this amount';

        minCashSection.appendChild(minCashLabel);
        minCashSection.appendChild(minCashInput);
        minCashSection.appendChild(minCashDesc);

        // Notifications section
        var notifySection = document.createElement('div');
        notifySection.style.cssText = 'margin-bottom:24px;';

        var notifyTitle = document.createElement('div');
        notifyTitle.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;';
        notifyTitle.textContent = 'Notifications';

        var notifyOptions = document.createElement('div');
        notifyOptions.style.cssText = 'display:flex;gap:24px;';

        var ingameLabel = document.createElement('label');
        ingameLabel.style.cssText = 'display:flex;align-items:center;cursor:pointer;';

        var ingameCheckbox = document.createElement('input');
        ingameCheckbox.type = 'checkbox';
        ingameCheckbox.id = 'rep-notify-ingame';
        ingameCheckbox.checked = settings.notifyIngame;
        ingameCheckbox.style.cssText = 'width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;';

        var ingameText = document.createElement('span');
        ingameText.style.cssText = 'font-size:13px;';
        ingameText.textContent = 'Ingame';

        ingameLabel.appendChild(ingameCheckbox);
        ingameLabel.appendChild(ingameText);

        var systemLabel = document.createElement('label');
        systemLabel.style.cssText = 'display:flex;align-items:center;cursor:pointer;';

        var systemCheckbox = document.createElement('input');
        systemCheckbox.type = 'checkbox';
        systemCheckbox.id = 'rep-notify-system';
        systemCheckbox.checked = settings.notifySystem;
        systemCheckbox.style.cssText = 'width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;';

        var systemText = document.createElement('span');
        systemText.style.cssText = 'font-size:13px;';
        systemText.textContent = 'System';

        systemLabel.appendChild(systemCheckbox);
        systemLabel.appendChild(systemText);

        notifyOptions.appendChild(ingameLabel);
        notifyOptions.appendChild(systemLabel);

        notifySection.appendChild(notifyTitle);
        notifySection.appendChild(notifyOptions);

        // Buttons section
        var buttonsSection = document.createElement('div');
        buttonsSection.style.cssText = 'display:flex;gap:12px;justify-content:space-between;margin-top:30px;';

        var runNowBtn = document.createElement('button');
        runNowBtn.id = 'rep-run-now';
        runNowBtn.style.cssText = 'padding:10px 24px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:500;';
        runNowBtn.textContent = 'Run Now';

        var saveBtn = document.createElement('button');
        saveBtn.id = 'rep-save';
        saveBtn.style.cssText = 'padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;';
        saveBtn.textContent = 'Save';

        buttonsSection.appendChild(runNowBtn);
        buttonsSection.appendChild(saveBtn);

        // Assemble all sections
        container.appendChild(autoRenewalSection);
        container.appendChild(minCashSection);
        container.appendChild(notifySection);
        container.appendChild(buttonsSection);

        settingsContent.appendChild(container);

        // Event listeners
        runNowBtn.addEventListener('click', function() {
            this.disabled = true;
            this.textContent = 'Running...';
            runAutoRenewal(true).then(function() {
                runNowBtn.textContent = 'Run Now';
                runNowBtn.disabled = false;
            });
        });

        saveBtn.addEventListener('click', function() {
            settings.autoRenewalEnabled = autoRenewalCheckbox.checked;
            settings.minCash = getNumericValue(minCashInput);
            settings.notifyIngame = ingameCheckbox.checked;
            settings.notifySystem = systemCheckbox.checked;
            if (settings.notifySystem) {
                requestNotificationPermission();
            }
            saveSettings();
            showToast('Reputation settings saved', 'success');
            closeReputationModal();
        });
    }

    // ========== MAIN UPDATE LOOP ==========
    function updateReputation() {
        if (isUpdating) {
            log('Update already in progress, skipping');
            return;
        }

        if (document.hidden) {
            log('Tab inactive, skipping update');
            return;
        }

        isUpdating = true;

        fetchUserSettings()
            .then(function(data) {
                var rep = data && data.user ? data.user.reputation : null;

                if (rep !== null && rep !== undefined) {
                    updateReputationDisplay(rep);
                }

                if (settings.autoRenewalEnabled) {
                    return getCachedCampaigns().then(function(campaignData) {
                        if (campaignData && campaignData.data) {
                            var activeCampaigns = campaignData.data.active_campaigns ?? [];
                            var activeCampaignTypes = {};
                            activeCampaigns.forEach(function(c) {
                                activeCampaignTypes[c.option_name] = true;
                            });

                            var allTypes = ['reputation', 'awareness', 'green'];
                            var missingTypes = allTypes.filter(function(t) { return !activeCampaignTypes[t]; });

                            if (missingTypes.length > 0) {
                                log('Missing campaign types: ' + missingTypes.join(', ') + ' - triggering renewal');
                                return runAutoRenewal(false, data);
                            }
                        }
                    });
                }
            })
            .catch(function(e) {
                console.error('[Reputation] Error:', e);
            })
            .finally(function() {
                isUpdating = false;
            });
    }

    // ========== INIT ==========
    var uiInitialized = false;

    function initUI() {
        if (uiInitialized) return;
        var hasApp = document.getElementById('app');
        if (!hasApp) {
            setTimeout(initUI, 500);
            return;
        }
        uiInitialized = true;
    }

    async function init() {
        // Register menu immediately - no DOM needed for IPC call
        addMenuItem('Auto Reputation', openSettingsModal, 24);
        initUI();

        await loadSettingsAsync();
        setupReputationModalWatcher();

        setTimeout(function() {
            updateReputation();
            setInterval(updateReputation, 2 * 60 * 1000);
        }, 1000);
    }

    window.addEventListener('rebelship-header-resize', function() {
        if (reputationElement && reputationElement.parentNode) {
            reputationElement.parentNode.removeChild(reputationElement);
        }
        reputationElement = null;
        reputationValueElement = null;
        displayRetries = 0;
        setTimeout(updateReputation, 350);
    });

    window.addEventListener('beforeunload', function() {
        modalListenerAttached = false;
    });

    // ========== BACKGROUND JOB ==========
    window.rebelshipRunAutoMarketing = function() {
        if (!settings.autoRenewalEnabled) {
            return Promise.resolve({ skipped: true, reason: 'disabled' });
        }
        return runAutoRenewal(false).then(function(result) {
            return { success: true, result: result };
        }).catch(function(e) {
            return { success: false, error: e.message };
        });
    };

    window.rebelshipBackgroundJobs = window.rebelshipBackgroundJobs || [];
    window.rebelshipBackgroundJobs.push({
        name: 'AutoMarketing',
        interval: 15 * 60 * 1000,
        run: function() { return window.rebelshipRunAutoMarketing(); }
    });

    if (!window.__rebelshipHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }
})();
