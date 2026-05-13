# Causes Map — 9 Root Causes of Low Connect Rate on Cloudflare Workers

Each cause: **sintoma → causa raiz → fix → como validar**. Apply in the order listed in the SKILL.md "Application order" section, not in alphabetical order.

---

## (a) Edge cache mutated without `arrayBuffer()`

**Sintoma.** Page loads with empty body (white screen) on production, but works fine in `wrangler dev`. Or: random users report "página em branco" intermittently.

**Causa raiz.** `cache.match(request)` returns a `Response` whose body is a `ReadableStream` that can only be read once. If you do `new Response(cached.body, { headers: newHeaders })` and then `cache.put` it back, the body stream is consumed on the first response and the next reader gets empty.

**Fix.** Materialize the body before reuse:

```ts
const cached = await caches.default.match(request);
if (cached) {
  const buf = await cached.arrayBuffer();
  const headers = new Headers(cached.headers);
  headers.set('x-cache-tier', 'edge');
  return new Response(buf, { headers, status: cached.status });
}
```

Full snippet in [`assets/worker-edge-cache-snippet.ts`](../assets/worker-edge-cache-snippet.ts).

**Como validar.** Deploy the fix. Run `curl -I https://yoursite.com/some-cached-route` twice in a row. Both responses should have non-empty bodies. In production, watch `wrangler tail` for 500s on cached routes — should be zero.

---

## (b) Preconnect injected after GTM

**Sintoma.** PageSpeed reports "Preconnect to required origins" as a missed opportunity. DevTools Network shows DNS lookup for `connect.facebook.net` happening AFTER `gtm.js` already needs it.

**Causa raiz.** The Vite/HTML template puts the GTM `<script>` before the preconnect block, so by the time the browser parses the preconnect hint, it has already issued DNS for those domains.

**Fix.** Reorder `<head>` so preconnect/dns-prefetch come FIRST, then GTM. Use [`assets/preconnect-head.html`](../assets/preconnect-head.html) as the canonical ordering.

**Como validar.** DevTools Network → check `Connection Start` column for `fbevents.js` and `gtm.js`. Both should show < 50ms (DNS resolved before request). Re-run PageSpeed — "Preconnect" warning disappears.

---

## (c) Pixel initialized inside the React bundle

**Sintoma.** `fbevents.js` Started at > 4.000ms on DevTools 4G throttle. Connect rate below 60%. PageSpeed score 90+ but Meta says you're missing PageViews.

**Causa raiz.** The GTM/Pixel initialization is inside `useEffect(() => { ... }, [])` in the React root, OR loaded as a separate React component. This delays the script tag injection until after hydration, which on mobile 4G can be 4-8 seconds.

**Fix.** Move GTM inline into `index.html`, BEFORE `<div id="root">`:

```html
<head>
  <!-- preconnect block -->
  <!-- pending-shim -->
  <script>
    (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start': new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0], j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-XXXXXXX');
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
```

**Vite asset path note.** Always absolute — `/assets/...`, never `./assets/...`. Relative paths break on nested routes (`/foo/bar/`) because the browser resolves them against the current path.

Full template in [`assets/vite-index-template.html`](../assets/vite-index-template.html).

**Como validar.** DevTools Performance tab → record a fresh load → search for `fbevents.js` row. Started at should be < 2.500ms. Meta Test Events: PageView fires in < 5s on mobile 4G.

---

## (d) `__pending` shim absent — pre-hydration clicks lost

**Sintoma.** Users tap the CTA while React is still hydrating, the tap registers visually (button looks pressed) but no event reaches Meta or GTM. Drop in CTR vs LPV ratio.

**Causa raiz.** Between HTML parse and tracker boot, there is a 200-2.000ms window where the DOM is interactive but the click listener has not been attached. Users on slow phones often tap in this window.

**Fix.** Inline a tiny shim in `<head>` BEFORE the tracker script:

```html
<script>
  window.__pending = [];
  window.__pendingPush = function (payload) {
    window.__pending.push(payload);
  };
</script>
```

The tracker drains `window.__pending` at boot. See [`assets/pending-shim.html`](../assets/pending-shim.html) for the canonical version, and the click tracker's drain logic in [`assets/click-tracker-global.js`](../assets/click-tracker-global.js).

**Como validar.** Open DevTools, throttle to "Slow 3G", reload, click a button as soon as it's visible. Check `window.__pending` — should have your click. After a beat, `dataLayer` should have it too.

---

## (e) Personalized HTML edge cache mis-modeled

**Sintoma.** User A sees user B's name/data on the page. Or: cache hit but content is stale for personalized blocks.

**Causa raiz.** The Worker injects per-request data (user name, A/B variant, country) into the HTML body, then caches that response. The cache key does not include the personalization dimension, so the next user gets a HIT with the wrong body.

**Fix.** Cache the body identical for everyone. Personalize via:

- **HTTP headers** (e.g., `set-cookie: x-variant=B`).
- **Cookies set client-side** after reading from a small JSON endpoint.
- **Edge function that mutates only specific tokens** post-cache (advanced; rare).

If you must vary the body, include the variation in the cache key:

```ts
const cacheKey = new Request(`${request.url}?_v=${variant}`, request);
```

**Como validar.** Two browsers, two different cookies/users. Compare the HTML response. If you see user A's name in user B's HTML — cache leak.

---

## (f) Duplicate redirect chain on `/r/*` routes

**Sintoma.** Click on a CTA → 2-3 redirects before reaching the destination. Some users (especially on mobile) bounce during the redirect chain. Meta Pixel "Lead" or "InitiateCheckout" event never fires.

**Causa raiz.** The Worker has a fallback regex on `/r/*` that matches more paths than intended (e.g., `/r/.*` instead of `/r/[a-z0-9-]+`). The first match redirects to a normalized form, which then matches again with a different rule.

**Fix.** Tighten the regex:

```ts
const match = request.url.match(/\/r\/([a-z0-9-]+)$/);
if (!match) return next();
```

Or use a route table with exact paths instead of regex.

**Como validar.** `curl -I` the redirect URL. Should be a single 302/301 to the final destination. `wrangler tail` should show a single hit, not a chain.

---

## (g) Click interceptor not bifurcated

**Sintoma.** External checkout links (Hotmart, Stripe Checkout, etc.) lose UTM params. Sales come in with `utm_source=(none)`.

**Causa raiz.** A single click handler tries to apply UTMs to ALL links, including same-origin nav links — which causes loops or unintended mutations. The fix is to bifurcate by link type.

**Fix.** Use the `click_target_kind` from the universal tracker spec. Apply UTMs only to `external-checkout` links:

```js
if (kind === 'external-checkout') {
  applyAttributionTo(link.href);
}
// nav, internal, etc. — leave alone
```

The propagator in [`assets/utm-propagator.js`](../assets/utm-propagator.js) does this bifurcation by default.

**Como validar.** Click a checkout link with `?gclid=TEST` in the address bar. Confirm the destination URL preserves `gclid=TEST`.

---

## (h) CAPI absent — adblock/ITP blocks client-only events

**Sintoma.** Meta Events Manager shows PageView/Purchase with Match Quality "Limited" or "Poor". Connect rate stuck below 80% even after fixing causes (a)-(g).

**Causa raiz.** Adblockers (uBlock, Brave, Safari ITP) block `connect.facebook.net` and `fbevents.js`. Client-side events never reach Meta. iOS 14.5+ ATT also limits attribution windows.

**Fix.** Server-side Conversions API (CAPI) proxy through the Worker. The Worker receives event payloads from the tracker, hashes PII, and forwards to `graph.facebook.com/v18.0/{PIXEL_ID}/events` with a server token.

Full implementation in [`assets/capi-proxy-snippet.ts`](../assets/capi-proxy-snippet.ts).

**Critical dedup note.** When both client-side Pixel AND CAPI fire the same event with the same `event_id`, Meta deduplicates. **Never** sum `fb_pixel_purchase` + server-side `purchase` in dashboards — they are the same event seen twice.

**Como validar.** Activate CAPI. Wait 24-48h. Meta Events Manager → check Event Match Quality, should move from "Limited" to "Good" or better. Aggregate Event Measurement page count should rise.

---

## (i) Adblockers blocking `connect.facebook.net` — server-side GTM workaround

**Sintoma.** GTM Preview shows PageView firing, but it never appears in Events Manager. CAPI (cause h) reduces but does not eliminate the gap.

**Causa raiz.** Even with CAPI, the client-side leg of dedup needs to fire to maximize Match Quality. Adblockers that block `connect.facebook.net` also block `googletagmanager.com` — so the GTM container itself never loads.

**Fix.** Server-side GTM (sGTM) on a custom subdomain. Deploy a separate Worker at `sgtm.yourdomain.com` that proxies GTM. Now the GTM URL is `https://sgtm.yourdomain.com/gtm.js?id=GTM-XXXXXXX`, which adblockers don't block because the host is first-party.

This is the heavyweight workaround. CAPI alone covers 80% of the gap; sGTM closes the remaining 15-18%. The last 2-5% (users with manual host blocking) cannot be reached client-side at all.

**Como validar.** After sGTM deploy, run Meta Pixel Helper on a browser with uBlock active. PageView should fire. Compare connect rate before/after over 7 days — expect a 3-8 point bump.

---

## Notes on causes that did NOT make this list

- **Slow LCP from images.** LCP rarely correlates with connect rate. Fix it separately for SEO/CWV.
- **TBT from heavy JS.** Same — affects Lighthouse, not Pixel timing directly.
- **Next.js OpenNext cold start.** Out of scope for this skill. If on Next.js, see a separate skill or apply cause (e) with longer s-maxage.
