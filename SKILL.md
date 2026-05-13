---
name: 90plus-page-cf-worker
description: Diagnose and fix low Meta Ads connect rate (landing page views per link click) on Cloudflare Workers — Vite+React, HTML+JS, quizzes, landing pages, A/B routers. Use when the user mentions low connect rate, Pixel firing late, slow Worker response, broken edge cache, missing click tracking, lost UTMs/gclid/fbclid, "should I use Pages?", or any "make this Cloudflare landing page faster" request. Encodes the absolute rule "Worker SEMPRE, Pages NUNCA" and the universal click tracker spec (capture every click with click_id, click_classes, click_text, click_href, click_target_kind, page_slug). Targets connect rate at or above 90 percent by shortening the path until `fbevents.js` Started at is at or below 2500 milliseconds on 4G mobile.
---

# 90plus-page-cf-worker — Connect Rate Optimization for Cloudflare Workers

Sister skill to `90plus-elementor-page`. Same outcome (connect rate >= 90%), different stack: Cloudflare Workers serving Vite+React, HTML+JS, quizzes, landing pages, and A/B redirect routers.

## Core premise

**Connect rate != Lighthouse score.** A page can score 95/100 on PageSpeed and still leak 30% of clicks if the Meta Pixel `PageView` event fires after the user bounces. The single observable that matters is the moment `fbevents.js` is reported as **Started at** in DevTools → Performance tab on a real 4G mobile device.

Target: **`fbevents.js` Started at <= 2.500ms** on 4G mobile. Below 2.500ms, connect rate climbs to >= 90% in 48-72h of Meta Ads delivery. Above 4.000ms, you bleed ad spend regardless of how fast the rest of the page feels.

## Regra absoluta: Worker SEMPRE, Pages NUNCA

> **If you reach for `wrangler pages deploy`, the Cloudflare dashboard "Create Pages project" button, or any Pages-specific workflow — STOP.**
>
> Workers are the default for every new and existing landing/quiz/page deployment on Cloudflare. Pages exists for legacy and edge cases only.

The full decision tree, exceptions, and trigger-phrase list live in [references/worker-vs-pages-decision.md](references/worker-vs-pages-decision.md). Load it before proposing any new deployment.

Why this rule exists:

1. Workers give you per-request middleware, edge cache personalization, KV/D1/Vectorize/Queues bindings, and a unified runtime. Pages cannot do this without the Pages Functions adapter — which is just Workers in a more restricted form.
2. Mixed Pages + Workers deployments fragment the routing surface, multiply DNS records, and produce silent redirect chains.
3. Pages has a slower iteration loop (deploy via git or dashboard) vs. Workers (`wrangler deploy` in seconds).

## When to invoke this skill

Trigger phrases (pt-BR and en):

- "connect rate baixa", "Meta Ads connect rate", "landing page views low"
- "Pixel dispara tarde", "fbevents.js slow", "PageView event missing"
- "Worker lento", "Cloudflare landing devagar", "TTFB alto no Cloudflare"
- "edge cache nao bate", "`cf-cache-status: MISS` em rota estatica"
- "cliques sumindo", "click tracking nao funciona", "primeiros cliques perdidos"
- "UTMs perdem", "gclid nao propaga", "fbclid nao chega no checkout"
- "vou criar projeto Pages", "deploy via dashboard Cloudflare", "`wrangler pages deploy`" — urgent: redirect to Workers
- "ordem do middleware Hono", "CORS depois de cache"

Common symptoms:

- Connect rate (Meta Ads "Landing Page View" / "Link Click") below 70%.
- `fbevents.js` Started at > 4.000ms on Chrome DevTools 4G throttle.
- Meta Events Manager shows PageView count diverging from `dataLayer.push('pageview')`.
- Cloudflare Analytics: cache hit ratio < 50% on routes that should be static.
- Browser console: `dataLayer is not defined` or clicks without `event_id`.

## Required inputs

Before diagnosing, collect:

1. **Page URL** in production (and a staging/preview URL if available).
2. **Pixel ID** and **GTM container ID** (placeholder `GTM-XXXXXXX` if redacted).
3. **Stack**: (a) Vite+React via Worker assets binding, (b) HTML+JS puro via Worker, (c) other (note it).
4. **Baseline measurements**:
   - PageSpeed Insights mobile report (URL + screenshot of Core Web Vitals).
   - DevTools → Performance tab → look for `fbevents.js` row → Started at value.
   - `wrangler tail <worker-name>` capture during a real visit (1-2 requests).
5. **Recent changes**: anything deployed in the last 7 days that touched routing, caching, or the Vite/HTML template.

If any input is missing, ask the user before guessing. Most "the Worker is slow" reports are actually GTM-in-bundle or middleware-order bugs that the user does not see.

## Diagnosis flow — 4 layers + 1 parallel

Run these in order. Don't skip layers; the bug is usually in the second one you check.

**Layer 1 — PageSpeed Insights (mobile).** Score < 85 in Performance, LCP > 2,5s, or TBT > 200ms means render-blocking work in the critical path. Lighthouse "Eliminate render-blocking resources" usually points at GTM-in-bundle or async font from a third domain.

**Layer 2 — DevTools Network (production, Fast 4G + Disable cache + incognito).** Look for:

- `fbevents.js` Started at value (the prime metric).
- `cf-cache-status` header on every static asset. Should be `HIT` on `/assets/*` and `/favicon.ico`. `MISS` or `BYPASS` here is the bug.
- Number of redirects before the HTML document. Should be 0 or 1. 2+ means a `/r/*` router is misfiring (see causes-map cause f).

**Layer 3 — Meta Test Events (real device).** Open `business.facebook.com → Events Manager → Pixel → Test Events`. Open the page on a mobile 4G device (not Wi-Fi — see validation-checklist). PageView should appear in < 5s. If it never appears, GTM is being blocked by an adblocker or CAPI is required (cause h).

**Layer 4 — Meta Ads Manager.** Compare "Landing Page View" vs "Link Click" over a 24-48h window. The ratio is the connect rate. Filter bots before computing — Meta Ads has a "Quality Filter" toggle; Cloudflare Analytics does not, so subtract `cf.botManagement.verifiedBot === true` traffic manually.

**Parallel — `wrangler tail`.** While running Layers 2 and 3, run `wrangler tail <worker-name> --format=pretty` and filter for the test path. Look for:

- Unexpected `console.log` (debug code left in production).
- 500/502 responses that the user does not see (cache served stale).
- Middleware ordering bugs (CORS after cache returns 304 without CORS).

## Cause map — 9 causes (summary)

Full table with sintoma -> causa raiz -> fix -> como validar lives in [references/causes-map.md](references/causes-map.md). Quick index:

- **(a)** Edge cache mutated without `arrayBuffer()` -> empty body.
- **(b)** Preconnect injected after GTM -> wasted DNS lookups.
- **(c)** Pixel initialized inside React bundle -> late `fbevents.js`.
- **(d)** `__pending` shim absent -> pre-hydration clicks lost.
- **(e)** Personalized HTML edge cache mis-modeled -> user A sees user B's data.
- **(f)** Duplicate redirect chain on `/r/*` routes -> 2-3 hops.
- **(g)** Click interceptor not bifurcated -> external checkout links lose attribution.
- **(h)** CAPI absent -> adblock/ITP blocks client-only events.
- **(i)** Adblockers blocking `connect.facebook.net` -> server-side GTM custom domain as workaround.

## Click tracking obrigatorio

Every Worker-served page MUST ship a global delegated click listener that captures **every clickable interaction** into the `dataLayer`. Payload, listener spec, PII guard, consent gate, SPA virtual pageview, and storage fallbacks are documented in [references/click-tracking-spec.md](references/click-tracking-spec.md). Drop-in implementation in [assets/click-tracker-global.js](assets/click-tracker-global.js).

Two rules that are non-negotiable:

1. **PII guard.** Handler must early-return if `event.target.closest('input, textarea, [contenteditable]')`. This prevents email/password/CPF from leaking into the `dataLayer`.
2. **Consent gate.** If your jurisdiction requires consent (LGPD, GDPR), the tracker reads `window.__consent` and queues events until granted. Use `window.__cfg.consentBypass = true` only in B2B contexts where consent is implied.

## UTM/gclid/fbclid propagation

Attribution params survive across:

- First-touch (immutable) -> `localStorage`.
- Cross-page (session) -> `sessionStorage`.
- Cross-domain (checkout) -> query string injection via `MutationObserver` on `<a>` and `<iframe>` elements.

Spec in [references/utm-propagation-spec.md](references/utm-propagation-spec.md), drop-in in [assets/utm-propagator.js](assets/utm-propagator.js).

## Application order

When fixing a slow Worker page, apply changes in this order:

1. **Preconnect block** in `<head>` (cheap, no risk). See [assets/preconnect-head.html](assets/preconnect-head.html).
2. **GTM inline in `index.html`**, not in the React bundle. See [assets/vite-index-template.html](assets/vite-index-template.html).
3. **`__pending` shim** before tracker boot. See [assets/pending-shim.html](assets/pending-shim.html).
4. **Click tracker + UTM propagator** loaded as `<script defer>` or imported at the top of `main.tsx`.
5. **Cache key + `arrayBuffer()` pattern** in the Worker. See [assets/worker-edge-cache-snippet.ts](assets/worker-edge-cache-snippet.ts).
6. **`_headers` template** for `Cache-Control: immutable` on `/assets/*`. See [assets/_headers.template](assets/_headers.template).
7. **CAPI proxy endpoint** (optional, only if causes a-g do not lift connect rate above 80%). See [assets/capi-proxy-snippet.ts](assets/capi-proxy-snippet.ts).

## After every change

Validate before declaring success. The full checklist (11 items including bot filtering, consent smoke, SPA navigation smoke) lives in [references/validation-checklist.md](references/validation-checklist.md). The shortest useful subset:

- `wrangler dev` locally, DevTools Fast 4G, confirm `fbevents.js` Started at <= 2.500ms.
- `wrangler tail` in production, real request, no unexpected logs.
- Meta Test Events on a real 4G mobile device, PageView <= 5s.
- DevTools Console: click any CTA -> `dataLayer` push with full payload.
- DevTools Console: click inside an `<input>` -> **no push** (PII guard working).

## How to deliver the work

1. **Establish baseline.** Capture PageSpeed score, DevTools Started at, `wrangler tail` snippet, Meta Test Events screenshot. Save them — you will reference these numbers in the closing report.
2. **Diagnose.** Run the 4 layers. Identify which causes (a-i) apply. Most pages have 2-3 simultaneous causes.
3. **Plan.** List the fixes in the application order above. Quote the asset path and the line/section you intend to copy.
4. **Apply.** Edit one cause at a time. After each cause, redeploy and re-measure. If a cause did not move the needle, revert and move on — don't pile fixes on top of an unresolved one.
5. **Re-validate.** Run the full validation checklist (not just the short subset) after the last fix.
6. **Report.** Closing message includes: causes applied, before/after Started at, before/after PageSpeed, expected connect rate in 48-72h, and a list of items the user must monitor in Meta Ads Manager.

## Bundled resources

References (load on demand):

- [references/worker-vs-pages-decision.md](references/worker-vs-pages-decision.md) — Worker vs Pages decision tree.
- [references/causes-map.md](references/causes-map.md) — 9 causes with sintoma/fix/validation.
- [references/click-tracking-spec.md](references/click-tracking-spec.md) — payload, listener, PII guard, consent gate, SPA virtual pageview, versioning.
- [references/utm-propagation-spec.md](references/utm-propagation-spec.md) — source resolver order, sck/slug patterns, iframe cross-origin, cookie size limits.
- [references/validation-checklist.md](references/validation-checklist.md) — 11-item post-change checklist.
- [references/gotchas.md](references/gotchas.md) — 13 traps including CSP nonce, bot filtering, `*.workers.dev` test events.

Assets (drop-in templates):

- [assets/click-tracker-global.js](assets/click-tracker-global.js) — universal delegated click tracker, version 1.0.0.
- [assets/utm-propagator.js](assets/utm-propagator.js) — MutationObserver UTM propagator with cookie/iframe safety.
- [assets/preconnect-head.html](assets/preconnect-head.html) — preconnect/dns-prefetch block.
- [assets/pending-shim.html](assets/pending-shim.html) — pre-hydration click queue.
- [assets/worker-edge-cache-snippet.ts](assets/worker-edge-cache-snippet.ts) — `cache.match` + `arrayBuffer()` pattern.
- [assets/capi-proxy-snippet.ts](assets/capi-proxy-snippet.ts) — server-side CAPI proxy (optional).
- [assets/vite-index-template.html](assets/vite-index-template.html) — Vite `index.html` with correct head ordering.
- [assets/wrangler-template.jsonc](assets/wrangler-template.jsonc) — minimal `wrangler.jsonc` with assets binding.
- [assets/_headers.template](assets/_headers.template) — Cache-Control rules for static assets.

## Critical gotchas (load gotchas.md)

The 8 traps that bite most often:

1. `cache.match` returns a `Response` with a locked body — must `await arrayBuffer()` before mutating headers.
2. Hono middleware ordering: CORS after cache returns 304 without CORS headers.
3. Vite asset path must be absolute (`/assets/...`), never relative — relative breaks on nested routes.
4. Deploying to the wrong Worker because `wrangler.jsonc > name` was not checked. The recurring Claude mistake this skill exists to prevent.
5. CSP strict mode rejects inline `<script>` without nonce/hash. Generate nonce per-request in the Worker.
6. `localStorage.setItem` throws in Safari private mode and on quota full — try/catch is mandatory.
7. Bots inflate the connect rate denominator — filter `cf.botManagement.verifiedBot` before comparing to Meta Ads.
8. `*.workers.dev` preview domains may be rejected by Pixel allowlists — always validate on the custom domain.

Full list in [references/gotchas.md](references/gotchas.md).

## What this skill does NOT cover

- **KV/D1/Vectorize schema design.** This skill assumes your data layer works; it optimizes the rendering and tracking layer.
- **Authentication flows.** Cookie/session/JWT auth is out of scope.
- **Cloudflare Pages Functions.** Use Workers (see worker-vs-pages-decision.md).
- **Image optimization beyond `Cache-Control`.** Use Cloudflare Images or a separate image pipeline.
- **Next.js + OpenNext in a Worker.** The boot model and cold-start dynamics differ enough to warrant a separate skill. Connect rate tactics here transfer in spirit but not in mechanics.
- **CDN/DNS setup**, custom domains, mTLS, Argo, Smart Routing — assume the network layer works.
