// ==UserScript==
// @name         ShippingManager - Demand Summary
// @namespace    https://rebelship.org/
// @description  Demand & ranking dashboard with map tooltips, CSV export, and route-popup demand/vessel filters
// @version      5.16
// @author       https://github.com/justonlyforyou/
// @order        10
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// @enabled      false
// ==/UserScript==

/* global addMenuItem */
(function() {
    'use strict';

    const SCRIPT_NAME = 'DemandSummary';
    const STORE_NAME = 'data';
    const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
    const RANKING_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
    const RANKING_BATCH_SIZE = 5; // Ports per batch
    const RANKING_RETRY_BATCH_SIZE = 3; // Reduced batch size for retries
    const RANKING_BATCH_DELAY_MS = 2000; // Delay between batches
    const API_BASE = 'https://shippingmanager.cc/api';

    // ========== REBELSHIPBRIDGE STORAGE ==========
    var RETRY_DELAYS = [500, 1000, 2000, 4000];

    async function dbGet(key, retryCount) {
        retryCount = retryCount || 0;
        if (!window.RebelShipBridge) {
            console.error('[' + SCRIPT_NAME + '] FATAL: RebelShipBridge not found!');
            return null;
        }
        if (!window.RebelShipBridge.storage) {
            console.error('[' + SCRIPT_NAME + '] FATAL: RebelShipBridge.storage not found!');
            return null;
        }
        try {
            console.log('[' + SCRIPT_NAME + '] dbGet(' + key + ') calling storage.get...');
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            console.log('[' + SCRIPT_NAME + '] dbGet(' + key + ') raw result: ' + (result ? result.substring(0, 100) + '...' : 'NULL'));
            if (result) {
                var parsed = JSON.parse(result);
                console.log('[' + SCRIPT_NAME + '] dbGet(' + key + ') parsed OK');
                return parsed;
            }
            console.log('[' + SCRIPT_NAME + '] dbGet(' + key + ') returned null/empty');
            return null;
        } catch (e) {
            console.error('[' + SCRIPT_NAME + '] dbGet(' + key + ') ERROR: ' + e.message);
            if (retryCount < RETRY_DELAYS.length) {
                var delay = RETRY_DELAYS[retryCount];
                console.log('[' + SCRIPT_NAME + '] dbGet retry ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ' in ' + delay + 'ms');
                await new Promise(function(r) { setTimeout(r, delay); });
                return dbGet(key, retryCount + 1);
            }
            console.error('[' + SCRIPT_NAME + '] dbGet FAILED after all retries: ' + e.message);
            return null;
        }
    }

    async function dbSet(key, value, retryCount) {
        retryCount = retryCount || 0;
        if (!window.RebelShipBridge) {
            console.error('[' + SCRIPT_NAME + '] FATAL: RebelShipBridge not found for SET!');
            return false;
        }
        if (!window.RebelShipBridge.storage) {
            console.error('[' + SCRIPT_NAME + '] FATAL: RebelShipBridge.storage not found for SET!');
            return false;
        }
        try {
            var jsonStr = JSON.stringify(value);
            console.log('[' + SCRIPT_NAME + '] dbSet(' + key + ') size=' + jsonStr.length + ' bytes');
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, jsonStr);
            console.log('[' + SCRIPT_NAME + '] dbSet(' + key + ') SUCCESS');
            // VERIFY: Read back immediately
            var verify = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (verify) {
                console.log('[' + SCRIPT_NAME + '] dbSet(' + key + ') VERIFIED - data persisted');
            } else {
                console.error('[' + SCRIPT_NAME + '] dbSet(' + key + ') VERIFY FAILED - data NOT persisted!');
            }
            return true;
        } catch (e) {
            console.error('[' + SCRIPT_NAME + '] dbSet(' + key + ') ERROR: ' + e.message);
            if (retryCount < RETRY_DELAYS.length) {
                var delay = RETRY_DELAYS[retryCount];
                console.log('[' + SCRIPT_NAME + '] dbSet retry ' + (retryCount + 1) + '/' + RETRY_DELAYS.length + ' in ' + delay + 'ms');
                await new Promise(function(r) { setTimeout(r, delay); });
                return dbSet(key, value, retryCount + 1);
            }
            console.error('[' + SCRIPT_NAME + '] dbSet FAILED after all retries: ' + e.message);
            return false;
        }
    }

    // ========== SETTINGS ==========
    var demandSettings = { mapTooltipsEnabled: true };

    async function loadSettings() {
        var saved = await dbGet('settings');
        if (saved && typeof saved === 'object') {
            if (saved.mapTooltipsEnabled !== undefined) demandSettings.mapTooltipsEnabled = saved.mapTooltipsEnabled;
        }
    }

    async function saveSettings() {
        await dbSet('settings', demandSettings);
    }

    // Get storage key for demand cache
    function getStorageKey() {
        return 'demandCache';
    }

    // Strip raw API fields - keep only what the script uses
    function slimPort(p) {
        return {
            code: p.code,
            demand: p.demand,
            consumed: p.consumed,
            lat: p.lat,
            lon: p.lon
        };
    }

    // ========== LOGGING ==========
    function log(msg, level) {
        const prefix = '[' + SCRIPT_NAME + '] ';
        if (level === 'error') {
            console.error(prefix + msg);
        } else {
            console.log(prefix + msg);
        }
    }

    // ========== PINIA STORE ACCESS ==========
    function getPinia() {
        try {
            const appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            const app = appEl.__vue_app__;
            return app._context.provides.pinia || app.config.globalProperties.$pinia;
        } catch {
            return null;
        }
    }

    function getStore(name) {
        try {
            const pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get(name);
        } catch {
            return null;
        }
    }

    function getModalStore() { return getStore('modal'); }
    function getToastStore() { return getStore('toast'); }
    function getVesselStore() { return getStore('vessel'); }
    function getGameStore() { return getStore('game'); }

    function showToast(message, type) {
        type = type || 'success';
        const toastStore = getToastStore();
        if (toastStore) {
            try {
                if (type === 'error' && toastStore.error) {
                    toastStore.error(message);
                } else if (toastStore.success) {
                    toastStore.success(message);
                }
            } catch {
                log('Toast error', 'error');
            }
        }
    }

    // ========== CACHE MANAGEMENT (REBELSHIPBRIDGE) ==========
    // In-memory cache for sync access (loaded on init)
    let cachedData = null;
    let rankingCache = null;

    async function loadCache() {
        try {
            const saved = await dbGet(getStorageKey());
            if (saved) {
                if (saved.ports) {
                    saved.ports = saved.ports.map(slimPort);
                }
                cachedData = saved;
            }
        } catch (e) {
            log('Failed to load cache: ' + e.message, 'error');
        }
        try {
            const savedRanking = await dbGet('rankingCache');
            if (savedRanking) {
                rankingCache = savedRanking;
                await fetchMyAllianceName();
                patchRankingCacheMyAlliance();
            }
        } catch (e) {
            log('Failed to load ranking cache: ' + e.message, 'error');
        }
        return cachedData;
    }

    var cachedMyAllianceName = null;

    function getMyAllianceName() {
        if (cachedMyAllianceName) return cachedMyAllianceName;
        try {
            var allianceStore = getStore('alliance');
            if (allianceStore && allianceStore.alliance && allianceStore.alliance.name) {
                cachedMyAllianceName = allianceStore.alliance.name;
                return cachedMyAllianceName;
            }
        } catch {
            // ignore
        }
        return null;
    }

    async function fetchMyAllianceName() {
        if (cachedMyAllianceName) return cachedMyAllianceName;
        try {
            var response = await fetch(API_BASE + '/alliance/get-user-alliance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({})
            });
            if (!response.ok) return null;
            var data = await response.json();
            if (data.data && data.data.alliance && data.data.alliance.name) {
                cachedMyAllianceName = data.data.alliance.name;
                return cachedMyAllianceName;
            }
        } catch {
            // ignore
        }
        return null;
    }

    function patchRankingCacheMyAlliance() {
        if (!rankingCache || !rankingCache.ports) return;
        var myName = getMyAllianceName();
        if (!myName) return; // Store not ready yet, try again next call
        rankingCachePatched = true;
        var ports = rankingCache.ports;
        for (var portCode in ports) {
            var entry = ports[portCode];
            if (!entry.myAlliance && entry.topAlliances) {
                for (var i = 0; i < entry.topAlliances.length; i++) {
                    if (entry.topAlliances[i].name === myName) {
                        entry.myAlliance = entry.topAlliances[i];
                        break;
                    }
                }
            }
        }
    }

    // Sync version for functions that can't be async (uses in-memory cache)
    function loadCacheSync() {
        return cachedData;
    }

    var rankingCachePatched = false;

    function loadRankingCacheSync() {
        if (rankingCache && !rankingCachePatched) {
            patchRankingCacheMyAlliance();
        }
        return rankingCache;
    }

    async function saveCache(data) {
        try {
            var vesselSnapshot = getVesselsByPort();
            const cacheData = {
                timestamp: Date.now(),
                ports: data.map(slimPort),
                vesselCounts: Object.keys(vesselSnapshot).length > 0 ? vesselSnapshot : undefined
            };
            await dbSet(getStorageKey(), cacheData);
            cachedData = cacheData;
            return true;
        } catch (e) {
            log('Failed to save cache: ' + e.message, 'error');
            return false;
        }
    }

    function canCollect() {
        const cache = loadCacheSync();
        if (!cache || !cache.timestamp) return true;
        const elapsed = Date.now() - cache.timestamp;
        return elapsed >= COOLDOWN_MS;
    }

    function getTimeUntilNextCollect() {
        const cache = loadCacheSync();
        if (!cache || !cache.timestamp) return 0;
        const elapsed = Date.now() - cache.timestamp;
        const remaining = COOLDOWN_MS - elapsed;
        return remaining > 0 ? remaining : 0;
    }

    function canCollectRanking() {
        const cache = loadRankingCacheSync();
        if (!cache || !cache.timestamp) return true;
        const elapsed = Date.now() - cache.timestamp;
        return elapsed >= RANKING_COOLDOWN_MS;
    }

    function getTimeUntilNextRankingCollect() {
        const cache = loadRankingCacheSync();
        if (!cache || !cache.timestamp) return 0;
        const elapsed = Date.now() - cache.timestamp;
        const remaining = RANKING_COOLDOWN_MS - elapsed;
        return remaining > 0 ? remaining : 0;
    }

    function formatCooldownTime(ms) {
        const mins = Math.ceil(ms / 60000);
        return mins + ' min';
    }

    function getRefreshButtonText() {
        if (isCollecting) return 'Collecting...';
        if (!canCollect()) return 'Wait ' + formatCooldownTime(getTimeUntilNextCollect());
        return 'Refresh All';
    }

    function getRefreshButtonStyle() {
        const canRefresh = canCollect() && !isCollecting;
        if (canRefresh) {
            return 'background:linear-gradient(180deg,#46ff33,#129c00);cursor:pointer;';
        }
        return 'background:#9ca3af;cursor:not-allowed;';
    }

    function getRefreshButtonHtml(id) {
        const disabled = !canCollect() || isCollecting ? ' disabled' : '';
        return '<button id="' + id + '" style="margin-top:8px;width:100%;padding:6px 12px;' + getRefreshButtonStyle() + 'border:0;border-radius:4px;color:#fff;font-size:11px;font-weight:500;"' + disabled + '>' + getRefreshButtonText() + '</button>';
    }

    async function refreshAllPorts() {
        if (isCollecting) return;
        if (!canCollect()) {
            showToast('Please wait ' + formatCooldownTime(getTimeUntilNextCollect()), 'error');
            return;
        }
        await collectDemand();
    }

    // ========== API FUNCTIONS ==========
    async function fetchAllPortCodes(maxRetries) {
        // Get port codes from game store or API
        const gameStore = getGameStore();
        if (gameStore && gameStore.ports && gameStore.ports.length > 0) {
            return gameStore.ports.map(p => p.code);
        }

        // Fallback: fetch from API with retry
        maxRetries = maxRetries ?? 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(API_BASE + '/game/index', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({})
                });

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                const data = await response.json();
                if (!data.data || !data.data.ports) {
                    throw new Error('No ports in game index');
                }

                return data.data.ports.map(p => p.code);
            } catch (e) {
                lastError = e;
                log('fetchAllPortCodes attempt ' + attempt + '/' + maxRetries + ' failed: ' + e.message);
                if (attempt < maxRetries) {
                    const delay = attempt * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    async function fetchPortsDemand(portCodes, maxRetries) {
        // Fetch in batches of 50 to avoid request size issues
        const BATCH_SIZE = 50;
        const allPorts = [];
        maxRetries = maxRetries ?? 3;

        for (let i = 0; i < portCodes.length; i += BATCH_SIZE) {
            const batch = portCodes.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            let lastError;
            let success = false;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(API_BASE + '/port/get-ports', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ port_code: batch })
                    });

                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status);
                    }

                    const data = await response.json();
                    if (data.data && data.data.port) {
                        allPorts.push(...data.data.port);
                    }
                    success = true;
                    break;
                } catch (e) {
                    lastError = e;
                    log('fetchPortsDemand batch ' + batchNum + ' attempt ' + attempt + '/' + maxRetries + ' failed: ' + e.message);
                    if (attempt < maxRetries) {
                        const delay = attempt * 1000;
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            if (!success) {
                throw new Error('Failed to fetch ports batch ' + batchNum + ': ' + lastError.message);
            }

            // Small delay between batches
            if (i + BATCH_SIZE < portCodes.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        return allPorts;
    }

    // WICHTIG: Ranking API akzeptiert NUR einzelne Strings, KEINE Arrays!
    // Das ist ANDERS als die Demand API (/port/get-ports) die Arrays akzeptiert.
    // Deshalb: Einzelne Calls parallel mit Promise.all ausfuehren.
    async function fetchPortRanking(portCode, maxRetries) {
        maxRetries = maxRetries ?? 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(API_BASE + '/port/get-alliance-data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ port_code: portCode })
                });

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                const data = await response.json();
                if (data.data && Array.isArray(data.data.top_alliances)) {
                    var myAlliance = data.data.my_alliance;
                    if (!myAlliance) {
                        // Use cached alliance name (fetched once during init, not per-port)
                        var myName = cachedMyAllianceName || getMyAllianceName();
                        if (myName) {
                            for (var t = 0; t < data.data.top_alliances.length; t++) {
                                if (data.data.top_alliances[t].name === myName) {
                                    myAlliance = data.data.top_alliances[t];
                                    break;
                                }
                            }
                        }
                    }
                    return {
                        topAlliances: data.data.top_alliances,
                        myAlliance: myAlliance
                    };
                }
                return null;
            } catch (e) {
                lastError = e;
                if (attempt < maxRetries) {
                    // Exponential backoff: 500ms, 1000ms, 2000ms... doubled for 429/503
                    var baseDelay = attempt * 500;
                    var isRateLimit = e.message && (e.message.includes('429') || e.message.includes('503'));
                    var delay = isRateLimit ? baseDelay * 2 : baseDelay;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        log('fetchPortRanking ' + portCode + ' failed after ' + maxRetries + ' attempts: ' + lastError.message, 'error');
        return null;
    }


    function getPortLastUpdated(portCode) {
        const cache = loadCacheSync();
        if (!cache) return null;
        if (cache.portTimestamps && cache.portTimestamps[portCode]) {
            return cache.portTimestamps[portCode];
        }
        return cache.timestamp;
    }

    // Cached vessel data - invalidated via Pinia $subscribe on vesselStore
    var vesselsByPortCache = null;
    var vesselStoreSubscribed = false;

    function invalidateVesselsByPortCache() {
        vesselsByPortCache = null;
    }

    function subscribeVesselStore() {
        if (vesselStoreSubscribed) return;
        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.$subscribe) return;
        vesselStoreSubscribed = true;
        vesselStore.$subscribe(function() {
            invalidateVesselsByPortCache();
        });
    }

    function getVesselsByPort() {
        // Return cached result if available
        if (vesselsByPortCache) return vesselsByPortCache;

        const vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return {};

        // Subscribe to store changes for cache invalidation (once)
        subscribeVesselStore();

        const result = {};

        function ensurePort(portCode) {
            if (!result[portCode]) {
                result[portCode] = {
                    // Destination (vessels heading TO this port)
                    destContainerCount: 0,
                    destTankerCount: 0,
                    destContainerCapacity: 0,
                    destTankerCapacity: 0,
                    // Origin (vessels departing FROM this port)
                    originContainerCount: 0,
                    originTankerCount: 0,
                    originContainerCapacity: 0,
                    originTankerCapacity: 0
                };
            }
        }

        function getCapacity(vessel) {
            const cap = vessel.capacity || {};
            const capMax = vessel.capacity_max || {};
            if (vessel.capacity_type === 'container') {
                return (cap.dry || capMax.dry || 0) + (cap.refrigerated || capMax.refrigerated || 0);
            } else if (vessel.capacity_type === 'tanker') {
                return (cap.fuel || capMax.fuel || 0) + (cap.crude_oil || capMax.crude_oil || 0);
            }
            return 0;
        }

        for (const vessel of vesselStore.userVessels) {
            const dest = vessel.route_destination;
            const origin = vessel.route_origin;
            const capacity = getCapacity(vessel);
            const isContainer = vessel.capacity_type === 'container';
            const isTanker = vessel.capacity_type === 'tanker';

            // Track destination
            if (dest) {
                ensurePort(dest);
                if (isContainer) {
                    result[dest].destContainerCount++;
                    result[dest].destContainerCapacity += capacity;
                } else if (isTanker) {
                    result[dest].destTankerCount++;
                    result[dest].destTankerCapacity += capacity;
                }
            }

            // Track origin
            if (origin) {
                ensurePort(origin);
                if (isContainer) {
                    result[origin].originContainerCount++;
                    result[origin].originContainerCapacity += capacity;
                } else if (isTanker) {
                    result[origin].originTankerCount++;
                    result[origin].originTankerCapacity += capacity;
                }
            }
        }

        vesselsByPortCache = result;
        return result;
    }

    // Legacy wrapper for table display
    function getVesselsByDestination() {
        const byPort = getVesselsByPort();
        const result = {};
        for (const portCode in byPort) {
            const p = byPort[portCode];
            result[portCode] = {
                containerCount: p.destContainerCount,
                tankerCount: p.destTankerCount,
                containerCapacity: p.destContainerCapacity,
                tankerCapacity: p.destTankerCapacity
            };
        }
        return result;
    }

    function getVesselsByPortWithFallback() {
        var live = getVesselsByPort();
        if (Object.keys(live).length > 0) return live;
        var cache = loadCacheSync();
        return (cache && cache.vesselCounts) ? cache.vesselCounts : {};
    }

    function getVesselsByDestinationWithFallback() {
        var live = getVesselsByDestination();
        if (Object.keys(live).length > 0) return live;
        var cache = loadCacheSync();
        if (!cache || !cache.vesselCounts) return {};
        var result = {};
        for (var portCode in cache.vesselCounts) {
            var p = cache.vesselCounts[portCode];
            result[portCode] = {
                containerCount: p.destContainerCount,
                tankerCount: p.destTankerCount,
                containerCapacity: p.destContainerCapacity,
                tankerCapacity: p.destTankerCapacity
            };
        }
        return result;
    }

    // ========== MOBILE ZOOM ==========
    let originalViewport = null;

    function enableMobileZoom() {
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            originalViewport = viewport.getAttribute('content');
            viewport.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes');
        }
    }

    function restoreViewport() {
        if (originalViewport !== null) {
            const viewport = document.querySelector('meta[name="viewport"]');
            if (viewport) {
                viewport.setAttribute('content', originalViewport);
            }
            originalViewport = null;
        }
    }

    // ========== MODAL ==========
    let isCollecting = false;
    let isCollectingRanking = false;
    let rankingProgress = { current: 0, total: 0 };
    let currentSortColumn = 'currentTEU'; // default sort column
    let currentSortOrder = 'desc'; // 'desc' or 'asc'
    let currentFilter = 'all';
    let activeModalContainer = null;
    let savedScrollPosition = 0;
    let pendingReturn = false;
    let isDemandModalOpen = false;
    let modalListenerAttached = false;

    let routeFilterInjected = false;
    let routeFilterBaselinePorts = null;
    let routeFilterDropdownOpen = null;
    let noVesselsFilterActive = false;
    let activeDemandFilter = { teu: null, bbl: null };

    var TEU_RANGES = [
        { label: 'All', min: 0 },
        { label: '>10k TEU', min: 10000 },
        { label: '>20k TEU', min: 20000 },
        { label: '>50k TEU', min: 50000 },
        { label: '>75k TEU', min: 75000 },
        { label: '>100k TEU', min: 100000 },
        { label: '>125k TEU', min: 125000 },
        { label: '>150k TEU', min: 150000 },
        { label: '>200k TEU', min: 200000 }
    ];

    var BBL_RANGES = [
        { label: 'All', min: 0 },
        { label: '>2M BBL', min: 2000000 },
        { label: '>5M BBL', min: 5000000 },
        { label: '>8M BBL', min: 8000000 },
        { label: '>10M BBL', min: 10000000 },
        { label: '>15M BBL', min: 15000000 },
        { label: '>20M BBL', min: 20000000 }
    ];

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatNumber(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toString();
    }

    function capitalizePortName(code) {
        return code.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }

    function formatTimestamp(ts) {
        if (!ts) return 'Never';
        const date = new Date(ts);
        return date.toLocaleString();
    }

    // ========== CUSTOM MODAL (Game-style) ==========
    function injectDemandModalStyles() {
        if (document.getElementById('demand-modal-styles')) return;

        const style = document.createElement('style');
        style.id = 'demand-modal-styles';
        style.textContent = [
            '@keyframes demand-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes demand-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes demand-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes demand-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#demand-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#demand-modal-wrapper #demand-modal-background{animation:demand-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#demand-modal-wrapper.hide #demand-modal-background{animation:demand-fade-out .15s linear forwards}',
            '#demand-modal-wrapper #demand-modal-content-wrapper{animation:demand-drop-down .15s linear forwards,demand-fade-in .15s linear forwards;height:100%;max-width:460px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#demand-modal-wrapper.hide #demand-modal-content-wrapper{animation:demand-push-up .15s linear forwards,demand-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#demand-modal-wrapper #demand-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#demand-modal-wrapper #demand-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#demand-modal-wrapper #demand-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#demand-modal-wrapper #demand-modal-content-wrapper{max-width:100%}}',
            '#demand-modal-wrapper #demand-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#demand-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#demand-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#demand-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#demand-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#demand-modal-container #demand-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#demand-modal-container #demand-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:0}',
            '#demand-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    // Modal close: lazy re-attach pattern.
    // On close, we only hide via CSS (classList.add('hide')), NOT remove from DOM.
    // On re-open, we check if the modal element still exists and just remove 'hide'.
    // Event listeners stay attached because the DOM nodes are reused, not recreated.
    // This avoids accumulating listeners without needing complex removeEventListener.
    // The renderModalContent() call on re-open refreshes innerHTML and re-attaches
    // handlers to the new inner elements each time.
    function closeDemandModal() {
        if (!isDemandModalOpen) return;
        log('Closing modal');
        isDemandModalOpen = false;
        // Stop ranking collection if running (cleanup on modal close)
        isCollectingRanking = false;
        if (rankingAbortController) {
            rankingAbortController.abort();
            rankingAbortController = null;
        }
        restoreViewport();
        const modalWrapper = document.getElementById('demand-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }

    function setupDemandModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        window.addEventListener('rebelship-menu-click', function() {
            if (isDemandModalOpen) {
                log('RebelShip menu clicked, closing modal');
                closeDemandModal();
            }
        });
    }

    // ========== HOVER TOOLTIP ==========
    let tooltipElement = null;
    let tooltipTimeout = null;
    let longPressTimer = null;
    const LONG_PRESS_DURATION = 500;

    function createTooltip() {
        if (tooltipElement) return tooltipElement;

        tooltipElement = document.createElement('div');
        tooltipElement.id = 'demand-tooltip';
        tooltipElement.style.cssText = 'position:fixed;display:none;background:#1f2937;border:1px solid #374151;border-radius:6px;padding:12px;min-width:200px;max-width:300px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-size:12px;color:#fff;pointer-events:auto;';
        document.body.appendChild(tooltipElement);
        return tooltipElement;
    }

    function hideTooltip() {
        if (tooltipElement) {
            tooltipElement.style.display = 'none';
        }
    }

    function hideTooltipDelayed() {
        tooltipTimeout = setTimeout(function() {
            hideTooltip();
        }, 200);
    }

    function showRankTooltip(portCode, cellElement) {
        const rankings = loadRankingCacheSync();
        if (!rankings || !rankings.ports || !rankings.ports[portCode]) {
            showToast('No ranking data for this port', 'info');
            return;
        }

        const portRanking = rankings.ports[portCode];
        const tooltip = createTooltip();

        let html = '<div style="font-weight:bold;font-size:14px;margin-bottom:8px;color:#f59e0b;">' + escapeHtml(capitalizePortName(portCode)) + '</div>';

        // My Alliance
        if (portRanking.myAlliance) {
            html += '<div style="margin-bottom:8px;">';
            html += '<div style="font-size:16px;font-weight:bold;color:#4ade80;">#' + portRanking.myAlliance.rank + ' ' + escapeHtml(portRanking.myAlliance.name) + '</div>';
            html += '<div style="font-size:11px;color:#9ca3af;margin-top:2px;">TEU: ' + formatNumber(portRanking.myAlliance.teu) + ' | BBL: ' + formatNumber(portRanking.myAlliance.bbl) + '</div>';
            html += '</div>';
        } else {
            html += '<div style="color:#9ca3af;margin-bottom:8px;">Your alliance has no rank here</div>';
        }

        // Top Alliances
        if (portRanking.topAlliances && portRanking.topAlliances.length > 0) {
            html += '<div style="border-top:1px solid #374151;padding-top:8px;">';
            html += '<div style="color:#9ca3af;font-size:10px;margin-bottom:6px;">TOP ALLIANCES</div>';
            for (var i = 0; i < portRanking.topAlliances.length; i++) {
                var ally = portRanking.topAlliances[i];
                var rankColor = i === 0 ? '#ffd700' : (i === 1 ? '#c0c0c0' : (i === 2 ? '#cd7f32' : '#fff'));
                html += '<div style="margin-bottom:4px;">';
                html += '<div style="color:' + rankColor + ';font-weight:bold;">#' + ally.rank + ' ' + escapeHtml(ally.name) + '</div>';
                html += '<div style="font-size:10px;color:#9ca3af;margin-left:16px;">TEU: ' + formatNumber(ally.teu) + ' | BBL: ' + formatNumber(ally.bbl) + '</div>';
                html += '</div>';
            }
            html += '</div>';
        }

        // Last updated
        if (rankings.timestamp) {
            html += '<div style="color:#6b7280;font-size:10px;margin-top:8px;padding-top:8px;border-top:1px solid #374151;">';
            html += 'Updated: ' + formatTimestamp(rankings.timestamp);
            html += '</div>';
        }

        // Close button for mobile
        html += '<div style="text-align:center;margin-top:8px;">';
        html += '<button id="rank-tooltip-close" style="padding:4px 16px;background:#374151;border:0;border-radius:4px;color:#fff;font-size:11px;cursor:pointer;">Close</button>';
        html += '</div>';

        tooltip.innerHTML = html;

        // Position tooltip near the cell
        tooltip.style.visibility = 'hidden';
        tooltip.style.display = 'block';
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;
        tooltip.style.visibility = 'visible';

        const rect = cellElement.getBoundingClientRect();
        const padding = 10;
        let left, top;

        // Center horizontally on screen for mobile-friendliness
        left = Math.max(padding, (window.innerWidth - tooltipWidth) / 2);

        // Position below the cell
        top = rect.bottom + padding;
        if (top + tooltipHeight > window.innerHeight - padding) {
            top = rect.top - tooltipHeight - padding;
        }
        if (top < padding) {
            top = padding;
        }

        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';

        // Close button handler
        const closeBtn = document.getElementById('rank-tooltip-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                hideTooltip();
            });
        }
    }

    function exportToCSV(ports, vesselsByDest) {
        if (!ports || ports.length === 0) {
            showToast('No data to export', 'error');
            return;
        }

        const rankings = loadRankingCacheSync();
        const rankingPorts = rankings ? rankings.ports : {};

        // CSV header
        const headers = [
            'Port',
            'Max TEU',
            'Current TEU',
            'Max BBL',
            'Current BBL',
            'Dry Demand',
            'Dry Consumed',
            'Refrigerated Demand',
            'Refrigerated Consumed',
            'Fuel Demand',
            'Fuel Consumed',
            'Crude Oil Demand',
            'Crude Oil Consumed',
            'Container Vessels',
            'Container Capacity',
            'Tanker Vessels',
            'Tanker Capacity',
            'Alliance Rank',
            'Alliance TEU',
            'Alliance BBL'
        ];

        const rows = [headers.join(',')];

        for (const port of ports) {
            const demand = port.demand || {};
            const consumed = port.consumed || {};
            const containerDemand = demand.container || {};
            const containerConsumed = consumed.container || {};
            const tankerDemand = demand.tanker || {};
            const tankerConsumed = consumed.tanker || {};
            const vessels = vesselsByDest[port.code] || {};
            const portRanking = rankingPorts[port.code];
            const myAlliance = portRanking ? portRanking.myAlliance : null;

            const maxTEU = (containerDemand.dry || 0) + (containerDemand.refrigerated || 0);
            const currentTEU = Math.max(0, maxTEU - (containerConsumed.dry || 0) - (containerConsumed.refrigerated || 0));
            const maxBBL = (tankerDemand.fuel || 0) + (tankerDemand.crude_oil || 0);
            const currentBBL = Math.max(0, maxBBL - (tankerConsumed.fuel || 0) - (tankerConsumed.crude_oil || 0));

            const row = [
                capitalizePortName(port.code),
                maxTEU,
                currentTEU,
                maxBBL,
                currentBBL,
                containerDemand.dry || 0,
                containerConsumed.dry || 0,
                containerDemand.refrigerated || 0,
                containerConsumed.refrigerated || 0,
                tankerDemand.fuel || 0,
                tankerConsumed.fuel || 0,
                tankerDemand.crude_oil || 0,
                tankerConsumed.crude_oil || 0,
                vessels.containerCount || 0,
                vessels.containerCapacity || 0,
                vessels.tankerCount || 0,
                vessels.tankerCapacity || 0,
                myAlliance ? myAlliance.rank : '',
                myAlliance ? myAlliance.teu : '',
                myAlliance ? myAlliance.bbl : ''
            ];

            rows.push(row.join(','));
        }

        const csvContent = rows.join('\n');
        const blob = new window.Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = window.URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = 'demand-summary-' + new Date().toISOString().slice(0, 10) + '.csv';
        link.click();

        window.URL.revokeObjectURL(url);
        showToast('CSV exported', 'success');
    }

    function openPortModal(portCode) {
        const modalStore = getModalStore();
        if (!modalStore) {
            log('Modal store not found', 'error');
            return;
        }

        log('Opening port modal for: ' + portCode);

        // Save scroll position for when user returns
        const listContainer = document.getElementById('demand-port-list');
        if (listContainer) {
            savedScrollPosition = listContainer.scrollTop;
            log('Saved scroll position: ' + savedScrollPosition);
        }
        pendingReturn = true;

        // Close our custom modal (hide it, don't remove)
        isDemandModalOpen = false;
        const demandWrapper = document.getElementById('demand-modal-wrapper');
        if (demandWrapper) {
            demandWrapper.classList.add('hide');
        }
        restoreViewport();

        // Open game's port modal
        setTimeout(function() {
            try {
                modalStore.open('port', {
                    componentProps: {
                        port_code: portCode
                    }
                });
                log('Port modal open called');
            } catch (err) {
                log('Error opening port modal: ' + err.message, 'error');
            }
        }, 200);
    }

    function openDemandModal() {
        // Close any open game modal first
        const modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        pendingReturn = false;
        injectDemandModalStyles();

        const existing = document.getElementById('demand-modal-wrapper');
        if (existing) {
            const contentCheck = existing.querySelector('#demand-central-container');
            if (contentCheck) {
                existing.classList.remove('hide');
                isDemandModalOpen = true;
                enableMobileZoom();
                renderModalContent(contentCheck);
                return;
            }
            existing.remove();
        }

        const headerEl = document.querySelector('header');
        const headerHeight = headerEl ? headerEl.offsetHeight : 89;

        const modalWrapper = document.createElement('div');
        modalWrapper.id = 'demand-modal-wrapper';

        const modalBackground = document.createElement('div');
        modalBackground.id = 'demand-modal-background';
        modalBackground.onclick = function() { closeDemandModal(); };

        const modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'demand-modal-content-wrapper';

        const modalContainer = document.createElement('div');
        modalContainer.id = 'demand-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        const modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        const headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Demand Summary';

        const closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeDemandModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            const fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeDemandModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        const modalContent = document.createElement('div');
        modalContent.id = 'demand-modal-content';

        const centralContainer = document.createElement('div');
        centralContainer.id = 'demand-central-container';

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isDemandModalOpen = true;
        enableMobileZoom();
        renderModalContent(centralContainer);

        // Restore scroll position if returning from port modal
        if (pendingReturn && savedScrollPosition > 0) {
            setTimeout(function() {
                const listContainer = document.getElementById('demand-port-list');
                if (listContainer) {
                    listContainer.scrollTop = savedScrollPosition;
                }
                pendingReturn = false;
            }, 50);
        }
    }

    // Intercept Back button clicks to return to our demand summary
    function setupBackButtonInterceptor() {
        document.addEventListener('click', function(e) {
            if (!pendingReturn) return;

            // Check if clicked on Back button in bottom controls
            // Back button uses .light-blue class (language-independent)
            var target = e.target;
            var controlBtn = target.closest('#bottom-controls .control-btn');
            var isBackBtn = controlBtn && controlBtn.classList.contains('light-blue');

            if (isBackBtn) {
                e.preventDefault();
                e.stopPropagation();
                log('Back button intercepted, returning to Demand Summary');
                pendingReturn = false;
                openDemandModal();
            }
        }, true);
    }

    async function renderModalContent(container) {
        activeModalContainer = container;

        log('renderModalContent: cachedData=' + (cachedData ? 'exists(' + (cachedData.ports ? cachedData.ports.length : 'no ports') + ')' : 'NULL'));
        log('renderModalContent: rankingCache=' + (rankingCache ? 'exists(' + (rankingCache.ports ? Object.keys(rankingCache.ports).length : 'no ports') + ')' : 'NULL'));

        // Reload from DB if memory caches are empty (e.g., after app restart)
        if (!cachedData || !rankingCache) {
            log('renderModalContent: Loading from DB...');
            await loadCache();
            log('renderModalContent: After loadCache - cachedData=' + (cachedData ? 'exists(' + (cachedData.ports ? cachedData.ports.length : 'no ports') + ')' : 'NULL'));
            log('renderModalContent: After loadCache - rankingCache=' + (rankingCache ? 'exists(' + (rankingCache.ports ? Object.keys(rankingCache.ports).length : 'no ports') + ')' : 'NULL'));
        }

        const cache = loadCacheSync();
        const hasCache = cache && cache.ports && cache.ports.length > 0;
        log('renderModalContent: hasCache=' + hasCache);
        const canCollectNow = canCollect();
        const cooldownRemaining = getTimeUntilNextCollect();
        const vesselsByDest = getVesselsByDestinationWithFallback();

        let html = '<div id="demand-summary-wrapper" data-rebelship-modal="demand-summary" style="padding:8px 2px;font-family:Lato,sans-serif;color:#01125d;height:100%;display:flex;flex-direction:column;box-sizing:border-box;">';

        // Header with last collect times
        const rankings = loadRankingCacheSync();
        log('Header: cache.timestamp=' + (cache ? cache.timestamp : 'NULL') + ', rankings.timestamp=' + (rankings ? rankings.timestamp : 'NULL'));
        html += '<div style="font-size:11px;color:#626b90;margin-bottom:2px;text-align:center;">';
        html += 'Demand: ' + formatTimestamp(cache ? cache.timestamp : null);
        html += ' | Ranking: ' + formatTimestamp(rankings ? rankings.timestamp : null);
        html += '</div>';

        // Settings row
        html += '<div style="text-align:center;margin-bottom:4px;">';
        html += '<label style="font-size:11px;color:#626b90;cursor:pointer;">';
        html += '<input type="checkbox" id="demand-map-tooltips-toggle"' + (demandSettings.mapTooltipsEnabled ? ' checked' : '') + ' style="margin-right:4px;cursor:pointer;">';
        html += 'Map port tooltips';
        html += '</label>';
        html += '</div>';

        if (!hasCache) {
            html += '<div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:40px;color:#626b90;">';
            html += '<p style="font-size:16px;margin-bottom:10px;">No demand data cached yet.</p>';
            html += '<p style="font-size:13px;margin-bottom:20px;">Click "Collect Demand" to fetch demand for all 360 ports.</p>';
            html += '<button id="demand-collect-btn" style="padding:10px 20px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:4px;color:#fff;font-size:14px;cursor:pointer;font-weight:bold;">' + (isCollecting ? 'Collecting...' : 'Collect Demand') + '</button>';
            html += '</div>';
        } else {
            // Summary
            const portsWithVessels = cache.ports.filter(p => vesselsByDest[p.code]);
            html += '<div style="margin-bottom:6px;font-size:11px;color:#626b90;text-align:center;">';
            html += cache.ports.length + ' ports cached | ' + portsWithVessels.length + ' ports with vessels en route';
            html += '</div>';

            // Filter tabs
            html += '<div style="display:flex;gap:2px;margin-bottom:12px;flex-wrap:wrap;align-items:center;justify-content:center;">';
            html += '<button class="demand-filter-btn" data-filter="all" style="padding:6px 12px;background:' + (currentFilter === 'all' ? '#0db8f4' : '#374151') + ';border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">All</button>';
            html += '<button class="demand-filter-btn" data-filter="vessels" style="padding:6px 12px;background:' + (currentFilter === 'vessels' ? '#0db8f4' : '#374151') + ';border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">With Vessels</button>';
            html += '<button class="demand-filter-btn" data-filter="novessels" style="padding:6px 12px;background:' + (currentFilter === 'novessels' ? '#0db8f4' : '#374151') + ';border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">No Vessels</button>';
            html += '<button class="demand-filter-btn" data-filter="container" style="padding:6px 12px;background:' + (currentFilter === 'container' ? '#0db8f4' : '#374151') + ';border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">Container</button>';
            html += '<button class="demand-filter-btn" data-filter="tanker" style="padding:6px 12px;background:' + (currentFilter === 'tanker' ? '#0db8f4' : '#374151') + ';border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">Tanker</button>';
            if (canCollectNow) {
                html += '<button id="demand-collect-btn" style="padding:6px 12px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">' + (isCollecting ? 'Collecting...' : 'Collect Demand') + '</button>';
            } else {
                const mins = Math.ceil(cooldownRemaining / 60000);
                html += '<button disabled style="padding:6px 12px;background:#9ca3af;border:0;border-radius:4px;color:#fff;font-size:12px;cursor:not-allowed;">Wait ' + mins + ' min</button>';
            }
            // Ranking button - check if there are uncollected ports (resume mode)
            var rankingData = loadRankingCacheSync();
            var collectedCount = rankingData && rankingData.ports ? Object.keys(rankingData.ports).length : 0;
            var hasUncollectedPorts = collectedCount < 360;
            var canCollectRankingNow = hasUncollectedPorts || canCollectRanking();
            var rankingCooldownRemaining = getTimeUntilNextRankingCollect();
            if (isCollectingRanking) {
                html += '<button id="ranking-collect-btn" disabled style="padding:6px 12px;background:#f59e0b;border:0;border-radius:4px;color:#fff;font-size:12px;cursor:not-allowed;">Collecting ' + rankingProgress.current + '/' + rankingProgress.total + '</button>';
            } else if (hasUncollectedPorts && collectedCount > 0) {
                html += '<button id="ranking-collect-btn" style="padding:6px 12px;background:linear-gradient(180deg,#f59e0b,#d97706);border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">Resume ' + collectedCount + '/360</button>';
            } else if (canCollectRankingNow) {
                html += '<button id="ranking-collect-btn" style="padding:6px 12px;background:linear-gradient(180deg,#f59e0b,#d97706);border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">Collect Ranking</button>';
            } else {
                const rankMins = Math.ceil(rankingCooldownRemaining / 60000);
                html += '<button disabled style="padding:6px 12px;background:#9ca3af;border:0;border-radius:4px;color:#fff;font-size:12px;cursor:not-allowed;">Rank ' + rankMins + 'm</button>';
            }
            html += '<button id="demand-export-btn" style="padding:6px 12px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">Export</button>';
            html += '</div>';

            // Port list - fills remaining height
            html += '<div id="demand-port-list" style="flex:1;overflow-y:auto;min-height:0;">';
            html += renderPortList(cache.ports, vesselsByDest, currentFilter, currentSortColumn, currentSortOrder);
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;

        // Event handlers
        var tooltipToggle = document.getElementById('demand-map-tooltips-toggle');
        if (tooltipToggle) {
            tooltipToggle.addEventListener('change', function() {
                demandSettings.mapTooltipsEnabled = this.checked;
                saveSettings();
            });
        }

        const collectBtn = document.getElementById('demand-collect-btn');
        if (collectBtn) {
            collectBtn.addEventListener('click', async function() {
                if (isCollecting) return;
                await collectDemand();
                renderModalContent(container);
            });
        }

        const exportBtn = document.getElementById('demand-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', function() {
                exportToCSV(cache.ports, vesselsByDest);
            });
        }

        const rankingBtn = document.getElementById('ranking-collect-btn');
        if (rankingBtn && !isCollectingRanking) {
            rankingBtn.addEventListener('click', async function() {
                if (isCollectingRanking) return;
                await collectRanking();
            });
        }

        // Filter buttons
        const filterBtns = container.querySelectorAll('.demand-filter-btn');
        filterBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                filterBtns.forEach(function(b) { b.style.background = '#374151'; });
                btn.style.background = '#0db8f4';

                currentFilter = btn.dataset.filter;
                const listContainer = document.getElementById('demand-port-list');
                if (listContainer && cache && cache.ports) {
                    listContainer.innerHTML = renderPortList(cache.ports, vesselsByDest, currentFilter, currentSortColumn, currentSortOrder);
                    attachSortHandlers(cache.ports, vesselsByDest);
                }
            });
        });

        // Attach sort handlers to column headers
        attachSortHandlers(cache.ports, vesselsByDest);
    }

    function attachSortHandlers(ports, vesselsByDest) {
        const headers = document.querySelectorAll('.demand-sort-header');
        headers.forEach(function(header) {
            header.addEventListener('click', function() {
                const column = header.dataset.column;
                if (currentSortColumn === column) {
                    currentSortOrder = currentSortOrder === 'desc' ? 'asc' : 'desc';
                } else {
                    currentSortColumn = column;
                    currentSortOrder = 'desc';
                }
                const listContainer = document.getElementById('demand-port-list');
                if (listContainer && ports) {
                    listContainer.innerHTML = renderPortList(ports, vesselsByDest, currentFilter, currentSortColumn, currentSortOrder);
                    attachSortHandlers(ports, vesselsByDest);
                }
            });
        });

        // Port link click handlers
        const portLinks = document.querySelectorAll('.demand-port-link');
        portLinks.forEach(function(link) {
            link.addEventListener('click', function() {
                const portCode = link.dataset.port;
                if (portCode) {
                    openPortModal(portCode);
                }
            });
        });

        // Rank cell click/touch handlers for tooltip
        const rankCells = document.querySelectorAll('.demand-rank-cell');
        rankCells.forEach(function(cell) {
            // Desktop: click
            cell.addEventListener('click', function(e) {
                e.stopPropagation();
                const portCode = cell.dataset.port;
                if (portCode) {
                    showRankTooltip(portCode, cell);
                }
            });

            // Mobile: long press
            var rankLongPressTimer = null;
            cell.addEventListener('touchstart', function() {
                const portCode = cell.dataset.port;
                rankLongPressTimer = setTimeout(function() {
                    if (portCode) {
                        showRankTooltip(portCode, cell);
                    }
                }, 500); // 500ms long press
            });
            cell.addEventListener('touchend', function() {
                if (rankLongPressTimer) {
                    clearTimeout(rankLongPressTimer);
                    rankLongPressTimer = null;
                }
            });
            cell.addEventListener('touchmove', function() {
                if (rankLongPressTimer) {
                    clearTimeout(rankLongPressTimer);
                    rankLongPressTimer = null;
                }
            });
        });
    }

    // Pre-calculated sort values cache - built once on data load, reused on sort clicks
    var sortValuesCache = null; // Map: portCode -> { port, maxTEU, currentTEU, maxBBL, currentBBL, containerVessels, tankerVessels, rank }

    function buildSortValuesCache(ports, vesselsByDest, rankingPorts) {
        var cache = new Map();
        for (var i = 0; i < ports.length; i++) {
            var port = ports[i];
            var demand = port.demand || {};
            var consumed = port.consumed || {};
            var containerDemand = demand.container || {};
            var containerConsumed = consumed.container || {};
            var tankerDemand = demand.tanker || {};
            var tankerConsumed = consumed.tanker || {};
            var vessels = vesselsByDest[port.code];
            var portRanking = rankingPorts[port.code];

            var maxTEU = (containerDemand.dry || 0) + (containerDemand.refrigerated || 0);
            var currentTEU = Math.max(0, maxTEU - (containerConsumed.dry || 0) - (containerConsumed.refrigerated || 0));
            var maxBBL = (tankerDemand.fuel || 0) + (tankerDemand.crude_oil || 0);
            var currentBBL = Math.max(0, maxBBL - (tankerConsumed.fuel || 0) - (tankerConsumed.crude_oil || 0));

            cache.set(port.code, {
                port: port,
                maxTEU: maxTEU,
                currentTEU: currentTEU,
                maxBBL: maxBBL,
                currentBBL: currentBBL,
                containerVessels: vessels ? vessels.containerCount : 0,
                tankerVessels: vessels ? vessels.tankerCount : 0,
                rank: portRanking && portRanking.myAlliance ? portRanking.myAlliance.rank : 9999,
                ranking: portRanking
            });
        }
        return cache;
    }

    function renderPortList(ports, vesselsByDest, filter, sortColumn, sortOrder) {
        const rankings = loadRankingCacheSync();
        const rankingPorts = rankings ? rankings.ports : {};
        log('renderPortList: rankings=' + (rankings ? 'exists' : 'NULL') + ', rankingPorts count=' + Object.keys(rankingPorts).length);

        // Build sort values cache once (reused across sort clicks until data changes)
        sortValuesCache = buildSortValuesCache(ports, vesselsByDest, rankingPorts);

        // Sort ports using pre-calculated values
        const sortedPorts = ports.slice().sort(function(a, b) {
            var aCache = sortValuesCache.get(a.code);
            var bCache = sortValuesCache.get(b.code);
            var aVal, bVal;

            switch (sortColumn) {
                case 'port': aVal = a.code; bVal = b.code; break;
                case 'maxTEU': aVal = aCache.maxTEU; bVal = bCache.maxTEU; break;
                case 'currentTEU': aVal = aCache.currentTEU; bVal = bCache.currentTEU; break;
                case 'maxBBL': aVal = aCache.maxBBL; bVal = bCache.maxBBL; break;
                case 'currentBBL': aVal = aCache.currentBBL; bVal = bCache.currentBBL; break;
                case 'containerVessels': aVal = aCache.containerVessels; bVal = bCache.containerVessels; break;
                case 'tankerVessels': aVal = aCache.tankerVessels; bVal = bCache.tankerVessels; break;
                case 'rank': aVal = aCache.rank; bVal = bCache.rank; break;
                default: aVal = aCache.currentTEU; bVal = bCache.currentTEU;
            }

            if (sortColumn === 'port') {
                return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            }
            return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
        });

        // Filter ports using pre-calculated values
        const filteredPorts = [];
        for (var fi = 0; fi < sortedPorts.length; fi++) {
            var port = sortedPorts[fi];
            var cached = sortValuesCache.get(port.code);
            var vessels = vesselsByDest[port.code];

            if (filter === 'vessels' && !vessels) continue;
            if (filter === 'novessels' && vessels) continue;
            if (filter === 'container' && cached.currentTEU <= 0) continue;
            if (filter === 'tanker' && cached.currentBBL <= 0) continue;

            filteredPorts.push(cached);
        }

        if (filteredPorts.length === 0) {
            return '<div style="text-align:center;padding:20px;color:#626b90;">No ports match this filter.</div>';
        }

        // Sort icon helper
        function sortIcon(column) {
            if (sortColumn === column) {
                return sortOrder === 'desc' ? ' v' : ' ^';
            }
            return '';
        }

        // Table header
        let html = '<table style="width:100%;border-collapse:collapse;font-size:10px;">';
        html += '<thead style="position:sticky;top:0;background:#d1d5db;z-index:10;">';
        html += '<tr style="text-align:left;">';
        html += '<th class="demand-sort-header" data-column="port" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:left;white-space:nowrap;cursor:pointer;">Port' + sortIcon('port') + '</th>';
        html += '<th class="demand-sort-header" data-column="maxTEU" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:right;white-space:nowrap;cursor:pointer;">mTEU' + sortIcon('maxTEU') + '</th>';
        html += '<th class="demand-sort-header" data-column="currentTEU" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:right;white-space:nowrap;cursor:pointer;">cTEU' + sortIcon('currentTEU') + '</th>';
        html += '<th class="demand-sort-header" data-column="maxBBL" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:right;white-space:nowrap;cursor:pointer;">mBBL' + sortIcon('maxBBL') + '</th>';
        html += '<th class="demand-sort-header" data-column="currentBBL" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:right;white-space:nowrap;cursor:pointer;">cBBL' + sortIcon('currentBBL') + '</th>';
        html += '<th class="demand-sort-header" data-column="containerVessels" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:center;white-space:nowrap;cursor:pointer;" title="Container Vessels"><img src="/images/icons/departure_notification/container_yellow.svg" alt="C" style="width:14px;height:14px;vertical-align:middle;">' + sortIcon('containerVessels') + '</th>';
        html += '<th class="demand-sort-header" data-column="tankerVessels" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:center;white-space:nowrap;cursor:pointer;" title="Tanker Vessels"><img src="/images/icons/departure_notification/oil_icon.svg" alt="T" style="width:14px;height:14px;vertical-align:middle;">' + sortIcon('tankerVessels') + '</th>';
        html += '<th class="demand-sort-header" data-column="rank" style="padding:2px 1px;border-bottom:2px solid #9ca3af;text-align:center;white-space:nowrap;cursor:pointer;" title="Alliance Rank">#' + sortIcon('rank') + '</th>';
        html += '</tr>';
        html += '</thead>';
        html += '<tbody>';

        for (let i = 0; i < filteredPorts.length; i++) {
            const item = filteredPorts[i];
            const portData = item.port;
            const rowBg = i % 2 === 0 ? '#f3f4f6' : '#fff';

            html += '<tr class="demand-port-row" data-port="' + escapeHtml(portData.code) + '" style="background:' + rowBg + ';">';
            html += '<td style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:left;">';
            html += '<span class="demand-port-link" data-port="' + escapeHtml(portData.code) + '" style="cursor:pointer;color:#3b82f6;text-decoration:underline;">';
            html += escapeHtml(capitalizePortName(portData.code));
            html += '</span></td>';

            html += '<td style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:right;">';
            html += item.maxTEU > 0 ? formatNumber(item.maxTEU) : '-';
            html += '</td>';

            html += '<td style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:right;">';
            html += item.currentTEU > 0 ? formatNumber(item.currentTEU) : '-';
            html += '</td>';

            html += '<td style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:right;">';
            html += item.maxBBL > 0 ? formatNumber(item.maxBBL) : '-';
            html += '</td>';

            html += '<td style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:right;">';
            html += item.currentBBL > 0 ? formatNumber(item.currentBBL) : '-';
            html += '</td>';

            html += '<td style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:center;">';
            html += item.containerVessels > 0 ? item.containerVessels : '-';
            html += '</td>';

            html += '<td style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:center;">';
            html += item.tankerVessels > 0 ? item.tankerVessels : '-';
            html += '</td>';

            // Rank column with tooltip
            html += '<td class="demand-rank-cell" data-port="' + escapeHtml(portData.code) + '" style="padding:1px 1px;border-bottom:1px solid #e5e7eb;text-align:center;cursor:pointer;">';
            if (item.ranking && item.ranking.myAlliance) {
                html += item.ranking.myAlliance.rank;
            } else {
                html += '-';
            }
            html += '</td>';

            html += '</tr>';
        }

        html += '</tbody>';
        html += '</table>';

        return html;
    }

    async function collectDemand() {
        if (isCollecting) return;
        if (!canCollect()) {
            showToast('Please wait before collecting again', 'error');
            return;
        }

        isCollecting = true;
        log('Starting demand collection...');

        try {
            showToast('Fetching port codes...', 'success');
            const portCodes = await fetchAllPortCodes();
            log('Found ' + portCodes.length + ' ports');

            showToast('Collecting demand for ' + portCodes.length + ' ports...', 'success');
            const ports = await fetchPortsDemand(portCodes);
            log('Collected demand for ' + ports.length + ' ports');

            await saveCache(ports);
            showToast('Demand collected for ' + ports.length + ' ports', 'success');

            // Refresh modal if still open
            if (activeModalContainer) {
                renderModalContent(activeModalContainer);
            }

        } catch (err) {
            log('Collection failed: ' + err.message, 'error');
            showToast('Failed to collect demand: ' + err.message, 'error');
        } finally {
            isCollecting = false;
            // Refresh modal to update button state
            if (activeModalContainer) {
                renderModalContent(activeModalContainer);
            }
        }
    }

    // AbortController for cancellable ranking collection
    var rankingAbortController = null;

    async function collectRanking() {
        if (isCollectingRanking) return;

        isCollectingRanking = true;
        rankingAbortController = new window.AbortController();
        rankingProgress.current = 0;
        rankingProgress.total = 0;
        updateRankingButtonProgress();
        log('Starting ranking collection...');

        try {
            // Load existing ranking data from DB - but don't overwrite memory if DB fails
            const savedRanking = await dbGet('rankingCache');
            if (savedRanking) {
                // Check if saved ranking has expired (older than RANKING_COOLDOWN_MS)
                var rankingAge = savedRanking.timestamp ? Date.now() - savedRanking.timestamp : Infinity;
                if (rankingAge < RANKING_COOLDOWN_MS && Object.keys(savedRanking.ports).length >= 360) {
                    // Ranking data is still fresh and complete, no need to re-fetch
                    rankingCache = savedRanking;
                    log('Ranking cache still valid (' + Math.round(rankingAge / 60000) + 'min old), skipping collection');
                    isCollectingRanking = false;
                    rankingProgress.current = 0;
                    rankingProgress.total = 0;
                    if (activeModalContainer) renderModalContent(activeModalContainer);
                    return;
                }
                // Merge DB data with memory (DB takes precedence for resume)
                rankingCache = savedRanking;
                log('Loaded ' + Object.keys(savedRanking.ports).length + ' ports from DB (age: ' + Math.round(rankingAge / 60000) + 'min)');
            } else if (!rankingCache) {
                // Only init if both DB and memory are empty
                rankingCache = { timestamp: null, ports: {} };
                log('No existing ranking data, starting fresh');
            } else {
                log('DB empty but memory has ' + Object.keys(rankingCache.ports).length + ' ports');
            }

            const portCodes = await fetchAllPortCodes();

            // Skip already-collected ports for resume
            var alreadyCollected = rankingCache && rankingCache.ports ? rankingCache.ports : {};
            var alreadyCount = Object.keys(alreadyCollected).length;
            var portsToCollect = portCodes.filter(function(code) {
                return !alreadyCollected[code];
            });

            rankingProgress.total = portCodes.length;
            rankingProgress.current = alreadyCount;
            updateRankingButtonProgress();

            log('Ranking: ' + alreadyCount + ' already collected, ' + portsToCollect.length + ' remaining out of ' + portCodes.length);

            var collectedCount = 0;
            var baseProgress = alreadyCount;

            // Process in batches - parallel API calls per batch
            for (let batchStart = 0; batchStart < portsToCollect.length; batchStart += RANKING_BATCH_SIZE) {
                if (!isCollectingRanking) {
                    log('Ranking collection paused at ' + rankingProgress.current + '/' + rankingProgress.total);
                    break;
                }

                var batchEnd = Math.min(batchStart + RANKING_BATCH_SIZE, portsToCollect.length);
                var batch = portsToCollect.slice(batchStart, batchEnd);

                // Parallel einzelne Calls (Ranking API akzeptiert keine Arrays!)
                var batchPromises = batch.map(function(portCode) {
                    return fetchPortRanking(portCode).then(function(ranking) {
                        return { portCode: portCode, ranking: ranking };
                    });
                });
                var results = await Promise.all(batchPromises);

                // Collect all results in memory
                var batchCollected = 0;
                var failedPorts = [];
                for (var r = 0; r < results.length; r++) {
                    var result = results[r];
                    if (result.ranking) {
                        var existing = rankingCache ? Object.assign({}, rankingCache.ports) : {};
                        existing[result.portCode] = result.ranking;
                        rankingCache = { timestamp: Date.now(), ports: existing };
                        batchCollected++;
                        collectedCount++;
                        updateRankCellLive(result.portCode, result.ranking);
                    } else {
                        failedPorts.push(result.portCode);
                    }
                    rankingProgress.current = baseProgress + batchStart + r + 1;
                }
                if (failedPorts.length > 0) {
                    log('FAILED to fetch ranking for: ' + failedPorts.join(', '), 'error');
                }

                // Single DB save per batch (fast)
                if (batchCollected > 0) {
                    await dbSet('rankingCache', rankingCache);
                    log('Batch saved: ' + batchCollected + ' ports, total ' + Object.keys(rankingCache.ports).length);
                }

                if (activeModalContainer) {
                    updateRankingButtonProgress();
                }

                // Short delay between batches
                if (batchEnd < portsToCollect.length && isCollectingRanking) {
                    await new Promise(resolve => setTimeout(resolve, RANKING_BATCH_DELAY_MS));
                }
            }

            // Retry loop for failed ports
            var MAX_RETRY_PASSES = 3;
            for (var retryPass = 1; retryPass <= MAX_RETRY_PASSES && isCollectingRanking; retryPass++) {
                var missingPorts = portCodes.filter(function(code) {
                    return !rankingCache.ports[code];
                });
                if (missingPorts.length === 0) break;

                log('Retry pass ' + retryPass + ': ' + missingPorts.length + ' ports missing');
                await new Promise(resolve => setTimeout(resolve, 3000));

                for (var retryBatchStart = 0; retryBatchStart < missingPorts.length; retryBatchStart += RANKING_RETRY_BATCH_SIZE) {
                    if (!isCollectingRanking) break;

                    var retryBatchEnd = Math.min(retryBatchStart + RANKING_RETRY_BATCH_SIZE, missingPorts.length);
                    var retryBatch = missingPorts.slice(retryBatchStart, retryBatchEnd);

                    var retryPromises = retryBatch.map(function(portCode) {
                        return fetchPortRanking(portCode).then(function(ranking) {
                            return { portCode: portCode, ranking: ranking };
                        });
                    });
                    var retryResults = await Promise.all(retryPromises);

                    var retryCollected = 0;
                    for (var ri = 0; ri < retryResults.length; ri++) {
                        var rr = retryResults[ri];
                        if (rr.ranking) {
                            var existingRetry = Object.assign({}, rankingCache.ports);
                            existingRetry[rr.portCode] = rr.ranking;
                            rankingCache = { timestamp: Date.now(), ports: existingRetry };
                            retryCollected++;
                            collectedCount++;
                            updateRankCellLive(rr.portCode, rr.ranking);
                        }
                    }

                    if (retryCollected > 0) {
                        await dbSet('rankingCache', rankingCache);
                        log('Retry batch saved: ' + retryCollected + ' ports, total ' + Object.keys(rankingCache.ports).length);
                    }

                    if (activeModalContainer) {
                        updateRankingButtonProgress();
                    }

                    if (retryBatchEnd < missingPorts.length && isCollectingRanking) {
                        await new Promise(resolve => setTimeout(resolve, RANKING_BATCH_DELAY_MS));
                    }
                }
            }

            // Log final result
            var finalCollected = rankingCache ? Object.keys(rankingCache.ports).length : 0;
            var stillMissing = portCodes.length - finalCollected;
            if (stillMissing > 0) {
                log(stillMissing + ' ports still missing after retries', 'error');
            }
            log('Final ranking count: ' + finalCollected + '/' + portCodes.length);

            if (isCollectingRanking) {
                showToast('Ranking complete: ' + finalCollected + '/' + portCodes.length + ' ports', 'success');
                log('Ranking collection complete');
            } else {
                showToast('Ranking paused: ' + collectedCount + ' new ports saved', 'success');
            }

        } catch (err) {
            log('Ranking collection failed: ' + err.message, 'error');
            showToast('Failed to collect ranking: ' + err.message, 'error');
        } finally {
            isCollectingRanking = false;
            rankingAbortController = null;
            rankingProgress.current = 0;
            rankingProgress.total = 0;
            if (activeModalContainer && isDemandModalOpen) {
                renderModalContent(activeModalContainer);
            }
        }
    }

    function updateRankingButtonProgress() {
        // Check if element still exists (modal may be closed)
        const btn = document.getElementById('ranking-collect-btn');
        if (btn) {
            btn.textContent = 'Collecting ' + rankingProgress.current + '/' + rankingProgress.total;
        }
    }

    function updateRankCellLive(portCode, ranking) {
        // Guard: only update if modal is still open and element exists in DOM
        if (!isDemandModalOpen) return;
        var cell = document.querySelector('.demand-rank-cell[data-port="' + portCode + '"]');
        if (!cell || !cell.isConnected) return;
        if (ranking && ranking.myAlliance) {
            cell.textContent = ranking.myAlliance.rank;
            cell.style.background = '#bbf7d0';
            setTimeout(function() {
                if (cell.isConnected) cell.style.background = '';
            }, 500);
        } else {
            cell.textContent = '-';
        }
    }

    // ========== ROUTE POPUP DEMAND FILTER ==========

    function injectRoutePopupStyles() {
        if (document.getElementById('route-popup-gap-fix')) return;
        var style = document.createElement('style');
        style.id = 'route-popup-gap-fix';
        style.textContent = '#createRoutePopup .buttonContainer{display:flex!important;flex-direction:column!important;gap:4px!important;row-gap:4px!important;}' +
            '#createRoutePopup .buttonContainer>*{margin:0!important;}';
        document.head.appendChild(style);
    }

    function isShowAllPortsStep() {
        var popup = document.getElementById('createRoutePopup');
        if (!popup) return false;
        // #suggest-route-btn only exists in step 1 (button selection step)
        return !!popup.querySelector('#suggest-route-btn');
    }

    var routePopupObserver = null;

    function initRoutePopupFilter() {
        injectRoutePopupStyles();

        var routePopupDebounceTimer = null;

        routePopupObserver = new MutationObserver(function() {
            // Debounce 250ms to avoid firing hundreds of times per second in Vue SPA
            if (routePopupDebounceTimer) clearTimeout(routePopupDebounceTimer);
            routePopupDebounceTimer = setTimeout(function() {
                var popup = document.getElementById('createRoutePopup');
                if (!popup) {
                    if (routeFilterInjected) {
                        resetRouteFilter();
                        // Disconnect observer when popup closes, reconnect on next check
                    }
                    return;
                }
                var btnContainer = popup.querySelector('.buttonContainer');
                if (!btnContainer) return;
                if (!isShowAllPortsStep()) return;
                // Check if our buttons are still in the DOM (popup may have been recreated)
                var hasOurButtons = btnContainer.querySelector('.demand-filter-route-btn');
                if (!hasOurButtons) {
                    routeFilterInjected = false;
                    injectRouteFilterButtons(btnContainer);
                }
            }, 250);
        });
        var observeTarget = document.getElementById('modal-container') || document.getElementById('app') || document.body;
        routePopupObserver.observe(observeTarget, { childList: true, subtree: true });

        document.addEventListener('click', function(e) {
            if (routeFilterDropdownOpen) {
                var dropdown = document.getElementById('demandFilterDropdown');
                if (dropdown && !dropdown.contains(e.target) && !e.target.closest('.demand-filter-route-btn')) {
                    closeAllDemandDropdowns();
                }
            }
        });
    }

    function injectRouteFilterButtons(container) {
        if (routeFilterInjected) return;
        routeFilterInjected = true;

        // Detect vessel type from route store
        var vesselType = null;
        try {
            var rs = getStore('route');
            if (rs && rs.selectedVessel) {
                vesselType = rs.selectedVessel.capacity_type;
            }
        } catch {
            // ignore
        }
        var isContainer = vesselType === 'container';
        var isTanker = vesselType === 'tanker';

        // DEMAND TEU button — only for container vessels (or unknown)
        if (!isTanker) {
            var teuBtn = document.createElement('button');
            teuBtn.className = 'default light-blue demand-filter-route-btn';
            teuBtn.setAttribute('data-v-67942aae', '');
            teuBtn.innerHTML = '<span class="btn-content-wrapper fit-btn-text">DEMAND TEU</span>';
            teuBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                createDemandDropdown(teuBtn, TEU_RANGES, 'teu');
            });
            container.appendChild(teuBtn);
        }

        // DEMAND BBL button — only for tanker vessels (or unknown)
        if (!isContainer) {
            var bblBtn = document.createElement('button');
            bblBtn.className = 'default light-blue demand-filter-route-btn';
            bblBtn.setAttribute('data-v-67942aae', '');
            bblBtn.innerHTML = '<span class="btn-content-wrapper fit-btn-text">DEMAND BBL</span>';
            bblBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                createDemandDropdown(bblBtn, BBL_RANGES, 'bbl');
            });
            container.appendChild(bblBtn);
        }

        // NO VESSELS button
        var noVesselsBtn = document.createElement('button');
        noVesselsBtn.id = 'demandFilterNoVessels';
        noVesselsBtn.className = 'default light-blue demand-filter-route-btn';
        noVesselsBtn.setAttribute('data-v-67942aae', '');
        noVesselsBtn.innerHTML = '<span class="btn-content-wrapper fit-btn-text">NO VESSELS</span>';
        noVesselsBtn.addEventListener('click', function() {
            noVesselsFilterActive = !noVesselsFilterActive;
            noVesselsBtn.className = noVesselsFilterActive
                ? 'default green demand-filter-route-btn'
                : 'default light-blue demand-filter-route-btn';
            applyDemandFilters();
        });
        container.appendChild(noVesselsBtn);

        // COLLECT DEMAND button
        var collectBtn = document.createElement('button');
        collectBtn.id = 'demandFilterCollectBtn';
        collectBtn.setAttribute('data-v-67942aae', '');
        if (isCollecting) {
            collectBtn.className = 'default light-blue demand-filter-route-btn';
            collectBtn.disabled = true;
            collectBtn.innerHTML = '<span class="btn-content-wrapper fit-btn-text">Collecting...</span>';
        } else if (!canCollect()) {
            collectBtn.className = 'default light-blue demand-filter-route-btn';
            collectBtn.style.cssText = 'opacity:0.5;';
            collectBtn.disabled = true;
            collectBtn.innerHTML = '<span class="btn-content-wrapper fit-btn-text">Wait ' + formatCooldownTime(getTimeUntilNextCollect()) + '</span>';
        } else {
            collectBtn.className = 'default light-blue demand-filter-route-btn';
            collectBtn.innerHTML = '<span class="btn-content-wrapper fit-btn-text">COLLECT DEMAND</span>';
            collectBtn.addEventListener('click', function() {
                handleRouteCollect(collectBtn);
            });
        }
        container.appendChild(collectBtn);
    }

    function resetRouteFilter() {
        routeFilterInjected = false;
        routeFilterBaselinePorts = null;
        routeFilterDropdownOpen = null;
        noVesselsFilterActive = false;
        activeDemandFilter = { teu: null, bbl: null };
        closeAllDemandDropdowns();
    }

    function createDemandDropdown(btn, ranges, type) {
        closeAllDemandDropdowns();

        var dropdown = document.createElement('div');
        dropdown.id = 'demandFilterDropdown';
        dropdown.style.cssText = 'position:absolute;background:#1a1a2e;border:1px solid #374151;border-radius:6px;padding:4px 0;z-index:9999;min-width:120px;box-shadow:0 4px 12px rgba(0,0,0,0.4);';

        for (var i = 0; i < ranges.length; i++) {
            (function(range) {
                var item = document.createElement('div');
                item.style.cssText = 'padding:6px 12px;color:#fff;font-size:12px;cursor:pointer;white-space:nowrap;';
                item.textContent = range.label;

                var isActive = activeDemandFilter[type] === range.min;
                if (isActive) {
                    item.style.background = '#3b82f6';
                }

                item.addEventListener('mouseenter', function() {
                    if (!isActive) item.style.background = '#2a2a4e';
                });
                item.addEventListener('mouseleave', function() {
                    if (!isActive) item.style.background = '';
                });
                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    if (range.min === 0) {
                        activeDemandFilter[type] = null;
                    } else {
                        activeDemandFilter[type] = range.min;
                    }
                    closeAllDemandDropdowns();

                    // Update button text
                    var span = btn.querySelector('.btn-content-wrapper');
                    if (span) {
                        if (range.min === 0) {
                            span.textContent = type === 'teu' ? 'DEMAND TEU' : 'DEMAND BBL';
                        } else {
                            span.textContent = range.label;
                        }
                    }
                    applyDemandFilters();
                });
                dropdown.appendChild(item);
            })(ranges[i]);
        }

        // Position: append first to measure, then clamp to viewport
        dropdown.style.position = 'fixed';
        dropdown.style.visibility = 'hidden';
        document.body.appendChild(dropdown);

        var rect = btn.getBoundingClientRect();
        var ddWidth = dropdown.offsetWidth;
        var ddHeight = dropdown.offsetHeight;

        // Horizontal: try align left with button, clamp to viewport
        var left = rect.left;
        if (left + ddWidth > window.innerWidth - 8) {
            left = window.innerWidth - ddWidth - 8;
        }
        if (left < 8) left = 8;

        // Vertical: prefer below button, if no room flip above
        var top = rect.bottom + 2;
        if (top + ddHeight > window.innerHeight - 8) {
            top = rect.top - ddHeight - 2;
        }
        if (top < 8) top = 8;

        dropdown.style.left = left + 'px';
        dropdown.style.top = top + 'px';
        dropdown.style.visibility = 'visible';
        routeFilterDropdownOpen = dropdown;
    }

    function closeAllDemandDropdowns() {
        var dropdown = document.getElementById('demandFilterDropdown');
        if (dropdown) {
            dropdown.remove();
        }
        routeFilterDropdownOpen = null;
    }

    async function applyDemandFilters() {
        var hasAnyFilter = activeDemandFilter.teu || activeDemandFilter.bbl || noVesselsFilterActive;

        var rs = getStore('route');
        if (!rs || !rs.routeSelection) {
            log('Route store not found', 'error');
            return;
        }

        // No filter active -> restore baseline
        if (!hasAnyFilter) {
            if (routeFilterBaselinePorts) {
                rs.$patch(function(state) {
                    state.routeSelection.activePorts = routeFilterBaselinePorts.slice();
                    state.routeSelection.isMinified = true;
                    state.routeSelection.routeCreationStep = 2;
                });
                fitBoundsToFilteredPorts(routeFilterBaselinePorts);
                routeFilterBaselinePorts = null;
            }
            return;
        }

        // Need demand data for TEU/BBL filters
        if ((activeDemandFilter.teu || activeDemandFilter.bbl) && !cachedData) {
            showToast('No demand data. Collect first.', 'error');
            return;
        }

        // Capture baseline before first filter — always fetch from API
        // to avoid using stale/filtered activePorts from a previous session
        if (!routeFilterBaselinePorts) {
            var selectedVessel = rs.selectedVessel;
            if (!selectedVessel) {
                showToast('No vessel selected', 'error');
                return;
            }
            var apiPorts = await fetchVesselPorts(selectedVessel.id);
            if (!apiPorts || apiPorts.length === 0) {
                showToast('Could not load ports', 'error');
                return;
            }
            routeFilterBaselinePorts = apiPorts;
            log('Captured baseline from API: ' + routeFilterBaselinePorts.length + ' ports');
        }

        if (!routeFilterBaselinePorts || routeFilterBaselinePorts.length === 0) {
            log('No baseline ports to filter', 'error');
            return;
        }

        // Build lookup from cachedData
        var demandByCode = {};
        if (cachedData && cachedData.ports) {
            for (var i = 0; i < cachedData.ports.length; i++) {
                var p = cachedData.ports[i];
                demandByCode[p.code] = p;
            }
        }

        var vesselsByPort = noVesselsFilterActive ? getVesselsByPort() : {};

        var filtered = routeFilterBaselinePorts.filter(function(port) {
            var code = port.code;

            // TEU filter
            if (activeDemandFilter.teu) {
                var portData = demandByCode[code];
                if (!portData) return false;
                var demand = portData.demand || {};
                var consumed = portData.consumed || {};
                var cd = demand.container || {};
                var cc = consumed.container || {};
                var currentTEU = Math.max(0, (cd.dry || 0) + (cd.refrigerated || 0) - (cc.dry || 0) - (cc.refrigerated || 0));
                if (currentTEU < activeDemandFilter.teu) return false;
            }

            // BBL filter
            if (activeDemandFilter.bbl) {
                var portDataB = demandByCode[code];
                if (!portDataB) return false;
                var demandB = portDataB.demand || {};
                var consumedB = portDataB.consumed || {};
                var td = demandB.tanker || {};
                var tc = consumedB.tanker || {};
                var currentBBL = Math.max(0, (td.fuel || 0) + (td.crude_oil || 0) - (tc.fuel || 0) - (tc.crude_oil || 0));
                if (currentBBL < activeDemandFilter.bbl) return false;
            }

            // No vessels filter
            if (noVesselsFilterActive) {
                var vp = vesselsByPort[code];
                if (vp) {
                    var hasDest = vp.destContainerCount > 0 || vp.destTankerCount > 0;
                    var hasOrigin = vp.originContainerCount > 0 || vp.originTankerCount > 0;
                    if (hasDest || hasOrigin) return false;
                }
            }

            return true;
        });

        if (filtered.length === 0) {
            showToast('0 ports match the filter', 'error');
            return;
        }

        rs.$patch(function(state) {
            state.routeSelection.activePorts = filtered;
            state.routeSelection.isMinified = true;
            state.routeSelection.routeCreationStep = 2;
        });
        fitBoundsToFilteredPorts(filtered);
        log('Demand filter applied: ' + filtered.length + '/' + routeFilterBaselinePorts.length + ' ports');
    }

    var vesselPortsCache = {};
    var VESSEL_PORTS_CACHE_TTL = 2 * 60 * 1000;

    async function fetchVesselPorts(vesselId) {
        var cached = vesselPortsCache[vesselId];
        if (cached && Date.now() - cached.timestamp < VESSEL_PORTS_CACHE_TTL) {
            return cached.ports;
        }
        try {
            var response = await fetch(API_BASE + '/route/get-vessel-ports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ user_vessel_id: vesselId })
            });
            if (!response.ok) return null;
            var data = await response.json();
            if (data && data.data && data.data.all && data.data.all.ports) {
                var ports = data.data.all.ports;
                vesselPortsCache[vesselId] = { ports: ports, timestamp: Date.now() };
                return ports;
            }
        } catch (err) {
            log('fetchVesselPorts error: ' + err.message, 'error');
        }
        return null;
    }

    function fitBoundsToFilteredPorts(ports) {
        try {
            var mapStore = getStore('mapStore');
            if (!mapStore || !mapStore.map) return;
            if (!ports || ports.length === 0) return;

            var bounds = [];
            for (var i = 0; i < ports.length; i++) {
                var p = ports[i];
                if (p.lat !== undefined && p.lon !== undefined) {
                    bounds.push([parseFloat(p.lat), parseFloat(p.lon)]);
                }
            }
            if (bounds.length > 0) {
                mapStore.map.fitBounds(bounds, { padding: [20, 20] });
            }
        } catch (e) {
            log('fitBounds failed: ' + e.message, 'error');
        }
    }

    async function handleRouteCollect(btn) {
        if (isCollecting) return;
        if (!canCollect()) {
            showToast('Please wait ' + formatCooldownTime(getTimeUntilNextCollect()), 'error');
            return;
        }
        var span = btn.querySelector('.btn-content-wrapper');
        if (span) span.textContent = 'Collecting...';
        btn.disabled = true;
        try {
            await collectDemand();
            if (span) span.textContent = 'Done!';
            setTimeout(function() {
                // After collect, show cooldown state
                btn.style.opacity = '0.5';
                if (span) span.textContent = 'Wait ' + formatCooldownTime(getTimeUntilNextCollect());
            }, 2000);
        } catch {
            if (span) span.textContent = 'Failed';
            setTimeout(function() {
                btn.style.opacity = '0.5';
                if (span) span.textContent = 'Wait ' + formatCooldownTime(getTimeUntilNextCollect());
            }, 2000);
        }
    }

    // ========== INITIALIZATION ==========
    let uiInitialized = false;
    let uiRetryCount = 0;
    const MAX_UI_RETRIES = 30;

    function initUI() {
        if (uiInitialized) return;

        const hasApp = document.getElementById('app');
        const hasMessaging = document.querySelector('.messaging');

        if (!hasApp || !hasMessaging) {
            uiRetryCount++;
            if (uiRetryCount < MAX_UI_RETRIES) {
                setTimeout(initUI, 1000);
                return;
            }
            log('Max UI retries reached');
            return;
        }

        uiInitialized = true;
        setupBackButtonInterceptor();
    }

    async function init() {
        log('Initializing...');

        // Register menu immediately - no DOM needed for IPC call
        addMenuItem('Demand Summary', openDemandModal, 12);
        initUI();

        // Fetch alliance name ONCE before anything else (used by ranking)
        await fetchMyAllianceName();

        // Load demand + vessel count cache from DB so data is available immediately
        await loadCache();

        setupDemandModalWatcher();
        await loadSettings();
        initMapMarkerHover();
        initRoutePopupFilter();
        initMapPortFilter();

        log('Script loaded');
    }

    // ========== MAP PORT FILTER ==========

    let mapFilterInjected = false;
    let mapFilterPanelOpen = false;
    let mapFilterActive = { teu: null, bbl: null, noVessels: false };
    let mapFilterHiddenMarkers = [];

    function initMapPortFilter() {
        // Watch for the customControls ship icon click -> port markers appear
        document.addEventListener('click', function(e) {
            var ctrl = e.target.closest('.customControls');
            if (!ctrl) return;
            // Port markers appear/disappear after a short delay
            setTimeout(function() {
                var markers = document.querySelectorAll('.leaflet-marker-icon[src*="porticon"]');
                if (markers.length > 0 && !mapFilterInjected) {
                    injectMapFilterControl();
                } else if (markers.length === 0 && mapFilterInjected) {
                    removeMapFilterControl();
                }
            }, 500);
        });

        // Also check periodically in case markers appear via other means
        // Only run when page is visible (Page Visibility API)
        var checkInterval = null;

        function startMapMarkerCheck() {
            if (checkInterval) return;
            checkInterval = setInterval(function() {
                var markers = document.querySelectorAll('.leaflet-marker-icon[src*="porticon"]');
                if (markers.length > 0 && !mapFilterInjected) {
                    injectMapFilterControl();
                } else if (markers.length === 0 && mapFilterInjected) {
                    removeMapFilterControl();
                }
            }, 2000);
        }

        function stopMapMarkerCheck() {
            if (checkInterval) {
                clearInterval(checkInterval);
                checkInterval = null;
            }
        }

        // Start/stop based on page visibility
        startMapMarkerCheck();
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                stopMapMarkerCheck();
            } else {
                startMapMarkerCheck();
            }
        });

        // Cleanup on page unload
        window.addEventListener('beforeunload', function() {
            stopMapMarkerCheck();
        });
    }

    function injectMapFilterControl() {
        if (mapFilterInjected) return;
        var rightControls = document.querySelector('.leaflet-top.leaflet-right');
        if (!rightControls) return;

        mapFilterInjected = true;

        var container = document.createElement('div');
        container.id = 'demand-map-filter-control';
        container.className = 'leaflet-control-layers leaflet-control customControls';
        container.style.cssText = 'cursor:pointer;display:flex;align-items:center;justify-content:center;';
        container.title = 'Demand Filter';

        // Filter SVG icon — same size as the ship icon SVG in customControls
        container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#666;"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>';

        container.addEventListener('click', function(e) {
            e.stopPropagation();
            if (mapFilterPanelOpen) {
                closeMapFilterPanel();
            } else {
                openMapFilterPanel(container);
            }
        });

        // Insert after the customControls
        var customCtrl = rightControls.querySelector('.customControls');
        if (customCtrl && customCtrl.nextSibling) {
            rightControls.insertBefore(container, customCtrl.nextSibling);
        } else {
            rightControls.appendChild(container);
        }
    }

    function removeMapFilterControl() {
        mapFilterInjected = false;
        mapFilterPanelOpen = false;
        mapFilterActive = { teu: null, bbl: null, noVessels: false };
        restoreAllMapMarkers();
        mapFilterHiddenMarkers = [];
        // Invalidate port marker layer cache (markers may be removed from DOM)
        invalidatePortMarkerLayerCache();
        var ctrl = document.getElementById('demand-map-filter-control');
        if (ctrl) ctrl.remove();
        var panel = document.getElementById('demand-map-filter-panel');
        if (panel) panel.remove();
    }

    function openMapFilterPanel(anchorEl) {
        closeMapFilterPanel();
        mapFilterPanelOpen = true;

        var panel = document.createElement('div');
        panel.id = 'demand-map-filter-panel';
        panel.style.cssText = 'position:fixed;background:#1a1a2e;border:1px solid #374151;border-radius:6px;padding:8px;z-index:9999;min-width:180px;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-size:12px;color:#fff;';

        // TEU section
        panel.appendChild(createMapFilterSection('DEMAND TEU', TEU_RANGES, 'teu'));

        // BBL section
        panel.appendChild(createMapFilterSection('DEMAND BBL', BBL_RANGES, 'bbl'));

        // Separator
        var sep = document.createElement('div');
        sep.style.cssText = 'border-top:1px solid #374151;margin:6px 0;';
        panel.appendChild(sep);

        // NO VESSELS toggle
        var noVRow = document.createElement('div');
        noVRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;';
        var noVCheck = document.createElement('input');
        noVCheck.type = 'checkbox';
        noVCheck.checked = mapFilterActive.noVessels;
        noVCheck.style.cssText = 'margin:0;cursor:pointer;';
        var noVLabel = document.createElement('span');
        noVLabel.textContent = 'NO VESSELS';
        noVLabel.style.cssText = 'cursor:pointer;';
        noVRow.appendChild(noVCheck);
        noVRow.appendChild(noVLabel);
        noVRow.addEventListener('click', function(e) {
            if (e.target !== noVCheck) noVCheck.checked = !noVCheck.checked;
            mapFilterActive.noVessels = noVCheck.checked;
            applyMapPortFilter();
        });
        panel.appendChild(noVRow);

        // Separator
        var sep2 = document.createElement('div');
        sep2.style.cssText = 'border-top:1px solid #374151;margin:6px 0;';
        panel.appendChild(sep2);

        // Reset button
        var resetBtn = document.createElement('button');
        resetBtn.textContent = 'RESET';
        resetBtn.style.cssText = 'width:100%;padding:6px;background:#374151;border:0;border-radius:4px;color:#fff;font-size:11px;cursor:pointer;';
        resetBtn.addEventListener('click', function() {
            mapFilterActive = { teu: null, bbl: null, noVessels: false };
            restoreAllMapMarkers();
            closeMapFilterPanel();
            updateMapFilterIcon();
        });
        panel.appendChild(resetBtn);

        // Close when clicking outside
        setTimeout(function() {
            document.addEventListener('click', mapFilterOutsideClickHandler);
        }, 0);

        // Position panel
        document.body.appendChild(panel);
        var rect = anchorEl.getBoundingClientRect();
        var panelW = panel.offsetWidth;
        var left = rect.left - panelW - 4;
        if (left < 8) left = rect.right + 4;
        var top = rect.top;
        if (top + panel.offsetHeight > window.innerHeight - 8) {
            top = window.innerHeight - panel.offsetHeight - 8;
        }
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    function mapFilterOutsideClickHandler(e) {
        var panel = document.getElementById('demand-map-filter-panel');
        var ctrl = document.getElementById('demand-map-filter-control');
        if (panel && !panel.contains(e.target) && ctrl && !ctrl.contains(e.target)) {
            closeMapFilterPanel();
        }
    }

    function closeMapFilterPanel() {
        mapFilterPanelOpen = false;
        var panel = document.getElementById('demand-map-filter-panel');
        if (panel) panel.remove();
        document.removeEventListener('click', mapFilterOutsideClickHandler);
    }

    function createMapFilterSection(title, ranges, type) {
        var section = document.createElement('div');
        section.style.cssText = 'margin-bottom:6px;';

        var label = document.createElement('div');
        label.textContent = title;
        label.style.cssText = 'font-size:10px;color:#9ca3af;margin-bottom:4px;';
        section.appendChild(label);

        var select = document.createElement('select');
        select.style.cssText = 'width:100%;padding:4px;background:#2a2a4e;border:1px solid #374151;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;';
        for (var i = 0; i < ranges.length; i++) {
            var opt = document.createElement('option');
            opt.value = ranges[i].min;
            opt.textContent = ranges[i].label;
            if (mapFilterActive[type] === ranges[i].min || (mapFilterActive[type] === null && ranges[i].min === 0)) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }
        select.addEventListener('change', function() {
            var val = parseInt(select.value, 10);
            mapFilterActive[type] = val === 0 ? null : val;
            applyMapPortFilter();
        });
        section.appendChild(select);
        return section;
    }

    // Cached port marker layers - WeakMap for layer->port-code mapping
    var portMarkerLayerCache = null; // Array of { layer, code } for port-icon layers only
    var portMarkerLayerMap = new WeakMap(); // layer -> portCode

    function getPortMarkerLayers() {
        var map = getLeafletMap();
        if (!map) return [];

        // Rebuild cache if empty
        if (!portMarkerLayerCache) {
            portMarkerLayerCache = [];
            var layers = map._layers;
            for (var layerId in layers) {
                var layer = layers[layerId];
                if (!layer._icon || !layer.options || !layer.options.port) continue;
                var src = layer._icon.getAttribute('src');
                if (!src || !src.includes('porticon')) continue;
                var code = layer.options.port.code;
                portMarkerLayerCache.push({ layer: layer, code: code });
                portMarkerLayerMap.set(layer, code);
            }
        }
        return portMarkerLayerCache;
    }

    function invalidatePortMarkerLayerCache() {
        portMarkerLayerCache = null;
    }

    function applyMapPortFilter() {
        var hasAnyFilter = mapFilterActive.teu || mapFilterActive.bbl || mapFilterActive.noVessels;

        updateMapFilterIcon();

        if (!hasAnyFilter) {
            restoreAllMapMarkers();
            return;
        }

        if ((mapFilterActive.teu || mapFilterActive.bbl) && !cachedData) {
            showToast('No demand data. Collect first.', 'error');
            return;
        }

        // Build lookup from cachedData
        var demandByCode = {};
        if (cachedData && cachedData.ports) {
            for (var i = 0; i < cachedData.ports.length; i++) {
                var p = cachedData.ports[i];
                demandByCode[p.code] = p;
            }
        }

        var vesselsByPort = mapFilterActive.noVessels ? getVesselsByPort() : {};

        // Restore all first
        restoreAllMapMarkers();
        mapFilterHiddenMarkers = [];

        // Use cached port marker layer list (only port markers, not all layers)
        var portLayers = getPortMarkerLayers();
        for (var i = 0; i < portLayers.length; i++) {
            var entry = portLayers[i];
            var layer = entry.layer;
            var code = entry.code;
            var shouldHide = false;

            // TEU filter
            if (mapFilterActive.teu) {
                var portData = demandByCode[code];
                if (!portData) {
                    shouldHide = true;
                } else {
                    var demand = portData.demand || {};
                    var consumed = portData.consumed || {};
                    var cd = demand.container || {};
                    var cc = consumed.container || {};
                    var currentTEU = Math.max(0, (cd.dry || 0) + (cd.refrigerated || 0) - (cc.dry || 0) - (cc.refrigerated || 0));
                    if (currentTEU < mapFilterActive.teu) shouldHide = true;
                }
            }

            // BBL filter
            if (!shouldHide && mapFilterActive.bbl) {
                var portDataB = demandByCode[code];
                if (!portDataB) {
                    shouldHide = true;
                } else {
                    var demandB = portDataB.demand || {};
                    var consumedB = portDataB.consumed || {};
                    var td = demandB.tanker || {};
                    var tc = consumedB.tanker || {};
                    var currentBBL = Math.max(0, (td.fuel || 0) + (td.crude_oil || 0) - (tc.fuel || 0) - (tc.crude_oil || 0));
                    if (currentBBL < mapFilterActive.bbl) shouldHide = true;
                }
            }

            // No vessels filter
            if (!shouldHide && mapFilterActive.noVessels) {
                var vp = vesselsByPort[code];
                if (vp) {
                    var hasDest = vp.destContainerCount > 0 || vp.destTankerCount > 0;
                    var hasOrigin = vp.originContainerCount > 0 || vp.originTankerCount > 0;
                    if (hasDest || hasOrigin) shouldHide = true;
                }
            }

            if (shouldHide) {
                if (layer._icon) layer._icon.style.display = 'none';
                if (layer._shadow) layer._shadow.style.display = 'none';
                mapFilterHiddenMarkers.push(layer);
            }
        }

        var totalMarkers = portLayers.length;
        var visibleCount = totalMarkers - mapFilterHiddenMarkers.length;
        log('Map filter: ' + visibleCount + '/' + totalMarkers + ' ports visible');
    }

    function restoreAllMapMarkers() {
        for (var i = 0; i < mapFilterHiddenMarkers.length; i++) {
            var layer = mapFilterHiddenMarkers[i];
            if (layer._icon) layer._icon.style.display = '';
            if (layer._shadow) layer._shadow.style.display = '';
        }
        mapFilterHiddenMarkers = [];
    }

    function updateMapFilterIcon() {
        var ctrl = document.getElementById('demand-map-filter-control');
        if (!ctrl) return;
        var svg = ctrl.querySelector('svg');
        if (!svg) return;
        var hasFilter = mapFilterActive.teu || mapFilterActive.bbl || mapFilterActive.noVessels;
        svg.style.color = hasFilter ? '#3b82f6' : '#666';
    }

    // ========== MAP MARKER HOVER ==========
    // Show demand tooltip when hovering over port markers on harbor map

    function initMapMarkerHover() {
        function isPortMarker(el) {
            if (!el || !el.classList || !el.classList.contains('leaflet-marker-icon')) return false;
            const src = el.getAttribute('src');
            return src && src.includes('porticon');
        }

        // Desktop: mouse hover
        document.addEventListener('mouseenter', function(e) {
            if (!demandSettings.mapTooltipsEnabled) return;
            if (!isPortMarker(e.target)) return;
            const portCode = getPortCodeFromMarker(e.target);
            if (portCode) {
                showMapTooltip(portCode, e.target);
            }
        }, true);

        document.addEventListener('mouseleave', function(e) {
            if (!isPortMarker(e.target)) return;
            hideTooltipDelayed();
        }, true);

        // Mobile: long-press (500ms)
        document.addEventListener('touchstart', function(e) {
            if (!demandSettings.mapTooltipsEnabled) return;
            const marker = e.target;
            if (!isPortMarker(marker)) return;

            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }

            longPressTimer = setTimeout(function() {
                const portCode = getPortCodeFromMarker(marker);
                if (portCode) {
                    showMapTooltip(portCode, marker);
                }
                longPressTimer = null;
            }, LONG_PRESS_DURATION);
        }, true);

        document.addEventListener('touchend', function(e) {
            if (!isPortMarker(e.target)) return;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, true);

        document.addEventListener('touchmove', function() {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, true);

        // Close tooltip when tapping elsewhere
        document.addEventListener('touchstart', function(e) {
            if (tooltipElement && tooltipElement.style.display === 'block') {
                if (!tooltipElement.contains(e.target) && !isPortMarker(e.target)) {
                    hideTooltip();
                }
            }
        }, false);
    }

    function getLeafletMap() {
        // Get Leaflet map from mapStore (stored as mapStore.map = this.map in game code)
        try {
            const mapStore = getStore('mapStore');
            if (mapStore && mapStore.map) {
                return mapStore.map;
            }
        } catch {
            // Ignore
        }
        return null;
    }

    function getPortCodeFromMarker(markerElement) {
        const map = getLeafletMap();
        if (!map) return null;

        try {
            // Iterate through map._layers to find the one with this icon
            let foundCode = null;
            const layers = map._layers;
            for (var layerId in layers) {
                if (foundCode) break;
                var layer = layers[layerId];
                if (layer._icon === markerElement && layer.options && layer.options.port) {
                    foundCode = layer.options.port.code;
                }
            }
            return foundCode;
        } catch {
            return null;
        }
    }

    function showMapTooltip(portCode, markerElement) {
        const cache = loadCacheSync();
        if (!cache || !cache.ports) return;

        const port = cache.ports.find(function(p) { return p.code === portCode; });
        if (!port) return;

        const tooltip = createTooltip();
        const demand = port.demand || {};
        const consumed = port.consumed || {};
        const containerDemand = demand.container || {};
        const containerConsumed = consumed.container || {};
        const tankerDemand = demand.tanker || {};
        const tankerConsumed = consumed.tanker || {};
        const vesselsByPort = getVesselsByPortWithFallback();
        const vessels = vesselsByPort[portCode] || {};
        const rankings = loadRankingCacheSync();
        const portRanking = rankings && rankings.ports ? rankings.ports[portCode] : null;

        const lastUpdated = getPortLastUpdated(portCode);
        const rankingLastUpdated = rankings ? rankings.timestamp : null;

        let html = '<div style="font-weight:bold;font-size:14px;margin-bottom:8px;color:#3b82f6;">' + escapeHtml(capitalizePortName(portCode)) + '</div>';

        // Container demand
        if (containerDemand.dry || containerDemand.refrigerated) {
            html += '<div style="margin-bottom:6px;">';
            html += '<div style="color:#9ca3af;font-size:10px;margin-bottom:2px;">CONTAINER DEMAND</div>';
            if (containerDemand.dry) {
                const dryRemain = Math.max(0, containerDemand.dry - (containerConsumed.dry || 0));
                html += '<div>Dry: ' + formatNumber(dryRemain) + ' / ' + formatNumber(containerDemand.dry) + ' TEU</div>';
            }
            if (containerDemand.refrigerated) {
                const refRemain = Math.max(0, containerDemand.refrigerated - (containerConsumed.refrigerated || 0));
                html += '<div>Ref: ' + formatNumber(refRemain) + ' / ' + formatNumber(containerDemand.refrigerated) + ' TEU</div>';
            }
            html += '</div>';
        }

        // Tanker demand
        if (tankerDemand.fuel || tankerDemand.crude_oil) {
            html += '<div style="margin-bottom:6px;">';
            html += '<div style="color:#9ca3af;font-size:10px;margin-bottom:2px;">TANKER DEMAND</div>';
            if (tankerDemand.fuel) {
                const fuelRemain = Math.max(0, tankerDemand.fuel - (tankerConsumed.fuel || 0));
                html += '<div>Fuel: ' + formatNumber(fuelRemain) + ' / ' + formatNumber(tankerDemand.fuel) + ' BBL</div>';
            }
            if (tankerDemand.crude_oil) {
                const crudeRemain = Math.max(0, tankerDemand.crude_oil - (tankerConsumed.crude_oil || 0));
                html += '<div>Crude: ' + formatNumber(crudeRemain) + ' / ' + formatNumber(tankerDemand.crude_oil) + ' BBL</div>';
            }
            html += '</div>';
        }

        // Vessels section
        const hasDestVessels = vessels.destContainerCount || vessels.destTankerCount;
        const hasOriginVessels = vessels.originContainerCount || vessels.originTankerCount;
        html += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #374151;">';
        html += '<div style="color:#9ca3af;font-size:10px;margin-bottom:4px;">YOUR VESSELS</div>';

        html += '<div style="margin-bottom:4px;"><span style="color:#4ade80;">Arriving:</span></div>';
        if (hasDestVessels) {
            if (vessels.destContainerCount) {
                html += '<div style="margin-left:12px;">' + vessels.destContainerCount + ' cargo (' + formatNumber(vessels.destContainerCapacity) + ' TEU)</div>';
            }
            if (vessels.destTankerCount) {
                html += '<div style="margin-left:12px;">' + vessels.destTankerCount + ' tanker (' + formatNumber(vessels.destTankerCapacity) + ' BBL)</div>';
            }
        } else {
            html += '<div style="margin-left:12px;">0</div>';
        }

        html += '<div style="margin-top:4px;"><span style="color:#f59e0b;">Departing:</span></div>';
        if (hasOriginVessels) {
            if (vessels.originContainerCount) {
                html += '<div style="margin-left:12px;">' + vessels.originContainerCount + ' cargo (' + formatNumber(vessels.originContainerCapacity) + ' TEU)</div>';
            }
            if (vessels.originTankerCount) {
                html += '<div style="margin-left:12px;">' + vessels.originTankerCount + ' tanker (' + formatNumber(vessels.originTankerCapacity) + ' BBL)</div>';
            }
        } else {
            html += '<div style="margin-left:12px;">0</div>';
        }
        html += '</div>';

        // Alliance Ranking section
        if (portRanking) {
            html += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #374151;">';
            html += '<div style="color:#9ca3af;font-size:10px;margin-bottom:4px;">ALLIANCE RANKING</div>';
            if (portRanking.myAlliance) {
                html += '<div style="margin-bottom:4px;">\uD83C\uDFC6 Your rank: <span style="color:#f59e0b;font-weight:bold;">#' + portRanking.myAlliance.rank + '</span></div>';
                html += '<div style="font-size:11px;color:#9ca3af;">TEU: ' + formatNumber(portRanking.myAlliance.teu) + ' | BBL: ' + formatNumber(portRanking.myAlliance.bbl) + '</div>';
            }
            if (portRanking.topAlliances && portRanking.topAlliances.length > 0) {
                html += '<div style="margin-top:6px;font-size:10px;color:#9ca3af;">Top 3:</div>';
                for (var i = 0; i < Math.min(3, portRanking.topAlliances.length); i++) {
                    var ally = portRanking.topAlliances[i];
                    html += '<div style="font-size:11px;margin-left:8px;">' + ally.rank + '. ' + escapeHtml(ally.name) + '</div>';
                }
            }
            html += '</div>';
        }

        // Last updated
        html += '<div style="color:#9ca3af;font-size:10px;margin-top:8px;padding-top:8px;border-top:1px solid #374151;">';
        html += 'Demand: ' + formatTimestamp(lastUpdated);
        if (rankingLastUpdated) {
            html += '<br>Ranking: ' + formatTimestamp(rankingLastUpdated);
        }
        html += '</div>';

        // Refresh button (refreshes ALL ports with 5min cooldown)
        html += getRefreshButtonHtml('map-tooltip-refresh-btn');

        tooltip.innerHTML = html;

        // Position tooltip - measure actual size first
        tooltip.style.visibility = 'hidden';
        tooltip.style.display = 'block';
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;
        tooltip.style.visibility = 'visible';

        const rect = markerElement.getBoundingClientRect();
        const padding = 10;
        let left, top;

        // Horizontal: prefer right of marker, fallback to left
        if (rect.right + padding + tooltipWidth <= window.innerWidth) {
            left = rect.right + padding;
        } else if (rect.left - padding - tooltipWidth >= 0) {
            left = rect.left - padding - tooltipWidth;
        } else {
            left = Math.max(padding, Math.min(window.innerWidth - tooltipWidth - padding, rect.left));
        }

        // Vertical: center on marker, but keep in viewport
        top = rect.top + (rect.height / 2) - (tooltipHeight / 2);
        if (top < padding) {
            top = padding;
        } else if (top + tooltipHeight > window.innerHeight - padding) {
            top = window.innerHeight - tooltipHeight - padding;
        }

        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';

        // Attach refresh button handler
        const refreshBtn = document.getElementById('map-tooltip-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async function(e) {
                e.stopPropagation();
                hideTooltip();
                await refreshAllPorts();
            });
        }

        // Keep tooltip visible when hovering over it
        tooltip.addEventListener('mouseenter', function() {
            if (tooltipTimeout) {
                clearTimeout(tooltipTimeout);
                tooltipTimeout = null;
            }
        });

        tooltip.addEventListener('mouseleave', function() {
            hideTooltip();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
