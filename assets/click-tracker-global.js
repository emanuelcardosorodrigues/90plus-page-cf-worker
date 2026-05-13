/* tracker spec: 1.0.0 */
/*
 * Universal delegated click tracker for Cloudflare Worker-served pages.
 * Spec: see references/click-tracking-spec.md
 *
 * Configure via window.__cfg before this script loads:
 *   window.__cfg = {
 *     externalCheckoutHosts: ['pay.example.com'],  // hosts to bifurcate as 'external-checkout'
 *     workerRedirectPrefix:  '/r/',                // path prefix served by Worker redirect router
 *     consentBypass:         false,                // true in B2B / implied-consent contexts
 *     respectDNT:            false,                // true to honor navigator.doNotTrack
 *     debug:                 false,                // true to console.error on internal failures
 *     derivedSlug:           (path) => '...',      // optional slug derivation for SPA route change
 *   };
 *
 * Inject window.__pageSlug from SSR or inline before this script:
 *   <script>window.__pageSlug = 'your-page-slug';</script>
 */
(function () {
  'use strict';

  var W = window;
  var D = document;
  var CFG = W.__cfg || {};
  var DL = (W.dataLayer = W.dataLayer || []);

  function err(msg, e) {
    if (CFG.debug) console.error('[tracker] ' + msg, e);
  }

  if (CFG.respectDNT && navigator.doNotTrack === '1') {
    err('DNT enabled, tracker disabled');
    return;
  }

  function uuid() {
    if (W.crypto && W.crypto.randomUUID) return W.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function readSearch(search) {
    var out = {};
    try {
      new URLSearchParams(search).forEach(function (v, k) { out[k] = v; });
    } catch (e) { err('URLSearchParams parse failed', e); }
    return out;
  }

  function readStorage(store, key) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function readCookie(name) {
    try {
      var m = D.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
      return m ? JSON.parse(decodeURIComponent(m[2])) : null;
    } catch (e) { return null; }
  }

  var ATTRIB_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'ttclid', 'msclkid'];

  function pickAttrib(src) {
    if (!src) return null;
    var has = false, out = {};
    for (var i = 0; i < ATTRIB_KEYS.length; i++) {
      var k = ATTRIB_KEYS[i];
      if (src[k]) { out[k] = src[k]; has = true; }
    }
    return has ? out : null;
  }

  function writeAttrib(attrib) {
    var s = JSON.stringify(attrib);
    try { sessionStorage.setItem('__attrib', s); } catch (e) {}
    try {
      if (!localStorage.getItem('__attrib_first')) {
        localStorage.setItem('__attrib_first', s);
      }
    } catch (e) {}
    try {
      D.cookie = '__attrib=' + encodeURIComponent(s) + '; Path=/; Max-Age=2592000; SameSite=Lax; Secure';
    } catch (e) {}
  }

  function initAttribution() {
    var fromUrl = pickAttrib(readSearch(location.search));
    var fromSession = readStorage(sessionStorage, '__attrib');
    var fromLocalFirst = readStorage(localStorage, '__attrib_first');
    var fromCookie = readCookie('__attrib');
    var resolved = fromUrl || fromSession || fromLocalFirst || fromCookie || {};
    if (fromUrl) writeAttrib(fromUrl);
    W.__attrib = resolved;
    return resolved;
  }

  initAttribution();

  function targetKind(el, href) {
    if (!href) return 'other';
    if (el.closest('header, nav, [data-nav]')) return 'nav';
    var prefix = CFG.workerRedirectPrefix || '/r/';
    if (href.indexOf(prefix) === 0 || (href.indexOf(location.origin + prefix) === 0)) return 'worker-redirect';
    var hosts = CFG.externalCheckoutHosts || [];
    for (var i = 0; i < hosts.length; i++) {
      if (href.indexOf('//' + hosts[i]) !== -1) return 'external-checkout';
    }
    var sameOrigin = href.indexOf(location.origin) === 0 || href[0] === '/' || href[0] === '#';
    return sameOrigin ? 'cta-internal' : 'cta-external';
  }

  function safeText(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 120 ? t.slice(0, 120) : t;
  }

  function buildPayload(el) {
    var href = el.tagName === 'A' ? (el.getAttribute('href') || null) : null;
    return {
      event: 'click',
      click_id: el.id || '',
      click_classes: (el.className && el.className.toString && el.className.toString().trim()) || '',
      click_text: safeText(el),
      click_href: href,
      click_target_kind: targetKind(el, href),
      page_slug: W.__pageSlug || '',
      event_id: uuid(),
      ts: Date.now(),
    };
  }

  function gateAndPush(payload) {
    if (W.__consent !== 'granted' && !CFG.consentBypass) {
      (W.__pendingConsent = W.__pendingConsent || []).push(payload);
      return;
    }
    DL.push(payload);
  }

  var seen = typeof WeakSet === 'function' ? new WeakSet() : null;

  function handler(event) {
    var raw = event.target;
    if (!raw || raw.nodeType !== 1) return;
    if (raw.closest('input, textarea, select, [contenteditable]')) return; // PII guard
    var tag = raw.tagName;
    if (tag !== 'A' && tag !== 'BUTTON' && tag !== 'INPUT' && !raw.closest('[role="button"], [data-track]')) {
      var el0 = raw.closest('a, button, [role="button"], [data-track]');
      if (!el0) return;
    }
    var el = raw.closest('a, button, [role="button"], [data-track]');
    if (!el) return;
    if (seen && seen.has(el)) return;
    if (seen) {
      seen.add(el);
      setTimeout(function () { try { seen.delete(el); } catch (e) {} }, 300);
    }
    try {
      gateAndPush(buildPayload(el));
    } catch (e) { err('payload build failed', e); }
  }

  D.addEventListener('click', handler, { capture: true, passive: true });

  // Drain pre-hydration shim queue
  if (Array.isArray(W.__pending) && W.__pending.length) {
    var queue = W.__pending.splice(0);
    setTimeout(function () { queue.forEach(function (p) { try { DL.push(p); } catch (e) {} }); }, 0);
  }

  // SPA virtual pageview
  function vpv(path) {
    var slug;
    try { slug = CFG.derivedSlug ? CFG.derivedSlug(path) : (path.split('/').filter(Boolean).slice(-1)[0] || ''); }
    catch (e) { slug = ''; }
    var key = 'pv:' + path;
    if (D.body && D.body.dataset.lastVpv === key) return;
    if (D.body) D.body.dataset.lastVpv = key;
    W.__pageSlug = slug;
    gateAndPush({
      event: 'virtual_pageview',
      page_slug: slug,
      path: path,
      event_id: uuid(),
      ts: Date.now(),
    });
  }

  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var ret = orig.apply(this, arguments);
      try { vpv(location.pathname + location.search); } catch (e) { err('vpv failed', e); }
      return ret;
    };
  });
  W.addEventListener('popstate', function () {
    try { vpv(location.pathname + location.search); } catch (e) { err('vpv popstate failed', e); }
  });
})();
