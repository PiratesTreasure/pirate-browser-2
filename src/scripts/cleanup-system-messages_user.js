// ==UserScript==
// @name         ShippingManager - Cleanup System Messages
// @namespace    https://rebelship.org/
// @version      1.01
// @description  Bulk delete alliance join and donation system messages from your inbox
// @author       https://github.com/justonlyforyou/
// @order        997
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// @RequireRebelShipMenu true
// ==/UserScript==
/* globals addSubMenu */

(function() {
    'use strict';

    var LOG_PREFIX = '[CleanupSysMsg]';

    function log(msg) {
        console.log(LOG_PREFIX + ' ' + msg);
    }

    function fetchAllChats(maxRetries) {
        maxRetries = maxRetries ?? 3;

        function attempt(attemptNum) {
            return fetch('/api/messenger/get-chats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({})
            })
            .then(function(response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function(data) {
                if (!data || !data.data) throw new Error('No data in response');
                return data.data;
            })
            .catch(function(e) {
                log('fetchAllChats attempt ' + attemptNum + '/' + maxRetries + ' failed: ' + e.message);
                if (attemptNum < maxRetries) {
                    var delay = attemptNum * 1000;
                    return new Promise(function(resolve) { setTimeout(resolve, delay); }).then(function() {
                        return attempt(attemptNum + 1);
                    });
                }
                throw e;
            });
        }

        return attempt(1);
    }

    function deleteSystemMessages(ids, maxRetries) {
        maxRetries = maxRetries ?? 3;

        function attempt(attemptNum) {
            return fetch('/api/messenger/delete-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    chat_ids: '[]',
                    system_message_ids: JSON.stringify(ids)
                })
            })
            .then(function(response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .catch(function(e) {
                log('deleteSystemMessages attempt ' + attemptNum + '/' + maxRetries + ' failed: ' + e.message);
                if (attemptNum < maxRetries) {
                    var delay = attemptNum * 1000;
                    return new Promise(function(resolve) { setTimeout(resolve, delay); }).then(function() {
                        return attempt(attemptNum + 1);
                    });
                }
                throw e;
            });
        }

        return attempt(1);
    }

    function showProgress(text) {
        var existing = document.getElementById('cleanup-sysmsg-progress');
        if (existing) {
            existing.innerHTML = text;
            return existing;
        }
        var div = document.createElement('div');
        div.id = 'cleanup-sysmsg-progress';
        div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1f2937;color:#fff;padding:20px 40px;border-radius:8px;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.5);font-family:Lato,sans-serif;font-size:14px;';
        div.innerHTML = text;
        document.body.appendChild(div);
        return div;
    }

    function removeProgress() {
        var el = document.getElementById('cleanup-sysmsg-progress');
        if (el) el.remove();
    }

    function isJoinMessage(chat) {
        var body = chat.body ?? '';
        return body.indexOf('accepted_to_join_alliance') !== -1 ||
               body === 'user_applied_to_join_alliance_message';
    }

    function isDonationMessage(chat) {
        var body = chat.body ?? '';
        return body.indexOf('alliance') !== -1 && body.indexOf('donation') !== -1;
    }

    async function deleteByFilter(filterFn, typeName) {
        var dropdown = document.getElementById('rebelship-dropdown');
        if (dropdown) dropdown.style.display = 'none';

        var progressDiv = showProgress('Loading chats...');

        try {
            var chats = await fetchAllChats();
            var systemChats = chats.filter(function(c) { return c.system_chat; });
            var matched = systemChats.filter(filterFn);

            if (matched.length === 0) {
                log('No ' + typeName + ' messages found');
                progressDiv.innerHTML = 'No ' + typeName + ' messages found.';
                setTimeout(removeProgress, 2000);
                return;
            }

            var ids = matched.map(function(c) { return c.id; });
            log('Found ' + ids.length + ' ' + typeName + ' messages, deleting...');
            progressDiv.innerHTML = 'Found ' + ids.length + ' ' + typeName + ' messages, deleting...';

            var batchSize = 50;
            for (var i = 0; i < ids.length; i += batchSize) {
                var batch = ids.slice(i, i + batchSize);
                var batchNum = Math.floor(i / batchSize) + 1;
                var totalBatches = Math.ceil(ids.length / batchSize);

                await deleteSystemMessages(batch);
                log('Batch ' + batchNum + '/' + totalBatches + ': ' + batch.length + ' deleted');
                progressDiv.innerHTML = 'Deleting ' + typeName + '... batch ' + batchNum + '/' + totalBatches;
            }

            log('Done! Deleted ' + ids.length + ' ' + typeName + ' messages');
            progressDiv.innerHTML = 'Deleted ' + ids.length + ' ' + typeName + ' messages!';
            setTimeout(removeProgress, 3000);
        } catch (e) {
            log('Error: ' + e.message);
            progressDiv.innerHTML = 'Failed: ' + e.message;
            setTimeout(removeProgress, 3000);
        }
    }

    function deleteJoinMessages() {
        deleteByFilter(isJoinMessage, 'alliance join');
    }

    function deleteDonationMessages() {
        deleteByFilter(isDonationMessage, 'donation');
    }

    function setupMenu() {
        var subItems = [
            { label: 'Delete Join Messages', onClick: deleteJoinMessages },
            { label: 'Delete Donations', onClick: deleteDonationMessages }
        ];
        addSubMenu('Cleanup Messages', subItems, 998);
        log('Menu registered');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupMenu);
    } else {
        setupMenu();
    }
})();
