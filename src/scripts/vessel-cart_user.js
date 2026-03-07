// ==UserScript==
// @name        ShippingManager - Vessel Shopping Cart
// @description Add vessels to cart and bulk purchase them
// @version     4.35
// @author      https://github.com/justonlyforyou/
// @order        24
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// @RequireRebelShipStorage true
// ==/UserScript==

/* global MutationObserver */

(function() {
    'use strict';

    // Inject interceptor script into page context (has access to Vue internals)
    var interceptorScript = document.createElement('script');
    interceptorScript.textContent = '(function(){if(window._rebelshipInterceptorInstalled)return;window._rebelshipInterceptorInstalled=true;window._rebelshipAllVessels=[];window._rebelshipLastBuildConfig=null;function findBuildVesselComponent(){var buildElements=document.querySelectorAll("[id*=build-vessel], .vesselCard, .engineCard");for(var i=0;i<buildElements.length;i++){var el=buildElements[i];var comp=el.__vueParentComponent;while(comp){if(comp.proxy&&comp.proxy.vessel){console.log("[VesselCart] Found vessel in proxy");return comp.proxy.vessel}if(comp.data&&typeof comp.data==="object"&&comp.data.vessel){console.log("[VesselCart] Found vessel in data");return comp.data.vessel}if(comp.setupState&&comp.setupState.vessel){console.log("[VesselCart] Found vessel in setupState");return comp.setupState.vessel}comp=comp.parent}}var appEl=document.querySelector("#app");if(!appEl)return null;var app=appEl.__vue_app__;if(!app)return null;var visited=new Set();function searchTree(vnode){if(!vnode||visited.has(vnode))return null;visited.add(vnode);if(vnode.component){var c=vnode.component;if(c.proxy&&c.proxy.vessel&&(c.proxy.vessel.capacity_type!==undefined||c.proxy.vessel.engine_model!==undefined)){console.log("[VesselCart] Found vessel via tree search (proxy)");return c.proxy.vessel}if(c.setupState&&c.setupState.vessel){console.log("[VesselCart] Found vessel via tree search (setupState)");return c.setupState.vessel}if(c.subTree){var found=searchTree(c.subTree);if(found)return found}}if(vnode.children&&Array.isArray(vnode.children)){for(var j=0;j<vnode.children.length;j++){var f=searchTree(vnode.children[j]);if(f)return f}}if(vnode.dynamicChildren){for(var k=0;k<vnode.dynamicChildren.length;k++){var g=searchTree(vnode.dynamicChildren[k]);if(g)return g}}return null}var rootComponent=app._container._vnode;if(rootComponent){return searchTree(rootComponent)}return null}window._rebelshipGetBuildConfig=function(){console.log("[VesselCart] _rebelshipGetBuildConfig called");var buildSection=document.querySelector("#build-vessel-order-section, [id*=build-vessel]");if(!buildSection){console.log("[VesselCart] Not on build page (no build-vessel section found)");return null}var vesselData=findBuildVesselComponent();if(!vesselData){console.log("[VesselCart] Could not find vessel data in Vue components");return null}console.log("[VesselCart] Raw vessel data from Vue:",JSON.stringify(vesselData,null,2));var vesselType=vesselData.capacity_type||vesselData.vessel_model||null;console.log("[VesselCart] Vessel type:",vesselType);var capacity=0;if(vesselData.capacity!==undefined&&vesselData.capacity!==null){if(typeof vesselData.capacity==="number"){capacity=vesselData.capacity;if(vesselType==="tanker"){capacity=Math.round(capacity*74);console.log("[VesselCart] Tanker capacity converted: "+vesselData.capacity+" * 74 = "+capacity+" BBL")}}else if(typeof vesselData.capacity==="object"){if(vesselType==="tanker"){capacity=(vesselData.capacity.fuel||0)+(vesselData.capacity.crude_oil||0)}else{capacity=(vesselData.capacity.dry||0)+(vesselData.capacity.refrigerated||0)}}}if(capacity===0&&vesselData.capacity_max){if(vesselType==="tanker"){capacity=(vesselData.capacity_max.fuel||0)+(vesselData.capacity_max.crude_oil||0)}else{capacity=(vesselData.capacity_max.dry||0)+(vesselData.capacity_max.refrigerated||0)}}console.log("[VesselCart] Final capacity:",capacity);var config={name:vesselData.name||"Custom Vessel",ship_yard:vesselData.ship_yard||null,vessel_model:vesselType,engine_type:vesselData.engine_model?(vesselData.engine_model.type||vesselData.engine_model):null,engine_kw:vesselData.engine_model?(vesselData.engine_model.power||0):0,capacity:capacity,antifouling_model:vesselData.antifouling_model?(vesselData.antifouling_model.model||vesselData.antifouling_model):null,bulbous:vesselData.bulbous?1:0,enhanced_thrusters:vesselData.enhanced_thrusters?1:0,propeller_types:vesselData.propeller?(vesselData.propeller.model||vesselData.propeller):null,range:vesselData.range||null};var priceEl=document.querySelector(".price .amount p, .price p:last-child");if(priceEl){var priceText=priceEl.textContent.replace(/[^0-9]/g,"");config.price=parseInt(priceText)||0;console.log("[VesselCart] Found price from DOM:",config.price)}console.log("[VesselCart] Converted build config:",config);return config};var originalXHROpen=XMLHttpRequest.prototype.open;var originalXHRSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(method,url){this._url=url;this._method=method;return originalXHROpen.apply(this,arguments)};XMLHttpRequest.prototype.send=function(body){var self=this;if(this._url&&this._url.indexOf("/api/vessel/get-all-acquirable-vessels")!==-1){this.addEventListener("load",function(){try{var data=JSON.parse(self.responseText);if(data&&data.data&&data.data.vessels_for_sale){window._rebelshipAllVessels=data.data.vessels_for_sale;console.log("[VesselCart Interceptor] Cached "+window._rebelshipAllVessels.length+" vessels")}}catch(e){}})}if(this._url&&this._url.indexOf("/api/vessel/build-vessel")!==-1&&this._method==="POST"){try{window._rebelshipLastBuildConfig=JSON.parse(body);console.log("[VesselCart Interceptor] Captured build config:",window._rebelshipLastBuildConfig)}catch(e){}}return originalXHRSend.apply(this,arguments)};var originalFetch=window.fetch;window.fetch=function(){var url=typeof arguments[0]==="string"?arguments[0]:"";var options=arguments[1];if(url.indexOf("/api/vessel/build-vessel")!==-1&&options&&options.method==="POST"){try{window._rebelshipLastBuildConfig=JSON.parse(options.body);console.log("[VesselCart Interceptor] Captured build config (fetch):",window._rebelshipLastBuildConfig)}catch(e){}}return originalFetch.apply(this,arguments).then(function(response){if(url.indexOf("/api/vessel/get-all-acquirable-vessels")!==-1){var clone=response.clone();clone.json().then(function(data){if(data&&data.data&&data.data.vessels_for_sale){window._rebelshipAllVessels=data.data.vessels_for_sale;console.log("[VesselCart Interceptor] Cached "+window._rebelshipAllVessels.length+" vessels")}}).catch(function(){})}return response})};console.log("[VesselCart Interceptor] Installed with _rebelshipGetBuildConfig")})();';
    (document.head || document.documentElement).appendChild(interceptorScript);
    interceptorScript.remove();


    // RebelShipBridge storage
    var SCRIPT_NAME = 'VesselCart';
    var STORE_NAME = 'data';

    var CART_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg>';

    var VIP_VESSELS = [
        { id: 59, name: 'Starliner', points: 2500 },
        { id: 60, name: 'MS Sundown', points: 3500 },
        { id: 61, name: 'MS Anaconda', points: 4500 },
        { id: 62, name: 'Big Bear', points: 6000 },
        { id: 63, name: 'Ventura', points: 8000 }
    ];
    var POINTS_ICON_URL = '/images/icons/points_icon.svg';

    // Cached cart data (object keyed by cart item key)
    var cachedCart = null;
    var drydockPortsCache = null;
    var watchDebounceTimer = null;
    var watchObserver = null;

    async function dbGet(key) {
        try {
            var result = await window.RebelShipBridge.storage.get(SCRIPT_NAME, STORE_NAME, key);
            if (result) {
                return JSON.parse(result);
            }
            return null;
        } catch (e) {
            console.error('[VesselCart] dbGet error:', e);
            return null;
        }
    }

    async function dbSet(key, value) {
        try {
            await window.RebelShipBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[VesselCart] dbSet error:', e);
            return false;
        }
    }

    // Migrate cart from array format to object format
    function migrateCart(data) {
        if (Array.isArray(data)) {
            var obj = {};
            for (var i = 0; i < data.length; i++) {
                var key = data[i].key || getCartItemKey(data[i].vessel);
                data[i].key = key;
                obj[key] = data[i];
            }
            return obj;
        }
        if (data && typeof data === 'object') return data;
        return {};
    }

    // Get cart from storage (async with callback)
    function getCart(callback) {
        if (cachedCart !== null) {
            callback(cachedCart);
            return;
        }
        dbGet('cart').then(function(data) {
            var migrated = migrateCart(data);
            // Persist migrated format if it was an array
            if (Array.isArray(data)) {
                dbSet('cart', migrated);
            }
            cachedCart = migrated;
            callback(cachedCart);
        }).catch(function(e) {
            console.error('[VesselCart] Failed to load cart:', e);
            cachedCart = {};
            callback(cachedCart);
        });
    }

    // Get cart synchronously (uses cache)
    function getCartSync() {
        return cachedCart !== null ? cachedCart : {};
    }

    // Save cart to storage
    function saveCart(cart) {
        cachedCart = cart;
        dbSet('cart', cart).then(function() {
            updateCartBadge();
        }).catch(function(e) {
            console.error('[VesselCart] Failed to save cart:', e);
        });
    }

    // Generate unique key for cart item
    function getCartItemKey(vessel) {
        if (vessel.type === 'build') {
            var cfg = vessel.buildConfig;
            return 'build_' + cfg.ship_yard + '_' + cfg.vessel_model + '_' + cfg.engine_type + '_' + cfg.capacity;
        }
        if (vessel.type === 'vip') {
            return 'vip_' + vessel.id;
        }
        return 'purchase_' + vessel.id;
    }

    // Add vessel to cart
    function addToCart(vessel, quantity) {
        quantity = quantity || 1;
        getCart(function(cart) {
            var key = getCartItemKey(vessel);

            if (cart[key]) {
                var oldQty = cart[key].quantity;
                cart[key].quantity += quantity;
                if (vessel.type === 'build' && cart[key].ships) {
                    var baseName = vessel.buildConfig.name || vessel.name;
                    var basePort = vessel.buildConfig.ship_yard || '';
                    for (var j = 0; j < quantity; j++) {
                        cart[key].ships.push({
                            name: baseName + '_' + (oldQty + j + 1),
                            port: basePort
                        });
                    }
                }
            } else {
                var item = { vessel: vessel, quantity: quantity, key: key };
                if (vessel.type === 'build') {
                    var bName = vessel.buildConfig.name || vessel.name;
                    var bPort = vessel.buildConfig.ship_yard || '';
                    item.ships = [];
                    for (var k = 0; k < quantity; k++) {
                        item.ships.push({
                            name: quantity > 1 ? bName + '_' + (k + 1) : bName,
                            port: bPort
                        });
                    }
                }
                cart[key] = item;
            }

            saveCart(cart);
            showNotification('Added to cart: ' + vessel.name + ' x' + quantity);
        });
    }

    // Remove from cart by key
    function removeFromCart(key) {
        getCart(function(cart) {
            delete cart[key];
            saveCart(cart);
        });
    }

    // Update quantity in cart by key
    function updateQuantity(key, newQuantity) {
        getCart(function(cart) {
            if (newQuantity <= 0) {
                removeFromCart(key);
                return;
            }
            var item = cart[key];
            if (!item) return;

            var oldQty = item.quantity;
            item.quantity = newQuantity;

            if (item.vessel.type === 'build' && item.ships) {
                if (newQuantity > oldQty) {
                    var baseName = item.vessel.buildConfig.name || item.vessel.name;
                    var basePort = item.vessel.buildConfig.ship_yard || '';
                    for (var j = oldQty; j < newQuantity; j++) {
                        item.ships.push({
                            name: baseName + '_' + (j + 1),
                            port: basePort
                        });
                    }
                } else if (newQuantity < oldQty) {
                    item.ships = item.ships.slice(0, newQuantity);
                }
            }
            saveCart(cart);
        });
    }

    // Update individual ship config (name/port) for build items
    function updateShipConfig(cartKey, shipIndex, field, value) {
        if (field !== 'name' && field !== 'port') return;
        if (field === 'name' && typeof value === 'string' && value.length > 100) {
            value = value.substring(0, 100);
        }
        getCart(function(cart) {
            var item = cart[cartKey];
            if (item && item.ships && item.ships[shipIndex]) {
                item.ships[shipIndex][field] = value;
                saveCart(cart);
            }
        });
    }

    // Clear cart
    function clearCart() {
        if (cachedCart) {
            var keys = Object.keys(cachedCart);
            for (var i = 0; i < keys.length; i++) {
                delete cachedCart[keys[i]];
            }
        }
        cachedCart = {};
        dbSet('cart', {}).then(function() {
            updateCartBadge();
        }).catch(function(e) {
            console.error('[VesselCart] Failed to clear cart:', e);
        });
    }

    // Get Pinia stores from Vue app
    function getStores() {
        try {
            var appEl = document.querySelector('#app');
            if (!appEl || !appEl.__vue_app__) return null;

            var app = appEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;

            var stores = {};
            pinia._s.forEach(function(store, name) {
                stores[name] = store;
            });

            return stores;
        } catch (e) {
            console.error('[VesselCart] Failed to get stores:', e);
            return null;
        }
    }

    // Get ports with drydock from route store (cached)
    function getDrydockPorts() {
        if (drydockPortsCache) return drydockPortsCache;
        var stores = getStores();
        if (!stores || !stores.route) {
            return [];
        }
        // Use drydockPorts directly if available (already filtered and sorted)
        if (stores.route.drydockPorts && stores.route.drydockPorts.length > 0) {
            drydockPortsCache = stores.route.drydockPorts;
            return drydockPortsCache;
        }
        // Fallback to filtering ports manually
        if (!stores.route.ports) {
            return [];
        }
        drydockPortsCache = stores.route.ports
            .filter(function(p) { return p.drydock !== null; })
            .sort(function(a, b) { return a.code.localeCompare(b.code); });
        return drydockPortsCache;
    }

    // Get anchor points info from stores
    function getAnchorPointsInfo() {
        var stores = getStores();
        if (!stores) {
            return null;
        }

        var userStore = stores.user;
        var totalAnchorPoints = userStore && userStore.settings ? userStore.settings.anchor_points : null;
        if (totalAnchorPoints === null) {
            return null;
        }

        var vesselStore = stores.vessel;
        var currentVessels = vesselStore && vesselStore.userVessels ? vesselStore.userVessels.length : 0;

        return {
            total: totalAnchorPoints,
            currentVessels: currentVessels,
            free: totalAnchorPoints - currentVessels
        };
    }

    // Get vessel name from the modal UI
    function getVesselNameFromUI() {
        var selectors = ['.name p', '.name', '.vessel-name p', '.vessel-name', '.ship-name'];

        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent) {
                var name = el.textContent.trim();
                if (name && name.length > 1 && name !== 'Order' && name !== 'Back' && name !== 'Fleet') {
                    return name;
                }
            }
        }

        return null;
    }

    // Check if we're on a build page
    function isOnBuildPage() {
        var buildSection = document.querySelector('#build-vessel-order-section, [id*="build-vessel"]');
        if (buildSection) {
            return true;
        }
        return false;
    }

    // Get build configuration from injected script
    function getBuildConfig() {
        if (typeof window._rebelshipGetBuildConfig === 'function') {
            var config = window._rebelshipGetBuildConfig();
            if (config) {
                return config;
            }
        }

        return null;
    }

    // Get current vessel or build config
    function getCurrentVessel() {
        if (isOnBuildPage()) {
            var buildConfig = getBuildConfig();
            if (buildConfig) {
                var vesselName = buildConfig.name || getVesselNameFromUI() || 'Custom Vessel';
                var buildPrice = buildConfig.price || 0;
                return {
                    type: 'build',
                    name: vesselName,
                    buildConfig: buildConfig,
                    price: buildPrice
                };
            } else {
                return null;
            }
        }

        var allVessels = Array.isArray(window._rebelshipAllVessels) ? window._rebelshipAllVessels : [];
        var vesselName2 = getVesselNameFromUI();

        if (!vesselName2) {
                console.warn('[VesselCart] getCurrentVessel: no vessel name found in UI');
                return null;
        }

        // Step 1: Exact match in cached acquirable vessels
        var vessel = null;
        for (var i = 0; i < allVessels.length; i++) {
            if (allVessels[i].name === vesselName2) {
                vessel = allVessels[i];
                break;
            }
        }

        // Step 2: Partial match in cached acquirable vessels
        if (!vessel) {
            for (var j = 0; j < allVessels.length; j++) {
                if (allVessels[j].name.indexOf(vesselName2) !== -1 || vesselName2.indexOf(allVessels[j].name) !== -1) {
                    vessel = allVessels[j];
                    break;
                }
            }
        }

        // Step 3: Check stores for VIP vessel data (set by buy-vip-vessel, game UI, or modal)
        if (!vessel) {
            var vipStores = getStores();
            if (vipStores) {
                var storeVessel = null;
                if (vipStores.vessel && vipStores.vessel.acquiringVessel) {
                    storeVessel = vipStores.vessel.acquiringVessel;
                }
                if (!storeVessel && vipStores.shop && vipStores.shop.vip_vessel) {
                    storeVessel = vipStores.shop.vip_vessel;
                }
                if (!storeVessel && vipStores.modal && vipStores.modal.props && vipStores.modal.props.vip_vessel) {
                    storeVessel = vipStores.modal.props.vip_vessel;
                }
                if (storeVessel && (storeVessel.name === vesselName2 || vesselName2.indexOf(storeVessel.name) !== -1 || storeVessel.name.indexOf(vesselName2) !== -1)) {
                    vessel = storeVessel;
                    console.log('[VesselCart] Found vessel via store fallback:', storeVessel.name);
                }
            }
        }

        // Step 4: Match against known VIP_VESSELS by name and construct vessel object
        if (!vessel) {
            for (var v = 0; v < VIP_VESSELS.length; v++) {
                if (VIP_VESSELS[v].name === vesselName2 || vesselName2.indexOf(VIP_VESSELS[v].name) !== -1 || VIP_VESSELS[v].name.indexOf(vesselName2) !== -1) {
                    vessel = { id: VIP_VESSELS[v].id, name: VIP_VESSELS[v].name };
                    console.log('[VesselCart] Matched VIP vessel by name fallback:', VIP_VESSELS[v].name);
                    break;
                }
            }
        }

        if (!vessel) {
            console.warn('[VesselCart] Vessel "' + vesselName2 + '" not found. acquirableVessels=' + allVessels.length + ', stores checked, VIP names checked');
            return null;
        }

        var vipInfo = getVipInfo(vessel);
        if (vipInfo) {
            return Object.assign({ type: 'vip', pointsPrice: vipInfo.points }, vessel);
        }

        return Object.assign({ type: 'purchase' }, vessel);
    }

    // Get quantity from input
    function getQuantityFromModal() {
        var qtyInput = document.querySelector('.quantity-input input[type="number"]');
        if (qtyInput) {
            return parseInt(qtyInput.value) || 1;
        }

        var modal = document.querySelector('.modal-container');
        if (modal) {
            var inputs = modal.querySelectorAll('input[type="number"]');
            for (var i = 0; i < inputs.length; i++) {
                var val = parseInt(inputs[i].value);
                if (val > 0) return val;
            }
        }

        return 1;
    }

    // Show notification (game style)
    function showNotification(message, type) {
        type = type || 'success';
        var existing = document.getElementById('rebelship-notification');
        if (existing) existing.remove();

        var colors = {
            success: '#4ade80',
            error: '#ef4444',
            info: '#3b82f6'
        };

        var notif = document.createElement('div');
        notif.id = 'rebelship-notification';
        notif.textContent = message;
        notif.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:' + colors[type] + ';color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);animation:slideDown 0.3s ease;';

        document.body.appendChild(notif);
        setTimeout(function() { notif.remove(); }, 2000);
    }

    // Create standalone cart button
    function createCartButton() {
        if (document.getElementById('rebelship-cart-btn')) return;

        var cart = getCartSync();
        var cartKeys = Object.keys(cart);
        var count = 0;
        for (var i = 0; i < cartKeys.length; i++) {
            count += cart[cartKeys[i]].quantity;
        }

        var btn = document.createElement('button');
        btn.id = 'rebelship-cart-btn';
        btn.innerHTML = CART_ICON + ' <span id="rebelship-cart-count">(' + count + ')</span>';
        btn.title = 'Shopping Cart - Click to open';
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            showCartModal();
        });

        var rebelshipMenu = document.getElementById('rebelship-menu');
        if (!rebelshipMenu) {
            var messagingIcon = document.querySelector('div.messaging.cursor-pointer');
            if (!messagingIcon) messagingIcon = document.querySelector('.messaging');
            if (!messagingIcon) {
                setTimeout(createCartButton, 1000);
                return;
            }
            rebelshipMenu = messagingIcon;
        }

        btn.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:4px 8px;background:transparent;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:16px;margin-right:4px !important;margin-left:4px !important;';

        if (rebelshipMenu.parentNode) {
            rebelshipMenu.parentNode.insertBefore(btn, rebelshipMenu);
        }

    }

    // Update cart badge
    function updateCartBadge() {
        var cart = getCartSync();
        var cartKeys = Object.keys(cart);
        var totalItems = 0;
        for (var i = 0; i < cartKeys.length; i++) {
            totalItems += cart[cartKeys[i]].quantity;
        }

        var cartCount = document.getElementById('rebelship-cart-count');
        if (cartCount) {
            cartCount.textContent = '(' + totalItems + ')';
        }
    }

    // Helper functions
    function escapeHtml(text) {
        if (typeof text !== 'string') text = String(text);
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatNumber(num) {
        return num.toLocaleString('en-US');
    }

    // Format port name: remove underscores, capitalize each word
    function formatPortName(name) {
        if (!name) return '';
        return name
            .replace(/_/g, ' ')
            .split(' ')
            .map(function(word) {
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join(' ');
    }

    // Check if vessel is VIP by ID or name
    function getVipInfo(vessel) {
        if (!vessel) return null;
        for (var i = 0; i < VIP_VESSELS.length; i++) {
            if (VIP_VESSELS[i].id === vessel.id || VIP_VESSELS[i].name === vessel.name) {
                return VIP_VESSELS[i];
            }
        }
        return null;
    }

    // Show shopping cart modal
    function showCartModal() {
        getCart(function(cart) {
            var cartKeys = Object.keys(cart);
            if (cartKeys.length === 0) {
                showNotification('Cart is empty');
                return;
            }

            var stores = getStores();
            var userStore = stores ? stores.user : null;
            var userCash = userStore && userStore.user ? userStore.user.cash : 0;
            var userPoints = userStore && userStore.user ? userStore.user.points : 0;

            // Pre-compute VIP info once per item
            var vipInfoMap = {};
            for (var vi = 0; vi < cartKeys.length; vi++) {
                vipInfoMap[cartKeys[vi]] = getVipInfo(cart[cartKeys[vi]].vessel);
            }

            var hasBuildItems = false;
            var hasUnpricedBuilds = false;
            var hasVipItems = false;
            var purchaseTotal = 0;
            var pointsTotal = 0;
            var totalItems = 0;

            for (var i = 0; i < cartKeys.length; i++) {
                var item = cart[cartKeys[i]];
                totalItems += item.quantity;
                var itemVipInfo = vipInfoMap[cartKeys[i]];
                if (item.vessel.type === 'build') {
                    hasBuildItems = true;
                    var buildPrice = item.vessel.buildConfig.price || 0;
                    if (!buildPrice) hasUnpricedBuilds = true;
                    purchaseTotal += buildPrice * item.quantity;
                } else if (item.vessel.type === 'vip' || itemVipInfo) {
                    hasVipItems = true;
                    pointsTotal += (item.vessel.pointsPrice || (itemVipInfo ? itemVipInfo.points : 0)) * item.quantity;
                } else if (item.vessel.price) {
                    purchaseTotal += item.vessel.price * item.quantity;
                }
            }

            var canAffordCash = userCash >= purchaseTotal;
            var canAffordPoints = userPoints >= pointsTotal;
            var canAfford = canAffordCash && canAffordPoints;

            var overlay = document.createElement('div');
            overlay.id = 'rebelship-cart-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99998;display:flex;align-items:center;justify-content:center;';

            var modal = document.createElement('div');
            modal.style.cssText = 'background:#1a1f2e;border:1px solid #374151;border-radius:12px;width:90%;max-width:500px;max-height:80vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

            var header = document.createElement('div');
            header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #374151;background:#0f1420;';
            var checkoutText = hasUnpricedBuilds ? 'Checkout (est.)' : 'Checkout';
            header.innerHTML = '<div style="display:flex;align-items:center;gap:10px;"><span style="color:#fff;font-size:18px;font-weight:600;">' + CART_ICON + ' Shopping Cart</span></div><div style="display:flex;gap:8px;"><button id="cart-close-btn" style="padding:8px 16px;background:#4b5563;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">Close</button><button id="cart-checkout-btn" style="padding:8px 16px;background:' + (canAfford ? '#4ade80' : '#6b7280') + ';color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;"' + (canAfford ? '' : ' disabled') + '>' + checkoutText + '</button></div>';

            var itemsContainer = document.createElement('div');
            itemsContainer.style.cssText = 'padding:16px 20px;max-height:400px;overflow-y:auto;';

            var drydockPorts = getDrydockPorts();

            for (var idx = 0; idx < cartKeys.length; idx++) {
                var cartItem = cart[cartKeys[idx]];
                var key = cartKeys[idx];
                var isBuild = cartItem.vessel.type === 'build';
                var cartVipInfo = vipInfoMap[key];
                var isVipItem = cartItem.vessel.type === 'vip' || cartVipInfo !== null;

                if (isBuild) {
                    var cfg = cartItem.vessel.buildConfig;

                    var getValue = function(v) {
                        if (v === null || v === undefined) return null;
                        if (typeof v === 'string' || typeof v === 'number') return v;
                        if (typeof v === 'object') {
                            return v.value || v.name || v.id || v.type || v.label || JSON.stringify(v);
                        }
                        return String(v);
                    };

                    var details = [];
                    var model = getValue(cfg.vessel_model);
                    var capacity = getValue(cfg.capacity);
                    var engine = getValue(cfg.engine_type);
                    var engineKw = getValue(cfg.engine_kw);

                    if (model) details.push(model);
                    if (capacity) details.push(formatNumber(capacity) + (model === 'tanker' ? ' BBL' : ' TEU'));
                    if (engine) details.push(engine + (engineKw ? ' ' + formatNumber(engineKw) + 'kW' : ''));

                    var perks = [];
                    if (cfg.bulbous) perks.push('Bulbous');
                    if (cfg.propeller_types) perks.push(cfg.propeller_types.replace(/_/g, ' '));
                    if (cfg.antifouling_model) perks.push('AF: ' + cfg.antifouling_model.replace(/_/g, ' '));

                    var priceText = details.length > 0 ? details.join(' | ') : 'Build config';
                    if (perks.length > 0) {
                        priceText += ' [' + perks.join(', ') + ']';
                    }

                    var unitPrice = cfg.price && cfg.price > 0 ? cfg.price : 0;
                    var totalPrice = unitPrice > 0 ? '$' + formatNumber(unitPrice * cartItem.quantity) : 'Build';

                    var headerDiv = document.createElement('div');
                    headerDiv.style.cssText = 'padding:12px;background:#252b3b;border-radius:8px 8px 0 0;margin-bottom:1px;border-left:3px solid #f59e0b;';
                    headerDiv.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;"><div style="flex:1;"><div style="color:#fff;font-weight:500;">' + escapeHtml(cartItem.vessel.name) + ' <span style="color:#f59e0b;font-size:11px;">[BUILD x' + cartItem.quantity + ']</span></div><div style="color:#9ca3af;font-size:11px;">' + escapeHtml(priceText) + '</div></div><div style="display:flex;align-items:center;gap:8px;"><button class="cart-qty-minus" data-key="' + key + '" style="width:24px;height:24px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">-</button><span style="color:#fff;min-width:20px;text-align:center;font-size:12px;">' + cartItem.quantity + '</span><button class="cart-qty-plus" data-key="' + key + '" style="width:24px;height:24px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">+</button><button class="cart-remove" data-key="' + key + '" style="width:24px;height:24px;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-left:4px;font-size:12px;" title="Remove">x</button></div><div style="min-width:70px;text-align:right;color:#4ade80;font-weight:600;font-size:13px;">' + totalPrice + '</div></div>';
                    itemsContainer.appendChild(headerDiv);

                    var ships = cartItem.ships || [];
                    for (var shipIdx = 0; shipIdx < ships.length; shipIdx++) {
                        var ship = ships[shipIdx];
                        var shipDiv = document.createElement('div');
                        shipDiv.style.cssText = 'padding:8px 12px;background:#1e2433;margin-bottom:1px;display:flex;align-items:center;gap:8px;' + (shipIdx === ships.length - 1 ? 'border-radius:0 0 8px 8px;margin-bottom:8px;' : '');

                        var portOptions = '<option value="">Select Port</option>';
                        for (var pIdx = 0; pIdx < drydockPorts.length; pIdx++) {
                            var p = drydockPorts[pIdx];
                            var selected = ship.port === p.code ? ' selected' : '';
                            var formattedCode = formatPortName(p.code);
                            var formattedCountry = formatPortName(p.country);
                            portOptions += '<option value="' + escapeHtml(p.code) + '"' + selected + '>' + escapeHtml(formattedCode) + ' (' + escapeHtml(formattedCountry) + ') [' + escapeHtml(String(p.drydock)) + ']</option>';
                        }

                        shipDiv.innerHTML = '<span style="color:#6b7280;font-size:11px;min-width:20px;">#' + (shipIdx + 1) + '</span>' +
                            '<input type="text" class="ship-name-input" data-key="' + key + '" data-idx="' + shipIdx + '" value="' + escapeHtml(ship.name) + '" style="flex:1;padding:4px 8px;background:#374151;border:1px solid #4b5563;border-radius:4px;color:#fff;font-size:12px;" placeholder="Ship name">' +
                            '<select class="ship-port-select" data-key="' + key + '" data-idx="' + shipIdx + '" style="width:180px;padding:4px;background:#374151;border:1px solid #4b5563;border-radius:4px;color:#fff;font-size:11px;max-height:200px;">' + portOptions + '</select>';

                        itemsContainer.appendChild(shipDiv);
                    }
                } else if (isVipItem) {
                    var vipUnitPrice = cartItem.vessel.pointsPrice || (cartVipInfo ? cartVipInfo.points : 0);
                    var priceTextVip = formatNumber(vipUnitPrice) + ' pts each';
                    var totalPriceVip = formatNumber(vipUnitPrice * cartItem.quantity) + ' pts';

                    var vipDiv = document.createElement('div');
                    vipDiv.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px;background:#252b3b;border-radius:8px;margin-bottom:8px;border-left:3px solid #a855f7;';
                    vipDiv.innerHTML = '<div style="flex:1;"><div style="color:#fff;font-weight:500;">' + escapeHtml(cartItem.vessel.name) + ' <span style="color:#a855f7;font-size:11px;">[VIP]</span></div><div style="color:#9ca3af;font-size:12px;"><img src="' + POINTS_ICON_URL + '" style="width:12px;height:12px;vertical-align:middle;margin-right:2px;">' + escapeHtml(priceTextVip) + '</div></div><div style="display:flex;align-items:center;gap:8px;"><button class="cart-qty-minus" data-key="' + key + '" style="width:28px;height:28px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:16px;">-</button><span style="color:#fff;min-width:24px;text-align:center;">' + cartItem.quantity + '</span><button class="cart-qty-plus" data-key="' + key + '" style="width:28px;height:28px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:16px;">+</button><button class="cart-remove" data-key="' + key + '" style="width:28px;height:28px;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-left:8px;" title="Remove">x</button></div><div style="min-width:80px;text-align:right;color:#a855f7;font-weight:600;"><img src="' + POINTS_ICON_URL + '" style="width:14px;height:14px;vertical-align:middle;margin-right:2px;">' + totalPriceVip + '</div>';
                    itemsContainer.appendChild(vipDiv);
                } else {
                    var priceTextPurchase = '$' + formatNumber(cartItem.vessel.price) + ' each';
                    var totalPricePurchase = '$' + formatNumber(cartItem.vessel.price * cartItem.quantity);

                    var itemDiv = document.createElement('div');
                    itemDiv.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px;background:#252b3b;border-radius:8px;margin-bottom:8px;';
                    itemDiv.innerHTML = '<div style="flex:1;"><div style="color:#fff;font-weight:500;">' + escapeHtml(cartItem.vessel.name) + '</div><div style="color:#9ca3af;font-size:12px;">' + escapeHtml(priceTextPurchase) + '</div></div><div style="display:flex;align-items:center;gap:8px;"><button class="cart-qty-minus" data-key="' + key + '" style="width:28px;height:28px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:16px;">-</button><span style="color:#fff;min-width:24px;text-align:center;">' + cartItem.quantity + '</span><button class="cart-qty-plus" data-key="' + key + '" style="width:28px;height:28px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:16px;">+</button><button class="cart-remove" data-key="' + key + '" style="width:28px;height:28px;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-left:8px;" title="Remove">x</button></div><div style="min-width:80px;text-align:right;color:#4ade80;font-weight:600;">' + totalPricePurchase + '</div>';
                    itemsContainer.appendChild(itemDiv);
                }
            }

            var footer = document.createElement('div');
            footer.style.cssText = 'padding:16px 20px;border-top:1px solid #374151;background:#0f1420;';
            var costDisplay = '$' + formatNumber(purchaseTotal) + (hasUnpricedBuilds ? ' (est.)' : '');

            var buildCount = 0;
            var vipCount = 0;
            for (var bi = 0; bi < cartKeys.length; bi++) {
                var bKey = cartKeys[bi];
                if (cart[bKey].vessel.type === 'build') buildCount += cart[bKey].quantity;
                if (cart[bKey].vessel.type === 'vip' || vipInfoMap[bKey]) vipCount += cart[bKey].quantity;
            }

            var itemsDetail = '';
            if (hasBuildItems && hasVipItems) {
                itemsDetail = ' (incl. ' + buildCount + ' builds, ' + vipCount + ' VIP)';
            } else if (hasBuildItems) {
                itemsDetail = ' (incl. ' + buildCount + ' builds)';
            } else if (hasVipItems) {
                itemsDetail = ' (incl. ' + vipCount + ' VIP)';
            }

            var footerHtml = '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#9ca3af;">Total Items:</span><span style="color:#fff;font-weight:500;">' + totalItems + ' vessels' + itemsDetail + '</span></div>';

            var anchorInfo = getAnchorPointsInfo();
            if (anchorInfo) {
                var freeAfterPurchase = anchorInfo.free - (totalItems - vipCount);
                var hasEnoughAnchors = freeAfterPurchase >= 0;
                footerHtml += '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#9ca3af;">Anchor Points:</span><span style="color:#fff;font-weight:500;">' + anchorInfo.free + ' free / ' + anchorInfo.total + ' total</span></div>';
                footerHtml += '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#9ca3af;">After Purchase:</span><span style="color:' + (hasEnoughAnchors ? '#4ade80' : '#ef4444') + ';font-weight:500;">' + freeAfterPurchase + ' free' + (hasEnoughAnchors ? '' : ' (not enough!)') + '</span></div>';
            }

            footerHtml += '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#9ca3af;">Cash Available:</span><span style="color:#4ade80;font-weight:500;">$' + formatNumber(userCash) + '</span></div>';
            if (hasVipItems) {
                footerHtml += '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#fff;font-weight:600;">Cash Cost:</span><span style="color:' + (canAffordCash ? '#4ade80' : '#ef4444') + ';font-weight:700;font-size:18px;">' + costDisplay + '</span></div>';
                footerHtml += '<div style="display:flex;justify-content:space-between;margin-bottom:8px;padding-top:8px;border-top:1px solid #374151;"><span style="color:#9ca3af;">Points Available:</span><span style="color:#a855f7;font-weight:500;">' + formatNumber(userPoints) + ' pts</span></div>';
                footerHtml += '<div style="display:flex;justify-content:space-between;"><span style="color:#fff;font-weight:600;">Points Cost:</span><span style="color:' + (canAffordPoints ? '#a855f7' : '#ef4444') + ';font-weight:700;font-size:18px;">' + formatNumber(pointsTotal) + ' pts</span></div>';
            } else {
                footerHtml += '<div style="display:flex;justify-content:space-between;"><span style="color:#fff;font-weight:600;">Total Cost:</span><span style="color:' + (canAfford ? '#4ade80' : '#ef4444') + ';font-weight:700;font-size:18px;">' + costDisplay + '</span></div>';
            }

            footer.innerHTML = footerHtml;

            modal.appendChild(header);
            modal.appendChild(itemsContainer);
            modal.appendChild(footer);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            var dropdown = document.getElementById('rebelship-dropdown');
            if (dropdown) dropdown.style.display = 'none';

            // Event delegation: single click handler instead of N per-element listeners
            overlay.addEventListener('click', function(e) {
                var target = e.target;
                if (target === overlay) {
                    overlay.remove();
                    return;
                }
                if (target.id === 'cart-close-btn') {
                    overlay.remove();
                    return;
                }
                if (target.id === 'cart-checkout-btn' && canAfford) {
                    overlay.remove();
                    processCheckout();
                    return;
                }
                if (target.classList.contains('cart-qty-minus')) {
                    var k1 = target.dataset.key;
                    var currentCart1 = getCartSync();
                    var found1 = currentCart1[k1];
                    if (found1) {
                        updateQuantity(k1, found1.quantity - 1);
                        overlay.remove();
                        showCartModal();
                    }
                    return;
                }
                if (target.classList.contains('cart-qty-plus')) {
                    var k2 = target.dataset.key;
                    var currentCart2 = getCartSync();
                    var found2 = currentCart2[k2];
                    if (found2) {
                        updateQuantity(k2, found2.quantity + 1);
                        overlay.remove();
                        showCartModal();
                    }
                    return;
                }
                if (target.classList.contains('cart-remove')) {
                    var k3 = target.dataset.key;
                    removeFromCart(k3);
                    var newCart = getCartSync();
                    if (Object.keys(newCart).length === 0) {
                        overlay.remove();
                        showNotification('Cart is empty');
                    } else {
                        overlay.remove();
                        showCartModal();
                    }
                    return;
                }
            });

            // Event delegation: single change handler for ship name/port inputs
            overlay.addEventListener('change', function(e) {
                var target = e.target;
                if (target.classList.contains('ship-name-input')) {
                    updateShipConfig(target.dataset.key, parseInt(target.dataset.idx), 'name', target.value);
                    return;
                }
                if (target.classList.contains('ship-port-select')) {
                    updateShipConfig(target.dataset.key, parseInt(target.dataset.idx), 'port', target.value);
                    return;
                }
            });
        });
    }

    // Purchase VIP vessel: load vessel data first, then call vessel/purchase-vessel
    // Based on game source (fleet_b.js:7040-7077): purchaseVipVessel calls
    // POST vessel/purchase-vessel with { vessel_id: modalStore.props.vip_vessel.id }
    function purchaseVipVessel(vessel) {
        var stores = getStores();
        if (!stores) {
            return Promise.reject(new Error('Stores not available'));
        }

        // Check cached vessels before API call
        var cachedVessel = null;
        if (Array.isArray(window._rebelshipAllVessels)) {
            for (var ci = 0; ci < window._rebelshipAllVessels.length; ci++) {
                if (window._rebelshipAllVessels[ci].id === vessel.id) {
                    cachedVessel = window._rebelshipAllVessels[ci];
                    break;
                }
            }
        }

        var vesselDataPromise;
        if (cachedVessel) {
            vesselDataPromise = Promise.resolve(cachedVessel);
        } else {
            vesselDataPromise = fetch('/api/vessel/show-acquirable-vessel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ vessel_id: vessel.id })
            })
            .then(function(response) { return response.json(); })
            .then(function(showData) {
                return showData && showData.data ? showData.data.vessels_for_sale : vessel;
            });
        }

        return vesselDataPromise.then(function(vesselData) {
            // Set up stores as the game does (fleet_b.js:7030-7034)
            if (stores.modal) {
                stores.modal.props = stores.modal.props || {};
                stores.modal.props.vip_vessel = vesselData;
            }
            if (stores.shop) {
                stores.shop.vip_vessel = vesselData;
                stores.shop.selectedVessel = vesselData;
            }
            if (stores.vessel) {
                stores.vessel.acquiringVessel = vesselData;
            }

            console.log('[VesselCart] Purchasing VIP vessel via /api/vessel/purchase-vessel, id:', vessel.id);
            return fetch('/api/vessel/purchase-vessel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ vessel_id: vessel.id })
            });
        })
        .then(function(response) { return response.json(); });
    }

    // Process checkout - purchase all vessels
    function processCheckout() {
        getCart(function(cart) {
            var checkoutKeys = Object.keys(cart);
            if (checkoutKeys.length === 0) return;

            var progressOverlay = document.createElement('div');
            progressOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;';
            progressOverlay.innerHTML = '<div id="checkout-progress" style="color:#fff;font-size:18px;margin-bottom:20px;">Processing...</div><div id="checkout-status" style="color:#9ca3af;font-size:14px;"></div>';
            document.body.appendChild(progressOverlay);

            var progressEl = progressOverlay.querySelector('#checkout-progress');
            var statusEl = progressOverlay.querySelector('#checkout-status');

            var successCount = 0;
            var failCount = 0;
            var errors = [];
            var totalPurchases = 0;
            for (var ti = 0; ti < checkoutKeys.length; ti++) {
                totalPurchases += cart[checkoutKeys[ti]].quantity;
            }

            var itemIndex = 0;
            var subIndex = 0;
            var currentPurchase = 0;

            function processNext() {
                if (itemIndex >= checkoutKeys.length) {
                    // Done
                    clearCart();

                    progressEl.textContent = 'Checkout Complete!';
                    if (errors.length > 0) {
                        statusEl.innerHTML = '<span style="color:#4ade80;">' + successCount + ' purchased</span>, <span style="color:#ef4444;">' + failCount + ' failed</span><br><br><div style="text-align:left;max-height:150px;overflow-y:auto;font-size:12px;color:#ef4444;">' + errors.join('<br>') + '</div>';
                    } else {
                        statusEl.innerHTML = '<span style="color:#4ade80;">' + successCount + ' purchased</span>';
                    }

                    setTimeout(function() {
                        progressOverlay.remove();
                        var stores = getStores();
                        var userStore = stores ? stores.user : null;
                        if (userStore && userStore.fetchUser) {
                            userStore.fetchUser().catch(function(e) {
                                console.error('[VesselCart] Failed to refresh user:', e);
                            });
                        }
                    }, errors.length > 0 ? 4000 : 2000);
                    return;
                }

                var item = cart[checkoutKeys[itemIndex]];
                if (subIndex >= item.quantity) {
                    itemIndex++;
                    subIndex = 0;
                    processNext();
                    return;
                }

                currentPurchase++;

                var shipConfig = item.ships && item.ships[subIndex] ? item.ships[subIndex] : null;
                var vesselName = shipConfig ? shipConfig.name : (item.vessel.name + (item.quantity > 1 ? '_' + (subIndex + 1) : ''));

                progressEl.textContent = 'Processing ' + currentPurchase + '/' + totalPurchases;
                statusEl.textContent = vesselName + ' (' + (subIndex + 1) + '/' + item.quantity + ')';

                var purchasePromise;

                if (item.vessel.type === 'build' && item.vessel.buildConfig) {
                    var buildConfig = Object.assign({}, item.vessel.buildConfig);

                    if (shipConfig) {
                        buildConfig.name = shipConfig.name;
                        if (shipConfig.port) {
                            buildConfig.ship_yard = shipConfig.port;
                        }
                    } else if (item.quantity > 1) {
                        buildConfig.name = buildConfig.name + '_' + (subIndex + 1);
                    }

                    console.log('[VesselCart] Building vessel:', buildConfig);
                    purchasePromise = fetch('/api/vessel/build-vessel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify(buildConfig)
                    }).then(function(response) { return response.json(); });
                } else if (item.vessel.type === 'vip' || getVipInfo(item.vessel)) {
                    console.log('[VesselCart] Purchasing VIP vessel:', item.vessel.id, item.vessel.name);
                    purchasePromise = purchaseVipVessel(item.vessel);
                } else {
                    console.log('[VesselCart] Purchasing vessel ID:', item.vessel.id);
                    purchasePromise = fetch('/api/vessel/purchase-vessel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ vessel_id: item.vessel.id })
                    }).then(function(response) { return response.json(); });
                }

                purchasePromise.then(function(data) {
                    if (data.error) {
                        failCount++;
                        var errorMsg = typeof data.error === 'string' ? data.error.replace(/_/g, ' ') : (data.error.message || JSON.stringify(data.error));
                        errors.push(escapeHtml(vesselName) + ': ' + escapeHtml(errorMsg));
                        statusEl.innerHTML = '<span style="color:#ef4444;">' + escapeHtml(errorMsg) + '</span>';
                        console.error('[VesselCart] Failed:', data);
                    } else if (data.success || data.data) {
                        successCount++;
                    } else {
                        failCount++;
                        errors.push(escapeHtml(vesselName) + ': unknown error');
                        console.error('[VesselCart] Failed:', data);
                    }
                }).catch(function(e) {
                    failCount++;
                    errors.push(escapeHtml(vesselName) + ': ' + escapeHtml(e.message));
                    console.error('[VesselCart] Error:', e);
                }).finally(function() {
                    subIndex++;
                    setTimeout(processNext, failCount > 0 ? 2000 : 500);
                });
            }

            processNext();
        });
    }

    // Watch for order button and inject add-to-cart button
    function watchForOrderButton() {
        watchObserver = new MutationObserver(function() {
            if (watchDebounceTimer) return;
            watchDebounceTimer = setTimeout(function() {
                watchDebounceTimer = null;

                var bottomControls = document.getElementById('bottom-controls');
                var existingCartBtn = document.getElementById('add-to-cart-btn');

                if (!bottomControls) {
                    if (existingCartBtn) existingCartBtn.remove();
                    return;
                }

                var orderBtn = bottomControls.querySelector('#order-btn');

                if (!orderBtn) {
                    if (existingCartBtn) existingCartBtn.remove();
                    return;
                }

                if (existingCartBtn && bottomControls.contains(existingCartBtn)) return;

                if (existingCartBtn) existingCartBtn.remove();

                var backBtn = bottomControls.querySelector('.light-blue');
                if (backBtn) backBtn.style.width = '25%';
                orderBtn.style.width = '40%';

                var cartBtn = document.createElement('div');
                cartBtn.id = 'add-to-cart-btn';
                cartBtn.className = 'control-btn flex-centered';
                cartBtn.style.cssText = 'width:35%;background:#f59e0b;cursor:pointer;';
                cartBtn.innerHTML = '<span>Add to ' + CART_ICON + '</span>';

                cartBtn.addEventListener('click', function() {
                    var currentVessel = getCurrentVessel();
                    if (currentVessel) {
                        var qty = getQuantityFromModal();
                        addToCart(currentVessel, qty);
                    } else {
                        showNotification('Could not get vessel data', 'error');
                    }
                });

                orderBtn.parentNode.insertBefore(cartBtn, orderBtn);
            }, 250);
        });

        var target = document.getElementById('modal-container') || document.getElementById('app') || document.body;
        watchObserver.observe(target, { childList: true, subtree: true });
    }

    // Initialize
    function init() {
        // Load cart into cache then create UI
        getCart(function() {
            createCartButton();
            updateCartBadge();
            watchForOrderButton();
        });

        // Invalidate drydock ports cache on navigation
        window.addEventListener('hashchange', function() {
            drydockPortsCache = null;
        });

        // Cleanup on page unload
        window.addEventListener('beforeunload', function() {
            if (watchObserver) { watchObserver.disconnect(); watchObserver = null; }
            if (watchDebounceTimer) { clearTimeout(watchDebounceTimer); watchDebounceTimer = null; }
        });
    }

    // Add CSS animation
    var style = document.createElement('style');
    style.textContent = '@keyframes slideDown { from { opacity: 0; transform: translate(-50%, -20px); } to { opacity: 1; transform: translate(-50%, 0); } }';
    document.head.appendChild(style);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
