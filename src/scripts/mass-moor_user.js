// ==UserScript==
// @name         ShippingManager - Mass-Moore/Resume
// @namespace    http://tampermonkey.net/
// @version      4.34
// @description  Mass Moor and Resume vessels with checkbox selection
// @author       https://github.com/justonlyforyou/
// @order        13
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// ==/UserScript==
/* globals MutationObserver */

(function() {
    'use strict';

    var API_BASE = 'https://shippingmanager.cc/api';
    var DEBOUNCE_MS = 300;

    function log(msg, level) {
        var prefix = '[Fleet Manager] ';
        if (level === 'error') {
            console.error(prefix + msg);
        } else if (level === 'warn') {
            console.warn(prefix + msg);
        } else {
            console.log(prefix + msg);
        }
    }

    // State
    var selectedVessels = new Set();
    var vesselIdMap = new Map();
    var isProcessing = false;
    var mainObserver = null;
    var debounceTimer = null;
    var observerTarget = null;

    // Header cache for getCurrentTab()
    var headerCache = { text: '', timestamp: 0 };

    function getCurrentTab() {
        var now = Date.now();
        if (headerCache.text && now - headerCache.timestamp < 500) {
            return headerCache.text;
        }
        var listing = document.getElementById('notifications-vessels-listing');
        if (!listing) {
            headerCache.text = '';
            headerCache.timestamp = now;
            return '';
        }
        var result = '';
        if (document.getElementById('depart-all-btn')) {
            result = 'port';
        } else if (document.querySelector('.singleButtonWrapper')) {
            var firstNameEl = listing.querySelector('.vesselRow .vesselName .nameValue');
            if (firstNameEl) {
                var lookupName = sanitizeName(firstNameEl.textContent);
                var store = getVesselStore();
                if (store && store.userVessels) {
                    for (var idx = 0; idx < store.userVessels.length; idx++) {
                        if (store.userVessels[idx].name === lookupName) {
                            result = store.userVessels[idx].is_parked ? 'anchor' : 'enroute';
                            break;
                        }
                    }
                }
            }
            if (!result) result = 'enroute';
        }
        headerCache.text = result;
        headerCache.timestamp = now;
        return result;
    }

    // Sanitize vessel name from DOM
    function sanitizeName(text) {
        return text ? text.trim().replace(/[<>'"]/g, '') : '';
    }

    // ============================================
    // PINIA STORE ACCESS
    // ============================================
    function getPinia() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            return app._context.provides.pinia || app.config.globalProperties.$pinia;
        } catch {
            return null;
        }
    }

    function getToastStore() {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('toast');
        } catch {
            return null;
        }
    }

    function showToast(message, type) {
        type = type || 'success';
        var toastStore = getToastStore();
        if (toastStore) {
            try {
                if (type === 'error' && toastStore.error) {
                    toastStore.error(message);
                } else if (toastStore.success) {
                    toastStore.success(message);
                }
            } catch (err) {
                log('Toast error: ' + err.message, 'error');
            }
        }
    }

    // ============================================
    // API FUNCTIONS
    // ============================================
    async function parkVessel(vesselId) {
        if (!vesselId || typeof vesselId !== 'number') {
            throw new Error('Invalid vesselId: ' + vesselId);
        }
        var response = await fetch(API_BASE + '/vessel/park-vessel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ vessel_id: vesselId })
        });
        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }
        var data = await response.json();
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid response format');
        }
        return data;
    }

    async function resumeVessel(vesselId) {
        if (!vesselId || typeof vesselId !== 'number') {
            throw new Error('Invalid vesselId: ' + vesselId);
        }
        var response = await fetch(API_BASE + '/vessel/resume-parked-vessel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ vessel_id: vesselId })
        });
        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }
        var data = await response.json();
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid response format');
        }
        return data;
    }

    // ============================================
    // GET VESSEL STORE FROM PINIA
    // ============================================
    function getVesselStore() {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('vessel');
        } catch {
            return null;
        }
    }

    // ============================================
    // GET VESSEL BY ID
    // ============================================
    function getVesselById(vesselId) {
        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return null;
        for (var i = 0; i < vesselStore.userVessels.length; i++) {
            if (vesselStore.userVessels[i].id === vesselId) return vesselStore.userVessels[i];
        }
        return null;
    }

    // ============================================
    // GET VESSEL ID FROM ROW
    // ============================================
    function getVesselIdFromRow(row) {
        if (vesselIdMap.has(row)) {
            return vesselIdMap.get(row);
        }

        var nameEl = row.querySelector('.vesselName .nameValue');
        if (!nameEl) return null;
        var vesselName = sanitizeName(nameEl.textContent);
        if (!vesselName) return null;

        var vesselStore = getVesselStore();
        if (!vesselStore || !vesselStore.userVessels) return null;

        var headerText = getCurrentTab();
        var candidates;
        if (headerText === 'port') {
            candidates = vesselStore.userVessels.filter(function(v) { return v.status === 'port' && !v.is_parked; });
        } else if (headerText === 'anchor') {
            candidates = vesselStore.userVessels.filter(function(v) { return v.is_parked === true; });
        } else if (headerText === 'enroute') {
            candidates = vesselStore.userVessels.filter(function(v) { return v.status !== 'port' && !v.is_parked; });
        } else {
            candidates = vesselStore.userVessels;
        }

        var vessel = null;
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i].name === vesselName) {
                vessel = candidates[i];
                break;
            }
        }

        if (vessel && vessel.id) {
            vesselIdMap.set(row, vessel.id);
            return vessel.id;
        }

        return null;
    }

    // ============================================
    // UI INJECTION
    // ============================================
    function injectCheckboxes() {
        var vesselList = document.querySelector('#notifications-vessels-listing .vesselList');
        if (!vesselList) return;

        var headerText = getCurrentTab();
        if (!headerText) return;

        var isAtPort = headerText === 'port';
        var isAnchored = headerText === 'anchor';
        var isAtSea = headerText === 'enroute';

        if (!isAtPort && !isAnchored && !isAtSea) {
            var existingCbs = vesselList.querySelectorAll('.fleet-manager-checkbox');
            for (var r = 0; r < existingCbs.length; r++) existingCbs[r].remove();
            selectedVessels.clear();
            return;
        }

        var vesselStore = getVesselStore();
        var userVessels = vesselStore && vesselStore.userVessels ? vesselStore.userVessels : [];

        var filteredVessels;
        if (isAtPort) {
            filteredVessels = userVessels.filter(function(v) { return v.status === 'port' && !v.is_parked; });
        } else if (isAnchored) {
            filteredVessels = userVessels.filter(function(v) { return v.is_parked === true; });
        } else if (isAtSea) {
            filteredVessels = userVessels.filter(function(v) { return v.status !== 'port' && !v.is_parked; });
        } else {
            filteredVessels = userVessels;
        }
        var matchedIds = new Set();
        vesselIdMap.clear();

        var vesselRows = vesselList.querySelectorAll('.vesselRow');
        for (var i = 0; i < vesselRows.length; i++) {
            var row = vesselRows[i];
            var nameEl = row.querySelector('.vesselName .nameValue');
            if (!nameEl) continue;
            var vesselName = sanitizeName(nameEl.textContent);

            var vessel = null;
            for (var f = 0; f < filteredVessels.length; f++) {
                if (filteredVessels[f].name === vesselName && !matchedIds.has(filteredVessels[f].id)) {
                    vessel = filteredVessels[f];
                    break;
                }
            }
            if (vessel) {
                matchedIds.add(vessel.id);
                vesselIdMap.set(row, vessel.id);
            }
            var existingCheckbox = row.querySelector('.fleet-manager-checkbox');

            if (isAnchored && (!vessel || !vessel.is_parked)) {
                if (existingCheckbox) existingCheckbox.remove();
                continue;
            }

            if (existingCheckbox) continue;

            var checkboxWrapper = document.createElement('div');
            checkboxWrapper.className = 'fleet-manager-checkbox';

            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'fleet-manager-cb-input';

            checkbox.addEventListener('change', (function(currentRow) {
                return function(e) {
                    e.stopPropagation();
                    var vid = getVesselIdFromRow(currentRow);
                    if (vid) {
                        if (e.target.checked) {
                            selectedVessels.add(vid);
                        } else {
                            selectedVessels.delete(vid);
                        }
                        updateButtonStates();
                    }
                };
            })(row));

            checkbox.addEventListener('click', function(e) {
                e.stopPropagation();
            });

            checkboxWrapper.appendChild(checkbox);
            row.classList.add('with-checkbox');
            row.insertBefore(checkboxWrapper, row.firstChild);
        }
    }

    function injectButtons() {
        if (document.getElementById('fleet-manager-buttons')) return;

        if (!document.getElementById('fleet-manager-style')) {
            var style = document.createElement('style');
            style.id = 'fleet-manager-style';
            style.textContent = [
                '#notifications-vessels-listing { display: flex !important; flex-direction: column !important; overflow: hidden !important; }',
                '#notifications-vessels-listing .vesselList { flex: 1 !important; overflow-y: auto !important; min-height: 0 !important; }',
                '#notifications-vessels-listing .header-text { padding: 3px !important; flex-shrink: 0 !important; }',
                '.countdownBox { order: -1 !important; width: 100% !important; }',
                '.buttonWrapper { gap: 2px !important; padding: 2px !important; flex-shrink: 0 !important; }',
                '.singleButtonWrapper { flex-shrink: 0 !important; }',
                '#fleet-manager-buttons { background: var(--background-light) !important; padding: 2px !important; margin: 0 !important; }',
                '#fleet-manager-buttons .btn { min-height: 0 !important; padding-top: 2px !important; padding-bottom: 2px !important; }',
                '#depart-all-btn { margin: 0 !important; }',
                '.fleet-manager-checkbox { position: absolute !important; left: 8px !important; top: 50% !important; transform: translateY(-50%) !important; z-index: 100 !important; }',
                '.fleet-manager-cb-input { width: 18px; height: 18px; cursor: pointer; accent-color: #22c55e; }',
                '.vesselRow { position: relative !important; z-index: 1 !important; }',
                '.vesselRow.with-checkbox { padding-left: 40px !important; }',
                '.btn-disabled { opacity: 0.5 !important; cursor: not-allowed !important; }'
            ].join(' ');
            document.head.appendChild(style);
        }

        var container = null;
        var departBtn = document.getElementById('depart-all-btn');
        if (departBtn) {
            container = departBtn.closest('.buttonWrapper') || departBtn.parentNode;
        } else {
            container = document.querySelector('.singleButtonWrapper');
        }
        if (!container) return;

        var buttonContainer = document.createElement('div');
        buttonContainer.id = 'fleet-manager-buttons';
        buttonContainer.style.cssText = 'grid-column: 1 / -1; width: 100%; display: flex; gap: 2px; padding: 0; box-sizing: border-box; margin-bottom: 2px;';

        var allBtn = createButton('All', function() { selectAll(true); });
        allBtn.id = 'fleet-manager-all-btn';

        var noneBtn = createButton('None', function() { selectAll(false); });
        noneBtn.id = 'fleet-manager-none-btn';

        var moorBtn = createButton('Moor', function() {
            if (!moorBtn.disabled) processSelectedVessels('moor');
        });
        moorBtn.id = 'fleet-manager-moor-btn';
        moorBtn.disabled = true;
        moorBtn.classList.add('btn-disabled');

        var resumeBtn = createButton('Resume', function() {
            if (!resumeBtn.disabled) processSelectedVessels('resume');
        });
        resumeBtn.id = 'fleet-manager-resume-btn';
        resumeBtn.disabled = true;
        resumeBtn.classList.add('btn-disabled');

        buttonContainer.appendChild(allBtn);
        buttonContainer.appendChild(noneBtn);
        buttonContainer.appendChild(moorBtn);
        buttonContainer.appendChild(resumeBtn);

        container.insertBefore(buttonContainer, container.firstChild);
        log('Buttons injected');
    }

    function createButton(text, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-depart btn-block default light-blue';
        btn.style.cssText = 'flex: 1;';

        var btnContent = document.createElement('div');
        btnContent.className = 'btn-content-wrapper fit-btn-text';
        btnContent.style.fontSize = '14px';
        btnContent.textContent = text;

        btn.appendChild(btnContent);
        btn.addEventListener('click', onClick);
        return btn;
    }

    function updateButtonStates() {
        var moorBtn = document.getElementById('fleet-manager-moor-btn');
        var resumeBtn = document.getElementById('fleet-manager-resume-btn');

        var hasSelection = selectedVessels.size > 0;
        var shouldDisable = !hasSelection || isProcessing;

        if (moorBtn) {
            moorBtn.disabled = shouldDisable;
            if (shouldDisable) {
                moorBtn.classList.add('btn-disabled');
            } else {
                moorBtn.classList.remove('btn-disabled');
            }
        }
        if (resumeBtn) {
            resumeBtn.disabled = shouldDisable;
            if (shouldDisable) {
                resumeBtn.classList.add('btn-disabled');
            } else {
                resumeBtn.classList.remove('btn-disabled');
            }
        }
    }

    // ============================================
    // SELECTION FUNCTIONS
    // ============================================
    function selectAll(select) {
        var checkboxes = document.querySelectorAll('.fleet-manager-checkbox input[type="checkbox"]');
        for (var i = 0; i < checkboxes.length; i++) {
            checkboxes[i].checked = select;
            var row = checkboxes[i].closest('.vesselRow');
            var vid = getVesselIdFromRow(row);
            if (vid) {
                if (select) {
                    selectedVessels.add(vid);
                } else {
                    selectedVessels.delete(vid);
                }
            }
        }
        updateButtonStates();
    }

    function clearAllCheckboxes() {
        var checkboxes = document.querySelectorAll('.fleet-manager-checkbox input[type="checkbox"]');
        for (var i = 0; i < checkboxes.length; i++) {
            checkboxes[i].checked = false;
        }
        selectedVessels.clear();
        updateButtonStates();
    }

    // ============================================
    // PROCESS VESSELS
    // ============================================
    async function processSelectedVessels(action) {
        if (selectedVessels.size === 0) {
            showToast('No vessels selected', 'error');
            return;
        }

        if (isProcessing) return;

        isProcessing = true;
        updateButtonStates();

        var allVesselIds = [];
        selectedVessels.forEach(function(id) { allVesselIds.push(id); });
        var successCount = 0;
        var failedVessels = [];

        var vesselIds = allVesselIds.filter(function(vid) {
            var vessel = getVesselById(vid);
            if (!vessel) { return false; }
            if (action === 'resume' && vessel.is_parked !== true) { return false; }
            if (action === 'moor' && vessel.is_parked === true) { return false; }
            return true;
        });

        if (vesselIds.length === 0) {
            var actionText = action === 'moor' ? 'moor' : 'resume';
            showToast('No vessels to ' + actionText + ' (all skipped)', 'error');
            isProcessing = false;
            clearAllCheckboxes();
            updateButtonStates();
            return;
        }

        try {
            for (var i = 0; i < vesselIds.length; i++) {
                var vesselId = vesselIds[i];
                try {
                    if (action === 'moor') {
                        await parkVessel(vesselId);
                    } else {
                        await resumeVessel(vesselId);
                    }
                    successCount++;
                } catch (err) {
                    failedVessels.push({ id: vesselId, error: err.message });
                }

                if (i < vesselIds.length - 1) {
                    await new Promise(function(resolve) { setTimeout(resolve, 200); });
                }
            }

            var doneText = action === 'moor' ? 'Moored' : 'Resumed';
            if (successCount > 0) {
                showToast(doneText + ' ' + successCount + ' vessel(s)', 'success');
            }

            for (var f = 0; f < failedVessels.length; f++) {
                showToast('Vessel ' + failedVessels[f].id + ' failed: ' + failedVessels[f].error, 'error');
            }

            refreshVesselList();
        } catch (outerErr) {
            log('processSelectedVessels error: ' + outerErr.message, 'error');
            showToast('Error: ' + outerErr.message, 'error');
        } finally {
            isProcessing = false;
            clearAllCheckboxes();
            updateButtonStates();
        }
    }

    function refreshVesselList() {
        var vesselStore = getVesselStore();
        if (vesselStore && vesselStore.fetchUserVessels) {
            vesselStore.fetchUserVessels().then(function() {
                log('Refreshed vessel list');
                injectCheckboxes();
                updateButtonStates();
            });
        }
    }

    // ============================================
    // INITIALIZE - Observer + heartbeat fallback
    // ============================================
    var heartbeatTimer = null;
    var HEARTBEAT_MS = 2000;

    function attachObserver() {
        var ideal = document.getElementById('mainSideBarContent');
        var best = ideal || document.getElementById('app') || document.body;

        if (observerTarget === best && best.isConnected) return;

        if (mainObserver) mainObserver.disconnect();
        mainObserver = new MutationObserver(function() {
            debouncedInit();
        });
        mainObserver.observe(best, { childList: true, subtree: true });
        observerTarget = best;
    }

    function debouncedInit() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function() {
            attachObserver();
            injectCheckboxes();
            injectButtons();
        }, DEBOUNCE_MS);
    }

    // Heartbeat: lightweight periodic check that guarantees the UI
    // works even when the MutationObserver is dead (GeckoView/Android).
    // Only does querySelector checks - no API calls, no heavy work.
    function heartbeat() {
        // Reconnect observer if target died
        if (!observerTarget || !observerTarget.isConnected) {
            observerTarget = null;
            attachObserver();
        }

        var vesselList = document.querySelector('#notifications-vessels-listing .vesselList');
        if (!vesselList) return;

        var rows = vesselList.querySelectorAll('.vesselRow');
        if (rows.length === 0) return;

        // Always re-inject: handles new rows added after initial injection
        injectCheckboxes();
        injectButtons();
    }

    function startHeartbeat() {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    }

    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    function init() {
        attachObserver();
        debouncedInit();
        startHeartbeat();
    }

    // Pause on background, resume on foreground (Android GeckoView safe)
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            stopHeartbeat();
        } else {
            attachObserver();
            startHeartbeat();
            debouncedInit();
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
