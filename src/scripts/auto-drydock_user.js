// ==UserScript==
// @name         ShippingManager - Auto Drydock
// @namespace    http://tampermonkey.net/
// @description  Automatic drydock management with bug prevention and moor option
// @version      1.69
// @order        4
// @author       RebelShip
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// @background-job-required true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AutoDrydock';
    var API_BASE = 'https://shippingmanager.cc/api';
    var originalFetch = window.fetch;

    var isModalOpen = false;
    var autoDrydockRunning = false;
    var cachedVessels = null;
    var cachedVesselsTimestamp = 0;
    var VESSEL_CACHE_TTL = 15000; // 15 seconds
    var handleVesselDataDebounceTimer = null;
    var VESSEL_DATA_DEBOUNCE_MS = 10000; // 10 seconds
    var modalTemplateCreated = false;

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

    // Default settings
    var DEFAULT_SETTINGS = {
        autoDrydockEnabled: false,
        autoDrydockThreshold: 75,
        autoDrydockMinCash: 1000000,
        autoDrydockSpeed: 'minimum',
        autoDrydockType: 'major',
        moorInsteadOfDrydock: false,
        notifyIngame: true,
        notifySystem: true
    };

    // ============================================
    // MODAL REGISTRY (shared across scripts)
    // ============================================
    if (!window.RebelShipModalRegistry) {
        window.RebelShipModalRegistry = {
            openModals: new Set(),
            register: function(name) { this.openModals.add(name); },
            unregister: function(name) { this.openModals.delete(name); },
            isOpen: function(name) { return this.openModals.has(name); },
            hasAnyOpen: function() { return this.openModals.size > 0; },
            closeAll: function() {
                this.openModals.forEach(function(name) {
                    window.dispatchEvent(new CustomEvent('rebelship-close-modal', { detail: { name: name } }));
                });
            }
        };
    }

    // ============================================
    // LOGGING
    // ============================================
    function log(msg, level) {
        var prefix = '[AutoDrydock] ';
        if (level === 'error') {
            console.error(prefix + msg);
        } else {
            console.log(prefix + msg);
        }
    }

    // ============================================
    // STORAGE - Own settings, shared queue
    // ============================================
    async function dbGetOwn(key) {
        if (!window.RebelShipBridge || !window.RebelShipBridge.storage) return null;
        try {
            var value = await window.RebelShipBridge.storage.get(SCRIPT_NAME, 'data', key);
            return value ? JSON.parse(value) : null;
        } catch (e) {
            log('dbGetOwn error: ' + e.message, 'error');
            return null;
        }
    }

    async function dbSetOwn(key, value) {
        if (!window.RebelShipBridge || !window.RebelShipBridge.storage) return;
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, 'data', key, JSON.stringify(value));
        } catch (e) {
            log('dbSetOwn error: ' + e.message, 'error');
        }
    }

    // Per-category shared storage with DepartManager (drydockVessels, pendingRouteSettings)
    var RETRY_DELAYS = Object.freeze([500, 1000, 2000, 4000]);

    async function getSharedCategory(category, retryCount) {
        // Use DepartManager's in-memory cache if available (eliminates race conditions)
        if (window._rebelshipDMStorage && window._rebelshipDMStorage.isReady()) {
            return window._rebelshipDMStorage.getCategory(category);
        }
        // Fallback: direct DB read (DepartManager not loaded yet)
        retryCount = retryCount || 0;
        if (!window.RebelShipBridge || !window.RebelShipBridge.storage) return null;
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
                log('getSharedCategory(' + category + ') retry ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ' in ' + delay + 'ms: ' + e.message, 'warn');
                await new Promise(function(r) { setTimeout(r, delay); });
                return getSharedCategory(category, retryCount + 1);
            }
            log('getSharedCategory(' + category + ') FAILED after retries: ' + e.message, 'error');
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
        if (!window.RebelShipBridge || !window.RebelShipBridge.storage) return false;
        try {
            await window.RebelShipBridge.storage.set('DepartManager', 'data', 'st_' + category, JSON.stringify(data));
            return true;
        } catch (e) {
            if (retryCount < RETRY_DELAYS.length) {
                var delay = RETRY_DELAYS[retryCount];
                log('saveSharedCategory(' + category + ') retry ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ' in ' + delay + 'ms: ' + e.message, 'warn');
                await new Promise(function(r) { setTimeout(r, delay); });
                return saveSharedCategory(category, data, retryCount + 1);
            }
            log('saveSharedCategory(' + category + ') FAILED after retries: ' + e.message, 'error');
            return false;
        }
    }

    // Settings
    var settingsCache = null;

    async function loadSettings() {
        var saved = await dbGetOwn('settings');
        settingsCache = {};
        for (var key in DEFAULT_SETTINGS) {
            settingsCache[key] = DEFAULT_SETTINGS[key];
        }
        if (saved) {
            for (var savedKey in saved) {
                settingsCache[savedKey] = saved[savedKey];
            }
        }
        return settingsCache;
    }

    async function saveSettings(newSettings) {
        for (var key in newSettings) {
            settingsCache[key] = newSettings[key];
        }
        await dbSetOwn('settings', settingsCache);
    }

    function getSettings() {
        return settingsCache ? settingsCache : DEFAULT_SETTINGS;
    }

    // ============================================
    // DRYDOCK VESSEL TRACKING (shared storage)
    // CRITICAL: Never create default storage with settings:{} - that corrupts DepartManager!
    // If we can't read storage after retries, refuse to write to prevent data loss.
    // ============================================
    async function saveDrydockVessel(vesselId, data) {
        var drydockVessels = await getSharedCategory('drydockVessels');
        if (drydockVessels === null) {
            log('Cannot save drydock vessel - storage unavailable after retries', 'error');
            return false;
        }
        drydockVessels[vesselId] = data;
        var success = await saveSharedCategory('drydockVessels', drydockVessels);
        if (success) {
            log('Saved drydock vessel: ' + data.name + ' (' + data.status + ')');
        }
        return success;
    }

    async function updateDrydockVesselStatus(vesselId, status) {
        var drydockVessels = await getSharedCategory('drydockVessels');
        if (!drydockVessels || !drydockVessels[vesselId]) return;
        drydockVessels[vesselId].status = status;
        await saveSharedCategory('drydockVessels', drydockVessels);
    }

    async function deleteDrydockVessel(vesselId) {
        var drydockVessels = await getSharedCategory('drydockVessels');
        if (!drydockVessels) return;
        delete drydockVessels[vesselId];
        await saveSharedCategory('drydockVessels', drydockVessels);
    }

    async function getDrydockVesselsByStatus(status) {
        var drydockVessels = await getSharedCategory('drydockVessels');
        if (!drydockVessels) return [];
        var result = [];
        for (var id in drydockVessels) {
            if (drydockVessels[id].status === status) {
                result.push({ vesselId: parseInt(id), data: drydockVessels[id] });
            }
        }
        return result;
    }

    // ============================================
    // PENDING ROUTE SETTINGS (shared storage)
    // CRITICAL: Never create default storage - refuse to write if storage unavailable
    // ============================================
    async function savePendingRouteSettings(vesselId, data) {
        var pendingRouteSettings = await getSharedCategory('pendingRouteSettings');
        if (pendingRouteSettings === null) {
            log('Cannot save pending route - storage unavailable after retries', 'error');
            return false;
        }
        pendingRouteSettings[vesselId] = data;
        var success = await saveSharedCategory('pendingRouteSettings', pendingRouteSettings);
        if (success) {
            log('Saved pending route settings for: ' + data.name);
        }
        return success;
    }

    // ============================================
    // PINIA STORE HELPERS
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

    function getToastStore() {
        return getStore('toast');
    }

    // ============================================
    // NOTIFICATIONS
    // ============================================
    function notify(message, type) {
        var settings = getSettings();
        var formattedMessage = '[AutoDrydock] ' + message;

        if (settings.notifyIngame) {
            try {
                var toastStore = getToastStore();
                if (toastStore) {
                    if (type === 'success' && toastStore.success) {
                        toastStore.success(formattedMessage);
                    } else if (type === 'error' && toastStore.error) {
                        toastStore.error(formattedMessage);
                    } else if (type === 'warning' && toastStore.warning) {
                        toastStore.warning(formattedMessage);
                    } else if (toastStore.info) {
                        toastStore.info(formattedMessage);
                    }
                }
            } catch (e) {
                log('Toast error: ' + e.message);
            }
        }

        if (settings.notifySystem && window.RebelShipNotify && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(formattedMessage);
            } catch (e) {
                log('RebelShipNotify error: ' + e.message);
            }
        }
    }

    // ============================================
    // API FUNCTIONS
    // ============================================
    async function apiFetch(endpoint, body, maxRetries) {
        maxRetries = maxRetries !== undefined ? maxRetries : 3;
        var lastError;

        for (var attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                var response = await originalFetch(API_BASE + endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(body)
                });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return await response.json();
            } catch (e) {
                lastError = e;
                log('API call (' + endpoint + ') attempt ' + attempt + '/' + maxRetries + ' failed: ' + e.message);
                if (attempt < maxRetries) {
                    var delay = attempt * 1000;
                    await new Promise(function(r) { setTimeout(r, delay); });
                }
            }
        }

        log('API call failed (' + endpoint + '): ' + lastError.message, 'error');
        return null;
    }

    async function fetchVesselData() {
        var now = Date.now();
        if (cachedVessels && (now - cachedVesselsTimestamp) < VESSEL_CACHE_TTL) {
            return cachedVessels;
        }
        var data = await apiFetch('/vessel/get-all-user-vessels', { include_routes: true });
        if (data && data.data && data.data.user_vessels) {
            cachedVessels = data.data.user_vessels;
            cachedVesselsTimestamp = now;
            return cachedVessels;
        }
        return [];
    }

    async function fetchUserData() {
        var data = await apiFetch('/user/get-user-settings', {});
        if (data && data.user) {
            return data;
        }
        return null;
    }

    async function sendToDrydock(vesselIds, speed, maintenanceType) {
        if (!Array.isArray(vesselIds) || vesselIds.length === 0) {
            log('sendToDrydock called with invalid vesselIds: ' + JSON.stringify(vesselIds), 'error');
            return null;
        }
        var body = {
            vessel_ids: JSON.stringify(vesselIds),
            speed: speed,
            maintenance_type: maintenanceType
        };
        return await apiFetch('/maintenance/do-major-drydock-maintenance-bulk', body);
    }

    async function getMaintenanceCost(vesselIds, speed, maintenanceType) {
        if (!Array.isArray(vesselIds) || vesselIds.length === 0) {
            log('getMaintenanceCost called with invalid vesselIds: ' + JSON.stringify(vesselIds), 'error');
            return null;
        }
        var body = {
            vessel_ids: JSON.stringify(vesselIds),
            speed: speed,
            maintenance_type: maintenanceType
        };
        var data = await apiFetch('/maintenance/get', body);
        if (data && data.data) return data.data;
        return null;
    }

    async function parkVessel(vesselId) {
        if (!vesselId || typeof vesselId !== 'number') {
            log('parkVessel called with invalid vesselId: ' + vesselId, 'error');
            return null;
        }
        return await apiFetch('/vessel/park-vessel', { vessel_id: vesselId });
    }

    async function updateRouteData(vesselId, speed, guards, prices) {
        if (!vesselId || typeof vesselId !== 'number') {
            log('updateRouteData called with invalid vesselId: ' + vesselId, 'error');
            return null;
        }
        var body = {
            user_vessel_id: vesselId,
            speed: speed,
            guards: guards,
            prices: prices
        };
        var data = await apiFetch('/route/update-route-data', body);
        return data && data.data && data.data.user_vessel;
    }

    // ============================================
    // DRYDOCK BUG PREVENTION - Fetch Interceptor
    // ============================================
    async function handleDrydockRequest(options) {
        if (!options || !options.body) return;

        try {
            var body;
            var vesselIds;
            try {
                body = JSON.parse(options.body);
                vesselIds = JSON.parse(body.vessel_ids);
            } catch (parseError) {
                log('JSON parse error in handleDrydockRequest: ' + parseError.message, 'error');
                return;
            }
            if (!vesselIds || vesselIds.length === 0) return;

            log('Drydock request detected for ' + vesselIds.length + ' vessel(s)');

            var MAX_RETRIES = 3;
            var RETRY_DELAY_MS = 750;

            // Fetch vessel data once before the loop
            var vessels = await fetchVesselData();
            var vesselMap = new Map(vessels.map(function(v) { return [v.id, v]; }));

            for (var i = 0; i < vesselIds.length; i++) {
                var vesselId = vesselIds[i];
                var vessel = null;
                var retryCount = 0;
                var validData = false;

                while (retryCount < MAX_RETRIES && !validData) {
                    if (!vessels || vessels.length === 0) {
                        retryCount++;
                        log('Retry ' + retryCount + '/' + MAX_RETRIES + ': No vessel data received');
                        await new Promise(function(r) { setTimeout(r, RETRY_DELAY_MS); });
                        vessels = await fetchVesselData();
                        vesselMap = new Map(vessels.map(function(v) { return [v.id, v]; }));
                        continue;
                    }

                    vessel = vesselMap.get(vesselId);

                    if (!vessel) {
                        retryCount++;
                        log('Retry ' + retryCount + '/' + MAX_RETRIES + ': Vessel ' + vesselId + ' not found');
                        await new Promise(function(r) { setTimeout(r, RETRY_DELAY_MS); });
                        vessels = await fetchVesselData();
                        vesselMap = new Map(vessels.map(function(v) { return [v.id, v]; }));
                        continue;
                    }

                    if (vessel.route_speed === undefined ||
                        vessel.route_guards === undefined ||
                        !vessel.prices ||
                        vessel.hours_until_check === undefined) {
                        retryCount++;
                        log('Retry ' + retryCount + '/' + MAX_RETRIES + ': ' + vessel.name + ' has incomplete data');
                        await new Promise(function(r) { setTimeout(r, RETRY_DELAY_MS); });
                        vessels = await fetchVesselData();
                        vesselMap = new Map(vessels.map(function(v) { return [v.id, v]; }));
                        continue;
                    }

                    validData = true;
                }

                if (!validData) {
                    if (!vessel) {
                        log('ERROR: Vessel ' + vesselId + ' not found after ' + MAX_RETRIES + ' retries, skipping', 'error');
                        continue;
                    }
                    var missing = [];
                    if (vessel.route_speed === undefined) missing.push('route_speed');
                    if (vessel.route_guards === undefined) missing.push('route_guards');
                    if (!vessel.prices) missing.push('prices');
                    if (vessel.hours_until_check === undefined) missing.push('hours_until_check');
                    log(vessel.name + ': ERROR - Missing fields after ' + MAX_RETRIES + ' retries: ' + missing.join(', '), 'error');
                    continue;
                }

                var hasActiveRoute = (vessel.active_route && vessel.active_route.route_id) || vessel.route_id;
                var isBugUse = !hasActiveRoute;

                await saveDrydockVessel(vesselId, {
                    name: vessel.name,
                    speed: vessel.route_speed,
                    guards: vessel.route_guards,
                    prices: vessel.prices,
                    hoursAtDrydock: vessel.hours_until_check,
                    routeId: vessel.active_route ? vessel.active_route.route_id : null,
                    originPort: vessel.route_origin ? vessel.route_origin : vessel.current_port_code,
                    destinationPort: vessel.route_destination,
                    status: isBugUse ? 'bug_use' : 'pre_drydock'
                });

                if (isBugUse) {
                    log(vessel.name + ': Bug-use detected (no active route)');
                }
            }
        } catch (e) {
            log('Failed to process drydock request: ' + e.message, 'error');
        }
    }

    async function handleVesselDataResponseImpl(data) {
        var vessels = [];
        if (data && data.data && data.data.user_vessels) {
            vessels = data.data.user_vessels;
        } else if (data && data.vessels) {
            vessels = data.vessels;
        }
        if (vessels.length === 0) return;

        // Check if any tracking is active before processing
        var drydockVessels = await getSharedCategory('drydockVessels');
        if (!drydockVessels || Object.keys(drydockVessels).length === 0) {
            return;
        }

        var vesselMap = new Map(vessels.map(function(v) { return [v.id, v]; }));

        // Check bug_use vessels - delete when anchored
        var bugUseVessels = await getDrydockVesselsByStatus('bug_use');
        for (var i = 0; i < bugUseVessels.length; i++) {
            var bugEntry = bugUseVessels[i];
            var bugVessel = vesselMap.get(bugEntry.vesselId);
            if (!bugVessel) {
                await deleteDrydockVessel(bugEntry.vesselId);
                continue;
            }
            // Cache vessel lookup for this iteration
            if (bugVessel.status === 'anchor') {
                log(bugEntry.data.name + ': Bug-use complete (anchored)');
                await deleteDrydockVessel(bugEntry.vesselId);
            }
        }

        // Check pre_drydock vessels - mark as past_drydock when complete
        var preDrydockVessels = await getDrydockVesselsByStatus('pre_drydock');
        for (var j = 0; j < preDrydockVessels.length; j++) {
            var preEntry = preDrydockVessels[j];
            var preVessel = vesselMap.get(preEntry.vesselId);
            if (!preVessel) continue;

            // Cache vessel lookup for this iteration
            if (preVessel.route_dry_operation === 1) continue;
            if (preVessel.status === 'maintenance') continue;

            var currentHours = preVessel.hours_until_check;
            var savedHours = preEntry.data.hoursAtDrydock;

            if (currentHours > savedHours) {
                log(preEntry.data.name + ': Drydock complete (hours: ' + savedHours + ' -> ' + currentHours + ')');
                await updateDrydockVesselStatus(preEntry.vesselId, 'past_drydock');
            }
        }

        // Check past_drydock vessels - restore when in port or anchored
        var pastDrydockVessels = await getDrydockVesselsByStatus('past_drydock');
        for (var k = 0; k < pastDrydockVessels.length; k++) {
            var pastEntry = pastDrydockVessels[k];
            var pastVessel = vesselMap.get(pastEntry.vesselId);
            if (!pastVessel) continue;

            // Cache vessel lookup for this iteration
            if ((pastVessel.status === 'port' || pastVessel.status === 'anchor') && !pastVessel.is_parked) {
                await restoreDrydockSettings(pastEntry.vesselId, pastEntry.data, pastVessel);
            }
        }
    }

    function handleVesselDataResponse(data) {
        if (handleVesselDataDebounceTimer) {
            clearTimeout(handleVesselDataDebounceTimer);
        }
        handleVesselDataDebounceTimer = setTimeout(function() {
            handleVesselDataResponseImpl(data);
            handleVesselDataDebounceTimer = null;
        }, VESSEL_DATA_DEBOUNCE_MS);
    }

    async function restoreDrydockSettings(vesselId, savedData, currentVessel) {
        var needsRestore =
            savedData.speed !== currentVessel.route_speed ||
            savedData.guards !== currentVessel.route_guards ||
            JSON.stringify(savedData.prices) !== JSON.stringify(currentVessel.prices);

        if (!needsRestore) {
            log(savedData.name + ': Settings already match');
            await deleteDrydockVessel(vesselId);
            return;
        }

        log(savedData.name + ': Restoring post-drydock settings');

        var success = await updateRouteData(vesselId, savedData.speed, savedData.guards, savedData.prices);
        if (success) {
            log(savedData.name + ': Settings restored');
            await deleteDrydockVessel(vesselId);
            notify('Restored settings for ' + savedData.name, 'success');
        }
    }

    // Setup fetch interceptor
    window.fetch = async function() {
        var args = arguments;
        var url = args[0];
        var options = args[1];
        var urlStr = typeof url === 'string' ? url : url.toString();

        // Intercept drydock bulk request - save settings BEFORE drydock
        if (urlStr.includes('/maintenance/do-major-drydock-maintenance-bulk')) {
            await handleDrydockRequest(options);
        }

        // Execute original fetch
        var response = await originalFetch.apply(this, args);
        var responseClone = response.clone();

        // Intercept vessel data responses - check drydock completion
        if (urlStr.includes('/vessel/get-vessels') ||
            urlStr.includes('/vessel/get-all-user-vessels') ||
            urlStr.includes('/game/index')) {
            try {
                var data = await responseClone.json();
                handleVesselDataResponse(data);
            } catch {
                // Ignore JSON parse errors
            }
        }

        return response;
    };

    // ============================================
    // AUTO DRYDOCK LOGIC
    // ============================================
    async function runAutoDrydock(manual) {
        if (autoDrydockRunning) {
            log('Auto drydock already running');
            return;
        }

        var settings = getSettings();
        if (!manual && !settings.autoDrydockEnabled) return;

        autoDrydockRunning = true;

        try {
            var vessels = await fetchVesselData();
            if (!vessels || vessels.length === 0) {
                if (manual) notify('No vessels found', 'error');
                return;
            }

            var threshold = settings.autoDrydockThreshold;

            // Filter: below threshold, not already in drydock or going to drydock
            var needsDrydock = vessels.filter(function(v) {
                var belowThreshold = v.hours_until_check <= threshold;
                var notInDrydock = v.status !== 'drydock' && v.status !== 'maintenance';
                var notGoingToDrydock = !v.next_route_is_maintenance && v.route_dry_operation !== 1;
                var notParked = !v.is_parked;
                return belowThreshold && notInDrydock && notGoingToDrydock && notParked;
            });

            log('Drydock check: ' + vessels.length + ' total, ' + needsDrydock.length + ' need drydock (threshold: ' + threshold + 'h)');

            if (needsDrydock.length === 0) {
                if (manual) notify('No vessels need drydock', 'info');
                return;
            }

            // MOOR INSTEAD OF DRYDOCK
            if (settings.moorInsteadOfDrydock) {
                log('Moor instead of drydock enabled - parking ' + needsDrydock.length + ' vessel(s)');

                var mooredCount = 0;
                for (var m = 0; m < needsDrydock.length; m++) {
                    var moorVessel = needsDrydock[m];

                    // Can only park vessels in port
                    if (moorVessel.status === 'port') {
                        var parkResult = await parkVessel(moorVessel.id);
                        if (parkResult && parkResult.data) {
                            mooredCount++;
                            log(moorVessel.name + ': Moored');
                        }
                    } else {
                        // Mark for mooring on arrival
                        await savePendingRouteSettings(moorVessel.id, {
                            name: moorVessel.name,
                            moorOnArrival: true
                        });
                        log(moorVessel.name + ': Marked for mooring on arrival');
                    }

                    await new Promise(function(r) { setTimeout(r, 200); });
                }

                if (mooredCount > 0) {
                    notify('Moored ' + mooredCount + ' vessel(s)', 'success');
                }
                return;
            }

            // NORMAL DRYDOCK FLOW
            log(needsDrydock.length + ' vessel(s) need drydock');

            var vesselIds = needsDrydock.map(function(v) { return v.id; });
            var costSpeedValue = settings.autoDrydockSpeed === 'maximum' ? 'maximum' : 'minimum';

            // Fetch user data only when needed
            var userData = await fetchUserData();
            if (!userData || !userData.user) {
                if (manual) notify('Could not fetch user data', 'error');
                return;
            }

            var cash = userData.user.cash;
            var minCash = settings.autoDrydockMinCash;

            // Get maintenance cost after moor check
            var costData = await getMaintenanceCost(vesselIds, costSpeedValue, settings.autoDrydockType);
            if (!costData) {
                if (manual) notify('Could not get maintenance cost', 'error');
                return;
            }

            var totalCost = 0;
            if (costData.vessels) {
                for (var c = 0; c < costData.vessels.length; c++) {
                    var vCost = costData.vessels[c];
                    totalCost += (settings.autoDrydockType === 'major' ? vCost.major_cost : vCost.minor_cost);
                }
            }

            var cashAfter = cash - totalCost;
            if (cashAfter < minCash) {
                log('Insufficient funds: $' + cash + ' - $' + totalCost + ' = $' + cashAfter + ' < min $' + minCash);
                if (manual) notify('Insufficient funds for drydock', 'error');
                return;
            }

            // Save settings before drydock (bug prevention)
            for (var s = 0; s < needsDrydock.length; s++) {
                var vessel = needsDrydock[s];
                var hasActiveRoute = (vessel.active_route && vessel.active_route.route_id) || vessel.route_id;

                await saveDrydockVessel(vessel.id, {
                    name: vessel.name,
                    speed: vessel.route_speed || vessel.max_speed,
                    guards: vessel.route_guards || 0,
                    prices: vessel.prices || {},
                    hoursAtDrydock: vessel.hours_until_check || 0,
                    routeId: vessel.active_route ? vessel.active_route.route_id : null,
                    originPort: vessel.route_origin || vessel.current_port_code,
                    destinationPort: vessel.route_destination,
                    status: hasActiveRoute ? 'pre_drydock' : 'bug_use'
                });
            }

            var speedValue = settings.autoDrydockSpeed === 'maximum' ? 'maximum' : 'minimum';

            var result = await sendToDrydock(vesselIds, speedValue, settings.autoDrydockType);

            if (result) {
                if (manual) {
                    var vesselNames = needsDrydock.map(function(v) { return v.name; }).join(', ');
                    log('Sent ' + needsDrydock.length + ' vessel(s) to drydock: ' + vesselNames);
                } else {
                    log('Sent ' + needsDrydock.length + ' vessel(s) to drydock');
                }
                notify('Sent ' + needsDrydock.length + ' vessel(s) to drydock', 'success');
            }

        } catch (e) {
            log('Auto drydock error: ' + e.message, 'error');
            if (manual) notify('Error: ' + e.message, 'error');
        } finally {
            autoDrydockRunning = false;
        }
    }

    // ============================================
    // CUSTOM MODAL (Game-style)
    // ============================================
    function injectDrydockModalStyles() {
        if (document.getElementById('drydock-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'drydock-modal-styles';
        style.textContent = [
            '@keyframes drydock-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes drydock-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes drydock-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes drydock-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#drydock-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#drydock-modal-wrapper #drydock-modal-background{animation:drydock-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#drydock-modal-wrapper.hide #drydock-modal-background{animation:drydock-fade-out .15s linear forwards}',
            '#drydock-modal-wrapper #drydock-modal-content-wrapper{animation:drydock-drop-down .15s linear forwards,drydock-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#drydock-modal-wrapper.hide #drydock-modal-content-wrapper{animation:drydock-push-up .15s linear forwards,drydock-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#drydock-modal-wrapper #drydock-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#drydock-modal-wrapper #drydock-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#drydock-modal-wrapper #drydock-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#drydock-modal-wrapper #drydock-modal-content-wrapper{max-width:100%}}',
            '#drydock-modal-wrapper #drydock-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#drydock-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#drydock-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#drydock-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#drydock-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#drydock-modal-container #drydock-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#drydock-modal-container #drydock-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#drydock-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeModal() {
        if (!isModalOpen) return;
        log('Closing modal');
        isModalOpen = false;
        var modalWrapper = document.getElementById('drydock-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }

    function setupDrydockModalWatcher() {
        window.addEventListener('rebelship-menu-click', function() {
            if (isModalOpen) {
                log('RebelShip menu clicked, closing modal');
                closeModal();
            }
        });
    }

    function openSettingsModal() {
        // Close any open game modal first
        var modalStore = getStore('modal');
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectDrydockModalStyles();

        var existing = document.getElementById('drydock-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#drydock-settings-content');
            if (contentCheck) {
                existing.classList.remove('hide');
                isModalOpen = true;
                updateDrydockSettingsContent();
                return;
            }
            existing.remove();
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'drydock-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'drydock-modal-background';
        modalBackground.onclick = function() { closeModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'drydock-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'drydock-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto Drydock Settings';

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
        modalContent.id = 'drydock-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'drydock-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'drydock-settings-content';
        centralContainer.appendChild(settingsContent);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isModalOpen = true;
        updateDrydockSettingsContent();
    }

    function createModalTemplate() {
        var settingsContent = document.getElementById('drydock-settings-content');
        if (!settingsContent) return;

        settingsContent.innerHTML = '\
            <div style="padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="ad-enabled"\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span>Enable Auto-Drydock</span>\
                    </label>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                        Hours Threshold\
                    </label>\
                    <input type="number" id="ad-threshold" min="1" max="999"\
                           class="redesign" style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;">\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;">\
                        Trigger when hours drop below this value\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                        Action Mode\
                    </label>\
                    <select id="ad-mode" class="redesign" style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;box-sizing:border-box;">\
                        <option value="drydock">Send to Drydock</option>\
                        <option value="moor">Moor (Park) Vessel</option>\
                    </select>\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;">\
                        Choose what happens when threshold is reached\
                    </div>\
                </div>\
                <div id="ad-drydock-options">\
                    <div style="margin-bottom:20px;">\
                        <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                            Minimum Cash Balance\
                        </label>\
                        <input type="text" id="ad-mincash" inputmode="numeric"\
                               class="redesign" style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;text-align:center;box-sizing:border-box;">\
                        <div style="font-size:12px;color:#626b90;margin-top:6px;">\
                            Keep at least this much cash after drydock costs\
                        </div>\
                    </div>\
                    <div style="margin-bottom:20px;">\
                        <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                            Drydock Speed\
                        </label>\
                        <select id="ad-speed" class="redesign" style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;box-sizing:border-box;">\
                            <option value="minimum">Minimum (slower, cheaper)</option>\
                            <option value="maximum">Maximum (fast, expensive)</option>\
                        </select>\
                    </div>\
                    <div style="margin-bottom:20px;">\
                        <label style="display:block;margin-bottom:8px;font-size:14px;font-weight:700;color:#01125d;">\
                            Maintenance Type\
                        </label>\
                        <select id="ad-type" class="redesign" style="width:100%;height:2.5rem;padding:0 1rem;background:#ebe9ea;border:0;border-radius:7px;color:#01125d;font-size:16px;font-family:Lato,sans-serif;box-sizing:border-box;">\
                            <option value="major">Major (100% antifouling)</option>\
                            <option value="minor">Minor (60% antifouling)</option>\
                        </select>\
                    </div>\
                </div>\
                <div style="margin-bottom:24px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="ad-notify-ingame"\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="ad-notify-system"\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:30px;">\
                    <button id="ad-run-now" style="padding:10px 24px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:500;font-family:Lato,sans-serif;">Run Now</button>\
                    <button id="ad-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">Save</button>\
                </div>\
                <div style="margin-top:20px;padding:12px;background:#fff;border-radius:6px;border:1px solid #ddd;">\
                    <div style="font-size:12px;color:#626b90;text-align:center;">\
                        Drydock bug prevention is always active (saves route settings before drydock)\
                    </div>\
                </div>\
            </div>';

        // Event delegation for mode change
        settingsContent.addEventListener('change', function(e) {
            if (e.target.id === 'ad-mode') {
                var drydockOpts = document.getElementById('ad-drydock-options');
                if (e.target.value === 'moor') {
                    drydockOpts.style.display = 'none';
                } else {
                    drydockOpts.style.display = '';
                }
            }
        });

        // Event delegation for button clicks
        settingsContent.addEventListener('click', function(e) {
            if (e.target.id === 'ad-run-now') {
                var btn = e.target;
                if (btn.disabled) return;
                btn.disabled = true;
                btn.textContent = 'Running...';
                runAutoDrydock(true).then(function() {
                    btn.textContent = 'Run Now';
                    btn.disabled = false;
                }).catch(function() {
                    btn.textContent = 'Run Now';
                    btn.disabled = false;
                });
            } else if (e.target.id === 'ad-save') {
                var btn = e.target;
                if (btn.disabled) return;
                btn.disabled = true;

                var enabled = document.getElementById('ad-enabled').checked;
                var mode = document.getElementById('ad-mode').value;
                var moorInstead = mode === 'moor';
                var threshold = parseInt(document.getElementById('ad-threshold').value, 10);
                var minCash = getNumericValue(document.getElementById('ad-mincash'));
                var speed = document.getElementById('ad-speed').value;
                var type = document.getElementById('ad-type').value;
                var notifyIngame = document.getElementById('ad-notify-ingame').checked;
                var notifySystem = document.getElementById('ad-notify-system').checked;

                // Validate
                if (isNaN(threshold) || threshold < 1 || threshold > 999) {
                    alert('Hours threshold must be between 1 and 999');
                    btn.disabled = false;
                    return;
                }
                if (!moorInstead && (isNaN(minCash) || minCash < 0)) {
                    alert('Minimum cash must be 0 or greater');
                    btn.disabled = false;
                    return;
                }

                var newSettings = {
                    autoDrydockEnabled: enabled,
                    moorInsteadOfDrydock: moorInstead,
                    autoDrydockThreshold: threshold,
                    autoDrydockMinCash: minCash,
                    autoDrydockSpeed: speed,
                    autoDrydockType: type,
                    notifyIngame: notifyIngame,
                    notifySystem: notifySystem
                };

                saveSettings(newSettings).then(function() {
                    log('Settings saved');
                    notify('Auto Drydock settings saved', 'success');
                    btn.disabled = false;
                    closeModal();
                });
            }
        });

        modalTemplateCreated = true;
    }

    function updateDrydockSettingsContent() {
        if (!modalTemplateCreated) {
            createModalTemplate();
        }

        var settings = getSettings();

        // Update values only
        var enabledEl = document.getElementById('ad-enabled');
        var thresholdEl = document.getElementById('ad-threshold');
        var modeEl = document.getElementById('ad-mode');
        var minCashEl = document.getElementById('ad-mincash');
        var speedEl = document.getElementById('ad-speed');
        var typeEl = document.getElementById('ad-type');
        var notifyIngameEl = document.getElementById('ad-notify-ingame');
        var notifySystemEl = document.getElementById('ad-notify-system');
        var drydockOptsEl = document.getElementById('ad-drydock-options');

        if (enabledEl) enabledEl.checked = settings.autoDrydockEnabled;
        if (thresholdEl) thresholdEl.value = settings.autoDrydockThreshold;
        if (modeEl) modeEl.value = settings.moorInsteadOfDrydock ? 'moor' : 'drydock';
        if (minCashEl) {
            minCashEl.value = formatNumberWithSeparator(settings.autoDrydockMinCash);
            setupThousandSeparator(minCashEl);
        }
        if (speedEl) speedEl.value = settings.autoDrydockSpeed;
        if (typeEl) typeEl.value = settings.autoDrydockType;
        if (notifyIngameEl) notifyIngameEl.checked = settings.notifyIngame;
        if (notifySystemEl) notifySystemEl.checked = settings.notifySystem;
        if (drydockOptsEl) drydockOptsEl.style.display = settings.moorInsteadOfDrydock ? 'none' : '';
    }

    // ============================================
    // AUTO-RUN INTERVAL
    // ============================================
    var autoRunInterval = null;

    function startAutoRun() {
        if (autoRunInterval) return;
        autoRunInterval = setInterval(function() {
            var settings = getSettings();
            if (settings.autoDrydockEnabled) {
                runAutoDrydock(false);
            }
        }, 15 * 60 * 1000); // 15 minutes (background service compatible)
    }

    // ============================================
    // INITIALIZATION
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
            log('Max UI retries reached, running in background mode');
            return;
        }

        uiInitialized = true;
    }

    async function init() {
        log('Initializing v1.5...');

        // Register menu immediately - no DOM needed for IPC call
        if (typeof addMenuItem === 'function') {
            addMenuItem('Auto Drydock', openSettingsModal, 25);
        }
        initUI();

        await loadSettings();
        setupDrydockModalWatcher();

        if (settingsCache && settingsCache.autoDrydockEnabled) {
            setTimeout(startAutoRun, 3000);
        }
    }

    // Expose for Android BackgroundScriptService
    window.rebelshipRunAutoDrydock = function() {
        return loadSettings().then(function() {
            if (!settingsCache || !settingsCache.autoDrydockEnabled) {
                return { skipped: true, reason: 'disabled' };
            }
            return runAutoDrydock(false);
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
        name: 'AutoDrydock',
        run: function() { return window.rebelshipRunAutoDrydock(); }
    });
})();
