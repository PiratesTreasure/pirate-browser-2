// ==UserScript==
// @name        ShippingManager - Admin View
// @description Enable admin/moderator UI elements (client-side only - just for look and feel). HAS NO ADMIN FUNCTIONS IN BACKEND!
// @version     9.01
// @author      https://github.com/justonlyforyou/
// @order        998
// @match       https://shippingmanager.cc/*
// @grant       none
// @run-at      document-end
// @enabled     false
// ==/UserScript==

(function() {
    'use strict';

    const script = document.createElement('script');
    script.textContent = `
(function() {
    if (window.__ADMIN_VIEW_88__) return;
    window.__ADMIN_VIEW_88__ = true;

    // Targeted fetch interceptor instead of global JSON.parse override
    var originalFetch = window.fetch;
    window.fetch = async function() {
        var url = arguments[0]?.url || arguments[0] || '';
        var response = await originalFetch.apply(this, arguments);
        if (typeof url !== 'string') return response;

        var needsPatch = url.includes('/user/') || url.includes('/game/') || url.includes('forum');
        if (!needsPatch) return response;

        var clone = response.clone();
        var patchedResponse = new Response(clone.body, {
            status: clone.status,
            statusText: clone.statusText,
            headers: clone.headers
        });

        patchedResponse.json = async function() {
            var data;
            try { data = await clone.json(); } catch(e) { return {}; }

            if (data?.admin_login !== undefined) {
                data.admin_login = true;
            }
            if (data?.data?.admin_login !== undefined) {
                data.data.admin_login = true;
            }
            if (data?.data && 'forum_user' in data.data) {
                if (data.data.forum_user) {
                    data.data.forum_user.role = 'admin';
                } else {
                    data.data.forum_user = { role: 'admin', id: 1 };
                }
            }
            if (data?.forum_user) {
                data.forum_user.role = 'admin';
            }
            return data;
        };

        return patchedResponse;
    };

    function getVueApp() {
        var appEl = document.querySelector('#app');
        return appEl?.__vue_app__;
    }

    function getPinia() {
        var app = getVueApp();
        if (!app) return null;
        return app._context?.provides?.pinia || app.config?.globalProperties?.$pinia;
    }

    function patchPiniaStores() {
        var pinia = getPinia();
        if (!pinia) return false;
        var userStore = pinia._s.get('user');
        if (userStore?.user) {
            userStore.user.is_admin = true;
        }
        return true;
    }

    // Early-return component search: stop as soon as forum component found
    var cachedForumComponent = null;

    function findForumComponentInTree(instance) {
        if (!instance) return null;
        var ctx = instance.ctx || instance.proxy;
        if (ctx && 'forumUser' in ctx) return instance;
        if (instance.data && 'forumUser' in instance.data) return instance;

        if (instance.subTree) {
            var found = walkVnodeForForum(instance.subTree);
            if (found) return found;
        }
        return null;
    }

    function walkVnodeForForum(vnode) {
        if (!vnode) return null;
        if (vnode.component) {
            var found = findForumComponentInTree(vnode.component);
            if (found) return found;
        }
        if (Array.isArray(vnode.children)) {
            for (var i = 0; i < vnode.children.length; i++) {
                var found = walkVnodeForForum(vnode.children[i]);
                if (found) return found;
            }
        }
        if (vnode.dynamicChildren) {
            for (var j = 0; j < vnode.dynamicChildren.length; j++) {
                var found = walkVnodeForForum(vnode.dynamicChildren[j]);
                if (found) return found;
            }
        }
        return null;
    }

    function findForumComponent() {
        if (cachedForumComponent) {
            var ctx = cachedForumComponent.ctx || cachedForumComponent.proxy;
            if (ctx && 'forumUser' in ctx) return cachedForumComponent;
            cachedForumComponent = null;
        }

        var forumContainer = document.querySelector('.forumContainer');
        if (forumContainer) {
            var keys = Object.keys(forumContainer);
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (key.startsWith('__vue')) {
                    var val = forumContainer[key];
                    if (val?.ctx && 'forumUser' in val.ctx) {
                        cachedForumComponent = val;
                        return val;
                    }
                    if (val?.component?.ctx && 'forumUser' in val.component.ctx) {
                        cachedForumComponent = val.component;
                        return val.component;
                    }
                }
            }
            // Parent traversal with depth limit of 10
            var el = forumContainer;
            var depth = 0;
            while (el && el !== document.body && depth < 10) {
                var elKeys = Object.keys(el);
                for (var j = 0; j < elKeys.length; j++) {
                    var k = elKeys[j];
                    if (k.startsWith('__vue') && el[k]?.ctx) {
                        if ('forumUser' in el[k].ctx) {
                            cachedForumComponent = el[k];
                            return el[k];
                        }
                    }
                }
                el = el.parentElement;
                depth++;
            }
        }

        var app = getVueApp();
        if (!app?._instance) return null;
        var found = findForumComponentInTree(app._instance);
        if (found) cachedForumComponent = found;
        return found;
    }

    function patchForumComponent() {
        var forumComp = findForumComponent();
        if (!forumComp) return false;
        var ctx = forumComp.ctx || forumComp.proxy;
        var data = forumComp.data;
        if (ctx?.forumUser) {
            ctx.forumUser.role = 'admin';
        }
        if (data?.forumUser) {
            data.forumUser.role = 'admin';
        }
        if (!ctx?.forumUser && !data?.forumUser) {
            if (ctx) {
                ctx.forumUser = { role: 'admin', id: 1 };
            }
        }
        if (forumComp.proxy?.$forceUpdate) {
            forumComp.proxy.$forceUpdate();
        }
        if (forumComp.update) {
            forumComp.update();
        }
        return true;
    }

    // Debounced MutationObserver: single call per 300ms instead of triple setTimeout
    var patchDebounceTimer = null;
    function debouncedPatch() {
        if (patchDebounceTimer) clearTimeout(patchDebounceTimer);
        patchDebounceTimer = setTimeout(patchForumComponent, 300);
    }

    var observer = new MutationObserver(function(mutations) {
        for (var m = 0; m < mutations.length; m++) {
            var addedNodes = mutations[m].addedNodes;
            for (var n = 0; n < addedNodes.length; n++) {
                var node = addedNodes[n];
                if (node.nodeType !== 1) continue;
                var className = '';
                if (node.className) {
                    if (typeof node.className === 'string') {
                        className = node.className;
                    } else if (node.className.baseVal) {
                        className = node.className.baseVal;
                    }
                }
                if (className.includes('forum') ||
                    className.includes('Forum') ||
                    className.includes('modal') ||
                    node.id === 'modal-container') {
                    debouncedPatch();
                    return;
                }
                if (node.classList && (node.classList.contains('forumContainer') || node.classList.contains('modal-wrapper'))) {
                    debouncedPatch();
                    return;
                }
            }
        }
    });
    var observeTarget = document.getElementById('modal-container') || document.getElementById('app') || document.body;
    observer.observe(observeTarget, { childList: true, subtree: true });

    window.adminView = {
        patch: patchForumComponent,
        patchStores: patchPiniaStores,
        getApp: getVueApp,
        getPinia: getPinia
    };

    setTimeout(patchPiniaStores, 2000);
})();
`;
    document.head.appendChild(script);
})();
