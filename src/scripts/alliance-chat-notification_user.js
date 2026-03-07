// ==UserScript==
// @name        ShippingManager - Alliance Chat Notification
// @description Shows a red dot on Alliance button when there are unread messages
// @version     2.27
// @author      https://github.com/justonlyforyou/
// @order        17
// @match       https://shippingmanager.cc/*
// @run-at      document-end
// @grant       none
// @enabled     false
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// @background-job-required true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AllianceChatNotify';
    var STORE_NAME = 'data';

    var CHECK_INTERVAL = 30000; // Check every 30 seconds
    var MARK_READ_DELAY = 3000; // 3 seconds before marking as read
    var lastReadTimestamp = 0;
    var newestMessageTimestamp = 0;
    var markReadTimeout = null;
    var hasUnread = false;
    var isChatTabActive = false;

    // Cleanup references
    var dotObserver = null;
    var modalObserver = null;
    var clickHandler = null;

    // Settings
    var settings = {
        inAppAlerts: true,
        desktopNotifications: true
    };

    function log(msg) {
        console.log('[AllianceChatNotify] ' + msg);
    }

    // ============================================
    // Utility Functions
    // ============================================

    // Debounce function to limit execution frequency
    function debounce(func, wait) {
        var timeout;
        return function() {
            var context = this;
            var args = arguments;
            clearTimeout(timeout);
            timeout = setTimeout(function() {
                func.apply(context, args);
            }, wait);
        };
    }

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
            console.error('[AllianceChatNotify] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[AllianceChatNotify] dbSet error:', e);
            return false;
        }
    }

    // ============================================
    // Settings Functions
    // ============================================

    async function loadSettings() {
        var stored = await dbGet('settings');
        if (stored) {
            if (typeof stored.inAppAlerts === 'boolean') settings.inAppAlerts = stored.inAppAlerts;
            if (typeof stored.desktopNotifications === 'boolean') settings.desktopNotifications = stored.desktopNotifications;
        }
    }

    async function saveSettings() {
        await dbSet('settings', settings);
    }

    // ============================================
    // Notification Functions
    // ============================================

    function showToast(message, type) {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return;
            var toastStore = pinia._s.get('toast');
            if (toastStore && toastStore.addToast) {
                toastStore.addToast({ message: message, type: type || 'info' });
            }
        } catch (e) {
            log('showToast error: ' + e.message);
        }
    }

    function sendSystemNotification(title, message) {
        if (!settings.desktopNotifications) return;

        if (typeof window.RebelShipNotify !== 'undefined' && window.RebelShipNotify.notify) {
            try {
                window.RebelShipNotify.notify(title + ': ' + message);
                return;
            } catch (e) {
                log('RebelShipNotify failed: ' + e.message);
            }
        }

        if ('Notification' in window) {
            if (Notification.permission === 'granted') {
                try {
                    new Notification(title, {
                        body: message,
                        icon: 'https://shippingmanager.cc/favicon.ico',
                        tag: 'alliance-chat'
                    });
                } catch (e) {
                    log('Web notification failed: ' + e.message);
                }
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(function(permission) {
                    if (permission === 'granted') {
                        sendSystemNotification(title, message);
                    }
                });
            }
        }
    }

    // ============================================
    // Settings Modal
    // ============================================

    function openSettingsModal() {
        var existing = document.getElementById('acn-settings-wrapper');
        if (existing) existing.remove();

        var wrapper = document.createElement('div');
        wrapper.id = 'acn-settings-wrapper';
        wrapper.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:100001;display:flex;align-items:center;justify-content:center;';

        var bg = document.createElement('div');
        bg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);';
        bg.addEventListener('click', function() { wrapper.remove(); });
        wrapper.appendChild(bg);

        var contentWrapper = document.createElement('div');
        contentWrapper.style.cssText = 'position:relative;z-index:1;animation:acn-fade-in 0.2s ease-out;';
        wrapper.appendChild(contentWrapper);

        var container = document.createElement('div');
        container.style.cssText = 'background:#c6cbdb;border-radius:12px;overflow:hidden;width:400px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
        contentWrapper.appendChild(container);

        // Header
        var header = document.createElement('div');
        header.style.cssText = 'background:#626b90;color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;';
        header.innerHTML = '<span style="font-size:18px;font-weight:700;">Chat Notification</span>';
        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'X';
        closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0;width:30px;height:30px;';
        closeBtn.addEventListener('click', function() { wrapper.remove(); });
        header.appendChild(closeBtn);
        container.appendChild(header);

        // Content
        var content = document.createElement('div');
        content.style.cssText = 'flex:1;overflow-y:auto;padding:0;';
        container.appendChild(content);

        var central = document.createElement('div');
        central.style.cssText = 'background:#e9effd;margin:16px;border-radius:8px;padding:20px;';
        content.appendChild(central);

        central.innerHTML =
            '<div style="margin-bottom:16px;">' +
                '<label style="display:flex;align-items:center;cursor:pointer;">' +
                    '<input type="checkbox" id="acn-inapp"' + (settings.inAppAlerts ? ' checked' : '') +
                    ' style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">' +
                    '<span style="font-weight:600;">Ingame Toast Notifications</span>' +
                '</label>' +
                '<div style="font-size:12px;color:#666;margin-top:4px;margin-left:32px;">Show toast when new alliance chat messages arrive</div>' +
            '</div>' +
            '<div style="margin-bottom:20px;">' +
                '<label style="display:flex;align-items:center;cursor:pointer;">' +
                    '<input type="checkbox" id="acn-desktop"' + (settings.desktopNotifications ? ' checked' : '') +
                    ' style="width:20px;height:20px;margin-right:12px;accent-color:#0db8f4;cursor:pointer;">' +
                    '<span style="font-weight:600;">System Notifications</span>' +
                '</label>' +
                '<div style="font-size:12px;color:#666;margin-top:4px;margin-left:32px;">Desktop / Android push notification for new messages</div>' +
            '</div>' +
            '<div style="text-align:center;">' +
                '<button id="acn-save" style="padding:10px 24px;background:linear-gradient(180deg,#46ff33,#129c00);border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;">Save</button>' +
            '</div>';

        // Save handler
        setTimeout(function() {
            var saveBtn = document.getElementById('acn-save');
            if (saveBtn) {
                saveBtn.addEventListener('click', function() {
                    settings.inAppAlerts = document.getElementById('acn-inapp').checked;
                    settings.desktopNotifications = document.getElementById('acn-desktop').checked;
                    saveSettings();
                    showToast('Chat Notification settings saved', 'success');
                    wrapper.remove();
                });
            }
        }, 0);

        // Animation CSS
        var style = document.createElement('style');
        style.textContent = '@keyframes acn-fade-in { from { opacity:0; transform:scale(0.95); } to { opacity:1; transform:scale(1); } }';
        wrapper.appendChild(style);

        document.body.appendChild(wrapper);
    }

    // ============================================
    // Load/Save Functions
    // ============================================

    // Load last read timestamp from Bridge DB + localStorage (dual source)
    async function loadLastRead() {
        var fromLocalStorage = 0;
        var fromBridge = 0;

        // 1. Read from localStorage (always available, synchronous)
        try {
            var lsValue = localStorage.getItem('acn_lastRead');
            if (lsValue) {
                fromLocalStorage = parseInt(lsValue, 10) || 0;
            }
            // Also check crash-recovery key
            var pending = localStorage.getItem('acn_pendingLastRead');
            if (pending) {
                var recovered = parseInt(JSON.parse(pending), 10) || 0;
                localStorage.removeItem('acn_pendingLastRead');
                if (recovered > fromLocalStorage) {
                    fromLocalStorage = recovered;
                }
            }
        } catch { /* ignore localStorage errors */ }

        // 2. Read from Bridge storage
        try {
            var stored = await dbGet('lastRead');
            if (stored) {
                fromBridge = parseInt(stored, 10) || 0;
            }
        } catch (e) {
            log('Bridge dbGet lastRead failed: ' + e.message);
        }

        // Use whichever is newer
        lastReadTimestamp = Math.max(fromLocalStorage, fromBridge);
        log('loadLastRead: localStorage=' + fromLocalStorage + ' bridge=' + fromBridge + ' using=' + lastReadTimestamp);

        // Sync: if localStorage has newer value, push to Bridge
        if (fromLocalStorage > fromBridge) {
            dbSet('lastRead', fromLocalStorage).catch(function() {});
        }
        // If Bridge has newer value, push to localStorage
        if (fromBridge > fromLocalStorage) {
            try { localStorage.setItem('acn_lastRead', String(fromBridge)); } catch {}
        }
    }

    // Save last read timestamp to BOTH Bridge DB and localStorage
    async function saveLastRead(timestamp) {
        if (!timestamp || timestamp <= 0) return;
        lastReadTimestamp = timestamp;
        hasUnread = false;
        updateNotificationDots();

        // 1. localStorage first (synchronous, always works)
        try {
            localStorage.setItem('acn_lastRead', String(timestamp));
        } catch { /* ignore */ }

        // 2. Bridge storage (async, may fail silently)
        try {
            var ok = await dbSet('lastRead', timestamp);
            log('saveLastRead: ' + timestamp + ' bridge=' + (ok ? 'ok' : 'FAIL'));
        } catch (e) {
            log('saveLastRead bridge error: ' + e.message);
        }
    }

    // ============================================
    // Notification Dot Functions
    // ============================================

    // Create notification dot on an element
    function createDot(parent, id) {
        if (!parent) return null;

        var existing = document.getElementById(id);
        if (existing) {
            existing.remove();
        }

        // Make sure parent has relative positioning
        var computedStyle = window.getComputedStyle(parent);
        if (computedStyle.position === 'static') {
            parent.style.position = 'relative';
        }

        var dot = document.createElement('div');
        dot.id = id;
        dot.style.cssText = 'position:absolute !important;top:2px !important;right:5px !important;width:10px !important;height:10px !important;background:#ef4444 !important;border-radius:50% !important;display:none;box-shadow:0 0 6px rgba(239,68,68,0.8) !important;z-index:100 !important;pointer-events:none !important;';

        parent.appendChild(dot);
        return dot;
    }

    // Update all notification dots based on hasUnread state
    var dotRetryTimer = null;
    function updateNotificationDots() {
        // Alliance button dot - wrap the img in a relative container
        var allianceBtn = document.getElementById('alliance-modal-btn');
        if (allianceBtn) {
            // Check if we already wrapped it
            var wrapper = document.getElementById('alliance-btn-wrapper');
            if (!wrapper) {
                // Create wrapper around the image
                wrapper = document.createElement('span');
                wrapper.id = 'alliance-btn-wrapper';
                wrapper.style.cssText = 'position:relative !important;display:inline-block !important;';
                allianceBtn.parentNode.insertBefore(wrapper, allianceBtn);
                wrapper.appendChild(allianceBtn);
            }

            // Create dot only once, toggle display property
            var dot = document.getElementById('alliance-btn-notify-dot');
            if (!dot) {
                dot = document.createElement('div');
                dot.id = 'alliance-btn-notify-dot';
                dot.style.cssText = 'position:absolute !important;top:5px !important;right:5px !important;width:10px !important;height:10px !important;background:#ef4444 !important;border-radius:50% !important;box-shadow:0 0 6px rgba(239,68,68,0.8) !important;z-index:100 !important;pointer-events:none !important;';
                wrapper.appendChild(dot);
            }
            dot.style.display = hasUnread ? 'block' : 'none';
        }

        // Chat tab dot (inside alliance modal)
        var chatTab = findChatTab();
        if (chatTab) {
            if (dotRetryTimer) { clearTimeout(dotRetryTimer); dotRetryTimer = null; }
            var tabDot = document.getElementById('alliance-chat-tab-notify-dot');
            if (!tabDot) {
                tabDot = createDot(chatTab, 'alliance-chat-tab-notify-dot');
            }
            if (tabDot) {
                tabDot.style.display = hasUnread ? 'block' : 'none';
            }
        } else {
            // Modal may be open but #top-nav not rendered yet - retry once
            var modalWrapper = document.getElementById('modal-wrapper');
            if (modalWrapper && modalWrapper.offsetParent !== null && !dotRetryTimer) {
                dotRetryTimer = setTimeout(function() {
                    dotRetryTimer = null;
                    updateNotificationDots();
                }, 500);
            }
        }
    }

    // Find the Chat tab in the alliance modal (3rd tab, index 2)
    function findChatTab() {
        var topNav = document.querySelector('#top-nav');
        if (!topNav) return null;
        // Use more specific selector with :scope to only get direct children
        var tabs = topNav.querySelectorAll(':scope > .tab.flex-centered');
        // Chat is always the 3rd tab (index 2): Overview, Co-op, Chat, Settings
        if (tabs.length >= 3) {
            return tabs[2];
        }
        return null;
    }

    // ============================================
    // API Functions
    // ============================================

    var cachedAllianceId = null;
    var cacheTimestamp = 0;
    var CACHE_TTL = 300000; // 5 minutes

    // Fetch alliance ID from API with retry
    function fetchAllianceId(maxRetries) {
        // Check cache with TTL
        var now = Date.now();
        if (cachedAllianceId && now - cacheTimestamp < CACHE_TTL) {
            return Promise.resolve(cachedAllianceId);
        }

        maxRetries = maxRetries ?? 3;

        function attempt(attemptNum) {
            return fetch('/api/alliance/get-user-alliance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({})
            }).then(function(response) {
                if (!response.ok) {
                    // Invalidate cache on 404 (user left alliance)
                    if (response.status === 404) {
                        cachedAllianceId = null;
                        cacheTimestamp = 0;
                    }
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            }).then(function(data) {
                if (data && data.data && data.data.alliance && data.data.alliance.id) {
                    cachedAllianceId = data.data.alliance.id;
                    cacheTimestamp = Date.now();
                    return cachedAllianceId;
                }
                log('No alliance found in API response');
                return null;
            }).catch(function(e) {
                log('fetchAllianceId attempt ' + attemptNum + '/' + maxRetries + ' failed: ' + e.message);
                if (attemptNum < maxRetries) {
                    // Exponential backoff: 500ms, 1000ms, 2000ms
                    var delay = Math.pow(2, attemptNum - 1) * 500;
                    return new Promise(function(r) { setTimeout(r, delay); }).then(function() {
                        return attempt(attemptNum + 1);
                    });
                }
                console.error('[AllianceChatNotify] Failed to fetch alliance ID after retries');
                return null;
            });
        }

        return attempt(1);
    }

    // Fetch latest chat messages and check for unread with retry
    function checkForUnreadMessages(maxRetries) {
        // Check if cachedAllianceId already exists to avoid promise chain
        if (!cachedAllianceId || Date.now() - cacheTimestamp >= CACHE_TTL) {
            return fetchAllianceId().then(function(allianceId) {
                if (!allianceId) {
                    log('No alliance ID - user may not be in an alliance');
                    return;
                }
                return performChatCheck(allianceId, maxRetries);
            });
        }
        return performChatCheck(cachedAllianceId, maxRetries);
    }

    // Perform the actual chat check (extracted from checkForUnreadMessages)
    function performChatCheck(allianceId, maxRetries) {
        maxRetries = maxRetries ?? 3;

        function attempt(attemptNum) {
            return fetch('/api/alliance/get-chat-feed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ alliance_id: allianceId })
            }).then(function(response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            }).then(function(data) {
                // API returns data.chat_feed not data.messages
                if (!data || !data.data || !data.data.chat_feed) {
                    log('No chat_feed data');
                    return;
                }

                var chatFeed = data.data.chat_feed;
                if (chatFeed.length === 0) {
                    hasUnread = false;
                    updateNotificationDots();
                    return;
                }

                // Find the newest message timestamp (only type: "chat", not "feed")
                // Use local var first, only assign to global after processing
                var checkNewest = 0;
                var newestSender = '';
                chatFeed.forEach(function(msg) {
                    // Only count actual chat messages, not feed items like "member_left"
                    if (msg.type === 'chat') {
                        var msgTime = msg.time_created || 0;
                        if (msgTime > checkNewest) {
                            checkNewest = msgTime;
                            newestSender = msg.user_name || 'Someone';
                        }
                    }
                });

                // Update global newest ONLY if we found messages (never reset to 0)
                if (checkNewest > 0) {
                    newestMessageTimestamp = checkNewest;
                }

                // First run: no lastRead ever saved → treat all existing messages as read
                if (lastReadTimestamp === 0 && checkNewest > 0) {
                    log('First run: initializing lastRead to newest message ' + checkNewest);
                    saveLastRead(checkNewest);
                    return;
                }

                // Count unread messages
                var unreadCount = 0;
                if (checkNewest > lastReadTimestamp) {
                    chatFeed.forEach(function(msg) {
                        if (msg.type === 'chat' && (msg.time_created || 0) > lastReadTimestamp) {
                            unreadCount++;
                        }
                    });
                }

                // Check if there are unread messages
                var wasUnread = hasUnread;
                if (checkNewest > lastReadTimestamp) {
                    hasUnread = true;
                    if (!wasUnread && !window.__rebelshipHeadless) {
                        log('Unread messages detected! Newest: ' + checkNewest + ' Last read: ' + lastReadTimestamp);
                        // Send notifications only on state change (first detection) and only in foreground
                        var notifyMsg = unreadCount + ' new alliance chat message' + (unreadCount > 1 ? 's' : '') + ' (latest from ' + newestSender + ')';
                        if (settings.inAppAlerts) {
                            showToast(notifyMsg, 'info');
                        }
                        sendSystemNotification('Alliance Chat', notifyMsg);
                    }
                } else {
                    hasUnread = false;
                }

                updateNotificationDots();
            }).catch(function(e) {
                log('checkForUnreadMessages attempt ' + attemptNum + '/' + maxRetries + ' failed: ' + e.message);
                if (attemptNum < maxRetries) {
                    // Exponential backoff: 500ms, 1000ms, 2000ms
                    var delay = Math.pow(2, attemptNum - 1) * 500;
                    return new Promise(function(r) { setTimeout(r, delay); }).then(function() {
                        return attempt(attemptNum + 1);
                    });
                }
                console.error('[AllianceChatNotify] Failed to check messages after retries');
            });
        }

        return attempt(1);
    }

    // ============================================
    // Mark As Read Functions
    // ============================================

    // Mark messages as read after delay
    function scheduleMarkAsRead() {
        if (markReadTimeout) {
            clearTimeout(markReadTimeout);
        }

        markReadTimeout = setTimeout(function() {
            if (isChatTabActive && newestMessageTimestamp > 0) {
                saveLastRead(newestMessageTimestamp);
            }
        }, MARK_READ_DELAY);
    }

    // Cancel mark as read
    function cancelMarkAsRead() {
        if (markReadTimeout) {
            clearTimeout(markReadTimeout);
            markReadTimeout = null;
        }
    }

    // ============================================
    // Event Monitoring
    // ============================================

    // Monitor Chat tab clicks and state
    function setupChatTabMonitor() {
        // Use event delegation on document
        clickHandler = function(e) {
            var target = e.target;

            // Check if clicked on chat tab or its children
            var chatTab = findChatTab();
            if (chatTab && (chatTab === target || chatTab.contains(target))) {
                isChatTabActive = true;
                scheduleMarkAsRead();
            } else if (target.closest('.tab.flex-centered')) {
                // Clicked on another tab (not chat tab)
                var clickedTab = target.closest('.tab.flex-centered');
                if (clickedTab !== chatTab) {
                    isChatTabActive = false;
                    cancelMarkAsRead();
                }
            }
        };
        document.addEventListener('click', clickHandler);
    }

    // Monitor for modal close with MutationObserver
    function monitorModalState() {
        var lastModalVisible = false;

        var checkModalState = function() {
            var modalWrapper = document.getElementById('modal-wrapper');
            var isModalVisible = modalWrapper && modalWrapper.offsetParent !== null;

            if (!isModalVisible && lastModalVisible) {
                // Modal just closed - save immediately if chat was active
                if (isChatTabActive && newestMessageTimestamp > 0 && newestMessageTimestamp > lastReadTimestamp) {
                    cancelMarkAsRead();
                    saveLastRead(newestMessageTimestamp);
                } else {
                    cancelMarkAsRead();
                }
                isChatTabActive = false;
            }

            lastModalVisible = isModalVisible;

            // Update dots when modal opens (chat tab might appear)
            if (isModalVisible) {
                updateNotificationDots();
            }
        };

        // Use MutationObserver on modal wrapper to detect visibility changes
        var modalWrapper = document.getElementById('modal-wrapper');
        if (modalWrapper) {
            modalObserver = new MutationObserver(checkModalState);
            modalObserver.observe(modalWrapper, {
                attributes: true,
                attributeFilter: ['style', 'class']
            });
        }

    }

    // ============================================
    // Initialization
    // ============================================

    async function init() {
        addMenuItem('Chat Notification', openSettingsModal, 51);

        await loadSettings();
        await loadLastRead();

        // Setup monitors
        setupChatTabMonitor();
        monitorModalState();

        // Initial check
        checkForUnreadMessages();

        // Periodic check for new messages
        setInterval(checkForUnreadMessages, CHECK_INTERVAL);

        // Observe modal-container for dot updates (NOT document.body)
        var debouncedUpdate = debounce(updateNotificationDots, 200);
        var modalContainer = document.getElementById('modal-container');
        if (modalContainer) {
            dotObserver = new MutationObserver(debouncedUpdate);
            dotObserver.observe(modalContainer, { childList: true });
        }

        // Initial dot update
        updateNotificationDots();

        log('Script loaded');
    }

    // Save read state on page unload if chat was active
    window.addEventListener('beforeunload', function() {
        if (isChatTabActive && newestMessageTimestamp > 0 && newestMessageTimestamp > lastReadTimestamp) {
            // Synchronous localStorage - dbSet is async and may not complete before unload
            try {
                localStorage.setItem('acn_lastRead', String(newestMessageTimestamp));
                localStorage.setItem('acn_pendingLastRead', JSON.stringify(newestMessageTimestamp));
            } catch { /* ignore */ }
        }
    });

    // ========== BACKGROUND JOB ==========
    window.rebelshipRunAllianceChatNotify = function() {
        return loadSettings().then(function() {
            return loadLastRead();
        }).then(function() {
            return checkForUnreadMessages();
        }).then(function() {
            return { success: true, hasUnread: hasUnread };
        }).catch(function(e) {
            return { success: false, error: e.message };
        });
    };

    window.rebelshipBackgroundJobs = window.rebelshipBackgroundJobs || [];
    window.rebelshipBackgroundJobs.push({
        name: 'AllianceChatNotify',
        interval: 60 * 1000,
        run: function() { return window.rebelshipRunAllianceChatNotify(); }
    });

    // Wait for page to load
    if (!window.__rebelshipHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 500); });
        } else {
            setTimeout(init, 500);
        }
    }
})();
