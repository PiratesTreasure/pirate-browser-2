// ==UserScript==
// @name         ShippingManager - Distance Filter for Route Planner
// @namespace    http://tampermonkey.net/
// @description  Filter ports by distance when creating new routes!
// @version      9.34
// @order        20
// @author       RebelShip
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// ==/UserScript==
/* globals MutationObserver */

(function() {
    var API_BASE = 'https://shippingmanager.cc/api';
    var injected = false;
    var dropdownOpen = false;
    var coordsCache = {};
    var vesselPortsCache = {};
    var COORDS_CACHE_TTL = 5 * 60 * 1000;
    var VESSEL_PORTS_CACHE_TTL = 2 * 60 * 1000;

    var RANGES = [
        { label: "All", min: 0, max: 999999 },
        { label: "< 1000 nm", min: 0, max: 1000 },
        { label: "1k-3k nm", min: 1000, max: 3000 },
        { label: "3k-6k nm", min: 3000, max: 6000 },
        { label: "6k-10k nm", min: 6000, max: 10000 },
        { label: "> 10k nm", min: 10000, max: 999999 }
    ];


    function getPinia() {
        var appEl = document.querySelector("#app");
        if (!appEl || !appEl.__vue_app__) return null;
        var app = appEl.__vue_app__;
        return app._context.provides.pinia || app.config.globalProperties.$pinia;
    }

    function getStore(name) {
        var pinia = getPinia();
        if (!pinia || !pinia._s) return null;
        return pinia._s.get(name);
    }

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
            console.log("[DistFilter] fetchVesselPorts error:", err);
        }
        return null;
    }

    async function fetchPortCoords(portCode) {
        var cached = coordsCache[portCode];
        if (cached && Date.now() - cached.timestamp < COORDS_CACHE_TTL) {
            return { lat: cached.lat, lon: cached.lon };
        }
        try {
            var response = await fetch(API_BASE + '/port/get-ports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ port_code: [portCode] })
            });
            if (!response.ok) return null;
            var data = await response.json();
            if (data && data.data && data.data.port && data.data.port.length > 0) {
                var port = data.data.port[0];
                var lat = parseFloat(port.lat);
                var lon = parseFloat(port.lon);
                if (isNaN(lat) || isNaN(lon)) {
                    console.warn("[DistFilter] Invalid coordinates for port:", portCode);
                    return null;
                }
                coordsCache[portCode] = { lat: lat, lon: lon, timestamp: Date.now() };
                return { lat: lat, lon: lon };
            }
        } catch (err) {
            console.log("[DistFilter] fetchPortCoords error:", err);
        }
        return null;
    }

    function filterPortsByDistance(ports, range, vesselCoords) {
        if (!ports || !range || range.label === "All" || !vesselCoords) {
            return ports;
        }
        var R = 3440.065;
        var vLat = vesselCoords.lat * Math.PI / 180;
        var cosVLat = Math.cos(vLat);
        var vLon = vesselCoords.lon * Math.PI / 180;
        return ports.filter(function(port) {
            var pLat = parseFloat(port.lat);
            var pLon = parseFloat(port.lon);
            if (isNaN(pLat) || isNaN(pLon)) return false;
            var pLatR = pLat * Math.PI / 180;
            var dLat = pLatR - vLat;
            var dLon = pLon * Math.PI / 180 - vLon;
            var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                    cosVLat * Math.cos(pLatR) * Math.sin(dLon/2) * Math.sin(dLon/2);
            var gcDist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            var dist = gcDist * 1.3;
            return dist >= range.min && dist < range.max;
        });
    }

    async function applyDistanceFilter(range, btn) {
        var rs = getStore("route");
        if (!rs) {
            console.log("[DistFilter] No route store");
            return;
        }

        var selectedVessel = rs.selectedVessel;
        if (!selectedVessel) {
            console.log("[DistFilter] No vessel selected");
            return;
        }

        var btnInner = btn ? btn.querySelector(".btn-content-wrapper") : null;
        if (btnInner) btnInner.textContent = "Loading...";

        console.log("[DistFilter] Fetching vessel port coords for:", selectedVessel.current_port_code);
        var vesselCoords = await fetchPortCoords(selectedVessel.current_port_code);
        if (!vesselCoords) {
            console.log("[DistFilter] Could not get vessel coordinates");
            if (btnInner) btnInner.textContent = "ERROR";
            return;
        }
        console.log("[DistFilter] Vessel coords:", vesselCoords);

        console.log("[DistFilter] Fetching all reachable ports...");
        var allPorts = await fetchVesselPorts(selectedVessel.id);
        if (!allPorts || allPorts.length === 0) {
            console.log("[DistFilter] No ports returned from API");
            if (btnInner) btnInner.textContent = "ERROR";
            return;
        }
        console.log("[DistFilter] Total ports from API:", allPorts.length);

        var filteredPorts = filterPortsByDistance(allPorts, range, vesselCoords);
        console.log("[DistFilter] Filtered to", filteredPorts.length, "ports for range:", range.label);

        if (filteredPorts.length === 0) {
            console.log("[DistFilter] No ports in this distance range!");
            if (btnInner) btnInner.textContent = "0 PORTS";
            return;
        }

        rs.$patch(function(state) {
            state.routeSelection.activePorts = filteredPorts;
            state.routeSelection.isMinified = true;
            state.routeSelection.doingDryOps = false;
            state.routeSelection.metropolroute = false;
            state.routeSelection.routeWasSuggested = false;
            state.routeSelection.routeCreationStep = 2;
        });

        console.log("[DistFilter] Applied! routeCreationStep=2, activePorts count:", filteredPorts.length);

        if (btnInner) btnInner.textContent = range.label === "All" ? "DISTANCE" : range.label;

        var mapStore = getStore("mapStore");
        if (mapStore && mapStore.map) {
            var bounds = filteredPorts.map(function(p) {
                return [parseFloat(p.lat), parseFloat(p.lon)];
            });
            if (bounds.length > 0) {
                try {
                    mapStore.map.fitBounds(bounds, { padding: [50, 50] });
                } catch (e) {
                    console.log("[DistFilter] fitBounds error:", e);
                }
            }
        }
    }

    var cachedDropdown = null;

    function createDropdown(btn) {
        if (cachedDropdown) {
            cachedDropdown.style.display = 'block';
            btn.style.position = 'relative';
            btn.appendChild(cachedDropdown);
            dropdownOpen = true;
            return;
        }

        var dropdown = document.createElement("div");
        dropdown.id = "rebel-dist-dropdown";
        dropdown.style.cssText = "position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#1a1a2e;border:1px solid #3a3a5e;border-radius:4px;min-width:90px;max-width:110px;z-index:9999;margin-bottom:4px;";

        RANGES.forEach(function(range) {
            var item = document.createElement("div");
            item.style.cssText = "padding:6px 10px;cursor:pointer;color:#fff;font-size:12px;text-align:center;white-space:nowrap;";
            item.textContent = range.label;
            item.onmouseenter = function() { item.style.background = "#2a2a4e"; };
            item.onmouseleave = function() { item.style.background = "transparent"; };
            item.onclick = function(e) {
                e.stopPropagation();
                dropdown.style.display = 'none';
                dropdownOpen = false;
                applyDistanceFilter(range, btn);
            };
            dropdown.appendChild(item);
        });

        cachedDropdown = dropdown;
        btn.style.position = "relative";
        btn.appendChild(dropdown);
        dropdownOpen = true;
    }

    function isShowAllPortsStep() {
        var popup = document.getElementById('createRoutePopup');
        if (!popup) return false;
        // #suggest-route-btn only exists in step 1 (button selection step)
        return !!popup.querySelector('#suggest-route-btn');
    }

    function inject() {
        if (injected) return;
        var container = document.querySelector("#createRoutePopup .buttonContainer");
        if (!container || document.getElementById("rebel-dist-btn")) return;
        if (!isShowAllPortsStep()) return;

        var btn = document.createElement("button");
        btn.id = "rebel-dist-btn";
        btn.type = "button";
        btn.className = "default light-blue";
        btn.setAttribute("data-v-67942aae", "");

        var inner = document.createElement("div");
        inner.className = "btn-content-wrapper fit-btn-text";
        inner.textContent = "DISTANCE";
        btn.appendChild(inner);

        btn.onclick = function(e) {
            e.stopPropagation();
            e.preventDefault();
            if (dropdownOpen) {
                var dd = document.getElementById("rebel-dist-dropdown");
                if (dd) dd.remove();
                dropdownOpen = false;
            } else {
                createDropdown(btn);
            }
        };

        container.appendChild(btn);
        injected = true;
        console.log("[DistFilter] Button injected");
    }

    function reset() {
        injected = false;
        dropdownOpen = false;
        cachedDropdown = null;
    }

    var obsTimer = null;
    var obs = new MutationObserver(function() {
        if (obsTimer) return;
        obsTimer = setTimeout(function() {
            obsTimer = null;
            var popup = document.querySelector("#createRoutePopup");
            if (!popup) {
                if (injected) reset();
                return;
            }
            var container = popup.querySelector('.buttonContainer');
            if (!container) return;
            if (!isShowAllPortsStep()) return;
            if (!container.querySelector('#rebel-dist-btn')) {
                injected = false;
                dropdownOpen = false;
                inject();
            }
        }, 200);
    });
    var observeRoot = document.getElementById('modal-container') || document.getElementById('app') || document.body;
    obs.observe(observeRoot, { childList: true, subtree: true });

    window.addEventListener('beforeunload', function() {
        obs.disconnect();
    });

    document.addEventListener("click", function(e) {
        if (dropdownOpen && !e.target.closest("#rebel-dist-btn")) {
            if (cachedDropdown) cachedDropdown.style.display = 'none';
            dropdownOpen = false;
        }
    });
})();
