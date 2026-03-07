// ==UserScript==
// @name         ShippingManager - Auto Happy Staff & Stuff Header Display (No-Points Edition)
// @namespace    http://tampermonkey.net/
// @description  Automatically manages staff salaries to maintain crew and management morale at target levels. DO NOT MIX WITH POINTS EDITION!
// @version      1.49
// @author       https://github.com/justonlyforyou/
// @order        5
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// @background-job-required true
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AutoHappyStaff';
    var STORE_NAME = 'data';

    var CHECK_INTERVAL = 15 * 60 * 1000;
    var API_BASE = 'https://shippingmanager.cc/api';

    var DEFAULT_SETTINGS = {
        enabled: false,
        targetMorale: 100,
        notifyIngame: true,
        notifySystem: false,
        happyThreshold: 75,
        neutralThreshold: 50,
        sadThreshold: 35,
        badThreshold: 25
    };

    var CREW_TYPES = ['captain', 'first_officer', 'boatswain', 'technical_officer'];
    var MANAGEMENT_TYPES = ['cfo', 'coo', 'cmo', 'cto'];

    var moraleDisplayElement = null;
    var crewSmileyElement = null;
    var managementSmileyElement = null;
    var displayRetries = 0;
    var isHappyModalOpen = false;
    var modalListenerAttached = false;

    var cachedSettings = null;
    var displayUpdateInterval = null;
    var menuClickListener = null;
    var headerResizeListener = null;
    var resizeDebounceTimer = null;
    var staffDataCache = null;
    var staffDataCacheTime = 0;
    var CACHE_DURATION = 5 * 60 * 1000;

    // ============================================
    // RebelShipBridge Storage Functions
    // ============================================

    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[AutoHappyStaff] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[AutoHappyStaff] dbSet error:', e);
            return false;
        }
    }

    // ============================================
    // Settings Storage
    // ============================================

    async function loadSettingsAsync() {
        try {
            var stored = await dbGet('settings');
            if (stored) {
                var result = {};
                for (var k in DEFAULT_SETTINGS) {
                    result[k] = stored[k] !== undefined ? stored[k] : DEFAULT_SETTINGS[k];
                }
                cachedSettings = result;
                return result;
            }
            cachedSettings = Object.assign({}, DEFAULT_SETTINGS);
            return cachedSettings;
        } catch (e) {
            console.error('[AutoHappyStaff] Failed to load settings:', e);
            cachedSettings = Object.assign({}, DEFAULT_SETTINGS);
            return cachedSettings;
        }
    }

    function loadSettings() {
        if (cachedSettings) {
            return cachedSettings;
        }
        return Object.assign({}, DEFAULT_SETTINGS);
    }

    async function saveSettings(settings) {
        cachedSettings = settings;
        try {
            await dbSet('settings', settings);
            console.log('[AutoHappyStaff] Settings saved');
        } catch (e) {
            console.error('[AutoHappyStaff] Failed to save settings:', e);
        }
    }

    // ============================================
    // HEADER SMILEY DISPLAY
    // ============================================

    /**
     * Wait for element to appear in DOM using MutationObserver
     */
    function waitForElement(selector, timeout) {
        timeout = timeout || 20000;
        return new Promise(function(resolve, reject) {
            var elapsed = 0;
            var interval = 500;
            function check() {
                var element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                    return;
                }
                elapsed += interval;
                if (elapsed >= timeout) {
                    reject(new Error('Element ' + selector + ' not found within timeout'));
                    return;
                }
                setTimeout(check, interval);
            }
            check();
        });
    }

    // Captain hat SVG (for management) - lighter blue for visibility
    var CAPTAIN_HAT_SVG = '<svg viewBox="0 0 24 12" width="18" height="9" style="position:absolute;top:-6px;left:50%;transform:translateX(-50%);"><path d="M4 10 L12 2 L20 10 L18 10 L12 5 L6 10 Z" fill="#4a7ab5"/><path d="M3 10 L21 10 L21 12 L3 12 Z" fill="#4a7ab5"/><circle cx="12" cy="7" r="2" fill="#ffd700"/></svg>';

    // Sailor hat SVG (for crew) - classic white sailor cap with blue band
    var SAILOR_HAT_SVG = '<svg viewBox="0 0 20 10" width="16" height="8" style="position:absolute;top:-5px;left:50%;transform:translateX(-50%);"><path d="M4 9 L4 6 Q10 3 16 6 L16 9 Z" fill="#ffffff" stroke="#1e3a5f" stroke-width="0.5"/><path d="M4 7 L16 7 L16 8 L4 8 Z" fill="#1e3a5f"/><ellipse cx="10" cy="9" rx="7" ry="1.5" fill="#ffffff" stroke="#1e3a5f" stroke-width="0.5"/></svg>';

    /**
     * Calculate smiley colors and mouth path from morale percentage
     */
    function calculateSmileyData(percentage, thresholds) {
        var t = thresholds;
        var faceColor = '';
        var glowColor = '';

        if (percentage >= t.happyThreshold) {
            faceColor = '#fbbf24';
            glowColor = 'rgba(251,191,36,0.6)';
        } else if (percentage >= t.neutralThreshold) {
            faceColor = '#e5e7eb';
            glowColor = '';
        } else if (percentage >= t.sadThreshold) {
            faceColor = '#9ca3af';
            glowColor = '';
        } else if (percentage >= t.badThreshold) {
            faceColor = '#f87171';
            glowColor = '';
        } else {
            faceColor = '#ef4444';
            glowColor = 'rgba(239,68,68,0.6)';
        }

        var mouthPath = '';
        if (percentage >= 70) {
            var smileCurve = 3 + Math.round((percentage - 70) / 30 * 3);
            mouthPath = 'M5 11 Q9 ' + (11 + smileCurve) + ' 13 11';
        } else if (percentage >= 50) {
            var slightSmile = Math.round((percentage - 50) / 20 * 3);
            mouthPath = 'M6 12 Q9 ' + (12 + slightSmile) + ' 12 12';
        } else if (percentage >= 35) {
            var slightFrown = Math.round((50 - percentage) / 15 * 2);
            mouthPath = 'M6 12 Q9 ' + (12 - slightFrown) + ' 12 12';
        } else if (percentage >= 20) {
            var sadCurve = 2 + Math.round((35 - percentage) / 15 * 3);
            mouthPath = 'M5 13 Q9 ' + (13 - sadCurve) + ' 13 13';
        } else {
            mouthPath = 'M5 14 Q9 8 13 14';
        }

        return {
            faceColor: faceColor,
            glowColor: glowColor,
            mouthPath: mouthPath
        };
    }

    /**
     * Create smiley SVG element
     */
    function createSmileyElement(hatType) {
        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:relative;display:inline-block;width:18px;height:18px;';

        var hatSvg = hatType === 'captain' ? CAPTAIN_HAT_SVG : SAILOR_HAT_SVG;
        wrapper.innerHTML = hatSvg;

        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 18 18');
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');

        var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '9');
        circle.setAttribute('cy', '9');
        circle.setAttribute('r', '8');
        circle.setAttribute('fill', '#e5e7eb');

        var leftEye = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        leftEye.setAttribute('cx', '6');
        leftEye.setAttribute('cy', '7');
        leftEye.setAttribute('r', '1.5');
        leftEye.setAttribute('fill', '#1f2937');

        var rightEye = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        rightEye.setAttribute('cx', '12');
        rightEye.setAttribute('cy', '7');
        rightEye.setAttribute('r', '1.5');
        rightEye.setAttribute('fill', '#1f2937');

        var mouth = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        mouth.setAttribute('d', 'M6 12 Q9 12 12 12');
        mouth.setAttribute('stroke', '#1f2937');
        mouth.setAttribute('stroke-width', '1.5');
        mouth.setAttribute('fill', 'none');
        mouth.setAttribute('stroke-linecap', 'round');

        svg.appendChild(circle);
        svg.appendChild(leftEye);
        svg.appendChild(rightEye);
        svg.appendChild(mouth);
        wrapper.appendChild(svg);

        wrapper._smileyCircle = circle;
        wrapper._smileyMouth = mouth;

        return wrapper;
    }

    /**
     * Update existing smiley element with new morale data
     */
    function updateSmileyElement(element, percentage, thresholds) {
        if (!element || !element._smileyCircle || !element._smileyMouth) {
            return;
        }

        var data = calculateSmileyData(percentage, thresholds);
        element._smileyCircle.setAttribute('fill', data.faceColor);

        if (data.glowColor) {
            element._smileyCircle.style.filter = 'drop-shadow(0 0 6px ' + data.glowColor + ')';
        } else {
            element._smileyCircle.style.filter = '';
        }

        element._smileyMouth.setAttribute('d', data.mouthPath);
    }

    /**
     * Create the morale display in the header
     */
    function createMoraleDisplay() {
        if (moraleDisplayElement) return moraleDisplayElement;

        var insertAfter = document.getElementById('reputation-display') ||
                          document.getElementById('coop-tickets-display') ||
                          document.querySelector('.content.led.cursor-pointer');

        if (!insertAfter || !insertAfter.parentNode) {
            return null;
        }

        moraleDisplayElement = document.createElement('div');
        moraleDisplayElement.id = 'morale-smiley-display';
        moraleDisplayElement.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:8px;cursor:pointer;';
        moraleDisplayElement.title = 'Staff Morale - Click to open settings';
        moraleDisplayElement.addEventListener('click', openSettingsModal);

        var mgmtContainer = document.createElement('div');
        mgmtContainer.style.cssText = 'display:flex;flex-direction:column;align-items:center;line-height:1;';
        var mgmtLabel = document.createElement('span');
        mgmtLabel.style.cssText = 'color:#9ca3af;margin-bottom:3px;font-size:12px;';
        mgmtLabel.textContent = 'Mgmt';
        managementSmileyElement = createSmileyElement('captain');
        managementSmileyElement.id = 'mgmt-smiley';
        updateSmileyElement(managementSmileyElement, 100, loadSettings());
        mgmtContainer.appendChild(mgmtLabel);
        mgmtContainer.appendChild(managementSmileyElement);

        var crewContainer = document.createElement('div');
        crewContainer.style.cssText = 'display:flex;flex-direction:column;align-items:center;line-height:1;';
        var crewLabel = document.createElement('span');
        crewLabel.style.cssText = 'color:#9ca3af;margin-bottom:3px;font-size:12px;';
        crewLabel.textContent = 'Crew';
        crewSmileyElement = createSmileyElement('sailor');
        crewSmileyElement.id = 'crew-smiley';
        updateSmileyElement(crewSmileyElement, 100, loadSettings());
        crewContainer.appendChild(crewLabel);
        crewContainer.appendChild(crewSmileyElement);

        moraleDisplayElement.appendChild(mgmtContainer);
        moraleDisplayElement.appendChild(crewContainer);

        insertAfter.parentNode.insertBefore(moraleDisplayElement, insertAfter.nextSibling);

        return moraleDisplayElement;
    }

    /**
     * Update the header smiley display with current morale values
     */
    async function updateMoraleDisplay() {
        var staffData = await fetchStaffData();
        if (!staffData || !staffData.info) {
            return;
        }

        var crewMorale = staffData.info.crew ? Math.round(parseFloat(staffData.info.crew.percentage)) : 0;
        var managementMorale = staffData.info.management ? Math.round(parseFloat(staffData.info.management.percentage)) : 0;
        var settings = loadSettings();

        if (!moraleDisplayElement) {
            createMoraleDisplay();
        }

        if (!moraleDisplayElement) {
            if (displayRetries < 10) {
                displayRetries++;
                try {
                    await waitForElement('#reputation-display, #coop-tickets-display, .content.led.cursor-pointer', 5000);
                    createMoraleDisplay();
                } catch {
                    console.log('[AutoHappyStaff] Could not find insertion point for morale display');
                    return;
                }
            }
            if (!moraleDisplayElement) return;
        }

        var thresholds = {
            happyThreshold: settings.happyThreshold,
            neutralThreshold: settings.neutralThreshold,
            sadThreshold: settings.sadThreshold,
            badThreshold: settings.badThreshold
        };

        if (managementSmileyElement) {
            updateSmileyElement(managementSmileyElement, managementMorale, thresholds);
            managementSmileyElement.title = 'Management: ' + managementMorale + '%';
        }

        if (crewSmileyElement) {
            updateSmileyElement(crewSmileyElement, crewMorale, thresholds);
            crewSmileyElement.title = 'Crew: ' + crewMorale + '%';
        }

    }

    // ============================================
    // PINIA STORE HELPERS
    // ============================================
    function getPinia() {
        var app = document.getElementById('app');
        if (!app || !app.__vue_app__) return null;
        return app.__vue_app__.config.globalProperties.$pinia;
    }

    function getModalStore() {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('modal');
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

    // ============================================
    // NOTIFICATIONS
    // ============================================
    function notify(message, type) {
        console.log('[AutoHappyStaff] ' + type.toUpperCase() + ': ' + message);

        var currentSettings = loadSettings();
        if (currentSettings.notifyIngame) {
            var toastStore = getToastStore();
            if (toastStore) {
                if (type === 'error' && toastStore.error) {
                    toastStore.error(message);
                } else if (toastStore.success) {
                    toastStore.success(message);
                }
            }
        }

        showSystemNotification(message);
    }

    function showSystemNotification(message) {
        var currentSettings = loadSettings();
        if (!currentSettings.notifySystem) {
            return;
        }

        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(SCRIPT_NAME + ': ' + message);
                console.log('[AutoHappyStaff] System notification sent');
                return;
            } catch (e) {
                console.log('[AutoHappyStaff] System notification failed: ' + e.message);
            }
        }

        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(SCRIPT_NAME, {
                        body: message,
                        icon: 'https://shippingmanager.cc/favicon.ico',
                        tag: 'autohappy'
                    });
                    console.log('[AutoHappyStaff] Web notification sent');
                } catch (e) {
                    console.log('[AutoHappyStaff] Web notification failed: ' + e.message);
                }
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(function(permission) {
                    if (permission === 'granted') {
                        showSystemNotification(message);
                    }
                });
            }
        }
    }

    // ============================================
    // API FUNCTIONS
    // ============================================
    async function fetchWithRetry(url, options, retries) {
        retries = retries || 3;
        for (var i = 0; i < retries; i++) {
            try {
                var response = await fetch(url, options);
                if (response.ok) return response;
                if (response.status >= 400 && response.status < 500) {
                    throw new Error('HTTP ' + response.status);
                }
            } catch (e) {
                if (i === retries - 1) throw e;
                if (e.message && e.message.indexOf('HTTP 4') === 0) throw e;
            }
            await new Promise(function(r) { setTimeout(r, 1000 * (i + 1)); });
        }
        throw new Error('Max retries exceeded');
    }

    async function fetchStaffData() {
        var now = Date.now();
        if (staffDataCache && (now - staffDataCacheTime) < CACHE_DURATION) {
            return staffDataCache;
        }

        try {
            var response = await fetchWithRetry(API_BASE + '/staff/get-user-staff', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({})
            });

            var data = await response.json();
            if (!data.data) {
                console.error('[AutoHappyStaff] Invalid staff response');
                return null;
            }

            staffDataCache = data.data;
            staffDataCacheTime = now;
            return data.data;
        } catch (e) {
            console.error('[AutoHappyStaff] fetchStaffData failed:', e);
            return null;
        }
    }

    async function raiseSalary(staffType) {
        try {
            var response = await fetchWithRetry(API_BASE + '/staff/raise-salary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ type: staffType })
            });

            var data = await response.json();
            staffDataCache = null;
            staffDataCacheTime = 0;
            return data;
        } catch (e) {
            console.error('[AutoHappyStaff] raiseSalary failed for ' + staffType + ':', e);
            return null;
        }
    }

    // ============================================
    // MAIN LOGIC
    // ============================================
    var isRunning = false;

    async function checkAndAdjustMorale(manual) {
        if (isRunning) {
            if (manual) notify('Already running, please wait', 'error');
            return;
        }

        var settings = loadSettings();
        if (!manual && !settings.enabled) {
            return;
        }

        isRunning = true;

        try {
            var staffData = await fetchStaffData();
            if (!staffData || !staffData.info) {
                console.log('[AutoHappyStaff] No staff data available');
                if (manual) notify('No staff data available', 'error');
                return;
            }

            var crewMorale = staffData.info.crew ? Math.round(parseFloat(staffData.info.crew.percentage)) : undefined;
            var managementMorale = staffData.info.management ? Math.round(parseFloat(staffData.info.management.percentage)) : undefined;
            var targetMorale = settings.targetMorale;
            var effectiveTarget = targetMorale === 100 ? 99 : targetMorale;


            if (crewMorale === undefined || managementMorale === undefined) {
                console.log('[AutoHappyStaff] Morale data not available');
                if (manual) notify('Morale data not available', 'error');
                return;
            }

            if (crewMorale >= effectiveTarget && managementMorale >= effectiveTarget) {
                if (manual) notify('Morale OK! Crew: ' + crewMorale + '%, Management: ' + managementMorale + '%', 'success');
                return;
            }

            var staffToAdjust = [];
            var raisedCount = 0;

            if (crewMorale < effectiveTarget && staffData.staff) {
                var crewStaff = staffData.staff.filter(function(s) {
                    return CREW_TYPES.indexOf(s.type) !== -1 && s.morale !== undefined;
                });
                staffToAdjust = staffToAdjust.concat(crewStaff);
            }

            if (managementMorale < effectiveTarget && staffData.staff) {
                var managementStaff = staffData.staff.filter(function(s) {
                    return MANAGEMENT_TYPES.indexOf(s.type) !== -1 && s.morale !== undefined;
                });
                staffToAdjust = staffToAdjust.concat(managementStaff);
            }

            if (staffToAdjust.length === 0) {
                if (manual) notify('No salary adjustment needed', 'success');
                return;
            }

            var MAX_RAISES_PER_STAFF = 50;

            for (var i = 0; i < staffToAdjust.length; i++) {
                var staff = staffToAdjust[i];
                var currentMorale = Math.round(staff.morale);
                var raiseCount = 0;


                while (currentMorale < effectiveTarget && raiseCount < MAX_RAISES_PER_STAFF) {
                    var result = await raiseSalary(staff.type);

                    if (result && result.data && result.data.staff) {
                        var newMorale = Math.round(result.data.staff.morale);
                        raiseCount++;
                        raisedCount++;


                        if (newMorale <= currentMorale) {
                            console.log('[AutoHappyStaff] ' + staff.type + ' morale not increasing, stopping raises');
                            break;
                        }

                        currentMorale = newMorale;
                    } else {
                        break;
                    }

                    await new Promise(function(resolve) { setTimeout(resolve, 500); });
                }

                if (currentMorale >= effectiveTarget) {
                } else {
                    console.log('[AutoHappyStaff] ' + staff.type + ' stopped at morale: ' + currentMorale + '% (raises: ' + raiseCount + ')');
                }
            }

            var updatedData = await fetchStaffData();
            if (updatedData && updatedData.info) {
                var newCrew = Math.round(parseFloat(updatedData.info.crew ? updatedData.info.crew.percentage : 0));
                var newManagement = Math.round(parseFloat(updatedData.info.management ? updatedData.info.management.percentage : 0));

                if (raisedCount > 0) {
                    var summary = 'Salaries adjusted. Crew: ' + newCrew + '%, Mgmt: ' + newManagement + '%';
                    notify(summary, 'success');
                    console.log('[AutoHappyStaff] ' + summary);
                } else if (manual) {
                    notify('Crew: ' + newCrew + '%, Mgmt: ' + newManagement + '%', 'success');
                }

                updateMoraleDisplay();
            }

        } catch (err) {
            console.error('[AutoHappyStaff] Error:', err);
            if (manual) notify('Error: ' + err.message, 'error');
        } finally {
            isRunning = false;
        }
    }

    // ============================================
    // MONITORING INTERVAL
    // ============================================
    var monitoringInterval = null;

    function startDisplayUpdates() {
        if (displayUpdateInterval) {
            clearInterval(displayUpdateInterval);
        }
        displayUpdateInterval = setInterval(updateMoraleDisplay, CHECK_INTERVAL);
    }

    function stopDisplayUpdates() {
        if (displayUpdateInterval) {
            clearInterval(displayUpdateInterval);
            displayUpdateInterval = null;
        }
    }

    function startMonitoring() {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
        }
        console.log('[AutoHappyStaff] Starting monitoring (interval: ' + CHECK_INTERVAL + 'ms)');
        monitoringInterval = setInterval(checkAndAdjustMorale, CHECK_INTERVAL);
    }

    function stopMonitoring() {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = null;
            console.log('[AutoHappyStaff] Stopped monitoring');
        }
        stopDisplayUpdates();
    }

    // ============================================
    // SETTINGS MODAL (Game-style custom modal)
    // ============================================

    function removeHappyModalStyles() {
        var style = document.getElementById('happy-modal-styles');
        if (style) {
            style.remove();
        }
    }

    function injectHappyModalStyles() {
        if (document.getElementById('happy-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'happy-modal-styles';
        style.textContent = [
            '@keyframes happy-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes happy-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes happy-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes happy-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#happy-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#happy-modal-wrapper #happy-modal-background{animation:happy-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#happy-modal-wrapper.hide #happy-modal-background{animation:happy-fade-out .15s linear forwards}',
            '#happy-modal-wrapper #happy-modal-content-wrapper{animation:happy-drop-down .15s linear forwards,happy-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#happy-modal-wrapper.hide #happy-modal-content-wrapper{animation:happy-push-up .15s linear forwards,happy-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#happy-modal-wrapper #happy-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#happy-modal-wrapper #happy-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#happy-modal-wrapper #happy-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#happy-modal-wrapper #happy-modal-content-wrapper{max-width:100%}}',
            '#happy-modal-wrapper #happy-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#happy-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#happy-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#happy-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#happy-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#happy-modal-container #happy-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#happy-modal-container #happy-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#happy-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeHappyModal() {
        if (!isHappyModalOpen) return;
        console.log('[AutoHappyStaff] Closing modal');
        isHappyModalOpen = false;
        var modalWrapper = document.getElementById('happy-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }

    function setupHappyModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        menuClickListener = function() {
            if (isHappyModalOpen) {
                console.log('[AutoHappyStaff] RebelShip menu clicked, closing modal');
                closeHappyModal();
            }
        };

        window.addEventListener('rebelship-menu-click', menuClickListener);
    }

    function openSettingsModal() {
        // Close any open game modal first
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectHappyModalStyles();

        var existing = document.getElementById('happy-modal-wrapper');
        if (existing) {
            var contentCheck = existing.querySelector('#happy-settings-content');
            if (contentCheck) {
                existing.classList.remove('hide');
                isHappyModalOpen = true;
                updateHappySettingsContent();
                return;
            }
            existing.remove();
        }

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'happy-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'happy-modal-background';
        modalBackground.onclick = function() { closeHappyModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'happy-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'happy-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Auto Happy Staff Settings';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeHappyModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeHappyModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'happy-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'happy-central-container';

        var settingsContent = document.createElement('div');
        settingsContent.id = 'happy-settings-content';
        centralContainer.appendChild(settingsContent);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isHappyModalOpen = true;
        updateHappySettingsContent();
    }

    function updateHappySettingsContent() {
        var settingsContent = document.getElementById('happy-settings-content');
        if (!settingsContent) return;

        var currentSettings = loadSettings();

        settingsContent.innerHTML = '\
            <div style="padding:20px;max-width:450px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;">\
                <div style="margin-bottom:20px;">\
                    <label style="display:flex;align-items:center;cursor:pointer;font-weight:700;font-size:16px;">\
                        <input type="checkbox" id="ah-enabled" ' + (currentSettings.enabled ? 'checked' : '') + '\
                               style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">\
                        <span>Enable Auto Happy Staff</span>\
                    </label>\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;margin-left:32px;">\
                        Automatically raises staff salaries when crew or management morale drops below the target level.\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <label style="display:block;font-weight:700;font-size:14px;margin-bottom:8px;">Target Morale</label>\
                    <select id="ah-target-morale" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box;">\
                        <option value="100" ' + (currentSettings.targetMorale === 100 ? 'selected' : '') + '>100%</option>\
                        <option value="90" ' + (currentSettings.targetMorale === 90 ? 'selected' : '') + '>90%</option>\
                        <option value="80" ' + (currentSettings.targetMorale === 80 ? 'selected' : '') + '>80%</option>\
                        <option value="70" ' + (currentSettings.targetMorale === 70 ? 'selected' : '') + '>70%</option>\
                        <option value="60" ' + (currentSettings.targetMorale === 60 ? 'selected' : '') + '>60%</option>\
                    </select>\
                    <div style="font-size:12px;color:#626b90;margin-top:6px;">\
                        Minimum happiness level to maintain for crew and management\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;">\
                    <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:#01125d;">Notifications</div>\
                    <div style="display:flex;gap:24px;">\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="ah-notify-ingame" ' + (currentSettings.notifyIngame ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">Ingame</span>\
                        </label>\
                        <label style="display:flex;align-items:center;cursor:pointer;">\
                            <input type="checkbox" id="ah-notify-system" ' + (currentSettings.notifySystem ? 'checked' : '') + '\
                                   style="width:18px;height:18px;margin-right:8px;accent-color:#0db8f4;cursor:pointer;">\
                            <span style="font-size:13px;">System</span>\
                        </label>\
                    </div>\
                </div>\
                <div style="margin-bottom:20px;padding:15px;background:#f0f4f8;border-radius:8px;">\
                    <label style="display:block;font-weight:700;font-size:14px;margin-bottom:12px;text-align:center;">Smiley Thresholds (Header Display)</label>\
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">\
                        <div style="text-align:center;">\
                            <label style="font-size:12px;color:#626b90;">Happy (yellow)</label>\
                            <div style="display:flex;align-items:center;justify-content:center;gap:4px;">\
                                <input type="number" id="ah-happy-threshold" value="' + currentSettings.happyThreshold + '" min="0" max="100"\
                                       style="width:60px;padding:6px;border:1px solid #ccc;border-radius:4px;font-size:13px;text-align:center;">\
                                <span style="font-size:12px;">%+</span>\
                            </div>\
                        </div>\
                        <div style="text-align:center;">\
                            <label style="font-size:12px;color:#626b90;">Neutral (gray)</label>\
                            <div style="display:flex;align-items:center;justify-content:center;gap:4px;">\
                                <input type="number" id="ah-neutral-threshold" value="' + currentSettings.neutralThreshold + '" min="0" max="100"\
                                       style="width:60px;padding:6px;border:1px solid #ccc;border-radius:4px;font-size:13px;text-align:center;">\
                                <span style="font-size:12px;">%+</span>\
                            </div>\
                        </div>\
                        <div style="text-align:center;">\
                            <label style="font-size:12px;color:#626b90;">Sad (dark gray)</label>\
                            <div style="display:flex;align-items:center;justify-content:center;gap:4px;">\
                                <input type="number" id="ah-sad-threshold" value="' + currentSettings.sadThreshold + '" min="0" max="100"\
                                       style="width:60px;padding:6px;border:1px solid #ccc;border-radius:4px;font-size:13px;text-align:center;">\
                                <span style="font-size:12px;">%+</span>\
                            </div>\
                        </div>\
                        <div style="text-align:center;">\
                            <label style="font-size:12px;color:#626b90;">Bad (red)</label>\
                            <div style="display:flex;align-items:center;justify-content:center;gap:4px;">\
                                <input type="number" id="ah-bad-threshold" value="' + currentSettings.badThreshold + '" min="0" max="100"\
                                       style="width:60px;padding:6px;border:1px solid #ccc;border-radius:4px;font-size:13px;text-align:center;">\
                                <span style="font-size:12px;">%+</span>\
                            </div>\
                        </div>\
                    </div>\
                    <div style="font-size:11px;color:#626b90;margin-top:8px;text-align:center;">\
                        Below Bad threshold = Critical (glowing red)\
                    </div>\
                </div>\
                <div style="display:flex;gap:12px;justify-content:space-between;margin-top:30px;">\
                    <button id="ah-run-now" style="padding:10px 24px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:500;">Run Now</button>\
                    <button id="ah-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;">Save</button>\
                </div>\
            </div>';

        var runNowBtn = document.getElementById('ah-run-now');
        var saveBtn = document.getElementById('ah-save');

        runNowBtn.onclick = async function() {
            this.disabled = true;
            this.textContent = 'Running...';
            await checkAndAdjustMorale(true);
            this.textContent = 'Run Now';
            this.disabled = false;
        };

        saveBtn.onclick = function() {
            var newSettings = {
                enabled: document.getElementById('ah-enabled').checked,
                targetMorale: parseInt(document.getElementById('ah-target-morale').value, 10) || 100,
                notifyIngame: document.getElementById('ah-notify-ingame').checked,
                notifySystem: document.getElementById('ah-notify-system').checked,
                happyThreshold: Math.max(0, Math.min(100, parseInt(document.getElementById('ah-happy-threshold').value, 10) || 75)),
                neutralThreshold: Math.max(0, Math.min(100, parseInt(document.getElementById('ah-neutral-threshold').value, 10) || 50)),
                sadThreshold: Math.max(0, Math.min(100, parseInt(document.getElementById('ah-sad-threshold').value, 10) || 35)),
                badThreshold: Math.max(0, Math.min(100, parseInt(document.getElementById('ah-bad-threshold').value, 10) || 25))
            };

            if (newSettings.notifySystem) {
                requestNotificationPermission();
            }

            saveSettings(newSettings);

            if (newSettings.enabled) {
                startMonitoring();
            } else {
                stopMonitoring();
            }

            updateMoraleDisplay();

            notify('Settings saved', 'success');
            closeHappyModal();
        };
    }

    // ============================================
    // INITIALIZATION
    // ============================================
    function requestNotificationPermission() {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().then(function() {
            });
        }
    }

    var uiInitialized = false;
    var uiRetryCount = 0;
    var MAX_UI_RETRIES = 30;

    function initUI() {
        if (uiInitialized) return;

        var hasApp = document.getElementById('app');
        if (!hasApp) {
            uiRetryCount++;
            if (uiRetryCount < MAX_UI_RETRIES) {
                setTimeout(initUI, 1000);
                return;
            }
            console.log('[AutoHappyStaff] Max retries reached, page might be in background mode');
            return;
        }

        uiInitialized = true;

        addMenuItem('Auto Happy Staff', openSettingsModal, 23);
    }

    async function init() {
        console.log('[AutoHappyStaff] Initializing...');

        // Register menu immediately for fast UI response
        initUI();

        var settings = await loadSettingsAsync();
        requestNotificationPermission();
        setupHappyModalWatcher();

        setTimeout(function() {
            createMoraleDisplay();
            updateMoraleDisplay();
            startDisplayUpdates();
        }, 3000);

        if (settings.enabled) {
            setTimeout(startMonitoring, 5000);
        }
    }

    // Cleanup function
    function cleanup() {
        stopMonitoring();
        stopDisplayUpdates();
        removeHappyModalStyles();

        if (menuClickListener) {
            window.removeEventListener('rebelship-menu-click', menuClickListener);
            menuClickListener = null;
        }

        if (headerResizeListener) {
            window.removeEventListener('rebelship-header-resize', headerResizeListener);
            headerResizeListener = null;
        }

        if (moraleDisplayElement && moraleDisplayElement.parentNode) {
            moraleDisplayElement.removeEventListener('click', openSettingsModal);
            moraleDisplayElement.parentNode.removeChild(moraleDisplayElement);
            moraleDisplayElement = null;
        }

        crewSmileyElement = null;
        managementSmileyElement = null;

        console.log('[AutoHappyStaff] Cleanup complete');
    }

    // Expose for Android BackgroundScriptService
    window.rebelshipRunAutoHappyStaff = async function() {
        var settings = loadSettings();
        if (!settings.enabled) {
            return { skipped: true, reason: 'disabled' };
        }
        await checkAndAdjustMorale();
        return { success: true };
    };

    // Expose cleanup for manual cleanup
    window.rebelshipCleanupAutoHappyStaff = cleanup;

    // Listen for header resize event to reinitialize display
    headerResizeListener = function() {
        if (resizeDebounceTimer) {
            clearTimeout(resizeDebounceTimer);
        }
        resizeDebounceTimer = setTimeout(function() {
            moraleDisplayElement = null;
            crewSmileyElement = null;
            managementSmileyElement = null;
            displayRetries = 0;
            createMoraleDisplay();
            updateMoraleDisplay();
        }, 300);
    };

    window.addEventListener('rebelship-header-resize', headerResizeListener);

    if (!window.__rebelshipHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    // Register for background job system
    window.rebelshipBackgroundJobs = window.rebelshipBackgroundJobs || [];
    window.rebelshipBackgroundJobs.push({
        name: 'AutoHappyStaff',
        run: async function() { return await window.rebelshipRunAutoHappyStaff(); }
    });
})();
