// ==UserScript==
// @name        ShippingManager - Rebelship Header Optimizer
// @description Important script to handle all the Rebelship UI header elements for all scripts.
// @version     3.90
// @author      https://github.com/justonlyforyou/
// @order       999
// @match       https://shippingmanager.cc/*
// @run-at      document-end
// @grant       none
// @enabled     false
// ==/UserScript==

(function() {
    'use strict';

    var MAX_INIT_RETRIES = 20;
    var FALLBACK_INTERVAL = 5000;
    var DEBOUNCE_MS = 500;
    var headerCreated = false;
    var vipValueEl = null;
    var cashValueEl = null;
    var anchorValueEl = null;
    var stockPriceEl = null;
    var stockDiffEl = null;
    var stockPercentEl = null;
    var stockSvgSlot = null;
    var subscribeDebounce = null;

    // ============================================
    // CSS — responsive layout via media queries (no JS resize)
    // ============================================
    function injectCSS() {
        if (document.getElementById('rebel-mobile-css')) return;
        var style = document.createElement('style');
        style.id = 'rebel-mobile-css';
        style.textContent = [
            // Desktop >=1440px: compact single-row header
            '@media (min-width: 1440px) {',
            '  .shippingHeader { height: 47px !important; max-height: 47px !important; min-height: 47px !important; position: relative !important; }',
            '  #rebel-mobile-header { display: inline-flex !important; align-items: center !important; gap: 8px !important; position: static !important; margin-right: 8px !important; }',
            '  #rebel-mobile-header .rebel-row { display: contents !important; }',
            '}',
            // Mobile <1440px: two-row header
            '@media (max-width: 1439px) {',
            '  .shippingHeader { height: 89px !important; max-height: 89px !important; min-height: 89px !important; position: relative !important; }',
            '  #rebel-mobile-header { display: flex !important; flex-direction: column !important; gap: 2px !important; position: absolute !important; bottom: 2px !important; left: 0 !important; width: 100% !important; padding: 2px 9px !important; }',
            '  #rebel-mobile-header .rebel-row { display: flex !important; align-items: center !important; gap: 8px !important; }',
            '}',
            // Row 1: left-align utility items
            '.shippingHeader .headerMainContent { display: flex !important; justify-content: flex-start !important; align-items: center !important; gap: 5px !important; max-width: unset !important; padding: 2px 10px !important; margin: 0 !important; width: 100% !important; }',
            '.shippingHeader .headerMainContent * { font-size: 12px !important; }',
            '.shippingHeader .headerMainContent .content.led { margin-right: 0 !important; }',
            '.shippingHeader .headerMainContent > * { margin-left: 0 !important; }',
            // Hide original sections (we display compact versions)
            '.companyContent { display: none !important; }',
            '.headerSubContent { display: none !important; }',
            '.contentBar.points { display: none !important; }',
            '.contentBar.cash { display: none !important; }',
            // Hide chart/LED wrappers (bunker-price-display replaces them)
            '.chartWrapper { display: none !important; }',
            '.ledWrapper { display: none !important; }',
            // Force countdown box full width in port menu
            '.countdownBox { width: 100% !important; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // ============================================
    // Store access
    // ============================================
    function getStore(name) {
        try {
            var app = document.getElementById('app');
            if (!app || !app.__vue_app__) return null;
            var pinia = app.__vue_app__.config.globalProperties.$pinia;
            return (pinia && pinia._s) ? pinia._s.get(name) : null;
        } catch { return null; }
    }

    function formatPoints(v) {
        if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
        if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
        return String(v);
    }

    function formatCash(v) {
        return '$' + v.toLocaleString('en-US');
    }

    function getTrendColor(trend) {
        if (trend === 'down') return '#ef4444';
        if (trend === 'up') return '#4ade80';
        return '#ffffff';
    }

    function extractStockValues(el) {
        var values = [];
        var nodes = el.querySelectorAll('span, p, div');
        for (var i = 0; i < nodes.length; i++) {
            var txt = nodes[i].textContent.trim();
            if (nodes[i].children.length === 0 && txt.length > 0) values.push(txt);
        }
        if (values.length === 0) {
            var matches = el.textContent.trim().match(/[\$\d.,]+|[-+]?[\d.]+%/g);
            if (matches) values = matches;
        }
        return values;
    }

    // ============================================
    // Display update
    // ============================================
    function updateValues() {
        var userStore = getStore('user');
        if (userStore && userStore.user) {
            if (vipValueEl && userStore.user.points !== undefined) {
                vipValueEl.textContent = formatPoints(userStore.user.points);
            }
            if (cashValueEl && userStore.user.cash !== undefined) {
                cashValueEl.textContent = formatCash(userStore.user.cash);
            }
        }
        if (anchorValueEl && userStore && userStore.settings) {
            var max = userStore.settings.anchor_points || 0;
            var vesselStore = getStore('vessel');
            var used = (vesselStore && vesselStore.userVessels) ? vesselStore.userVessels.length : 0;
            anchorValueEl.textContent = Math.max(0, max - used) + '/' + max;
        }
        var origStock = document.querySelector('.stockInfo');
        if (origStock && stockPriceEl) {
            var trend = (userStore && userStore.user) ? userStore.user.stock_trend : null;
            var color = getTrendColor(trend);
            var vals = extractStockValues(origStock);
            stockPriceEl.textContent = vals[0] || '...';
            stockPriceEl.style.color = color;
            if (stockDiffEl) { stockDiffEl.textContent = vals[1] || ''; stockDiffEl.style.color = color; }
            if (stockPercentEl) { stockPercentEl.textContent = vals[2] || ''; stockPercentEl.style.color = color; }
            var svg = origStock.querySelector('svg');
            if (svg && stockSvgSlot) {
                var existing = stockSvgSlot.querySelector('svg');
                var svgClone = svg.cloneNode(true);
                svgClone.style.cssText = 'width:10px;height:10px;fill:' + color;
                var paths = svgClone.querySelectorAll('path,polygon,circle,rect');
                for (var p = 0; p < paths.length; p++) paths[p].style.fill = color;
                if (existing) stockSvgSlot.replaceChild(svgClone, existing);
                else stockSvgSlot.appendChild(svgClone);
            }
        }
    }

    // Debounced update for $subscribe
    function debouncedUpdate() {
        if (subscribeDebounce) clearTimeout(subscribeDebounce);
        subscribeDebounce = setTimeout(updateValues, DEBOUNCE_MS);
    }

    // Subscribe to userStore only (vessel count read passively in updateValues)
    function subscribeToStore() {
        var userStore = getStore('user');
        if (!userStore) return false;
        userStore.$subscribe(debouncedUpdate);
        return true;
    }

    // ============================================
    // Header creation (one-time, no rebuild on resize)
    // ============================================
    function createHeader() {
        if (headerCreated || document.getElementById('rebel-mobile-header')) return false;
        var companyContent = document.querySelector('.companyContent') || document.querySelector('.headerSubContent');
        var headerMain = document.querySelector('.headerMainContent');
        if (!companyContent || !headerMain) return false;

        var origXp = document.querySelector('.ceo-progress-container');
        var origStock = document.querySelector('.stockInfo');
        var origCash = document.querySelector('.contentBar.cash');
        var origPoints = document.querySelector('.contentBar.points');

        // XP button (static clone)
        var xpEl = null;
        if (origXp) {
            xpEl = origXp.cloneNode(true);
            xpEl.style.cssText = 'cursor:pointer;';
            xpEl.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); origXp.click(); });
        }

        // Company name (static clone)
        var companyEl = null;
        var origCompany = companyContent.querySelector('p.cursor-pointer');
        if (origCompany) {
            companyEl = origCompany.cloneNode(true);
            companyEl.style.cssText = 'color:#fff;font-weight:bold;cursor:pointer;margin:0;font-size:13px;';
            companyEl.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); origCompany.click(); });
        }

        // VIP points
        var vipEl = null;
        if (origPoints) {
            vipEl = document.createElement('div');
            vipEl.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;';
            var vipSvg = origPoints.querySelector('svg');
            if (vipSvg) {
                var vipIcon = vipSvg.cloneNode(true);
                vipIcon.setAttribute('width', '14');
                vipIcon.setAttribute('height', '14');
                vipEl.appendChild(vipIcon);
            }
            vipValueEl = document.createElement('span');
            vipValueEl.style.cssText = 'color:#fbbf24;font-size:13px;font-weight:bold;';
            vipValueEl.textContent = '...';
            vipEl.appendChild(vipValueEl);
            vipEl.addEventListener('click', function() { origPoints.click(); });
        }

        // Cash
        var cashEl = document.createElement('div');
        cashEl.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;';
        if (origCash) {
            var cashSvg = origCash.querySelector('svg');
            if (cashSvg) {
                var cashIcon = cashSvg.cloneNode(true);
                cashIcon.setAttribute('width', '14');
                cashIcon.setAttribute('height', '14');
                cashEl.appendChild(cashIcon);
            }
        }
        cashValueEl = document.createElement('span');
        cashValueEl.style.cssText = 'color:#4ade80;font-size:13px;font-weight:bold;';
        cashValueEl.textContent = '...';
        cashEl.appendChild(cashValueEl);
        cashEl.addEventListener('click', function() { if (origCash) origCash.click(); });

        // Anchor
        var anchorEl = document.createElement('div');
        anchorEl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;';
        var anchorIcon = document.createElement('span');
        anchorIcon.textContent = '\u2693';
        anchorEl.appendChild(anchorIcon);
        anchorValueEl = document.createElement('span');
        anchorValueEl.style.cssText = 'color:#60a5fa;font-weight:bold;';
        anchorValueEl.textContent = '...';
        anchorEl.appendChild(anchorValueEl);

        // Stock
        var stockEl = null;
        if (origStock) {
            stockEl = document.createElement('div');
            stockEl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;';
            stockEl.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); origStock.click(); });
            stockPriceEl = document.createElement('span');
            stockPriceEl.style.fontWeight = 'bold';
            stockEl.appendChild(stockPriceEl);
            stockDiffEl = document.createElement('span');
            stockEl.appendChild(stockDiffEl);
            stockPercentEl = document.createElement('span');
            stockEl.appendChild(stockPercentEl);
            stockSvgSlot = document.createElement('span');
            stockSvgSlot.style.cssText = 'display:inline-flex;align-items:center;';
            stockEl.appendChild(stockSvgSlot);
        }

        // Assemble: row1 = XP, Company, VIP, Cash | row2 = Anchor, Stock
        var wrapper = document.createElement('div');
        wrapper.id = 'rebel-mobile-header';

        var row1 = document.createElement('div');
        row1.className = 'rebel-row';
        if (xpEl) row1.appendChild(xpEl);
        if (companyEl) row1.appendChild(companyEl);
        if (vipEl) row1.appendChild(vipEl);
        row1.appendChild(cashEl);
        wrapper.appendChild(row1);

        var row2 = document.createElement('div');
        row2.className = 'rebel-row';
        row2.appendChild(anchorEl);
        if (stockEl) row2.appendChild(stockEl);
        wrapper.appendChild(row2);

        headerMain.insertBefore(wrapper, headerMain.firstChild);
        headerCreated = true;
        return true;
    }

    // ============================================
    // Init
    // ============================================
    function init() {
        var retries = 0;
        var subRetries = 0;

        function trySubscribe() {
            if (subscribeToStore()) return;
            if (subRetries < MAX_INIT_RETRIES) {
                subRetries++;
                setTimeout(trySubscribe, 1000);
            }
        }

        function tryInit() {
            if (document.querySelector('.companyContent') || document.querySelector('.headerSubContent')) {
                injectCSS();
                if (createHeader()) {
                    updateValues();
                    trySubscribe();
                    setInterval(updateValues, FALLBACK_INTERVAL);
                }
            } else if (retries < MAX_INIT_RETRIES) {
                retries++;
                setTimeout(tryInit, 500);
            }
        }

        tryInit();
    }

    init();
})();
