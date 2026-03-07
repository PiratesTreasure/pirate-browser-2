// ==UserScript==
// @name        ShippingManager - Export all your vessels details
// @description Export all your vessels with details as CSV
// @version     1.23
// @author      https://github.com/justonlyforyou/
// @order        994
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// @RequireRebelShipMenu true
// ==/UserScript==
/* globals Blob, URL, addMenuItem */

(function() {
    'use strict';

    // Column mapping: [csvHeader, accessor(vessel)]
    // Nested fields use dot-path accessors, booleans use flag accessor
    var COLUMNS = [
        ['id', function(v) { return v.id; }],
        ['name', function(v) { return v.name; }],
        ['type_name', function(v) { return v.type_name; }],
        ['capacity_type', function(v) { return v.capacity_type; }],
        ['status', function(v) { return v.status; }],
        ['current_port_code', function(v) { return v.current_port_code; }],
        ['imo', function(v) { return v.imo; }],
        ['mmsi', function(v) { return v.mmsi; }],
        ['year', function(v) { return v.year; }],
        ['length', function(v) { return v.length; }],
        ['width', function(v) { return v.width; }],
        ['range', function(v) { return v.range; }],
        ['kw', function(v) { return v.kw; }],
        ['max_speed', function(v) { return v.max_speed; }],
        ['capacity_max_dry', function(v) { return v.capacity_max ? v.capacity_max.dry : undefined; }],
        ['capacity_max_refrigerated', function(v) { return v.capacity_max ? v.capacity_max.refrigerated : undefined; }],
        ['capacity_dry', function(v) { return v.capacity ? v.capacity.dry : undefined; }],
        ['capacity_refrigerated', function(v) { return v.capacity ? v.capacity.refrigerated : undefined; }],
        ['price_dry', function(v) { return v.prices ? v.prices.dry : undefined; }],
        ['price_refrigerated', function(v) { return v.prices ? v.prices.refrigerated : undefined; }],
        ['fuel_capacity', function(v) { return v.fuel_capacity; }],
        ['fuel_factor', function(v) { return v.fuel_factor; }],
        ['co2_factor', function(v) { return v.co2_factor; }],
        ['wear', function(v) { return v.wear; }],
        ['hours_until_check', function(v) { return v.hours_until_check; }],
        ['hours_between_service', function(v) { return v.hours_between_service; }],
        ['travelled_hours', function(v) { return v.travelled_hours; }],
        ['total_distance_traveled', function(v) { return v.total_distance_traveled; }],
        ['is_parked', function(v) { return v.is_parked ? '1' : '0'; }],
        ['gearless', function(v) { return v.gearless !== undefined ? v.gearless : '0'; }],
        ['bulbous_bow', function(v) { return v.bulbous_bow !== undefined ? v.bulbous_bow : '0'; }],
        ['enhanced_thrusters', function(v) { return v.enhanced_thrusters !== undefined ? v.enhanced_thrusters : '0'; }],
        ['antifouling', function(v) { return v.antifouling; }],
        ['route_name', function(v) { return v.route_name; }],
        ['route_origin', function(v) { return v.route_origin; }],
        ['route_destination', function(v) { return v.route_destination; }],
        ['route_distance', function(v) { return v.route_distance; }],
        ['route_speed', function(v) { return v.route_speed; }],
        ['route_end_time', function(v) { return v.route_end_time; }],
        ['time_acquired', function(v) { return v.time_acquired; }],
        ['time_arrival', function(v) { return v.time_arrival; }],
        ['engine_type', function(v) { return v.engine_type; }],
        ['price', function(v) { return v.price; }]
    ];

    // Pre-build header string once
    var headerLine = COLUMNS.map(function(col) { return col[0]; }).join(';') + '\n';

    // Add export button to menu
    function addExportMenuItem() {
        addMenuItem('Export All Vessels', exportVessels, 997);
        console.log('[ExportVessels] Menu item added');
    }

    function exportVessels() {
        var dropdown = document.getElementById('rebelship-dropdown');
        if (dropdown) dropdown.style.display = 'none';

        fetch('https://shippingmanager.cc/api/vessel/get-all-user-vessels', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ include_routes: true }),
            credentials: 'include'
        })
        .then(function(response) {
            if (!response.ok) {
                throw new Error('API request failed: ' + response.status);
            }
            return response.json();
        })
        .then(function(data) {
            var vessels = data.data && data.data.user_vessels ? data.data.user_vessels : [];

            if (vessels.length === 0) {
                alert('No vessels found.');
                return;
            }

            // Build CSV as Blob chunks (avoid string copying)
            var chunks = ['\ufeff', headerLine];

            for (var i = 0; i < vessels.length; i++) {
                var v = vessels[i];
                var parts = [];
                for (var c = 0; c < COLUMNS.length; c++) {
                    parts.push(escapeCSV(COLUMNS[c][1](v)));
                }
                chunks.push(parts.join(';') + '\n');
            }

            // Free vessels array before Blob creation
            vessels = null;

            // Download CSV (BOM is separate chunk)
            var blob = new Blob(chunks, { type: 'text/csv;charset=utf-8;' });
            chunks = null;
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = 'vessels_' + new Date().toISOString().slice(0, 10) + '.csv';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            alert('Exported ' + (data.data.user_vessels ? data.data.user_vessels.length : 0) + ' vessels to CSV!');
        })
        .catch(function(err) {
            console.error('[ExportVessels] Export error:', err);
            alert('Export failed: ' + err.message);
        });
    }

    function escapeCSV(val) {
        if (val === null || val === undefined) return '';
        if (typeof val === 'number') return String(val);
        var str = String(val);
        if (str.length === 0) return '';
        if (str.indexOf('"') !== -1 || str.indexOf(';') !== -1 || str.indexOf('\n') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    // Initialize: finite retry for addMenuItem availability
    function init() {
        if (typeof addMenuItem === 'function') {
            addExportMenuItem();
            return;
        }
        var attempt = 0;
        function retryInit() {
            attempt++;
            if (typeof addMenuItem === 'function') {
                addExportMenuItem();
                return;
            }
            if (attempt < 3) setTimeout(retryInit, attempt * 1000);
        }
        setTimeout(retryInit, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
