// ==UserScript==
// @name         ShippingManager - Port Updates
// @namespace    http://tampermonkey.net/
// @description  !ports chatbot command with daily auto-post of alliance port rankings
// @version      1.0
// @order        24
// @author       PiratesTreasure
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @RequirePiratesTreasureMenu true
// @RequirePiratesTreasureStorage true
// @background-job-required true
// @enabled      false
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'PortUpdates';
    var STORE_NAME = 'data';
    var LOG_PREFIX = '[PortUpdates]';

    var DEFAULT_SETTINGS = {
        enabled: false,
        autoPostEnabled: false,
        rankThreshold: 10
    };

    var settings = null;
    var isModalOpen = false;

    // ============================================
    // STORAGE
    // ============================================
    async function dbGet(key) {
        if (!window.PiratesTreasureBridge || !window.PiratesTreasureBridge.storage) return null;
        try {
            var value = await window.PiratesTreasureBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            return value ? JSON.parse(value) : null;
        } catch (e) {
            log('dbGet error: ' + e.message, 'error');
            return null;
        }
    }

    async function dbSet(key, value) {
        if (!window.PiratesTreasureBridge || !window.PiratesTreasureBridge.storage) return false;
        try {
            await window.PiratesTreasureBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            log('dbSet error: ' + e.message, 'error');
            return false;
        }
    }

    // ============================================
    // SETTINGS
    // ============================================
    async function loadSettings() {
        var saved = await dbGet('settings');
        settings = {};
        for (var key in DEFAULT_SETTINGS) {
            settings[key] = DEFAULT_SETTINGS[key];
        }
        if (saved) {
            for (var savedKey in saved) {
                settings[savedKey] = saved[savedKey];
            }
        }
        return settings;
    }

    async function saveSettings() {
        await dbSet('settings', settings);
    }

    // ============================================
    // LOGGING
    // ============================================
    function log(msg, level) {
        if (level === 'error') {
            console.error(LOG_PREFIX + ' ' + msg);
        } else {
            console.log(LOG_PREFIX + ' ' + msg);
        }
    }

    // ============================================
    // RANKING DATA (fetches from GitHub)
    // ============================================
    var GITHUB_DATA_URL = 'https://raw.githubusercontent.com/PiratesTreasure/pirate-dashboard/main/public/port_data.json';

    async function getRankingData() {
        try {
            var response = await fetch(GITHUB_DATA_URL, { cache: 'no-store' });
            if (!response.ok) {
                log('GitHub fetch failed: ' + response.status, 'error');
                return null;
            }
            return await response.json();
        } catch (e) {
            log('Failed to fetch ranking data: ' + e.message, 'error');
            return null;
        }
    }

    // ============================================
    // FORMAT PORT UPDATE MESSAGE (pirate themed)
    // ============================================
    function capitalizePortName(code) {
        return code.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }

    function getMovementStr(rankChange) {
        if (rankChange == null) return ' NEW';
        // rank_change is current - previous, so negative means improved
        if (rankChange < 0) return ' \u25B2' + (Math.abs(rankChange) > 1 ? Math.abs(rankChange) : '');  // ▲ or ▲N
        if (rankChange > 0) return ' \u25BC' + (rankChange > 1 ? rankChange : '');  // ▼ or ▼N
        return '';
    }

    function formatPortUpdateMessage(rankingData, threshold) {
        if (!rankingData || !rankingData.ports || !rankingData.ports.length) return null;

        var allPorts = rankingData.ports;

        // Filter to ports within threshold
        var entries = [];
        for (var i = 0; i < allPorts.length; i++) {
            var p = allPorts[i];
            if (p.rank != null && p.rank <= threshold) {
                entries.push({
                    code: p.port_code,
                    name: p.port_name || capitalizePortName(p.port_code),
                    rank: p.rank,
                    rankChange: p.rank_change
                });
            }
        }

        if (entries.length === 0) return null;

        entries.sort(function(a, b) { return a.rank - b.rank || a.name.localeCompare(b.name); });

        // Count stats
        var rank1Count = 0;
        var top3Count = 0;
        var top10Count = 0;
        var improved = 0;
        var dropped = 0;

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.rank === 1) rank1Count++;
            if (e.rank <= 3) top3Count++;
            if (e.rank <= 10) top10Count++;
            if (e.rankChange != null) {
                if (e.rankChange < 0) improved++;
                else if (e.rankChange > 0) dropped++;
            }
        }

        // Group by rank tiers
        var rank1Ports = entries.filter(function(e) { return e.rank === 1; });
        var rank2Ports = entries.filter(function(e) { return e.rank === 2; });
        var rank3Ports = entries.filter(function(e) { return e.rank === 3; });
        var chasingPorts = entries.filter(function(e) { return e.rank >= 4 && e.rank <= 5; });
        var midTablePorts = entries.filter(function(e) { return e.rank >= 6 && e.rank <= 7; });
        var top10Ports = entries.filter(function(e) { return e.rank >= 8 && e.rank <= 10; });

        var lines = [];

        // Header
        lines.push('\u2693 Daily Port Update \u2693');
        lines.push('');

        // Overview
        lines.push('\uD83D\uDCCA Current Overview');
        lines.push(allPorts.length + ' ports tracked');
        lines.push('\uD83E\uDD47 ' + rank1Count + ' Rank 1 ports');
        lines.push('\uD83C\uDFC5 ' + top3Count + ' Top 3 ports');
        lines.push('\uD83D\uDD1F ' + top10Count + ' Top 10 ports');
        if (improved > 0 || dropped > 0) {
            if (improved > 0) lines.push('\uD83D\uDCC8 ' + improved + ' improved \u2B06\uFE0F');
            if (dropped > 0) lines.push('\uD83D\uDCC9 ' + dropped + ' dropped \u2B07\uFE0F');
        }

        // Rank 1
        if (rank1Ports.length > 0) {
            lines.push('');
            lines.push('\uD83C\uDFC6 Rank 1 Ports');
            for (var r1 = 0; r1 < rank1Ports.length; r1++) {
                var p1 = rank1Ports[r1];
                lines.push(p1.name + getMovementStr(p1.rankChange));
            }
        }

        // Rank 2
        if (rank2Ports.length > 0) {
            lines.push('');
            lines.push('\uD83E\uDD48 Rank 2 Ports');
            for (var r2 = 0; r2 < rank2Ports.length; r2++) {
                var p2 = rank2Ports[r2];
                lines.push(p2.name + getMovementStr(p2.rankChange));
            }
        }

        // Rank 3
        if (rank3Ports.length > 0) {
            lines.push('');
            lines.push('\uD83E\uDD49 Rank 3 Ports');
            for (var r3 = 0; r3 < rank3Ports.length; r3++) {
                var p3 = rank3Ports[r3];
                lines.push(p3.name + getMovementStr(p3.rankChange));
            }
        }

        // Chasing the Top (4-5)
        if (chasingPorts.length > 0) {
            lines.push('');
            lines.push('\uD83D\uDCCD Chasing the Top');
            for (var c = 0; c < chasingPorts.length; c++) {
                var pc = chasingPorts[c];
                lines.push(pc.rank + ' \u2014 ' + pc.name + getMovementStr(pc.rankChange));
            }
        }

        // Mid Table (6-7)
        if (midTablePorts.length > 0) {
            lines.push('');
            lines.push('\uD83D\uDCCD Mid Table Movement');
            for (var m = 0; m < midTablePorts.length; m++) {
                var pm = midTablePorts[m];
                lines.push(pm.rank + ' \u2014 ' + pm.name + getMovementStr(pm.rankChange));
            }
        }

        // Top 10 Battle (8-10)
        if (top10Ports.length > 0) {
            lines.push('');
            lines.push('\uD83D\uDCCD Top 10 Battle');
            for (var t = 0; t < top10Ports.length; t++) {
                var pt = top10Ports[t];
                lines.push(pt.rank + ' \u2014 ' + pt.name + getMovementStr(pt.rankChange));
            }
        }

        return lines.join('\n');
    }

    // ============================================
    // COMMAND HANDLER (!ports)
    // ============================================
    async function handlePortsCommand(args, userId, userName, isDm, sendResponse) {
        if (!settings || !settings.enabled) return;

        var rankingData = await getRankingData();
        if (!rankingData) {
            await sendResponse('No port ranking data available. Make sure the Alliance Tracker has run.', userId, isDm);
            return;
        }

        var threshold = settings.rankThreshold || 10;
        var message = formatPortUpdateMessage(rankingData, threshold);
        if (!message) {
            await sendResponse('No ports found where the alliance ranks in the top ' + threshold + '.', userId, isDm);
            return;
        }

        await sendResponse(message, userId, isDm);
    }

    // ============================================
    // AUTO DAILY POST
    // ============================================
    async function checkAndAutoPost() {
        if (!settings || !settings.enabled || !settings.autoPostEnabled) return;

        if (!window.PiratesTreasureChatBot || !window.PiratesTreasureChatBot.isEnabled()) {
            log('ChatBot not available or not enabled, skipping auto-post');
            return;
        }

        var rankingData = await getRankingData();
        if (!rankingData || !rankingData.updated) {
            log('No ranking data for auto-post');
            return;
        }

        // Check if the ranking data timestamp has changed since last post
        var lastPostedTimestamp = await dbGet('lastPostedRankingTimestamp');
        if (lastPostedTimestamp === rankingData.updated) {
            log('Ranking data unchanged (timestamp: ' + rankingData.updated + '), skipping auto-post');
            return;
        }

        var threshold = settings.rankThreshold || 10;
        var message = formatPortUpdateMessage(rankingData, threshold);
        if (!message) {
            log('No qualifying ports for auto-post');
            return;
        }

        try {
            var sent = await window.PiratesTreasureChatBot.sendAllianceMessage(message);
            if (sent !== false) {
                await dbSet('lastPostedRankingTimestamp', rankingData.updated);
                log('Auto-posted port update (new ranking timestamp: ' + rankingData.updated + ')');
            } else {
                log('Failed to send auto-post', 'error');
            }
        } catch (e) {
            log('Auto-post error: ' + e.message, 'error');
        }
    }

    // ============================================
    // REGISTER COMMAND
    // ============================================
    function registerPortsCommand() {
        if (!window.PiratesTreasureChatBot) {
            log('ChatBot not available, retrying in 5s...');
            setTimeout(registerPortsCommand, 5000);
            return;
        }

        window.PiratesTreasureChatBot.registerCommand('ports', handlePortsCommand, {
            description: 'Show daily alliance port rankings update',
            usage: '!ports \u2014 Shows pirate port rankings with movement tracking',
            minRole: 'all'
        });

        log('Registered !ports command');
    }

    // ============================================
    // SETTINGS MODAL
    // ============================================
    function openSettingsModal() {
        if (isModalOpen) return;
        isModalOpen = true;

        if (window.PiratesTreasureModalRegistry) {
            window.PiratesTreasureModalRegistry.register('PortUpdates');
        }

        var overlay = document.createElement('div');
        overlay.id = 'port-updates-modal-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:12px;padding:24px;min-width:360px;max-width:450px;color:#fff;font-family:sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

        var title = document.createElement('div');
        title.style.cssText = 'font-size:18px;font-weight:bold;margin-bottom:16px;color:#f59e0b;';
        title.textContent = '\u2693 Port Updates Settings';
        modal.appendChild(title);

        // Enabled toggle
        var enabledRow = createToggleRow('Enable Port Updates', settings.enabled, function(val) {
            settings.enabled = val;
        });
        modal.appendChild(enabledRow);

        // Auto-post toggle
        var autoPostRow = createToggleRow('Daily Auto-Post', settings.autoPostEnabled, function(val) {
            settings.autoPostEnabled = val;
        });
        modal.appendChild(autoPostRow);

        // Rank threshold
        var thresholdRow = document.createElement('div');
        thresholdRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding:8px 0;';

        var thresholdLabel = document.createElement('span');
        thresholdLabel.style.cssText = 'font-size:14px;color:#d1d5db;';
        thresholdLabel.textContent = 'Rank Threshold (Top N)';
        thresholdRow.appendChild(thresholdLabel);

        var thresholdInput = document.createElement('input');
        thresholdInput.type = 'number';
        thresholdInput.min = '1';
        thresholdInput.max = '50';
        thresholdInput.value = settings.rankThreshold;
        thresholdInput.style.cssText = 'width:60px;padding:4px 8px;background:#374151;border:1px solid #4b5563;border-radius:6px;color:#fff;font-size:14px;text-align:center;';
        thresholdInput.addEventListener('change', function() {
            var val = parseInt(thresholdInput.value);
            if (!isNaN(val) && val >= 1 && val <= 50) {
                settings.rankThreshold = val;
            }
        });
        thresholdRow.appendChild(thresholdInput);
        modal.appendChild(thresholdRow);

        // Info text
        var info = document.createElement('div');
        info.style.cssText = 'font-size:11px;color:#6b7280;margin-top:8px;margin-bottom:16px;';
        info.textContent = 'Reads ranking data from the Alliance Tracker. ChatBot must be enabled for auto-post. Movement arrows compare against previous run.';
        modal.appendChild(info);

        // Buttons
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = 'padding:6px 16px;background:#374151;border:1px solid #4b5563;border-radius:6px;color:#d1d5db;cursor:pointer;font-size:13px;';
        closeBtn.addEventListener('click', function() {
            closeModal();
        });
        btnRow.appendChild(closeBtn);

        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.style.cssText = 'padding:6px 16px;background:linear-gradient(180deg,#f59e0b,#d97706);border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;font-weight:bold;';
        saveBtn.addEventListener('click', function() {
            saveSettings();
            closeModal();
            log('Settings saved');
        });
        btnRow.appendChild(saveBtn);

        modal.appendChild(btnRow);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) closeModal();
        });

        function closeModal() {
            var el = document.getElementById('port-updates-modal-overlay');
            if (el) el.remove();
            isModalOpen = false;
            if (window.PiratesTreasureModalRegistry) {
                window.PiratesTreasureModalRegistry.unregister('PortUpdates');
            }
        }
    }

    function createToggleRow(label, initialValue, onChange) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding:8px 0;';

        var labelEl = document.createElement('span');
        labelEl.style.cssText = 'font-size:14px;color:#d1d5db;';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        var toggle = document.createElement('div');
        toggle.style.cssText = 'width:44px;height:24px;border-radius:12px;cursor:pointer;position:relative;transition:background 0.2s;' +
            (initialValue ? 'background:#f59e0b;' : 'background:#4b5563;');

        var knob = document.createElement('div');
        knob.style.cssText = 'width:20px;height:20px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left 0.2s;' +
            (initialValue ? 'left:22px;' : 'left:2px;');
        toggle.appendChild(knob);

        var state = initialValue;
        toggle.addEventListener('click', function() {
            state = !state;
            toggle.style.background = state ? '#f59e0b' : '#4b5563';
            knob.style.left = state ? '22px' : '2px';
            onChange(state);
        });

        row.appendChild(toggle);
        return row;
    }

    // ============================================
    // BACKGROUND JOB (auto-post check)
    // ============================================
    function registerBackgroundJob() {
        if (!window.PiratesTreasureBridge || !window.PiratesTreasureBridge.registerBackgroundJob) return;

        window.PiratesTreasureBridge.registerBackgroundJob({
            name: SCRIPT_NAME,
            intervalMinutes: 30,
            run: async function() {
                try {
                    if (!settings) await loadSettings();
                    await checkAndAutoPost();
                } catch (e) {
                    log('Background job error: ' + e.message, 'error');
                    return { success: false, error: e.message };
                }
                return { success: true };
            }
        });

        log('Background job registered');
    }

    // ============================================
    // INIT
    // ============================================
    async function init() {
        await loadSettings();

        if (typeof addMenuItem === 'function') {
            addMenuItem('Port Updates', openSettingsModal, 26);
        }

        registerPortsCommand();
        registerBackgroundJob();

        // Check for auto-post on init (delayed to let ChatBot initialize)
        setTimeout(function() {
            checkAndAutoPost();
        }, 15000);

        log('Port Updates initialized');
    }

    if (!window.__piratestreasureHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    } else {
        registerBackgroundJob();
    }
})();
