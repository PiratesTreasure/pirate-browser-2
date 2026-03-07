// ==UserScript==
// @name        ShippingManager - Vessel Sell Cart
// @description Select and bulk-sell vessels with lazy-loaded sell prices
// @version     1.11
// @author      https://github.com/justonlyforyou/
// @order        25
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// @RequireRebelShipMenu true
// ==/UserScript==

/* global addMenuItem */

(function() {
    'use strict';

    var SELL_TAG_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>';

    // Price cache: vesselId -> { selling_price, original_price }
    var priceCache = new Map();
    var priceFetchAbort = null;
    var sellModalOpen = false;

    // Get Pinia stores from Vue app
    function getStores() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;

            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;

            var stores = {};
            pinia._s.forEach(function(store, name) {
                stores[name] = store;
            });

            return stores;
        } catch (e) {
            console.error('[VesselSell] Failed to get stores:', e);
            return null;
        }
    }

    function escapeHtml(text) {
        if (typeof text !== 'string') text = String(text);
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatNumber(num) {
        return num.toLocaleString('en-US');
    }

    function showNotification(message, type) {
        type = type || 'success';
        var existing = document.getElementById('rebelship-sell-notification');
        if (existing) existing.remove();

        var colors = {
            success: '#4ade80',
            error: '#ef4444',
            info: '#3b82f6'
        };

        var notif = document.createElement('div');
        notif.id = 'rebelship-sell-notification';
        notif.textContent = message;
        notif.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:' + colors[type] + ';color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);animation:rebelSellSlideDown 0.3s ease;';

        document.body.appendChild(notif);
        setTimeout(function() { notif.remove(); }, 2000);
    }

    // Get all user vessels from vessel store
    function getUserVessels() {
        var stores = getStores();
        if (!stores || !stores.vessel) return [];
        return stores.vessel.userVessels || [];
    }

    // Fetch sell price for a single vessel
    function fetchSellPrice(vesselId) {
        return fetch('/api/vessel/get-sell-price', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ vessel_id: vesselId })
        })
        .then(function(response) { return response.json(); })
        .then(function(data) {
            if (data && data.data) {
                var priceData = {
                    selling_price: data.data.selling_price || 0,
                    original_price: data.data.original_price || 0
                };
                priceCache.set(vesselId, priceData);
                return priceData;
            }
            return null;
        })
        .catch(function(e) {
            console.error('[VesselSell] Failed to fetch price for vessel ' + vesselId + ':', e);
            return null;
        });
    }

    // Batch fetch sell prices with parallel requests (5 per batch)
    function fetchSellPrices(vesselIds, onEachPrice, onDone) {
        var aborted = false;
        priceFetchAbort = function() { aborted = true; };

        var total = vesselIds.length;
        var completed = 0;
        // Filter out already cached
        var toFetch = vesselIds.filter(function(id) { return !priceCache.has(id); });
        completed = total - toFetch.length;

        if (toFetch.length === 0) {
            if (onDone) onDone();
            return;
        }

        var BATCH_SIZE = 5;
        var batchIdx = 0;

        function fetchBatch() {
            if (aborted || batchIdx >= toFetch.length) {
                if (onDone) onDone();
                return;
            }

            var batch = toFetch.slice(batchIdx, batchIdx + BATCH_SIZE);
            batchIdx += batch.length;

            var promises = [];
            for (var i = 0; i < batch.length; i++) {
                (function(vid) {
                    promises.push(fetchSellPrice(vid).then(function() {
                        completed++;
                        if (onEachPrice) onEachPrice(vid, completed, total);
                    }));
                })(batch[i]);
            }

            Promise.all(promises).then(function() {
                if (!aborted) {
                    setTimeout(fetchBatch, 200);
                }
            });
        }

        fetchBatch();
    }

    // Sell a single vessel
    function sellVessel(vesselId) {
        return fetch('/api/vessel/sell-vessel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ vessel_id: vesselId })
        })
        .then(function(response) { return response.json(); });
    }

    // Show the sell modal
    function showSellModal() {
        if (sellModalOpen) return;
        sellModalOpen = true;

        var allUserVessels = getUserVessels();
        if (!allUserVessels || allUserVessels.length === 0) {
            showNotification('No vessels found', 'info');
            sellModalOpen = false;
            return;
        }

        // Only show vessels that can be sold (at port or anchored)
        var vessels = allUserVessels.filter(function(v) {
            var s = v.status;
            return s === 'port' || s === 'anchor';
        });

        if (vessels.length === 0) {
            showNotification('No sellable vessels (need status: at port or anchored)', 'info');
            sellModalOpen = false;
            return;
        }

        // Sort vessels by name (in-place, no copy needed)
        vessels.sort(function(a, b) {
            return (a.name || '').localeCompare(b.name || '');
        });

        // Map for O(1) vessel lookup by ID
        var vesselMap = {};
        for (var mi = 0; mi < vessels.length; mi++) {
            var mv = vessels[mi];
            vesselMap[mv.user_vessel_id || mv.id] = mv;
        }

        var selectedIds = new Set();
        var currentFilter = '';
        var priceElements = new Map();

        function getFilteredVessels() {
            if (!currentFilter) return vessels;
            var q = currentFilter.toLowerCase();
            return vessels.filter(function(v) {
                return (v.name || '').toLowerCase().indexOf(q) !== -1;
            });
        }

        // Build overlay
        var overlay = document.createElement('div');
        overlay.id = 'rebelship-sell-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99998;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1f2e;border:1px solid #374151;border-radius:12px;width:90%;max-width:600px;max-height:85vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;';

        // Header
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #374151;background:#0f1420;flex-shrink:0;';
        header.innerHTML = '<div style="display:flex;align-items:center;gap:10px;"><span style="color:#fff;font-size:18px;font-weight:600;">' + SELL_TAG_ICON + ' Sell Vessels</span></div>' +
            '<div style="display:flex;gap:8px;">' +
            '<button id="sell-close-btn" style="padding:8px 16px;background:#4b5563;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">Close</button>' +
            '<button id="sell-checkout-btn" style="padding:8px 16px;background:#6b7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;" disabled>Sell Selected</button>' +
            '</div>';

        // Search + controls bar
        var controlsBar = document.createElement('div');
        controlsBar.style.cssText = 'padding:12px 20px;border-bottom:1px solid #374151;background:#0f1420;flex-shrink:0;';
        controlsBar.innerHTML = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">' +
            '<input id="sell-search" type="text" placeholder="Search vessels..." style="flex:1;padding:8px 12px;background:#252b3b;border:1px solid #374151;border-radius:6px;color:#fff;font-size:13px;outline:none;">' +
            '<button id="sell-select-all" style="padding:6px 12px;background:#374151;color:#9ca3af;border:none;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;">Select All</button>' +
            '<button id="sell-select-none" style="padding:6px 12px;background:#374151;color:#9ca3af;border:none;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;">None</button>' +
            '</div>';

        // Progress banner
        var banner = document.createElement('div');
        banner.id = 'sell-price-banner';
        banner.style.cssText = 'padding:8px 20px;background:#1e293b;color:#94a3b8;font-size:12px;border-bottom:1px solid #374151;flex-shrink:0;display:none;';
        banner.textContent = 'Loading sell prices...';

        // Vessel list container
        var listContainer = document.createElement('div');
        listContainer.id = 'sell-vessel-list';
        listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px 20px;';

        // Footer
        var footer = document.createElement('div');
        footer.id = 'sell-footer';
        footer.style.cssText = 'padding:12px 20px;border-top:1px solid #374151;background:#0f1420;flex-shrink:0;';
        footer.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span id="sell-selected-count" style="color:#9ca3af;font-size:13px;">0 selected</span>' +
            '<span id="sell-total-value" style="color:#ef4444;font-weight:600;font-size:16px;">$0</span>' +
            '</div>';

        modal.appendChild(header);
        modal.appendChild(controlsBar);
        modal.appendChild(banner);
        modal.appendChild(listContainer);
        modal.appendChild(footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        var CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

        // Update row visual state without full re-render
        function updateRowStyle(row, isSelected) {
            row.style.background = isSelected ? '#2a3348' : '#252b3b';
            row.style.borderLeftColor = isSelected ? '#ef4444' : 'transparent';
            var cb = row.firstChild;
            if (cb) {
                cb.style.borderColor = isSelected ? '#ef4444' : '#4b5563';
                cb.style.background = isSelected ? '#ef4444' : 'transparent';
                cb.innerHTML = isSelected ? CHECK_SVG : '';
            }
        }

        // Render vessel rows
        function renderList() {
            listContainer.innerHTML = '';
            priceElements = new Map();
            var filtered = getFilteredVessels();

            if (filtered.length === 0) {
                listContainer.innerHTML = '<div style="text-align:center;color:#6b7280;padding:40px 0;font-size:14px;">No vessels match your search</div>';
                return;
            }

            for (var i = 0; i < filtered.length; i++) {
                var v = filtered[i];
                var vid = v.user_vessel_id || v.id;
                var isSelected = selectedIds.has(vid);
                var cached = priceCache.get(vid);

                var row = document.createElement('div');
                row.className = 'sell-vessel-row';
                row.dataset.vid = vid;
                row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:' + (isSelected ? '#2a3348' : '#252b3b') + ';border-radius:6px;margin-bottom:4px;cursor:pointer;border-left:3px solid ' + (isSelected ? '#ef4444' : 'transparent') + ';transition:background 0.15s,border-color 0.15s;';

                var checkbox = '<div style="width:20px;height:20px;border:2px solid ' + (isSelected ? '#ef4444' : '#4b5563') + ';border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:' + (isSelected ? '#ef4444' : 'transparent') + ';">' +
                    (isSelected ? CHECK_SVG : '') +
                    '</div>';

                var vesselStatus = v.status || '';
                var statusColor = vesselStatus === 'port' ? '#4ade80' : vesselStatus === 'anchor' ? '#f59e0b' : '#9ca3af';
                var statusLabel = vesselStatus === 'port' ? 'IN PORT' : vesselStatus === 'anchor' ? 'ANCHORED' : escapeHtml(vesselStatus.toUpperCase());
                var statusText = vesselStatus ? ' <span style="color:' + statusColor + ';font-size:10px;">[' + statusLabel + ']</span>' : '';

                var vesselType = v.capacity_type || v.vessel_model || '';
                var typeText = vesselType ? '<span style="color:#6b7280;font-size:11px;"> ' + escapeHtml(vesselType) + '</span>' : '';

                var priceHtml;
                if (cached) {
                    priceHtml = '<div style="text-align:right;min-width:100px;">' +
                        '<div style="color:#ef4444;font-weight:500;font-size:13px;">$' + formatNumber(cached.selling_price) + '</div>' +
                        '<div style="color:#4b5563;font-size:10px;text-decoration:line-through;">$' + formatNumber(cached.original_price) + '</div>' +
                        '</div>';
                } else {
                    priceHtml = '<div style="text-align:right;min-width:100px;" class="sell-price-container" data-vid="' + vid + '">' +
                        '<div style="color:#4b5563;font-size:12px;">...</div>' +
                        '</div>';
                }

                row.innerHTML = checkbox +
                    '<div style="flex:1;min-width:0;">' +
                    '<div style="color:#fff;font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(v.name || 'Unnamed') + statusText + '</div>' +
                    '<div>' + typeText + '</div>' +
                    '</div>' +
                    priceHtml;

                // Store price element ref for direct updates
                if (!cached) {
                    var priceContainer = row.querySelector('.sell-price-container');
                    if (priceContainer) priceElements.set(vid, priceContainer);
                }

                listContainer.appendChild(row);
            }
        }

        // Event delegation: single click handler on listContainer
        listContainer.addEventListener('click', function(e) {
            var row = e.target;
            while (row && row !== listContainer) {
                if (row.classList && row.classList.contains('sell-vessel-row')) break;
                row = row.parentNode;
            }
            if (!row || row === listContainer) return;
            var vid = parseInt(row.dataset.vid) || row.dataset.vid;
            if (selectedIds.has(vid)) {
                selectedIds.delete(vid);
                updateRowStyle(row, false);
            } else {
                selectedIds.add(vid);
                updateRowStyle(row, true);
            }
            updateFooter();
            updateSellButton();
        });

        function updateFooter() {
            var count = selectedIds.size;
            var totalValue = 0;
            selectedIds.forEach(function(vid) {
                var cached = priceCache.get(vid);
                if (cached) {
                    totalValue += cached.selling_price;
                }
            });

            var countEl = document.getElementById('sell-selected-count');
            var valueEl = document.getElementById('sell-total-value');
            if (countEl) countEl.textContent = count + ' selected';
            if (valueEl) valueEl.textContent = '$' + formatNumber(totalValue);
        }

        function updateSellButton() {
            var btn = document.getElementById('sell-checkout-btn');
            if (!btn) return;
            if (selectedIds.size > 0) {
                btn.disabled = false;
                btn.style.background = '#ef4444';
                btn.style.cursor = 'pointer';
            } else {
                btn.disabled = true;
                btn.style.background = '#6b7280';
                btn.style.cursor = 'default';
            }
        }

        // Filter logic
        function applyFilter() {
            renderList();
        }

        // Search input
        var searchInput = controlsBar.querySelector('#sell-search');
        var searchTimer = null;
        searchInput.addEventListener('input', function() {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function() {
                currentFilter = searchInput.value.trim();
                applyFilter();
                // Start fetching prices for newly visible vessels
                startPriceFetch();
            }, 200);
        });

        // Select all / none
        controlsBar.querySelector('#sell-select-all').addEventListener('click', function() {
            var filtered = getFilteredVessels();
            for (var si = 0; si < filtered.length; si++) {
                selectedIds.add(filtered[si].user_vessel_id || filtered[si].id);
            }
            renderList();
            updateFooter();
            updateSellButton();
        });

        controlsBar.querySelector('#sell-select-none').addEventListener('click', function() {
            selectedIds.clear();
            renderList();
            updateFooter();
            updateSellButton();
        });

        // Close
        function closeModal() {
            sellModalOpen = false;
            if (priceFetchAbort) {
                priceFetchAbort();
                priceFetchAbort = null;
            }
            if (searchTimer) {
                clearTimeout(searchTimer);
                searchTimer = null;
            }
            priceCache.clear();
            overlay.remove();
        }

        header.querySelector('#sell-close-btn').addEventListener('click', closeModal);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });

        // Sell checkout button - uses vesselMap for O(1) lookup
        header.querySelector('#sell-checkout-btn').addEventListener('click', function() {
            if (selectedIds.size === 0) return;
            var toSell = [];
            selectedIds.forEach(function(vid) {
                if (vesselMap[vid]) {
                    toSell.push(vesselMap[vid]);
                }
            });
            closeModal();
            processSellCheckout(toSell);
        });

        // Update price in a row when it arrives (uses priceElements Map for O(1) lookup)
        function updateRowPrice(vid) {
            var cached = priceCache.get(vid);
            if (!cached) return;
            var container = priceElements.get(vid);
            if (container) {
                container.innerHTML = '<div style="color:#ef4444;font-weight:500;font-size:13px;">$' + formatNumber(cached.selling_price) + '</div>' +
                    '<div style="color:#4b5563;font-size:10px;text-decoration:line-through;">$' + formatNumber(cached.original_price) + '</div>';
                priceElements.delete(vid);
            }
            if (selectedIds.has(vid)) {
                updateFooter();
            }
        }

        // Start fetching prices for currently filtered vessels
        function startPriceFetch() {
            if (priceFetchAbort) {
                priceFetchAbort();
            }

            var filtered = getFilteredVessels();
            var ids = [];
            for (var fi = 0; fi < filtered.length; fi++) {
                ids.push(filtered[fi].user_vessel_id || filtered[fi].id);
            }
            var uncached = ids.filter(function(id) { return !priceCache.has(id); });

            if (uncached.length === 0) {
                banner.style.display = 'none';
                return;
            }

            banner.style.display = 'block';

            fetchSellPrices(ids,
                function onEachPrice(vid, done, total) {
                    banner.textContent = 'Loading sell prices... (' + done + '/' + total + ')';
                    updateRowPrice(vid);
                    if (done >= total) {
                        banner.style.display = 'none';
                    }
                },
                function onDone() {
                    banner.style.display = 'none';
                    renderList();
                    updateFooter();
                }
            );
        }

        // Initial render
        renderList();
        startPriceFetch();
    }

    // Process sell checkout - sell vessels sequentially
    var MAX_ERRORS = 20;

    function processSellCheckout(sellVessels) {
        if (!sellVessels || sellVessels.length === 0) return;

        var progressOverlay = document.createElement('div');
        progressOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;';
        progressOverlay.innerHTML = '<div id="sell-progress" style="color:#fff;font-size:18px;margin-bottom:20px;">Selling vessels...</div><div id="sell-status" style="color:#9ca3af;font-size:14px;"></div>';
        document.body.appendChild(progressOverlay);

        var progressEl = progressOverlay.querySelector('#sell-progress');
        var statusEl = progressOverlay.querySelector('#sell-status');

        var successCount = 0;
        var failCount = 0;
        var errors = [];
        var total = sellVessels.length;
        var idx = 0;

        function processNext() {
            if (idx >= total) {
                progressEl.textContent = 'Sell Complete!';
                var errorDisplay = errors.join('<br>');
                if (failCount > MAX_ERRORS) {
                    errorDisplay += '<br>... and ' + (failCount - MAX_ERRORS) + ' more';
                }
                if (failCount > 0) {
                    statusEl.innerHTML = '<span style="color:#4ade80;">' + successCount + ' sold</span>, <span style="color:#ef4444;">' + failCount + ' failed</span><br><br><div style="text-align:left;max-height:150px;overflow-y:auto;font-size:12px;color:#ef4444;">' + errorDisplay + '</div>';
                } else {
                    statusEl.innerHTML = '<span style="color:#4ade80;">' + successCount + ' sold</span>';
                }

                setTimeout(function() {
                    progressOverlay.remove();
                    if (successCount > 0) {
                        var stores = getStores();
                        if (stores) {
                            if (stores.user && typeof stores.user.fetchUser === 'function') {
                                stores.user.fetchUser().catch(function(e) {
                                    console.error('[VesselSell] Failed to refresh user:', e);
                                });
                            }
                            if (stores.vessel && typeof stores.vessel.fetchUserVessels === 'function') {
                                stores.vessel.fetchUserVessels().catch(function(e) {
                                    console.error('[VesselSell] Failed to refresh vessels:', e);
                                });
                            }
                        }
                    }
                }, failCount > 0 ? 4000 : 2000);
                return;
            }

            var v = sellVessels[idx];
            var vid = v.user_vessel_id || v.id;
            var vname = v.name || 'Vessel #' + vid;
            idx++;

            progressEl.textContent = 'Selling ' + idx + '/' + total;
            statusEl.textContent = vname;

            sellVessel(vid).then(function(data) {
                if (data.error) {
                    failCount++;
                    var errorMsg = typeof data.error === 'string' ? data.error.replace(/_/g, ' ') : (data.error.message || JSON.stringify(data.error));
                    if (errors.length < MAX_ERRORS) {
                        errors.push(escapeHtml(vname) + ': ' + escapeHtml(errorMsg));
                    }
                    statusEl.innerHTML = '<span style="color:#ef4444;">' + escapeHtml(errorMsg) + '</span>';
                    console.error('[VesselSell] Failed to sell:', data);
                } else if (data.success || data.data) {
                    successCount++;
                    priceCache.delete(vid);
                } else {
                    failCount++;
                    if (errors.length < MAX_ERRORS) {
                        errors.push(escapeHtml(vname) + ': unknown error');
                    }
                    console.error('[VesselSell] Unexpected response:', data);
                }
            }).catch(function(e) {
                failCount++;
                if (errors.length < MAX_ERRORS) {
                    errors.push(escapeHtml(vname) + ': ' + escapeHtml(e.message));
                }
                console.error('[VesselSell] Error selling vessel:', e);
            }).finally(function() {
                setTimeout(processNext, failCount > 0 ? 2000 : 500);
            });
        }

        processNext();
    }

    // Close sell modal when RebelShip menu is clicked
    function setupMenuListener() {
        window.addEventListener('rebelship-menu-click', function() {
            if (sellModalOpen) {
                sellModalOpen = false;
                if (priceFetchAbort) {
                    priceFetchAbort();
                    priceFetchAbort = null;
                }
                var overlay = document.getElementById('rebelship-sell-overlay');
                if (overlay) overlay.remove();
            }
        });
    }

    // Initialize
    function init() {
        addMenuItem('Sell Vessels', showSellModal, 64);
        setupMenuListener();
    }

    // Add CSS animation
    var style = document.createElement('style');
    style.textContent = '@keyframes rebelSellSlideDown { from { opacity: 0; transform: translate(-50%, -20px); } to { opacity: 1; transform: translate(-50%, 0); } }';
    document.head.appendChild(style);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
