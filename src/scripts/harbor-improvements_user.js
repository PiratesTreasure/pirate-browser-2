// ==UserScript==
// @name         ShippingManager - Game Bug-Fix: Move down harbor details button
// @namespace    https://rebelship.org/
// @version      2.92
// @description  Just a simple repositioning of the details button on harbor menu.
// @author       https://github.com/justonlyforyou/
// @order        27
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// ==/UserScript==

(function() {
    'use strict';

    var DEBOUNCE_MS = 200;
    var debounceTimer = null;
    var popupObserver = null;
    var observer = null;
    var isAdjusting = false;

    var style = document.createElement('style');
    style.textContent = [
        '.port-popup .popup_data {',
        '    position: relative !important;',
        '    padding-bottom: 40px !important;',
        '}',
        '.port-popup .buttonWrapper {',
        '    position: absolute !important;',
        '    bottom: 2px !important;',
        '    left: 0 !important;',
        '    right: 0 !important;',
        '    padding: 0 !important;',
        '    margin: 0 !important;',
        '    text-align: center !important;',
        '}'
    ].join('\n');
    document.head.appendChild(style);

    // Keep popups within viewport - single getBoundingClientRect call
    function adjustPopupPosition(popup) {
        if (!popup || isAdjusting) return;
        isAdjusting = true;

        var rect = popup.getBoundingClientRect();
        var viewportWidth = window.innerWidth;
        var viewportHeight = window.innerHeight;
        var margin = 10;

        var currentLeft = parseFloat(popup.style.left) || rect.left;
        var currentTop = parseFloat(popup.style.top) || rect.top;
        var targetLeft = currentLeft;
        var targetTop = currentTop;

        // Right overflow
        if (rect.right > viewportWidth - margin) {
            targetLeft -= (rect.right - viewportWidth + margin);
        }
        // Left edge (accounting for right adjustment)
        var newLeft = rect.left + (targetLeft - currentLeft);
        if (newLeft < margin) {
            targetLeft = currentLeft - rect.left + margin;
        }

        // Bottom overflow
        if (rect.bottom > viewportHeight - margin) {
            targetTop -= (rect.bottom - viewportHeight + margin);
        }
        // Top edge (accounting for bottom adjustment)
        var newTop = rect.top + (targetTop - currentTop);
        if (newTop < margin) {
            targetTop = currentTop - rect.top + margin;
        }

        // Apply all changes at once (single reflow)
        if (targetLeft !== currentLeft) popup.style.left = targetLeft + 'px';
        if (targetTop !== currentTop) popup.style.top = targetTop + 'px';

        isAdjusting = false;
    }

    // Check for popup and adjust position
    function checkForPopup() {
        var popup = document.querySelector('.port-popup');
        if (popup) {
            adjustPopupPosition(popup);
            if (!popupObserver) startPopupObserver(popup);
        } else {
            stopPopupObserver();
        }
    }

    function debouncedCheck() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function() {
            requestAnimationFrame(checkForPopup);
        }, DEBOUNCE_MS);
    }

    // Narrowed observer: only watch the popup element for style changes
    function startPopupObserver(popup) {
        if (popupObserver) popupObserver.disconnect();
        popupObserver = new MutationObserver(function() {
            if (!isAdjusting) debouncedCheck();
        });
        popupObserver.observe(popup, { attributes: true, attributeFilter: ['style'] });
    }

    function stopPopupObserver() {
        if (popupObserver) {
            popupObserver.disconnect();
            popupObserver = null;
        }
    }

    observer = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes;
            var removed = mutations[i].removedNodes;

            for (var j = 0; j < added.length; j++) {
                if (added[j].nodeType !== 1) continue;
                if ((added[j].classList && added[j].classList.contains('port-popup')) ||
                    (added[j].querySelector && added[j].querySelector('.port-popup'))) {
                    debouncedCheck();
                    break;
                }
            }

            for (var k = 0; k < removed.length; k++) {
                if (removed[k].nodeType !== 1) continue;
                if ((removed[k].classList && removed[k].classList.contains('port-popup')) ||
                    (removed[k].querySelector && removed[k].querySelector('.port-popup'))) {
                    stopPopupObserver();
                    break;
                }
            }
        }
    });

    function attachMapObserver() {
        var leaflet = document.querySelector('.leaflet-container');
        if (!leaflet) {
            setTimeout(attachMapObserver, 1000);
            return;
        }
        observer.observe(leaflet, { childList: true, subtree: true });
    }
    attachMapObserver();

    window.addEventListener('beforeunload', function() {
        if (observer) observer.disconnect();
        stopPopupObserver();
    });
})();
