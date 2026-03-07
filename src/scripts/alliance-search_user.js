// ==UserScript==
// @name        ShippingManager - Open Alliance Search
// @description Search all open alliances
// @version     3.57
// @author      https://github.com/justonlyforyou/
// @order        2
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// @enabled     false
// ==/UserScript==
/* globals Event, addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'AllianceSearch';
    var STORE_NAME = 'data';

    var STORAGE_KEY = 'alliances';
    var STORAGE_META_KEY = 'meta';
    var STORAGE_PROGRESS_KEY = 'progress';
    var isDownloading = false;
    var isIndexReady = false;
    var PAGE_SIZE = 10;
    var MAX_DOM_NODES = 1000; // Max alliance items in DOM to prevent memory issues
    var currentResults = [];
    var displayedCount = 0;
    var isLoadingMore = false;
    var isAllianceSearchModalOpen = false;
    var modalOpenedAt = 0;
    var modalListenerAttached = false;
    var cachedAlliances = null; // In-memory cache to avoid storage reads on every filter

    // ==================== Global Modal Registry ====================
    // Shared registry so userscripts don't interfere with each other's modals
    if (!window.RebelShipModalRegistry) {
        window.RebelShipModalRegistry = {
            activeScript: null,
            register: function(scriptName) {
                this.activeScript = scriptName;
            },
            unregister: function(scriptName) {
                if (this.activeScript === scriptName) {
                    this.activeScript = null;
                }
            },
            isOurs: function(scriptName) {
                return this.activeScript === scriptName;
            }
        };
    }

    // ==================== RebelShipBridge Storage ====================

    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[AllianceSearch] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[AllianceSearch] dbSet error:', e);
            return false;
        }
    }

    async function dbDelete(key) {
        try {
            await window.RebelShipBridge.storage.delete(SCRIPT_NAME, STORE_NAME, key);
            return true;
        } catch (e) {
            console.error('[AllianceSearch] dbDelete error:', e);
            return false;
        }
    }

    // ==================== Storage Functions ====================

    // Format numbers with thousand separators
    function formatNumber(num) {
        return num.toLocaleString('en-US');
    }

    function formatNumberWithSeparator(value) {
        var num = Number(String(value).replace(/,/g, ''));
        if (isNaN(num)) return String(value);
        return new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 }).format(num);
    }

    function setupThousandSeparator(input) {
        input.type = 'text';
        input.inputMode = 'numeric';
        input.addEventListener('input', function(e) {
            var raw = e.target.value.replace(/[^\d]/g, '');
            e.target.value = formatNumberWithSeparator(raw);
        });
        if (input.value) {
            input.value = formatNumberWithSeparator(input.value);
        }
    }

    function getNumericValue(input) {
        return parseInt(String(input.value).replace(/,/g, ''), 10);
    }

    // Get Pinia stores
    function getStores() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;
            return {
                modalStore: pinia._s.get('modal'),
                allianceStore: pinia._s.get('alliance')
            };
        } catch (e) {
            console.error('[AllianceSearch] Failed to get stores:', e);
            return null;
        }
    }

    // Open alliance modal by ID
    async function openAllianceModal(allianceId) {
        var stores = getStores();
        if (!stores) {
            alert('Failed to access game stores. Try refreshing the page.');
            return;
        }

        if (stores.allianceStore) {
            if (stores.allianceStore.alliance && typeof stores.allianceStore.alliance === 'object') {
                if (stores.allianceStore.alliance.value !== undefined) {
                    stores.allianceStore.alliance.value.id = allianceId;
                } else {
                    stores.allianceStore.alliance.id = allianceId;
                }
            }

            if (typeof stores.allianceStore.$patch === 'function') {
                stores.allianceStore.$patch(function(state) {
                    if (state.alliance) {
                        state.alliance.id = allianceId;
                    }
                });
            }
        }

        await new Promise(function(r) { setTimeout(r, 100); });

        stores.modalStore.open('allianceOverview');
    }

    // Get stored alliances (async)
    async function getStoredAlliances() {
        try {
            var data = await dbGet(STORAGE_KEY);
            return data ? data : [];
        } catch (e) {
            console.error('[AllianceSearch] Failed to load alliances:', e);
            return [];
        }
    }

    // Get storage metadata (async)
    async function getStorageMeta() {
        try {
            var data = await dbGet(STORAGE_META_KEY);
            return data ? data : null;
        } catch (e) {
            console.error('[AllianceSearch] Failed to get meta:', e);
            return null;
        }
    }

    // Get download progress (async)
    async function getDownloadProgress() {
        try {
            var data = await dbGet(STORAGE_PROGRESS_KEY);
            return data ? data : null;
        } catch (e) {
            console.error('[AllianceSearch] Failed to get progress:', e);
            return null;
        }
    }

    // Save download progress (async) - only offset, alliances stay in memory
    async function saveDownloadProgress(offset) {
        try {
            await dbSet(STORAGE_PROGRESS_KEY, {
                offset: offset,
                timestamp: Date.now()
            });
        } catch (e) {
            console.error('[AllianceSearch] Failed to save progress:', e);
        }
    }

    // Clear download progress (async)
    async function clearDownloadProgress() {
        try {
            await dbDelete(STORAGE_PROGRESS_KEY);
        } catch (e) {
            console.error('[AllianceSearch] Failed to clear progress:', e);
        }
    }

    // Save alliances to storage (async)
    async function saveAlliances(alliances) {
        try {
            await dbSet(STORAGE_KEY, alliances);
            await dbSet(STORAGE_META_KEY, {
                count: alliances.length,
                timestamp: Date.now(),
                date: new Date().toLocaleString()
            });
            await clearDownloadProgress();
            return true;
        } catch (e) {
            console.error('[AllianceSearch] Failed to save alliances:', e);
            return false;
        }
    }

    // Check if index is ready (async)
    var STALE_PROGRESS_MS = 5 * 60 * 1000; // 5 minutes

    async function checkIndexReady() {
        var meta = await getStorageMeta();
        var progress = await getDownloadProgress();

        // Clean up stale progress from interrupted downloads
        if (progress && !isDownloading) {
            var progressAge = Date.now() - (progress.timestamp || 0);
            if (progressAge > STALE_PROGRESS_MS) {
                console.log('[AllianceSearch] Clearing stale progress (' + Math.round(progressAge / 60000) + ' min old)');
                await clearDownloadProgress();
                progress = null;
            }
        }

        isIndexReady = meta && meta.count > 0 && !progress;
        return isIndexReady;
    }

    // Update dialog UI based on state (async)
    async function updateDialogState() {
        await checkIndexReady();

        var searchContainer = document.getElementById('alliance-search-container');
        var indexingContainer = document.getElementById('alliance-indexing-container');
        var statusLine = document.getElementById('alliance-search-status');

        if (!searchContainer || !indexingContainer) {
            return;
        }


        if (isIndexReady && !isDownloading) {
            searchContainer.style.display = 'flex';
            indexingContainer.style.display = 'none';
            var meta = await getStorageMeta();
            if (meta && statusLine) {
                statusLine.textContent = meta.count + ' alliances indexed (' + meta.date + ')';
            }
            var searchInput = document.getElementById('alliance-search-input');
            if (searchInput) {
                searchInput.dispatchEvent(new Event('input'));
            }
        } else {
            searchContainer.style.display = 'none';
            indexingContainer.style.display = 'block';
        }
    }

    // Fetch all alliances from API (async)
    async function fetchAllAlliances(forceRestart) {
        if (isDownloading) {
            console.log('[AllianceSearch] Download already in progress');
            return;
        }

        isDownloading = true;
        isIndexReady = false;
        updateDialogState();

        var progress = forceRestart ? null : await getDownloadProgress();
        var offset = progress ? progress.offset : 0;
        var allAlliances = [];
        var limit = 50;
        var page = Math.floor(offset / limit) + 1;

        if (progress) {
            // Load previously saved alliances from main storage to resume
            allAlliances = await getStoredAlliances();
            console.log('[AllianceSearch] Resuming download from offset', offset, 'with', allAlliances.length, 'alliances from DB');
        } else {
            console.log('[AllianceSearch] Starting fresh alliance download...');
        }

        try {
            while (true) {
                var response = await fetch('/api/alliance/get-open-alliances', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        limit: limit,
                        offset: offset,
                        filter: 'all'
                    })
                });

                var data = await response.json();

                if (!data || !data.data || !data.data.alliances) {
                    console.log('[AllianceSearch] No more data at offset', offset);
                    break;
                }

                var alliances = data.data.alliances;

                if (alliances.length === 0) {
                    console.log('[AllianceSearch] Done! No more alliances at offset', offset);
                    break;
                }

                alliances.forEach(function(a) {
                    allAlliances.push({
                        id: a.id,
                        name: a.name,
                        image: a.image,
                        image_colors: a.image_colors,
                        language: a.language,
                        members: a.members,
                        benefit_level: a.benefit_level,
                        total_share_value: a.total_share_value,
                        departures_24h: a.stats ? a.stats.departures_24h : 0,
                        contribution_24h: a.stats ? a.stats.contribution_score_24h : 0,
                        coops_24h: a.stats ? a.stats.coops_24h : 0
                    });
                });

                updateIndexingStatus(allAlliances.length, page);

                offset += limit;
                page++;

                // Save offset for crash recovery (alliances stay in memory until final save)
                await saveDownloadProgress(offset);

                await new Promise(function(r) { setTimeout(r, 200); });
            }

            if (await saveAlliances(allAlliances)) {
                console.log('[AllianceSearch] Saved', allAlliances.length, 'alliances to storage');
            }

            // Update in-memory cache after successful download
            cachedAlliances = allAlliances;
            isIndexReady = true;

        } catch (e) {
            console.error('[AllianceSearch] Download error:', e);
            await saveDownloadProgress(offset);
            updateIndexingStatus(-1, 0, e.message);
        } finally {
            isDownloading = false;
            updateDialogState();
        }

        return allAlliances;
    }

    // Update indexing status in UI
    function updateIndexingStatus(count, page, error) {
        var statusText = document.getElementById('alliance-indexing-status');
        if (!statusText) return;

        if (error) {
            statusText.textContent = 'Error: ' + error + ' (will resume on next load)';
            statusText.style.color = '#ef4444';
        } else if (count >= 0) {
            statusText.textContent = 'Indexing alliances... ' + count + ' found (page ' + page + ')';
            statusText.style.color = '#fbbf24';
        }
    }

    // Filter and search alliances (optimized: use in-memory cache, text search first)
    async function filterAlliances(query, minMembers, minContribution, minDepartures, maxMembers, maxContribution, maxDepartures) {
        // Use cached alliances if available, otherwise load from storage
        if (!cachedAlliances) {
            cachedAlliances = await getStoredAlliances();
        }
        var alliances = cachedAlliances;

        // Always work on a copy — never return the cachedAlliances reference
        // (doSearch clears currentResults.length which would destroy the cache)
        var filtered = alliances.slice();

        // Text search first (creates smallest result set, then numeric filters)
        if (query && query.length >= 2) {
            var queryLower = query.toLowerCase();
            filtered = filtered.filter(function(a) {
                return a.name.toLowerCase().indexOf(queryLower) !== -1;
            });
        }

        // Then apply numeric filters on smaller set
        var hasMinFilter = minMembers > 0 || minContribution > 0 || minDepartures > 0;
        var hasMaxFilter = maxMembers > 0 || maxContribution > 0 || maxDepartures > 0;
        if (hasMinFilter || hasMaxFilter) {
            filtered = filtered.filter(function(a) {
                if (minMembers > 0 && (a.members || 0) < minMembers) return false;
                if (maxMembers > 0 && (a.members || 0) > maxMembers) return false;
                if (minContribution > 0 && (a.contribution_24h || 0) < minContribution) return false;
                if (maxContribution > 0 && (a.contribution_24h || 0) > maxContribution) return false;
                if (minDepartures > 0 && (a.departures_24h || 0) < minDepartures) return false;
                if (maxDepartures > 0 && (a.departures_24h || 0) > maxDepartures) return false;
                return true;
            });
        }

        filtered.sort(function(a, b) {
            return a.name.localeCompare(b.name);
        });

        return filtered;
    }

    // Open alliance search dialog (custom overlay, not game modal)
    async function openAllianceSearchModal() {
        console.log('[AllianceSearch] Opening custom dialog');

        // Load alliances into cache BEFORE setting modal flag
        // (rebelship-menu-click fires during await and would close the modal immediately)
        if (!cachedAlliances) {
            cachedAlliances = await getStoredAlliances();
        }

        isAllianceSearchModalOpen = true;
        modalOpenedAt = Date.now();
        window.RebelShipModalRegistry.register(SCRIPT_NAME);

        showDialog();
    }

    // Close alliance search dialog
    function closeAllianceSearchModal() {
        if (!isAllianceSearchModalOpen) return;

        console.log('[AllianceSearch] Closing dialog');
        isAllianceSearchModalOpen = false;
        window.RebelShipModalRegistry.unregister(SCRIPT_NAME);

        var modalWrapper = document.getElementById('rebelship-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
    }


    // Setup listener for menu clicks
    function setupNavigationWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        // Listen for RebelShip menu clicks to close our dialog
        // (but not when our own menu item just opened it — timing guard prevents race condition)
        window.addEventListener('rebelship-menu-click', function() {
            if (isAllianceSearchModalOpen && (Date.now() - modalOpenedAt > 500)) {
                console.log('[AllianceSearch] RebelShip menu clicked, closing dialog');
                closeAllianceSearchModal();
            }
        });
    }

    // Inject game-identical modal CSS (1:1 copy from app.css)
    function injectModalStyles() {
        if (document.getElementById('rebelship-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'rebelship-modal-styles';
        style.textContent = [
            // Animations (exact copy from game)
            '@keyframes rs-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes rs-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes rs-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes rs-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',

            // Modal wrapper (exact copy from game #modal-wrapper) - align-items:flex-start to position from top
            '#rebelship-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',

            // Modal background (exact copy from game #modal-wrapper #modal-background)
            '#rebelship-modal-wrapper #rebelship-modal-background{animation:rs-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#rebelship-modal-wrapper.hide #rebelship-modal-background{animation:rs-fade-out .15s linear forwards}',

            // Modal content wrapper (exact copy from game #modal-wrapper #modal-content-wrapper)
            '#rebelship-modal-wrapper #rebelship-modal-content-wrapper{animation:rs-drop-down .15s linear forwards,rs-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#rebelship-modal-wrapper.hide #rebelship-modal-content-wrapper{animation:rs-push-up .15s linear forwards,rs-fade-out .15s linear forwards}',

            // Media queries for content wrapper (exact copy from game)
            '@media screen and (min-width:1200px){#rebelship-modal-wrapper #rebelship-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#rebelship-modal-wrapper #rebelship-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#rebelship-modal-wrapper #rebelship-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#rebelship-modal-wrapper #rebelship-modal-content-wrapper{max-width:100%}}',

            // Modal container (exact copy from game #modal-wrapper #modal-container)
            '#rebelship-modal-wrapper #rebelship-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',

            // Modal header (exact copy from game #modal-container .modal-header)
            '#rebelship-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',

            // Header title (exact copy from game #modal-container .header-title)
            '#rebelship-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',

            // Header icon (exact copy from game #modal-container .header-icon)
            '#rebelship-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#rebelship-modal-container .header-icon.closeModal{height:19px;width:19px}',

            // Modal content (exact copy from game #modal-container #modal-content)
            '#rebelship-modal-container #rebelship-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',

            // Central container (exact copy from game #modal-container #central-container) - with padding
            '#rebelship-modal-container #rebelship-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',

            // Hide class
            '#rebelship-modal-wrapper.hide{pointer-events:none}',

            // Spin animation for loading
            '@keyframes spin{to{transform:rotate(360deg)}}'
        ].join('');
        document.head.appendChild(style);
    }

    // Show the alliance search dialog (game-style modal - 1:1 copy)
    function showDialog() {
        // Close any open game modal first
        var stores = getStores();
        if (stores && stores.modalStore && stores.modalStore.closeAll) {
            stores.modalStore.closeAll();
        }

        injectModalStyles();

        var existing = document.getElementById('rebelship-modal-wrapper');
        if (existing) {
            // Check if content still exists
            var contentCheck = existing.querySelector('#alliance-search-wrapper');
            if (contentCheck) {
                existing.classList.remove('hide');
                isAllianceSearchModalOpen = true;
                modalOpenedAt = Date.now();
                window.RebelShipModalRegistry.register(SCRIPT_NAME);
                updateDialogState();
                return;
            }
            // Content missing, remove old wrapper and rebuild
            existing.remove();
        }

        // Get header height for positioning (same as game modal)
        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        // Create game-identical modal structure
        // Structure: #modal-wrapper > #modal-background + #modal-content-wrapper > #modal-container > .modal-header + #modal-content > #central-container

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'rebelship-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'rebelship-modal-background';
        modalBackground.onclick = function() { closeAllianceSearchModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'rebelship-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'rebelship-modal-container';
        modalContainer.className = 'font-lato';
        // Inline styles for positioning (same as game applies dynamically)
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        // Modal header (exact structure as game)
        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Alliance Search';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeAllianceSearchModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeAllianceSearchModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        // Modal content (exact structure as game)
        var modalContent = document.createElement('div');
        modalContent.id = 'rebelship-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'rebelship-central-container';

        var content = buildSearchContent();
        centralContainer.appendChild(content);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        updateDialogState();
    }

    // Build search content (shared between modal and fallback)
    function buildSearchContent() {
        var wrapper = document.createElement('div');
        wrapper.id = 'alliance-search-wrapper';
        wrapper.dataset.rebelshipModal = 'alliance-search';
        wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;';

        var indexingContainer = document.createElement('div');
        indexingContainer.id = 'alliance-indexing-container';
        indexingContainer.style.cssText = 'text-align:center;padding:40px 20px;';

        var spinner = document.createElement('div');
        spinner.style.cssText = 'width:40px;height:40px;border:3px solid #374151;border-top-color:#3b82f6;border-radius:50%;margin:0 auto 20px;animation:spin 1s linear infinite;';

        var indexingText = document.createElement('div');
        indexingText.id = 'alliance-indexing-status';
        indexingText.style.cssText = 'color:#1a1a2e;font-size:14px;font-weight:bold;';
        indexingText.textContent = 'Indexing alliances...';

        indexingContainer.appendChild(spinner);
        indexingContainer.appendChild(indexingText);

        var searchContainer = document.createElement('div');
        searchContainer.id = 'alliance-search-container';
        searchContainer.style.cssText = 'display:none;flex-direction:column;flex:1;min-height:0;';

        var statusLine = document.createElement('div');
        statusLine.id = 'alliance-search-status';
        statusLine.style.cssText = 'color:#333;font-size:12px;margin-bottom:10px;';

        var searchRow = document.createElement('div');
        searchRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';

        var searchInput = document.createElement('input');
        searchInput.id = 'alliance-search-input';
        searchInput.type = 'text';
        searchInput.placeholder = 'Search alliance name...';
        searchInput.style.cssText = 'flex:1;padding:10px;border-radius:4px;border:1px solid #ccc;background:#f5f5f5;color:#333;font-size:14px;';

        var refreshBtn = document.createElement('button');
        refreshBtn.id = 'alliance-refresh-btn';
        refreshBtn.textContent = 'Update';
        refreshBtn.style.cssText = 'padding:10px 15px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;';

        searchRow.appendChild(searchInput);
        searchRow.appendChild(refreshBtn);

        var filterRow = document.createElement('div');
        filterRow.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;';

        var filterInputStyle = 'width:110px;padding:6px 8px;border-radius:4px;border:1px solid #ccc;background:#f5f5f5;color:#333;font-size:12px;';

        var minMembersInput = document.createElement('input');
        minMembersInput.id = 'alliance-filter-members';
        minMembersInput.type = 'number';
        minMembersInput.min = '0';
        minMembersInput.max = '30';
        minMembersInput.placeholder = 'Min Members';
        minMembersInput.style.cssText = filterInputStyle;

        var minContribInput = document.createElement('input');
        minContribInput.id = 'alliance-filter-contribution';
        minContribInput.placeholder = 'Min Contrib 24h';
        minContribInput.style.cssText = filterInputStyle;
        setupThousandSeparator(minContribInput);

        var minDeparturesInput = document.createElement('input');
        minDeparturesInput.id = 'alliance-filter-departures';
        minDeparturesInput.placeholder = 'Min Dep 24h';
        minDeparturesInput.style.cssText = filterInputStyle;
        setupThousandSeparator(minDeparturesInput);

        filterRow.appendChild(minMembersInput);
        filterRow.appendChild(minContribInput);
        filterRow.appendChild(minDeparturesInput);

        var filterRow2 = document.createElement('div');
        filterRow2.style.cssText = 'display:flex;gap:8px;margin-bottom:15px;flex-wrap:wrap;';

        var maxMembersInput = document.createElement('input');
        maxMembersInput.id = 'alliance-filter-max-members';
        maxMembersInput.type = 'number';
        maxMembersInput.min = '0';
        maxMembersInput.max = '30';
        maxMembersInput.placeholder = 'Max Members';
        maxMembersInput.style.cssText = filterInputStyle;

        var maxContribInput = document.createElement('input');
        maxContribInput.id = 'alliance-filter-max-contribution';
        maxContribInput.placeholder = 'Max Contrib 24h';
        maxContribInput.style.cssText = filterInputStyle;
        setupThousandSeparator(maxContribInput);

        var maxDeparturesInput = document.createElement('input');
        maxDeparturesInput.id = 'alliance-filter-max-departures';
        maxDeparturesInput.placeholder = 'Max Dep 24h';
        maxDeparturesInput.style.cssText = filterInputStyle;
        setupThousandSeparator(maxDeparturesInput);

        var resultCount = document.createElement('span');
        resultCount.id = 'alliance-result-count';
        resultCount.style.cssText = 'color:#666;font-size:12px;margin-left:auto;align-self:center;';

        filterRow2.appendChild(maxMembersInput);
        filterRow2.appendChild(maxContribInput);
        filterRow2.appendChild(maxDeparturesInput);
        filterRow2.appendChild(resultCount);

        var resultsContainer = document.createElement('div');
        resultsContainer.id = 'alliance-search-results';
        resultsContainer.style.cssText = 'flex:1;overflow-y:auto;min-height:0;';

        searchContainer.appendChild(statusLine);
        searchContainer.appendChild(searchRow);
        searchContainer.appendChild(filterRow);
        searchContainer.appendChild(filterRow2);
        searchContainer.appendChild(resultsContainer);

        wrapper.appendChild(indexingContainer);
        wrapper.appendChild(searchContainer);

        // Function to perform search with filters (async)
        async function doSearch() {
            var query = searchInput.value;
            var minMembers = parseInt(minMembersInput.value) || 0;
            var minContrib = getNumericValue(minContribInput) || 0;
            var minDep = getNumericValue(minDeparturesInput) || 0;
            var maxMembers = parseInt(maxMembersInput.value) || 0;
            var maxContrib = getNumericValue(maxContribInput) || 0;
            var maxDep = getNumericValue(maxDeparturesInput) || 0;

            currentResults = await filterAlliances(query, minMembers, minContrib, minDep, maxMembers, maxContrib, maxDep);
            displayedCount = 0;

            resultCount.textContent = currentResults.length + ' results';

            resultsContainer.innerHTML = '';
            loadMoreResults(resultsContainer);
        }

        var searchTimeout = null;
        searchInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });

        minMembersInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });
        minContribInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });
        minDeparturesInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });
        maxMembersInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });
        maxContribInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });
        maxDeparturesInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });

        // Shared helper for checking if we need to load more results
        function checkLoadMore() {
            if (isLoadingMore) return;
            if (displayedCount >= currentResults.length) return;

            var scrollTop = resultsContainer.scrollTop;
            var scrollHeight = resultsContainer.scrollHeight;
            var clientHeight = resultsContainer.clientHeight;

            if (scrollTop + clientHeight >= scrollHeight - 50) {
                loadMoreResults(resultsContainer);
            }
        }

        // Single scroll handler (wheel events trigger scroll anyway)
        resultsContainer.addEventListener('scroll', checkLoadMore);

        refreshBtn.addEventListener('click', function() {
            if (isDownloading) return;
            // Clear cache so fresh data is loaded after download completes
            cachedAlliances = null;
            fetchAllAlliances(true);
        });

        if (isIndexReady) {
            setTimeout(doSearch, 100);
        }

        return wrapper;
    }

    // Load more results (lazy loading with max DOM node limit)
    function loadMoreResults(container) {
        if (isLoadingMore) return;

        var existingBtn = container.querySelector('.load-more-btn');
        if (existingBtn) existingBtn.remove();

        if (displayedCount >= currentResults.length) {
            return;
        }

        // Check if we hit the max DOM node limit
        if (displayedCount >= MAX_DOM_NODES) {
            var limitMsg = document.createElement('div');
            limitMsg.style.cssText = 'padding:20px;text-align:center;color:#666;font-size:14px;background:#fff;border-top:2px solid #3b82f6;';
            limitMsg.innerHTML = '<strong>Showing first ' + MAX_DOM_NODES + ' results</strong><br>' +
                '<span style="font-size:12px;">Use filters to narrow down results (' +
                (currentResults.length - MAX_DOM_NODES) + ' more available)</span>';
            container.appendChild(limitMsg);
            return;
        }

        isLoadingMore = true;

        var remainingSlots = MAX_DOM_NODES - displayedCount;
        var batchSize = Math.min(PAGE_SIZE, remainingSlots);
        var nextBatch = currentResults.slice(displayedCount, displayedCount + batchSize);
        renderResults(nextBatch, container, true);
        displayedCount += nextBatch.length;

        if (displayedCount < currentResults.length && displayedCount < MAX_DOM_NODES) {
            var loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn';
            loadMoreBtn.textContent = 'Load More (' + (currentResults.length - displayedCount) + ' remaining)';
            loadMoreBtn.style.cssText = 'width:100%;padding:12px;margin-top:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;';
            loadMoreBtn.addEventListener('click', function() {
                loadMoreResults(container);
            });
            container.appendChild(loadMoreBtn);
        }

        isLoadingMore = false;
    }

    // Render search results (append mode for lazy loading, optimized with DocumentFragment)
    function renderResults(alliances, container, append) {
        if (!append) {
            container.innerHTML = '';
        }

        if (alliances.length === 0 && !append) {
            var noResults = document.createElement('div');
            noResults.style.cssText = 'color:#666;text-align:center;padding:20px;';
            noResults.textContent = 'No alliances found';
            container.appendChild(noResults);
            return;
        }

        // Use DocumentFragment for batch DOM insertion (one reflow instead of N)
        var fragment = document.createDocumentFragment();

        alliances.forEach(function(alliance) {
            var item = document.createElement('div');
            item.style.cssText = 'padding:12px;border-bottom:1px solid #e5e5e5;cursor:pointer;background:#fff;';

            item.addEventListener('mouseenter', function() {
                try { this.style.background = '#f5f5f5'; } catch (e) { console.error('[AllianceSearch] mouseenter error:', e); }
            });
            item.addEventListener('mouseleave', function() {
                try { this.style.background = '#fff'; } catch (e) { console.error('[AllianceSearch] mouseleave error:', e); }
            });

            // Top row: Logo + Name + Members
            var topRow = document.createElement('div');
            topRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';

            var logoDiv = document.createElement('div');
            logoDiv.style.cssText = 'width:36px;height:36px;flex-shrink:0;border-radius:4px;overflow:hidden;background:#e5e5e5;';
            if (alliance.image) {
                var logoImg = document.createElement('img');
                logoImg.src = '/images/alliances/' + alliance.image + '.svg';
                logoImg.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                if (alliance.image_colors && alliance.image_colors.primary) {
                    logoDiv.style.background = alliance.image_colors.primary;
                }
                logoDiv.appendChild(logoImg);
            }

            var nameDiv = document.createElement('div');
            nameDiv.style.cssText = 'flex:1;min-width:0;';
            var nameText = document.createElement('div');
            nameText.style.cssText = 'color:#1a1a1a;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nameText.textContent = alliance.name;
            var langText = document.createElement('div');
            langText.style.cssText = 'color:#666;font-size:12px;margin-top:2px;';
            langText.textContent = (alliance.language || 'en').toUpperCase() + ' | Level ' + alliance.benefit_level;
            nameDiv.appendChild(nameText);
            nameDiv.appendChild(langText);

            var freeSlots = 30 - (alliance.members || 0);
            var membersDiv = document.createElement('div');
            membersDiv.style.cssText = 'text-align:right;flex-shrink:0;';
            membersDiv.innerHTML = '<div style="font-weight:600;color:#1a1a1a;font-size:14px;">' + alliance.members + '/30</div>' +
                '<div style="color:' + (freeSlots > 0 ? '#22c55e' : '#ef4444') + ';font-size:12px;font-weight:500;">' + freeSlots + ' free</div>';

            topRow.appendChild(logoDiv);
            topRow.appendChild(nameDiv);
            topRow.appendChild(membersDiv);

            // Bottom row: Stats
            var statsRow = document.createElement('div');
            statsRow.style.cssText = 'display:flex;gap:12px;padding-left:46px;font-size:11px;flex-wrap:wrap;';
            var departures = alliance.departures_24h;
            var contribution = alliance.contribution_24h;
            var coops = alliance.coops_24h;
            var shareValue = alliance.total_share_value;
            statsRow.innerHTML =
                '<div><span style="color:#888;">Dep:</span> <span style="color:#1a1a1a;font-weight:500;">' + formatNumber(departures) + '</span></div>' +
                '<div><span style="color:#888;">Contrib:</span> <span style="color:#1a1a1a;font-weight:500;">' + formatNumber(contribution) + '</span></div>' +
                '<div><span style="color:#888;">Coops:</span> <span style="color:#1a1a1a;font-weight:500;">' + formatNumber(coops) + '</span></div>' +
                '<div><span style="color:#888;">Shares:</span> <span style="color:#1a1a1a;font-weight:500;">' + formatNumber(shareValue) + '</span></div>';

            item.appendChild(topRow);
            item.appendChild(statsRow);

            item.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                // Close our modal
                closeAllianceSearchModal();

                // Close any game modals
                var stores = getStores();
                if (stores && stores.modalStore && stores.modalStore.closeAll) {
                    stores.modalStore.closeAll();
                }

                setTimeout(function() {
                    openAllianceModal(alliance.id);
                }, 200);
            });

            fragment.appendChild(item);
        });

        // Single DOM append at the end (one reflow instead of N)
        container.appendChild(fragment);
    }

    // Start background download (async)
    async function startBackgroundDownload() {
        var progress = await getDownloadProgress();
        var meta = await getStorageMeta();

        if (progress) {
            console.log('[AllianceSearch] Found incomplete download, resuming...');
            fetchAllAlliances(false);
        } else if (!meta || meta.count === 0) {
            console.log('[AllianceSearch] No alliance data, starting download...');
            fetchAllAlliances(true);
        } else {
            isIndexReady = true;
            console.log('[AllianceSearch] Alliance index ready:', meta.count, 'alliances');
        }
    }

    // Initialize (async)
    async function init() {
        // Add menu item immediately for fast UI response
        addMenuItem('Alliance Search', function() {
            openAllianceSearchModal();
        }, 10);

        // Check index state in background
        await checkIndexReady();

        // Setup navigation watcher to close modal on navigation
        setupNavigationWatcher();

        // Start background download if needed
        startBackgroundDownload();

        console.log('[AllianceSearch] Script loaded');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
