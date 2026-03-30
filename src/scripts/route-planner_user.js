// ==UserScript==
// @name         ShippingManager - Route Planner
// @namespace    https://github.com/PiratesTreasure
// @description  Plan optimal routes based on demand, travel time, and pirate risk
// @version      1.0
// @author       https://github.com/PiratesTreasure
// @order        15
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @RequirePiratesTreasureMenu true
// @RequirePiratesTreasureStorage true
// @enabled      false
// ==/UserScript==

/* global addMenuItem */
(function() {
    'use strict';

    var SCRIPT_NAME = 'RoutePlanner';
    var STORE_NAME = 'data';
    var RETRY_DELAYS = [500, 1000, 2000, 4000];
    var SEA_ROUTE_MULTIPLIER = 1.3;
    var EARTH_RADIUS_NM = 3440.065;
    // Game time: travelHours = distance / speed / 48 + PORT_OVERHEAD
    // Calibrated from game's Create Route screen:
    //   Southampton→Boston:      3233nm @ 30kn = 02:36:22 real
    //   Southampton→Providenija: 4942nm @ 30kn = 03:47:35 real
    var GAME_TIME_FACTOR = 48;
    var PORT_OVERHEAD_HOURS = 13 / 36; // ~21m 40s loading/port time per leg

    var DEFAULT_SETTINGS = {
        defaultSpeed: 30,
        idealTravelHours: 3,
        fuelPrice: 500,
        co2Price: 10,
        showExcludedPorts: false,
        weights: { demandSustainability: 50, travelTime: 50 }
    };

    var settings = {};
    var isModalOpen = false;
    var stylesInjected = false;
    var _toggleableChannelIds = []; // Populated from route store on init

    // ========== STORAGE ==========

    async function dbGet(key, retryCount) {
        retryCount = retryCount || 0;
        if (!window.PiratesTreasureBridge || !window.PiratesTreasureBridge.storage) return null;
        try {
            var result = await window.PiratesTreasureBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) return JSON.parse(result);
            return null;
        } catch (e) {
            if (retryCount < RETRY_DELAYS.length) {
                await new Promise(function(r) { setTimeout(r, RETRY_DELAYS[retryCount]); });
                return dbGet(key, retryCount + 1);
            }
            return null;
        }
    }

    async function dbSet(key, value) {
        if (!window.PiratesTreasureBridge || !window.PiratesTreasureBridge.storage) return false;
        try {
            await window.PiratesTreasureBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    // Read DemandSummary's demand cache directly
    async function getDemandCache() {
        if (!window.PiratesTreasureBridge || !window.PiratesTreasureBridge.storage) return null;
        try {
            var result = await window.PiratesTreasureBridge.storage.get('DemandSummary', 'data', 'demandCache');
            if (result) return JSON.parse(result);
            return null;
        } catch (e) {
            return null;
        }
    }

    // ========== SETTINGS ==========

    async function loadSettings() {
        var saved = await dbGet('settings');
        settings = Object.assign({}, DEFAULT_SETTINGS, saved || {});
        if (!settings.weights) settings.weights = Object.assign({}, DEFAULT_SETTINGS.weights);
    }

    async function saveSettings() {
        await dbSet('settings', settings);
    }

    // ========== PINIA STORE ACCESS ==========

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

    function getVesselStore() {
        return getStore('vessel');
    }

    // Build hijacking risk cache from all fleet vessel routes (same approach as RebelShip)
    function getHijackingRiskCache() {
        var cache = {};
        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return cache;

        for (var i = 0; i < vesselStore.userVessels.length; i++) {
            var v = vesselStore.userVessels[i];
            if (!v.routes || !Array.isArray(v.routes)) continue;
            for (var j = 0; j < v.routes.length; j++) {
                var route = v.routes[j];
                if (route.origin && route.destination && route.hijacking_risk !== undefined) {
                    var key = route.origin + '<>' + route.destination;
                    var revKey = route.destination + '<>' + route.origin;
                    cache[key] = route.hijacking_risk;
                    cache[revKey] = route.hijacking_risk;
                }
            }
        }
        return cache;
    }

    function getHijackingRisk(originPort, destPort) {
        var cache = getHijackingRiskCache();
        return cache[originPort + '<>' + destPort] || cache[destPort + '<>' + originPort] || 0;
    }

    function goToPortOnMap(lat, lon, portCode) {
        try {
            var mapStore = getStore('mapStore');
            if (mapStore && mapStore.map) {
                // Close the route planner modal first
                closeModal();
                // Pan to the port on the Leaflet map
                mapStore.map.setView([lat, lon], 6, { animate: true });
                log('Map navigated to ' + portCode + ' (' + lat + ', ' + lon + ')');
            } else {
                log('Map store not available');
            }
        } catch (e) {
            log('goToPortOnMap error: ' + e.message);
        }
    }

    function getModalStore() {
        return getStore('modal');
    }

    // ========== LOGGING ==========

    function log(msg) {
        console.log('[' + SCRIPT_NAME + '] ' + msg);
    }

    // ========== DISTANCE CALCULATION ==========

    function haversineDistance(lat1, lon1, lat2, lon2) {
        var R = EARTH_RADIUS_NM;
        var vLat = lat1 * Math.PI / 180;
        var pLat = lat2 * Math.PI / 180;
        var dLat = pLat - vLat;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(vLat) * Math.cos(pLat) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var gcDist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return gcDist * SEA_ROUTE_MULTIPLIER;
    }

    // Fetch available ports for a vessel from game API
    var vesselPortsCache = {};
    var VESSEL_PORTS_CACHE_TTL = 5 * 60 * 1000; // 5 min

    // Route distance cache: keyed by "vesselId:originPort" → { routes, timestamp }
    var routeDistanceCache = {};
    var ROUTE_DISTANCE_CACHE_TTL = 10 * 60 * 1000; // 10 min
    var prefetchInProgress = {}; // track active prefetches to avoid duplicates

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
            if (!response.ok) {
                log('fetchVesselPorts HTTP error: ' + response.status);
                return null;
            }
            var data = await response.json();
            if (data && data.data && data.data.all && data.data.all.ports) {
                var ports = data.data.all.ports;
                vesselPortsCache[vesselId] = { ports: ports, timestamp: Date.now() };
                log('Fetched ' + ports.length + ' reachable ports from API for vessel ' + vesselId);
                if (ports.length > 0) log('Port sample keys: ' + Object.keys(ports[0]).join(', ') + ' | sample: ' + JSON.stringify(ports[0]).substring(0, 300));
                return ports;
            }
            log('fetchVesselPorts: unexpected response structure');
        } catch (e) {
            log('fetchVesselPorts error: ' + e.message);
        }
        return null;
    }

    // Fetch real game distance for a single route via get-routes-by-ports API
    // Passes toggleable channel IDs so the API returns all route options (passage variants)
    async function fetchGameRouteDistance(vesselId, originPort, destPort) {
        try {
            var reqBody = { user_vessel_id: vesselId, port1: originPort, port2: destPort };
            if (_toggleableChannelIds.length > 0) {
                reqBody.channels = _toggleableChannelIds;
            }
            var resp = await fetch(API_BASE + '/route/get-routes-by-ports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(reqBody)
            });
            if (!resp.ok) return null;
            var data = await resp.json();
            if (data && data.data) {
                var routes = Array.isArray(data.data) ? data.data :
                             data.data.routes ? data.data.routes :
                             data.data.route ? [data.data.route] : [];
                if (routes.length > 0) {
                    // Log route count and pick shortest route (passages make routes shorter)
                    if (!window._rpRouteKeysLogged) {
                        window._rpRouteKeysLogged = true;
                        if (routes.length > 1) {
                            log('Route API returned ' + routes.length + ' route options — picking shortest');
                        }
                    }
                    // Pick the shortest route (passage routes are shorter)
                    var r0 = routes[0];
                    for (var si = 1; si < routes.length; si++) {
                        var d0 = r0.total_distance || r0.distance || Infinity;
                        var di = routes[si].total_distance || routes[si].distance || Infinity;
                        if (di < d0) r0 = routes[si];
                    }
                    // Capture for debugging
                    if (!window._rpRouteDebug) {
                        window._rpRouteDebug = JSON.stringify(r0).substring(0, 1000);
                    }
                    // Only show CANAL badge for paid toggleable channels (Suez, Panama, etc.)
                    var usesPaidCanal = false;
                    if (r0.channels_ids && r0.channel_cost > 0) {
                        usesPaidCanal = true;
                    }
                    return {
                        distance: r0.total_distance || r0.distance || r0.nm || null,
                        usesCanal: usesPaidCanal,
                        channelFee: r0.channel_cost || r0.channel_fee || r0.channel_payment || 0,
                        routeId: r0.id || r0.route_id || null,
                        hijackingRisk: r0.hijacking_risk || r0.piracy_risk || r0.risk || r0.pirate_risk || 0
                    };
                }
            }
        } catch (e) {
            log('fetchGameRouteDistance error: ' + e.message);
        }
        return null;
    }

    // Build distance map: get reachable ports, then batch-fetch real distances
    async function fetchRouteDistances(vesselId, originPortCode, statusCallback) {
        // Check cache first
        var cacheKey = vesselId + ':' + originPortCode;
        var cached = routeDistanceCache[cacheKey];
        if (cached && Date.now() - cached.timestamp < ROUTE_DISTANCE_CACHE_TTL) {
            log('Route distances cache hit for ' + originPortCode + ' (' + Object.keys(cached.routes).length + ' ports)');
            return cached.routes;
        }

        // If a prefetch is already running for this key, wait for it
        if (prefetchInProgress[cacheKey]) {
            log('Waiting for prefetch in progress: ' + cacheKey);
            await prefetchInProgress[cacheKey];
            cached = routeDistanceCache[cacheKey];
            if (cached) return cached.routes;
        }
        var ports = await fetchVesselPorts(vesselId);
        if (!ports || ports.length === 0) {
            log('No ports from API, will use Haversine fallback');
            return null;
        }

        // Get origin coords for Haversine pre-filter
        var originLat = null, originLon = null;
        for (var i = 0; i < ports.length; i++) {
            if (ports[i].code === originPortCode || ports[i].port_code === originPortCode) {
                originLat = parseFloat(ports[i].lat);
                originLon = parseFloat(ports[i].lon);
                break;
            }
        }
        if (originLat === null) {
            var cache = await getDemandCache();
            if (cache && cache.ports) {
                for (var j = 0; j < cache.ports.length; j++) {
                    if (cache.ports[j].code === originPortCode) {
                        originLat = parseFloat(cache.ports[j].lat);
                        originLon = parseFloat(cache.ports[j].lon);
                        break;
                    }
                }
            }
        }
        if (originLat === null || originLon === null) {
            log('Could not find origin coords for ' + originPortCode);
            return null;
        }

        // Build port list with Haversine estimates
        var portList = [];
        for (var k = 0; k < ports.length; k++) {
            var p = ports[k];
            var code = p.code || p.port_code;
            if (!code || code === originPortCode) continue;
            var pLat = parseFloat(p.lat);
            var pLon = parseFloat(p.lon);
            if (isNaN(pLat) || isNaN(pLon)) continue;
            portList.push({ code: code, haversine: haversineDistance(originLat, originLon, pLat, pLon) });
        }

        // Fetch real distances from game API in batches
        var routes = {};
        var BATCH_SIZE = 10;
        var BATCH_DELAY = 50;
        var totalPorts = portList.length;
        log('Fetching real distances for ' + totalPorts + ' ports from ' + originPortCode + '...');

        for (var b = 0; b < portList.length; b += BATCH_SIZE) {
            var batch = portList.slice(b, b + BATCH_SIZE);
            var results = await Promise.all(batch.map(function(item) {
                return fetchGameRouteDistance(vesselId, originPortCode, item.code)
                    .then(function(r) { return { code: item.code, data: r, haversine: item.haversine }; });
            }));

            for (var r = 0; r < results.length; r++) {
                var res = results[r];
                if (res.data && res.data.distance) {
                    routes[res.code] = {
                        distance: res.data.distance,
                        usesCanal: res.data.usesCanal,
                        channelFee: res.data.channelFee,
                        routeId: res.data.routeId,
                        hijackingRisk: res.data.hijackingRisk || 0
                    };
                } else {
                    routes[res.code] = {
                        distance: res.haversine,
                        channelFee: 0,
                        usesCanal: false,
                        hijackingRisk: 0
                    };
                }
            }

            // Update status if callback provided
            var fetched = Math.min(b + BATCH_SIZE, totalPorts);
            if (statusCallback) statusCallback(fetched, totalPorts);

            if (b + BATCH_SIZE < portList.length) {
                await new Promise(function(resolve) { setTimeout(resolve, BATCH_DELAY); });
            }
        }

        var gameCount = Object.values(routes).filter(function(r) { return r.routeId; }).length;
        log('Built distance map for ' + Object.keys(routes).length + ' ports (' + gameCount + ' from game API)');

        // Store in cache
        routeDistanceCache[cacheKey] = { routes: routes, timestamp: Date.now() };
        return routes;
    }

    // Pre-fetch distances for all idle vessels in background
    async function prefetchAllDistances() {
        var idle = getIdleVessels();
        if (idle.length === 0) return;

        // Group by origin port to avoid duplicate fetches for same port
        var byOrigin = {};
        for (var i = 0; i < idle.length; i++) {
            var v = idle[i];
            var origin = v.current_port_code;
            if (!origin) continue;
            if (!byOrigin[origin]) byOrigin[origin] = v;
        }

        var origins = Object.keys(byOrigin);
        log('Pre-fetching distances for ' + origins.length + ' unique origin ports (' + idle.length + ' idle vessels)');

        for (var j = 0; j < origins.length; j++) {
            var vessel = byOrigin[origins[j]];
            var cacheKey = vessel.id + ':' + origins[j];

            // Skip if already cached or in progress
            if (routeDistanceCache[cacheKey] && Date.now() - routeDistanceCache[cacheKey].timestamp < ROUTE_DISTANCE_CACHE_TTL) continue;
            if (prefetchInProgress[cacheKey]) continue;

            prefetchInProgress[cacheKey] = fetchRouteDistances(vessel.id, origins[j]).then(function(key) {
                return function() { delete prefetchInProgress[key]; };
            }(cacheKey)).catch(function(key) {
                return function() { delete prefetchInProgress[key]; };
            }(cacheKey));
        }
    }

    // ========== ROUTE CREATION & DEPARTURE ==========

    var API_BASE = window.PIRATE_API_BASE || 'https://shippingmanager.cc/api';

    async function resumeParkedVessel(vesselId) {
        try {
            var response = await fetch(API_BASE + '/vessel/resume-parked-vessel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ vessel_id: vesselId })
            });
            if (!response.ok) return { success: false, error: 'HTTP ' + response.status };
            var data = await response.json();
            return { success: true, data: data };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async function createRouteAndDepart(vesselId, originPort, destPort, speed, hijackingRisk) {
        try {
            // Step 0: If vessel is parked/anchored, resume it first
            var vesselStore = getVesselStore();
            if (vesselStore && vesselStore.userVessels) {
                var vessel = vesselStore.userVessels.find(function(v) { return v.id === vesselId; });
                if (vessel && vessel.is_parked) {
                    _debugLog.push('Vessel is parked, resuming...');
                    var resumeResult = await resumeParkedVessel(vesselId);
                    if (!resumeResult.success) {
                        return { success: false, error: 'Failed to resume parked vessel: ' + resumeResult.error };
                    }
                    await new Promise(function(r) { setTimeout(r, 500); });
                }
            }

            // Will determine guards after checking route data for hijacking risk
            var guards = (hijackingRisk && hijackingRisk > 0) ? 10 : 0;

            // Step 1: Get route ID by searching routes between origin and destination
            _debugLog.push('Step 1: Fetching routes ' + originPort + ' → ' + destPort);
            var departReqBody = { user_vessel_id: vesselId, port1: originPort, port2: destPort };
            if (_toggleableChannelIds.length > 0) departReqBody.channels = _toggleableChannelIds;
            var routesResp = await fetch(API_BASE + '/route/get-routes-by-ports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(departReqBody)
            });
            if (!routesResp.ok) {
                var routesErr = await routesResp.json().catch(function() { return {}; });
                _debugLog.push('Get routes failed: HTTP ' + routesResp.status + ' ' + JSON.stringify(routesErr));
                return { success: false, error: 'Get routes failed: HTTP ' + routesResp.status };
            }
            var routesData = await routesResp.json();
            _debugLog.push('Routes response: ' + JSON.stringify(routesData).substring(0, 500));

            // Find the route_id from the response
            var routeId = null;
            if (routesData.data) {
                // Could be array of routes or object with routes property
                var routes = Array.isArray(routesData.data) ? routesData.data :
                             routesData.data.routes ? routesData.data.routes :
                             routesData.data.route ? [routesData.data.route] : [];
                if (routes.length > 0) {
                    // Pick shortest route (passage variants may be shorter)
                    var bestRoute = routes[0];
                    for (var bri = 1; bri < routes.length; bri++) {
                        var bd = bestRoute.total_distance || bestRoute.distance || Infinity;
                        var cd = routes[bri].total_distance || routes[bri].distance || Infinity;
                        if (cd < bd) bestRoute = routes[bri];
                    }
                    routeId = bestRoute.id || bestRoute.route_id;
                    _debugLog.push('Selected shortest route: ' + (bestRoute.total_distance || bestRoute.distance) + 'nm (of ' + routes.length + ' options)');
                }
            }

            if (!routeId) {
                _debugLog.push('No route_id found in response');
                return { success: false, error: 'No route found between ' + originPort + ' and ' + destPort };
            }

            // Check for hijacking risk in route response (try multiple field names)
            if (guards === 0 && bestRoute) {
                var routeRisk = bestRoute.hijacking_risk || bestRoute.piracy_risk || bestRoute.risk || bestRoute.pirate_risk || 0;
                if (routeRisk > 0) {
                    guards = 10;
                    _debugLog.push('Pirate risk from route API: ' + routeRisk + '% - guards set to 10');
                }
            }

            // Also check vessel routes cache as fallback
            if (guards === 0) {
                var cachedRisk = getHijackingRisk(originPort, destPort);
                if (cachedRisk > 0) {
                    guards = 10;
                    _debugLog.push('Pirate risk from fleet cache: ' + cachedRisk + '% - guards set to 10');
                }
            }

            if (guards > 0) {
                _debugLog.push('Guards: 10/10 (pirate risk detected)');
            }
            _debugLog.push('Got route_id: ' + routeId);

            // Step 2: Create user route with the route_id
            var createResp = await fetch(API_BASE + '/route/create-user-route', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    user_vessel_id: vesselId,
                    route_id: routeId
                })
            });
            if (!createResp.ok) {
                var errData = await createResp.json().catch(function() { return {}; });
                _debugLog.push('Create route failed: HTTP ' + createResp.status + ' ' + JSON.stringify(errData));
                return { success: false, error: 'Route creation failed: ' + (errData.error || 'HTTP ' + createResp.status) };
            }
            var createData = await createResp.json();
            _debugLog.push('Create route response: ' + JSON.stringify(createData).substring(0, 300));
            if (!createData.data) {
                return { success: false, error: 'Route creation failed: ' + (createData.error || JSON.stringify(createData)) };
            }

            // Step 3: Fetch auto-prices and update route with game's recommended prices
            _debugLog.push('Step 3: Fetching auto-prices');
            var autoPriceResp = await fetch(API_BASE + '/demand/auto-price', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ user_vessel_id: vesselId, route_id: routeId })
            });
            if (!autoPriceResp.ok) {
                _debugLog.push('Auto-price fetch failed: HTTP ' + autoPriceResp.status);
                return { success: false, error: 'Failed to fetch auto-prices (HTTP ' + autoPriceResp.status + ')' };
            }
            var autoPriceData = await autoPriceResp.json();
            if (!autoPriceData || !autoPriceData.data) {
                _debugLog.push('Auto-price response empty: ' + JSON.stringify(autoPriceData));
                return { success: false, error: 'Auto-price returned no data' };
            }
            var ap = autoPriceData.data;
            _debugLog.push('Auto-prices raw: ' + JSON.stringify(ap));
            // Map auto-price field names (ref, crude) to vessel price fields (refrigerated, crude_oil)
            var prices = {
                dry: ap.dry,
                refrigerated: ap.ref,
                fuel: ap.fuel,
                crude_oil: ap.crude
            };
            _debugLog.push('Mapped prices: ' + JSON.stringify(prices));
            var updateResp = await fetch(API_BASE + '/route/update-route-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    user_vessel_id: vesselId,
                    speed: speed,
                    guards: guards,
                    prices: prices
                })
            });
            if (!updateResp.ok) {
                _debugLog.push('Failed to update prices: HTTP ' + updateResp.status);
                return { success: false, error: 'Failed to set prices (HTTP ' + updateResp.status + ')' };
            }
            _debugLog.push('Route prices updated to auto-prices');

            // Step 4: Depart
            var departResp = await fetch(API_BASE + '/route/depart', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    user_vessel_id: vesselId,
                    speed: speed,
                    guards: guards,
                    history: 0
                })
            });
            if (!departResp.ok) {
                var departErrData = await departResp.json().catch(function() { return {}; });
                _debugLog.push('Depart failed: HTTP ' + departResp.status + ' ' + JSON.stringify(departErrData));
                return { success: false, error: 'Depart failed: HTTP ' + departResp.status + ' - ' + (departErrData.error || JSON.stringify(departErrData)) };
            }
            var departData = await departResp.json();
            _debugLog.push('Depart response: ' + JSON.stringify(departData).substring(0, 300));
            if (!departData.data) {
                return { success: false, error: 'Depart failed: ' + (departData.error || JSON.stringify(departData)) };
            }

            return { success: true, departInfo: departData.data.depart_info || departData.data };
        } catch (e) {
            _debugLog.push('Exception: ' + e.message);
            return { success: false, error: e.message };
        }
    }

    // ========== TIME HELPERS ==========

    function hoursUntilReset() {
        var now = new Date();
        var reset = new Date(now);
        reset.setHours(0, 1, 0, 0); // 0:01
        if (reset <= now) {
            reset.setDate(reset.getDate() + 1);
        }
        return (reset - now) / (1000 * 60 * 60);
    }

    function formatHours(h) {
        if (h < 1) return Math.round(h * 60) + 'm';
        var hrs = Math.floor(h);
        var mins = Math.round((h - hrs) * 60);
        return hrs + 'h ' + (mins < 10 ? '0' : '') + mins + 'm';
    }

    function formatMoney(n) {
        if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
        return '$' + Math.round(n);
    }

    function formatNumber(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return Math.round(n).toString();
    }

    // ========== VESSEL DATA HELPERS ==========

    function getVesselCapacity(vessel) {
        var cap = vessel.capacity_max || {};
        if (vessel.capacity_type === 'container') {
            return (cap.dry || 0) + (cap.refrigerated || 0);
        } else if (vessel.capacity_type === 'tanker') {
            return (cap.fuel || 0) + (cap.crude_oil || 0);
        }
        return 0;
    }

    // Fuel formula capacity: tankers use BBL/74 conversion to TEU-equivalent
    function getFuelCapacity(vessel) {
        var cap = vessel.capacity_max || {};
        if (vessel.capacity_type === 'tanker') {
            return ((cap.fuel || 0) + (cap.crude_oil || 0)) / 74;
        }
        return (cap.dry || 0) + (cap.refrigerated || 0);
    }

    function getIdleVessels() {
        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return [];
        return vesselStore.userVessels.filter(function(v) {
            return v.current_port_code && (
                v.status === 'moored' || v.status === 'port' ||
                v.status === 'pending' || v.status === 'anchor' ||
                v.is_parked
            );
        });
    }

    function getAllVessels() {
        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return [];
        return vesselStore.userVessels;
    }

    // ========== EN-ROUTE VESSEL TRACKING ==========

    function getEnRouteByPort() {
        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return {};
        var result = {};

        for (var i = 0; i < vesselStore.userVessels.length; i++) {
            var vessel = vesselStore.userVessels[i];
            var dest = vessel.route_destination;
            if (!dest) continue;

            if (!result[dest]) {
                result[dest] = { containerCapacity: 0, tankerCapacity: 0, containerCount: 0, tankerCount: 0 };
            }

            var cap = vessel.capacity || {};
            var capMax = vessel.capacity_max || {};
            if (vessel.capacity_type === 'container') {
                var teu = (cap.dry || capMax.dry || 0) + (cap.refrigerated || capMax.refrigerated || 0);
                result[dest].containerCapacity += teu;
                result[dest].containerCount++;
            } else if (vessel.capacity_type === 'tanker') {
                var bbl = (cap.fuel || capMax.fuel || 0) + (cap.crude_oil || capMax.crude_oil || 0);
                result[dest].tankerCapacity += bbl;
                result[dest].tankerCount++;
            }
        }
        return result;
    }

    // ========== PROFITABILITY CALCULATION ==========

    // Get average cargo prices from fleet vessels that have active routes
    function getFleetAveragePrices(capacityType) {
        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return null;
        var totals = {};
        var count = 0;
        for (var i = 0; i < vesselStore.userVessels.length; i++) {
            var v = vesselStore.userVessels[i];
            if (!v.prices || v.capacity_type !== capacityType) continue;
            var p = v.prices;
            if (capacityType === 'tanker') {
                if ((p.crude_oil || 0) === 0 && (p.fuel || 0) === 0) continue;
                totals.crude_oil = (totals.crude_oil || 0) + (p.crude_oil || 0);
                totals.fuel = (totals.fuel || 0) + (p.fuel || 0);
            } else {
                if ((p.dry || 0) === 0 && (p.refrigerated || 0) === 0) continue;
                totals.dry = (totals.dry || 0) + (p.dry || 0);
                totals.refrigerated = (totals.refrigerated || 0) + (p.refrigerated || 0);
            }
            count++;
        }
        if (count === 0) return null;
        var avg = {};
        for (var key in totals) {
            avg[key] = totals[key] / count;
        }
        return avg;
    }

    function estimateIncome(vessel) {
        if (!vessel || !vessel.capacity_max) return 0;
        var cap = vessel.capacity_max;
        // Use vessel's own prices if available, otherwise fleet average
        var prices = vessel.prices;
        if (!prices || (vessel.capacity_type === 'tanker' && !(prices.crude_oil || prices.fuel)) ||
            (vessel.capacity_type !== 'tanker' && !(prices.dry || prices.refrigerated))) {
            prices = getFleetAveragePrices(vessel.capacity_type);
        }
        if (!prices) return 0;
        if (vessel.capacity_type === 'tanker') {
            return (cap.crude_oil || 0) * (prices.crude_oil || 0) +
                   (cap.fuel || 0) * (prices.fuel || 0);
        }
        return (cap.dry || 0) * (prices.dry || 0) +
               (cap.refrigerated || 0) * (prices.refrigerated || 0);
    }

    function calculateFuelCost(vessel, distance, speed, fuelPrice) {
        var capacity = getFuelCapacity(vessel);
        if (capacity <= 0 || distance <= 0 || speed <= 0) return 0;
        var fuelFactor = vessel.fuel_factor || 1;
        var fuelKg = capacity * distance * Math.sqrt(speed) * fuelFactor / 40;
        var fuelTons = fuelKg / 1000 * 1.02;
        return fuelTons * fuelPrice;
    }

    function calculateCO2Cost(vessel, distance, co2Price) {
        var capacity = getFuelCapacity(vessel);
        if (capacity <= 0 || distance <= 0) return 0;
        var co2Factor = vessel.co2_factor || 1;
        var co2PerTeuNm = (2 - capacity / 15000) * co2Factor;
        var co2Tons = co2PerTeuNm * capacity * distance / 1000;
        return co2Tons * co2Price;
    }

    function calculateProfit(vessel, distance, speed, fuelPrice, co2Price) {
        var income = estimateIncome(vessel);
        var fuelCostPerLeg = calculateFuelCost(vessel, distance, speed, fuelPrice);
        var co2CostPerLeg = calculateCO2Cost(vessel, distance, co2Price);
        // Earn money one way, pay fuel+CO2 one way
        return income - fuelCostPerLeg - co2CostPerLeg;
    }

    // ========== DEMAND HELPERS ==========

    function getPortDemand(port, capacityType) {
        var demand = port.demand || {};
        var consumed = port.consumed || {};
        if (capacityType === 'container') {
            var cd = demand.container || {};
            var cc = consumed.container || {};
            return ((cd.dry || 0) + (cd.refrigerated || 0)) - ((cc.dry || 0) + (cc.refrigerated || 0));
        } else if (capacityType === 'tanker') {
            var td = demand.tanker || {};
            var tc = consumed.tanker || {};
            return ((td.fuel || 0) + (td.crude_oil || 0)) - ((tc.fuel || 0) + (tc.crude_oil || 0));
        }
        return 0;
    }

    function getEffectiveDemand(port, capacityType, enRouteByPort) {
        var rawDemand = getPortDemand(port, capacityType);
        var enRoute = enRouteByPort[port.code];
        if (!enRoute) return rawDemand;
        if (capacityType === 'container') {
            return rawDemand - (enRoute.containerCapacity || 0);
        } else if (capacityType === 'tanker') {
            return rawDemand - (enRoute.tankerCapacity || 0);
        }
        return rawDemand;
    }

    // ========== SCORING ==========

    function scorePort(vessel, port, originLat, originLon, speed, enRouteByPort, maxValues, apiRoutes) {
        var lat = parseFloat(port.lat);
        var lon = parseFloat(port.lon);
        if (isNaN(lat) || isNaN(lon)) return null;

        // Use API distance (canal-aware) if available, else fallback to Haversine
        var distance;
        var usesCanal = false;
        var channelFee = 0;
        if (apiRoutes && apiRoutes[port.code]) {
            distance = apiRoutes[port.code].distance;
            usesCanal = apiRoutes[port.code].usesCanal || false;
            channelFee = apiRoutes[port.code].channelFee || 0;
        } else {
            distance = haversineDistance(originLat, originLon, lat, lon);
        }
        if (distance <= 0) return null;

        // Get hijacking risk: check fleet cache first, then API-fetched route data
        var hijackingRisk = getHijackingRisk(vessel.current_port_code, port.code);
        if (!hijackingRisk && apiRoutes && apiRoutes[port.code] && apiRoutes[port.code].hijackingRisk) {
            hijackingRisk = apiRoutes[port.code].hijackingRisk;
        }

        // Travel time in real hours (game compresses time by GAME_TIME_FACTOR)
        var travelHours = distance / speed / GAME_TIME_FACTOR + PORT_OVERHEAD_HOURS;
        var roundTripHours = travelHours * 2;
        var vesselCapacity = getVesselCapacity(vessel);
        var effectiveDemand = getEffectiveDemand(port, vessel.capacity_type, enRouteByPort);

        // Sustainability — hoursUntilReset is real time, roundTripHours is also real time
        var hrsLeft = hoursUntilReset();
        // If less than one round trip remains today, use full 24h cycle
        // (demand resets and auto-depart keeps running)
        var effectiveHours = hrsLeft < roundTripHours ? 24 : hrsLeft;
        var possibleTrips = roundTripHours > 0 ? Math.floor(effectiveHours / roundTripHours) : 0;
        var sustainableTrips = vesselCapacity > 0 ? Math.floor(effectiveDemand / vesselCapacity) : 0;
        if (sustainableTrips < 0) sustainableTrips = 0;

        // Cap sustainable trips by what's physically possible
        var tripsToday = Math.min(sustainableTrips, possibleTrips);

        // Status
        var status = 'red';
        if (sustainableTrips >= possibleTrips && sustainableTrips >= 1) {
            status = 'green';
        } else if (sustainableTrips >= 1) {
            status = 'yellow';
        }

        return {
            portCode: port.code,
            lat: lat,
            lon: lon,
            distance: Math.round(distance),
            travelHours: travelHours,
            roundTripHours: roundTripHours,
            rawDemand: getPortDemand(port, vessel.capacity_type),
            effectiveDemand: effectiveDemand,
            enRouteCapacity: (function() {
                var er = enRouteByPort[port.code];
                if (!er) return 0;
                return vessel.capacity_type === 'container' ? (er.containerCapacity || 0) : (er.tankerCapacity || 0);
            })(),
            enRouteCount: (function() {
                var er = enRouteByPort[port.code];
                if (!er) return 0;
                return vessel.capacity_type === 'container' ? (er.containerCount || 0) : (er.tankerCount || 0);
            })(),
            vesselCapacity: vesselCapacity,
            sustainableTrips: sustainableTrips,
            possibleTrips: possibleTrips,
            tripsToday: tripsToday,
            usesCanal: usesCanal,
            channelFee: channelFee,
            hijackingRisk: hijackingRisk,
            status: status,
            score: 0 // calculated after normalization
        };
    }

    async function rankPorts(vessel, ports, originLat, originLon, speed, statusCallback) {
        // Try to get real distances from game API (canal-aware)
        var apiRoutes = await fetchRouteDistances(vessel.id, vessel.current_port_code, statusCallback);
        var enRouteByPort = getEnRouteByPort();
        var scored = [];

        for (var i = 0; i < ports.length; i++) {
            // Skip the origin port
            if (ports[i].code === vessel.current_port_code) continue;

            var result = scorePort(vessel, ports[i], originLat, originLon, speed, enRouteByPort, null, apiRoutes);
            if (result) scored.push(result);
        }

        if (scored.length === 0) return [];

        // Calculate composite scores
        var w = settings.weights;
        var idealHours = settings.idealTravelHours;
        var sigma = idealHours * 0.8; // Gaussian spread

        for (var k = 0; k < scored.length; k++) {
            var s = scored[k];

            // Demand sustainability score (0-1)
            var sustainScore = s.possibleTrips > 0 ? Math.min(1, s.sustainableTrips / s.possibleTrips) : 0;

            // Travel time sweet spot — Gaussian centered on ideal (e.g. 3h)
            var travelDiff = s.travelHours - idealHours;
            var travelScore = Math.exp(-(travelDiff * travelDiff) / (2 * sigma * sigma));

            // Composite score (0-100)
            s.score = Math.round(
                (sustainScore * w.demandSustainability +
                 travelScore * w.travelTime)
            );

            s._sustainScore = sustainScore;
            s._travelScore = travelScore;
        }

        // Sort by score descending
        scored.sort(function(a, b) { return b.score - a.score; });

        return scored;
    }

    // ========== FLEET MODE ==========

    function planFleet(vessels, ports, speed) {
        // Sort vessels by capacity descending (assign biggest first)
        var sorted = vessels.slice().sort(function(a, b) {
            return getVesselCapacity(b) - getVesselCapacity(a);
        });

        var demandCache = {};
        var assignments = [];
        var enRouteByPort = getEnRouteByPort();

        // Build a mutable demand map
        for (var i = 0; i < ports.length; i++) {
            var p = ports[i];
            demandCache[p.code] = {
                container: getPortDemand(p, 'container'),
                tanker: getPortDemand(p, 'tanker')
            };
            // Subtract en-route
            var er = enRouteByPort[p.code];
            if (er) {
                demandCache[p.code].container -= (er.containerCapacity || 0);
                demandCache[p.code].tanker -= (er.tankerCapacity || 0);
            }
        }

        for (var v = 0; v < sorted.length; v++) {
            var vessel = sorted[v];
            if (!vessel.current_port_code) continue;

            // Find origin coords
            var originPort = null;
            for (var pi = 0; pi < ports.length; pi++) {
                if (ports[pi].code === vessel.current_port_code) {
                    originPort = ports[pi];
                    break;
                }
            }
            if (!originPort) continue;

            var originLat = parseFloat(originPort.lat);
            var originLon = parseFloat(originPort.lon);
            if (isNaN(originLat) || isNaN(originLon)) continue;

            var vesselCap = getVesselCapacity(vessel);
            var bestPort = null;
            var bestScore = -Infinity;
            var bestResult = null;

            for (var pp = 0; pp < ports.length; pp++) {
                var port = ports[pp];
                if (port.code === vessel.current_port_code) continue;

                var pLat = parseFloat(port.lat);
                var pLon = parseFloat(port.lon);
                if (isNaN(pLat) || isNaN(pLon)) continue;

                var availDemand = demandCache[port.code] ? demandCache[port.code][vessel.capacity_type] || 0 : 0;
                if (availDemand < vesselCap) continue; // Not enough demand

                var distance = haversineDistance(originLat, originLon, pLat, pLon);
                if (distance <= 0) continue;

                var travelHours = distance / speed / GAME_TIME_FACTOR + PORT_OVERHEAD_HOURS;
                var roundTripHours = travelHours * 2;
                var hrsLeft = hoursUntilReset();
                var effectiveHours = hrsLeft < roundTripHours ? 24 : hrsLeft;
                var possibleTrips = roundTripHours > 0 ? Math.floor(effectiveHours / roundTripHours) : 0;
                var sustainableTrips = vesselCap > 0 ? Math.floor(availDemand / vesselCap) : 0;
                var tripsToday = Math.min(sustainableTrips, possibleTrips);

                // Score using same weights (demand + travel time)
                var w = settings.weights;
                var idealHours = settings.idealTravelHours;
                var sigma = idealHours * 0.8;

                var sustainScore = possibleTrips > 0 ? Math.min(1, sustainableTrips / possibleTrips) : 0;
                var travelDiff = travelHours - idealHours;
                var travelScore = Math.exp(-(travelDiff * travelDiff) / (2 * sigma * sigma));

                var score = sustainScore * w.demandSustainability +
                            travelScore * w.travelTime;

                if (score > bestScore) {
                    bestScore = score;
                    bestPort = port;
                    bestResult = {
                        portCode: port.code,
                        distance: Math.round(distance),
                        travelHours: travelHours,
                        sustainableTrips: sustainableTrips,
                        tripsToday: tripsToday,
                        effectiveDemand: availDemand,
                        score: Math.round(score)
                    };
                }
            }

            if (bestPort && bestResult) {
                assignments.push({
                    vessel: vessel,
                    vesselName: vessel.name,
                    vesselCapacity: vesselCap,
                    capacityType: vessel.capacity_type,
                    result: bestResult
                });

                // Deduct capacity from demand pool
                if (demandCache[bestPort.code]) {
                    demandCache[bestPort.code][vessel.capacity_type] -= vesselCap;
                }
            }
        }

        return assignments;
    }

    // ========== STYLES ==========

    function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;

        var css = '\
#rp-modal-wrapper { position:fixed; top:0; left:0; width:100%; height:100%; z-index:9999; display:flex; }\
#rp-modal-background { position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); }\
#rp-modal-content-wrapper { position:relative; z-index:1; width:100%; display:flex; justify-content:center; }\
#rp-modal-container { position:absolute; background:#1a2332; color:#c8d6e5; border-radius:8px; width:95%; max-width:1300px;\
  display:flex; flex-direction:column; overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,0.5); }\
#rp-modal-container .modal-header { display:flex; justify-content:space-between; align-items:center;\
  padding:12px 16px; background:#0d1520; border-bottom:1px solid #2a3a4e; }\
#rp-modal-container .header-title { font-size:16px; font-weight:700; color:#fff; }\
#rp-modal-container .header-icon { cursor:pointer; width:20px; height:20px; filter:invert(0.8); }\
#rp-modal-body { padding:16px; overflow-y:auto; flex:1; }\
.rp-controls { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px; }\
.rp-control-group { display:flex; flex-direction:column; gap:4px; }\
.rp-control-group label { font-size:11px; color:#8899aa; text-transform:uppercase; letter-spacing:0.5px; }\
.rp-control-group select, .rp-control-group input { background:#0d1520; color:#c8d6e5; border:1px solid #2a3a4e;\
  border-radius:4px; padding:6px 10px; font-size:13px; outline:none; min-width:120px; }\
.rp-control-group select:focus, .rp-control-group input:focus { border-color:#4a9eff; }\
.rp-btn { background:#1e6fbf; color:#fff; border:none; border-radius:4px; padding:8px 18px; font-size:13px;\
  font-weight:600; cursor:pointer; white-space:nowrap; }\
.rp-btn:hover { background:#2580d4; }\
.rp-btn:disabled { background:#2a3a4e; color:#667788; cursor:not-allowed; }\
.rp-btn-sm { padding:4px 10px; font-size:11px; }\
.rp-results-info { font-size:12px; color:#667788; margin-bottom:8px; }\
.rp-results-info span { color:#8899aa; }\
.rp-table-wrap { overflow-x:auto; }\
.rp-table { width:100%; border-collapse:collapse; font-size:12px; }\
.rp-table th { background:#0d1520; color:#8899aa; padding:8px 10px; text-align:left; font-weight:600;\
  text-transform:uppercase; font-size:10px; letter-spacing:0.5px; border-bottom:2px solid #2a3a4e;\
  cursor:pointer; white-space:nowrap; user-select:none; }\
.rp-table th:hover { color:#c8d6e5; }\
.rp-table th .sort-arrow { margin-left:4px; font-size:8px; }\
.rp-table td { padding:6px 10px; border-bottom:1px solid #1e2d3d; white-space:nowrap; }\
.rp-table tr:hover td { background:#1e2d3d; }\
.rp-table tr.rp-excluded td { opacity:0.4; }\
.rp-status-green { color:#2ecc71; font-weight:700; }\
.rp-status-yellow { color:#f39c12; font-weight:700; }\
.rp-status-red { color:#e74c3c; font-weight:700; }\
.rp-score-bar { display:inline-block; height:6px; border-radius:3px; min-width:4px; }\
.rp-score-bar.high { background:#2ecc71; }\
.rp-score-bar.mid { background:#f39c12; }\
.rp-score-bar.low { background:#e74c3c; }\
.rp-footer { font-size:11px; color:#556677; padding:8px 16px; border-top:1px solid #2a3a4e; display:flex;\
  justify-content:space-between; align-items:center; }\
.rp-settings-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:8px;\
  padding-top:8px; border-top:1px solid #1e2d3d; }\
.rp-settings-row label { font-size:11px; color:#667788; display:flex; align-items:center; gap:4px; }\
.rp-settings-row input[type="number"] { width:60px; background:#0d1520; color:#c8d6e5; border:1px solid #2a3a4e;\
  border-radius:3px; padding:2px 6px; font-size:11px; }\
.rp-settings-row input[type="checkbox"] { accent-color:#1e6fbf; }\
.rp-fleet-table td { vertical-align:middle; }\
.rp-warn { background:#3d2a0a; color:#f39c12; padding:10px 14px; border-radius:6px; margin-bottom:12px; font-size:13px; }\
.rp-goto-btn { background:none; border:none; cursor:pointer; font-size:13px; padding:0 3px; opacity:0.7; vertical-align:middle; }\
.rp-goto-btn:hover { opacity:1; transform:scale(1.2); }\
.rp-send-btn { background:#27ae60; color:#fff; border:none; border-radius:3px; padding:3px 10px; font-size:11px;\
  font-weight:600; cursor:pointer; white-space:nowrap; }\
.rp-send-btn:hover { background:#2ecc71; }\
.rp-send-btn:disabled { background:#2a3a4e; color:#667788; cursor:not-allowed; }\
.rp-send-btn.sending { background:#f39c12; }\
.rp-send-btn.sent { background:#2a3a4e; color:#2ecc71; }\
.rp-send-btn.failed { background:#c0392b; }\
.rp-canal-badge { display:inline-block; background:#2980b9; color:#fff; font-size:9px; padding:1px 5px;\
  border-radius:3px; margin-left:4px; font-weight:600; vertical-align:middle; }\
#rp-modal-wrapper.hide { display:none; }\
';
        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ========== MODAL ==========

    var currentSort = { col: 'score', asc: false };
    var lastResults = null;
    var lastMode = 'single';
    var lastFleetResults = null;

    function openModal() {
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) modalStore.closeAll();

        injectStyles();

        var existing = document.getElementById('rp-modal-wrapper');
        if (existing) {
            existing.classList.remove('hide');
            isModalOpen = true;
            return;
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var wrapper = document.createElement('div');
        wrapper.id = 'rp-modal-wrapper';

        var bg = document.createElement('div');
        bg.id = 'rp-modal-background';
        bg.onclick = function() { closeModal(); };

        var contentWrapper = document.createElement('div');
        contentWrapper.id = 'rp-modal-content-wrapper';

        var container = document.createElement('div');
        container.id = 'rp-modal-container';
        container.className = 'font-lato';
        container.style.top = headerHeight + 'px';
        container.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        container.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        // Header
        var header = document.createElement('div');
        header.className = 'modal-header';
        var title = document.createElement('span');
        title.className = 'header-title';
        title.textContent = 'Route Planner';
        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;color:#fff;';
            fallback.onclick = function() { closeModal(); };
            this.parentNode.appendChild(fallback);
        };
        header.appendChild(title);
        header.appendChild(closeIcon);

        // Body
        var body = document.createElement('div');
        body.id = 'rp-modal-body';

        // Debug log box (always present)
        var debugLog = document.createElement('div');
        debugLog.id = 'rp-error-log';
        debugLog.style.cssText = 'display:none;background:#1a0000;border:1px solid #c0392b;color:#e74c3c;padding:8px 12px;margin-bottom:8px;border-radius:4px;font-size:11px;font-family:monospace;max-height:150px;overflow-y:auto;white-space:pre-wrap;';
        body.appendChild(debugLog);

        // Footer
        var footer = document.createElement('div');
        footer.className = 'rp-footer';
        footer.id = 'rp-footer';

        container.appendChild(header);
        container.appendChild(body);
        container.appendChild(footer);
        contentWrapper.appendChild(container);
        wrapper.appendChild(bg);
        wrapper.appendChild(contentWrapper);
        document.body.appendChild(wrapper);

        isModalOpen = true;
        renderControls(body);

        // Start pre-fetching distances for all idle vessels in background
        prefetchAllDistances();
    }

    function closeModal() {
        var wrapper = document.getElementById('rp-modal-wrapper');
        if (wrapper) wrapper.classList.add('hide');
        isModalOpen = false;
    }

    function renderControls(body) {
        body.innerHTML = '';

        var controls = document.createElement('div');
        controls.className = 'rp-controls';

        // Vessel selector
        var vesselGroup = document.createElement('div');
        vesselGroup.className = 'rp-control-group';
        var vesselLabel = document.createElement('label');
        vesselLabel.textContent = 'Vessel';
        var vesselSelect = document.createElement('select');
        vesselSelect.id = 'rp-vessel-select';
        vesselSelect.style.minWidth = '220px';

        // Fleet mode option
        var fleetOpt = document.createElement('option');
        fleetOpt.value = '__fleet__';
        fleetOpt.textContent = '⚓ Fleet Mode (all idle vessels)';
        vesselSelect.appendChild(fleetOpt);

        // Group idle vessels by type
        var idle = getIdleVessels();
        var containers = idle.filter(function(v) { return v.capacity_type === 'container'; });
        var tankers = idle.filter(function(v) { return v.capacity_type === 'tanker'; });

        if (containers.length > 0) {
            var cGroup = document.createElement('optgroup');
            cGroup.label = 'Containers (' + containers.length + ')';
            containers.sort(function(a, b) { return getVesselCapacity(b) - getVesselCapacity(a); });
            for (var ci = 0; ci < containers.length; ci++) {
                var co = document.createElement('option');
                co.value = containers[ci].id;
                co.textContent = containers[ci].name + ' (' + formatNumber(getVesselCapacity(containers[ci])) + ' TEU @ ' + containers[ci].current_port_code + ')';
                cGroup.appendChild(co);
            }
            vesselSelect.appendChild(cGroup);
        }

        if (tankers.length > 0) {
            var tGroup = document.createElement('optgroup');
            tGroup.label = 'Tankers (' + tankers.length + ')';
            tankers.sort(function(a, b) { return getVesselCapacity(b) - getVesselCapacity(a); });
            for (var ti = 0; ti < tankers.length; ti++) {
                var to2 = document.createElement('option');
                to2.value = tankers[ti].id;
                to2.textContent = tankers[ti].name + ' (' + formatNumber(getVesselCapacity(tankers[ti])) + ' BBL @ ' + tankers[ti].current_port_code + ')';
                tGroup.appendChild(to2);
            }
            vesselSelect.appendChild(tGroup);
        }

        vesselGroup.appendChild(vesselLabel);
        vesselGroup.appendChild(vesselSelect);

        // Speed input
        var speedGroup = document.createElement('div');
        speedGroup.className = 'rp-control-group';
        var speedLabel = document.createElement('label');
        speedLabel.textContent = 'Speed (knots)';
        var speedInput = document.createElement('input');
        speedInput.type = 'number';
        speedInput.id = 'rp-speed-input';
        speedInput.min = '1';
        speedInput.max = '50';
        speedInput.value = settings.defaultSpeed || 30;
        speedInput.style.width = '80px';
        speedGroup.appendChild(speedLabel);
        speedGroup.appendChild(speedInput);

        // Update max speed when vessel changes
        vesselSelect.addEventListener('change', function() {
            if (vesselSelect.value === '__fleet__') {
                speedInput.max = '50';
            } else {
                var v = findVesselById(vesselSelect.value);
                if (v && v.max_speed) speedInput.max = v.max_speed;
            }
        });

        // Plan button
        var planBtn = document.createElement('button');
        planBtn.className = 'rp-btn';
        planBtn.textContent = 'Plan Route';
        planBtn.onclick = function() { runPlanner(body); };

        controls.appendChild(vesselGroup);
        controls.appendChild(speedGroup);
        controls.appendChild(planBtn);
        body.appendChild(controls);

        // Settings row
        var settingsRow = document.createElement('div');
        settingsRow.className = 'rp-settings-row';

        settingsRow.innerHTML = '\
<label>Fuel $/t: <input type="number" id="rp-fuel-price" value="' + settings.fuelPrice + '" min="0" step="50"></label>\
<label>CO2 $/t: <input type="number" id="rp-co2-price" value="' + settings.co2Price + '" min="0" step="1"></label>\
<label>Ideal travel: <input type="number" id="rp-ideal-hours" value="' + settings.idealTravelHours + '" min="0.5" max="24" step="0.5">h</label>\
<label><input type="checkbox" id="rp-show-excluded" ' + (settings.showExcludedPorts ? 'checked' : '') + '> Show excluded ports</label>';

        body.appendChild(settingsRow);

        // Results container
        var resultsContainer = document.createElement('div');
        resultsContainer.id = 'rp-results';
        body.appendChild(resultsContainer);
    }

    function findVesselById(id) {
        var all = getAllVessels();
        for (var i = 0; i < all.length; i++) {
            if (String(all[i].id) === String(id)) return all[i];
        }
        return null;
    }

    async function runPlanner(body) {
        // Read settings from UI
        var fuelInput = document.getElementById('rp-fuel-price');
        var co2Input = document.getElementById('rp-co2-price');
        var idealInput = document.getElementById('rp-ideal-hours');
        var excludedCheck = document.getElementById('rp-show-excluded');
        var speedInput = document.getElementById('rp-speed-input');
        var vesselSelect = document.getElementById('rp-vessel-select');

        if (fuelInput) settings.fuelPrice = parseFloat(fuelInput.value) || 500;
        if (co2Input) settings.co2Price = parseFloat(co2Input.value) || 10;
        if (idealInput) settings.idealTravelHours = parseFloat(idealInput.value) || 3;
        if (excludedCheck) settings.showExcludedPorts = excludedCheck.checked;
        if (speedInput) settings.defaultSpeed = parseFloat(speedInput.value) || 30;
        saveSettings();

        var speed = parseFloat(speedInput.value);
        if (!speed || speed <= 0) {
            showError('Please enter a valid speed.');
            return;
        }

        var resultsContainer = document.getElementById('rp-results');
        if (!resultsContainer) return;
        resultsContainer.innerHTML = '<div style="color:#8899aa;padding:20px;text-align:center;">Loading demand data...</div>';

        // Load demand cache
        var cache = await getDemandCache();
        if (!cache || !cache.ports || cache.ports.length === 0) {
            resultsContainer.innerHTML = '<div class="rp-warn">No demand data found. Please run Demand Summary first to collect port data.</div>';
            updateFooter(null);
            return;
        }

        var cacheAge = cache.timestamp ? Math.round((Date.now() - cache.timestamp) / 60000) : null;

        var isFleet = vesselSelect.value === '__fleet__';

        if (isFleet) {
            lastMode = 'fleet';
            var idleVessels = getIdleVessels();
            if (idleVessels.length === 0) {
                resultsContainer.innerHTML = '<div class="rp-warn">No idle vessels found. Vessels must be moored at a port to plan routes.</div>';
                updateFooter(cacheAge);
                return;
            }
            var assignments = planFleet(idleVessels, cache.ports, speed);
            lastFleetResults = assignments;
            renderFleetTable(resultsContainer, assignments, speed);
        } else {
            lastMode = 'single';
            var vessel = findVesselById(vesselSelect.value);
            if (!vessel) {
                resultsContainer.innerHTML = '<div class="rp-warn">Vessel not found. Please select a valid vessel.</div>';
                updateFooter(cacheAge);
                return;
            }

            // Find origin port coordinates
            var originPort = null;
            for (var i = 0; i < cache.ports.length; i++) {
                if (cache.ports[i].code === vessel.current_port_code) {
                    originPort = cache.ports[i];
                    break;
                }
            }
            if (!originPort) {
                resultsContainer.innerHTML = '<div class="rp-warn">Could not find origin port "' + vessel.current_port_code + '" in demand data.</div>';
                updateFooter(cacheAge);
                return;
            }

            var originLat = parseFloat(originPort.lat);
            var originLon = parseFloat(originPort.lon);

            resultsContainer.innerHTML = '<div id="rp-loading-status" style="color:#8899aa;padding:20px;text-align:center;">Fetching route distances...</div>';
            var ranked = await rankPorts(vessel, cache.ports, originLat, originLon, speed, function(fetched, total) {
                var el = document.getElementById('rp-loading-status');
                if (el) el.textContent = 'Fetching route distances... ' + fetched + '/' + total + ' ports';
            });
            lastResults = ranked;
            currentSort = { col: 'score', asc: false };
            renderResultsTable(resultsContainer, ranked, vessel, speed);
        }

        updateFooter(cacheAge);
    }

    function showError(msg) {
        var resultsContainer = document.getElementById('rp-results');
        if (resultsContainer) {
            resultsContainer.innerHTML = '<div class="rp-warn">' + msg + '</div>';
        }
    }

    function updateFooter(cacheAge) {
        var footer = document.getElementById('rp-footer');
        if (!footer) return;
        var hrsLeft = hoursUntilReset();
        var leftHtml = 'Demand resets in ' + formatHours(hrsLeft);
        if (cacheAge !== null) {
            leftHtml += ' | Data age: ' + cacheAge + 'min';
            if (cacheAge > 10) leftHtml += ' <span style="color:#f39c12">(stale)</span>';
        }
        footer.innerHTML = '<span>' + leftHtml + '</span><span>Fuel: $' + settings.fuelPrice + '/t | CO2: $' + settings.co2Price + '/t</span>';
    }

    // ========== RESULTS TABLE (SINGLE VESSEL) ==========

    function renderResultsTable(container, results, vessel, speed) {
        container.innerHTML = '';

        var showExcluded = settings.showExcludedPorts;
        var visible = showExcluded ? results : results.filter(function(r) { return r.status !== 'red'; });
        var excluded = results.filter(function(r) { return r.status === 'red'; }).length;

        // Info bar
        var info = document.createElement('div');
        info.className = 'rp-results-info';
        info.innerHTML = 'Showing <span>' + visible.length + '</span> ports | ' +
            '<span>' + excluded + '</span> excluded (low demand) | ' +
            'Vessel: <span>' + vessel.name + '</span> (' + formatNumber(getVesselCapacity(vessel)) +
            ' ' + (vessel.capacity_type === 'container' ? 'TEU' : 'BBL') + ')';
        container.appendChild(info);

        // Table
        var tableWrap = document.createElement('div');
        tableWrap.className = 'rp-table-wrap';

        var table = document.createElement('table');
        table.className = 'rp-table';

        var columns = [
            { key: 'portCode', label: 'Port' },
            { key: 'effectiveDemand', label: 'Eff. Demand' },
            { key: 'enRouteCapacity', label: 'En Route' },
            { key: 'distance', label: 'Distance' },
            { key: 'travelHours', label: 'Travel' },
            { key: 'tripsToday', label: 'Trips Today' },
            { key: 'hijackingRisk', label: 'Pirate Risk' },
            { key: 'score', label: 'Score' },
            { key: 'status', label: 'Status' },
            { key: '_action', label: '' }
        ];

        // Header
        var thead = document.createElement('thead');
        var headRow = document.createElement('tr');
        for (var c = 0; c < columns.length; c++) {
            var th = document.createElement('th');
            th.textContent = columns[c].label;
            th.dataset.col = columns[c].key;
            if (currentSort.col === columns[c].key) {
                th.innerHTML += ' <span class="sort-arrow">' + (currentSort.asc ? '▲' : '▼') + '</span>';
            }
            th.onclick = (function(col) {
                return function() {
                    if (currentSort.col === col) {
                        currentSort.asc = !currentSort.asc;
                    } else {
                        currentSort.col = col;
                        currentSort.asc = col === 'portCode'; // alpha asc by default, everything else desc
                    }
                    sortResults(visible, currentSort.col, currentSort.asc);
                    renderResultsTable(container, results, vessel, speed);
                };
            })(columns[c].key);
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        // Body
        var tbody = document.createElement('tbody');
        // Sort visible
        sortResults(visible, currentSort.col, currentSort.asc);

        for (var r = 0; r < visible.length; r++) {
            var row = visible[r];
            var tr = document.createElement('tr');
            if (row.status === 'red') tr.className = 'rp-excluded';

            var unit = vessel.capacity_type === 'container' ? ' TEU' : ' BBL';

            var canalBadge = row.usesCanal ? '<span class="rp-canal-badge">CANAL</span>' : '';

            var pirateBadge = row.hijackingRisk > 0 ? '<span style="color:#e74c3c;font-weight:bold">' + row.hijackingRisk + '%</span>' : '<span style="color:#2ecc71">Safe</span>';

            tr.innerHTML = '\
<td>' + row.portCode + ' <button class="rp-goto-btn" data-lat="' + row.lat + '" data-lon="' + row.lon + '" title="Show on map">&#x1f4cd;</button></td>\
<td>' + formatNumber(row.effectiveDemand) + unit + '</td>\
<td>' + (row.enRouteCount > 0 ? row.enRouteCount + ' ships (' + formatNumber(row.enRouteCapacity) + ')' : '-') + '</td>\
<td>' + formatNumber(row.distance) + ' nm' + canalBadge + '</td>\
<td>' + formatHours(row.travelHours) + '</td>\
<td>' + row.tripsToday + '/' + row.possibleTrips + '</td>\
<td>' + pirateBadge + '</td>\
<td>' + renderScoreBar(row.score) + '</td>\
<td class="rp-status-' + row.status + '">' + row.status.toUpperCase() + '</td>\
<td></td>';

            // Add Send button to last cell
            var sendCell = tr.lastElementChild;
            if (row.status !== 'red') {
                var sendBtn = document.createElement('button');
                sendBtn.className = 'rp-send-btn';
                sendBtn.textContent = 'Send';
                sendBtn.dataset.port = row.portCode;
                sendBtn.onclick = (function(portCode, btn, vesselObj, risk) {
                    return function() { handleSendShip(vesselObj, portCode, speed, btn, risk); };
                })(row.portCode, sendBtn, vessel, row.hijackingRisk);
                sendCell.appendChild(sendBtn);
            }

            // Wire up "Go to" button
            var gotoBtn = tr.querySelector('.rp-goto-btn');
            if (gotoBtn) {
                gotoBtn.onclick = (function(lat, lon, portCode) {
                    return function(e) {
                        e.stopPropagation();
                        goToPortOnMap(parseFloat(lat), parseFloat(lon), portCode);
                    };
                })(gotoBtn.dataset.lat, gotoBtn.dataset.lon, row.portCode);
            }

            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);

        // Debug button to view API response
        if (window._rpRouteDebug) {
            var debugBtn = document.createElement('button');
            debugBtn.textContent = 'Show API Debug';
            debugBtn.style.cssText = 'margin:8px;padding:4px 10px;font-size:11px;background:#333;color:#aaa;border:1px solid #555;border-radius:3px;cursor:pointer;';
            debugBtn.onclick = function() { prompt('Route API response (Ctrl+A):', window._rpRouteDebug); };
            container.appendChild(debugBtn);
        }
    }

    function sortResults(arr, col, asc) {
        arr.sort(function(a, b) {
            var va = a[col];
            var vb = b[col];
            if (typeof va === 'string') {
                return asc ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            return asc ? va - vb : vb - va;
        });
    }

    function renderScoreBar(score) {
        var cls = score >= 60 ? 'high' : score >= 30 ? 'mid' : 'low';
        return '<span class="rp-score-bar ' + cls + '" style="width:' + Math.max(4, score) + 'px"></span> ' + score;
    }

    // ========== SEND SHIP ==========

    var _debugLog = [];

    // showErrorLog removed — using _debugLog.push + alert instead

    async function handleSendShip(vessel, destPortCode, speed, btn, hijackingRisk) {
        try {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.className = 'rp-send-btn sending';
        btn.textContent = 'Sending...';

        _debugLog = [];
        _debugLog.push('Sending ' + vessel.name + ' id:' + vessel.id + ' parked:' + vessel.is_parked + ' status:' + vessel.status + ' from ' + vessel.current_port_code + ' to ' + destPortCode + ' at ' + speed + 'kn' + (hijackingRisk ? ' pirate_risk:' + hijackingRisk + '%' : ''));

        var result = await createRouteAndDepart(vessel.id, vessel.current_port_code, destPortCode, speed, hijackingRisk);

        if (result.success) {
            btn.className = 'rp-send-btn sent';
            btn.textContent = 'Sent!';
            _debugLog.push('SUCCESS: ' + vessel.name + ' departed to ' + destPortCode);
        } else {
            btn.className = 'rp-send-btn failed';
            btn.textContent = 'Failed';
            _debugLog.push('FAILED: ' + vessel.name + ' → ' + destPortCode + ': ' + (result.error || 'Unknown error'));
            prompt('Debug log (Ctrl+A to select all):', _debugLog.join(' | '));
            // Re-enable after 3s so user can retry
            setTimeout(function() {
                btn.disabled = false;
                btn.className = 'rp-send-btn';
                btn.textContent = 'Send';
            }, 3000);
        }
        } catch(e) {
            alert('Send error: ' + e.message);
            btn.disabled = false;
            btn.className = 'rp-send-btn';
            btn.textContent = 'Send';
        }
    }

    // ========== FLEET TABLE ==========

    function renderFleetTable(container, assignments, speed) {
        container.innerHTML = '';

        if (assignments.length === 0) {
            container.innerHTML = '<div class="rp-warn">No viable routes found for idle vessels. Check demand data freshness.</div>';
            return;
        }

        var info = document.createElement('div');
        info.className = 'rp-results-info';
        info.style.display = 'flex';
        info.style.justifyContent = 'space-between';
        info.style.alignItems = 'center';

        var infoText = document.createElement('span');
        infoText.innerHTML = 'Fleet assignments: <span>' + assignments.length + '</span> vessels';
        info.appendChild(infoText);

        var sendAllBtn = document.createElement('button');
        sendAllBtn.className = 'rp-btn rp-btn-sm';
        sendAllBtn.textContent = 'Send All';
        sendAllBtn.style.background = '#27ae60';
        sendAllBtn.onclick = function() {
            sendAllBtn.disabled = true;
            sendAllBtn.textContent = 'Sending...';
            // Click all individual Send buttons
            var btns = container.querySelectorAll('.rp-send-btn:not(:disabled)');
            btns.forEach(function(b) { b.click(); });
            setTimeout(function() { sendAllBtn.textContent = 'Done'; }, 2000);
        };
        info.appendChild(sendAllBtn);

        container.appendChild(info);

        var tableWrap = document.createElement('div');
        tableWrap.className = 'rp-table-wrap';

        var table = document.createElement('table');
        table.className = 'rp-table rp-fleet-table';

        table.innerHTML = '\
<thead><tr>\
<th>Vessel</th><th>Type</th><th>Capacity</th><th>From</th><th>To</th>\
<th>Distance</th><th>Travel</th><th>Trips</th><th>Score</th><th></th>\
</tr></thead>';

        var tbody = document.createElement('tbody');
        for (var i = 0; i < assignments.length; i++) {
            var a = assignments[i];
            var unit = a.capacityType === 'container' ? ' TEU' : ' BBL';
            var tr = document.createElement('tr');
            tr.innerHTML = '\
<td>' + a.vesselName + '</td>\
<td>' + a.capacityType + '</td>\
<td>' + formatNumber(a.vesselCapacity) + unit + '</td>\
<td>' + a.vessel.current_port_code + '</td>\
<td>' + a.result.portCode + '</td>\
<td>' + formatNumber(a.result.distance) + ' nm</td>\
<td>' + formatHours(a.result.travelHours) + '</td>\
<td>' + a.result.tripsToday + '</td>\
<td>' + renderScoreBar(a.result.score) + '</td>\
<td></td>';

            // Add Send button
            var fleetSendCell = tr.lastElementChild;
            var fleetSendBtn = document.createElement('button');
            fleetSendBtn.className = 'rp-send-btn';
            fleetSendBtn.textContent = 'Send';
            fleetSendBtn.onclick = (function(vesselObj, portCode, btn) {
                return function() { handleSendShip(vesselObj, portCode, speed, btn, 0); };
            })(a.vessel, a.result.portCode, fleetSendBtn);
            fleetSendCell.appendChild(fleetSendBtn);

            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);
    }

    // ========== INITIALIZATION ==========

    function waitForBridge(callback) {
        if (window.PiratesTreasureBridge && typeof addMenuItem === 'function') {
            callback();
            return;
        }
        var attempts = 0;
        var interval = setInterval(function() {
            attempts++;
            if (window.PiratesTreasureBridge && typeof addMenuItem === 'function') {
                clearInterval(interval);
                callback();
            } else if (attempts > 100) {
                clearInterval(interval);
                console.error('[RoutePlanner] PiratesTreasureBridge not found after timeout');
            }
        }, 200);
    }

    waitForBridge(async function() {
        await loadSettings();
        addMenuItem('Route Planner', openModal, 15);
        log('Route Planner initialized');
        // Cache toggleable channel IDs for route API calls (enables shortest-route selection)
        var routeStore = getStore('route');
        if (routeStore && routeStore.channels) {
            _toggleableChannelIds = routeStore.channels.filter(function(c) { return c.toggleable === 1; }).map(function(c) { return c.id; });
            log('Loaded ' + _toggleableChannelIds.length + ' toggleable channels for route optimization');
        }
    });
})();
