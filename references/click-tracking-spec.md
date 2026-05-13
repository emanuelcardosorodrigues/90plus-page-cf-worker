# Click Tracking Spec — Universal Delegated Listener

Spec for the global click tracker shipped in [`assets/click-tracker-global.js`](../assets/click-tracker-global.js). Every Worker-served landing/quiz/page MUST implement this contract, or risk losing 20-40% of click attribution to pre-hydration races, SPA route changes, adblockers, or PII leaks.

## Payload obrigatório

Every click push to `dataLayer` carries this exact shape. Missing fields break Tag Manager triggers configured downstream.

```js
{
  event: 'click',
  click_id: 'string',          // element.id, or '' if absent
  click_classes: 'string',     // element.className, trimmed
  click_text: 'string',        // element.textContent, single-spaced, sliced to 120 chars
  click_href: 'string|null',   // for <a>, the resolved href; null otherwise
  click_target_kind: 'cta-internal' | 'cta-external' | 'external-checkout' | 'worker-redirect' | 'nav' | 'other',
  page_slug: 'string',          // window.__pageSlug at click time
  event_id: 'string',           // crypto.randomUUID() for dedup with CAPI
  ts: 1234567890                // Date.now() at handler entry
}
```

## Listener global, NÃO por seletor

Bind exactly **one** listener on `document`, in capture phase, passive. Determine the click target via `closest('a, button, [role="button"], [data-track]')`.

```js
document.addEventListener('click', handler, { capture: true, passive: true });
```

Reasons:

- **Capture phase** catches the click before any framework's synthetic event system swallows it.
- **Passive** signals to the browser that the handler does not call `preventDefault`, so scroll/touch jank stays away.
- **One listener** is cheaper than per-button bindings, survives DOM rerenders without manual rebinding, and works with any framework.

## PII guard — nunca capturar input/textarea

Early-return at the top of the handler:

```js
if (event.target.closest('input, textarea, select, [contenteditable]')) return;
```

Why: a click inside a text field counts as a click on the field's text, which often contains the user's email, password, CPF, or full name. Pushing that to `dataLayer` leaks PII to every Tag Manager destination — Meta, Google Ads, Hotjar, anywhere `dataLayer` is read. LGPD/GDPR violation in one line.

Smoke test: open DevTools Console, click inside an `<input type="text">`, watch `dataLayer`. Nothing should appear.

## Consent gate

If the site operates under LGPD/GDPR or any explicit-consent regime:

```js
if (window.__consent !== 'granted' && !window.__cfg?.consentBypass) {
  (window.__pendingConsent ||= []).push(payload);
  return;
}
```

The tracker does not own the CMP. The site integrates a CMP (Cookiebot, OneTrust, custom) that sets `window.__consent = 'granted'` after the user accepts. When consent flips to granted, the CMP code should drain `window.__pendingConsent`:

```js
// In the CMP "accepted" callback:
const queue = window.__pendingConsent || [];
queue.forEach(p => window.dataLayer.push(p));
window.__pendingConsent = [];
```

For B2B contexts where consent is implied (logged-in dashboards, internal tools), set `window.__cfg = { consentBypass: true }` before the tracker loads.

## DNT (optional)

Some users enable `navigator.doNotTrack === '1'` globally — most don't realize they did, and turning off tracking by default breaks attribution for legitimate visits. Default: **ignore DNT**.

Opt-in: `window.__cfg = { respectDNT: true }`. The tracker then early-returns when `navigator.doNotTrack === '1'`.

## Slug lifecycle (window.__pageSlug)

`page_slug` is the page identity used downstream for A/B routing, funnel attribution, and webhook reconciliation. Three boot sources, in priority:

1. **SSR injection.** Server-side rendered HTML emits `<script>window.__pageSlug='my-landing';</script>` in `<head>`, BEFORE the tracker script tag. Recommended for Worker-served HTML.
2. **Static config.** For pure SPAs, the Vite/HTML template sets `window.__pageSlug` inline in `index.html` before the tracker.
3. **SPA route change.** When the user navigates within the SPA, the tracker monkey-patches `history.pushState` and `history.replaceState` to update `window.__pageSlug` from the new route. See next section.

## SPA navigation — virtual pageview

For SPAs, a route change without a full page reload still counts as a "view" for attribution. The tracker patches `history.pushState`/`replaceState` to fire a virtual pageview:

```js
const fireVirtualPageview = (path) => {
  const event_id = `pv:${path}:${Date.now()}`;
  if (document.body.dataset.lastVpv === event_id.slice(0, -3)) return; // dedup within 1s
  document.body.dataset.lastVpv = event_id.slice(0, -3);
  window.__pageSlug = derivedSlugFromPath(path);
  window.dataLayer.push({
    event: 'virtual_pageview',
    page_slug: window.__pageSlug,
    path,
    event_id,
  });
};

['pushState', 'replaceState'].forEach((method) => {
  const original = history[method];
  history[method] = function (...args) {
    const ret = original.apply(this, args);
    fireVirtualPageview(location.pathname + location.search);
    return ret;
  };
});
window.addEventListener('popstate', () => fireVirtualPageview(location.pathname + location.search));
```

Dedup logic prevents double-fire when frameworks call `replaceState` rapidly. The `derivedSlugFromPath` helper is project-specific — the tracker accepts it via `window.__cfg.derivedSlug = (path) => '...'` or falls back to `location.pathname.split('/').filter(Boolean).slice(-1)[0]`.

## Captura de gclid/fbclid/UTMs — ordem de fontes

The tracker reads attribution params in this exact order, first hit wins:

1. **URL current** — `new URLSearchParams(location.search)`.
2. **sessionStorage** — survives across pages within the same tab.
3. **localStorage** — first-touch immutable; survives across tabs and days.
4. **Cookie** — cross-domain (when SameSite=Lax + same eTLD+1).

Once resolved, the boot of the tracker writes ALL sources synchronously before the first push, eliminating the race condition described next.

## Race condition — primeira pageview

If the very first page load has `?gclid=ABC` in the URL and the tracker fires a `pageview` event before reading the URL, the event has no `gclid`. Fix: source resolution is **synchronous** at boot, BEFORE any `dataLayer.push`. Reference: [`assets/click-tracker-global.js`](../assets/click-tracker-global.js) — the `initAttribution()` call sits immediately after the IIFE entry, before listeners attach.

Smoke test: open a fresh tab, paste `https://yoursite.com/?gclid=TEST123`, look at the first `dataLayer.push` — it must include `gclid: 'TEST123'`.

## Lógica de write

After boot, the resolver writes attribution to all three layers (with try/catch):

```js
const writeAttrib = (attrib) => {
  try { sessionStorage.setItem('__attrib', JSON.stringify(attrib)); } catch {}
  try {
    if (!localStorage.getItem('__attrib_first')) {
      localStorage.setItem('__attrib_first', JSON.stringify(attrib));
    }
  } catch {} // quota full, Safari private mode, etc.
  try {
    document.cookie = `__attrib=${encodeURIComponent(JSON.stringify(attrib))}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
  } catch {}
};
```

`localStorage` may throw on quota full or in Safari private mode. Always wrap. Fallback degradation: session-only attribution. Worst case: URL-only attribution per visit (acceptable for paid traffic; not for organic).

## Bind a links externos de checkout

The handler bifurcates the link target:

- `external-checkout` — href host matches `window.__cfg.externalCheckoutHosts = ['pay.example.com', ...]`. Apply attribution sufix (UTM/sck) and let the navigation proceed.
- `worker-redirect` — href path starts with `/r/`. The Worker handles the redirect; do not modify.
- `cta-external` — any other external link.
- `cta-internal` — same-origin link to a non-`/r/` path.
- `nav` — link inside `<header>`, `<nav>`, or with `[data-nav]`.
- `other` — fallback.

The `externalCheckoutHosts` list is project-specific. The tracker accepts it via `window.__cfg` so no host is hardcoded in the shared asset.

## Iframes

UTM propagation into iframes is delegated to [`utm-propagator.js`](../assets/utm-propagator.js). The click tracker itself does not reach into iframes.

**Special case: video players (VTURB, Wistia, Vimeo, etc.).** Many embed players render the play/CTA button in the parent DOM (above the iframe), so a click on the button is captured by the document-level listener without any iframe access. Players that put the CTA inside the iframe are cross-origin and unreachable — accept the loss or use the player's postMessage API.

## Anti-double-fire

A `WeakSet` of already-processed elements prevents double-pushes when frameworks fire synthetic + native click in the same tick:

```js
const seen = new WeakSet();
function handler(event) {
  const target = event.target.closest('a, button, [role="button"], [data-track]');
  if (!target || seen.has(target)) return;
  seen.add(target);
  setTimeout(() => seen.delete(target), 300); // release after 300ms
  // ... build payload, push
}
```

## Versioning — SemVer de event names

Tag Manager triggers configured on `event: 'click'` break silently if the event name bumps to `click@2`. Strategy:

- **Major bump** (breaking payload shape) → new event name, e.g. `click_v2`. Migrate Tag Manager triggers, then retire old event.
- **Minor bump** (additive fields) → keep `event: 'click'`, add field with safe default.
- Annotate the tracker file header with the spec version: `/* tracker spec: 1.0.0 */`.

## Performance note — `capture: true`

The capture-phase listener intercepts every click in the document. In normal landing pages this is < 0.1ms per click — invisible. In design tools, kanban boards, or drag-and-drop interfaces with hundreds of clicks per minute, it can become a hot path.

Mitigation:

```js
function handler(event) {
  const tag = event.target.tagName;
  if (tag !== 'A' && tag !== 'BUTTON' && tag !== 'INPUT' && !event.target.closest('[role="button"], [data-track]')) {
    return; // fast bail
  }
  // ... rest of handler
}
```

The fast bail rejects most spurious clicks in the first 2-3 instructions. Benchmark on the target page before shipping.

## Build integration — Vite minification

**Vite + React.** Import the tracker at the top of `main.tsx`:

```ts
import './tracker.js'; // side-effect import; Vite preserves order
import { createRoot } from 'react-dom/client';
// ...
```

Vite preserves side-effect imports in production builds. The tracker boots synchronously before React mounts, so pre-hydration clicks are captured by the `__pending` shim, and React's first render does not race the tracker.

**HTML+JS puro.** Use `<script defer>` in `<head>`:

```html
<script defer src="/tracker.js"></script>
```

`defer` guarantees the script runs after HTML parse but before `DOMContentLoaded`, in document order.

**Never paste the minified tracker inline** unless source maps are also shipped. Debugging a production bug in minified inline JS is an hours-long ordeal.

## Debug mode

```js
if (window.__cfg?.debug) {
  console.error('[tracker] failed to read URL params', err);
}
```

Default: silent. The tracker swallows errors in production to avoid breaking the page over a tracking issue. Set `window.__cfg = { debug: true }` in a preview environment to surface failures.
