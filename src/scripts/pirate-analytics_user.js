// ==UserScript==
// @name         Pirate Analytics
// @description  Fleet performance dashboard, transaction log, route profitability and trends. Background recording + live dashboard.
// @version      1.0.3
// @match        https://shippingmanager.cc/*
// @order        2
// @background-job-required true
// @RequirePiratesTreasureMenu true
// ==/UserScript==

(function () {
    'use strict';

    var SCRIPT_NAME  = 'PirateAnalytics';
    var STORE_NAME   = 'data';
    var MAX_TX_AGE_DAYS = 90;
    var API_BASE = window.PIRATE_API_BASE || 'https://shippingmanager.cc/api';

    // ── Storage helpers (direct localStorage - no PiratesTreasureBridge dependency) ──
    var LS_PREFIX = 'pirate:' + SCRIPT_NAME + ':' + STORE_NAME + ':';

    function dbGet(key) {
        try {
            var r = localStorage.getItem(LS_PREFIX + key);
            return r ? JSON.parse(r) : null;
        } catch { return null; }
    }
    function dbSet(key, value) {
        try {
            localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
            return true;
        } catch { return false; }
    }

    // ── Transaction logger ───────────────────────────────────────
    function logTransaction(entry) {
        try {
            var txs = dbGet('transactions') || [];
            txs.unshift(entry);
            var cutoff = Date.now() - (MAX_TX_AGE_DAYS * 86400000);
            txs = txs.filter(function(t) { return t.timestamp >= cutoff; });
            if (txs.length > 2000) txs.length = 2000;
            dbSet('transactions', txs);
        } catch (e) { if (window.PirateLog) window.PirateLog.warn('PirateAnalytics', 'logTransaction failed', e); }
    }

    // ── 1.0.2: bunker purchase accounting (delivered + charged, not ordered) ──────────────────
    var BUNKER_TOL_T = 2, BUNKER_TOL_PCT = 0.005;
    var BUNKER_DM_BAD = { QUANTITY_EXCESS: 1, OVERCHARGE: 1, UNVERIFIED: 1, PRICE_SUSPECT: 1 };
    function paNum(x) { return typeof x === 'number' && isFinite(x); }

    // Pure: what a bunker purchase really was. i = { orderedTons, price, dm, respStockKg, stockBeforeKg, cashCost, preferCash, success }
    // dm = Depart Manager's verified result {deliveredTons, chargedTotal, decisionPrice, reportedPrice, priceVerdict, approximate, verdict}
    function paBunkerAccounting(i) {
        var ord = paNum(i.orderedTons) && i.orderedTons > 0 ? i.orderedTons : 0;
        var dm = i.dm || null;
        var tol = Math.max(BUNKER_TOL_T, ord * BUNKER_TOL_PCT);
        var f = { orderedTons: ord };
        if (i.success === false || (dm && dm.verdict === 'REJECTED')) {
            f.failed = true; f.amountTons = 0; f.deliveredTons = 0; f.costSource = 'refused'; f.discrepancy = ['REFUSED_BY_GAME'];
            return { fields: f, cost: 0 };
        }
        var delivered = null, dsrc = null;
        if (dm && paNum(dm.deliveredTons)) { delivered = dm.deliveredTons; dsrc = 'dm-verified'; }
        else if (paNum(i.respStockKg) && paNum(i.stockBeforeKg)) {
            var d = (i.respStockKg - i.stockBeforeKg) / 1000;
            if (d > 0 && d < 1e8) { delivered = d; dsrc = 'response-stock'; }   // a zero/negative change is not evidence of a delivery (stale or already-updated page store)
        }
        var price = (dm && paNum(dm.reportedPrice)) ? dm.reportedPrice : (dm && paNum(dm.decisionPrice) ? dm.decisionPrice : i.price);
        var costOrdered = (paNum(price) && price > 0 && ord > 0) ? Math.round(ord * price) : null;
        var cost = null, csrc = null;
        if (dm && paNum(dm.chargedTotal) && dm.priceVerdict === 'ok' && !dm.approximate) { cost = Math.round(dm.chargedTotal); csrc = 'dm-verified-charge'; }
        else if (i.preferCash && paNum(i.cashCost) && i.cashCost > 0) { cost = Math.round(i.cashCost); csrc = 'cash-change'; }
        else if (delivered !== null && paNum(price) && price > 0) { cost = Math.round(delivered * price); csrc = 'delivered-x-price'; }
        else if (costOrdered !== null) { cost = costOrdered; csrc = 'ordered-x-price'; }
        else if (paNum(i.cashCost) && i.cashCost > 0) { cost = Math.round(i.cashCost); csrc = 'cash-change'; }
        f.amountTons = delivered !== null ? delivered : ord;
        f.deliveredTons = delivered; f.deliveredSource = dsrc; f.costSource = csrc; f.costOrdered = costOrdered;
        var disc = [];
        if (delivered !== null && delivered > ord + tol) disc.push('DELIVERED_MORE');
        if (delivered !== null && delivered < ord - Math.max(tol, ord * 0.02)) disc.push('DELIVERED_LESS');
        if (cost !== null && costOrdered !== null && Math.abs(cost - costOrdered) > Math.max(1000, costOrdered * 0.01)) disc.push('COST_DIFFERS_FROM_ORDER');
        if (dm && BUNKER_DM_BAD[dm.verdict]) disc.push('DM_' + dm.verdict);
        if (dm && dm.priceVerdict === 'cash-overcharge') disc.push('CASH_ABOVE_PRICE');
        if (disc.length) f.discrepancy = disc;
        return { fields: f, cost: cost };
    }

    function paStockKg(commodity) {
        try {
            var app = document.querySelector('#app').__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            for (var [k, st] of pinia._s) { if (st.user && paNum(st.user[commodity])) return st.user[commodity]; }
        } catch {}
        return null;
    }
    function paStockFromResponse(data, commodity) {
        try { var u = (data && data.user) || (data && data.data && data.data.user); return u && paNum(u[commodity]) ? u[commodity] : null; } catch { return null; }
    }
    // Request unit: DM 3.110.9 publishes requestAmount (== the body amount, tonnes for fuel); DM <= 3.110.8 sent a kilogram number
    // (its published amountTons == amount / 1000); an unpublished fetch-path request is a legacy Depart Manager one.
    function paBunkerRequest(body, commodity, lpSnap) {
        var amt = Number(body && body.amount) || 0, lp = null;
        if (lpSnap !== undefined) lp = lpSnap;              // 1.0.3: the publication as it was WHEN THE REQUEST WAS SENT
        else { try { lp = window._dmLastPurchase; } catch {} }
        var fresh = lp && lp.commodity === commodity && Date.now() - lp.at < 60000;
        if (fresh && lp.requestAmount !== undefined && lp.requestAmount === amt) return { orderedTons: lp.amountTons, id: lp.id, price: lp.pricePerTon || 0, unit: lp.unit || 't' };
        if (fresh && Math.abs(lp.amountTons - amt / 1000) < 1) return { orderedTons: amt / 1000, id: lp.id, price: lp.pricePerTon || 0, unit: 'kg-legacy' };
        return { orderedTons: amt / 1000, id: undefined, price: 0, unit: 'kg-assumed' };
    }
    function paKnownPrice(commodity) {
        var p = 0;
        try { if (window._paBunkerPrices) p = commodity === 'fuel' ? (window._paBunkerPrices.fuel || 0) : (window._paBunkerPrices.co2 || 0); } catch {}
        if (!p) p = parseFloat(localStorage.getItem('pa_price_' + commodity) || '0');
        return p;
    }
    // Depart Manager verified a purchase AFTER this script logged it: amend that transaction
    function amendBunkerFromDm(res) {
        try {
            if (!res || !res.id) return false;
            var txs = dbGet('transactions') || [];
            var t = null;
            for (var k = 0; k < txs.length; k++) { if (txs[k].dmPurchaseId === res.id) { t = txs[k]; break; } }
            if (!t) {
                // 1.0.3: adopt an unlinked transaction of the same purchase (request not recognised at the time), whatever unit PA guessed
                var rts = Date.parse(res.requestAt), rtype = res.commodity === 'fuel' ? 'bunker_fuel' : 'bunker_co2';
                for (var j = 0; j < txs.length; j++) {
                    var x = txs[j];
                    if (x.type !== rtype || x.dmPurchaseId || x.reconciled || !rts || Math.abs(x.timestamp - rts) > 20000) continue;
                    var xo = paNum(x.orderedTons) ? x.orderedTons : x.amountTons;
                    if (!paNum(xo) || !paNum(res.orderedTons)) continue;
                    if (Math.abs(xo - res.orderedTons) <= 1 || Math.abs(xo * 1000 - res.orderedTons) <= 2 || Math.abs(xo / 1000 - res.orderedTons) <= 1) { t = x; t.dmPurchaseId = res.id; break; }
                }
            }
            if (!t) return false;
            t.orderedTons = res.orderedTons;
            var acc = paBunkerAccounting({ orderedTons: t.orderedTons, price: res.decisionPrice, dm: res, success: true });
            Object.keys(acc.fields).forEach(function(key) { t[key] = acc.fields[key]; });
            if (!acc.fields.discrepancy) delete t.discrepancy;
            if (acc.cost !== null) t.cost = acc.cost;
            delete t.awaitingDm;
            dbSet('transactions', txs);
            return true;
        } catch { return false; }
    }
    try { window.addEventListener('dm:purchase-recorded', function(e) { amendBunkerFromDm(e && e.detail); }); } catch {}

    // One-off correction of EXISTING bunker records from Depart Manager's own purchase log (same page storage).
    // Dry run unless {apply:true}. Matches by commodity + request time (+-30 s) + ordered tonnes; never touches a record twice.
    function reconcileBunker(opts) {
        opts = opts || {};
        var out = { apply: !!opts.apply, matched: 0, changed: [], skipped: 0 };
        var log = null;
        try { log = JSON.parse(localStorage.getItem('pirate:DepartManager:data:purchaseLog') || 'null'); } catch {}
        if (!Array.isArray(log)) { out.error = 'no Depart Manager purchase log'; return out; }
        var txs = dbGet('transactions') || [];
        log.forEach(function(e) {
            if (!e || (e.commodity !== 'fuel' && e.commodity !== 'co2') || !paNum(e.amountTons)) return;
            var ts = Date.parse(e.requestAt);
            if (!ts) return;
            var type = e.commodity === 'fuel' ? 'bunker_fuel' : 'bunker_co2';
            var best = null;
            txs.forEach(function(t) {
                if (t.type !== type || t.reconciled || t.dmPurchaseId) return;
                if (Math.abs(t.timestamp - ts) > 30000) return;
                var o = paNum(t.orderedTons) ? t.orderedTons : t.amountTons;
                if (!paNum(o) || (Math.abs(o - e.amountTons) > 1 && Math.abs(o * 1000 - e.amountTons) > 2)) return;   // 1.0.3: also a record 1000x too small
                if (!best || Math.abs(t.timestamp - ts) < Math.abs(best.timestamp - ts)) best = t;
            });
            if (!best) { out.skipped++; return; }
            out.matched++;
            var approx = !!e.chargedIsApproximate;
            var dm = { deliveredTons: paNum(e.deliveredTons) ? e.deliveredTons : null, decisionPrice: e.decisionPrice, reportedPrice: e.reportedPrice,
                chargedTotal: (paNum(e.cashBefore) && paNum(e.cashAfter) && !approx) ? e.cashBefore - e.cashAfter : null,
                priceVerdict: e.priceVerdict, approximate: approx, verdict: e.verdict || undefined };
            var acc = paBunkerAccounting({ orderedTons: e.amountTons, price: e.decisionPrice, dm: dm, success: true });
            var before = { amountTons: best.amountTons, cost: best.cost };
            var after = { amountTons: acc.fields.amountTons, cost: acc.cost !== null ? acc.cost : best.cost, discrepancy: acc.fields.discrepancy || null };
            if (Math.abs((before.cost || 0) - (after.cost || 0)) < 1 && Math.abs((before.amountTons || 0) - (after.amountTons || 0)) < 0.5 && !acc.fields.discrepancy) return;
            out.changed.push({ timestamp: best.timestamp, requestAt: e.requestAt, commodity: e.commodity, before: before, after: after });
            if (opts.apply) {
                Object.keys(acc.fields).forEach(function(key) { best[key] = acc.fields[key]; });
                if (acc.cost !== null) best.cost = acc.cost;
                best.reconciled = true;
            }
        });
        if (opts.apply && out.changed.length) dbSet('transactions', txs);
        return out;
    }
    try { window.PirateAnalyticsReconcileBunker = reconcileBunker; } catch {}

    // ── Cash monitor ─────────────────────────────────────────────
    // Polls Pinia store for cash changes and logs outgoing transactions
    var lastKnownCash = null;
    var cashPollInterval = null;
    var contribPollInterval = null;

    function getCashFromPinia() {
        try {
            var app = document.querySelector('#app').__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            for (var [k, s] of pinia._s) {
                if (s.user && s.user.cash !== undefined) return s.user.cash;
            }
        } catch {}
        return null;
    }

    function extractCash(data) {
        if (data && data.user && data.user.cash !== undefined) return data.user.cash;
        if (data && data.data && data.data.user && data.data.user.cash !== undefined) return data.data.user.cash;
        if (data && data.data && data.data.cash !== undefined) return data.data.cash;
        return null;
    }

    function startCashMonitor() {
        lastKnownCash = getCashFromPinia();

        cashPollInterval = setInterval(function() {
            var current = getCashFromPinia();
            if (current === null) return;
            if (lastKnownCash === null) { lastKnownCash = current; return; }

            var delta = current - lastKnownCash;
            lastKnownCash = current;

            if (delta < -500) {
                // Cash dropped - check if we have a recent outgoing tx without cost
                var cost = Math.abs(delta);
                try {
                    var txs = dbGet('transactions') || [];
                    var now = Date.now();
                    var found = false;
                    for (var i = 0; i < txs.length; i++) {
                        if (txs[i].direction === 'out' && (now - txs[i].timestamp) < 8000 && !txs[i].cost) {
                            txs[i].cost = cost;
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        txs.unshift({
                            timestamp: now,
                            date: new Date(now).toISOString().split('T')[0],
                            type: 'outgoing',
                            label: 'Outgoing Payment',
                            cost: cost,
                            direction: 'out'
                        });
                        var cutoff = now - (MAX_TX_AGE_DAYS * 86400000);
                        txs = txs.filter(function(t) { return t.timestamp >= cutoff; });
                        if (txs.length > 2000) txs.length = 2000;
                    }
                    dbSet('transactions', txs);
                } catch (e) { if (window.PirateLog) window.PirateLog.warn('PirateAnalytics', 'cashMonitor tx update failed', e); }
            }
        }, 2500);
    }

    function stopCashMonitor() {
        if (cashPollInterval) { clearInterval(cashPollInterval); cashPollInterval = null; }
        if (contribPollInterval) { clearInterval(contribPollInterval); contribPollInterval = null; }
    }

    // Cleanup intervals on page unload to prevent memory leaks
    if (window.PirateCleanup) {
        window.PirateCleanup.register('PirateAnalytics', stopCashMonitor);
    } else {
        window.addEventListener('beforeunload', stopCashMonitor);
    }

    setTimeout(startCashMonitor, 3000);

    // ── Contribution tracking ─────────────────────────────────────
    // Keeps a cached "last known" contribution total, updated every 2 mins.
    // When a departure fires: record the cached value as "before".
    // After departure: fetch new value as "after", delta = after - before.
    var paContribPending = {}; // vesselId -> { before: N, time: T }
    var paCachedContrib = null; // last known contribution total
    var paContribUpdating = false;

    function updateCachedContrib() {
        getPaUserAndAlliance();
        if (!paUserId || !paAllianceId || paContribUpdating) return;
        paContribUpdating = true;
        originalFetch('https://shippingmanager.cc/api/alliance/get-alliance-members', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alliance_id: paAllianceId, last_24h_stats: true })
        }).then(function(r) { return r.json(); }).then(function(d) {
            paContribUpdating = false;
            if (!d || !d.data || !d.data.members) return;
            var me = d.data.members.find(function(m) { return m.user_id === paUserId; });
            if (me !== undefined) paCachedContrib = me ? (me.contribution || 0) : null;
        }).catch(function() { paContribUpdating = false; });
    }

    function fetchContribAfter(vesselId) {
        getPaUserAndAlliance();
        if (!paUserId || !paAllianceId) return;
        originalFetch('https://shippingmanager.cc/api/alliance/get-alliance-members', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alliance_id: paAllianceId, last_24h_stats: true })
        }).then(function(r) { return r.json(); }).then(function(d) {
            if (!d || !d.data || !d.data.members) return;
            var me = d.data.members.find(function(m) { return m.user_id === paUserId; });
            if (!me) return;
            var after = me.contribution || 0;
            // Update cached value
            paCachedContrib = after;
            // Calculate delta for this vessel
            var pending = paContribPending[vesselId];
            if (pending && pending.before !== null && pending.before !== undefined) {
                var delta = after - pending.before;
                if (delta > 0) {
                    try {
                        var raw = localStorage.getItem('pirate:PirateAnalytics:data:departLogs');
                        if (raw) {
                            var logs = JSON.parse(raw);
                            for (var i = 0; i < Math.min(logs.length, 10); i++) {
                                if (logs[i].vesselId === vesselId && !logs[i].myContributionDelta) {
                                    logs[i].myContributionDelta = delta;
                                    localStorage.setItem('pirate:PirateAnalytics:data:departLogs', JSON.stringify(logs));
                                    break;
                                }
                            }
                        }
                    } catch {}
                }
            }
            delete paContribPending[vesselId];
        }).catch(function() {
            delete paContribPending[vesselId];
        });
    }

    // Start updating cached contrib every 2 minutes
    setTimeout(function() {
        getPaUserAndAlliance();
        if (paAllianceId) {
            updateCachedContrib();
            contribPollInterval = setInterval(updateCachedContrib, 120000);
        }
    }, 8000);

    // ── XHR interceptor for outgoing costs ────────────────────────
    // DepartManager owns window.fetch so we use XHR to capture costs
    (function() {
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._pa_url = url ? url.toString() : '';
            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function(body) {
            var url = this._pa_url || '';
            var self = this;

            var isBunkerFuel = url.includes('/bunker/purchase-fuel');
            var isBunkerCO2  = url.includes('/bunker/purchase-co2');
            var isDrydock    = url.includes('/maintenance/do-major-drydock');
            var isMarketing  = url.includes('/marketing-campaign/activate');
            var isRepair     = url.includes('/vessel/repair') || url.includes('/maintenance/repair');
            var isShop       = url.includes('/shop/') && url.includes('/purchase');

            var needsCost = isBunkerFuel || isBunkerCO2 || isDrydock || isMarketing || isRepair || isShop;

            if (needsCost) {
                var cashBefore = getCashFromPinia();
                var stockBefore = (isBunkerFuel || isBunkerCO2) ? paStockKg(isBunkerFuel ? 'fuel' : 'co2') : null;
                var reqBody = body;
                var captureTime = Date.now();

                self.addEventListener('load', function() {
                    try {
                        if (self.status !== 200) return;
                        var data = JSON.parse(self.responseText);

                        // Get cash after from response or Pinia
                        var cashAfter = extractCash(data) || getCashFromPinia();
                        var cost = (cashBefore !== null && cashAfter !== null && cashBefore > cashAfter)
                            ? Math.round(cashBefore - cashAfter) : null;

                        // Bunker: calculate from amount * price as fallback
                        var bodyParsed = {};
                        try { bodyParsed = JSON.parse(reqBody || '{}'); } catch {}

                        if ((isBunkerFuel || isBunkerCO2) && !cost) {
                            var amtKg = bodyParsed.amount || 0;
                            // Try window._paBunkerPrices (set by DepartManager) first
                            var cachedPrice = 0;
                            try {
                                if (window._paBunkerPrices) {
                                    cachedPrice = isBunkerFuel ? (window._paBunkerPrices.fuel || 0) : (window._paBunkerPrices.co2 || 0);
                                }
                            } catch {}
                            // Fallback to localStorage cache
                            if (!cachedPrice) {
                                cachedPrice = parseFloat(localStorage.getItem('pa_price_' + (isBunkerFuel ? 'fuel' : 'co2')) || '0');
                            }
                            if (amtKg > 0 && cachedPrice > 0) cost = Math.round(amtKg * cachedPrice); // 1.0.2: the game's own UI sends TONNES
                        }

                        var label = isBunkerFuel ? 'Fuel Purchase' :
                                    isBunkerCO2  ? 'CO2 Purchase' :
                                    isDrydock    ? 'Drydock Maintenance' :
                                    isMarketing  ? 'Marketing Campaign' :
                                    isRepair     ? 'Vessel Repair' : 'Shop Purchase';

                        var type = isBunkerFuel ? 'bunker_fuel' :
                                   isBunkerCO2  ? 'bunker_co2' :
                                   isDrydock    ? 'drydock' :
                                   isMarketing  ? 'marketing' :
                                   isRepair     ? 'repair' : 'shop';

                        var extra = {};
                        if (isBunkerFuel || isBunkerCO2) {
                            // 1.0.2: the game's UI amount is TONNES; delivered tonnes from the response's stock figure
                            var xComm = isBunkerFuel ? 'fuel' : 'co2';
                            var xAcc = paBunkerAccounting({ orderedTons: Number(bodyParsed.amount) || 0, price: paKnownPrice(xComm), cashCost: cost, preferCash: true,
                                respStockKg: paStockFromResponse(data, xComm), stockBeforeKg: stockBefore,
                                success: !(data && (data.error || (data.data && data.data.success === false))) });
                            extra = xAcc.fields; cost = xAcc.cost;
                        }
                        if (isDrydock) extra.vesselCount = (bodyParsed.vessel_ids || []).length;
                        if (isShop) extra.item = bodyParsed.item || bodyParsed.product || 'Item';

                        // Update lastKnownCash to prevent double-counting in cash monitor
                        if (cashAfter !== null) lastKnownCash = cashAfter;

                        logTransaction(Object.assign({
                            timestamp: captureTime,
                            date: new Date(captureTime).toISOString().split('T')[0],
                            type: type,
                            label: label,
                            cost: cost,
                            direction: 'out'
                        }, extra));

                    } catch {}
                });
            }

            // Cache bunker prices from get-prices XHR
            if (url.includes('/bunker/get-prices')) {
                self.addEventListener('load', function() {
                    try {
                        var d = JSON.parse(self.responseText);
                        if (!d || !d.data) return;
                        var fuelPrice = d.data.discounted_fuel;
                        var co2Price  = d.data.discounted_co2;
                        if ((fuelPrice === undefined || co2Price === undefined) && d.data.prices) {
                            var now = new Date();
                            var h = now.getUTCHours();
                            var slot = (h < 10 ? '0' + h : '' + h) + (now.getUTCMinutes() < 30 ? ':00' : ':30');
                            var found = d.data.prices.find(function(p) { return p.time === slot; }) || d.data.prices[0];
                            if (found) {
                                if (fuelPrice === undefined) fuelPrice = found.fuel_price;
                                if (co2Price  === undefined) co2Price  = found.co2_price;
                            }
                        }
                        if (fuelPrice) localStorage.setItem('pa_price_fuel', fuelPrice);
                        if (co2Price)  localStorage.setItem('pa_price_co2',  co2Price);
                        try { window._paBunkerPrices = { fuel: fuelPrice, co2: co2Price }; } catch {}
                    } catch {}
                });
            }

            // Capture departures via XHR
            var isDepart = url.includes('/route/depart') &&
                           !url.includes('/route/depart-all') &&
                           !url.includes('/route/depart-coop');
            if (isDepart) {
                var departBody = body;
                self.addEventListener('load', function() {
                    try {
                        if (self.status !== 200) return;
                        var data = JSON.parse(self.responseText);
                        if (!data || !data.data || !data.data.depart_info) return;
                        var info = data.data.depart_info;

                        // Get vessel ID from request body
                        var vesselId = null;
                        try { vesselId = JSON.parse(departBody || '{}').user_vessel_id; } catch {}

                        // Look up vessel from Pinia
                        var vessel = null;
                        try {
                            var app = document.querySelector('#app').__vue_app__;
                            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
                            for (var [k, s] of pinia._s) {
                                if (s.userVessels) {
                                    vessel = s.userVessels.find(function(v) { return v.id === vesselId; });
                                    if (vessel) break;
                                }
                            }
                        } catch {}

                        // Calculate utilization
                        var loaded = (info.teu_dry || 0) + (info.teu_refrigerated || 0) +
                                     (info.crude_oil || 0) + (info.fuel || 0);
                        var capacityMax = vessel ? vessel.capacity_max : null;

                        var entry = {
                            timestamp: Date.now(),
                            date: new Date().toISOString().split('T')[0],
                            vesselId: vesselId,
                            vesselName: vessel ? vessel.name : ('Vessel ' + vesselId),
                            vesselType: vessel ? vessel.capacity_type : null,
                            routeOrigin: vessel ? vessel.route_origin : null,
                            routeDestination: vessel ? vessel.route_destination : null,
                            routeDistance: vessel ? vessel.route_distance : null,
                            routeSpeed: vessel ? vessel.route_speed : null,
                            capacityMax: capacityMax,
                            myContributionDelta: null,
                            departResponse: {
                                success: true,
                                income: info.depart_income || 0,
                                harborFee: info.harbor_fee || 0,
                                channelFee: info.channel_payment || 0,
                                guardFee: info.guard_payment || 0,
                                fuelUsed: info.fuel_usage ? info.fuel_usage / 1000 : 0,
                                co2Used: info.co2_emission ? info.co2_emission / 1000 : 0,
                                teuDry: info.teu_dry,
                                teuRef: info.teu_refrigerated,
                                crudeOil: info.crude_oil,
                                fuelCargo: info.fuel
                            }
                        };

                        // Save to our own departure log
                        var existing = [];
                        try {
                            var raw = localStorage.getItem('pirate:PirateAnalytics:data:departLogs');
                            if (raw) existing = JSON.parse(raw);
                        } catch {}
                        existing.unshift(entry);
                        if (existing.length > 5000) existing.length = 5000;
                        localStorage.setItem('pirate:PirateAnalytics:data:departLogs', JSON.stringify(existing));

                        // Also log as income transaction
                        logTransaction({
                            timestamp: entry.timestamp,
                            date: entry.date,
                            type: 'departure_income',
                            label: 'Departure Income',
                            income: entry.departResponse.income,
                            harborFee: entry.departResponse.harborFee,
                            channelFee: entry.departResponse.channelFee,
                            guardFee: entry.departResponse.guardFee,
                            direction: 'in'
                        });
                    } catch(e) {}
                });
            }

            return origSend.apply(this, arguments);
        };
    })();

    // ── Alliance contribution helper ─────────────────────────────
    var paAllianceId = null;
    var paUserId = null;

    function getPaUserAndAlliance() {
        try {
            var app = document.querySelector('#app').__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            for (var [k, s] of pinia._s) {
                if (s.user && s.user.id) paUserId = s.user.id;
                if (s.allianceId) paAllianceId = s.allianceId;
                if (s.alliance && s.alliance.id) paAllianceId = s.alliance.id;
            }
        } catch {}
    }

    async function getMyContrib() {
        try {
            getPaUserAndAlliance();
            if (!paUserId || !paAllianceId) return null;
            var r = await originalFetch('https://shippingmanager.cc/api/alliance/get-alliance-members', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alliance_id: paAllianceId, last_24h_stats: true })
            });
            var d = await r.json();
            if (d && d.data && d.data.members) {
                var me = d.data.members.find(function(m) { return m.user_id === paUserId; });
                return me ? (me.contribution || 0) : null;
            }
        } catch {}
        return null;
    }

    // ── Fetch wrapper - departure capture only ───────────────────
    var originalFetch = window.fetch;
    window.fetch = async function() {
        var args = arguments;
        var url  = (args[0] || '').toString();
        var opts = args[1] || {};
        var paPre = null;   // 1.0.2: stock BEFORE a bunker purchase request (the page store may be updated by the time the response is processed)
        var paLpSnap = null; // 1.0.3: Depart Manager's publication for THIS request (a later purchase overwrites window._dmLastPurchase within the second)
        try { if (url.includes('/bunker/purchase-')) { paPre = { fuel: paStockKg('fuel'), co2: paStockKg('co2') }; paLpSnap = window._dmLastPurchase ? Object.assign({}, window._dmLastPurchase) : null; } } catch {}
        var response = await originalFetch.apply(this, args);

        try {
            // Cache bunker prices from get-prices response
            if (url.includes('/bunker/get-prices')) {
                response.clone().json().then(function(d) {
                    if (!d || !d.data) return;
                    // Try discounted prices first, then find current price slot
                    var fuelPrice = d.data.discounted_fuel;
                    var co2Price  = d.data.discounted_co2;
                    if ((fuelPrice === undefined || co2Price === undefined) && d.data.prices) {
                        var now = new Date();
                        var h = now.getUTCHours();
                        var slot = (h < 10 ? '0' + h : '' + h) + (now.getUTCMinutes() < 30 ? ':00' : ':30');
                        var found = d.data.prices.find(function(p) { return p.time === slot; }) || d.data.prices[0];
                        if (found) {
                            if (fuelPrice === undefined) fuelPrice = found.fuel_price;
                            if (co2Price  === undefined) co2Price  = found.co2_price;
                        }
                    }
                    if (fuelPrice) localStorage.setItem('pa_price_fuel', fuelPrice);
                    if (co2Price)  localStorage.setItem('pa_price_co2',  co2Price);
                    try { window._paBunkerPrices = { fuel: fuelPrice, co2: co2Price }; } catch {}
                }).catch(function(){});
            }

            // Outgoing costs
            var isBF = url.includes('/bunker/purchase-fuel');
            var iBC  = url.includes('/bunker/purchase-co2');
            var isDK = url.includes('/maintenance/do-major-drydock');
            var isMK = url.includes('/marketing-campaign/activate');

            if (isBF || iBC || isDK || isMK) {
                var cashBefore2 = getCashFromPinia();
                var stockBefore2 = (isBF || iBC) ? (paPre ? paPre[isBF ? 'fuel' : 'co2'] : paStockKg(isBF ? 'fuel' : 'co2')) : null;
                var fetchTime = Date.now();
                response.clone().json().then(function(data) {
                    var cashAfter2 = extractCash(data) || getCashFromPinia();
                    var cost2 = null;
                    var body2 = {};
                    try { body2 = JSON.parse(opts.body || '{}'); } catch {}
                    var bunkerExtra = null;
                    if (isBF || iBC) {
                        // 1.0.2: unit-aware request, delivered tonnes and verified charge (Depart Manager result when available)
                        var bComm = isBF ? 'fuel' : 'co2';
                        var bReq = paBunkerRequest(body2, bComm, paLpSnap);
                        var bPrice = bReq.price || paKnownPrice(bComm);
                        var bDm = null;
                        try { bDm = bReq.id && window._dmPurchaseResults ? window._dmPurchaseResults[bReq.id] : null; } catch {}
                        var bCash = (cashBefore2 !== null && cashAfter2 !== null && cashBefore2 > cashAfter2) ? Math.round(cashBefore2 - cashAfter2) : null;
                        var bAcc = paBunkerAccounting({ orderedTons: bReq.orderedTons, price: bPrice, dm: bDm, respStockKg: paStockFromResponse(data, bComm), stockBeforeKg: stockBefore2,
                            cashCost: bCash, success: !(data && (data.error || (data.data && data.data.success === false))) });
                        cost2 = bAcc.cost; bunkerExtra = bAcc.fields;
                        if (bReq.id) { bunkerExtra.dmPurchaseId = bReq.id; if (!bDm) bunkerExtra.awaitingDm = true; }
                        bunkerExtra.requestUnit = bReq.unit;
                    }
                    if (cost2 === null && cashBefore2 !== null && cashAfter2 !== null && cashBefore2 > cashAfter2) {
                        cost2 = Math.round(cashBefore2 - cashAfter2); // last resort only (drydock/marketing keep this path)
                    }
                    if (cashAfter2 !== null) lastKnownCash = cashAfter2;
                    var label = isBF ? 'Fuel Purchase' : iBC ? 'CO2 Purchase' : isDK ? 'Drydock Maintenance' : 'Marketing Campaign';
                    var type  = isBF ? 'bunker_fuel' : iBC ? 'bunker_co2' : isDK ? 'drydock' : 'marketing';
                    var extra = {};
                    if (bunkerExtra) extra = bunkerExtra;
                    if (isDK) extra.vesselCount = (body2.vessel_ids || []).length;
                    logTransaction(Object.assign({ timestamp: fetchTime, date: new Date(fetchTime).toISOString().split('T')[0], type: type, label: label, cost: cost2, direction: 'out' }, extra));
                }).catch(function(){});
            }

            // Departure capture
            if (url.includes('/route/depart') && !url.includes('depart-all') && !url.includes('depart-coop') && response.ok) {
                response.clone().json().then(function(data) {
                    if (!data || !data.data || !data.data.depart_info) return;
                    var info = data.data.depart_info;
                    var vesselId = null;
                    try { vesselId = JSON.parse(opts.body || '{}').user_vessel_id; } catch {}
                    var vessel = null;
                    try {
                        var app = document.querySelector('#app').__vue_app__;
                        var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
                        for (var [k, s] of pinia._s) {
                            if (s.userVessels) { vessel = s.userVessels.find(function(v) { return v.id === vesselId; }); if (vessel) break; }
                        }
                    } catch {}
                    var entry = {
                        timestamp: Date.now(),
                        date: new Date().toISOString().split('T')[0],
                        vesselId: vesselId,
                        vesselName: vessel ? vessel.name : ('Vessel ' + vesselId),
                        vesselType: vessel ? vessel.capacity_type : null,
                        routeOrigin: vessel ? vessel.route_origin : null,
                        routeDestination: vessel ? vessel.route_destination : null,
                        routeDistance: vessel ? vessel.route_distance : null,
                        routeSpeed: vessel ? vessel.route_speed : null,
                        capacityMax: vessel ? vessel.capacity_max : null,
                        myContributionDelta: null,
                        departResponse: {
                            success: true,
                            income: info.depart_income || 0,
                            harborFee: info.harbor_fee || 0,
                            channelFee: info.channel_payment || 0,
                            guardFee: info.guard_payment || 0,
                            fuelUsed: info.fuel_usage ? info.fuel_usage / 1000 : 0,
                            co2Used: info.co2_emission ? info.co2_emission / 1000 : 0,
                            teuDry: info.teu_dry,
                            teuRef: info.teu_refrigerated,
                            crudeOil: info.crude_oil,
                            fuelCargo: info.fuel
                        }
                    };
                    var existing = [];
                    try { var r = localStorage.getItem('pirate:PirateAnalytics:data:departLogs'); if (r) existing = JSON.parse(r); } catch {}
                    existing.unshift(entry);
                    if (existing.length > 5000) existing.length = 5000;
                    localStorage.setItem('pirate:PirateAnalytics:data:departLogs', JSON.stringify(existing));
                    logTransaction({ timestamp: entry.timestamp, date: entry.date, type: 'departure_income', label: 'Departure Income', income: entry.departResponse.income, harborFee: entry.departResponse.harborFee, channelFee: entry.departResponse.channelFee, guardFee: entry.departResponse.guardFee, direction: 'in' });
                    // Store cached contrib as "before", then fetch "after" in 3s
                    if (vesselId && paCachedContrib !== null) {
                        paContribPending[vesselId] = { before: paCachedContrib, time: Date.now() };
                        setTimeout(function() { fetchContribAfter(vesselId); }, 3000);
                    }
                }).catch(function() {});
            }
        } catch {}

        return response;
    };

    // ── Read departure logs ───────────────────────────────────────
    // Reads from our own XHR-captured logs + DepartManager logs, deduped
    async function getDepartLogs() {
        var all = [];
        // Our own logs (captured via XHR interceptor)
        try {
            var raw1 = localStorage.getItem('pirate:PirateAnalytics:data:departLogs');
            if (raw1) all = all.concat(JSON.parse(raw1));
        } catch {}
        // DepartManager logs (from auto-depart)
        try {
            var raw2 = localStorage.getItem('pirate:DepartManager:data:departLogs');
            if (raw2) all = all.concat(JSON.parse(raw2));
        } catch {}
        // Deduplicate by vesselId + date (same vessel can only depart once per minute)
        var seen = new Set();
        return all.filter(function(l) {
            var minute = Math.floor((l.timestamp || 0) / 60000);
            var k = (l.vesselId || l.vesselName || '') + '_' + minute;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        }).sort(function(a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
    }

    // ── Fetch current vessel data from API ────────────────────────
    async function fetchVessels() {
        try {
            var r = await originalFetch(API_BASE + '/vessel/get-all-user-vessels', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            var d = await r.json();
            return (d && d.data && d.data.user_vessels) ? d.data.user_vessels : [];
        } catch { return []; }
    }

    // ── Fetch user data (cash, points) ────────────────────────────
    async function fetchUserData() {
        try {
            var r = await originalFetch(API_BASE + '/user/get-user-settings', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            var d = await r.json();
            return (d && d.data) ? d.data : null;
        } catch { return null; }
    }

    // ── Number formatters ─────────────────────────────────────────
    function fmt$(n) {
        if (n === null || n === undefined) return '-';
        if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
        return '$' + Math.round(n).toLocaleString();
    }
    function fmtN(n, dec) {
        if (n === null || n === undefined || isNaN(n)) return '-';
        return Number(n).toFixed(dec || 0);
    }
    function fmtDate(ts) {
        return new Date(ts).toLocaleDateString() + ' ' + new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    }

    // ── Build fleet analytics from departure logs ─────────────────
    function buildFleetStats(logs) {
        var vesselMap = {};

        logs.forEach(function(log) {
            if (!log.vesselId || !log.departResponse || !log.departResponse.success) return;
            var id = log.vesselId;
            if (!vesselMap[id]) {
                vesselMap[id] = {
                    vesselId: id,
                    vesselName: log.vesselName || 'Unknown',
                    vesselType: log.vesselType || '',
                    primaryRoute: (log.routeOrigin || '') + ' <> ' + (log.routeDestination || ''),
                    trips: 0,
                    totalRevenue: 0,
                    totalHarborFee: 0,
                    totalChannelFee: 0,
                    totalGuardFee: 0,
                    totalFuelTons: 0,
                    totalCo2Tons: 0,
                    totalContrib: 0,
                    totalDistance: 0,
                    speeds: [],
                    utilizations: []
                };
            }
            var v = vesselMap[id];
            var dr = log.departResponse;
            v.trips++;
            v.totalRevenue    += dr.income      || 0;
            v.totalHarborFee  += dr.harborFee   || 0;
            v.totalChannelFee += dr.channelFee  || 0;
            v.totalGuardFee   += dr.guardFee    || 0;
            v.totalFuelTons   += dr.fuelUsed    || 0;
            v.totalCo2Tons    += dr.co2Used     || 0;
            v.totalContrib    += log.myContributionDelta || 0;
            v.totalDistance   += log.routeDistance || 0;
            if (log.routeSpeed) v.speeds.push(log.routeSpeed);
            // Utilization - capacity_max is always {dry,refrigerated} or {fuel,crude_oil}
            var capMax = log.capacityMax;
            if (capMax && typeof capMax === 'object') {
                var capNum, loaded;
                if (log.vesselType === 'tanker') {
                    // Tanker: capacity in barrels /74 = TEU equiv
                    capNum = ((capMax.fuel || 0) + (capMax.crude_oil || 0)) / 74;
                    loaded = ((dr.crudeOil || 0) + (dr.fuelCargo || 0)) / 74;
                } else {
                    // Cargo: capacity and loaded in TEU
                    capNum = (capMax.dry || 0) + (capMax.refrigerated || 0);
                    loaded = (dr.teuDry || 0) + (dr.teuRef || 0);
                }
                if (capNum > 0 && loaded > 0) {
                    v.utilizations.push(Math.min(100, (loaded / capNum) * 100));
                }
            }
        });

        return Object.values(vesselMap).map(function(v) {
            var net = v.totalRevenue - v.totalHarborFee - v.totalChannelFee - v.totalGuardFee;
            var avgUtil = v.utilizations.length ? v.utilizations.reduce(function(a,b){return a+b;},0) / v.utilizations.length : null;
            var avgSpeed = v.speeds.length ? v.speeds.reduce(function(a,b){return a+b;},0) / v.speeds.length : null;
            return Object.assign(v, {
                avgRevenue:  v.trips ? v.totalRevenue / v.trips : 0,
                avgContrib:  v.trips ? v.totalContrib / v.trips : 0,
                netRevenue:  net,
                avgNet:      v.trips ? net / v.trips : 0,
                avgUtil:     avgUtil,
                avgSpeed:    avgSpeed,
                avgPerNm:    v.totalDistance ? v.totalRevenue / v.totalDistance : null
            });
        }).sort(function(a,b) { return b.totalRevenue - a.totalRevenue; });
    }

    // ── Build route profitability ─────────────────────────────────
    function buildRouteStats(logs) {
        var routeMap = {};
        logs.forEach(function(log) {
            if (!log.departResponse || !log.departResponse.success) return;
            var key = (log.routeOrigin || '?') + ' <> ' + (log.routeDestination || '?');
            if (!routeMap[key]) {
                routeMap[key] = { route: key, trips: 0, totalRevenue: 0, totalContrib: 0, vessels: new Set(), totalDistance: 0 };
            }
            var r = routeMap[key];
            r.trips++;
            r.totalRevenue += log.departResponse.income || 0;
            r.totalContrib += log.myContributionDelta || 0;
            r.vessels.add(log.vesselName);
            r.totalDistance += log.routeDistance || 0;
        });
        return Object.values(routeMap).map(function(r) {
            return Object.assign(r, {
                vesselCount: r.vessels.size,
                avgRevenue: r.trips ? r.totalRevenue / r.trips : 0,
                avgContrib: r.trips ? r.totalContrib / r.trips : 0,
                avgPerNm: r.totalDistance ? r.totalRevenue / r.totalDistance : null
            });
        }).sort(function(a,b) { return b.totalRevenue - a.totalRevenue; });
    }

    // ── Build trends (daily buckets) ──────────────────────────────
    function buildTrends(logs, txs, days) {
        days = days || 30;
        var cutoff = Date.now() - (days * 86400000);
        var dailyMap = {};

        function getDay(ts) { return new Date(ts).toISOString().split('T')[0]; }
        function ensureDay(day) {
            if (!dailyMap[day]) dailyMap[day] = { date: day, income: 0, outgoing: 0, contrib: 0, trips: 0 };
        }

        logs.filter(function(l) { return l.timestamp >= cutoff && l.departResponse && l.departResponse.success; })
            .forEach(function(l) {
                var day = getDay(l.timestamp);
                ensureDay(day);
                dailyMap[day].income  += l.departResponse.income || 0;
                dailyMap[day].contrib += l.myContributionDelta || 0;
                dailyMap[day].trips++;
            });

        txs.filter(function(t) { return t.timestamp >= cutoff && t.direction === 'out'; })
            .forEach(function(t) {
                var day = getDay(t.timestamp);
                ensureDay(day);
                dailyMap[day].outgoing += t.cost || 0;
            });

        return Object.values(dailyMap).sort(function(a,b) { return a.date.localeCompare(b.date); });
    }

    // ── Export helpers ────────────────────────────────────────────
    function downloadFile(content, filename, type) {
        var blob = new Blob([content], { type: type });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    }

    function exportFleetCSV(stats) {
        var headers = ['Vessel','Type','Route','Trips','Total Revenue','Avg/Trip','Net Revenue','Avg Net/Trip','Total Contrib','Avg Contrib/Trip','Avg Utilization %','Avg Speed (kn)','Total Fuel (t)','Total CO2 (t)'];
        var rows = stats.map(function(v) {
            return [
                v.vesselName, v.vesselType, v.primaryRoute, v.trips,
                v.totalRevenue.toFixed(0), v.avgRevenue.toFixed(0),
                v.netRevenue.toFixed(0), v.avgNet.toFixed(0),
                v.totalContrib.toFixed(0), v.avgContrib.toFixed(2),
                v.avgUtil !== null ? v.avgUtil.toFixed(1) : '',
                v.avgSpeed !== null ? v.avgSpeed.toFixed(1) : '',
                v.totalFuelTons.toFixed(1), v.totalCo2Tons.toFixed(1)
            ].join(',');
        });
        return [headers.join(',')].concat(rows).join('\n');
    }

    function exportTransactionsCSV(txs) {
        var headers = ['Date','Type','Label','Direction','Amount/Income','Cost','Details'];
        var rows = txs.map(function(t) {
            var detail = '';
            if (t.amountTons) detail = t.amountTons.toFixed(1) + 't';
            if (t.orderedTons !== undefined && t.amountTons !== undefined && Math.abs(t.orderedTons - t.amountTons) > 0.05) detail += ' ordered:' + t.orderedTons.toFixed(1) + 't';
            if (t.failed) detail += ' FAILED';
            if (t.discrepancy && t.discrepancy.length) detail += ' ' + t.discrepancy.join('|');
            if (t.item) detail = t.item;
            if (t.income) detail = 'Income:' + t.income + ' HarborFee:' + (t.harborFee||0) + ' ChannelFee:' + (t.channelFee||0);
            return [t.date, t.type, t.label, t.direction, t.income || '', t.cost || '', detail].join(',');
        });
        return [headers.join(',')].concat(rows).join('\n');
    }

    function exportAllJSON(fleetStats, routeStats, txs, trends) {
        return JSON.stringify({
            exportDate: new Date().toISOString(),
            fleet: fleetStats,
            routes: routeStats,
            transactions: txs,
            trends: trends
        }, null, 2);
    }

    // ── Modal ─────────────────────────────────────────────────────
    var isOpen = false;

    function openDashboard() {
        if (isOpen) return;
        isOpen = true;

        var overlay = document.createElement('div');
        overlay.id = 'pa-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999990;display:flex;align-items:flex-start;justify-content:center;padding-top:40px;';

        var modal = document.createElement('div');
        modal.id = 'pa-modal';
        modal.style.cssText = 'width:90vw;max-width:1200px;height:80vh;background:#0d1117;border:1px solid #1e2d42;border-radius:8px;display:flex;flex-direction:column;font-family:Inter,-apple-system,sans-serif;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.8);';

        modal.innerHTML = [
            '<div style="display:flex;align-items:center;padding:12px 16px;background:#111820;border-bottom:1px solid #1e2d42;gap:10px;">',
              '<span style="font-family:\'Bebas Neue\',Impact,sans-serif;font-size:20px;letter-spacing:2px;color:#e8912a;">🏴‍☠️ PIRATE ANALYTICS</span>',
              '<div style="display:flex;gap:2px;margin-left:8px;" id="pa-tabs">',
                '<button class="pa-tab pa-tab-active" data-tab="fleet">Fleet Overview</button>',
                '<button class="pa-tab" data-tab="routes">Route Profitability</button>',
                '<button class="pa-tab" data-tab="transactions">Transactions</button>',
                '<button class="pa-tab" data-tab="trends">Trends</button>',
              '</div>',
              '<div style="flex:1;"></div>',
              '<button id="pa-export-csv" style="padding:5px 12px;background:#1e2d42;border:1px solid #253347;color:#e2e8f0;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;">⬇ CSV</button>',
              '<button id="pa-export-json" style="padding:5px 12px;background:#1e2d42;border:1px solid #253347;color:#e2e8f0;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;">⬇ JSON</button>',
              '<button id="pa-close" style="padding:5px 12px;background:transparent;border:none;color:#7a90a8;cursor:pointer;font-size:18px;">✕</button>',
            '</div>',
            '<div id="pa-content" style="flex:1;overflow:auto;padding:0;"></div>'
        ].join('');

        // Inject CSS
        var style = document.createElement('style');
        style.textContent = [
            '.pa-tab{padding:6px 14px;border:none;background:transparent;color:#7a90a8;cursor:pointer;font-size:12px;font-weight:600;border-bottom:2px solid transparent;font-family:inherit;}',
            '.pa-tab:hover{color:#e2e8f0;}',
            '.pa-tab-active{color:#e8912a!important;border-bottom-color:#e8912a!important;}',
            '#pa-modal table{width:100%;border-collapse:collapse;font-size:11px;}',
            '#pa-modal thead{position:sticky;top:0;z-index:1;}',
            '#pa-modal th{background:#111820;color:#7a90a8;padding:6px 8px;text-align:right;border-bottom:1px solid #1e2d42;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;cursor:pointer;}',
            '#pa-modal th:hover{color:#e8912a;}',
            '#pa-modal th.left,#pa-modal td.left{text-align:left;}',
            '#pa-modal td{padding:5px 8px;border-bottom:1px solid #161d27;color:#e2e8f0;text-align:right;white-space:nowrap;}',
            '#pa-modal tr:hover td{background:#1c2535;}',
            '.pa-green{color:#2dd4a0!important;}.pa-red{color:#f04f5a!important;}.pa-gold{color:#e8912a!important;}.pa-muted{color:#7a90a8!important;}',
            '#pa-modal ::-webkit-scrollbar{width:5px;height:5px;}',
            '#pa-modal ::-webkit-scrollbar-track{background:transparent;}',
            '#pa-modal ::-webkit-scrollbar-thumb{background:#253347;border-radius:3px;}',
            '.pa-summary-bar{display:flex;gap:12px;padding:12px 16px;background:#080b10;border-bottom:1px solid #1e2d42;flex-wrap:wrap;}',
            '.pa-stat{background:#111820;border:1px solid #1e2d42;border-radius:6px;padding:8px 14px;min-width:120px;}',
            '.pa-stat-lbl{font-size:10px;color:#7a90a8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}',
            '.pa-stat-val{font-size:16px;font-weight:700;color:#e2e8f0;}',
            '.pa-tx-in{color:#2dd4a0;}.pa-tx-out{color:#f04f5a;}',
            '.pa-loading{display:flex;align-items:center;justify-content:center;height:100%;color:#7a90a8;font-size:14px;}',
            '.pa-trend-bar{display:inline-block;height:14px;background:#e8912a;border-radius:2px;min-width:2px;}',
            '.pa-trend-bar.outgoing{background:#f04f5a;}',
            '.pa-trend-bar.contrib{background:#2dd4a0;}'
        ].join('');
        document.head.appendChild(style);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // State
        var currentTab  = 'fleet';
        var fleetStats  = [];
        var routeStats  = [];
        var txs         = [];
        var trends30    = [];
        var trends7     = [];
        var sortKey     = 'totalRevenue';
        var sortDir     = -1;
        var txFilter    = 'all';
        var trendDays   = 30;
        var loaded      = false;

        function showLoading() {
            document.getElementById('pa-content').innerHTML = '<div class="pa-loading">Loading data...</div>';
        }

        async function loadData() {
            showLoading();
            var logs = await getDepartLogs();
            txs      = dbGet('transactions') || [];
            fleetStats = buildFleetStats(logs);
            routeStats = buildRouteStats(logs);
            trends30   = buildTrends(logs, txs, 30);
            trends7    = buildTrends(logs, txs, 7);
            loaded = true;
            renderTab();
        }

        function renderTab() {
            if (!loaded) return;
            if (currentTab === 'fleet')        renderFleet();
            else if (currentTab === 'routes')   renderRoutes();
            else if (currentTab === 'transactions') renderTransactions();
            else if (currentTab === 'trends')   renderTrends();
        }

        // ── Fleet Overview ────────────────────────────────────────
        function renderFleet() {
            var sorted = fleetStats.slice().sort(function(a,b) {
                var va = a[sortKey], vb = b[sortKey];
                if (va === null || va === undefined) va = -Infinity;
                if (vb === null || vb === undefined) vb = -Infinity;
                return sortDir * (vb - va);
            });

            var totalRevenue = fleetStats.reduce(function(s,v){return s+v.totalRevenue;},0);
            var totalTrips   = fleetStats.reduce(function(s,v){return s+v.trips;},0);
            var totalContrib = fleetStats.reduce(function(s,v){return s+v.totalContrib;},0);
            var activeVessels = fleetStats.length;

            var cols = [
                { key:'vesselName',   label:'Vessel',     left:true  },
                { key:'vesselType',   label:'Type',       left:true  },
                { key:'trips',        label:'Trips'                   },
                { key:'totalRevenue', label:'Revenue'                 },
                { key:'avgRevenue',   label:'Avg/Trip'                },
                { key:'netRevenue',   label:'Net Revenue'             },
                { key:'totalContrib', label:'Contrib'                 },
                { key:'avgContrib',   label:'Avg Contrib'             },
                { key:'avgUtil',      label:'Util %'                  },
                { key:'avgSpeed',     label:'Avg kn'                  },
                { key:'avgPerNm',     label:'$/nm'                    },
                { key:'totalFuelTons',label:'Fuel (t)'               },
                { key:'primaryRoute', label:'Primary Route', left:true},
            ];

            var headers = cols.map(function(c) {
                var active = sortKey === c.key ? ' pa-gold' : '';
                var arrow  = sortKey === c.key ? (sortDir === -1 ? ' ↓' : ' ↑') : '';
                return '<th class="'+(c.left?'left':'')+active+'" data-key="'+c.key+'">' + c.label + arrow + '</th>';
            }).join('');

            var rows = sorted.map(function(v) {
                return '<tr>' +
                    '<td class="left" style="font-weight:600;">' + v.vesselName + '</td>' +
                    '<td class="left pa-muted">' + v.vesselType + '</td>' +
                    '<td>' + v.trips + '</td>' +
                    '<td class="pa-green">' + fmt$(v.totalRevenue) + '</td>' +
                    '<td>' + fmt$(v.avgRevenue) + '</td>' +
                    '<td class="pa-green">' + fmt$(v.netRevenue) + '</td>' +
                    '<td class="pa-gold">' + fmtN(v.totalContrib) + '</td>' +
                    '<td>' + fmtN(v.avgContrib, 1) + '</td>' +
                    '<td>' + (v.avgUtil !== null ? fmtN(v.avgUtil,1)+'%' : '-') + '</td>' +
                    '<td class="pa-muted">' + (v.avgSpeed !== null ? fmtN(v.avgSpeed,1) : '-') + '</td>' +
                    '<td class="pa-muted">' + (v.avgPerNm !== null ? fmt$(v.avgPerNm) : '-') + '</td>' +
                    '<td class="pa-muted">' + fmtN(v.totalFuelTons,1) + '</td>' +
                    '<td class="left pa-muted" style="font-size:10px;">' + v.primaryRoute + '</td>' +
                    '</tr>';
            }).join('');

            document.getElementById('pa-content').innerHTML =
                '<div class="pa-summary-bar">' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Vessels Tracked</div><div class="pa-stat-val">' + activeVessels + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Total Revenue</div><div class="pa-stat-val pa-green">' + fmt$(totalRevenue) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Total Trips</div><div class="pa-stat-val">' + totalTrips + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Total Contrib</div><div class="pa-stat-val pa-gold">' + fmtN(totalContrib) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Avg/Trip</div><div class="pa-stat-val">' + fmt$(totalTrips ? totalRevenue/totalTrips : 0) + '</div></div>' +
                '</div>' +
                '<div style="overflow:auto;height:calc(100% - 70px);">' +
                  '<table><thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table>' +
                '</div>';

            // Sort on header click
            document.getElementById('pa-content').querySelectorAll('th[data-key]').forEach(function(th) {
                th.style.cursor = 'pointer';
                th.addEventListener('click', function() {
                    var key = th.dataset.key;
                    if (sortKey === key) sortDir *= -1;
                    else { sortKey = key; sortDir = -1; }
                    renderFleet();
                });
            });
        }

        // ── Route Profitability ───────────────────────────────────
        function renderRoutes() {
            var rows = routeStats.map(function(r) {
                return '<tr>' +
                    '<td class="left" style="font-weight:600;">' + r.route + '</td>' +
                    '<td>' + r.vesselCount + '</td>' +
                    '<td>' + r.trips + '</td>' +
                    '<td class="pa-green">' + fmt$(r.totalRevenue) + '</td>' +
                    '<td>' + fmt$(r.avgRevenue) + '</td>' +
                    '<td class="pa-gold">' + fmtN(r.totalContrib) + '</td>' +
                    '<td>' + fmtN(r.avgContrib, 1) + '</td>' +
                    '<td class="pa-muted">' + (r.avgPerNm !== null ? fmt$(r.avgPerNm) : '-') + '</td>' +
                    '</tr>';
            }).join('');

            document.getElementById('pa-content').innerHTML =
                '<div style="overflow:auto;height:100%;">' +
                '<table><thead><tr>' +
                '<th class="left">Route</th><th>Vessels</th><th>Trips</th>' +
                '<th>Total Revenue</th><th>Avg/Trip</th><th>Total Contrib</th><th>Avg Contrib</th><th>$/nm</th>' +
                '</tr></thead><tbody>' + rows + '</tbody></table></div>';
        }

        // ── Transactions ──────────────────────────────────────────
        function renderTransactions() {
            var filtered = txFilter === 'all'  ? txs :
                           txFilter === 'in'   ? txs.filter(function(t){return t.direction==='in';}) :
                           txFilter === 'out'  ? txs.filter(function(t){return t.direction==='out';}) :
                           txs.filter(function(t){return t.type===txFilter;});

            var totalIn  = txs.filter(function(t){return t.direction==='in';}).reduce(function(s,t){return s+(t.income||0);},0);
            var totalOut = txs.filter(function(t){return t.direction==='out';}).reduce(function(s,t){return s+(t.cost||0);},0);
            var net = totalIn - totalOut;

            // 1.0.2: bunker purchases whose delivery or charge differs from the order
            var bunkerDisc = txs.filter(function(t) { return t.discrepancy && t.discrepancy.length && !t.failed; });
            var bunkerExtraCost = bunkerDisc.reduce(function(sum, t) { return sum + ((t.cost || 0) - (t.costOrdered || 0)); }, 0);
            var bunkerFailed = txs.filter(function(t) { return t.failed; }).length;
            var bunkerBanner = (bunkerDisc.length || bunkerFailed)
                ? '<div style="padding:6px 16px;background:#3a1a1a;color:#ffb4b4;font-size:11px;border-bottom:1px solid #5a2a2a;">Bunker discrepancies: ' + bunkerDisc.length +
                  ' purchase(s) delivered/charged differently from the order (' + (bunkerExtraCost >= 0 ? '+' : '-') + fmt$(Math.abs(bunkerExtraCost)) + ' vs ordered)' +
                  (bunkerFailed ? '; ' + bunkerFailed + ' refused by the game (cost 0)' : '') + '. Costs below are the verified charges.</div>' : '';

            var filterBtns = ['all','in','out','bunker_fuel','bunker_co2','drydock','repair','shop','marketing'].map(function(f) {
                var labels = {all:'All',in:'Income',out:'Outgoing',bunker_fuel:'Fuel',bunker_co2:'CO2',drydock:'Drydock',repair:'Repair',shop:'Shop',marketing:'Marketing'};
                var active = txFilter === f ? 'background:#253347;color:#e2e8f0;' : '';
                return '<button data-filter="'+f+'" style="padding:4px 10px;border:1px solid #253347;border-radius:4px;background:transparent;'+active+'color:#7a90a8;cursor:pointer;font-size:11px;font-family:inherit;">'+labels[f]+'</button>';
            }).join('');

            var rows = filtered.slice(0, 500).map(function(t) {
                var amtIn  = t.income ? '<span class="pa-tx-in">+' + fmt$(t.income) + '</span>' : '';
                var amtOut = t.cost   ? '<span class="pa-tx-out">-' + fmt$(t.cost)   + '</span>' : '';
                var detail = '';
                if (t.harborFee)   detail += 'Harbor: ' + fmt$(t.harborFee) + ' ';
                if (t.channelFee)  detail += 'Channel: ' + fmt$(t.channelFee) + ' ';
                if (t.guardFee)    detail += 'Guards: ' + fmt$(t.guardFee) + ' ';
                if (t.amountTons)  detail += fmtN(t.amountTons,1) + 't @ ' + (t.cost && t.amountTons ? fmt$(t.cost / t.amountTons) + '/t' : '?/t') + ' ';
                if (t.orderedTons !== undefined && t.amountTons !== undefined && Math.abs(t.orderedTons - t.amountTons) > 0.05) detail += '(ordered ' + fmtN(t.orderedTons,1) + 't) ';
                if (t.failed) detail += '[REFUSED - nothing bought] ';
                else if (t.discrepancy && t.discrepancy.length) detail += '[! ' + t.discrepancy.join(', ') + '] ';
                if (t.awaitingDm) detail += '(awaiting Depart Manager verification) ';
                if (t.vesselCount) detail += t.vesselCount + ' vessel(s)';
                if (t.item)        detail += t.item;
                return '<tr>' +
                    '<td class="left pa-muted">' + fmtDate(t.timestamp) + '</td>' +
                    '<td class="left">' + (t.label || t.type) + '</td>' +
                    '<td>' + (amtIn || amtOut) + '</td>' +
                    '<td class="left pa-muted" style="font-size:10px;">' + detail + '</td>' +
                    '</tr>';
            }).join('');

            document.getElementById('pa-content').innerHTML =
                '<div class="pa-summary-bar">' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Total Income</div><div class="pa-stat-val pa-green">' + fmt$(totalIn) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Total Outgoing</div><div class="pa-stat-val pa-red">' + fmt$(totalOut) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Net</div><div class="pa-stat-val '+(net>=0?'pa-green':'pa-red')+'">' + fmt$(net) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Transactions</div><div class="pa-stat-val">' + txs.length + '</div></div>' +
                '</div>' +
                bunkerBanner +
                '<div style="padding:8px 16px;display:flex;gap:6px;border-bottom:1px solid #1e2d42;background:#080b10;">' + filterBtns + '</div>' +
                '<div style="overflow:auto;height:calc(100% - 120px);">' +
                '<table><thead><tr><th class="left">Date</th><th class="left">Type</th><th>Amount</th><th class="left">Detail</th></tr></thead>' +
                '<tbody>' + rows + '</tbody></table></div>';

            document.getElementById('pa-content').querySelectorAll('[data-filter]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    txFilter = btn.dataset.filter;
                    renderTransactions();
                });
            });
        }

        // ── Trends ────────────────────────────────────────────────
        function renderTrends() {
            var data = trendDays === 7 ? trends7 : trends30;
            var maxIncome  = Math.max.apply(null, data.map(function(d){return d.income;})) || 1;
            var maxContrib = Math.max.apply(null, data.map(function(d){return d.contrib;})) || 1;
            var maxOut     = Math.max.apply(null, data.map(function(d){return d.outgoing;})) || 1;
            var maxBar     = Math.max(maxIncome, maxOut);

            var totalIncome  = data.reduce(function(s,d){return s+d.income;},0);
            var totalOut     = data.reduce(function(s,d){return s+d.outgoing;},0);
            var totalContrib = data.reduce(function(s,d){return s+d.contrib;},0);
            var totalTrips   = data.reduce(function(s,d){return s+d.trips;},0);

            var rows = data.map(function(d) {
                var incW = maxBar > 0 ? (d.income / maxBar * 150) : 0;
                var outW = maxBar > 0 ? (d.outgoing / maxBar * 150) : 0;
                var cntW = maxContrib > 0 ? (d.contrib / maxContrib * 80) : 0;
                return '<tr>' +
                    '<td class="left">' + d.date + '</td>' +
                    '<td>' + d.trips + '</td>' +
                    '<td class="pa-green">' + fmt$(d.income) +
                      '<br><span class="pa-trend-bar" style="width:'+incW.toFixed(0)+'px"></span>' +
                    '</td>' +
                    '<td class="pa-red">' + (d.outgoing > 0 ? fmt$(d.outgoing) : '-') +
                      (d.outgoing > 0 ? '<br><span class="pa-trend-bar outgoing" style="width:'+outW.toFixed(0)+'px"></span>' : '') +
                    '</td>' +
                    '<td class="pa-gold">' + (d.contrib > 0 ? fmtN(d.contrib) : '-') +
                      (d.contrib > 0 ? '<br><span class="pa-trend-bar contrib" style="width:'+cntW.toFixed(0)+'px"></span>' : '') +
                    '</td>' +
                    '<td class="pa-muted">' + fmt$(d.income - d.outgoing) + '</td>' +
                    '</tr>';
            }).join('');

            document.getElementById('pa-content').innerHTML =
                '<div class="pa-summary-bar">' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Period Income</div><div class="pa-stat-val pa-green">' + fmt$(totalIncome) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Period Outgoing</div><div class="pa-stat-val pa-red">' + fmt$(totalOut) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Net Profit</div><div class="pa-stat-val '+(totalIncome-totalOut>=0?'pa-green':'pa-red')+'">' + fmt$(totalIncome-totalOut) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Contrib</div><div class="pa-stat-val pa-gold">' + fmtN(totalContrib) + '</div></div>' +
                  '<div class="pa-stat"><div class="pa-stat-lbl">Trips</div><div class="pa-stat-val">' + totalTrips + '</div></div>' +
                  '<div style="display:flex;gap:6px;align-items:center;margin-left:auto;">' +
                    '<button id="pa-trend-7" style="padding:4px 10px;border:1px solid #253347;border-radius:4px;background:'+(trendDays===7?'#253347':'transparent')+';color:'+(trendDays===7?'#e2e8f0':'#7a90a8')+';cursor:pointer;font-size:11px;font-family:inherit;">7 days</button>' +
                    '<button id="pa-trend-30" style="padding:4px 10px;border:1px solid #253347;border-radius:4px;background:'+(trendDays===30?'#253347':'transparent')+';color:'+(trendDays===30?'#e2e8f0':'#7a90a8')+';cursor:pointer;font-size:11px;font-family:inherit;">30 days</button>' +
                  '</div>' +
                '</div>' +
                '<div style="overflow:auto;height:calc(100% - 70px);">' +
                '<table><thead><tr><th class="left">Date</th><th>Trips</th><th>Income</th><th>Outgoing</th><th>Contrib</th><th>Net</th></tr></thead>' +
                '<tbody>' + rows + '</tbody></table></div>';

            document.getElementById('pa-trend-7').addEventListener('click', function() { trendDays = 7; renderTrends(); });
            document.getElementById('pa-trend-30').addEventListener('click', function() { trendDays = 30; renderTrends(); });
        }

        // ── Tab switching ─────────────────────────────────────────
        document.getElementById('pa-tabs').addEventListener('click', function(e) {
            var btn = e.target.closest('.pa-tab');
            if (!btn) return;
            currentTab = btn.dataset.tab;
            document.querySelectorAll('.pa-tab').forEach(function(b) { b.classList.remove('pa-tab-active'); });
            btn.classList.add('pa-tab-active');
            renderTab();
        });

        // ── Export buttons ────────────────────────────────────────
        document.getElementById('pa-export-csv').addEventListener('click', function() {
            var dateStr = new Date().toISOString().split('T')[0];
            if (currentTab === 'fleet' || currentTab === 'routes') {
                downloadFile(exportFleetCSV(fleetStats), 'pirate-fleet-' + dateStr + '.csv', 'text/csv');
                downloadFile(exportTransactionsCSV(txs), 'pirate-transactions-' + dateStr + '.csv', 'text/csv');
            } else {
                downloadFile(exportTransactionsCSV(txs), 'pirate-transactions-' + dateStr + '.csv', 'text/csv');
            }
        });

        document.getElementById('pa-export-json').addEventListener('click', function() {
            var dateStr = new Date().toISOString().split('T')[0];
            downloadFile(exportAllJSON(fleetStats, routeStats, txs, trends30), 'pirate-analytics-' + dateStr + '.json', 'application/json');
        });

        // ── Close ─────────────────────────────────────────────────
        document.getElementById('pa-close').addEventListener('click', close);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        function close() {
            overlay.remove();
            style.remove();
            isOpen = false;
        }

        loadData();
    }

    // ── Register with pirate bridge ───────────────────────────────
    if (typeof addMenuItem === 'function') {
        addMenuItem('📊 Pirate Analytics', openDashboard, 5);
    }

    console.log('[PirateAnalytics] v1.0 Ready ✓');

})();
