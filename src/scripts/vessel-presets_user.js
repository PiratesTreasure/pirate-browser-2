// ==UserScript==
// @name        ShippingManager - Vessel Presets
// @description Create and manage vessel build preset templates, add them to cart
// @version     1.0.0
// @author      https://github.com/PiratesTreasure
// @order        26
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// @RequirePiratesTreasureMenu true
// @RequirePiratesTreasureStorage true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    var SCRIPT_NAME = 'VesselPresets';
    var STORE_NAME = 'data';
    var PRESETS_KEY = 'presets';

    var CART_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg>';
    var SHIP_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 21c-1.39 0-2.78-.47-4-1.32-2.44 1.71-5.56 1.71-8 0C6.78 20.53 5.39 21 4 21H2v2h2c1.38 0 2.74-.35 4-.99 2.52 1.29 5.48 1.29 8 0 1.26.65 2.62.99 4 .99h2v-2h-2zM3.95 19H4c1.6 0 3.02-.88 4-2 .98 1.12 2.4 2 4 2s3.02-.88 4-2c.98 1.12 2.4 2 4 2h.05l1.89-6.68c.08-.26.06-.54-.06-.78s-.34-.42-.6-.5L20 10.62V6c0-1.1-.9-2-2-2h-3V1H9v3H6c-1.1 0-2 .9-2 2v4.62l-1.29.42c-.26.08-.48.26-.6.5s-.14.52-.05.78L3.95 19zM6 6h12v3.97L12 8 6 9.97V6z"/></svg>';

    // ── Default presets (always present) ────────────────────────

    var BASE_BUILD = {
        engine_type: 'mih_cp9',
        engine_kw: 60000,
        bulbous: 1,
        enhanced_thrusters: 0,
        propeller_types: '6_blades',
        antifouling_model: null,
        range: null,
        ship_yard: '',
        price: 0
    };

    function makeDefault(id, name, vesselName, model, capacity, price) {
        var cfg = {};
        for (var k in BASE_BUILD) cfg[k] = BASE_BUILD[k];
        cfg.name = vesselName;
        cfg.vessel_model = model;
        cfg.capacity = capacity;
        cfg.price = price || 0;
        return {
            id: id,
            name: name,
            builtIn: true,
            createdAt: 0,
            updatedAt: 0,
            buildConfig: cfg
        };
    }

    var DEFAULT_PRESETS = {
        // Containers
        'default_c2k':    makeDefault('default_c2k',    'C2k',     'C2k',     'container', 2000,    70592400),
        'default_c5k':    makeDefault('default_c5k',    'C5k',     'C5k',     'container', 5000,    102077841),
        'default_c10k':   makeDefault('default_c10k',   'C10k',    'C10k',    'container', 10000,   153031694),
        'default_c15k':   makeDefault('default_c15k',   'C15k',    'C15k',    'container', 15000,   205510865),
        'default_c20k':   makeDefault('default_c20k',   'C20k',    'C20k',    'container', 20000,   256464718),
        'default_c27k':   makeDefault('default_c27k',   'C27k',    'C27k',    'container', 27000,   328247401),
        // Tankers
        'default_t148k':  makeDefault('default_t148k',  'T148k',   'T148k',   'tanker', 148000,    70592400),
        'default_t500k':  makeDefault('default_t500k',  'T500k',   'T500k',   'tanker', 500000,    119577769),
        'default_t750k':  makeDefault('default_t750k',  'T750k',   'T750k',   'tanker', 750000,    154557012),
        'default_t1m':    makeDefault('default_t1m',    'T1m',     'T1m',     'tanker', 1000000,   189536255),
        'default_t1.5m':  makeDefault('default_t1.5m',  'T1.5m',   'T1.5m',   'tanker', 1500000,  258742388),
        'default_t2m':    makeDefault('default_t2m',    'T2m',     'T2m',     'tanker', 1998000,   328247401)
    };

    // ── Storage helpers ──────────────────────────────────────────

    var cachedPresets = null;

    function dbGet(key) {
        return window.PiratesTreasureBridge.storage.get(SCRIPT_NAME, STORE_NAME, key).then(function(result) {
            if (result) return JSON.parse(result);
            return null;
        }).catch(function(e) {
            console.error('[VesselPresets] dbGet error:', e);
            return null;
        });
    }

    function dbSet(key, value) {
        return window.PiratesTreasureBridge.storage.set(SCRIPT_NAME, STORE_NAME, key, JSON.stringify(value)).then(function() {
            return true;
        }).catch(function(e) {
            console.error('[VesselPresets] dbSet error:', e);
            return false;
        });
    }

    function mergeWithDefaults(userPresets) {
        var merged = {};
        var dk = Object.keys(DEFAULT_PRESETS);
        for (var i = 0; i < dk.length; i++) {
            merged[dk[i]] = DEFAULT_PRESETS[dk[i]];
        }
        if (userPresets) {
            var uk = Object.keys(userPresets);
            for (var j = 0; j < uk.length; j++) {
                merged[uk[j]] = userPresets[uk[j]];
            }
        }
        return merged;
    }

    function getPresets(callback) {
        if (cachedPresets !== null) {
            callback(cachedPresets);
            return;
        }
        dbGet(PRESETS_KEY).then(function(data) {
            var userPresets = (data && typeof data === 'object') ? data : {};
            cachedPresets = mergeWithDefaults(userPresets);
            callback(cachedPresets);
        }).catch(function() {
            cachedPresets = mergeWithDefaults({});
            callback(cachedPresets);
        });
    }

    function getPresetsSync() {
        return cachedPresets !== null ? cachedPresets : mergeWithDefaults({});
    }

    function savePresets(presets) {
        cachedPresets = presets;
        // Only persist user-created presets, not built-in defaults
        var userOnly = {};
        var keys = Object.keys(presets);
        for (var i = 0; i < keys.length; i++) {
            if (!presets[keys[i]].builtIn) {
                userOnly[keys[i]] = presets[keys[i]];
            }
        }
        dbSet(PRESETS_KEY, userOnly);
    }

    function createPreset(data) {
        var presets = getPresetsSync();
        var id = 'preset_' + Date.now();
        presets[id] = {
            id: id,
            name: data.name,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            buildConfig: data.buildConfig
        };
        savePresets(presets);
        return id;
    }

    function updatePreset(id, data) {
        var presets = getPresetsSync();
        if (!presets[id]) return;
        presets[id].name = data.name;
        presets[id].buildConfig = data.buildConfig;
        presets[id].updatedAt = Date.now();
        savePresets(presets);
    }

    function deletePreset(id) {
        var presets = getPresetsSync();
        delete presets[id];
        savePresets(presets);
    }

    // ── Helpers ──────────────────────────────────────────────────

    function escapeHtml(text) {
        if (typeof text !== 'string') text = String(text);
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatNumber(num) {
        if (num == null || isNaN(num)) return '0';
        return Number(num).toLocaleString('en-US');
    }

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

    function showNotification(message, type) {
        if (window.PiratesTreasureNotify) {
            window.PiratesTreasureNotify.show('Vessel Presets', message);
        }
    }

    // ── Drydock ports ────────────────────────────────────────────

    function getDrydockPorts() {
        if (typeof window._piratestreasureGetDrydockPorts === 'function') {
            var ports = window._piratestreasureGetDrydockPorts();
            if (ports && ports.length > 0) return ports;
        }
        // Fallback: read from route store
        if (window.PirateUtils && window.PirateUtils.getStore) {
            var routeStore = window.PirateUtils.getStore('route');
            if (routeStore) {
                if (routeStore.drydockPorts && routeStore.drydockPorts.length > 0) {
                    return routeStore.drydockPorts;
                }
                if (routeStore.ports) {
                    return routeStore.ports
                        .filter(function(p) { return p.drydock !== null; })
                        .sort(function(a, b) { return a.code.localeCompare(b.code); });
                }
            }
        }
        return [];
    }

    // ── Cart integration ─────────────────────────────────────────

    function addPresetToCart(presetId, quantity, portOverride) {
        var presets = getPresetsSync();
        var preset = presets[presetId];
        if (!preset) return;

        var buildConfig = JSON.parse(JSON.stringify(preset.buildConfig));
        if (portOverride) {
            buildConfig.ship_yard = portOverride;
        }

        var vessel = {
            type: 'build',
            name: buildConfig.name || preset.name,
            buildConfig: buildConfig,
            price: buildConfig.price || 0
        };

        if (typeof window._piratestreasureAddToCart === 'function') {
            window._piratestreasureAddToCart(vessel, quantity);
        } else {
            addPresetToCartDirect({ name: preset.name, buildConfig: buildConfig }, quantity);
        }
    }

    function addPresetToCartDirect(preset, quantity) {
        var cartRaw = localStorage.getItem('pirate:VesselCart:data:cart');
        var cart;
        try {
            cart = cartRaw ? JSON.parse(cartRaw) : {};
        } catch (e) {
            cart = {};
        }

        var cfg = preset.buildConfig;
        var key = 'build_' + cfg.ship_yard + '_' + cfg.vessel_model + '_' + cfg.engine_type + '_' + cfg.capacity;
        var baseName = cfg.name || preset.name;

        if (cart[key]) {
            var oldQty = cart[key].quantity;
            cart[key].quantity += quantity;
            if (cart[key].ships) {
                for (var j = 0; j < quantity; j++) {
                    cart[key].ships.push({
                        name: baseName + '_' + (oldQty + j + 1),
                        port: cfg.ship_yard || ''
                    });
                }
            }
        } else {
            var ships = [];
            for (var k = 0; k < quantity; k++) {
                ships.push({
                    name: quantity > 1 ? baseName + '_' + (k + 1) : baseName,
                    port: cfg.ship_yard || ''
                });
            }
            cart[key] = {
                vessel: {
                    type: 'build',
                    name: baseName,
                    buildConfig: JSON.parse(JSON.stringify(cfg)),
                    price: cfg.price || 0
                },
                quantity: quantity,
                key: key,
                ships: ships
            };
        }

        localStorage.setItem('pirate:VesselCart:data:cart', JSON.stringify(cart));

        // Update cart badge
        var cartCount = document.getElementById('piratestreasure-cart-count');
        if (cartCount) {
            var total = 0;
            var keys = Object.keys(cart);
            for (var i = 0; i < keys.length; i++) {
                total += cart[keys[i]].quantity;
            }
            cartCount.textContent = '(' + total + ')';
        }

        showNotification('Added ' + quantity + 'x ' + baseName + ' to cart');
    }

    // ── Quantity tracking per preset in the modal ────────────────

    var presetQuantities = {};

    // ── Main preset list modal ───────────────────────────────────

    function openPresetsModal() {
        getPresets(function(presets) {
            renderPresetsModal(presets);
        });
    }

    function renderPresetsModal(presets) {
        // Remove any existing modal
        var existing = document.getElementById('vessel-presets-overlay');
        if (existing) existing.remove();

        var presetKeys = Object.keys(presets);

        var overlay = document.createElement('div');
        overlay.id = 'vessel-presets-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99998;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1f2e;border:1px solid #374151;border-radius:12px;width:90%;max-width:600px;max-height:80vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;';

        // Header
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #374151;background:#0f1420;flex-shrink:0;';
        header.innerHTML = '<div style="display:flex;align-items:center;gap:10px;"><span style="color:#fff;font-size:18px;font-weight:600;">' + SHIP_ICON + ' Vessel Presets</span><span style="color:#6b7280;font-size:13px;">(' + presetKeys.length + ')</span></div>' +
            '<div style="display:flex;gap:8px;">' +
            '<button id="vp-capture-btn" style="padding:8px 12px;background:#8b5cf6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;font-size:12px;" title="Save the current build page config as a preset">Capture Build</button>' +
            '<button id="vp-new-btn" style="padding:8px 12px;background:#4ade80;color:#111;border:none;border-radius:6px;cursor:pointer;font-weight:500;font-size:12px;">+ New Preset</button>' +
            '<button id="vp-close-btn" style="padding:8px 16px;background:#4b5563;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">Close</button>' +
            '</div>';

        // Items container
        var itemsContainer = document.createElement('div');
        itemsContainer.style.cssText = 'padding:16px 20px;overflow-y:auto;flex:1;';

        if (presetKeys.length === 0) {
            itemsContainer.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#6b7280;">' +
                '<div style="font-size:40px;margin-bottom:12px;">&#9875;</div>' +
                '<div style="font-size:16px;margin-bottom:8px;">No presets yet</div>' +
                '<div style="font-size:13px;">Click "+ New Preset" to create your first vessel template,<br>or use "Capture Build" while on the build page.</div>' +
                '</div>';
        } else {
            // Sort: user presets first (by updatedAt desc), then built-in (by capacity asc)
            presetKeys.sort(function(a, b) {
                var pa = presets[a], pb = presets[b];
                var aBuiltIn = pa.builtIn ? 1 : 0;
                var bBuiltIn = pb.builtIn ? 1 : 0;
                if (aBuiltIn !== bBuiltIn) return aBuiltIn - bBuiltIn;
                if (aBuiltIn) {
                    // Built-in: containers first, then tankers, by capacity
                    var aModel = pa.buildConfig.vessel_model === 'container' ? 0 : 1;
                    var bModel = pb.buildConfig.vessel_model === 'container' ? 0 : 1;
                    if (aModel !== bModel) return aModel - bModel;
                    return (pa.buildConfig.capacity || 0) - (pb.buildConfig.capacity || 0);
                }
                return (pb.updatedAt || 0) - (pa.updatedAt || 0);
            });

            var drydockPorts = getDrydockPorts();

            for (var idx = 0; idx < presetKeys.length; idx++) {
                var preset = presets[presetKeys[idx]];
                var pid = preset.id;
                var cfg = preset.buildConfig;

                // Initialize quantity if not set
                if (!presetQuantities[pid]) presetQuantities[pid] = 1;

                // Build summary
                var details = [];
                if (cfg.vessel_model) details.push(cfg.vessel_model);
                if (cfg.capacity) details.push(formatNumber(cfg.capacity) + (cfg.vessel_model === 'tanker' ? ' BBL' : ' TEU'));
                if (cfg.engine_type) details.push(cfg.engine_type + (cfg.engine_kw ? ' ' + formatNumber(cfg.engine_kw) + 'kW' : ''));

                var perks = [];
                if (cfg.bulbous) perks.push('Bulbous');
                if (cfg.enhanced_thrusters) perks.push('Thrusters');
                if (cfg.propeller_types) perks.push(cfg.propeller_types.replace(/_/g, ' '));
                if (cfg.antifouling_model) perks.push('AF: ' + cfg.antifouling_model.replace(/_/g, ' '));

                var priceText = cfg.price ? '$' + formatNumber(cfg.price) : '';

                // Build port options HTML
                var portOptionsHtml = '<option value="">-- Select Ship Yard --</option>';
                for (var pIdx = 0; pIdx < drydockPorts.length; pIdx++) {
                    var port = drydockPorts[pIdx];
                    var portSelected = cfg.ship_yard === port.code ? ' selected' : '';
                    portOptionsHtml += '<option value="' + escapeHtml(port.code) + '"' + portSelected + '>' + escapeHtml(formatPortName(port.code)) + ' (' + escapeHtml(formatPortName(port.country)) + ') [' + escapeHtml(String(port.drydock)) + ']</option>';
                }

                var isBuiltIn = !!preset.builtIn;
                var card = document.createElement('div');
                card.style.cssText = 'padding:12px;background:#252b3b;border-radius:8px;margin-bottom:8px;border-left:3px solid ' + (isBuiltIn ? '#f59e0b' : '#3b82f6') + ';';

                var actionButtons = '';
                if (isBuiltIn) {
                    actionButtons = '<span style="padding:3px 6px;background:#f59e0b22;color:#f59e0b;border-radius:3px;font-size:10px;font-weight:600;">DEFAULT</span>';
                } else {
                    actionButtons = '<button class="vp-edit-btn" data-id="' + pid + '" style="padding:4px 8px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Edit</button>' +
                        '<button class="vp-delete-btn" data-id="' + pid + '" style="padding:4px 8px;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Del</button>';
                }

                card.innerHTML =
                    // Top row: name + actions
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
                        '<div style="color:#fff;font-weight:600;font-size:14px;">' + escapeHtml(preset.name) + '</div>' +
                        '<div style="display:flex;gap:4px;align-items:center;">' + actionButtons + '</div>' +
                    '</div>' +
                    // Details
                    (details.length > 0 ? '<div style="color:#9ca3af;font-size:12px;margin-bottom:2px;">' + escapeHtml(details.join(' | ')) + '</div>' : '') +
                    (perks.length > 0 ? '<div style="color:#6b7280;font-size:11px;margin-bottom:2px;">' + escapeHtml(perks.join(', ')) + '</div>' : '') +
                    (priceText ? '<div style="color:#4ade80;font-size:12px;margin-bottom:4px;">' + escapeHtml(priceText) + '</div>' : '') +
                    // Port selector
                    '<div style="margin-bottom:8px;">' +
                        '<select class="vp-port-select" data-id="' + pid + '" style="width:100%;padding:5px 8px;background:#374151;border:1px solid #4b5563;border-radius:4px;color:#fff;font-size:12px;">' +
                            portOptionsHtml +
                        '</select>' +
                    '</div>' +
                    // Quantity + Add to cart
                    '<div style="display:flex;align-items:center;gap:8px;">' +
                        '<button class="vp-qty-minus" data-id="' + pid + '" style="width:26px;height:26px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">-</button>' +
                        '<span class="vp-qty-display" data-id="' + pid + '" style="color:#fff;min-width:24px;text-align:center;font-size:13px;">' + presetQuantities[pid] + '</span>' +
                        '<button class="vp-qty-plus" data-id="' + pid + '" style="width:26px;height:26px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">+</button>' +
                        '<button class="vp-add-cart" data-id="' + pid + '" style="flex:1;padding:6px 12px;background:#f59e0b;color:#111;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;display:flex;align-items:center;justify-content:center;gap:4px;">' + CART_ICON + ' Add to Cart</button>' +
                    '</div>';

                itemsContainer.appendChild(card);
            }
        }

        modal.appendChild(header);
        modal.appendChild(itemsContainer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Event delegation
        overlay.addEventListener('click', function(e) {
            var target = e.target;

            if (target === overlay) {
                overlay.remove();
                return;
            }
            if (target.id === 'vp-close-btn') {
                overlay.remove();
                return;
            }
            if (target.id === 'vp-new-btn') {
                openPresetForm(null);
                return;
            }
            if (target.id === 'vp-capture-btn') {
                captureCurrentBuild();
                return;
            }
            if (target.classList.contains('vp-edit-btn')) {
                openPresetForm(target.dataset.id);
                return;
            }
            if (target.classList.contains('vp-delete-btn')) {
                var delId = target.dataset.id;
                var delPreset = getPresetsSync()[delId];
                if (delPreset && confirm('Delete preset "' + delPreset.name + '"?')) {
                    deletePreset(delId);
                    overlay.remove();
                    openPresetsModal();
                }
                return;
            }
            if (target.classList.contains('vp-qty-minus')) {
                var qid1 = target.dataset.id;
                if (presetQuantities[qid1] > 1) {
                    presetQuantities[qid1]--;
                    var display1 = overlay.querySelector('.vp-qty-display[data-id="' + qid1 + '"]');
                    if (display1) display1.textContent = presetQuantities[qid1];
                }
                return;
            }
            if (target.classList.contains('vp-qty-plus')) {
                var qid2 = target.dataset.id;
                presetQuantities[qid2] = (presetQuantities[qid2] || 1) + 1;
                var display2 = overlay.querySelector('.vp-qty-display[data-id="' + qid2 + '"]');
                if (display2) display2.textContent = presetQuantities[qid2];
                return;
            }
            if (target.classList.contains('vp-add-cart') || target.closest('.vp-add-cart')) {
                var btn = target.classList.contains('vp-add-cart') ? target : target.closest('.vp-add-cart');
                var addId = btn.dataset.id;
                var qty = presetQuantities[addId] || 1;
                // Read port from the dropdown for this preset
                var portSelect = overlay.querySelector('.vp-port-select[data-id="' + addId + '"]');
                var portOverride = portSelect ? portSelect.value : '';
                if (!portOverride) {
                    showNotification('Please select a ship yard first');
                    if (portSelect) portSelect.style.borderColor = '#ef4444';
                    return;
                }
                addPresetToCart(addId, qty, portOverride);
                return;
            }
        });
    }

    // ── Capture Current Build ────────────────────────────────────

    function captureCurrentBuild() {
        if (typeof window._piratestreasureGetBuildConfig !== 'function') {
            showNotification('Build capture not available. Is the Vessel Cart script enabled?');
            return;
        }
        var config = window._piratestreasureGetBuildConfig();
        if (!config) {
            showNotification('No build configuration found. Navigate to the build vessel page first.');
            return;
        }
        openPresetForm(null, config);
    }

    // ── Create/Edit preset form modal ────────────────────────────

    function openPresetForm(presetId, prefillConfig) {
        // Remove existing form if any
        var existing = document.getElementById('vessel-presets-form-overlay');
        if (existing) existing.remove();

        var isEdit = presetId !== null && presetId !== undefined;
        var preset = isEdit ? getPresetsSync()[presetId] : null;

        // Default values
        var values = {
            presetName: '',
            vesselName: '',
            vessel_model: 'container',
            ship_yard: '',
            engine_type: '',
            engine_kw: '',
            capacity: '',
            range: '',
            antifouling_model: '',
            propeller_types: '',
            bulbous: 0,
            enhanced_thrusters: 0,
            price: ''
        };

        if (isEdit && preset) {
            values.presetName = preset.name || '';
            var cfg = preset.buildConfig;
            values.vesselName = cfg.name || '';
            values.vessel_model = cfg.vessel_model || 'container';
            values.ship_yard = cfg.ship_yard || '';
            values.engine_type = cfg.engine_type || '';
            values.engine_kw = cfg.engine_kw || '';
            values.capacity = cfg.capacity || '';
            values.range = cfg.range || '';
            values.antifouling_model = cfg.antifouling_model || '';
            values.propeller_types = cfg.propeller_types || '';
            values.bulbous = cfg.bulbous || 0;
            values.enhanced_thrusters = cfg.enhanced_thrusters || 0;
            values.price = cfg.price || '';
        } else if (prefillConfig) {
            values.presetName = prefillConfig.name || '';
            values.vesselName = prefillConfig.name || '';
            values.vessel_model = prefillConfig.vessel_model || 'container';
            values.ship_yard = prefillConfig.ship_yard || '';
            values.engine_type = prefillConfig.engine_type || '';
            values.engine_kw = prefillConfig.engine_kw || '';
            values.capacity = prefillConfig.capacity || '';
            values.range = prefillConfig.range || '';
            values.antifouling_model = prefillConfig.antifouling_model || '';
            values.propeller_types = prefillConfig.propeller_types || '';
            values.bulbous = prefillConfig.bulbous || 0;
            values.enhanced_thrusters = prefillConfig.enhanced_thrusters || 0;
            values.price = prefillConfig.price || '';
        }

        var drydockPorts = getDrydockPorts();

        var portOptions = '<option value="">-- Select Port --</option>';
        for (var pi = 0; pi < drydockPorts.length; pi++) {
            var p = drydockPorts[pi];
            var selected = values.ship_yard === p.code ? ' selected' : '';
            portOptions += '<option value="' + escapeHtml(p.code) + '"' + selected + '>' + escapeHtml(formatPortName(p.code)) + ' (' + escapeHtml(formatPortName(p.country)) + ') [' + escapeHtml(String(p.drydock)) + ']</option>';
        }

        var inputStyle = 'width:100%;padding:8px 10px;background:#252b3b;border:1px solid #374151;color:#fff;border-radius:6px;font-size:13px;box-sizing:border-box;';
        var labelStyle = 'color:#9ca3af;font-size:12px;margin-bottom:4px;display:block;';
        var fieldStyle = 'margin-bottom:12px;';

        var overlay = document.createElement('div');
        overlay.id = 'vessel-presets-form-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1f2e;border:1px solid #374151;border-radius:12px;width:90%;max-width:500px;max-height:85vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;';

        // Header
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #374151;background:#0f1420;flex-shrink:0;';
        header.innerHTML = '<span style="color:#fff;font-size:16px;font-weight:600;">' + (isEdit ? 'Edit Preset' : 'New Preset') + '</span>' +
            '<div style="display:flex;gap:8px;">' +
            '<button id="vpf-save-btn" style="padding:8px 16px;background:#4ade80;color:#111;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;">Save</button>' +
            '<button id="vpf-cancel-btn" style="padding:8px 16px;background:#4b5563;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">Cancel</button>' +
            '</div>';

        // Form
        var form = document.createElement('div');
        form.style.cssText = 'padding:16px 20px;overflow-y:auto;flex:1;';

        form.innerHTML =
            // Preset Name
            '<div style="' + fieldStyle + '">' +
                '<label style="' + labelStyle + '">Preset Name *</label>' +
                '<input id="vpf-preset-name" type="text" style="' + inputStyle + '" placeholder="e.g. My Container Build" value="' + escapeHtml(values.presetName) + '">' +
            '</div>' +
            // Vessel Name
            '<div style="' + fieldStyle + '">' +
                '<label style="' + labelStyle + '">Default Vessel Name</label>' +
                '<input id="vpf-vessel-name" type="text" style="' + inputStyle + '" placeholder="Name given to vessels when added to cart" value="' + escapeHtml(values.vesselName) + '">' +
            '</div>' +
            // Vessel Model + Ship Yard (side by side)
            '<div style="display:flex;gap:12px;' + fieldStyle + '">' +
                '<div style="flex:1;">' +
                    '<label style="' + labelStyle + '">Vessel Model *</label>' +
                    '<select id="vpf-vessel-model" style="' + inputStyle + '">' +
                        '<option value="container"' + (values.vessel_model === 'container' ? ' selected' : '') + '>Container</option>' +
                        '<option value="tanker"' + (values.vessel_model === 'tanker' ? ' selected' : '') + '>Tanker</option>' +
                    '</select>' +
                '</div>' +
                '<div style="flex:1;">' +
                    '<label style="' + labelStyle + '">Ship Yard *</label>' +
                    '<select id="vpf-ship-yard" style="' + inputStyle + '">' + portOptions + '</select>' +
                '</div>' +
            '</div>' +
            // Engine Type + Engine kW
            '<div style="display:flex;gap:12px;' + fieldStyle + '">' +
                '<div style="flex:1;">' +
                    '<label style="' + labelStyle + '">Engine Type</label>' +
                    '<input id="vpf-engine-type" type="text" style="' + inputStyle + '" placeholder="e.g. HFO_standard" value="' + escapeHtml(String(values.engine_type)) + '">' +
                '</div>' +
                '<div style="flex:1;">' +
                    '<label style="' + labelStyle + '">Engine kW</label>' +
                    '<input id="vpf-engine-kw" type="text" inputmode="numeric" style="' + inputStyle + '" placeholder="e.g. 18,000" value="' + (values.engine_kw ? formatNumber(values.engine_kw) : '') + '">' +
                '</div>' +
            '</div>' +
            // Capacity + Range
            '<div style="display:flex;gap:12px;' + fieldStyle + '">' +
                '<div style="flex:1;">' +
                    '<label id="vpf-capacity-label" style="' + labelStyle + '">Capacity (' + (values.vessel_model === 'tanker' ? 'BBL' : 'TEU') + ')</label>' +
                    '<input id="vpf-capacity" type="text" inputmode="numeric" style="' + inputStyle + '" placeholder="e.g. 5,000" value="' + (values.capacity ? formatNumber(values.capacity) : '') + '">' +
                '</div>' +
                '<div style="flex:1;">' +
                    '<label style="' + labelStyle + '">Range</label>' +
                    '<input id="vpf-range" type="text" inputmode="numeric" style="' + inputStyle + '" placeholder="e.g. 12,000" value="' + (values.range ? formatNumber(values.range) : '') + '">' +
                '</div>' +
            '</div>' +
            // Antifouling + Propeller
            '<div style="display:flex;gap:12px;' + fieldStyle + '">' +
                '<div style="flex:1;">' +
                    '<label style="' + labelStyle + '">Antifouling Model</label>' +
                    '<input id="vpf-antifouling" type="text" style="' + inputStyle + '" placeholder="e.g. copper_based" value="' + escapeHtml(String(values.antifouling_model)) + '">' +
                '</div>' +
                '<div style="flex:1;">' +
                    '<label style="' + labelStyle + '">Propeller Type</label>' +
                    '<input id="vpf-propeller" type="text" style="' + inputStyle + '" placeholder="e.g. fixed_pitch" value="' + escapeHtml(String(values.propeller_types)) + '">' +
                '</div>' +
            '</div>' +
            // Checkboxes: Bulbous + Enhanced Thrusters
            '<div style="display:flex;gap:24px;' + fieldStyle + '">' +
                '<label style="display:flex;align-items:center;gap:6px;color:#9ca3af;font-size:13px;cursor:pointer;">' +
                    '<input id="vpf-bulbous" type="checkbox"' + (values.bulbous ? ' checked' : '') + ' style="accent-color:#f59e0b;width:16px;height:16px;cursor:pointer;">' +
                    'Bulbous Bow' +
                '</label>' +
                '<label style="display:flex;align-items:center;gap:6px;color:#9ca3af;font-size:13px;cursor:pointer;">' +
                    '<input id="vpf-thrusters" type="checkbox"' + (values.enhanced_thrusters ? ' checked' : '') + ' style="accent-color:#f59e0b;width:16px;height:16px;cursor:pointer;">' +
                    'Enhanced Thrusters' +
                '</label>' +
            '</div>' +
            // Estimated Price
            '<div style="' + fieldStyle + '">' +
                '<label style="' + labelStyle + '">Estimated Price ($)</label>' +
                '<input id="vpf-price" type="text" inputmode="numeric" style="' + inputStyle + '" placeholder="e.g. 45,000,000" value="' + (values.price ? formatNumber(values.price) : '') + '">' +
            '</div>';

        modal.appendChild(header);
        modal.appendChild(form);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Setup thousand separators on numeric fields
        if (window.PirateUtils && window.PirateUtils.setupThousandSeparator) {
            var numericIds = ['vpf-engine-kw', 'vpf-capacity', 'vpf-range', 'vpf-price'];
            for (var ni = 0; ni < numericIds.length; ni++) {
                var numInput = document.getElementById(numericIds[ni]);
                if (numInput) window.PirateUtils.setupThousandSeparator(numInput);
            }
        }

        // Update capacity label when vessel model changes
        var vesselModelSelect = document.getElementById('vpf-vessel-model');
        if (vesselModelSelect) {
            vesselModelSelect.addEventListener('change', function() {
                var label = document.getElementById('vpf-capacity-label');
                if (label) {
                    label.textContent = 'Capacity (' + (vesselModelSelect.value === 'tanker' ? 'BBL' : 'TEU') + ')';
                }
            });
        }

        // Event handlers
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay || e.target.id === 'vpf-cancel-btn') {
                overlay.remove();
                return;
            }
            if (e.target.id === 'vpf-save-btn') {
                savePresetFromForm(presetId, overlay);
                return;
            }
        });
    }

    function getNumericValue(inputId) {
        var input = document.getElementById(inputId);
        if (!input || !input.value) return 0;
        return parseInt(String(input.value).replace(/,/g, ''), 10) || 0;
    }

    function savePresetFromForm(presetId, overlay) {
        var presetName = document.getElementById('vpf-preset-name').value.trim();
        if (!presetName) {
            showNotification('Preset name is required');
            document.getElementById('vpf-preset-name').style.borderColor = '#ef4444';
            return;
        }

        var vesselModel = document.getElementById('vpf-vessel-model').value;
        var shipYard = document.getElementById('vpf-ship-yard').value;
        if (!shipYard) {
            showNotification('Ship yard is required');
            document.getElementById('vpf-ship-yard').style.borderColor = '#ef4444';
            return;
        }

        var vesselName = document.getElementById('vpf-vessel-name').value.trim() || presetName;
        var engineType = document.getElementById('vpf-engine-type').value.trim();
        var engineKw = getNumericValue('vpf-engine-kw');
        var capacity = getNumericValue('vpf-capacity');
        var range = getNumericValue('vpf-range');
        var antifouling = document.getElementById('vpf-antifouling').value.trim();
        var propeller = document.getElementById('vpf-propeller').value.trim();
        var bulbous = document.getElementById('vpf-bulbous').checked ? 1 : 0;
        var thrusters = document.getElementById('vpf-thrusters').checked ? 1 : 0;
        var price = getNumericValue('vpf-price');

        var data = {
            name: presetName,
            buildConfig: {
                name: vesselName,
                vessel_model: vesselModel,
                ship_yard: shipYard,
                engine_type: engineType || null,
                engine_kw: engineKw || 0,
                capacity: capacity || 0,
                range: range || null,
                antifouling_model: antifouling || null,
                propeller_types: propeller || null,
                bulbous: bulbous,
                enhanced_thrusters: thrusters,
                price: price || 0
            }
        };

        if (presetId) {
            updatePreset(presetId, data);
            showNotification('Preset "' + presetName + '" updated');
        } else {
            createPreset(data);
            showNotification('Preset "' + presetName + '" created');
        }

        overlay.remove();

        // Refresh the main presets modal
        var mainOverlay = document.getElementById('vessel-presets-overlay');
        if (mainOverlay) {
            mainOverlay.remove();
        }
        openPresetsModal();
    }

    // ── Init ─────────────────────────────────────────────────────

    function init() {
        getPresets(function(presets) {
            console.log('[VesselPresets] Loaded ' + Object.keys(presets).length + ' presets');
        });

        addMenuItem('Vessel Presets', openPresetsModal, 27);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
