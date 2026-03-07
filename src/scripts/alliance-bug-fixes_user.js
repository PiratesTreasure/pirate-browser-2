// ==UserScript==
// @name        ShippingManager - Alliance Tools
// @description Alliance ID display, interim CEO edit buttons, member exclude for management/COO
// @version     1.21
// @author      https://github.com/justonlyforyou/
// @order        18
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// ==/UserScript==

(function() {
    'use strict';

    var cachedPinia = null;
    var modalObserver = null;
    var membersObserver = null;
    var isUpdating = false;

    // ============================================
    // PINIA STORE ACCESS (shared)
    // ============================================
    function getPinia() {
        if (cachedPinia) return cachedPinia;
        var app = document.getElementById('app');
        if (!app || !app.__vue_app__) return null;
        cachedPinia = app.__vue_app__._context.provides.pinia || app.__vue_app__.config.globalProperties.$pinia;
        return cachedPinia;
    }

    function getStore(name) {
        var pinia = getPinia();
        return pinia && pinia._s ? pinia._s.get(name) : null;
    }

    function getLanguage() {
        var app = document.getElementById('app');
        return app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$Language : null;
    }

    function getMyMember() {
        var userStore = getStore('user');
        var allianceStore = getStore('alliance');
        if (!userStore || !userStore.user || !allianceStore || !allianceStore.members) return null;
        var userId = userStore.user.id;
        return allianceStore.members.find(function(m) { return m.user_id === userId; });
    }

    function showToast(msg, type) {
        var toast = getStore('toast');
        if (!toast) return;
        if (type === 'error' && toast.error) toast.error(msg);
        else if (toast.success) toast.success(msg);
    }

    // ============================================
    // FEATURE 1: Alliance ID Badge
    // ============================================
    var _idRetryTimer = null;
    var _idRetryCount = 0;

    function injectAllianceId() {
        var nameEl = document.getElementById('alliance-name');
        if (!nameEl || nameEl.querySelector('[data-at-id-badge]')) return;

        var allianceStore = getStore('alliance');
        if (!allianceStore || !allianceStore.alliance) {
            // Store not ready yet, retry up to 10 times (5 seconds total)
            if (_idRetryCount < 10) {
                _idRetryCount++;
                _idRetryTimer = setTimeout(injectAllianceId, 500);
            }
            return;
        }

        var alliance = allianceStore.alliance;
        var allianceId = alliance.id || (alliance.value && alliance.value.id);
        if (!allianceId) {
            if (_idRetryCount < 10) {
                _idRetryCount++;
                _idRetryTimer = setTimeout(injectAllianceId, 500);
            }
            return;
        }
        _idRetryCount = 0;

        var badge = document.createElement('span');
        badge.setAttribute('data-at-id-badge', 'true');
        badge.textContent = '(' + allianceId + ')';
        badge.title = 'Click to copy Alliance ID';
        badge.style.cssText = 'color:#626b90;font-size:inherit;font-weight:400;margin-left:5px;cursor:pointer;opacity:0.8;';
        badge.addEventListener('mouseenter', function() { badge.style.opacity = '1'; badge.style.textDecoration = 'underline'; });
        badge.addEventListener('mouseleave', function() { badge.style.opacity = '0.8'; badge.style.textDecoration = 'none'; });
        badge.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(String(allianceId)).then(function() { showToast('Alliance ID copied!', 'success'); });
            }
        });

        nameEl.appendChild(badge);
    }

    // ============================================
    // FEATURE 2: Interim CEO Edit Buttons
    // ============================================
    async function updateAllianceData(payload) {
        if (isUpdating) return;
        isUpdating = true;

        var Language = getLanguage();
        var allianceStore = getStore('alliance');

        try {
            var response = await fetch('/api/alliance/update-alliance-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error('HTTP ' + response.status);
            var data = await response.json();

            if (data.error) {
                showToast('Update failed', 'error');
            } else {
                var msgKey = payload.name ? 'Alliance/management/name_updated' : 'Alliance/management/description_updated';
                var fallback = payload.name ? 'Alliance name updated' : 'Alliance description updated';
                var msg = Language && Language.text ? Language.text(msgKey) || fallback : fallback;
                showToast(msg, 'success');
                if (data.data && allianceStore && allianceStore.update) {
                    allianceStore.update(data.data);
                }
            }
        } catch (err) {
            console.error('[Alliance Tools] Update error:', err);
            showToast('Update failed', 'error');
        } finally {
            isUpdating = false;
        }
    }

    function showEditPrompt(type) {
        var allianceStore = getStore('alliance');
        var toast = getStore('toast');
        var Language = getLanguage();

        if (!allianceStore || !allianceStore.alliance) return;

        var currentValue = type === 'name' ? allianceStore.alliance.name : allianceStore.alliance.description;
        var titleKey = type === 'name' ? 'Alliance/management/edit_name' : 'Alliance/management/edit_description';
        var titleFallback = type === 'name' ? 'Edit Alliance Name' : 'Edit Alliance Description';
        var title = Language && Language.text ? Language.text(titleKey) || titleFallback : titleFallback;

        if (toast && toast.input) {
            toast.input(title, currentValue, [
                { text: Language && Language.text ? Language.text('General/save') || 'Save' : 'Save', buttonColor: 'blue', value: true },
                { text: Language && Language.text ? Language.text('General/cancel') || 'Cancel' : 'Cancel', value: false }
            ]).then(function(result) {
                if (result === false || result === currentValue) return;
                if (type === 'name') {
                    if (String(result).length < 3) {
                        showToast('Name must be at least 3 characters', 'error');
                        return;
                    }
                    updateAllianceData({ name: result });
                } else {
                    updateAllianceData({ description: result });
                }
            });
        }
    }

    function createEditButton(type) {
        var btn = document.createElement('div');
        btn.className = 'edit-btn no-select';
        btn.dataset.atEditBtn = type;
        btn.style.cssText = 'cursor:pointer;margin-left:5px;display:inline-block;';

        var img = document.createElement('img');
        img.src = '/images/alliances/edit_alliance_icon.svg';
        img.style.cssText = 'width:16px;height:16px;';
        btn.appendChild(img);

        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            showEditPrompt(type);
        });

        return btn;
    }

    function injectEditButtons() {
        var myMember = getMyMember();
        if (!myMember || myMember.role !== 'interim_ceo') return;

        var nameEl = document.getElementById('alliance-name');
        if (nameEl && !nameEl.querySelector('.edit-btn')) {
            nameEl.appendChild(createEditButton('name'));
        }

        var descEl = document.getElementById('alliance-description');
        if (descEl && !descEl.querySelector('.edit-btn')) {
            descEl.appendChild(createEditButton('description'));
        }
    }

    // ============================================
    // FEATURE 3: Member Exclude Buttons
    // ============================================
    async function doKick(userId, companyName, isCeoConfirm) {
        var Language = getLanguage();
        var body = { user_id: userId };
        if (isCeoConfirm) body.ceo_confirmed = true;

        try {
            var response = await fetch('/api/alliance/exclude-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(body)
            });

            if (!response.ok) throw new Error('HTTP ' + response.status);
            var data = await response.json();

            if (data.error === 'ceo_inactivity_period_not_reached') {
                var msg = Language && Language.text ? Language.text('Errors/ceo_inactivity_period_not_reached') || 'CEO inactivity period not reached (14 days required)' : 'CEO inactivity period not reached (14 days required)';
                showToast(msg, 'error');
            } else if (data.error === 'ceo_inactivity_period_reached_confirm') {
                var confirmMsg = Language && Language.text ? Language.text('Alliance/management/ceo_inactivity_period_reached_confirm', {'[company_name]': companyName}) || 'Final confirm: Remove ' + companyName + ' as CEO permanently?' : 'Final confirm: Remove ' + companyName + ' as CEO permanently?';
                var toast = getStore('toast');
                if (toast && toast.prompt) {
                    toast.prompt(confirmMsg, [
                        { text: 'Yes', buttonColor: 'red', value: true },
                        { text: 'No', value: false }
                    ]).then(function(yes) { if (yes) doKick(userId, companyName, true); });
                }
            } else if (data.error) {
                showToast('Exclude failed', 'error');
            } else {
                var allianceStore = getStore('alliance');
                if (allianceStore && allianceStore.fetchAllianceData) {
                    allianceStore.fetchAllianceData();
                }
                showToast('Member excluded', 'success');
            }
        } catch (err) {
            console.error('[Alliance Tools] doKick error:', err);
            showToast('Network error', 'error');
        }
    }

    function promptKick(member) {
        var toast = getStore('toast');
        var lang = getLanguage();
        var msg = lang && lang.text ? lang.text('Alliance/management/exclude_user_prompt', {'[company_name]': member.company_name}) || 'Remove ' + member.company_name + ' from alliance?' : 'Remove ' + member.company_name + ' from alliance?';

        if (toast && toast.prompt) {
            toast.prompt(msg, [
                { text: 'Yes', buttonColor: 'red', value: true },
                { text: 'No', value: false }
            ]).then(function(confirmed) {
                if (confirmed) doKick(member.user_id, member.company_name);
            });
        }
    }

    function createExcludeButton(member) {
        var Language = getLanguage();
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'undefined undefined btn default red';
        btn.dataset.atExcludeBtn = member.user_id;

        var btnContent = document.createElement('div');
        btnContent.className = 'btn-content-wrapper ';
        btnContent.textContent = Language && Language.text ? Language.text('Alliance/management/exclude') || 'Exclude' : 'Exclude';
        btn.appendChild(btnContent);

        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            promptKick(member);
        });

        return btn;
    }

    function injectExcludeButtons() {
        var myMember = getMyMember();
        if (!myMember) return;

        // CEO already has all buttons from game
        if (myMember.role === 'ceo') return;

        // Only management roles can kick
        if (myMember.role !== 'interim_ceo' && myMember.role !== 'coo' && myMember.role !== 'management') return;

        var allianceStore = getStore('alliance');
        var userStore = getStore('user');
        if (!allianceStore || !allianceStore.members || !userStore || !userStore.user) return;

        var myUserId = userStore.user.id;

        // Build lookup: company_name -> member (only kickable = regular members)
        var kickableByName = {};
        for (var m = 0; m < allianceStore.members.length; m++) {
            var member = allianceStore.members[m];
            if (member.user_id === myUserId) continue;
            if (member.role === 'ceo') continue;
            if (member.has_management_role) continue;
            kickableByName[member.company_name.replace(/\u00a0/g, ' ').trim()] = member;
        }

        // Use specific selector: #members-container > .member-container
        var memberContainers = document.querySelectorAll('#members-container > .member-container');

        for (var i = 0; i < memberContainers.length; i++) {
            var container = memberContainers[i];
            if (container.querySelector('[data-at-exclude-btn]')) continue;

            var companyNameEl = container.querySelector('.company-name');
            if (!companyNameEl) continue;

            var companyName = companyNameEl.textContent.trim();
            var matchedMember = kickableByName[companyName];
            if (!matchedMember) continue;

            var buttonRow = container.querySelector('.button-row');
            if (!buttonRow) continue;

            buttonRow.appendChild(createExcludeButton(matchedMember));
        }
    }

    // Fix: CEO exclude button (for when interim_ceo/management wants to kick inactive CEO)
    function fixCeoExcludeButton() {
        var myMember = getMyMember();
        if (!myMember || myMember.role === 'ceo') return;

        var managementContent = document.getElementById('management-content');
        if (!managementContent) return;

        // Look for red buttons outside member list (the CEO exclude button)
        var redBtns = managementContent.querySelectorAll('.btn.red');
        for (var i = 0; i < redBtns.length; i++) {
            var btn = redBtns[i];
            if (btn.closest('#members-container')) continue;
            if (btn.dataset.atCeoFixed) continue;
            if (btn.dataset.atExcludeBtn) continue;

            var ceo = allianceStore_getCEO();
            if (!ceo) continue;

            // Hide broken button, replace with working one
            btn.style.display = 'none';
            btn.dataset.atCeoFixed = 'true';

            var newBtn = document.createElement('button');
            newBtn.type = 'button';
            newBtn.className = btn.className;
            newBtn.dataset.atExcludeBtn = 'ceo';

            var newBtnContent = document.createElement('div');
            newBtnContent.className = 'btn-content-wrapper';
            newBtnContent.textContent = btn.textContent.trim();
            newBtn.appendChild(newBtnContent);

            newBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                var currentCeo = allianceStore_getCEO();
                if (currentCeo) promptKick(currentCeo);
            });

            btn.parentNode.insertBefore(newBtn, btn.nextSibling);
        }
    }

    function allianceStore_getCEO() {
        var alliance = getStore('alliance');
        if (!alliance || !alliance.members) return null;
        return alliance.members.find(function(m) { return m.role === 'ceo'; });
    }

    // ============================================
    // OBSERVERS
    // ============================================
    var modalDebounceTimer = null;
    var membersDebounceTimer = null;
    var lastMembersContainer = null;

    function onAllianceContent() {
        injectAllianceId();
        injectEditButtons();

        // Watch members-container only when it appears (Members tab)
        var mc = document.getElementById('members-container');
        if (mc && mc !== lastMembersContainer) {
            lastMembersContainer = mc;
            if (membersObserver) membersObserver.disconnect();

            injectExcludeButtons();
            fixCeoExcludeButton();

            membersObserver = new MutationObserver(function() {
                if (membersDebounceTimer) clearTimeout(membersDebounceTimer);
                membersDebounceTimer = setTimeout(function() {
                    injectExcludeButtons();
                    fixCeoExcludeButton();
                }, 300);
            });
            membersObserver.observe(mc, { childList: true });
        }
    }

    function onModalChange() {
        if (!document.getElementById('alliance-name')) {
            if (membersObserver) { membersObserver.disconnect(); membersObserver = null; }
            lastMembersContainer = null;
            if (_idRetryTimer) { clearTimeout(_idRetryTimer); _idRetryTimer = null; }
            _idRetryCount = 0;
            return;
        }
        if (modalDebounceTimer) clearTimeout(modalDebounceTimer);
        modalDebounceTimer = setTimeout(onAllianceContent, 200);
    }

    function init() {
        var lastModalContainer = null;
        var pollTimer = null;

        function checkModal() {
            var mc = document.getElementById('modal-container');
            if (mc && mc !== lastModalContainer) {
                if (lastModalContainer && modalObserver) {
                    modalObserver.disconnect();
                    modalObserver = null;
                }
                lastModalContainer = mc;
                modalObserver = new MutationObserver(onModalChange);
                modalObserver.observe(mc, { childList: true, subtree: true });
                onModalChange();
            }
        }

        pollTimer = setInterval(checkModal, 500);
        checkModal();

        window.addEventListener('beforeunload', function() {
            if (pollTimer) clearInterval(pollTimer);
            if (modalObserver) modalObserver.disconnect();
            if (membersObserver) membersObserver.disconnect();
            if (modalDebounceTimer) clearTimeout(modalDebounceTimer);
            if (membersDebounceTimer) clearTimeout(membersDebounceTimer);
            if (_idRetryTimer) clearTimeout(_idRetryTimer);
        });
    }

    init();
})();
