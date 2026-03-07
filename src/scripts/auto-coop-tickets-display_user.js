// ==UserScript==
// @name        ShippingManager - Auto Co-Op & Co-Op Header Display
// @description Shows open Co-Op tickets, auto-sends COOP vessels to alliance members
// @version     5.52
// @author      https://github.com/justonlyforyou/
// @order        3
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// @background-job-required true
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'CoOp';
    var STORE_NAME = 'data';

    var coopElement = null;
    var coopValueElement = null;
    var isProcessing = false;
    var isCoopModalOpen = false;
    var modalListenerAttached = false;

    // Settings
    var settings = {
        autoSendEnabled: false,
        notifyIngame: true,
        notifySystem: false
    };

    // ========== REBELSHIPBRIDGE STORAGE ==========

    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[' + SCRIPT_NAME + '] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[' + SCRIPT_NAME + '] dbSet error:', e);
            return false;
        }
    }

    async function loadSettings() {
        try {
            var record = await dbGet('settings');
            if (record) {
                settings = {
                    autoSendEnabled: record.autoSendEnabled !== undefined ? record.autoSendEnabled : false,
                    notifyIngame: record.notifyIngame !== undefined ? record.notifyIngame : true,
                    notifySystem: record.notifySystem !== undefined ? record.notifySystem : false
                };
            }
            return settings;
        } catch (e) {
            console.error('[' + SCRIPT_NAME + '] Failed to load settings:', e);
            return settings;
        }
    }

    async function saveSettings() {
        try {
            await dbSet('settings', settings);
            console.log('[' + SCRIPT_NAME + '] Settings saved');
        } catch (e) {
            console.error('[' + SCRIPT_NAME + '] Failed to save settings:', e);
        }
    }

    // ========== API FUNCTIONS ==========
    function fetchWithCookie(url, options, maxRetries) {
        maxRetries = maxRetries !== undefined ? maxRetries : 5;

        function attempt(attemptNum) {
            return fetch(url, Object.assign({
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
            }, options)).then(function(response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            }).catch(function(e) {
                log('Fetch attempt ' + attemptNum + '/' + maxRetries + ' failed: ' + e.message);
                if (attemptNum < maxRetries) {
                    // Exponential backoff: 2s, 4s, 8s, 16s
                    var delay = Math.pow(2, attemptNum) * 1000;
                    log('Retrying in ' + (delay / 1000) + 's...');
                    return new Promise(function(resolve) {
                        setTimeout(function() {
                            resolve(attempt(attemptNum + 1));
                        }, delay);
                    });
                }
                throw e;
            });
        }

        return attempt(1);
    }

    function fetchCoopData() {
        return fetchWithCookie('https://shippingmanager.cc/api/coop/get-coop-data', {
            method: 'POST',
            body: JSON.stringify({})
        });
    }

    function fetchContacts() {
        return fetchWithCookie('https://shippingmanager.cc/api/contact/get-contacts', {
            method: 'POST',
            body: JSON.stringify({})
        });
    }

    function fetchMemberSettings() {
        return fetchWithCookie('https://shippingmanager.cc/api/alliance/get-member-settings', {
            method: 'POST',
            body: JSON.stringify({})
        }).catch(function(e) {
            console.warn('[Co-Op] Failed to fetch member settings:', e.message);
            return { data: [] };
        });
    }

    function sendCoopVessels(userId, vesselCount) {
        return fetchWithCookie('https://shippingmanager.cc/api/route/depart-coop', {
            method: 'POST',
            body: JSON.stringify({ user_id: userId, vessels: vesselCount })
        });
    }

    // ========== AUTO COOP LOGIC (Drip-Feed Distribution) ==========

    var DIST_INTERVAL = 2 * 60 * 1000; // 2 minutes between sends
    var TEMP_RETRY_DELAY = 15 * 60 * 1000; // 15 minutes for temporary errors

    var PERMANENT_ERRORS = [
        'user_departed_has_coop_disabled',
        'user_departer_and_departed_are_the_same',
        'no_data'
    ];
    var TEMPORARY_ERRORS = [
        'user_departed_does_not_allow_coop_at_this_time',
        'no_vessels_are_ready_to_depart'
    ];

    var distState = {
        active: false,
        timer: null,
        members: [],
        companyNameMap: {},
        memberIndex: 0,
        skipList: {},
        startTime: 0,
        totalSent: 0,
        totalRequested: 0,
        results: [],
        retryPass: false
    };

    function runAutoCoop(manual) {
        if (distState.active) {
            log('Distribution already in progress');
            return Promise.resolve({ skipped: true, reason: 'distribution_active' });
        }
        if (isProcessing) {
            return Promise.resolve({ skipped: true, reason: 'processing' });
        }
        if (!manual && !settings.autoSendEnabled) {
            return Promise.resolve({ skipped: true, reason: 'disabled' });
        }

        isProcessing = true;

        // Invalidate coop cache to get fresh data
        apiCache.coop = { data: null, timestamp: 0 };

        return Promise.all([
            getCachedOrFetch('coop', fetchCoopData),
            getCachedOrFetch('contacts', fetchContacts),
            getCachedOrFetch('members', fetchMemberSettings)
        ]).then(function(responses) {
            var coopData = responses[0];
            var contactData = responses[1];
            var memberSettings = responses[2];

            var available = coopData.data && coopData.data.coop ? coopData.data.coop.available : 0;
            var members = coopData.data ? coopData.data.members_coop : [];
            var allianceContacts = contactData.data && contactData.data.alliance_contacts ? contactData.data.alliance_contacts : [];
            var settingsData = memberSettings.data || [];
            var ownUserId = coopData.data && coopData.data.user ? coopData.data.user.id : null;
            if (!ownUserId && coopData.user) {
                ownUserId = coopData.user.id;
            }
            if (!ownUserId) {
                var userStore = getPiniaStore('user');
                ownUserId = userStore && userStore.user ? userStore.user.id : null;
            }
            if (!ownUserId) {
                log('Cannot determine own user ID - aborting to prevent self-send');
                isProcessing = false;
                return { totalSent: 0, totalRequested: 0, results: [] };
            }

            if (available === 0) {
                log('No COOP tickets available');
                isProcessing = false;
                return { totalSent: 0, totalRequested: 0, results: [] };
            }

            // Build company name map
            var companyNameMap = {};
            allianceContacts.forEach(function(c) { companyNameMap[c.id] = c.company_name; });
            if (coopData.data && coopData.data.user && coopData.data.user.id && coopData.data.user.company_name) {
                companyNameMap[coopData.data.user.id] = coopData.data.user.company_name;
            }

            // Build settings map
            var settingsMap = {};
            settingsData.forEach(function(s) { settingsMap[s.user_id] = s; });

            // Filter eligible members (pre-filter)
            var skippedReasons = { self: 0, disabled: 0, noVessels: 0, lowFuel: 0, timeRestriction: 0 };
            var eligibleMembers = members.filter(function(member) {
                // Skip own user
                if (ownUserId && member.user_id === ownUserId) { skippedReasons.self++; return false; }

                // Skip coop disabled (from members_coop.enabled)
                if (member.enabled === false) { skippedReasons.disabled++; return false; }

                // Skip coop disabled (from get-member-settings.coop_enabled)
                var userSettings = settingsMap[member.user_id];
                if (userSettings && userSettings.coop_enabled === false) { skippedReasons.disabled++; return false; }

                if (member.total_vessels === 0) { skippedReasons.noVessels++; return false; }

                // Check fuel (less than 10t = 10000kg)
                var fuelTons = member.fuel / 1000;
                if (fuelTons < 10) { skippedReasons.lowFuel++; return false; }

                // Check time restrictions
                if (userSettings && userSettings.restrictions && userSettings.restrictions.time_range_enabled) {
                    var startHour = userSettings.restrictions.time_restriction_arr[0];
                    var endHour = userSettings.restrictions.time_restriction_arr[1];
                    var now = new Date();
                    var currentHour = now.getUTCHours();
                    var effectiveEndHour = endHour === 0 ? 24 : endHour;

                    var inTimeRange = false;
                    if (startHour < effectiveEndHour) {
                        inTimeRange = currentHour >= startHour && currentHour < effectiveEndHour;
                    } else {
                        inTimeRange = currentHour >= startHour || currentHour < endHour;
                    }

                    if (!inTimeRange) { skippedReasons.timeRestriction++; return false; }
                }

                return true;
            });

            var skipSummary = [];
            if (skippedReasons.self) skipSummary.push(skippedReasons.self + ' self');
            if (skippedReasons.disabled) skipSummary.push(skippedReasons.disabled + ' coop disabled');
            if (skippedReasons.noVessels) skipSummary.push(skippedReasons.noVessels + ' no vessels');
            if (skippedReasons.lowFuel) skipSummary.push(skippedReasons.lowFuel + ' low fuel');
            if (skippedReasons.timeRestriction) skipSummary.push(skippedReasons.timeRestriction + ' time restricted');
            if (skipSummary.length > 0) {
                log('Pre-filtered out: ' + skipSummary.join(', '));
            }

            if (eligibleMembers.length === 0) {
                log('No eligible members found');
                isProcessing = false;
                return { totalSent: 0, totalRequested: 0, results: [] };
            }

            // Sort by total_vessels DESC (largest fleets first)
            eligibleMembers.sort(function(a, b) { return b.total_vessels - a.total_vessels; });

            log('Starting distribution: ' + available + ' vessels to ' + eligibleMembers.length + ' eligible members (2min intervals)');
            startDistribution(eligibleMembers, companyNameMap);

            // Return immediately - distribution continues in background via timer
            return { started: true, members: eligibleMembers.length, available: available };
        }).catch(function(e) {
            log('Error after all retries: ' + e.message);
            showToast('CoOp Error: ' + e.message, 'error');
            isProcessing = false;
            return { error: e.message };
        });
    }

    function startDistribution(members, companyNameMap) {
        distState.active = true;
        distState.members = members;
        distState.companyNameMap = companyNameMap;
        distState.memberIndex = 0;
        distState.skipList = {};
        distState.startTime = Date.now();
        distState.totalSent = 0;
        distState.totalRequested = 0;
        distState.results = [];
        distState.retryPass = false;

        // First tick immediately
        distributionTick();

        // Then every 2 minutes
        distState.timer = setInterval(distributionTick, DIST_INTERVAL);
    }

    function findNextMember() {
        var now = Date.now();
        while (distState.memberIndex < distState.members.length) {
            var candidate = distState.members[distState.memberIndex];
            var skip = distState.skipList[candidate.user_id];
            if (skip) {
                if (skip.until && now >= skip.until) {
                    delete distState.skipList[candidate.user_id];
                    return candidate;
                }
                distState.memberIndex++;
                continue;
            }
            return candidate;
        }
        return null;
    }

    function hasTemporarySkips() {
        var keys = Object.keys(distState.skipList);
        for (var i = 0; i < keys.length; i++) {
            if (distState.skipList[keys[i]].until) return true;
        }
        return false;
    }

    function distributionTick() {
        if (!distState.active) return;

        // Fresh fetch available count (bypass cache)
        apiCache.coop = { data: null, timestamp: 0 };
        getCachedOrFetch('coop', fetchCoopData).then(function(coopData) {
            var available = coopData.data && coopData.data.coop ? coopData.data.coop.available : 0;

            // Update header display
            if (coopData.data && coopData.data.coop) {
                coopCache.available = available;
                coopCache.cap = coopData.data.coop.coop_boost || coopData.data.coop.cap;
                coopCache.lastFetch = Date.now();
            }
            updateCoopDisplay();

            if (available === 0) {
                log('No vessels remaining, distribution complete');
                stopDistribution();
                return;
            }

            // Try members until one succeeds or none left
            tryNextMember(available);
        }).catch(function(e) {
            log('Failed to fetch coop data during distribution: ' + e.message);
        });
    }

    function tryNextMember(available) {
        if (!distState.active) return;

        var member = findNextMember();

        if (!member) {
            if (hasTemporarySkips() && !distState.retryPass) {
                distState.retryPass = true;
                log('All members processed. Waiting 15min for temporary-skipped members retry...');
                clearInterval(distState.timer);
                distState.timer = setTimeout(function() {
                    distState.memberIndex = 0;
                    distState.retryPass = false;
                    distributionTick();
                    distState.timer = setInterval(distributionTick, DIST_INTERVAL);
                }, TEMP_RETRY_DELAY);
                return;
            }
            log('No more eligible members');
            stopDistribution();
            return;
        }

        var maxToSend = Math.min(available, member.total_vessels);
        var companyName = distState.companyNameMap[member.user_id] || 'User ' + member.user_id;
        var memberNum = distState.memberIndex + 1;
        var totalMembers = distState.members.length;

        log('Sending ' + maxToSend + ' to ' + companyName + ' (' + memberNum + '/' + totalMembers + ' members, ' + available + ' vessels remaining)');

        sendCoopVessels(member.user_id, maxToSend).then(function(sendResult) {
            if (sendResult.error) {
                log('Failed: ' + sendResult.error + ' (' + companyName + ')');
                distState.results.push({ company_name: companyName, error: sendResult.error });

                if (PERMANENT_ERRORS.indexOf(sendResult.error) !== -1) {
                    distState.skipList[member.user_id] = { reason: sendResult.error };
                    log('Permanent skip: ' + companyName + ' (' + sendResult.error + ')');
                } else if (TEMPORARY_ERRORS.indexOf(sendResult.error) !== -1) {
                    distState.skipList[member.user_id] = { reason: sendResult.error, until: Date.now() + TEMP_RETRY_DELAY };
                    log('Temporary skip: ' + companyName + ' (retry in 15min)');
                } else {
                    distState.skipList[member.user_id] = { reason: sendResult.error };
                    log('Unknown error skip: ' + companyName + ' (' + sendResult.error + ')');
                }

                distState.memberIndex++;
                // Failed → immediately try next member, no 2min wait
                tryNextMember(available);
            } else {
                var departed = sendResult.data && sendResult.data.vessels_departed ? sendResult.data.vessels_departed : 0;
                distState.totalRequested += maxToSend;
                distState.totalSent += departed;

                distState.results.push({
                    company_name: companyName,
                    requested: maxToSend,
                    departed: departed
                });

                log('Sent ' + departed + '/' + maxToSend + ' to ' + companyName);
                distState.memberIndex++;
                // Success → wait for next 2min tick
            }
        }).catch(function(e) {
            log('Error sending to ' + companyName + ': ' + e.message);
            distState.results.push({ company_name: companyName, error: e.message });
            distState.skipList[member.user_id] = { reason: e.message };
            distState.memberIndex++;
            // Network error → immediately try next member
            tryNextMember(available);
        });
    }

    function stopDistribution() {
        if (!distState.active) return;

        if (distState.timer) {
            clearInterval(distState.timer);
            clearTimeout(distState.timer);
            distState.timer = null;
        }

        var elapsed = Math.round((Date.now() - distState.startTime) / 1000);
        log('Distribution complete: ' + distState.totalSent + '/' + distState.totalRequested + ' vessels sent in ' + elapsed + 's');

        var skippedPerm = 0;
        var skippedTemp = 0;
        Object.keys(distState.skipList).forEach(function(uid) {
            if (distState.skipList[uid].until) skippedTemp++;
            else skippedPerm++;
        });
        if (skippedPerm > 0 || skippedTemp > 0) {
            log('Skipped: ' + skippedPerm + ' permanent, ' + skippedTemp + ' temporary');
        }

        if (distState.totalSent > 0) {
            var successCount = distState.results.filter(function(r) { return r.departed > 0; }).length;
            showToast('CoOp: Sent ' + distState.totalSent + ' vessels to ' + successCount + ' members', 'success');
        } else if (distState.totalRequested > 0) {
            showToast('CoOp: All sends failed', 'error');
        }

        distState.active = false;
        distState.members = [];
        distState.companyNameMap = {};
        distState.skipList = {};
        distState.results = [];
        isProcessing = false;
    }

    // ========== LOGGING & NOTIFICATIONS ==========
    function log(message) {
        console.log('[' + SCRIPT_NAME + '] ' + message);
    }

    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    function sendSystemNotification(title, message) {
        if (!settings.notifySystem) return;

        // Android bridge
        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(title + ': ' + message);
                return;
            } catch {
                // Ignore notify errors
            }
        }

        // Web Notification API
        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(title, { body: message, icon: 'https://shippingmanager.cc/favicon.ico', tag: 'coop' });
                } catch {
                    // Ignore notification errors
                }
            } else if (Notification.permission === 'default') {
                Notification.requestPermission().then(function(permission) {
                    if (permission === 'granted') {
                        new Notification(title, { body: message, icon: 'https://shippingmanager.cc/favicon.ico', tag: 'coop' });
                    }
                });
            }
        }
    }

    function showToast(message, type) {
        // In-game toast
        if (settings.notifyIngame) {
            var toastStore = getToastStore();
            if (toastStore) {
                if (type === 'error' && toastStore.error) toastStore.error(message);
                else if (type === 'warning' && toastStore.warning) toastStore.warning(message);
                else if (toastStore.success) toastStore.success(message);
            }
        }

        // System notification
        sendSystemNotification(SCRIPT_NAME, message);
    }

    function getPiniaStore(storeName) {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;
            return pinia._s.get(storeName);
        } catch {
            return null;
        }
    }

    function getToastStore() {
        return getPiniaStore('toast');
    }

    // Cache for coop data from API
    var coopCache = { available: 0, cap: 0, lastFetch: 0 };
    var coopCacheFails = 0;

    // API cache with TTL for all 3 API calls
    var apiCache = {
        coop: { data: null, timestamp: 0 },
        contacts: { data: null, timestamp: 0 },
        members: { data: null, timestamp: 0 }
    };
    var CACHE_TTL = 2 * 60 * 1000; // 2 minutes

    function getCachedOrFetch(cacheKey, fetchFn) {
        var now = Date.now();
        var cached = apiCache[cacheKey];
        if (cached.data && (now - cached.timestamp) < CACHE_TTL) {
            return Promise.resolve(cached.data);
        }
        return fetchFn().then(function(data) {
            apiCache[cacheKey] = { data: data, timestamp: now };
            return data;
        });
    }

    function refreshCoopCache() {
        return fetchCoopData().then(function(data) {
            if (data && data.data && data.data.coop) {
                coopCache.available = data.data.coop.available;
                // coop_boost takes priority over cap (alliance benefit)
                coopCache.cap = data.data.coop.coop_boost || data.data.coop.cap;
                coopCache.lastFetch = Date.now();
                coopCacheFails = 0; // Reset on success
            }
            return coopCache;
        }).catch(function() {
            coopCacheFails++;
            if (coopCacheFails > 3) {
                coopCache.lastFetch = 0; // Cache invalidieren nach 3 Fails
            }
            return coopCache;
        });
    }

    // ========== UI: DISPLAY ==========

    // Click Co-op tab (index 1): Overview, Co-op, Chat, Settings
    function clickCoopTab() {
        var topNav = document.querySelector('#top-nav');
        if (!topNav) return false;
        var tabs = topNav.querySelectorAll('.tab.flex-centered');
        if (tabs.length >= 2) {
            var tab = tabs[1];
            // Delay click to let Vue finish mounting, prevents game JS error
            setTimeout(function() {
                var event = new window.MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                });
                tab.dispatchEvent(event);
            }, 500);
            return true;
        }
        return false;
    }

    function openAllianceCoopTab() {
        var allianceBtn = document.getElementById('alliance-modal-btn');
        if (!allianceBtn) return;

        allianceBtn.click();

        var modalContainer = document.getElementById('modal-container');
        if (!modalContainer) return;

        var observer = new MutationObserver(function(mutations, obs) {
            if (clickCoopTab()) {
                obs.disconnect();
            }
        });

        observer.observe(modalContainer, { childList: true, subtree: true });

        // Timeout nach 5 Sekunden
        setTimeout(function() { observer.disconnect(); }, 5000);
    }


    // Cache for CO2 container element
    var co2ContainerCache = null;

    /**
     * Create 2-line coop display (like bunker):
     * Line 1: "CO-OP"
     * Line 2: available/max (red if available > 0)
     * Works with game's original CO2 display OR our bunker-price-display
     */
    function createCoopDisplay() {
        if (coopElement) return coopElement;

        // Find CO2 container - cache it on first success
        if (!co2ContainerCache) {
            co2ContainerCache = document.querySelector('.content.led.cursor-pointer');
        }

        if (!co2ContainerCache || !co2ContainerCache.parentNode) {
            co2ContainerCache = null; // Reset on failure
            log('CO2 container not found, retrying...');
            return null;
        }

        var co2Container = co2ContainerCache;

        // Create container
        coopElement = document.createElement('div');
        coopElement.id = 'coop-tickets-display';
        coopElement.style.cssText = 'display:flex;flex-direction:column;align-items:center;line-height:1.2;cursor:pointer;margin-left:8px;';
        coopElement.addEventListener('click', openAllianceCoopTab);

        // Line 1: Label
        var label = document.createElement('span');
        label.style.cssText = 'display:block;color:#9ca3af;font-size:12px;';
        label.textContent = 'COOP';
        coopElement.appendChild(label);

        // Line 2: Value (available/max)
        coopValueElement = document.createElement('span');
        coopValueElement.id = 'coop-tickets-value';
        coopValueElement.style.cssText = 'display:block;font-weight:bold;font-size:12px;';
        coopValueElement.textContent = '.../...';
        coopElement.appendChild(coopValueElement);

        // Insert after CO2 container (works with game or bunker-price-display)
        co2Container.parentNode.insertBefore(coopElement, co2Container.nextSibling);

        return coopElement;
    }

    function waitForCoopContainer() {
        return new Promise(function(resolve, reject) {
            var elapsed = 0;
            var interval = 500;
            var timeout = 20000;
            function check() {
                var container = document.querySelector('.content.led.cursor-pointer');
                if (container) { resolve(container); return; }
                elapsed += interval;
                if (elapsed >= timeout) { reject(new Error('Timeout')); return; }
                setTimeout(check, interval);
            }
            check();
        });
    }

    function updateCoopDisplay() {
        // Use cached data instead of re-fetching
        var available = coopCache.available;
        var cap = coopCache.cap;

        // If cache is empty (first initialization), then fetch
        if (coopCache.lastFetch === 0) {
            return refreshCoopCache().then(updateCoopDisplay);
        }

        // Hide if no coop data (not in alliance)
        if (cap === 0) {
            if (coopElement) coopElement.style.display = 'none';
            return Promise.resolve();
        }

        if (!coopElement) createCoopDisplay();
        if (!coopElement) {
            // Use MutationObserver instead of polling retries
            return waitForCoopContainer().then(function() {
                co2ContainerCache = null; // Reset cache to refetch
                return updateCoopDisplay();
            }).catch(function() {
                log('Timeout waiting for CO2 container');
            });
        }

        coopElement.style.display = '';
        if (coopValueElement) {
            coopValueElement.textContent = available + '/' + cap;
            // Red if available > 0 (tickets waiting), green if 0
            coopValueElement.style.color = available > 0 ? '#ef4444' : '#4ade80';
        }

        return Promise.resolve();
    }

    // ========== UI: SETTINGS MODAL (Game-style custom modal) ==========

    // Inject game-identical modal CSS (1:1 copy from app.css)
    function injectCoopModalStyles() {
        if (document.getElementById('coop-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'coop-modal-styles';
        style.textContent = [
            '@keyframes coop-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes coop-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes coop-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes coop-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#coop-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#coop-modal-wrapper #coop-modal-background{animation:coop-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#coop-modal-wrapper.hide #coop-modal-background{animation:coop-fade-out .15s linear forwards}',
            '#coop-modal-wrapper #coop-modal-content-wrapper{animation:coop-drop-down .15s linear forwards,coop-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#coop-modal-wrapper.hide #coop-modal-content-wrapper{animation:coop-push-up .15s linear forwards,coop-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#coop-modal-wrapper #coop-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#coop-modal-wrapper #coop-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#coop-modal-wrapper #coop-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#coop-modal-wrapper #coop-modal-content-wrapper{max-width:100%}}',
            '#coop-modal-wrapper #coop-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#coop-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#coop-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#coop-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#coop-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#coop-modal-container #coop-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#coop-modal-container #coop-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#coop-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeCoopModal() {
        if (!isCoopModalOpen) return;
        log('Closing CoOp modal');
        isCoopModalOpen = false;
        var modalWrapper = document.getElementById('coop-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }

    function setupCoopModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        window.addEventListener('rebelship-menu-click', function() {
            if (isCoopModalOpen) {
                log('RebelShip menu clicked, closing modal');
                closeCoopModal();
            }
        });
    }

    function getModalStore() {
        return getPiniaStore('modal');
    }

    function openSettingsModal() {
        // Close any open game modal first
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectCoopModalStyles();

        var existing = document.getElementById('coop-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#coop-settings-content');
            if (contentCheck) {
                existing.classList.remove('hide');
                isCoopModalOpen = true;
                updateSettingsContent();
                return;
            }
            existing.remove();
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'coop-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'coop-modal-background';
        modalBackground.onclick = function() { closeCoopModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'coop-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'coop-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto CO-OP Settings';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeCoopModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeCoopModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'coop-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'coop-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'coop-settings-content';
        centralContainer.appendChild(settingsContent);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isCoopModalOpen = true;
        updateSettingsContent();
    }

    function updateSettingsContent() {
        var settingsContent = document.getElementById('coop-settings-content');
        if (!settingsContent) return;

        settingsContent.innerHTML = '\
            <div style="padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="fh-auto-send" ' + (settings.autoSendEnabled ? 'checked' : '') + '\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span>Auto-Send COOP Vessels</span>\
                    </label>\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;margin-left:32px;">\
                        Automatically distribute available COOP vessels to alliance members (largest fleets first)\
                    </div>\
                </div>\
                <div style="margin-bottom:24px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="fh-notify-ingame" ' + (settings.notifyIngame ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="fh-notify-system" ' + (settings.notifySystem ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:30px;">\
                    <button id="fh-run-now" style="padding:10px 24px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:500;">' + (distState.active ? 'Stop' : 'Run Now') + '</button>\
                    <button id="fh-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;">Save</button>\
                </div>\
            </div>';

        document.getElementById('fh-run-now').addEventListener('click', function() {
            var btn = this;
            if (distState.active) {
                stopDistribution();
                btn.textContent = 'Run Now';
                btn.style.background = 'linear-gradient(180deg,#3b82f6,#1d4ed8)';
                return;
            }
            btn.disabled = true;
            btn.textContent = 'Starting...';
            runAutoCoop(true).then(function(result) {
                if (result && result.started) {
                    btn.textContent = 'Stop';
                    btn.style.background = 'linear-gradient(180deg,#ef4444,#b91c1c)';
                    btn.disabled = false;
                } else {
                    btn.textContent = 'Run Now';
                    btn.disabled = false;
                }
            });
        });

        document.getElementById('fh-save').addEventListener('click', function() {
            settings.autoSendEnabled = document.getElementById('fh-auto-send').checked;
            settings.notifyIngame = document.getElementById('fh-notify-ingame').checked;
            settings.notifySystem = document.getElementById('fh-notify-system').checked;
            if (settings.notifySystem) {
                requestNotificationPermission();
            }
            saveSettings().then(function() {
                showToast('CoOp settings saved', 'success');
                closeCoopModal();
            });
        });
    }

    // ========== SCHEDULER ==========
    // Run every 15 minutes (compatible with Android background service)
    var RUN_INTERVAL = 15 * 60 * 1000;

    function scheduledRun() {
        if (!settings.autoSendEnabled) return;
        runAutoCoop(false);
    }

    // ========== INITIALIZATION ==========
    var uiInitialized = false;
    var uiRetryCount = 0;

    function initUI() {
        if (uiInitialized) return;
        var hasApp = document.getElementById('app');
        var hasMessaging = document.querySelector('.messaging');
        if (!hasApp || !hasMessaging) {
            uiRetryCount++;
            if (uiRetryCount < 30) { setTimeout(initUI, 1000); return; }
            log('Max UI retries reached');
            return;
        }
        uiInitialized = true;
    }

    function init() {
        // Register menu immediately - no DOM needed for IPC call
        if (typeof addMenuItem === 'function') {
            addMenuItem('Auto CO-OP', openSettingsModal, 22);
        }
        initUI();

        // Load settings in background then continue initialization
        loadSettings().then(function() {
            setupCoopModalWatcher();

            // Initial display update and cache population
            refreshCoopCache().then(updateCoopDisplay);

            // Update cache every 15 minutes, then refresh display
            setInterval(function() {
                refreshCoopCache().then(updateCoopDisplay);
            }, RUN_INTERVAL);

            // Run auto-send every 15 minutes
            setInterval(scheduledRun, RUN_INTERVAL);

            // Initial run after 30 seconds
            setTimeout(scheduledRun, 30000);
        });
    }

    // Expose for Android BackgroundScriptService
    window.rebelshipRunAutoCoop = function() {
        return loadSettings().then(function() {
            if (!settings.autoSendEnabled) return { skipped: true, reason: 'disabled' };
            return runAutoCoop();
        });
    };

    // Store header resize handler for cleanup
    var headerResizeHandler = function() {
        coopElement = null;
        coopValueElement = null;
        co2ContainerCache = null;
        refreshCoopCache().then(updateCoopDisplay);
    };

    // Listen for header resize event to reinitialize display
    window.addEventListener('rebelship-header-resize', headerResizeHandler);

    // Optional: Cleanup-Funktion für Userscript-Neuladen
    window.rebelshipCleanupAutoCoop = function() {
        stopDistribution();
        window.removeEventListener('rebelship-header-resize', headerResizeHandler);
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
        name: 'AutoCoop',
        run: function() { return window.rebelshipRunAutoCoop(); }
    });
})();
