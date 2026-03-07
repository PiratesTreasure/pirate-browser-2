// ==UserScript==
// @name         ShippingManager - Departure Log Viewer
// @namespace    https://rebelship.org/
// @description  View departure tracking logs from Depart Manager
// @version      1.27
// @author       https://github.com/justonlyforyou/
// @order        15
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'Departure Log Viewer';
    var SCRIPT_NAME_BRIDGE = 'DepartManager';
    var STORE_NAME = 'data';
    var ITEMS_PER_PAGE = 50;

    var allLogs = [];
    var filteredLogs = [];
    var currentPage = 0;
    var modalElement = null;
    var searchTimeout = null;

    // Cached references (set at modal open, cleared at modal close)
    var filterRefs = { search: null, util: null, contrib: null };
    var cachedGameStore = null;
    var portsByCode = null;

    // ============================================
    // ESCAPING
    // ============================================
    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============================================
    // REBELSHIPBRIDGE STORAGE
    // ============================================
    async function dbGet(key) {
        var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME_BRIDGE, STORE_NAME, key);
        if (result) {
            var parsed = JSON.parse(result);
            if (parsed && parsed.error) {
                throw new Error('[DB] Bridge returned error: ' + parsed.error);
            }
            return parsed;
        }
        return null;
    }

    // ============================================
    // LOAD DEPARTURE LOGS
    // ============================================
    async function loadDepartLogs() {
        try {
            var logs = await dbGet('departLogs') || [];
            logs.sort(function(a, b) {
                return b.timestamp - a.timestamp;
            });
            return logs;
        } catch (e) {
            console.error('[DepartLogViewer] Load error:', e.message);
            return [];
        }
    }

    // ============================================
    // FORMATTING HELPERS
    // ============================================
    function formatNumber(num) {
        if (num === null || num === undefined || isNaN(num)) return '-';
        return Number(num).toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    function formatDecimal(num, decimals) {
        if (num === null || num === undefined || isNaN(num)) return '-';
        return Number(num).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    function formatDate(timestamp) {
        if (!timestamp) return '-';
        var d = new Date(timestamp);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
               ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    // Get Pinia store
    function getStore(name) {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;
            return pinia._s.get(name);
        } catch {
            return null;
        }
    }

    function getGameStore() { return getStore('game'); }

    // Build portsByCode Map from game store (called at modal open)
    function buildPortsByCodeMap() {
        var gameStore = cachedGameStore;
        if (!gameStore || !gameStore.ports) {
            portsByCode = null;
            return;
        }
        portsByCode = new Map();
        gameStore.ports.forEach(function(p) {
            if (p.code) {
                portsByCode.set(p.code.toLowerCase(), p);
            }
        });
    }

    // Get port data using cached Map (O(1) lookup)
    function getPortData(code) {
        if (!code) return null;
        if (!portsByCode) return null;
        return portsByCode.get(code.toLowerCase()) || null;
    }

    // Format port: "Name (CODE) Country" or fallback to capitalized code
    function formatPortDisplay(code) {
        if (!code) return '-';
        var port = getPortData(code);
        if (port && port.name) {
            var displayCode = escapeHtml(code.toUpperCase().substring(0, 3));
            var country = port.country ? escapeHtml(port.country.toUpperCase()) : '';
            return escapeHtml(port.name) + ' (' + displayCode + ')' + (country ? ' ' + country : '');
        }
        // Fallback: capitalize
        var fallback = code.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        return escapeHtml(fallback);
    }

    function getGrossIncome(log) {
        var income = log.departResponse?.income || 0;
        var harborFee = log.departResponse?.harborFee || 0;
        return income + harborFee;
    }

    function getTriggerLabel(type) {
        var colors = { auto: '#3b82f6', manual: '#22c55e', single: '#f59e0b' };
        var color = colors[type] || '#6b7280';
        return '<span style="background:' + color + ';color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;">' + escapeHtml((type || 'UNKNOWN').toUpperCase()) + '</span>';
    }

    // ============================================
    // SEARCH & FILTER
    // ============================================
    function getDepartInfo(resp) {
        if (resp.teuDry !== undefined) {
            return resp;
        }
        var fullApi = resp.fullApiResponse || {};
        return fullApi.depart_info || resp.fullDepartInfo || {};
    }

    function getLogUtilization(log) {
        var resp = log.departResponse || {};
        var info = getDepartInfo(resp);
        var teuDry = info.teuDry || info.teu_dry || 0;
        var teuRef = info.teuRef || info.teu_refrigerated || 0;
        var crudeOil = info.crudeOil || info.crude_oil || 0;
        var fuelCargo = info.fuelCargo || info.fuel || 0;
        var capacityMax = log.capacityMax || {};
        var totalLoaded = 0;
        var maxCapacity = 0;
        if (teuDry > 0 || teuRef > 0) {
            totalLoaded = teuDry + teuRef;
            maxCapacity = (capacityMax.dry || 0) + (capacityMax.refrigerated || 0);
        } else {
            totalLoaded = crudeOil + fuelCargo;
            maxCapacity = (capacityMax.crude_oil || 0) + (capacityMax.fuel || 0);
        }
        return maxCapacity > 0 ? Math.round((totalLoaded / maxCapacity) * 100) : 0;
    }

    function getLogContribDelta(log) {
        return log.myContributionDelta || 0;
    }

    function formatContrib(value) {
        var n = value || 0;
        return (n >= 0 ? '+' : '') + formatNumber(n);
    }

    function contribColor(value) {
        return (value || 0) >= 0 ? '#0369a1' : '#dc2626';
    }

    function matchesUtilizationFilter(util, filter) {
        if (!filter || filter === 'all') return true;
        if (filter === '<30') return util < 30;
        if (filter === '30-50') return util >= 30 && util <= 50;
        if (filter === '50-75') return util > 50 && util <= 75;
        if (filter === '75-85') return util > 75 && util <= 85;
        if (filter === '85-100') return util > 85 && util <= 100;
        return true;
    }

    function matchesContribFilter(contrib, filter) {
        if (!filter || filter === 'all') return true;
        if (filter === '<2') return contrib < 2;
        if (filter === '2-5') return contrib >= 2 && contrib <= 5;
        if (filter === '5-10') return contrib > 5 && contrib <= 10;
        if (filter === '10-15') return contrib > 10 && contrib <= 15;
        if (filter === '15-25') return contrib > 15 && contrib <= 25;
        if (filter === '25-30') return contrib > 25 && contrib <= 30;
        if (filter === '>30') return contrib > 30;
        return true;
    }

    // Pre-compute utilization for all logs (fix #7: avoid double calculation)
    function precomputeUtilization(logs) {
        logs.forEach(function(log) {
            if (log.utilization === undefined) {
                log.utilization = getLogUtilization(log);
            }
        });
    }

    function applyFilters() {
        var searchTerm = filterRefs.search ? filterRefs.search.value.toLowerCase().trim() : '';
        var utilValue = filterRefs.util ? filterRefs.util.value : 'all';
        var contribValue = filterRefs.contrib ? filterRefs.contrib.value : 'all';

        filteredLogs = allLogs.filter(function(log) {
            // Search filter
            if (searchTerm) {
                var matchSearch = false;
                if (log.vesselName && log.vesselName.toLowerCase().includes(searchTerm)) matchSearch = true;
                if (log.vesselId && log.vesselId.toString().includes(searchTerm)) matchSearch = true;
                var netIncome = log.departResponse?.income || 0;
                if (netIncome.toString().includes(searchTerm)) matchSearch = true;
                var grossIncome = getGrossIncome(log);
                if (grossIncome.toString().includes(searchTerm)) matchSearch = true;
                if (log.routeOrigin && log.routeOrigin.toLowerCase().includes(searchTerm)) matchSearch = true;
                if (log.routeDestination && log.routeDestination.toLowerCase().includes(searchTerm)) matchSearch = true;
                if (!matchSearch) return false;
            }

            // Utilization filter (use precomputed value)
            if (!matchesUtilizationFilter(log.utilization, utilValue)) return false;

            // Contribution filter
            var contrib = getLogContribDelta(log);
            if (!matchesContribFilter(contrib, contribValue)) return false;

            return true;
        });

        // Reset to page 0 on filter change
        currentPage = 0;
    }

    // ============================================
    // RENDER LOG ITEM
    // ============================================
    function renderLogItem(log, index) {
        var resp = log.departResponse || {};
        var info = getDepartInfo(resp);

        var netIncome = resp.income || info.depart_income || 0;
        var grossIncome = getGrossIncome(log);
        var harborFee = resp.harborFee || info.harbor_fee || 0;
        var channelFee = resp.channelFee || info.channel_payment || 0;
        var guardFee = resp.guardFee || info.guard_payment || 0;
        var fuelUsed = resp.fuelUsed || (info.fuel_usage ? info.fuel_usage / 1000 : 0);
        var co2Used = resp.co2Used || (info.co2_emission ? info.co2_emission / 1000 : 0);

        var teuDry = info.teuDry || info.teu_dry || 0;
        var teuRef = info.teuRef || info.teu_refrigerated || 0;
        var crudeOil = info.crudeOil || info.crude_oil || 0;
        var fuelCargo = info.fuelCargo || info.fuel || 0;

        // My contribution (only if tracked - user in alliance)
        var myContribBefore = log.myContributionBefore;
        var myContribAfter = log.myContributionAfter;
        var myContribDelta = log.myContributionDelta;
        var hasContribution = myContribBefore !== null && myContribBefore !== undefined;

        // Escaped user data
        var safeVesselName = escapeHtml(log.vesselName || 'Unknown');
        var safeVesselId = escapeHtml(String(log.vesselId || '-'));

        var html = '<div class="dlv-item" data-index="' + index + '" style="border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px;overflow:hidden;">';

        // === COLLAPSED HEADER ===
        html += '<div class="dlv-item-header" style="padding:12px;background:#f9fafb;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">';
        html += '<div style="display:flex;align-items:center;gap:12px;">';
        html += '<span class="dlv-expand-icon" style="font-size:12px;color:#6b7280;transition:transform 0.2s;">&#9654;</span>';
        html += '<div>';
        html += '<div style="font-weight:600;font-size:14px;">' + safeVesselName + '</div>';
        html += '<div style="font-size:12px;color:#6b7280;">' + escapeHtml(formatDate(log.timestamp)) + ' ' + getTriggerLabel(log.triggerType) + '</div>';
        html += '</div>';
        html += '</div>';
        html += '<div style="text-align:right;">';
        html += '<div style="font-weight:700;font-size:16px;color:#16a34a;">+$' + formatNumber(netIncome) + '</div>';
        if (hasContribution) {
            html += '<div style="font-size:11px;color:' + contribColor(myContribDelta) + ';font-weight:600;">My Contrib: ' + formatContrib(myContribDelta) + '</div>';
        }
        html += '</div>';
        html += '</div>';

        // === EXPANDED DETAILS ===
        html += '<div class="dlv-item-details" style="display:none;padding:0;border-top:1px solid #e5e7eb;background:#fff;">';

        // Table style
        var rowStyle = 'display:flex;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #f3f4f6;';
        var labelStyle = 'color:#6b7280;font-size:12px;';
        var valueStyle = 'font-size:12px;font-weight:500;';

        // Route Info
        html += '<div style="' + rowStyle + '">';
        html += '<span style="' + labelStyle + '">Route</span>';
        html += '<span style="' + valueStyle + '">' + formatPortDisplay(log.routeOrigin) + ' -> ' + formatPortDisplay(log.routeDestination) + '</span>';
        html += '</div>';

        html += '<div style="' + rowStyle + '">';
        html += '<span style="' + labelStyle + '">Vessel ID</span>';
        html += '<span style="' + valueStyle + '">' + safeVesselId + '</span>';
        html += '</div>';

        if (log.routeDistance) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Distance / Speed</span>';
            html += '<span style="' + valueStyle + '">' + formatNumber(log.routeDistance) + ' nm @ ' + escapeHtml(String(log.routeSpeed || '-')) + ' kn</span>';
            html += '</div>';
        }

        // Financial - Gross first, then deductions, then Net
        html += '<div style="' + rowStyle + '">';
        html += '<span style="' + labelStyle + '">Gross Income</span>';
        html += '<span style="' + valueStyle + 'color:#16a34a;">$' + formatNumber(grossIncome) + '</span>';
        html += '</div>';

        html += '<div style="' + rowStyle + '">';
        html += '<span style="' + labelStyle + '">Harbor Fee</span>';
        html += '<span style="' + valueStyle + 'color:#dc2626;">-$' + formatNumber(harborFee) + '</span>';
        html += '</div>';

        if (channelFee > 0) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Channel Fee</span>';
            html += '<span style="' + valueStyle + 'color:#dc2626;">-$' + formatNumber(channelFee) + '</span>';
            html += '</div>';
        }

        if (guardFee > 0) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Guard Payment</span>';
            html += '<span style="' + valueStyle + 'color:#dc2626;">-$' + formatNumber(guardFee) + '</span>';
            html += '</div>';
        }

        html += '<div style="' + rowStyle + 'background:#f9fafb;font-weight:600;">';
        html += '<span style="' + labelStyle + 'font-weight:600;">Net Income</span>';
        html += '<span style="' + valueStyle + 'color:#16a34a;">$' + formatNumber(netIncome) + '</span>';
        html += '</div>';

        // Cargo loaded (from depart_info)
        if (teuDry > 0) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">TEU Dry</span>';
            html += '<span style="' + valueStyle + '">' + formatNumber(teuDry) + ' TEU</span>';
            html += '</div>';
        }
        if (teuRef > 0) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">TEU Refrigerated</span>';
            html += '<span style="' + valueStyle + '">' + formatNumber(teuRef) + ' TEU</span>';
            html += '</div>';
        }
        if (crudeOil > 0) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Crude Oil</span>';
            html += '<span style="' + valueStyle + '">' + formatNumber(crudeOil) + ' BBL</span>';
            html += '</div>';
        }
        if (fuelCargo > 0) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Fuel</span>';
            html += '<span style="' + valueStyle + '">' + formatNumber(fuelCargo) + ' BBL</span>';
            html += '</div>';
        }

        // Utilization (use precomputed value from fix #7)
        if (log.utilization > 0) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Utilization</span>';
            html += '<span style="' + valueStyle + '">' + log.utilization + '%</span>';
            html += '</div>';
        }

        // Prices (from vessel.prices)
        var prices = log.prices || {};
        if (prices.dry) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Price Dry</span>';
            html += '<span style="' + valueStyle + '">$' + formatNumber(prices.dry) + '</span>';
            html += '</div>';
        }
        if (prices.refrigerated) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Price Refrigerated</span>';
            html += '<span style="' + valueStyle + '">$' + formatNumber(prices.refrigerated) + '</span>';
            html += '</div>';
        }
        if (prices.crude_oil) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Price Crude</span>';
            html += '<span style="' + valueStyle + '">$' + formatNumber(prices.crude_oil) + '</span>';
            html += '</div>';
        }
        if (prices.fuel) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Price Fuel</span>';
            html += '<span style="' + valueStyle + '">$' + formatNumber(prices.fuel) + '</span>';
            html += '</div>';
        }

        // Resources Used
        html += '<div style="' + rowStyle + '">';
        html += '<span style="' + labelStyle + '">Fuel Used</span>';
        html += '<span style="' + valueStyle + '">' + formatDecimal(fuelUsed, 1) + ' t</span>';
        html += '</div>';

        html += '<div style="' + rowStyle + '">';
        html += '<span style="' + labelStyle + '">CO2 Emission</span>';
        html += '<span style="' + valueStyle + '">' + formatDecimal(co2Used, 1) + ' t</span>';
        html += '</div>';

        // MY CONTRIBUTION (at bottom, only if tracked)
        if (hasContribution) {
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Contrib Before</span>';
            html += '<span style="' + valueStyle + '">' + formatNumber(myContribBefore) + '</span>';
            html += '</div>';
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Contrib After</span>';
            html += '<span style="' + valueStyle + '">' + formatNumber(myContribAfter) + '</span>';
            html += '</div>';
            html += '<div style="' + rowStyle + '">';
            html += '<span style="' + labelStyle + '">Contrib Delta</span>';
            html += '<span style="' + valueStyle + 'color:' + contribColor(myContribDelta) + ';">' + formatContrib(myContribDelta) + '</span>';
            html += '</div>';
        }

        html += '</div>';
        html += '</div>';

        return html;
    }

    // ============================================
    // RENDER LIST (paginated)
    // ============================================
    function renderList(container) {
        container.innerHTML = '';

        var start = currentPage * ITEMS_PER_PAGE;
        var toShow = filteredLogs.slice(start, start + ITEMS_PER_PAGE);

        if (toShow.length === 0 && filteredLogs.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280;">No departure logs found.</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < toShow.length; i++) {
            html += renderLogItem(toShow[i], start + i);
        }
        container.insertAdjacentHTML('beforeend', html);

        var items = container.querySelectorAll('.dlv-item:not([data-bound])');
        items.forEach(function(item) {
            item.dataset.bound = 'true';
            var header = item.querySelector('.dlv-item-header');
            var details = item.querySelector('.dlv-item-details');
            var icon = item.querySelector('.dlv-expand-icon');

            header.addEventListener('click', function() {
                var isOpen = details.style.display !== 'none';
                details.style.display = isOpen ? 'none' : 'block';
                icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
            });
        });
    }

    // ============================================
    // PAGINATION CONTROLS
    // ============================================
    function renderPagination(paginationContainer, listContainer) {
        paginationContainer.innerHTML = '';

        var totalPages = Math.ceil(filteredLogs.length / ITEMS_PER_PAGE);
        if (totalPages <= 1) return;

        var navStyle = 'display:flex;align-items:center;justify-content:center;gap:4px;padding:8px 0;flex-wrap:wrap;';
        var btnBase = 'padding:4px 10px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;cursor:pointer;background:#fff;color:#334155;';
        var btnActive = 'padding:4px 10px;border:1px solid #0284c7;border-radius:4px;font-size:12px;cursor:pointer;background:#0284c7;color:#fff;font-weight:600;';
        var btnDisabled = 'padding:4px 10px;border:1px solid #e5e7eb;border-radius:4px;font-size:12px;cursor:default;background:#f3f4f6;color:#9ca3af;';

        var nav = document.createElement('div');
        nav.style.cssText = navStyle;

        // Prev button
        var prevBtn = document.createElement('button');
        prevBtn.textContent = 'Prev';
        if (currentPage === 0) {
            prevBtn.style.cssText = btnDisabled;
        } else {
            prevBtn.style.cssText = btnBase;
            prevBtn.addEventListener('click', function() {
                currentPage--;
                renderList(listContainer);
                renderPagination(paginationContainer, listContainer);
                updateFooter();
                listContainer.scrollTop = 0;
            });
        }
        nav.appendChild(prevBtn);

        // Page number buttons (show max 7 page buttons around current)
        var maxButtons = 7;
        var startPage = Math.max(0, currentPage - Math.floor(maxButtons / 2));
        var endPage = Math.min(totalPages - 1, startPage + maxButtons - 1);
        if (endPage - startPage < maxButtons - 1) {
            startPage = Math.max(0, endPage - maxButtons + 1);
        }

        if (startPage > 0) {
            var firstBtn = document.createElement('button');
            firstBtn.textContent = '1';
            firstBtn.style.cssText = btnBase;
            firstBtn.addEventListener('click', function() {
                currentPage = 0;
                renderList(listContainer);
                renderPagination(paginationContainer, listContainer);
                updateFooter();
                listContainer.scrollTop = 0;
            });
            nav.appendChild(firstBtn);
            if (startPage > 1) {
                var dots = document.createElement('span');
                dots.textContent = '...';
                dots.style.cssText = 'font-size:12px;color:#6b7280;padding:0 2px;';
                nav.appendChild(dots);
            }
        }

        for (var p = startPage; p <= endPage; p++) {
            (function(pageNum) {
                var pageBtn = document.createElement('button');
                pageBtn.textContent = String(pageNum + 1);
                pageBtn.style.cssText = pageNum === currentPage ? btnActive : btnBase;
                if (pageNum !== currentPage) {
                    pageBtn.addEventListener('click', function() {
                        currentPage = pageNum;
                        renderList(listContainer);
                        renderPagination(paginationContainer, listContainer);
                        updateFooter();
                        listContainer.scrollTop = 0;
                    });
                }
                nav.appendChild(pageBtn);
            })(p);
        }

        if (endPage < totalPages - 1) {
            if (endPage < totalPages - 2) {
                var dots2 = document.createElement('span');
                dots2.textContent = '...';
                dots2.style.cssText = 'font-size:12px;color:#6b7280;padding:0 2px;';
                nav.appendChild(dots2);
            }
            var lastBtn = document.createElement('button');
            lastBtn.textContent = String(totalPages);
            lastBtn.style.cssText = btnBase;
            lastBtn.addEventListener('click', function() {
                currentPage = totalPages - 1;
                renderList(listContainer);
                renderPagination(paginationContainer, listContainer);
                updateFooter();
                listContainer.scrollTop = 0;
            });
            nav.appendChild(lastBtn);
        }

        // Next button
        var nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next';
        if (currentPage >= totalPages - 1) {
            nextBtn.style.cssText = btnDisabled;
        } else {
            nextBtn.style.cssText = btnBase;
            nextBtn.addEventListener('click', function() {
                currentPage++;
                renderList(listContainer);
                renderPagination(paginationContainer, listContainer);
                updateFooter();
                listContainer.scrollTop = 0;
            });
        }
        nav.appendChild(nextBtn);

        paginationContainer.appendChild(nav);
    }

    // ============================================
    // MODAL STYLES (game-like)
    // ============================================
    function injectModalStyles() {
        if (document.getElementById('dlv-modal-styles')) return;
        var style = document.createElement('style');
        style.id = 'dlv-modal-styles';
        style.textContent = [
            '@keyframes dlv-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes dlv-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes dlv-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes dlv-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#dlv-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#dlv-modal-wrapper #dlv-modal-background{animation:dlv-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#dlv-modal-wrapper.hide #dlv-modal-background{animation:dlv-fade-out .15s linear forwards}',
            '#dlv-modal-wrapper #dlv-modal-content-wrapper{animation:dlv-drop-down .15s linear forwards,dlv-fade-in .15s linear forwards;height:100%;max-width:460px;opacity:0;position:relative;width:100%;z-index:9001}',
            '#dlv-modal-wrapper.hide #dlv-modal-content-wrapper{animation:dlv-push-up .15s linear forwards,dlv-fade-out .15s linear forwards}',
            '#dlv-modal-wrapper #dlv-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#dlv-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#dlv-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#dlv-modal-container .header-icon{cursor:pointer;height:19px;width:19px;margin:0 .5rem}',
            '#dlv-modal-container #dlv-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#dlv-modal-container #dlv-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#dlv-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    // ============================================
    // CREATE MODAL (fix #12: rebuild from scratch each time)
    // ============================================
    async function openModal() {
        injectModalStyles();

        // Fix #12: Always remove old modal and rebuild fresh (auto-cleans all listeners)
        if (modalElement) {
            modalElement.remove();
            modalElement = null;
        }

        // Fix #8: Cache game store at modal open
        cachedGameStore = getGameStore();
        // Fix #9: Build portsByCode Map at modal open
        buildPortsByCodeMap();

        allLogs = await loadDepartLogs();
        // Fix #7: Pre-compute utilization once for all logs
        precomputeUtilization(allLogs);
        filteredLogs = allLogs.slice();
        currentPage = 0;

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        modalElement = document.createElement('div');
        modalElement.id = 'dlv-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'dlv-modal-background';
        modalBackground.onclick = closeModal;

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'dlv-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'dlv-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Departure Logs';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = closeModal;

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'dlv-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'dlv-central-container';

        // Fix #3: Search bar built with createElement instead of innerHTML
        var searchBar = document.createElement('div');
        searchBar.style.cssText = 'margin-bottom:8px;';
        var searchInput = document.createElement('input');
        searchInput.id = 'dlv-search';
        searchInput.type = 'text';
        searchInput.placeholder = 'Search vessel, port, income...';
        searchInput.style.cssText = 'width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;box-sizing:border-box;';
        searchBar.appendChild(searchInput);
        centralContainer.appendChild(searchBar);

        // Fix #3: Filter dropdowns built with createElement instead of innerHTML
        var filterBar = document.createElement('div');
        filterBar.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';

        // Utilization filter
        var utilWrapper = document.createElement('div');
        utilWrapper.style.cssText = 'flex:1;';
        var utilLabel = document.createElement('label');
        utilLabel.style.cssText = 'font-size:11px;color:#666;display:block;margin-bottom:2px;';
        utilLabel.textContent = 'Utilization';
        var utilSelect = document.createElement('select');
        utilSelect.id = 'dlv-filter-util';
        utilSelect.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;background:#fff;';
        var utilOptions = [
            { value: 'all', text: 'All' },
            { value: '<30', text: '<30%' },
            { value: '30-50', text: '30-50%' },
            { value: '50-75', text: '50-75%' },
            { value: '75-85', text: '75-85%' },
            { value: '85-100', text: '85-100%' }
        ];
        utilOptions.forEach(function(opt) {
            var option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.text;
            utilSelect.appendChild(option);
        });
        utilWrapper.appendChild(utilLabel);
        utilWrapper.appendChild(utilSelect);
        filterBar.appendChild(utilWrapper);

        // Contribution filter
        var contribWrapper = document.createElement('div');
        contribWrapper.style.cssText = 'flex:1;';
        var contribLabel = document.createElement('label');
        contribLabel.style.cssText = 'font-size:11px;color:#666;display:block;margin-bottom:2px;';
        contribLabel.textContent = 'Contribution';
        var contribSelect = document.createElement('select');
        contribSelect.id = 'dlv-filter-contrib';
        contribSelect.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;background:#fff;';
        var contribOptions = [
            { value: 'all', text: 'All' },
            { value: '<2', text: '<2' },
            { value: '2-5', text: '2-5' },
            { value: '5-10', text: '5-10' },
            { value: '10-15', text: '10-15' },
            { value: '15-25', text: '15-25' },
            { value: '25-30', text: '25-30' },
            { value: '>30', text: '>30' }
        ];
        contribOptions.forEach(function(opt) {
            var option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.text;
            contribSelect.appendChild(option);
        });
        contribWrapper.appendChild(contribLabel);
        contribWrapper.appendChild(contribSelect);
        filterBar.appendChild(contribWrapper);

        centralContainer.appendChild(filterBar);

        // List container
        var listContainer = document.createElement('div');
        listContainer.id = 'dlv-list';
        listContainer.style.cssText = 'overflow-y:auto;max-height:calc(100vh - 260px);';
        centralContainer.appendChild(listContainer);

        // Pagination container
        var paginationContainer = document.createElement('div');
        paginationContainer.id = 'dlv-pagination';
        centralContainer.appendChild(paginationContainer);

        // Footer
        var footer = document.createElement('div');
        footer.id = 'dlv-footer';
        footer.style.cssText = 'padding:8px 0;font-size:11px;color:#666;';
        var footerShown = document.createElement('span');
        footerShown.id = 'dlv-shown';
        footerShown.textContent = '0';
        var footerTotal = document.createElement('span');
        footerTotal.id = 'dlv-total';
        footerTotal.textContent = '0';
        footer.appendChild(document.createTextNode('Showing page '));
        footer.appendChild(footerShown);
        footer.appendChild(document.createTextNode(' of '));
        footer.appendChild(footerTotal);
        centralContainer.appendChild(footer);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalElement.appendChild(modalBackground);
        modalElement.appendChild(modalContentWrapper);
        document.body.appendChild(modalElement);

        // Fix #6: Cache filter element references at modal open
        filterRefs.search = searchInput;
        filterRefs.util = utilSelect;
        filterRefs.contrib = contribSelect;

        renderList(listContainer);
        renderPagination(paginationContainer, listContainer);
        updateFooter();

        // Search handler
        searchInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function() {
                applyFilters();
                renderList(listContainer);
                renderPagination(paginationContainer, listContainer);
                updateFooter();
            }, 300);
        });

        // Filter handlers
        utilSelect.addEventListener('change', function() {
            applyFilters();
            renderList(listContainer);
            renderPagination(paginationContainer, listContainer);
            updateFooter();
        });

        contribSelect.addEventListener('change', function() {
            applyFilters();
            renderList(listContainer);
            renderPagination(paginationContainer, listContainer);
            updateFooter();
        });

        // Fix #4: Throttled scroll handler (150ms) - kept for scroll-to-top UX, no longer loads more
        var scrollThrottle = null;
        listContainer.addEventListener('scroll', function() {
            if (scrollThrottle) return;
            scrollThrottle = setTimeout(function() {
                scrollThrottle = null;
            }, 150);
        });
    }

    function updateFooter() {
        var shown = document.getElementById('dlv-shown');
        var total = document.getElementById('dlv-total');
        var totalPages = Math.max(1, Math.ceil(filteredLogs.length / ITEMS_PER_PAGE));
        if (shown) shown.textContent = currentPage + 1;
        if (total) total.textContent = totalPages + ' (' + filteredLogs.length + ' logs)';
    }

    // Fix #12: Remove modal from DOM on close (auto-cleans all event listeners)
    function closeModal() {
        if (modalElement) {
            modalElement.classList.add('hide');
            setTimeout(function() {
                if (modalElement) {
                    modalElement.remove();
                    modalElement = null;
                }
                // Clear cached refs
                filterRefs.search = null;
                filterRefs.util = null;
                filterRefs.contrib = null;
                cachedGameStore = null;
                portsByCode = null;
            }, 160); // Wait for fade-out animation (150ms) to finish
        }
    }

    // ============================================
    // FLEET STATS TAB
    // ============================================
    var fleetTabInjected = false;
    var fleetStatsPeriod = -1; // default: all time (-1 = no filter)
    var fleetStatsSort = { key: 'income', dir: 'desc' };
    var fleetStatsLogs = null; // cached logs from DB

    function getVesselStore() { return getStore('vessel'); }
    function getRouteStore() { return getStore('route'); }
    function getGlobalStore() { return getStore('global'); }
    function getModalStore() { return getStore('modal'); }

    // Fix #5: Replace setInterval polling with MutationObserver (debounced 300ms)
    function watchFleetModal() {
        var debounceTimer = null;
        var observer = new MutationObserver(function() {
            if (debounceTimer) return;
            debounceTimer = setTimeout(function() {
                debounceTimer = null;
                var bottomNav = document.getElementById('bottom-nav');
                var deliveryBtn = bottomNav ? bottomNav.querySelector('#delivery-page-btn') : null;
                if (bottomNav && deliveryBtn) {
                    if (!fleetTabInjected) {
                        injectFleetStatsTab(bottomNav);
                        fleetTabInjected = true;
                    }
                } else {
                    // Only remove if fleet modal is truly gone (not just Vue re-rendering)
                    // Double-check after a short delay to avoid false positives during Vue transitions
                    if (fleetTabInjected) {
                        setTimeout(function() {
                            var navRecheck = document.getElementById('bottom-nav');
                            if (!navRecheck) {
                                removeFleetStatsTab();
                                fleetTabInjected = false;
                            }
                        }, 200);
                    }
                }
            }, 300);
        });
        var modalContainer = document.getElementById('modal-container') || document.getElementById('app') || document.body;
        observer.observe(modalContainer, { childList: true, subtree: true });
    }

    function injectFleetStatsTab(bottomNav) {
        if (document.getElementById('dlv-stats-page-btn')) return;

        var tabBtn = document.createElement('div');
        tabBtn.id = 'dlv-stats-page-btn';
        tabBtn.className = 'flex-centered flex-vertical';
        tabBtn.style.cssText = 'cursor:pointer;padding:4px 8px;';
        tabBtn.innerHTML = '<img src="/images/icons/stock_chart_icon.svg" style="width:24px;height:24px;filter:invert(1);">' +
            '<span class="modal-bottom-navigation-btn">Stats</span>';
        bottomNav.appendChild(tabBtn);

        tabBtn.addEventListener('click', function() {
            // Deselect all other tabs
            var allTabs = bottomNav.querySelectorAll('[id$="-page-btn"]');
            allTabs.forEach(function(t) { t.classList.remove('selected-page'); });
            tabBtn.classList.add('selected-page');
            renderFleetStatsTab();
        });

        // Hook original tabs to close stats content when clicked
        var originalTabs = ['overview-page-btn', 'order-page-btn', 'delivery-page-btn', 'anchorPoints-page-btn'];
        originalTabs.forEach(function(tabId) {
            var el = document.getElementById(tabId);
            if (el) {
                el.addEventListener('click', function() {
                    tabBtn.classList.remove('selected-page');
                    var statsContent = document.getElementById('dlv-stats-content');
                    if (statsContent) statsContent.remove();
                    // Show original content
                    var central = document.getElementById('central-container');
                    if (central) {
                        Array.from(central.children).forEach(function(child) {
                            if (child.id !== 'dlv-stats-content') child.style.display = '';
                        });
                    }
                });
            }
        });
    }

    async function renderFleetStatsTab() {
        var central = document.getElementById('central-container');
        if (!central) return;

        // Hide original content
        Array.from(central.children).forEach(function(child) {
            if (child.id !== 'dlv-stats-content') child.style.display = 'none';
        });

        // Remove old stats content
        var old = document.getElementById('dlv-stats-content');
        if (old) old.remove();

        var container = document.createElement('div');
        container.id = 'dlv-stats-content';
        container.style.cssText = 'padding:10px 0;height:100%;display:flex;flex-direction:column;';
        central.appendChild(container);

        // Loading indicator
        var loadingEl = document.createElement('div');
        loadingEl.style.cssText = 'text-align:center;padding:40px;color:#64748b;font-size:14px;';
        loadingEl.textContent = 'Loading data...';
        container.appendChild(loadingEl);

        // Always load fresh from DB for stats (allLogs may be stale from a previous modal open)
        fleetStatsLogs = await loadDepartLogs();
        precomputeUtilization(fleetStatsLogs);
        loadingEl.remove();

        // Build filter bar (stays, never re-rendered)
        buildFleetFilterBar(container);

        // Table area (re-rendered on filter/sort change)
        var tableArea = document.createElement('div');
        tableArea.id = 'dlv-stats-table-area';
        tableArea.style.cssText = 'flex:1;overflow-y:auto;';
        container.appendChild(tableArea);

        renderFleetStatsTable();
    }

    function buildFleetFilterBar(container) {
        var filterBar = document.createElement('div');
        filterBar.id = 'dlv-stats-filter-bar';
        filterBar.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;';
        var periods = [
            { label: 'All', ms: -1 },
            { label: '1h', ms: 1 * 60 * 60 * 1000 },
            { label: '3h', ms: 3 * 60 * 60 * 1000 },
            { label: '6h', ms: 6 * 60 * 60 * 1000 },
            { label: '12h', ms: 12 * 60 * 60 * 1000 },
            { label: '24h', ms: 24 * 60 * 60 * 1000 },
            { label: '48h', ms: 48 * 60 * 60 * 1000 },
            { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 }
        ];
        var activeBtnStyle = 'padding:5px 12px;border-radius:12px;border:1px solid #0284c7;font-size:12px;font-weight:600;cursor:pointer;background:#0284c7;color:#fff;';
        var inactiveBtnStyle = 'padding:5px 12px;border-radius:12px;border:1px solid #cbd5e1;font-size:12px;font-weight:600;cursor:pointer;background:#fff;color:#334155;';
        periods.forEach(function(p) {
            var btn = document.createElement('button');
            btn.textContent = p.label;
            btn.dataset.periodMs = p.ms;
            btn.style.cssText = p.ms === fleetStatsPeriod ? activeBtnStyle : inactiveBtnStyle;
            btn.addEventListener('click', function() {
                fleetStatsPeriod = p.ms;
                // Update button styles
                filterBar.querySelectorAll('button').forEach(function(b) {
                    b.style.cssText = parseInt(b.dataset.periodMs) === fleetStatsPeriod ? activeBtnStyle : inactiveBtnStyle;
                });
                renderFleetStatsTable();
            });
            filterBar.appendChild(btn);
        });
        container.appendChild(filterBar);
    }

    function renderFleetStatsTable() {
        var tableArea = document.getElementById('dlv-stats-table-area');
        if (!fleetStatsLogs) return;
        // If tableArea was removed (e.g. Vue re-render), recreate it inside stats container
        if (!tableArea) {
            var statsContainer = document.getElementById('dlv-stats-content');
            if (!statsContainer) return;
            tableArea = document.createElement('div');
            tableArea.id = 'dlv-stats-table-area';
            tableArea.style.cssText = 'flex:1;overflow-y:auto;';
            statsContainer.appendChild(tableArea);
        }
        tableArea.innerHTML = '';

        var logs = fleetStatsLogs;
        var filtered;
        if (fleetStatsPeriod === -1) {
            filtered = logs;
        } else {
            var cutoff = Date.now() - fleetStatsPeriod;
            filtered = logs.filter(function(log) { return log.timestamp >= cutoff; });
        }

        // Group by vesselId
        var byVessel = {};
        filtered.forEach(function(log) {
            var vid = log.vesselId;
            if (!vid) return;
            if (!byVessel[vid]) {
                byVessel[vid] = { vesselId: vid, vesselName: log.vesselName || 'Unknown', logs: [] };
            }
            byVessel[vid].logs.push(log);
        });

        // Aggregate stats
        var stats = Object.values(byVessel).map(function(v) {
            var totalIncome = 0;
            var totalUtil = 0;
            var totalContrib = 0;
            v.logs.forEach(function(log) {
                totalIncome += (log.departResponse?.income || 0);
                totalUtil += (log.utilization != null ? log.utilization : getLogUtilization(log));
                totalContrib += getLogContribDelta(log);
            });
            return {
                vesselId: v.vesselId,
                vesselName: v.vesselName,
                income: totalIncome,
                departures: v.logs.length,
                avgUtil: Math.round(totalUtil / v.logs.length),
                contrib: totalContrib
            };
        });

        // Sort
        var k = fleetStatsSort.key;
        var asc = fleetStatsSort.dir === 'asc';
        stats.sort(function(a, b) {
            var va = k === 'vesselName' ? (a[k] || '').toLowerCase() : a[k];
            var vb = k === 'vesselName' ? (b[k] || '').toLowerCase() : b[k];
            if (va < vb) return asc ? -1 : 1;
            if (va > vb) return asc ? 1 : -1;
            return 0;
        });

        if (stats.length === 0) {
            tableArea.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280;">No departures in this time period.</div>';
            return;
        }

        // Totals
        var totalIncome = 0, totalDep = 0, totalContrib = 0;
        stats.forEach(function(s) {
            totalIncome += s.income;
            totalDep += s.departures;
            totalContrib += s.contrib;
        });

        // Sort indicator
        function sortArrow(key) {
            if (fleetStatsSort.key !== key) return '';
            return fleetStatsSort.dir === 'asc' ? ' ^' : ' v';
        }

        // Header
        var headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display:flex;padding:6px 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;border-bottom:2px solid #cbd5e1;position:sticky;top:0;background:#e9effd;z-index:1;';
        var columns = [
            { key: 'vesselName', label: 'Vessel', flex: '2', align: 'left' },
            { key: 'income', label: 'Income', flex: '1', align: 'right' },
            { key: 'departures', label: 'Dep', flex: '0.5', align: 'right' },
            { key: 'avgUtil', label: 'Util', flex: '0.5', align: 'right' },
            { key: 'contrib', label: 'Contrib', flex: '0.7', align: 'right' }
        ];
        columns.forEach(function(col) {
            var hcol = document.createElement('div');
            hcol.style.cssText = 'flex:' + col.flex + ';text-align:' + col.align + ';cursor:pointer;user-select:none;';
            hcol.textContent = col.label + sortArrow(col.key);
            hcol.addEventListener('click', function() {
                if (fleetStatsSort.key === col.key) {
                    fleetStatsSort.dir = fleetStatsSort.dir === 'desc' ? 'asc' : 'desc';
                } else {
                    fleetStatsSort.key = col.key;
                    fleetStatsSort.dir = col.key === 'vesselName' ? 'asc' : 'desc';
                }
                renderFleetStatsTable();
            });
            headerDiv.appendChild(hcol);
        });
        tableArea.appendChild(headerDiv);

        // Rows
        stats.forEach(function(s, i) {
            var bgColor = i % 2 === 0 ? '#fff' : '#f8fafc';
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;padding:8px;font-size:13px;align-items:center;border-bottom:1px solid #f1f5f9;background:' + bgColor + ';';
            row.innerHTML = '<div style="flex:2;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                '<span class="dlv-stats-vessel" data-vessel-id="' + s.vesselId + '" style="color:#0284c7;cursor:pointer;font-weight:500;">' + escapeHtml(s.vesselName) + '</span></div>' +
                '<div style="flex:1;text-align:right;font-weight:600;color:#16a34a;">$' + formatCompact(s.income) + '</div>' +
                '<div style="flex:0.5;text-align:right;">' + s.departures + '</div>' +
                '<div style="flex:0.5;text-align:right;">' + s.avgUtil + '%</div>' +
                '<div style="flex:0.7;text-align:right;color:' + contribColor(s.contrib) + ';">' + formatContrib(s.contrib) + '</div>';
            tableArea.appendChild(row);
        });

        // Totals row
        var totalsRow = document.createElement('div');
        totalsRow.style.cssText = 'display:flex;padding:8px;font-size:13px;font-weight:700;border-top:2px solid #cbd5e1;background:#f1f5f9;';
        totalsRow.innerHTML = '<div style="flex:2;text-align:left;">Total (' + stats.length + ' vessels)</div>' +
            '<div style="flex:1;text-align:right;color:#16a34a;">$' + formatCompact(totalIncome) + '</div>' +
            '<div style="flex:0.5;text-align:right;">' + totalDep + '</div>' +
            '<div style="flex:0.5;text-align:right;"></div>' +
            '<div style="flex:0.7;text-align:right;color:' + contribColor(totalContrib) + ';">' + formatContrib(totalContrib) + '</div>';
        tableArea.appendChild(totalsRow);

        // Vessel click handlers
        tableArea.querySelectorAll('.dlv-stats-vessel').forEach(function(el) {
            el.addEventListener('click', function() {
                var vesselId = parseInt(el.dataset.vesselId);
                openVesselPopup(vesselId);
            });
        });
    }

    function formatCompact(num) {
        if (num === null || num === undefined || isNaN(num)) return '-';
        var absNum = Math.abs(num);
        if (absNum >= 1e9) return (num / 1e9).toFixed(1) + 'B';
        if (absNum >= 1e6) return (num / 1e6).toFixed(1) + 'M';
        if (absNum >= 1e3) return (num / 1e3).toFixed(1) + 'K';
        return formatNumber(num);
    }

    function openVesselPopup(vesselId) {
        var vesselStore = getVesselStore();
        var routeStore = getRouteStore();
        var globalStore = getGlobalStore();
        var modalStore = getModalStore();
        if (!vesselStore || !routeStore || !globalStore || !modalStore) return;

        var vessel = vesselStore.userVessels.find(function(v) { return v.id === vesselId; });
        if (!vessel) return;

        routeStore.selectedVessel = vessel;
        globalStore.$patch(function(e) {
            e.popupData.show = true;
            e.popupData.type = 'vessel';
            e.trackedVessel = vessel;
            e.isSideBarOpen = false;
        });
        modalStore.closeAll();
    }

    // Fix #13: Set onclick = null before removing tab buttons to release closures
    function removeFleetStatsTab() {
        var tabBtn = document.getElementById('dlv-stats-page-btn');
        if (tabBtn) {
            tabBtn.onclick = null;
            tabBtn.remove();
        }
        var statsContent = document.getElementById('dlv-stats-content');
        if (statsContent) statsContent.remove();
        // Show original content back
        var central = document.getElementById('central-container');
        if (central) {
            Array.from(central.children).forEach(function(child) {
                child.style.display = '';
            });
        }
    }

    // ============================================
    // MENU INTEGRATION
    // ============================================
    function init() {
        if (typeof addMenuItem === 'function') {
            addMenuItem(SCRIPT_NAME, openModal);
        }
        watchFleetModal();
    }

    function waitForBridge() {
        if (typeof window.RebelShipBridge !== 'undefined' && window.RebelShipBridge.storage) {
            init();
        } else {
            setTimeout(waitForBridge, 500);
        }
    }

    waitForBridge();
})();
