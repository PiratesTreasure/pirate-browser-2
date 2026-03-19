// ==UserScript==
// @name         Pirate Command Bar
// @description  Registers script menu items into the Pirate Browser Tools menu. Account info is shown in the Electron toolbar - no page injection needed.
// @version      3.0.0
// @match        https://shippingmanager.cc/*
// @order        1
// ==/UserScript==

(function () {
  'use strict';
  // This script no longer injects anything into the game page.
  // Account info (username, company, balance, rank) is now displayed
  // directly in the Electron toolbar via webview.executeJavaScript polling.
  // The Tools dropdown in the toolbar is populated by addMenuItem/addSubMenu
  // calls from the other scripts via pirate-bridge_user.js.
  console.log('[PirateCommandBar] v3.0 - toolbar mode active');
})();
