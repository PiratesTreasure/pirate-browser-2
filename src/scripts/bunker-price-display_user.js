// ==UserScript==
// @name         ShippingManager - Bunker Price Display
// @namespace    http://tampermonkey.net/
// @version      3.27
// @description  Shows current fuel and CO2 bunker prices with fill levels
// @author       https://github.com/justonlyforyou/
// @order        19
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// ==/UserScript==

(function() {
    'use strict';

    const API_URL = "https://shippingmanager.cc/api/bunker/get-prices";

    let fuelPriceElement = null;
    let co2PriceElement = null;
    let fuelFillElement = null;
    let co2FillElement = null;
    let fillLevelDebounce = null;
    let initRetryCount = 0;
    const MAX_INIT_RETRIES = 10;

    function findCurrentPrice(prices) {
        // Game uses prices.slice(-1)[0] — last element is always the current slot
        return prices[prices.length - 1];
    }

    function getFuelColor(price) {
        if (price > 750) return '#ef4444';
        if (price >= 650) return '#fbbf24';
        if (price >= 500) return '#60a5fa';
        return '#4ade80';
    }

    function getCO2Color(price) {
        if (price >= 20) return '#ef4444';
        if (price >= 15) return '#fbbf24';
        if (price >= 10) return '#60a5fa';
        return '#4ade80';
    }

    function getFuelFillColor(percent) {
        // Game uses 30% threshold for "low fuel" warning
        if (percent <= 30) return '#ef4444';  // red
        return '#4ade80';  // green
    }

    function getCO2FillColor(percent) {
        // Game: positive = green, zero/negative = red
        if (percent <= 0) return '#ef4444';  // red
        return '#4ade80';  // green
    }

    function getPinia() {
        var app = document.getElementById('app');
        if (!app || !app.__vue_app__) return null;
        return app.__vue_app__.config.globalProperties.$pinia;
    }

    function getUserStore() {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('user');
        } catch (err) { // eslint-disable-line no-unused-vars
            return null;
        }
    }

    function getBunkerFillLevels() {
        var userStore = getUserStore();
        if (!userStore || !userStore.user || !userStore.settings) return null;

        var fuel = userStore.user.fuel;
        var co2 = userStore.user.co2;
        var maxFuel = userStore.settings.max_fuel;
        var maxCO2 = userStore.settings.max_co2;

        if (!maxFuel || !maxCO2) return null;

        return {
            fuelPercent: Math.round((fuel / maxFuel) * 100),
            co2Percent: Math.round((co2 / maxCO2) * 100)
        };
    }

    /**
     * Create 3-line bunker display:
     * Line 1: "Fuel" or "CO2"
     * Line 2: Fill level %
     * Line 3: Price
     */
    function createBunkerBlock(container, type) {
        // Hide original content
        var wrapper = container.querySelector('.chartWrapper') || container.querySelector('.ledWrapper');
        if (wrapper) wrapper.style.display = 'none';

        // Create 3-line block
        var block = document.createElement('div');
        block.id = 'bunker-' + type + '-block';
        block.style.cssText = 'display:flex;flex-direction:column;align-items:center;line-height:1.2;';

        // Line 1: Label
        var label = document.createElement('span');
        label.style.cssText = 'color:#9ca3af;font-size:12px;';
        label.textContent = type === 'fuel' ? 'Fuel' : 'CO2';
        block.appendChild(label);

        // Line 2: Fill %
        var fill = document.createElement('span');
        fill.id = 'bunker-' + type + '-fill';
        fill.style.cssText = 'font-weight:bold;font-size:12px;';
        fill.textContent = '...%';
        block.appendChild(fill);

        // Line 3: Price
        var price = document.createElement('span');
        price.id = 'bunker-' + type + '-price';
        price.style.cssText = 'font-size:12px;font-weight:bold;';
        price.textContent = '';
        block.appendChild(price);

        container.appendChild(block);

        return { fill: fill, price: price };
    }

    function insertPriceDisplays() {
        var chartElement = document.querySelector('.content.chart.cursor-pointer');
        var ledElement = document.querySelector('.content.led.cursor-pointer');

        if (chartElement && !fuelFillElement) {
            var fuelBlock = createBunkerBlock(chartElement, 'fuel');
            fuelFillElement = fuelBlock.fill;
            fuelPriceElement = fuelBlock.price;
        }

        if (ledElement && !co2FillElement) {
            var co2Block = createBunkerBlock(ledElement, 'co2');
            co2FillElement = co2Block.fill;
            co2PriceElement = co2Block.price;
        }

        return fuelFillElement && co2FillElement;
    }

    async function updatePrices() {
        try {
            var response = await fetch(API_URL, { credentials: "include" });
            if (!response.ok) return;

            var data = await response.json();
            var prices = data && data.data && data.data.prices;
            if (!prices || prices.length === 0) return;

            var discountedFuel = data && data.data && data.data.discounted_fuel;
            var discountedCo2 = data && data.data && data.data.discounted_co2;

            var fuelPrice, co2Price;
            if (discountedFuel !== undefined) {
                fuelPrice = discountedFuel;
            } else {
                fuelPrice = findCurrentPrice(prices).fuel_price;
            }

            if (discountedCo2 !== undefined) {
                co2Price = discountedCo2;
            } else {
                co2Price = findCurrentPrice(prices).co2_price;
            }

            if (!fuelFillElement || !co2FillElement) {
                if (!insertPriceDisplays()) return;
            }

            // Update prices (Math.ceil to match game's formatting)
            if (fuelPriceElement && fuelPrice !== undefined) {
                var fuelDisplay = Math.ceil(fuelPrice);
                fuelPriceElement.textContent = '$' + fuelDisplay + '/t';
                fuelPriceElement.style.color = getFuelColor(fuelDisplay);
            }
            if (co2PriceElement && co2Price !== undefined) {
                var co2Display = Math.ceil(co2Price);
                co2PriceElement.textContent = '$' + co2Display + '/t';
                co2PriceElement.style.color = getCO2Color(co2Display);
            }

            // Update fill levels
            updateFillLevels();
        } catch (err) {
            console.error("[BunkerPrice] Error:", err);
        }
    }

    // Fetch interceptor: update fill levels when bunker/user API calls complete
    var _origFetchBunker = window.fetch;
    window.fetch = function() {
        var url = typeof arguments[0] === 'string' ? arguments[0] : '';
        var result = _origFetchBunker.apply(this, arguments);
        if (url.indexOf('/bunker/') !== -1 || url.indexOf('/user/') !== -1) {
            result.then(function() {
                if (fillLevelDebounce) clearTimeout(fillLevelDebounce);
                fillLevelDebounce = setTimeout(updateFillLevels, 300);
            }).catch(function() {});
        }
        return result;
    };

    // Update fill levels (both desktop and mobile use same elements now)
    function updateFillLevels() {
        var fillLevels = getBunkerFillLevels();
        if (!fillLevels) return;

        if (fuelFillElement) {
            fuelFillElement.textContent = fillLevels.fuelPercent + '%';
            fuelFillElement.style.color = getFuelFillColor(fillLevels.fuelPercent);
        }
        if (co2FillElement) {
            co2FillElement.textContent = fillLevels.co2Percent + '%';
            co2FillElement.style.color = getCO2FillColor(fillLevels.co2Percent);
        }
    }

    /**
     * Calculate ms until next price update time (:00:45 or :30:45)
     * Prices change at :00 and :30, we fetch 45 seconds after
     */
    function getMsUntilNextPriceUpdate() {
        var now = new Date();
        var minutes = now.getMinutes();
        var seconds = now.getSeconds();
        var ms = now.getMilliseconds();

        var targetMinute, targetSecond = 45;

        if (minutes < 30) {
            // Next update at :30:45
            targetMinute = 30;
        } else {
            // Next update at :00:45 (next hour)
            targetMinute = 60; // Will wrap to 0
        }

        var currentTotalSeconds = minutes * 60 + seconds;
        var targetTotalSeconds = targetMinute * 60 + targetSecond;

        var diffSeconds = targetTotalSeconds - currentTotalSeconds;
        if (diffSeconds <= 0) {
            // Already past target, go to next slot
            diffSeconds += 30 * 60; // Add 30 minutes
        }

        return diffSeconds * 1000 - ms;
    }

    /**
     * Schedule next price update at :00:45 or :30:45
     * Android background job compatible - uses setTimeout
     */
    var priceUpdateTimer = null;

    function schedulePriceUpdate() {
        if (priceUpdateTimer) {
            clearTimeout(priceUpdateTimer);
        }
        var delay = getMsUntilNextPriceUpdate();
        var nextUpdate = new Date(Date.now() + delay);
        console.log('[BunkerPrice] Next update at ' + nextUpdate.toLocaleTimeString() + ' (in ' + Math.round(delay / 1000) + 's)');

        priceUpdateTimer = setTimeout(function() {
            priceUpdateTimer = null;
            updatePrices();
            schedulePriceUpdate(); // Schedule next
        }, delay);
    }

    function resetElements() {
        fuelPriceElement = null;
        co2PriceElement = null;
        fuelFillElement = null;
        co2FillElement = null;
        initRetryCount = 0;
    }

    function init() {
        if (insertPriceDisplays()) {
            updatePrices();
            // Schedule updates at :00:45 and :30:45 (Android compatible)
            schedulePriceUpdate();
        } else {
            initRetryCount++;
            if (initRetryCount < MAX_INIT_RETRIES) {
                setTimeout(init, 1000);
            } else {
                console.error('[BunkerPrice] Init failed after ' + MAX_INIT_RETRIES + ' attempts');
            }
        }
    }

    // Debounce helper for resize listener
    var resizeDebounceTimer = null;
    function debounceResize(callback, delay) {
        if (resizeDebounceTimer) {
            clearTimeout(resizeDebounceTimer);
        }
        resizeDebounceTimer = setTimeout(callback, delay);
    }

    // Listen for header resize event to reinitialize
    window.addEventListener('rebelship-header-resize', function() {
        resetElements();
        debounceResize(function() {
            if (insertPriceDisplays()) {
                updatePrices();
            } else {
                console.log('[BunkerPrice] Reinit failed after resize');
            }
        }, 300);
    });

    // Re-fetch prices when tab becomes visible again (Android background suspension)
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden && fuelFillElement) {
            console.log('[BunkerPrice] Tab visible - refreshing prices');
            updatePrices();
            schedulePriceUpdate();
        }
    });

    init();
})();
