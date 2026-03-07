// ==UserScript==
// @name         ShippingManager - Export Vessel History
// @namespace    http://tampermonkey.net/
// @version      3.85
// @description  Detect vessel history API calls and offer CSV download
// @author       https://github.com/justonlyforyou/
// @order        996
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled     false
// ==/UserScript==
/* globals XMLHttpRequest, Blob, URL */

(function() {
    'use strict';

    var currentHistoryBtn = null;
    var trackingEnabled = false;
    var cachedHistoryData = null;

    // Wait 5 seconds after page load before tracking (ignore initial page load calls)
    setTimeout(function() {
        trackingEnabled = true;
    }, 5000);

    // Intercept fetch BEFORE the game loads
    var originalFetch = window.fetch;
    window.fetch = async function() {
        var args = Array.prototype.slice.call(arguments);
        var url = args[0];
        var options = args[1];
        var urlStr = typeof url === 'string' ? url : url.url;

        // Check if this is the vessel history endpoint (only after tracking is enabled)
        if (trackingEnabled && urlStr.indexOf('/api/vessel/get-vessel-history') !== -1 && options && options.body) {
            try {
                var body = JSON.parse(options.body);
                var vesselId = body.vessel_id;

                if (vesselId) {
                    // Call original fetch first to get the response
                    var response = await originalFetch.apply(this, args);
                    var clonedResponse = response.clone();

                    // Extract vessel name from response
                    clonedResponse.json().then(function(data) {
                        var history = data.data && data.data.vessel_history;
                        var vesselName = (data.data && data.data.user_vessel && data.data.user_vessel.name) || 'Vessel';
                        cachedHistoryData = history;
                        showSaveButton(vesselName, vesselId, history);
                    }).catch(function() {
                        showSaveButton('Vessel', vesselId, null);
                    });

                    return response;
                }
            } catch (e) {
                console.log('[VesselHistory] Error parsing fetch body:', e);
            }
        }

        return originalFetch.apply(this, args);
    };

    // Intercept XMLHttpRequest BEFORE the game loads
    var originalXHROpen = XMLHttpRequest.prototype.open;
    var originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        this._method = method;
        return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        var self = this;
        if (trackingEnabled && this._url && this._url.indexOf('/api/vessel/get-vessel-history') !== -1 && body) {
            try {
                var parsedBody = JSON.parse(body);
                var vesselId = parsedBody.vessel_id;

                if (vesselId) {
                    this.addEventListener('load', function() {
                        try {
                            var data = JSON.parse(self.responseText);
                            var history = data.data && data.data.vessel_history;
                            var vesselName = (data.data && data.data.user_vessel && data.data.user_vessel.name) || 'Vessel';

                            showSaveButton(vesselName, vesselId, history);
                        } catch {
                            showSaveButton('Vessel', vesselId, null);
                        }
                    });
                }
            } catch (e) {
                console.log('[VesselHistory] Error parsing XHR body:', e);
            }
        }

        return originalXHRSend.apply(this, [body]);
    };

    // Show save button in Voyage history header
    function showSaveButton(vesselName, vesselId, historyData) {
        // Remove existing button
        if (currentHistoryBtn && currentHistoryBtn.parentNode) {
            currentHistoryBtn.parentNode.removeChild(currentHistoryBtn);
            currentHistoryBtn = null;
        }

        function insertButton() {
            if (document.getElementById('save-vessel-history-btn')) return true;
            var headers = document.querySelectorAll('.blackBarHeader');
            if (headers.length === 0) return false;
            var targetHeader = headers[headers.length - 1];

            var btn = document.createElement('button');
            btn.id = 'save-vessel-history-btn';
            btn.textContent = 'Export History';
            btn.style.cssText = 'padding:4px 10px;background:#4ade80;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;margin-left:auto;';

            if (historyData) {
                btn.addEventListener('click', function() { saveHistoryAsCSV(vesselName, vesselId, historyData); });
            } else {
                btn.addEventListener('click', function() {
                    if (cachedHistoryData) {
                        saveHistoryAsCSV(vesselName, vesselId, cachedHistoryData);
                    } else {
                        fetchAndSaveHistory(vesselId, vesselName);
                    }
                });
            }

            targetHeader.style.display = 'flex';
            targetHeader.style.alignItems = 'center';
            targetHeader.appendChild(btn);
            currentHistoryBtn = btn;
            return true;
        }

        // Try immediately, if not ready use MutationObserver
        if (insertButton()) return;

        var observeRoot = document.getElementById('modal-container') || document.getElementById('app') || document.body;
        var insertObserver = new MutationObserver(function() {
            if (insertButton()) {
                insertObserver.disconnect();
            }
        });
        insertObserver.observe(observeRoot, { childList: true, subtree: true });
        // Safety timeout
        setTimeout(function() { insertObserver.disconnect(); }, 10000);
    }

    // Fetch history from API and save as CSV
    async function fetchAndSaveHistory(vesselId, vesselName) {
        try {
            var response = await originalFetch('https://shippingmanager.cc/api/vessel/get-vessel-history', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ vessel_id: parseInt(vesselId, 10) }),
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error('API request failed: ' + response.status);
            }

            var data = await response.json();
            var history = (data.data && data.data.vessel_history) || [];

            if (history.length === 0) {
                alert('No history entries found for ' + vesselName);
                return;
            }

            saveHistoryAsCSV(vesselName, vesselId, history);

        } catch (err) {
            console.error('[VesselHistory] Error fetching history:', err);
            alert('Failed to fetch history: ' + err.message);
        }
    }

    // Save history as CSV - dynamically uses ALL fields from API response
    function saveHistoryAsCSV(vesselName, vesselId, history) {
        if (!history || history.length === 0) {
            alert('No history data available');
            return;
        }

        // Detect columns from first entry only (all entries share same schema)
        var allKeys = {};
        var firstTrip = history[0];
        var topKeys = Object.keys(firstTrip);
        for (var k = 0; k < topKeys.length; k++) {
            var key = topKeys[k];
            if (typeof firstTrip[key] === 'object' && firstTrip[key] !== null) {
                var subKeys = Object.keys(firstTrip[key]);
                for (var s = 0; s < subKeys.length; s++) {
                    allKeys[key + '_' + subKeys[s]] = true;
                }
            } else {
                allKeys[key] = true;
            }
        }

        var columns = Object.keys(allKeys).sort();
        var chunks = ['\ufeff' + columns.join(';') + '\n'];

        for (var i = 0; i < history.length; i++) {
            var trip = history[i];
            var parts = [];
            for (var c = 0; c < columns.length; c++) {
                var col = columns[c];
                var underscoreIdx = col.indexOf('_');
                if (underscoreIdx !== -1) {
                    var parent = col.substring(0, underscoreIdx);
                    var child = col.substring(underscoreIdx + 1);
                    parts.push(escapeCSV(trip[parent] && trip[parent][child]));
                } else {
                    parts.push(escapeCSV(trip[col]));
                }
            }
            chunks.push(parts.join(';') + '\n');
        }

        // Download via Blob chunks
        var blob = new Blob(chunks, { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'vessel_history_' + vesselId + '_' + new Date().toISOString().slice(0,10) + '.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        alert('Exported ' + history.length + ' trips for ' + vesselName);

        // Remove button after save
        if (currentHistoryBtn && currentHistoryBtn.parentNode) {
            currentHistoryBtn.parentNode.removeChild(currentHistoryBtn);
            currentHistoryBtn = null;
        }
        cachedHistoryData = null;
    }

    function escapeCSV(str) {
        if (str === null || str === undefined) return '';
        str = String(str);
        if (str.indexOf('"') !== -1 || str.indexOf(';') !== -1 || str.indexOf('\n') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

})();
