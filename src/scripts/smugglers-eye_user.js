// ==UserScript==
// @name         ShippingManager - Smuggler's Eye
// @namespace    https://rebelship.org/
// @version      1.97
// @description  Auto-adjust cargo prices: 4% instant markup, gradual increase, max guards on pirate routes
// @author       https://github.com/justonlyforyou/
// @order        12
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

    console.log('[SmugglersEye] Script loading...');

    // ========== CONFIGURATION ==========
    var SCRIPT_NAME = 'SmugglersEye';
    var STORE_NAME = 'data';
    var CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
    var AUTOPRICE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    var API_BASE = 'https://shippingmanager.cc/api';
    var MAX_BUFFER_SIZE = 100;
    var MAX_BUFFER_AGE = 24 * 60 * 60 * 1000; // 24 hours
    var originalFetch = window.fetch;

    // ========== STATE ==========
    var settings = {
        enabled: false,
        instant4Percent: true,
        gradual8Percent: false,
        gradualIncreaseStep: 1,
        gradualIncreaseInterval: 25,
        targetPercent: 8,
        maxGuardsOnPirateRoutes: true,
        notifyIngame: true,
        notifySystem: false
    };
    var monitorInterval = null;
    var isProcessing = false;
    var isModalOpen = false;
    var modalListenerAttached = false;
    var autoPriceCacheData = {};
    var gradualIncreaseData = {};
    var hijackingRiskCache = new Map();
    var routesCached = false;
    var autoPriceDirty = false;
    var gradualDirty = false;

    // ========== UTILITY ==========
    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function calculatePriceDiffPercent(price, autoprice) {
        if (!autoprice || autoprice === 0) return 0;
        return Math.round(((price - autoprice) / autoprice) * 100);
    }

    // ========== REBELSHIPBRIDGE STORAGE (Own) ==========
    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[SmugglersEye] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[SmugglersEye] dbSet error:', e);
            return false;
        }
    }

    // ========== PER-CATEGORY SHARED STORAGE (DepartManager) ==========
    var RETRY_DELAYS = [500, 1000, 2000];

    async function getSharedCategory(category, retryCount) {
        // Use DepartManager's in-memory cache if available (eliminates race conditions)
        if (window._rebelshipDMStorage && window._rebelshipDMStorage.isReady()) {
            return window._rebelshipDMStorage.getCategory(category);
        }
        // Fallback: direct DB read (DepartManager not loaded yet)
        retryCount = retryCount || 0;
        try {
            // Try per-category key first
            var value = await window.RebelShipBridge.storage.get('DepartManager', 'data', 'st_' + category);
            if (value) return JSON.parse(value);
            // Fallback: old blob format (pre-migration)
            var blob = await window.RebelShipBridge.storage.get('DepartManager', 'data', 'storage');
            if (blob) {
                var parsed = JSON.parse(blob);
                return parsed[category] || {};
            }
            return {};
        } catch (e) {
            if (retryCount < RETRY_DELAYS.length) {
                var delay = RETRY_DELAYS[retryCount];
                console.warn('[SmugglersEye] getSharedCategory(' + category + ') retry ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ' in ' + delay + 'ms');
                await new Promise(function(r) { setTimeout(r, delay); });
                return getSharedCategory(category, retryCount + 1);
            }
            console.error('[SmugglersEye] getSharedCategory(' + category + ') FAILED after retries:', e);
            return null;
        }
    }

    async function saveSharedCategory(category, data, retryCount) {
        // Use DepartManager's debounced save if available (eliminates race conditions)
        if (window._rebelshipDMStorage && window._rebelshipDMStorage.isReady()) {
            window._rebelshipDMStorage.saveCategory(category, data);
            return true;
        }
        // Fallback: direct DB write (DepartManager not loaded yet)
        retryCount = retryCount || 0;
        try {
            await window.RebelShipBridge.storage.set('DepartManager', 'data', 'st_' + category, JSON.stringify(data));
            return true;
        } catch (e) {
            if (retryCount < RETRY_DELAYS.length) {
                var delay = RETRY_DELAYS[retryCount];
                console.warn('[SmugglersEye] saveSharedCategory(' + category + ') retry ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ' in ' + delay + 'ms');
                await new Promise(function(r) { setTimeout(r, delay); });
                return saveSharedCategory(category, data, retryCount + 1);
            }
            console.error('[SmugglersEye] saveSharedCategory(' + category + ') FAILED after retries:', e);
            return false;
        }
    }

    // ========== SETTINGS ==========
    async function loadSettings() {
        try {
            var record = await dbGet('settings');
            if (record) {
                settings = {
                    enabled: record.enabled !== undefined ? record.enabled : false,
                    instant4Percent: record.instant4Percent !== undefined ? record.instant4Percent : true,
                    gradual8Percent: record.gradual8Percent !== undefined ? record.gradual8Percent : false,
                    gradualIncreaseStep: record.gradualIncreaseStep !== undefined ? record.gradualIncreaseStep : 1,
                    gradualIncreaseInterval: record.gradualIncreaseInterval !== undefined ? record.gradualIncreaseInterval : 25,
                    targetPercent: record.targetPercent !== undefined ? record.targetPercent : 8,
                    maxGuardsOnPirateRoutes: record.maxGuardsOnPirateRoutes !== undefined ? record.maxGuardsOnPirateRoutes : true,
                    notifyIngame: record.notifyIngame !== undefined ? record.notifyIngame : true,
                    notifySystem: record.notifySystem !== undefined ? record.notifySystem : false
                };
            }
            return settings;
        } catch (e) {
            console.error('[SmugglersEye] Failed to load settings:', e);
            return settings;
        }
    }

    async function saveSettings() {
        try {
            await dbSet('settings', settings);
        } catch (e) {
            console.error('[SmugglersEye] Failed to save settings:', e);
        }
    }

    // ========== AUTOPRICE CACHE (Shared with DepartManager) ==========
    async function loadAutoPriceCache() {
        try {
            var parsed = null;
            // Use DM's in-memory cache if available
            if (window._rebelshipDMStorage && window._rebelshipDMStorage.isReady()) {
                parsed = window._rebelshipDMStorage.getAutoPriceCache();
            } else {
                var result = await window.RebelShipBridge.storage.get('DepartManager', 'data', 'autoPriceCache');
                if (result) parsed = JSON.parse(result);
            }
            if (parsed) {
                var now = Date.now();
                var cleaned = {};
                var keys = Object.keys(parsed);
                var removed = 0;
                for (var i = 0; i < keys.length; i++) {
                    var entry = parsed[keys[i]];
                    if (entry && entry.timestamp && (now - entry.timestamp) < AUTOPRICE_CACHE_TTL) {
                        cleaned[keys[i]] = entry;
                    } else {
                        removed++;
                    }
                }
                autoPriceCacheData = cleaned;
                if (removed > 0) {
                    log('Cleaned ' + removed + ' expired autoprice cache entries');
                    autoPriceDirty = true;
                }
            }
        } catch (e) {
            console.error('[SmugglersEye] loadAutoPriceCache error:', e);
        }
        return autoPriceCacheData;
    }

    async function saveAutoPriceCache() {
        try {
            // Use DM's API if available (writes through DM's cache)
            if (window._rebelshipDMStorage) {
                window._rebelshipDMStorage.saveAutoPriceCache(autoPriceCacheData);
            } else {
                await window.RebelShipBridge.storage.set('DepartManager', 'data', 'autoPriceCache', JSON.stringify(autoPriceCacheData));
            }
        } catch (e) {
            console.error('[SmugglersEye] saveAutoPriceCache error:', e);
        }
    }

    function getAutoprice(routeId, vesselType) {
        var cacheKey = routeId + '_' + (vesselType === 'tanker' ? 't' : 'c');
        var entry = autoPriceCacheData[cacheKey];
        if (entry && entry.prices) {
            return {
                dry: entry.prices.dry,
                ref: entry.prices.ref,
                fuel: entry.prices.fuel,
                crude: entry.prices.crude
            };
        }
        return null;
    }

    // ========== GRADUAL INCREASE TRACKING ==========
    async function loadGradualIncreaseData() {
        var cached = await dbGet('gradualIncrease');
        if (cached) {
            gradualIncreaseData = cached;
        }
        return gradualIncreaseData;
    }

    async function saveGradualIncreaseData() {
        await dbSet('gradualIncrease', gradualIncreaseData);
    }

    function getLastGradualIncrease(vesselId) {
        return gradualIncreaseData[vesselId] || 0;
    }

    function setLastGradualIncrease(vesselId, timestamp) {
        gradualIncreaseData[vesselId] = timestamp;
        gradualDirty = true;
    }

    function cleanGradualIncreaseData(vessels) {
        var vesselIdSet = {};
        for (var i = 0; i < vessels.length; i++) {
            vesselIdSet[vessels[i].id] = true;
        }
        var keys = Object.keys(gradualIncreaseData);
        var removed = 0;
        for (var j = 0; j < keys.length; j++) {
            if (!vesselIdSet[keys[j]]) {
                delete gradualIncreaseData[keys[j]];
                removed++;
                gradualDirty = true;
            }
        }
        if (removed > 0) {
            log('Cleaned ' + removed + ' stale gradual increase entries');
        }
    }

    // ========== PENDING ROUTE SETTINGS (Shared) ==========
    var pendingChangesBuffer = {};

    function bufferPendingRouteSettings(vesselId, data) {
        var bufferKeys = Object.keys(pendingChangesBuffer);
        if (bufferKeys.length >= MAX_BUFFER_SIZE) {
            var oldestKey = bufferKeys[0];
            var oldestTime = pendingChangesBuffer[bufferKeys[0]].savedAt || 0;
            for (var i = 1; i < bufferKeys.length; i++) {
                var t = pendingChangesBuffer[bufferKeys[i]].savedAt || 0;
                if (t < oldestTime) {
                    oldestTime = t;
                    oldestKey = bufferKeys[i];
                }
            }
            delete pendingChangesBuffer[oldestKey];
        }

        pendingChangesBuffer[vesselId] = {
            name: data.name,
            speed: data.speed,
            guards: data.guards,
            prices: data.prices,
            savedAt: Date.now()
        };
    }

    async function flushPendingRouteSettings() {
        var now = Date.now();
        var bufferKeys = Object.keys(pendingChangesBuffer);
        for (var i = 0; i < bufferKeys.length; i++) {
            var entry = pendingChangesBuffer[bufferKeys[i]];
            if (entry.savedAt && (now - entry.savedAt) > MAX_BUFFER_AGE) {
                delete pendingChangesBuffer[bufferKeys[i]];
            }
        }

        var vesselIds = Object.keys(pendingChangesBuffer);
        if (vesselIds.length === 0) return;

        var pendingRouteSettings = await getSharedCategory('pendingRouteSettings');
        if (pendingRouteSettings === null) {
            console.error('[SmugglersEye] Cannot save pending routes - storage unavailable after retries');
            return;
        }

        for (var k = 0; k < vesselIds.length; k++) {
            pendingRouteSettings[vesselIds[k]] = pendingChangesBuffer[vesselIds[k]];
        }

        var success = await saveSharedCategory('pendingRouteSettings', pendingRouteSettings);
        if (success) {
            pendingChangesBuffer = {};
        }
    }

    // ========== HIJACKING RISK CACHE (Map-based) ==========
    function rebuildHijackingRiskCache(vessels) {
        hijackingRiskCache.clear();
        for (var i = 0; i < vessels.length; i++) {
            var vessel = vessels[i];
            if (!vessel.routes || !Array.isArray(vessel.routes)) continue;
            for (var j = 0; j < vessel.routes.length; j++) {
                var route = vessel.routes[j];
                if (route.origin && route.destination && route.hijacking_risk !== undefined) {
                    var routeKey = route.origin + '<>' + route.destination;
                    var reverseKey = route.destination + '<>' + route.origin;
                    hijackingRiskCache.set(routeKey, route.hijacking_risk);
                    hijackingRiskCache.set(reverseKey, route.hijacking_risk);
                }
            }
        }
    }

    function getVesselHijackingRisk(vessel) {
        if (!vessel.route_origin || !vessel.route_destination) return 0;
        var routeKey = vessel.route_origin + '<>' + vessel.route_destination;
        var risk = hijackingRiskCache.get(routeKey);
        if (risk !== undefined) return risk;
        var reverseKey = vessel.route_destination + '<>' + vessel.route_origin;
        risk = hijackingRiskCache.get(reverseKey);
        if (risk !== undefined) return risk;
        return 0;
    }

    // ========== API FUNCTIONS ==========
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

    function fetchVessels() {
        var includeRoutes = !routesCached;
        return fetchWithCookie(API_BASE + '/vessel/get-all-user-vessels', {
            method: 'POST',
            body: JSON.stringify({ include_routes: includeRoutes })
        }).then(function(data) {
            var vessels = data.data && data.data.user_vessels ? data.data.user_vessels : [];
            if (includeRoutes && vessels.length > 0) {
                rebuildHijackingRiskCache(vessels);
                routesCached = true;
            }
            return vessels;
        });
    }

    function updateRouteData(vesselId, speed, guards, prices) {
        return fetchWithCookie(API_BASE + '/route/update-route-data', {
            method: 'POST',
            body: JSON.stringify({
                user_vessel_id: vesselId,
                speed: speed,
                guards: guards,
                prices: prices
            })
        }).then(function(data) {
            return data && data.data && data.data.user_vessel;
        });
    }

    async function fetchAutoPrice(vesselId, routeId) {
        try {
            var response = await originalFetch(API_BASE + '/demand/auto-price', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ user_vessel_id: vesselId, route_id: routeId })
            });
            if (response.ok) {
                var data = await response.json();
                return data && data.data ? data.data : null;
            }
        } catch (e) {
            log('fetchAutoPrice failed: ' + e.message, 'error');
        }
        return null;
    }

    // ========== CORE LOGIC ==========
    async function initAutoPriceCache(vessels) {
        if (!vessels || vessels.length === 0) return;

        var vesselsWithRoutes = vessels.filter(function(v) {
            var routeId = (v.active_route && v.active_route.route_id) || v.route_id;
            return routeId && v.route_destination && !v.is_parked;
        });

        if (vesselsWithRoutes.length === 0) return;

        var now = Date.now();
        var needsFetch = [];

        for (var i = 0; i < vesselsWithRoutes.length; i++) {
            var v = vesselsWithRoutes[i];
            var routeId = (v.active_route && v.active_route.route_id) || v.route_id;
            var cacheKey = routeId + '_' + (v.capacity_type === 'tanker' ? 't' : 'c');
            var entry = autoPriceCacheData[cacheKey];

            if (!entry || (now - entry.timestamp) >= AUTOPRICE_CACHE_TTL) {
                needsFetch.push({ vessel: v, routeId: routeId, cacheKey: cacheKey });
            }
        }

        if (needsFetch.length === 0) return;

        var batchSize = 3;
        var batchDelay = 500;
        for (var j = 0; j < needsFetch.length; j += batchSize) {
            var batch = needsFetch.slice(j, j + batchSize);
            var batchHadError = false;
            await Promise.all(batch.map(async function(item) {
                var prices = await fetchAutoPrice(item.vessel.id, item.routeId);
                if (prices) {
                    autoPriceCacheData[item.cacheKey] = { prices: prices, timestamp: now };
                    autoPriceDirty = true;
                } else {
                    batchHadError = true;
                }
            }));

            if (batchHadError) {
                batchDelay = Math.min(batchDelay * 2, 5000);
            }
            if (j + batchSize < needsFetch.length) {
                await new Promise(function(r) { setTimeout(r, batchDelay); });
            }
        }
    }

    function applySmugglersEyeToVessel(vessel) {
        if (!settings.enabled) return { updated: false, pending: false };

        if (!vessel.route_destination) return { updated: false, pending: false };

        var routeId = (vessel.active_route && vessel.active_route.route_id) || vessel.route_id;
        if (!routeId) return { updated: false, pending: false };

        if (vessel.is_parked) return { updated: false, pending: false };

        var autoprice = getAutoprice(routeId, vessel.capacity_type);
        if (!autoprice) return { updated: false, pending: false };

        var currentPrices = vessel.prices || {};
        var newPrices = Object.assign({}, currentPrices);
        var newGuards = vessel.route_guards || 0;
        var needsUpdate = false;

        // 4% Instant Markup
        if (settings.instant4Percent) {
            if (currentPrices.dry && autoprice.dry) {
                var diffDry = calculatePriceDiffPercent(currentPrices.dry, autoprice.dry);
                if (diffDry < 4) {
                    newPrices.dry = Math.round(autoprice.dry * 1.04);
                    needsUpdate = true;
                }
            }
            if (currentPrices.refrigerated && autoprice.ref) {
                var diffRef = calculatePriceDiffPercent(currentPrices.refrigerated, autoprice.ref);
                if (diffRef < 4) {
                    newPrices.refrigerated = Math.round(autoprice.ref * 1.04);
                    needsUpdate = true;
                }
            }
            if (currentPrices.fuel && autoprice.fuel) {
                var diffFuel = calculatePriceDiffPercent(currentPrices.fuel, autoprice.fuel);
                if (diffFuel < 4) {
                    newPrices.fuel = Math.round(autoprice.fuel * 1.04 * 100) / 100;
                    needsUpdate = true;
                }
            }
            if (currentPrices.crude_oil && autoprice.crude) {
                var diffCrude = calculatePriceDiffPercent(currentPrices.crude_oil, autoprice.crude);
                if (diffCrude < 4) {
                    newPrices.crude_oil = Math.round(autoprice.crude * 1.04 * 100) / 100;
                    needsUpdate = true;
                }
            }
        }

        // Gradual Increase
        if (settings.gradual8Percent) {
            var now = Date.now();
            var lastIncrease = getLastGradualIncrease(vessel.id);
            var targetPercent = settings.targetPercent;
            var increaseStep = settings.gradualIncreaseStep;
            var intervalMs = settings.gradualIncreaseInterval * 60 * 60 * 1000;
            var stepMultiplier = 1 + increaseStep / 100;

            if (!lastIncrease || (now - lastIncrease) >= intervalMs) {
                var gradualUpdated = false;

                if (currentPrices.dry && autoprice.dry) {
                    var currentDiffDry = calculatePriceDiffPercent(newPrices.dry || currentPrices.dry, autoprice.dry);
                    if (currentDiffDry < targetPercent) {
                        var maxPriceDry = Math.round(autoprice.dry * (1 + targetPercent / 100));
                        newPrices.dry = Math.min(Math.round((newPrices.dry || currentPrices.dry) * stepMultiplier), maxPriceDry);
                        gradualUpdated = true;
                    }
                }
                if (currentPrices.refrigerated && autoprice.ref) {
                    var currentDiffRef = calculatePriceDiffPercent(newPrices.refrigerated || currentPrices.refrigerated, autoprice.ref);
                    if (currentDiffRef < targetPercent) {
                        var maxPriceRef = Math.round(autoprice.ref * (1 + targetPercent / 100));
                        newPrices.refrigerated = Math.min(Math.round((newPrices.refrigerated || currentPrices.refrigerated) * stepMultiplier), maxPriceRef);
                        gradualUpdated = true;
                    }
                }
                if (currentPrices.fuel && autoprice.fuel) {
                    var currentDiffFuel = calculatePriceDiffPercent(newPrices.fuel || currentPrices.fuel, autoprice.fuel);
                    if (currentDiffFuel < targetPercent) {
                        var maxPriceFuel = Math.round(autoprice.fuel * (1 + targetPercent / 100) * 100) / 100;
                        newPrices.fuel = Math.min(Math.round((newPrices.fuel || currentPrices.fuel) * stepMultiplier * 100) / 100, maxPriceFuel);
                        gradualUpdated = true;
                    }
                }
                if (currentPrices.crude_oil && autoprice.crude) {
                    var currentDiffCrude = calculatePriceDiffPercent(newPrices.crude_oil || currentPrices.crude_oil, autoprice.crude);
                    if (currentDiffCrude < targetPercent) {
                        var maxPriceCrude = Math.round(autoprice.crude * (1 + targetPercent / 100) * 100) / 100;
                        newPrices.crude_oil = Math.min(Math.round((newPrices.crude_oil || currentPrices.crude_oil) * stepMultiplier * 100) / 100, maxPriceCrude);
                        gradualUpdated = true;
                    }
                }

                if (gradualUpdated) {
                    setLastGradualIncrease(vessel.id, now);
                    needsUpdate = true;
                }
            }
        }

        // Max Guards on Pirate Routes
        if (settings.maxGuardsOnPirateRoutes) {
            var hijackingRisk = getVesselHijackingRisk(vessel);
            if (hijackingRisk > 0 && newGuards < 10) {
                newGuards = 10;
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            if (vessel.status === 'port') {
                return { routeUpdate: { vesselId: vessel.id, speed: vessel.route_speed, guards: newGuards, prices: newPrices } };
            } else {
                bufferPendingRouteSettings(vessel.id, {
                    name: vessel.name,
                    speed: vessel.route_speed,
                    guards: newGuards,
                    prices: newPrices
                });
                return { pending: true };
            }
        }

        return { updated: false, pending: false };
    }

    async function runSmugglersEye(manual) {
        if (!settings.enabled && !manual) {
            return { skipped: true, reason: 'disabled' };
        }

        if (isProcessing) {
            return { skipped: true, reason: 'processing' };
        }

        isProcessing = true;
        var result = { checked: true, updated: 0, pending: 0, error: null };

        try {
            var vessels = await fetchVessels();
            if (!vessels || vessels.length === 0) {
                log('No vessels found');
                return result;
            }

            await initAutoPriceCache(vessels);
            cleanGradualIncreaseData(vessels);

            var routeUpdates = [];
            for (var i = 0; i < vessels.length; i++) {
                var vesselResult = applySmugglersEyeToVessel(vessels[i]);
                if (vesselResult.routeUpdate) {
                    routeUpdates.push(vesselResult.routeUpdate);
                }
                if (vesselResult.pending) {
                    result.pending++;
                }
            }

            // Batch parallel API calls for port vessels
            var routeBatchSize = 5;
            for (var b = 0; b < routeUpdates.length; b += routeBatchSize) {
                var routeBatch = routeUpdates.slice(b, b + routeBatchSize);
                await Promise.all(routeBatch.map(function(update) {
                    return updateRouteData(update.vesselId, update.speed, update.guards, update.prices);
                }));
                if (b + routeBatchSize < routeUpdates.length) {
                    await new Promise(function(r) { setTimeout(r, 300); });
                }
            }
            result.updated = routeUpdates.length;

            // Flush all batched saves
            await flushPendingRouteSettings();
            if (gradualDirty) {
                await saveGradualIncreaseData();
                gradualDirty = false;
            }
            if (autoPriceDirty) {
                await saveAutoPriceCache();
                autoPriceDirty = false;
            }

            if (result.updated > 0 || result.pending > 0) {
                var msg = "Smuggler's Eye: " + result.updated + ' direct, ' + result.pending + ' pending';
                log(msg);
                if (result.updated > 0) {
                    showToast(result.updated + ' vessel(s) updated');
                }
            } else {
                log('No price changes needed');
            }

            return result;
        } catch (error) {
            log('Error: ' + error.message, 'error');
            result.error = error.message;
            return result;
        } finally {
            isProcessing = false;
        }
    }

    // ========== MONITORING ==========
    function startMonitoring() {
        if (monitorInterval) {
            clearInterval(monitorInterval);
        }
        monitorInterval = setInterval(function() {
            runSmugglersEye(false);
        }, CHECK_INTERVAL_MS);
        runSmugglersEye(false);
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
        var prefix = '[SmugglersEye]';
        if (level === 'error') {
            console.error(prefix, message);
        } else {
            console.log(prefix, message);
        }
    }

    function sendSystemNotification(title, message) {
        if (!settings.notifySystem) return;

        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(title + ': ' + message);
                return;
            } catch (e) {
                log('System notification failed: ' + e.message, 'error');
            }
        }

        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(title, {
                        body: message,
                        icon: 'https://shippingmanager.cc/favicon.ico',
                        tag: 'smugglers-eye'
                    });
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
                } catch (err) {
                    log('Toast error: ' + err.message, 'error');
                }
            }
        }
        sendSystemNotification("Smuggler's Eye", message);
    }

    // ========== CUSTOM MODAL (Game-style) ==========
    function injectModalStyles() {
        if (document.getElementById('smuggler-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'smuggler-modal-styles';
        style.textContent = [
            '@keyframes smuggler-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes smuggler-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes smuggler-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes smuggler-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#smuggler-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#smuggler-modal-wrapper #smuggler-modal-background{animation:smuggler-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#smuggler-modal-wrapper.hide #smuggler-modal-background{animation:smuggler-fade-out .15s linear forwards}',
            '#smuggler-modal-wrapper #smuggler-modal-content-wrapper{animation:smuggler-drop-down .15s linear forwards,smuggler-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#smuggler-modal-wrapper.hide #smuggler-modal-content-wrapper{animation:smuggler-push-up .15s linear forwards,smuggler-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#smuggler-modal-wrapper #smuggler-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#smuggler-modal-wrapper #smuggler-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#smuggler-modal-wrapper #smuggler-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#smuggler-modal-wrapper #smuggler-modal-content-wrapper{max-width:100%}}',
            '#smuggler-modal-wrapper #smuggler-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#smuggler-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#smuggler-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#smuggler-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#smuggler-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#smuggler-modal-container #smuggler-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#smuggler-modal-container #smuggler-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#smuggler-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeModal() {
        if (!isModalOpen) return;
        isModalOpen = false;
        var modalWrapper = document.getElementById('smuggler-modal-wrapper');
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

        var existing = document.getElementById('smuggler-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#smuggler-settings-content');
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
        modalWrapper.id = 'smuggler-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'smuggler-modal-background';
        modalBackground.onclick = function() { closeModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'smuggler-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'smuggler-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = "Smuggler's Eye Settings";

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
        modalContent.id = 'smuggler-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'smuggler-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'smuggler-settings-content';
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
        var settingsContent = document.getElementById('smuggler-settings-content');
        if (!settingsContent) return;

        settingsContent.innerHTML = '\
            <div style="padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:flex-start;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="se-enabled" ' + (settings.enabled ? 'checked' : '') + '\
                               style="width:20px;height:20px;margin-right:12px;margin-top:2px;flex-shrink:0;accent-color:#0db8f4;cursor:pointer;">\
                        <span style="text-align:left;"><span>Enable Smuggler\'s Eye</span>\
                        <span style="display:block;font-size:12px;color:#626b90;margin-top:4px;font-weight:400;">This feature runs exclusively in the background. It does not interact with Create Route or Edit Route dialogs and will not modify any sliders or settings there.</span></span>\
                    </label>\
                </div>\
                <div id="se-options-wrapper" style="margin-bottom:20px;' + (settings.enabled ? '' : 'opacity:0.5;pointer-events:none;') + '">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:flex-start;cursor:pointer;">\
                        <input type="checkbox" id="se-instant4" ' + (settings.instant4Percent ? 'checked' : '') + (settings.enabled ? '' : ' disabled') + '\
                               style="width:20px;height:20px;margin-right:12px;margin-top:2px;flex-shrink:0;accent-color:#0db8f4;cursor:pointer;">\
                        <span style="text-align:left;"><span style="font-weight:600;">4% Instant Markup</span>\
                        <span style="display:block;font-size:12px;color:#626b90;margin-top:2px;">Raise prices below 4% to 4%</span></span>\
                    </label>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;">\
                        <input type="checkbox" id="se-gradual" ' + (settings.gradual8Percent ? 'checked' : '') + (settings.enabled ? '' : ' disabled') + '\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span style="font-weight:600;">Gradual Increase</span>\
                    </label>\
                </div>\
                <div id="se-gradual-options" style="margin-bottom:20px;padding-left:32px;' + (settings.gradual8Percent ? '' : 'display:none;') + '">\
                    <div style="display:flex;gap:12px;margin-bottom:12px;">\
                        <div style="flex:1;">\
                            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#01125d;">Step (%)</label>\
                            <input type="number" id="se-step" min="1" max="10" value="' + escapeHtml(settings.gradualIncreaseStep) + '"' + (settings.enabled ? '' : ' disabled') + '\
                                   class="redesign" style="width:100%;height:2rem;padding:0 0.5rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:14px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;">\
                        </div>\
                        <div style="flex:1;">\
                            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#01125d;">Interval (h)</label>\
                            <input type="number" id="se-interval" min="1" max="168" value="' + escapeHtml(settings.gradualIncreaseInterval) + '"' + (settings.enabled ? '' : ' disabled') + '\
                                   class="redesign" style="width:100%;height:2rem;padding:0 0.5rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:14px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;">\
                        </div>\
                        <div style="flex:1;">\
                            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#01125d;">Max (%)</label>\
                            <input type="number" id="se-target" min="1" max="20" value="' + escapeHtml(settings.targetPercent) + '"' + (settings.enabled ? '' : ' disabled') + '\
                                   class="redesign" style="width:100%;height:2rem;padding:0 0.5rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:14px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;">\
                        </div>\
                    </div>\
                    <div style="font-size:11px;color:#626b90;">Increase prices by Step% every Interval hours until Max%</div>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:flex-start;cursor:pointer;">\
                        <input type="checkbox" id="se-guards" ' + (settings.maxGuardsOnPirateRoutes ? 'checked' : '') + (settings.enabled ? '' : ' disabled') + '\
                               style="width:20px;height:20px;margin-right:12px;margin-top:2px;flex-shrink:0;accent-color:#0db8f4;cursor:pointer;">\
                        <span style="text-align:left;"><span style="font-weight:600;">Max Guards on Pirate Routes</span>\
                        <span style="display:block;font-size:12px;color:#626b90;margin-top:2px;">Set 10 guards when hijacking risk > 0%</span></span>\
                    </label>\
                </div>\
                </div>\
                <div style="margin-bottom:24px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="se-notify-ingame" ' + (settings.notifyIngame ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="se-notify-system" ' + (settings.notifySystem ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:30px;">\
                    <button id="se-run-now" style="padding:10px 24px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:500;font-family:Lato,sans-serif;">Run Now</button>\
                    <button id="se-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">Save</button>\
                </div>\
            </div>';

        // Toggle options wrapper enabled/disabled
        document.getElementById('se-enabled').addEventListener('change', function() {
            var wrapper = document.getElementById('se-options-wrapper');
            var inputs = wrapper.querySelectorAll('input');
            var k;
            if (this.checked) {
                wrapper.style.opacity = '';
                wrapper.style.pointerEvents = '';
                for (k = 0; k < inputs.length; k++) { inputs[k].disabled = false; }
            } else {
                wrapper.style.opacity = '0.5';
                wrapper.style.pointerEvents = 'none';
                for (k = 0; k < inputs.length; k++) { inputs[k].disabled = true; }
            }
        });

        // Toggle gradual options visibility
        document.getElementById('se-gradual').addEventListener('change', function() {
            var opts = document.getElementById('se-gradual-options');
            opts.style.display = this.checked ? '' : 'none';
        });

        document.getElementById('se-run-now').addEventListener('click', function() {
            var btn = this;
            btn.disabled = true;
            btn.textContent = 'Running...';
            runSmugglersEye(true).then(function() {
                btn.textContent = 'Run Now';
                btn.disabled = false;
            });
        });

        document.getElementById('se-save').addEventListener('click', function() {
            var enabled = document.getElementById('se-enabled').checked;
            var instant4 = document.getElementById('se-instant4').checked;
            var gradual = document.getElementById('se-gradual').checked;
            var step = Math.max(1, Math.min(10, parseInt(document.getElementById('se-step').value, 10) || 1));
            var interval = Math.max(1, Math.min(168, parseInt(document.getElementById('se-interval').value, 10) || 25));
            var target = Math.max(1, Math.min(20, parseInt(document.getElementById('se-target').value, 10) || 8));
            var guards = document.getElementById('se-guards').checked;
            var notifyIngame = document.getElementById('se-notify-ingame').checked;
            var notifySystem = document.getElementById('se-notify-system').checked;

            var wasEnabled = settings.enabled;
            settings.enabled = enabled;
            settings.instant4Percent = instant4;
            settings.gradual8Percent = gradual;
            settings.gradualIncreaseStep = step;
            settings.gradualIncreaseInterval = interval;
            settings.targetPercent = target;
            settings.maxGuardsOnPirateRoutes = guards;
            settings.notifyIngame = notifyIngame;
            settings.notifySystem = notifySystem;

            saveSettings().then(function() {
                if (enabled && !wasEnabled) {
                    startMonitoring();
                } else if (!enabled && wasEnabled) {
                    stopMonitoring();
                }

                showToast("Smuggler's Eye settings saved");
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
        // Register menu immediately - no DOM needed for IPC call
        addMenuItem("Smuggler's Eye", openSettingsModal, 24);
        initUI();
        injectModalStyles();

        await loadSettings();
        await loadAutoPriceCache();
        await loadGradualIncreaseData();
        setupModalWatcher();

        if (settings.enabled) {
            setTimeout(startMonitoring, 3000);
        }
    }

    // Expose for Android BackgroundScriptService
    if (!window.rebelshipRunSmugglersEye) {
        window.rebelshipRunSmugglersEye = function() {
            return loadSettings().then(function() {
                if (!settings.enabled) {
                    return { skipped: true, reason: 'disabled' };
                }
                return runSmugglersEye(false);
            });
        };
    }

    if (!window.__rebelshipHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    // Register for background job system
    if (!window.rebelshipBackgroundJobs) {
        window.rebelshipBackgroundJobs = [];
    }
    window.rebelshipBackgroundJobs.push({
        name: 'SmugglersEye',
        run: function() { return window.rebelshipRunSmugglersEye(); }
    });
})();
