// ==UserScript==
// @name         ShippingManager - Vessel Details Fix
// @namespace    http://tampermonkey.net/
// @description  Fix missing vessel details (Engine, Port, Fuel Factor)
// @version      2.15
// @order        26
// @author       RebelShip
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @RequireRebelShipMenu false
// @enabled      false
// ==/UserScript==

(function() {
    'use strict';

    var DEBOUNCE_MS = 200;
    var cachedPinia = null;
    var observer = null;
    var debounceTimer = null;

    // Vessel data captured from API responses (most reliable source)
    var apiCache = {};

    function log(msg) {
        console.log('[VesselDetailsFix] ' + msg);
    }

    function formatPortName(code) {
        if (!code) return null;
        return code.split('_').map(function(part) {
            return part.charAt(0).toUpperCase() + part.slice(1);
        }).join(' ');
    }

    // ============================================
    // FETCH INTERCEPTOR — capture vessel data from API
    // ============================================
    var origFetch = window.fetch;
    window.fetch = function() {
        var args = arguments;
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        var result = origFetch.apply(this, args);

        if (url.indexOf('/vessel/') !== -1 || url.indexOf('/shop/') !== -1) {
            result.then(function(response) {
                try {
                    var clone = response.clone();
                    clone.json().then(function(json) {
                        cacheFromApi(json);
                    }).catch(function() {});
                } catch {}
                return response;
            }).catch(function() {});
        }

        return result;
    };

    function cacheFromApi(json) {
        if (!json || !json.data) return;
        var data = json.data;
        var vessels = [];

        // get-all-user-vessels: { vessels: [...] }
        if (Array.isArray(data.vessels)) vessels = data.vessels;
        // show-acquirable-vessel: { vessels_for_sale: {...} or [...] }
        else if (data.vessels_for_sale) {
            vessels = Array.isArray(data.vessels_for_sale) ? data.vessels_for_sale : [data.vessels_for_sale];
        }
        // get-vessels-for-sale or similar: data is array
        else if (Array.isArray(data)) vessels = data;
        // Single vessel object with name
        else if (data.name && typeof data.name === 'string') vessels = [data];

        var count = 0;
        for (var i = 0; i < vessels.length; i++) {
            var v = vessels[i];
            if (v && v.name && typeof v.name === 'string') {
                apiCache[v.name] = v;
                count++;
            }
        }
        if (count > 0) {
            log('Cached ' + count + ' vessels from API');
            debouncedFix(); // Trigger fix now that we have data
        }
    }

    // ============================================
    // PINIA STORE ACCESS
    // ============================================
    function getPinia() {
        if (cachedPinia) return cachedPinia;
        try {
            var appEl = document.getElementById('app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            cachedPinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            return cachedPinia;
        } catch {
            return null;
        }
    }

    function getStore(name) {
        var pinia = getPinia();
        return pinia && pinia._s ? pinia._s.get(name) : null;
    }

    // ============================================
    // PROPERTY ACCESS (snake_case + camelCase)
    // ============================================
    function getEngineType(v) { return v.engine_type || v.engineType || v.engine || null; }
    function getFuelFactor(v) {
        if (v.fuel_factor !== undefined) return v.fuel_factor;
        if (v.fuelFactor !== undefined) return v.fuelFactor;
        return undefined;
    }
    function getPortCode(v) { return v.current_port_code || v.currentPortCode || v.port_code || v.portCode || null; }

    // ============================================
    // VESSEL DATA LOOKUP
    // ============================================
    function findVesselByName(name) {
        if (!name) return null;

        // API response cache (most reliable)
        if (apiCache[name]) return apiCache[name];

        // Acquirable vessels (shop - set by RebelShip browser)
        var allVessels = window._rebelshipAllVessels;
        if (Array.isArray(allVessels)) {
            for (var i = 0; i < allVessels.length; i++) {
                if (allVessels[i].name === name) return allVessels[i];
            }
        }

        // Stores: vessel, shop, route
        var vesselStore = getStore('vessel');
        if (vesselStore) {
            if (vesselStore.acquiringVessel && vesselStore.acquiringVessel.name === name) return vesselStore.acquiringVessel;
            if (vesselStore.selectedVessel && vesselStore.selectedVessel.name === name) return vesselStore.selectedVessel;
            // Own vessels
            if (vesselStore.userVessels) {
                for (var j = 0; j < vesselStore.userVessels.length; j++) {
                    if (vesselStore.userVessels[j].name === name) return vesselStore.userVessels[j];
                }
            }
        }

        var shopStore = getStore('shop');
        if (shopStore) {
            if (shopStore.selectedVessel && shopStore.selectedVessel.name === name) return shopStore.selectedVessel;
            if (shopStore.vip_vessel && shopStore.vip_vessel.name === name) return shopStore.vip_vessel;
        }

        return null;
    }

    // Fallback: get currently selected vessel from stores (no name needed)
    function getSelectedVessel() {
        var vesselStore = getStore('vessel');
        if (vesselStore && vesselStore.selectedVessel) return vesselStore.selectedVessel;
        if (vesselStore && vesselStore.acquiringVessel) return vesselStore.acquiringVessel;
        var routeStore = getStore('route');
        if (routeStore && routeStore.selectedVessel) return routeStore.selectedVessel;
        return null;
    }

    // ============================================
    // FIX SHOP/VIP VESSELS (.vessel containers)
    // ============================================
    function fixShopVipVessels() {
        var containers = document.querySelectorAll('.vessel');
        if (containers.length === 0) return;

        for (var c = 0; c < containers.length; c++) {
            var container = containers[c];
            var nameEl = container.querySelector('.name p');
            if (!nameEl) continue;

            var vesselName = nameEl.textContent.trim();
            if (!vesselName) continue;

            // Skip if already processed for this exact vessel
            if (container.getAttribute('data-vdf') === vesselName) continue;

            // Vessel changed or new — remove old injected row
            var oldFF = container.querySelector('[data-vdf-ff]');
            if (oldFF) oldFF.remove();

            var vessel = findVesselByName(vesselName);
            if (!vessel) continue;

            var engineType = getEngineType(vessel);
            var portCode = getPortCode(vessel);
            var fuelFactor = getFuelFactor(vessel);

            var rows = container.querySelectorAll('.vesselDetailRow');
            for (var i = 0; i < rows.length; i++) {
                var labelEl = rows[i].querySelector('p');
                if (!labelEl) continue;
                var label = labelEl.textContent.trim();

                // Fix empty Engine
                if (label === 'Engine' || label === 'Motor') {
                    var engineEl = rows[i].querySelector('.rowContent p') || rows[i].querySelectorAll('p')[1];
                    if (engineEl && !engineEl.textContent.trim() && engineType) {
                        engineEl.textContent = engineType;
                        log('Fixed Engine: ' + engineType);
                    }
                }

                // Fix abbreviated Port
                if (label === 'Port' || label === 'Hafen') {
                    var portEl = rows[i].querySelector('.rowContent p') || rows[i].querySelectorAll('p')[1];
                    if (portEl) {
                        var abbrev = portEl.textContent.trim();
                        if (abbrev.length <= 5 && portCode) {
                            var fullName = formatPortName(portCode);
                            if (fullName) {
                                portEl.textContent = fullName + ' (' + abbrev + ')';
                                log('Fixed Port: ' + fullName);
                            }
                        }
                    }
                }

                // Add Fuel Factor before Year of construction
                if ((label === 'Year of construction' || label === 'Baujahr') && fuelFactor !== undefined) {
                    if (!container.querySelector('[data-vdf-ff]')) {
                        var ffRow = rows[i].cloneNode(true);
                        ffRow.setAttribute('data-vdf-ff', 'true');
                        var ffPs = ffRow.querySelectorAll('p');
                        if (ffPs.length >= 2) {
                            ffPs[0].textContent = 'Fuel Factor';
                            ffPs[1].textContent = Number(fuelFactor).toFixed(2);
                        }
                        rows[i].parentElement.insertBefore(ffRow, rows[i]);
                        log('Added Fuel Factor: ' + Number(fuelFactor).toFixed(2));
                    }
                }
            }

            container.setAttribute('data-vdf', vesselName);
        }
    }

    // ============================================
    // FIX OWNED VESSEL DETAILS (.gradientTable)
    // ============================================
    function fixOwnedVesselDetails() {
        var tables = document.querySelectorAll('.gradientTable');
        if (tables.length === 0) return;

        for (var t = 0; t < tables.length; t++) {
            var table = tables[t];
            var entries = table.querySelectorAll('.dataEntry');

            // Verify this is a vessel detail table (has Engine or Year of construction)
            var isVesselTable = false;
            for (var check = 0; check < entries.length; check++) {
                var checkLabel = entries[check].querySelector('p');
                if (checkLabel) {
                    var checkText = checkLabel.textContent.trim();
                    if (checkText.indexOf('Engine') !== -1 || checkText.indexOf('Motor') !== -1 ||
                        checkText.indexOf('Year') !== -1 || checkText.indexOf('Baujahr') !== -1) {
                        isVesselTable = true;
                        break;
                    }
                }
            }
            if (!isVesselTable) {
                table.setAttribute('data-vdf', 'skip');
                continue;
            }

            // Find vessel data: walk up DOM for name, then fall back to store
            var vessel = null;
            var vesselIdent = '';
            var parent = table.parentElement;
            while (parent && parent !== document.body && !vessel) {
                var nameEl = parent.querySelector('.name p, .vesselName, [class*="vessel-name"], [class*="vesselName"]');
                if (nameEl) {
                    vesselIdent = nameEl.textContent.trim();
                    vessel = findVesselByName(vesselIdent);
                }
                if (!vessel) parent = parent.parentElement;
            }
            if (!vessel) vessel = getSelectedVessel();
            if (!vessel) continue;

            vesselIdent = vesselIdent || vessel.name || '';

            // Skip if already processed for this exact vessel
            if (table.getAttribute('data-vdf') === vesselIdent) continue;

            // Vessel changed — remove old injected row
            var oldFF = table.querySelector('[data-vdf-ff]');
            if (oldFF) oldFF.remove();

            var engineType = getEngineType(vessel);
            var fuelFactor = getFuelFactor(vessel);
            var yearEntry = null;

            for (var i = 0; i < entries.length; i++) {
                var labelEl = entries[i].querySelector('p');
                if (!labelEl) continue;
                var label = labelEl.textContent.trim();

                // Fix empty Engine
                if (label.indexOf('Engine') !== -1 || label.indexOf('Motor') !== -1) {
                    var contentEl = entries[i].querySelector('.content');
                    if (contentEl && !contentEl.textContent.trim() && engineType) {
                        contentEl.innerHTML = '';
                        var span = document.createElement('span');
                        span.className = 'uppercase';
                        span.textContent = engineType;
                        contentEl.appendChild(span);
                        log('Fixed Engine (owned): ' + engineType);
                    }
                }

                // Track Year of construction row for Fuel Factor insertion
                if (label.indexOf('Year') !== -1 || label.indexOf('Baujahr') !== -1) {
                    yearEntry = entries[i];
                }
            }

            // Add Fuel Factor before Year of construction
            if (yearEntry && fuelFactor !== undefined && !table.querySelector('[data-vdf-ff]')) {
                var ffEntry = yearEntry.cloneNode(true);
                ffEntry.setAttribute('data-vdf-ff', 'true');

                var ffLabelEl = ffEntry.querySelector('p');
                var ffContentEl = ffEntry.querySelector('.content');
                if (ffLabelEl && ffContentEl) {
                    // Preserve SVG icon, replace text nodes
                    var textNodes = [];
                    for (var n = 0; n < ffLabelEl.childNodes.length; n++) {
                        if (ffLabelEl.childNodes[n].nodeType === 3) textNodes.push(ffLabelEl.childNodes[n]);
                    }
                    for (var r = 0; r < textNodes.length; r++) {
                        ffLabelEl.removeChild(textNodes[r]);
                    }
                    ffLabelEl.appendChild(document.createTextNode(' Fuel Factor'));
                    ffContentEl.textContent = Number(fuelFactor).toFixed(2);
                }

                yearEntry.parentElement.insertBefore(ffEntry, yearEntry);
                log('Added Fuel Factor (owned): ' + Number(fuelFactor).toFixed(2));
            }

            table.setAttribute('data-vdf', vesselIdent);
        }
    }

    // ============================================
    // MAIN + OBSERVER
    // ============================================
    function fixAll() {
        fixShopVipVessels();
        fixOwnedVesselDetails();
    }

    function debouncedFix() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fixAll, DEBOUNCE_MS);
    }

    function watchPopover() {
        var popover = document.getElementById('popover');
        if (!popover) {
            setTimeout(watchPopover, 1000);
            return;
        }
        var popoverObserver = new MutationObserver(debouncedFix);
        popoverObserver.observe(popover, { childList: true });
        log('Watching #popover for vessel selection');
    }

    var lastModalContainer = null;

    function attachModalObserver() {
        var mc = document.getElementById('modal-container');
        if (mc && mc !== lastModalContainer) {
            lastModalContainer = mc;
            observer = new MutationObserver(debouncedFix);
            observer.observe(mc, { childList: true, subtree: true });
        }
    }

    function init() {
        attachModalObserver();
        if (!lastModalContainer) {
            setTimeout(init, 500);
            return;
        }

        // Re-attach modal observer when modal reopens (v-if destroys #modal-container)
        var modalStore = getStore('modal');
        if (modalStore && modalStore.$subscribe) {
            modalStore.$subscribe(function() {
                setTimeout(attachModalObserver, 100);
            });
        }

        // Watch #popover for vessel selection (vessel details render there)
        watchPopover();

        // Also catch SPA navigation via history API
        var origPush = history.pushState;
        var origReplace = history.replaceState;
        history.pushState = function() { origPush.apply(history, arguments); debouncedFix(); };
        history.replaceState = function() { origReplace.apply(history, arguments); debouncedFix(); };
        window.addEventListener('popstate', debouncedFix);

        log('Initialized');
    }

    window.addEventListener('beforeunload', function() {
        if (observer) observer.disconnect();
        if (debounceTimer) clearTimeout(debounceTimer);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
