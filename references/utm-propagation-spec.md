# UTM/gclid/fbclid Propagation Spec

Spec for [`assets/utm-propagator.js`](../assets/utm-propagator.js). Handles cross-page, cross-tab, and cross-domain attribution. Coexists with the click tracker but lives in a separate file so it can be loaded independently in pages that don't need click tracking but DO need UTM propagation (rare, but happens).

## Source of truth

`window.__attrib` is the canonical resolved attribution object. The click tracker boots first and writes it; the propagator reads it on every iteration.

Boot order:

1. URL query string (current request).
2. `sessionStorage.__attrib` (same tab, current visit).
3. `localStorage.__attrib_first` (first-touch immutable, any tab).
4. `document.cookie.__attrib` (cross-subdomain fallback).

First hit wins. If the current URL has new params, they overwrite session + write to local (only if local was empty).

## Padrão opcional — sck multi-posição pipe-delimited

Some funnels carry attribution through gateway checkouts via a single `sck` param composed of pipe-delimited positions. The position layout is project-specific; a common convention:

```
sck = utm_source | utm_medium | utm_campaign | utm_content | utm_term | gclid | fbclid | landing_slug | variant | order_bump | ...
```

The first position (last-touch source) may receive contextual suffixes (`_ck`, `_ob`, `_v2`) for downstream A/B reconciliation; positions 2-N are immutable once set.

Apply this pattern when:

- Your payment gateway supports a single tracking field (sck, custom_id, etc.).
- You want server-side attribution via webhook without client-side dependency.
- You need to A/B test variants where the variant name has to round-trip through a third party.

Skip this pattern when:

- You have a proper attribution API server-side (Stape, Stripe metadata with rich fields, etc.).
- The funnel has < 3 dimensions to track — plain `utm_*` is enough.

The propagator accepts a builder via `window.__cfg.sckBuilder = (attrib) => '...'` so the pipe layout stays project-specific.

## Padrão opcional — slug composto multidimensional

When a funnel runs many concurrent A/B tests, encoding all variants in the landing slug itself is more resilient than client-side tracking:

```
landing-v02_ckck-v1_obob2
```

Reading the slug after PURCHASE_APPROVED webhook gives you `(landing, page_variant, checkout_variant, order_bump_variant)` without depending on Pixel, GTM, or any client-side tracker.

When to use:

- High-volume paid traffic where 5-15% loss to adblockers/ITP would distort A/B results.
- Multi-dimensional experiments where the math demands clean assignment.

Trade-off: slug becomes unreadable in URLs. Worth it for transactional funnels, not for content sites.

## Regra de sufixo em sck[0]

Only position 0 (last-touch source) receives suffixes. Positions 1-N stay byte-identical from the first write.

Why: downstream A/B engines that read `sck[0]` to assign variant treatment need a single mutable lane. Mutating later positions breaks first-touch attribution.

## first-touch slug imutável

Beyond `utm_*`, the *first* landing path the user touched is the most attributable signal for content-driven funnels. The propagator writes a first-touch cookie/local entry:

```js
__pageSlug_first = 'first-landing-they-saw'
```

Once written, never overwrite. The click tracker reads `window.__pageSlug` for the current page; the propagator carries `__pageSlug_first` through to checkout.

## Marcador `?pv=` injetado pelo Worker

When the same slug serves multiple page variants (A/B), the Worker can inject a `?pv=2` query param into the served URL to record which variant the user actually saw. The propagator then carries `pv` into the sck string or as a separate param.

Recommended over slug renaming because:

- URL stays clean for SEO.
- The slug is the "logical page" identity; `pv` is the "rendered variant" identity.

## Loop do MutationObserver

Propagation works by observing DOM mutations and patching `<a href>` and `<iframe src>` as nodes appear:

```js
const observer = new MutationObserver((records) => {
  if (W.__attribIdle) return; // debounce flag
  W.__attribIdle = true;
  (W.requestIdleCallback || setTimeout)(() => {
    records.forEach((rec) => {
      rec.addedNodes.forEach(processNode);
    });
    W.__attribIdle = false;
  }, { timeout: 16 });
});
observer.observe(D.body, { childList: true, subtree: true });
```

Debounce via `requestIdleCallback` keeps the observer off the critical path. `WeakSet` tracks already-patched nodes to avoid loops.

## Iframes cross-origin — SecurityError

Mutating `iframe.src` on a cross-origin iframe can throw `SecurityError` in some browsers, especially when the iframe is already loaded. Strategy:

- Patch `iframe.src` BEFORE the iframe is inserted into the DOM (via MutationObserver on `addedNodes`).
- Wrap every assignment in try/catch.
- If the iframe is already loaded, send attribution via `postMessage` instead (requires cooperation from the iframe's origin).

```js
function patchIframe(iframe) {
  try {
    const url = new URL(iframe.src, location.href);
    Object.entries(W.__attrib || {}).forEach(([k, v]) => {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    });
    iframe.src = url.toString();
  } catch (e) {
    // SecurityError, opaque src, or malformed URL — skip silently
  }
}
```

## Cookie 4KB limit

A single cookie is capped at ~4KB. UTM params can balloon (long `utm_content` strings, multiple gclid concatenations). The propagator truncates before writing:

```js
function fitCookie(attrib) {
  const json = JSON.stringify(attrib);
  if (json.length < 1500) return attrib;
  // Drop least-critical fields first
  const trimmed = { ...attrib };
  ['utm_term', 'utm_content'].forEach(k => delete trimmed[k]);
  return trimmed;
}
```

Hard limit: 1500 chars for the cookie value (room for cookie name + attributes). Anything beyond goes to sessionStorage only.

## iOS Safari ITP — limitações

Intelligent Tracking Prevention (ITP 2.3+) clears `localStorage` and cookies set via `document.cookie` after 7 days of no first-party interaction. Implications:

- First-touch attribution beyond 7 days requires server-side persistence (CAPI, webhook, or backend session).
- Cross-domain attribution via cookie works only inside the same eTLD+1 (e.g., `app.example.com` ↔ `pay.example.com`).
- `localStorage.__attrib_first` may disappear in long-tail re-engagement campaigns.

No client-side workaround exists. The defense is server-side: when a user converts, the payment gateway webhook carries enough context (sck, slug, fbclid) to reconcile attribution even if the client-side store is empty.

## Cookies em iframes (SameSite/Secure)

Iframes from a different origin do NOT share cookies with the parent. To pass attribution to an embedded checkout iframe:

1. Build the attribution payload from `window.__attrib`.
2. Inject it as query params in the iframe's `src` BEFORE the iframe loads (MutationObserver `addedNodes`).
3. Set all own cookies as `SameSite=Lax; Secure; Path=/` to maximize cross-tab survival.

`SameSite=None` only when truly required for cross-site embedding, and always paired with `Secure`. Otherwise Chrome rejects.

## localStorage quota / private mode

`localStorage.setItem` throws when:

- Quota full (~5MB across all keys).
- Safari private mode (quota = 0 on iOS < 11, sometimes still on exotic browsers).
- Storage disabled by user/extension.

Always wrap. Fallback chain:

1. localStorage → sessionStorage.
2. sessionStorage → cookie.
3. Cookie → URL-only (worst case, attribution dies on tab close).

This is the same try/catch envelope used in `writeAttrib` (see click-tracking-spec.md).
