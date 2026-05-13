/* utm-propagator spec: 1.0.0 */
/*
 * MutationObserver-based UTM/gclid/fbclid propagator for Cloudflare Worker-served pages.
 * Spec: see references/utm-propagation-spec.md
 *
 * Configure via window.__cfg before this script loads:
 *   window.__cfg = {
 *     externalCheckoutHosts: ['pay.example.com'],
 *     sckBuilder:            (attrib) => 'pipe|delimited|sck|string',  // optional
 *     attribParams:          ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','ttclid','msclkid'],
 *   };
 *
 * Reads window.__attrib (set by click-tracker-global.js). If __attrib is empty, this script is a no-op.
 */
(function () {
  'use strict';

  var W = window;
  var D = document;
  var CFG = W.__cfg || {};
  var PARAMS = CFG.attribParams || ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'ttclid', 'msclkid'];
  var EXT_HOSTS = CFG.externalCheckoutHosts || [];
  var processed = typeof WeakSet === 'function' ? new WeakSet() : null;

  function getAttrib() {
    return W.__attrib || {};
  }

  function isExternal(url) {
    if (!url) return false;
    try {
      var u = new URL(url, location.href);
      if (u.origin === location.origin) return false;
      var host = u.host;
      for (var i = 0; i < EXT_HOSTS.length; i++) {
        if (host.indexOf(EXT_HOSTS[i]) !== -1) return true;
      }
      return true; // any external link by default
    } catch (e) { return false; }
  }

  function appendAttribToUrl(rawUrl) {
    var attrib = getAttrib();
    if (!attrib || !Object.keys(attrib).length) return rawUrl;
    try {
      var u = new URL(rawUrl, location.href);
      for (var i = 0; i < PARAMS.length; i++) {
        var k = PARAMS[i];
        if (attrib[k] && !u.searchParams.has(k)) {
          u.searchParams.set(k, attrib[k]);
        }
      }
      if (typeof CFG.sckBuilder === 'function') {
        try {
          var sck = CFG.sckBuilder(attrib);
          if (sck && !u.searchParams.has('sck')) u.searchParams.set('sck', sck);
        } catch (e) {}
      }
      return u.toString();
    } catch (e) { return rawUrl; }
  }

  function patchAnchor(a) {
    if (!a || processed && processed.has(a)) return;
    var href = a.getAttribute('href');
    if (!href || href[0] === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    if (!isExternal(href)) return;
    var next = appendAttribToUrl(href);
    if (next !== href) a.setAttribute('href', next);
    if (processed) processed.add(a);
  }

  function patchIframe(iframe) {
    if (!iframe || processed && processed.has(iframe)) return;
    var src = iframe.getAttribute('src');
    if (!src || /^(about:|data:|javascript:)/i.test(src)) return;
    try {
      if (!isExternal(src)) {
        if (processed) processed.add(iframe);
        return;
      }
      var next = appendAttribToUrl(src);
      if (next !== src) iframe.setAttribute('src', next);
      if (processed) processed.add(iframe);
    } catch (e) {
      // SecurityError on cross-origin already-loaded iframes — skip
    }
  }

  function processNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'A') patchAnchor(node);
    else if (node.tagName === 'IFRAME') patchIframe(node);
    if (node.querySelectorAll) {
      var anchors = node.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) patchAnchor(anchors[i]);
      var iframes = node.querySelectorAll('iframe[src]');
      for (var j = 0; j < iframes.length; j++) patchIframe(iframes[j]);
    }
  }

  function initialPass() {
    processNode(D.body);
  }

  var idle = false;
  function scheduleSweep(records) {
    if (idle) return;
    idle = true;
    var run = function () {
      idle = false;
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) processNode(added[j]);
      }
    };
    if (W.requestIdleCallback) {
      W.requestIdleCallback(run, { timeout: 16 });
    } else {
      setTimeout(run, 16);
    }
  }

  function start() {
    initialPass();
    if (typeof MutationObserver !== 'function') return;
    var observer = new MutationObserver(function (records) {
      scheduleSweep(records);
    });
    observer.observe(D.body, { childList: true, subtree: true });
  }

  if (D.readyState === 'loading') {
    D.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
