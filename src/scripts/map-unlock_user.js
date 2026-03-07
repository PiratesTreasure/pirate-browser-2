// ==UserScript==
// @name        ShippingManager - Premium Feature Unlocker
// @description Unlocks premium map themes, tanker ops, metropolis and extended zoom
// @version     1.17
// @author      https://github.com/justonlyforyou/
// @order        30
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// ==/UserScript==

(function() {
    'use strict';

    if (window._rebelShipUnlockActive) return;
    window._rebelShipUnlockActive = true;

    var ALL_MAPS = {0: 'light', 1: 'dark', 2: 'street', 3: 'satellite', 4: 'city', 5: 'sky'};
    var EXTENDED_ZOOM = 18;
    var patchDebounce = null;

    var initInterval = null;
    var cookieInterval = null;
    var featuresUnlocked = false;
    var zoomUnlocked = false;

    function acceptCookies() {
        var banner = document.querySelector('.cookieConsent');
        if (banner) {
            var btn = banner.querySelector('button.dark-green');
            if (btn) {
                btn.click();
                return true;
            }
        }
        return false;
    }

    function applyFeaturePatch(userStore) {
        var settings = userStore.settings;
        var user = userStore.user;
        if (!user || !settings) return;

        // Tanker ops
        var companyType = user.company_type;
        if (companyType) {
            var hasTanker = Array.isArray(companyType) ? companyType.indexOf('tanker') !== -1 : (typeof companyType === 'string' && companyType.indexOf('tanker') >= 0);
            if (!hasTanker) {
                user.company_type = Array.isArray(companyType) ? companyType.slice().concat(['tanker']) : [companyType, 'tanker'];
            }
        }

        // Metropolis
        if (!settings.metropolis) settings.metropolis = 1;

        // All map themes unlocked
        settings.maps = ALL_MAPS;

        // Extended zoom
        if (!settings.zoom) settings.zoom = EXTENDED_ZOOM;
    }

    function unlockFeatures() {
        if (featuresUnlocked) return;
        try {
            var app = document.querySelector('#app');
            if (!app || !app.__vue_app__) return;
            var pinia = app.__vue_app__._context.provides.pinia || app.__vue_app__.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return;
            var userStore = pinia._s.get('user');
            if (!userStore || !userStore.user) return;

            applyFeaturePatch(userStore);

            userStore.$subscribe(function() {
                if (patchDebounce) clearTimeout(patchDebounce);
                patchDebounce = setTimeout(function() {
                    if (userStore.user) applyFeaturePatch(userStore);
                }, 500);
            });

            featuresUnlocked = true;
        } catch {}
    }

    function unlockZoom() {
        if (zoomUnlocked) return;
        try {
            var app = document.querySelector('#app');
            if (!app || !app.__vue_app__) return;
            var pinia = app.__vue_app__._context.provides.pinia || app.__vue_app__.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return;
            var mapStore = pinia._s.get('mapStore');
            if (mapStore && mapStore.map) {
                mapStore.map.setMinZoom(1);
                mapStore.map.setMaxZoom(EXTENDED_ZOOM);
                zoomUnlocked = true;
            }
        } catch {}
    }

    var initTries = 0;

    function tryInit() {
        initTries++;
        unlockFeatures();
        unlockZoom();

        if (featuresUnlocked && zoomUnlocked) {
            clearInterval(initInterval);
            initInterval = null;
            console.log('[Map Unlock] Init complete after ' + initTries + ' tries');
        } else if (initTries > 30) {
            clearInterval(initInterval);
            initInterval = null;
            console.log('[Map Unlock] Init stopped after max tries');
        }
    }

    // Cookie accept (self-clearing)
    var cookieTries = 0;
    cookieInterval = setInterval(function() {
        if (acceptCookies() || cookieTries++ > 20) {
            clearInterval(cookieInterval);
            cookieInterval = null;
        }
    }, 500);

    setTimeout(tryInit, 500);
    initInterval = setInterval(tryInit, 2000);

    window.addEventListener('beforeunload', function() {
        if (initInterval) { clearInterval(initInterval); initInterval = null; }
        if (cookieInterval) { clearInterval(cookieInterval); cookieInterval = null; }
    });
})();
