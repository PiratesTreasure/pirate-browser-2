// ==UserScript==
// @name        ShippingManager - VIP Vessel Shop
// @description Quick access to purchase all VIP vessels as much as you have points for ;)
// @version     2.29
// @author      https://github.com/justonlyforyou/
// @order        31
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// @RequireRebelShipMenu true
// ==/UserScript==
/* globals addSubMenu */

(function() {
    'use strict';

    var POINTS_ICON_URL = '/images/icons/points_icon.svg';

    // Cache for vessel data with 15 minute TTL
    var vesselCache = {
        data: {},
        timestamps: {}
    };
    var CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

    // VIP Vessels data (IDs 59-63)
    var VIP_VESSELS = [
        { id: 59, name: 'Starliner', type: 'Container', points: 2500 },
        { id: 60, name: 'MS Sundown', type: 'Tanker', points: 3500 },
        { id: 61, name: 'MS Anaconda', type: 'Container', points: 4500 },
        { id: 62, name: 'Big Bear', type: 'Container', points: 6000 },
        { id: 63, name: 'Ventura', type: 'Container', points: 8000 }
    ];

    // Get Pinia stores from Vue app
    function getStores() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) {
                console.error('[VIPVessel] Vue app not found');
                return null;
            }
            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) {
                console.error('[VIPVessel] Pinia store not found');
                return null;
            }
            return {
                modalStore: pinia._s.get('modal'),
                shopStore: pinia._s.get('shop'),
                vesselStore: pinia._s.get('vessel'),
                userStore: pinia._s.get('user')
            };
        } catch (e) {
            console.error('[VIPVessel] Failed to get stores:', e);
            return null;
        }
    }

    // Register submenu with all VIP vessels
    function createVIPVesselMenu() {
        var subItems = VIP_VESSELS.map(function(vessel) {
            return {
                label: vessel.name,
                price: vessel.points.toLocaleString(),
                icon: POINTS_ICON_URL,
                onClick: function() {
                    openVesselInGameModal(vessel.id);
                }
            };
        });
        addSubMenu('Buy VIP Vessel', subItems, 997);
        console.log('[VIPVessel] Submenu registered with ' + subItems.length + ' vessels');
    }

    // Fetch vessel data and open game modal
    function openVesselInGameModal(vesselId) {
        var stores = getStores();
        if (!stores) {
            alert('Failed to access game stores. Try refreshing the page.');
            return;
        }

        // Check cache first (15 minute TTL)
        var now = Date.now();
        if (vesselCache.data[vesselId] && vesselCache.timestamps[vesselId]) {
            var age = now - vesselCache.timestamps[vesselId];
            if (age < CACHE_TTL_MS) {
                console.log('[VIPVessel] Using cached data for vessel ' + vesselId + ' (age: ' + Math.round(age / 1000) + 's)');
                openModalWithVesselData(stores, vesselId, vesselCache.data[vesselId]);
                return;
            }
        }

        fetch('/api/vessel/show-acquirable-vessel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vessel_id: vesselId }),
            credentials: 'include'
        })
        .then(function(response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status + ': ' + response.statusText);
            }
            return response.json();
        })
        .then(function(data) {
            if (!data.data || !data.data.vessels_for_sale) {
                alert('Failed to load vessel data: Invalid API response');
                console.error('[VIPVessel] Invalid response:', data);
                return;
            }

            var vesselData = data.data.vessels_for_sale;

            // Cache the vessel data
            vesselCache.data[vesselId] = vesselData;
            vesselCache.timestamps[vesselId] = Date.now();

            openModalWithVesselData(stores, vesselId, vesselData);
        })
        .catch(function(err) {
            console.error('[VIPVessel] Error:', err);
            alert('Error loading vessel: ' + err.message);
        });
    }

    // Open modal with vessel data (extracted for cache reuse)
    function openModalWithVesselData(stores, vesselId, vesselData) {
        // If a modal is already open, close it first and reopen with new vessel
        if (stores.modalStore && stores.modalStore.component) {
            stores.modalStore.closeAll();
            setTimeout(function() {
                openModalWithVesselData(stores, vesselId, vesselData);
            }, 150);
            return;
        }

        var vipInfo = VIP_VESSELS.find(function(v) { return v.id === vesselId; });

        // Build full product object matching game's expected structure
        var product = {
            id: vesselId,
            name: vesselData.name,
            sku: 'vip_vessel',
            description: 'Get a special vessel with 50% more revenue for each depart',
            price: vipInfo ? vipInfo.points : vesselData.price_in_points,
            image: 'price_tag_icon.svg',
            rewards: [{ type: 'vessel', name: vesselData.name, vessel_id: vesselId }],
            order: 13,
            restricted: false,
            special_tag: null,
            one_time: null,
            bonus_value: null,
            delay_hours: null,
            discount: null,
            salary: 0,
            info: []
        };

        if (stores.shopStore) {
            stores.shopStore.vip_vessel = vesselData;
            stores.shopStore.selectedVessel = vesselData;
            stores.shopStore.selectedProduct = product;
        }

        if (stores.vesselStore) {
            stores.vesselStore.acquiringVessel = vesselData;
            stores.vesselStore.selectedVessel = vesselData;
        }

        stores.modalStore.props = {
            vip_vessel: vesselData,
            product: product,
            vessel: vesselData,
            componentProps: { vip_vessel: vesselData, product: product }
        };

        stores.modalStore.open('fleet', {
            initialPage: 'order',
            vip_vessel: vesselData,
            vessel: vesselData,
            product: product,
            componentProps: { vip_vessel: vesselData, product: product }
        });

        // Setup cleanup listener for when modal closes
        setupModalCloseCleanup(stores);
    }

    // Clean up store properties when modal closes
    function setupModalCloseCleanup(stores) {
        if (!stores.modalStore) return;

        var cleanup = function() {
            if (stores.shopStore) {
                stores.shopStore.selectedVessel = null;
                stores.shopStore.selectedProduct = null;
            }
            if (stores.vesselStore) {
                stores.vesselStore.selectedVessel = null;
            }
            console.log('[VIPVessel] Store cleanup completed');
        };

        // Watch for modal close via store state
        var unwatch = stores.modalStore.$subscribe(function(mutation, state) {
            if (!state.component) {
                cleanup();
                unwatch();
            }
        });
    }

    // Initialize
    function init() {
        createVIPVesselMenu();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
