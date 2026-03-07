// ==UserScript==
// @name         ShippingManager - Game Bug-Using: Fast Delivery for built vessels
// @namespace    https://rebelship.org/
// @version      1.18
// @description  Fast delivery for built vessels via drydock exploit. Sends pending vessels in drydock, for resetting the delivery time with the maintenance end ;)
// @author       https://github.com/justonlyforyou/
// @order        22
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// ==/UserScript==
/* globals CustomEvent, MutationObserver, XMLHttpRequest */

(function() {
    'use strict';

    // ============================================
    // CONSTANTS
    // ============================================
    var API_BASE = 'https://shippingmanager.cc/api';
    var DEBOUNCE_MS = 200;
    var RETRY_BASE_DELAY_MS = 1000;
    var MAX_RETRIES = 3;
    var DRYDOCK_DURATION_MIN = 60;

    function log(msg) {
        console.log('[Fast Delivery] ' + msg);
    }

    // ============================================
    // STATE
    // ============================================
    var selectedVessels = new Set();
    var vesselDataMap = new Map();
    var isProcessing = false;


    // ============================================
    // PINIA STORE ACCESS
    // ============================================
    var cachedPinia = null;

    function getPinia() {
        if (cachedPinia) return cachedPinia;
        try {
            var appEl = document.getElementById('app');
            if (!appEl || !appEl.__vue_app__) return null;
            var app = appEl.__vue_app__;
            cachedPinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            return cachedPinia;
        } catch {
            return null;
        }
    }

    function getStore(name) {
        try {
            var pinia = getPinia();
            if (!pinia || !pinia._s) return null;
            return pinia._s.get(name);
        } catch {
            return null;
        }
    }

    function showToast(message, type) {
        type = type || 'success';
        var toastStore = getStore('toast');
        if (toastStore) {
            try {
                if (type === 'error' && toastStore.error) {
                    toastStore.error(message);
                } else if (toastStore.success) {
                    toastStore.success(message);
                }
            } catch (err) {
                log('Toast error: ' + err.message);
            }
        }
    }

    // ============================================
    // API FUNCTIONS
    // ============================================

    // Uses XMLHttpRequest to bypass window.fetch interceptors (e.g. AutoDrydock)
    function xhrPost(url, body, maxRetries) {
        maxRetries = maxRetries ?? MAX_RETRIES;
        var lastError;

        return (async function tryRequest(attempt) {
            try {
                return await new Promise(function(resolve, reject) {
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', url, true);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.withCredentials = true;
                    xhr.onload = function() {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            resolve(JSON.parse(xhr.responseText));
                        } else {
                            reject(new Error('HTTP ' + xhr.status));
                        }
                    };
                    xhr.onerror = function() {
                        reject(new Error('Network error'));
                    };
                    xhr.send(JSON.stringify(body));
                });
            } catch (e) {
                lastError = e;
                log('xhrPost (' + url + ') attempt ' + attempt + '/' + maxRetries + ' failed: ' + e.message);
                if (attempt < maxRetries) {
                    var delay = attempt * RETRY_BASE_DELAY_MS;
                    await new Promise(function(resolve) { setTimeout(resolve, delay); });
                    return tryRequest(attempt + 1);
                }
                throw lastError;
            }
        })(1);
    }

    async function fetchDrydockStatus(vesselIds, maxRetries) {
        maxRetries = maxRetries ?? MAX_RETRIES;
        var lastError;

        for (var attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                var response = await fetch(API_BASE + '/maintenance/get', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        vessel_ids: JSON.stringify(vesselIds)
                    })
                });
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                var data = await response.json();
                var vessels = data.data && data.data.vessels ? data.data.vessels : [];

                var totalCost = vessels.reduce(function(sum, vessel) {
                    var md = vessel.maintenance_data;
                    if (!md) return sum;
                    for (var i = 0; i < md.length; i++) {
                        if (md[i].type === 'drydock_minor') {
                            return sum + (md[i].discounted_price || md[i].price || 0);
                        }
                    }
                    return sum;
                }, 0);

                return {
                    vessels: vessels,
                    totalCost: totalCost,
                    cash: data.user ? data.user.cash || 0 : 0
                };
            } catch (e) {
                lastError = e;
                log('fetchDrydockStatus attempt ' + attempt + '/' + maxRetries + ' failed: ' + e.message);
                if (attempt < maxRetries) {
                    var delay = attempt * RETRY_BASE_DELAY_MS;
                    await new Promise(function(resolve) { setTimeout(resolve, delay); });
                }
            }
        }

        throw lastError;
    }

    async function triggerBulkDrydock(vesselIds) {
        // Uses xhrPost to bypass window.fetch interceptors (AutoDrydock)
        return xhrPost(API_BASE + '/maintenance/do-major-drydock-maintenance-bulk', {
            vessel_ids: JSON.stringify(vesselIds),
            speed: 'minimum',
            maintenance_type: 'minor'
        });
    }

    // ============================================
    // GET BUILT VESSELS IN PENDING
    // ============================================
    function getBuiltPendingVessels() {
        var vesselStore = getStore('vessel');
        if (!vesselStore || !vesselStore.userVessels) return [];

        return vesselStore.userVessels.filter(function(v) {
            return v.status === 'pending' && v.delivery_price !== null && v.delivery_price > 0;
        });
    }

    // ============================================
    // UI INJECTION
    // ============================================
    function isPendingTab() {
        var buttons = document.querySelectorAll('#notifications-vessels-listing .bottomWrapper button.btn-block');
        // pending is the 4th button (index 3), active when selected
        return buttons.length >= 4 && buttons[3].classList.contains('active');
    }

    function injectCheckboxes() {
        if (!isPendingTab()) {
            var existing = document.querySelectorAll('.fast-delivery-checkbox');
            if (existing.length > 0) {
                existing.forEach(function(cb) { cb.remove(); });
            }
            selectedVessels.clear();
            vesselDataMap.clear();
            return;
        }

        var vesselList = document.querySelector('#notifications-vessels-listing .vesselList');
        if (!vesselList) return;

        var builtVessels = getBuiltPendingVessels();
        // Build name→vessel map for O(1) lookup
        var nameMap = {};
        for (var i = 0; i < builtVessels.length; i++) {
            nameMap[builtVessels[i].name] = builtVessels[i];
            vesselDataMap.set(builtVessels[i].id, builtVessels[i]);
        }

        var vesselRows = vesselList.querySelectorAll('.vesselRow');
        vesselRows.forEach(function(row) {
            var nameEl = row.querySelector('.vesselName .nameValue');
            if (!nameEl) return;
            var vesselName = nameEl.textContent.trim();

            var existingCheckbox = row.querySelector('.fast-delivery-checkbox');

            var vessel = nameMap[vesselName];
            if (!vessel) {
                if (existingCheckbox) existingCheckbox.remove();
                return;
            }

            if (existingCheckbox) return;

            var checkboxWrapper = document.createElement('div');
            checkboxWrapper.className = 'fast-delivery-checkbox';
            checkboxWrapper.style.cssText = 'position:absolute;left:8px;top:50%;transform:translateY(-50%);z-index:10;';

            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.vesselId = vessel.id;
            checkbox.style.cssText = 'width:18px;height:18px;cursor:pointer;accent-color:#f59e0b;';

            checkbox.addEventListener('change', function(e) {
                e.stopPropagation();
                var vid = parseInt(this.dataset.vesselId, 10);
                if (this.checked) {
                    selectedVessels.add(vid);
                } else {
                    selectedVessels.delete(vid);
                }
                updateButtonStates();
            });

            checkbox.addEventListener('click', function(e) {
                e.stopPropagation();
            });

            checkboxWrapper.appendChild(checkbox);
            row.style.position = 'relative';
            row.style.paddingLeft = '40px';
            row.insertBefore(checkboxWrapper, row.firstChild);
        });
    }

    function injectButtons() {
        var existing = document.getElementById('fast-delivery-buttons');

        if (!isPendingTab()) {
            if (existing) { existing.remove(); }
            return;
        }

        var builtVessels = getBuiltPendingVessels();
        if (builtVessels.length === 0) {
            if (existing) { existing.remove(); }
            return;
        }

        if (existing) return;

        var container = document.querySelector('#notifications-vessels-listing .buttonWrapper');
        if (!container) {
            container = document.querySelector('.buttonWrapper');
        }
        if (!container) return;

        var buttonContainer = document.createElement('div');
        buttonContainer.id = 'fast-delivery-buttons';
        buttonContainer.style.cssText = 'grid-column:1/-1;width:100%;display:flex;gap:4px;padding:0;box-sizing:border-box;margin-bottom:4px;';

        var allBtn = createButton('All', function() { selectAll(true); });
        allBtn.id = 'fast-delivery-all-btn';

        var noneBtn = createButton('None', function() { selectAll(false); });
        noneBtn.id = 'fast-delivery-none-btn';

        var fastBtn = createButton('Fast Delivery', function() { processSelectedVessels(); });
        fastBtn.id = 'fast-delivery-btn';
        fastBtn.disabled = true;
        fastBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';

        buttonContainer.appendChild(allBtn);
        buttonContainer.appendChild(noneBtn);
        buttonContainer.appendChild(fastBtn);

        container.insertBefore(buttonContainer, container.firstChild);

        log('Buttons injected');
    }

    function createButton(text, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-depart btn-block default light-blue';
        btn.style.cssText = 'flex:1;padding-top:2px;padding-bottom:2px;min-height:0;';

        var btnContent = document.createElement('div');
        btnContent.className = 'btn-content-wrapper fit-btn-text';
        btnContent.style.fontSize = '14px';
        btnContent.textContent = text;

        btn.appendChild(btnContent);
        btn.addEventListener('click', onClick);
        return btn;
    }

    function updateButtonStates() {
        var fastBtn = document.getElementById('fast-delivery-btn');
        if (!fastBtn) return;
        var disabled = selectedVessels.size === 0 || isProcessing;
        fastBtn.disabled = disabled;
        fastBtn.style.opacity = disabled ? '0.5' : '1';
        fastBtn.style.cursor = disabled ? 'not-allowed' : 'pointer';
    }

    // ============================================
    // SELECTION FUNCTIONS
    // ============================================
    function selectAll(select) {
        var listing = document.getElementById('notifications-vessels-listing');
        var checkboxes = listing ? listing.querySelectorAll('.fast-delivery-checkbox input[type="checkbox"]') : [];

        checkboxes.forEach(function(cb) {
            cb.checked = select;
        });

        if (select) {
            var builtVessels = getBuiltPendingVessels();
            builtVessels.forEach(function(v) { selectedVessels.add(v.id); });
        } else {
            selectedVessels.clear();
        }

        updateButtonStates();
        log('Selection: ' + selectedVessels.size + ' vessels');
    }

    // ============================================
    // PROCESS VESSELS - SHOW CONFIRMATION MODAL
    // ============================================
    async function processSelectedVessels() {
        if (selectedVessels.size === 0) {
            showToast('No vessels selected', 'error');
            return;
        }
        if (isProcessing) return;

        isProcessing = true;
        updateButtonStates();

        var vesselIds = Array.from(selectedVessels);

        try {
            var drydockStatus = await fetchDrydockStatus(vesselIds);
            showConfirmationModal(vesselIds, drydockStatus.totalCost || 0, drydockStatus.cash || 0);
        } catch (err) {
            log('Error fetching drydock status: ' + err.message);
            showToast('Failed to get drydock cost', 'error');
            isProcessing = false;
            updateButtonStates();
        }
    }

    // ============================================
    // CONFIRMATION MODAL (Custom modal like auto-repair)
    // ============================================
    var isFDModalOpen = false;

    function injectFDModalStyles() {
        if (document.getElementById('fd-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'fd-modal-styles';
        style.textContent = [
            '@keyframes fd-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes fd-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes fd-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes fd-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',
            '#fd-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',
            '#fd-modal-wrapper #fd-modal-background{animation:fd-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#fd-modal-wrapper.hide #fd-modal-background{animation:fd-fade-out .15s linear forwards}',
            '#fd-modal-wrapper #fd-modal-content-wrapper{animation:fd-drop-down .15s linear forwards,fd-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#fd-modal-wrapper.hide #fd-modal-content-wrapper{animation:fd-push-up .15s linear forwards,fd-fade-out .15s linear forwards}',
            '@media screen and (min-width:1200px){#fd-modal-wrapper #fd-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#fd-modal-wrapper #fd-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#fd-modal-wrapper #fd-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#fd-modal-wrapper #fd-modal-content-wrapper{max-width:100%}}',
            '#fd-modal-wrapper #fd-modal-container{background-color:#fff;height:100vh;overflow:hidden;position:absolute;width:100%}',
            '#fd-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',
            '#fd-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',
            '#fd-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#fd-modal-container .header-icon.closeModal{height:19px;width:19px}',
            '#fd-modal-container #fd-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',
            '#fd-modal-container #fd-central-container{background-color:#e9effd;margin:0;overflow-x:hidden;overflow-y:auto;width:100%;flex:1;padding:10px 15px}',
            '#fd-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeFDModal() {
        if (!isFDModalOpen) return;
        log('Closing FD modal');
        isFDModalOpen = false;
        var modalWrapper = document.getElementById('fd-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
        }
        isProcessing = false;
        updateButtonStates();
    }

    function createInfoRow(label, value, noMargin) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;' + (noMargin ? '' : 'margin-bottom:10px;');
        var labelSpan = document.createElement('span');
        labelSpan.style.cssText = 'font-size:14px;color:#626b90;';
        labelSpan.textContent = label;
        var valueSpan = document.createElement('span');
        valueSpan.style.cssText = 'font-size:14px;font-weight:700;color:#01125d;';
        valueSpan.textContent = value;
        row.appendChild(labelSpan);
        row.appendChild(valueSpan);
        return row;
    }

    function showConfirmationModal(vesselIds, totalCost, cash) {
        var modalStore = getStore('modal');
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectFDModalStyles();

        var existing = document.getElementById('fd-modal-wrapper');
        if (existing) existing.remove();

        var headerEl = document.querySelector('header');
        var headerHeight = headerEl ? headerEl.offsetHeight : 89;

        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'fd-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'fd-modal-background';
        modalBackground.onclick = function() { closeFDModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'fd-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'fd-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Fast Delivery';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeFDModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;';
            fallback.onclick = function() { closeFDModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        var modalContent = document.createElement('div');
        modalContent.id = 'fd-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'fd-central-container';

        var canAfford = cash >= totalCost;

        // Build modal body with DOM methods (XSS-safe)
        var contentDiv = document.createElement('div');
        contentDiv.style.cssText = 'padding:20px;max-width:400px;margin:0 auto;font-family:Lato,sans-serif;color:#01125d;';

        var desc = document.createElement('div');
        desc.style.cssText = 'margin-bottom:16px;font-size:14px;color:#626b90;line-height:1.5;';
        desc.textContent = 'By triggering drydock immediately after build, delivery time is reduced to ' + DRYDOCK_DURATION_MIN + ' minutes (the drydock duration). This is a known game exploit.';
        contentDiv.appendChild(desc);

        var infoBox = document.createElement('div');
        infoBox.style.cssText = 'background:#ebe9ea;border-radius:8px;padding:16px;margin-bottom:16px;';
        infoBox.appendChild(createInfoRow('Vessels', String(vesselIds.length)));
        infoBox.appendChild(createInfoRow('Total Drydock Cost', '$' + totalCost.toLocaleString()));
        infoBox.appendChild(createInfoRow('Your Cash', '$' + cash.toLocaleString(), true));
        contentDiv.appendChild(infoBox);

        if (!canAfford) {
            var warning = document.createElement('div');
            warning.style.cssText = 'background:#fee2e2;border-radius:8px;padding:12px;margin-bottom:16px;color:#dc2626;font-size:13px;font-weight:500;';
            warning.textContent = 'Not enough cash to afford drydock!';
            contentDiv.appendChild(warning);
        }

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-top:24px;';

        var cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'padding:10px 24px;background:linear-gradient(90deg,#d7d8db,#95969b);border:0;border-radius:6px;color:#393939;cursor:pointer;font-size:16px;font-weight:500;font-family:Lato,sans-serif;';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function() { closeFDModal(); });

        var confirmBtn = document.createElement('button');
        confirmBtn.disabled = !canAfford;
        confirmBtn.style.cssText = 'padding:10px 24px;background:' + (canAfford ? 'linear-gradient(180deg,#f59e0b,#d97706)' : '#9ca3af') + ';border:0;border-radius:6px;color:#fff;cursor:' + (canAfford ? 'pointer' : 'not-allowed') + ';font-size:16px;font-weight:500;font-family:Lato,sans-serif;opacity:' + (canAfford ? '1' : '0.6') + ';';
        confirmBtn.textContent = 'Activate Fast Delivery';
        confirmBtn.addEventListener('click', async function() {
            if (!canAfford || this.disabled) return;
            this.disabled = true;
            this.style.opacity = '0.6';
            this.style.cursor = 'not-allowed';
            await executeFastDelivery(vesselIds);
            closeFDModal();
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(confirmBtn);
        contentDiv.appendChild(btnRow);
        centralContainer.appendChild(contentDiv);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isFDModalOpen = true;
    }

    async function executeFastDelivery(vesselIds) {
        try {
            log('Triggering fast delivery for ' + vesselIds.length + ' vessels');
            var result = await triggerBulkDrydock(vesselIds);

            if (result.data && result.data.success) {
                var msg = vesselIds.length === 1
                    ? 'Fast delivery activated - vessel will arrive in ' + DRYDOCK_DURATION_MIN + ' minutes'
                    : 'Fast delivery activated - ' + vesselIds.length + ' vessels will arrive in ' + DRYDOCK_DURATION_MIN + ' minutes';
                showToast(msg, 'success');
                log(msg);

                window.dispatchEvent(new CustomEvent('drydock-completed'));
                refreshVesselList();
            } else {
                throw new Error('API returned failure');
            }
        } catch (err) {
            log('Fast delivery failed: ' + err.message);
            showToast('Fast delivery failed. Check console for details.', 'error');
        } finally {
            selectedVessels.clear();
            isProcessing = false;
            updateButtonStates();
        }
    }

    function refreshVesselList() {
        var vesselStore = getStore('vessel');
        if (!vesselStore || !vesselStore.fetchUserVessels) return;

        vesselStore.fetchUserVessels().then(function() {
            log('Refreshed vessel list');
            injectCheckboxes();
            updateButtonStates();
        }).catch(function(err) {
            log('refreshVesselList error: ' + err.message);
        });
    }

    // ============================================
    // INITIALIZE WITH MUTATION OBSERVER
    // ============================================
    var debounceTimer = null;
    var observer = null;

    function debouncedInject() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function() {
            injectCheckboxes();
            injectButtons();
        }, DEBOUNCE_MS);
    }

    function startObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver(function() {
            debouncedInject();
        });

        var listing = document.getElementById('notifications-vessels-listing');
        if (!listing) return false;

        observer.observe(listing, { childList: true, subtree: true });
        log('Observer started on #notifications-vessels-listing');
        return true;
    }

    function init() {
        var lastListing = null;

        function checkListing() {
            var listing = document.getElementById('notifications-vessels-listing');
            if (listing !== lastListing) {
                if (lastListing && observer) {
                    observer.disconnect();
                    observer = null;
                }
                lastListing = listing;

                if (listing) {
                    startObserver();
                    debouncedInject();
                }
            }
        }

        var pollTimer = setInterval(checkListing, 500);
        checkListing();

        window.addEventListener('beforeunload', function() {
            if (pollTimer) clearInterval(pollTimer);
            if (observer) observer.disconnect();
        });
    }

    init();
    log('Script loaded');
})();
