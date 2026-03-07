// ==UserScript==
// @name        ShippingManager - Depart All Loop Button
// @description Clicks Depart All button repeatedly until all vessels departed
// @author      https://github.com/justonlyforyou/
// @version     2.94
// @order        29
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// ==/UserScript==

(function() {
    'use strict';

    var running = false;
    var loopBtn = null;
    var lastDepartError = null;
    var stylesInjected = false;

    // Intercept fetch to catch depart-all API errors
    var originalFetch = window.fetch;
    window.fetch = async function() {
        var url = arguments[0];
        var urlStr = typeof url === 'string' ? url : url.toString();

        var response = await originalFetch.apply(this, arguments);

        // Check depart-all response for errors
        if (urlStr.includes('/route/depart-all')) {
            try {
                var bodyText = await response.text();
                var data = JSON.parse(bodyText);
                if (data.error) {
                    lastDepartError = data.error;
                    console.log('[DepartLoop] API error:', data.error);
                } else {
                    lastDepartError = null;
                }
                return new window.Response(bodyText, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            } catch {
                // ignore parse errors
            }
        }

        return response;
    };

    function hasNotEnoughFuel() {
        return lastDepartError === 'not_enough_fuel';
    }

    async function getVesselsAtPort() {
        try {
            const res = await fetch('/api/vessel/get-all-user-vessels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ include_routes: false })
            });
            const data = await res.json();
            const vessels = data.data?.user_vessels || [];

            const atPort = vessels.filter(v =>
                v.status === 'port' &&
                !v.is_parked &&
                v.route_name
            );

            return atPort.length;
        } catch (err) {
            console.warn('[DepartLoop] API request failed:', err.message);
            return -1;
        }
    }

    function updateButtonState() {
        if (!loopBtn) return;
        const btnContent = loopBtn.querySelector('.btn-content-wrapper');
        if (running) {
            btnContent.textContent = 'Stop';
            loopBtn.classList.remove('light-blue');
            loopBtn.classList.add('red');
        } else {
            btnContent.textContent = 'Depart Loop';
            loopBtn.classList.remove('red');
            loopBtn.classList.add('light-blue');
        }
    }

    async function loop() {
        if (running) return;
        running = true;
        updateButtonState();

        var maxIterations = 100;
        var iterations = 0;

        while (running) {
            iterations++;
            if (iterations > maxIterations) {
                console.log('[Loop] Max iterations reached (' + maxIterations + '), stopping');
                break;
            }

            const count = await getVesselsAtPort();
            console.log('[Loop] Vessels at port:', count, '(iteration ' + iterations + '/' + maxIterations + ')');

            if (count === -1) {
                console.log('[Loop] API error, retrying in 3s...');
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }

            if (count === 0) {
                console.log('[Loop] All vessels departed');
                break;
            }

            const departBtn = document.getElementById('depart-all-btn');
            if (!departBtn) {
                console.log('[Loop] Depart All button not found');
                break;
            }

            lastDepartError = null;
            departBtn.click();

            // Wait for response
            await new Promise(r => setTimeout(r, 2000));

            // Check API response for fuel error
            if (hasNotEnoughFuel()) {
                console.log('[Loop] Stopping - not_enough_fuel');
                break;
            }
        }

        running = false;
        updateButtonState();
    }

    function stop() {
        running = false;
        updateButtonState();
        console.log('[Loop] Stopped');
    }

    function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;

        const style = document.createElement('style');
        style.textContent = '.bottomWrapper.btn-group { position: absolute !important; bottom: 0 !important; left: 0 !important; width: 100% !important; } .buttonWrapper { position: absolute !important; bottom: 46px !important; left: 0 !important; width: 100% !important; padding: 0 2px !important; box-sizing: border-box !important; gap: 2px !important; }';
        document.head.appendChild(style);
    }

    function addButton() {
        injectStyles();

        const orig = document.getElementById('depart-all-btn');
        if (!orig || document.getElementById('depart-loop-btn')) return;

        const buttonWrapper = orig.closest('.buttonWrapper');
        if (!buttonWrapper) return;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'grid-column: 1 / -1; width: 100%; margin-top: 4px;';

        loopBtn = document.createElement('button');
        loopBtn.id = 'depart-loop-btn';
        loopBtn.type = 'button';
        loopBtn.className = 'btn btn-depart btn-block default light-blue';
        loopBtn.style.width = '100%';

        const btnContent = document.createElement('div');
        btnContent.className = 'btn-content-wrapper fit-btn-text';
        btnContent.style.fontSize = '14px';
        btnContent.textContent = 'Depart Loop';

        loopBtn.appendChild(btnContent);
        loopBtn.onclick = () => running ? stop() : loop();

        wrapper.appendChild(loopBtn);
        buttonWrapper.appendChild(wrapper);
    }

    var addButtonTimer = null;

    function debouncedAddButton() {
        if (addButtonTimer) clearTimeout(addButtonTimer);
        addButtonTimer = setTimeout(function() {
            if (!document.querySelector('.buttonWrapper')) return;
            if (document.getElementById('depart-loop-btn')) return;
            addButton();
        }, 200);
    }

    var observer = new MutationObserver(debouncedAddButton);

    function attachObserver() {
        var sidebar = document.getElementById('mainSideBarContent');
        if (!sidebar) {
            setTimeout(attachObserver, 1000);
            return;
        }
        observer.observe(sidebar, { childList: true, subtree: true });
        debouncedAddButton();
    }
    attachObserver();
})();
