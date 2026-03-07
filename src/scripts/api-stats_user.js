// ==UserScript==
// @name         ShippingManager - API Stats Monitor
// @namespace    http://tampermonkey.net/
// @description  Monitor all API calls to shippingmanager.cc in the background
// @version      2.01
// @order        1
// @author       RebelShip
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-start
// @RequireRebelShipMenu true
// @enabled      false
// ==/UserScript==
/* globals addMenuItem, XMLHttpRequest */

(function() {
    'use strict';

    var MAX_AGE_MS = 61 * 60 * 1000;
    var timestamps = [];
    var modalVisible = false;
    var currentFilter = 5;
    var filterButtons = [];

    function isApiUrl(url) {
        if (!url) return false;
        return url.indexOf('/api/') !== -1 || url.indexOf('/api?') !== -1;
    }

    function recordCall() {
        timestamps.push(Date.now());
    }

    function cleanup() {
        var cutoff = Date.now() - MAX_AGE_MS;
        while (timestamps.length > 0 && timestamps[0] < cutoff) {
            timestamps.shift();
        }
    }

    function getCount(minutes) {
        var cutoff = Date.now() - (minutes * 60 * 1000);
        var count = 0;
        for (var i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] >= cutoff) {
                count++;
            } else {
                break;
            }
        }
        return count;
    }

    function interceptFetch() {
        var originalFetch = window.fetch;
        window.fetch = function(input) {
            var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (isApiUrl(url)) {
                recordCall();
            }
            return originalFetch.apply(this, arguments);
        };
    }

    function interceptXHR() {
        var originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (isApiUrl(url)) {
                this._apiStats = true;
            }
            return originalOpen.apply(this, arguments);
        };

        var originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
            if (this._apiStats) {
                recordCall();
            }
            return originalSend.apply(this, arguments);
        };
    }

    function createModal() {
        var existing = document.getElementById('api-stats-modal');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'api-stats-modal';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1a2e;border:1px solid #3a3a5e;border-radius:8px;width:400px;max-width:90vw;display:flex;flex-direction:column;color:#fff;font-family:Arial,sans-serif;';

        var header = document.createElement('div');
        header.style.cssText = 'padding:16px 20px;border-bottom:1px solid #3a3a5e;display:flex;justify-content:space-between;align-items:center;';

        var titleSpan = document.createElement('span');
        titleSpan.textContent = 'API Stats';
        titleSpan.style.cssText = 'font-size:18px;font-weight:700;';
        header.appendChild(titleSpan);

        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'X';
        closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 8px;';
        closeBtn.onclick = function() {
            overlay.remove();
            modalVisible = false;
        };
        header.appendChild(closeBtn);

        var filters = document.createElement('div');
        filters.style.cssText = 'padding:12px 20px;border-bottom:1px solid #3a3a5e;display:flex;flex-wrap:wrap;gap:6px;';

        filterButtons = [];
        [1, 5, 10, 15, 30, 45, 60].forEach(function(mins) {
            var btn = document.createElement('button');
            btn.textContent = mins + 'm';
            btn.style.cssText = 'padding:4px 8px;border:1px solid #3a3a5e;border-radius:4px;cursor:pointer;font-size:12px;' +
                (currentFilter === mins ? 'background:#4a90d9;color:#fff;' : 'background:#2a2a4e;color:#aaa;');
            btn.onclick = function() {
                currentFilter = mins;
                updateDisplay();
                filterButtons.forEach(function(b) {
                    b.style.background = '#2a2a4e';
                    b.style.color = '#aaa';
                });
                btn.style.background = '#4a90d9';
                btn.style.color = '#fff';
            };
            filterButtons.push(btn);
            filters.appendChild(btn);
        });

        var content = document.createElement('div');
        content.id = 'api-stats-content';
        content.style.cssText = 'padding:20px;text-align:center;';

        modal.appendChild(header);
        modal.appendChild(filters);
        modal.appendChild(content);
        overlay.appendChild(modal);

        overlay.onclick = function(e) {
            if (e.target === overlay) {
                overlay.remove();
                modalVisible = false;
            }
        };

        document.body.appendChild(overlay);
        modalVisible = true;
        updateDisplay();
    }

    function updateDisplay() {
        var content = document.getElementById('api-stats-content');
        if (!content) return;

        cleanup();
        var count = getCount(currentFilter);
        var perMin = currentFilter > 0 ? (count / currentFilter).toFixed(1) : count;

        content.textContent = '';

        var countEl = document.createElement('div');
        countEl.style.cssText = 'font-size:48px;font-weight:700;color:#4a90d9;';
        countEl.textContent = count;
        content.appendChild(countEl);

        var labelEl = document.createElement('div');
        labelEl.style.cssText = 'font-size:14px;color:#626b90;margin-top:4px;';
        labelEl.textContent = 'calls in last ' + currentFilter + ' min';
        content.appendChild(labelEl);

        var rateEl = document.createElement('div');
        rateEl.style.cssText = 'font-size:16px;color:#aaa;margin-top:12px;';
        rateEl.textContent = perMin + ' calls/min';
        content.appendChild(rateEl);

        var limitEl = document.createElement('div');
        var count15 = getCount(15);
        var limitColor = count15 > 900 ? '#ef4444' : count15 > 700 ? '#fbbf24' : '#4ade80';
        limitEl.style.cssText = 'font-size:14px;margin-top:12px;color:' + limitColor + ';';
        limitEl.textContent = '15min limit: ' + count15 + ' / 1000';
        content.appendChild(limitEl);

        var totalEl = document.createElement('div');
        totalEl.style.cssText = 'font-size:12px;color:#626b90;margin-top:8px;';
        totalEl.textContent = 'Total tracked: ' + timestamps.length;
        content.appendChild(totalEl);
    }

    function toggleModal() {
        if (modalVisible) {
            var m = document.getElementById('api-stats-modal');
            if (m) m.remove();
            modalVisible = false;
        } else {
            createModal();
        }
    }

    function init() {
        interceptFetch();
        interceptXHR();

        addMenuItem('API Stats', toggleModal, 99);

        document.addEventListener('keydown', function(e) {
            if (e.altKey && e.key === 'a') {
                e.preventDefault();
                toggleModal();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
