# Gotchas — 13 Traps That Bite Most

Ordered roughly by how often they hit production. Read the top 5 before touching any Worker; the rest before a major refactor.

---

## 1. `cache.match` returns a locked body

`cache.match(request)` resolves to a `Response` whose body is a one-shot stream. Reading it once consumes it; the next consumer gets nothing.

**Fix.** Always materialize before mutating headers or returning:

```ts
const buf = await cached.arrayBuffer();
return new Response(buf, { headers: newHeaders, status: cached.status });
```

Full pattern in [`assets/worker-edge-cache-snippet.ts`](../assets/worker-edge-cache-snippet.ts).

## 2. Hono middleware ordering

In Hono (and similar router frameworks), middleware runs in registration order. Put CORS BEFORE cache:

```ts
app.use('*', cors());        // FIRST
app.use('*', cacheMiddleware()); // SECOND
```

If cache runs first and returns a 304 from a `cache.match`, the response goes back to the client without CORS headers — and the browser blocks it. Same logic for security headers, auth, anything that needs to be on every response.

## 3. Vite asset path must be absolute

Vite generates paths like `assets/index-AbC123.js` by default if `base` is not configured. Relative paths break on nested routes (`/funnel/step-2/` resolves `./assets/...` against the wrong base).

**Fix.** In `vite.config.ts`:

```ts
export default defineConfig({
  base: '/',
});
```

And in `index.html`, write `/assets/...`, never `./assets/...`.

## 4. Deploying to the wrong Worker

`wrangler deploy` reads `wrangler.jsonc > name`. If you switch projects locally and forget to switch back, you can publish project A's code over project B's deployment.

**Defense.**

```bash
wrangler whoami                  # confirm account
wrangler deployments list        # show last 5 deploys
cat wrangler.jsonc | grep '"name"'  # confirm target
```

Make this a habit before every `wrangler deploy` in production. This is the recurring Claude mistake the entire skill exists to prevent.

## 5. CSP strict mode rejects inline scripts without nonce

If you ship `Content-Security-Policy: script-src 'self'`, inline `<script>window.__pending=[]</script>` is rejected. The browser silently refuses to execute it. Symptom: `__pending` is never created, the tracker drains an empty queue, pre-hydration clicks are lost.

**Fix.** Generate a nonce per request in the Worker:

```ts
const nonce = crypto.randomUUID().slice(0, 12);
headers.set('Content-Security-Policy', `script-src 'self' 'nonce-${nonce}' ...`);
// Inject the same nonce into every inline <script> tag in the HTML.
```

Hash-based CSP (`'sha256-XXX'`) is a static alternative when the inline script content never changes.

## 6. `localStorage.setItem` throws on quota or private mode

Safari private mode (older versions) sets `localStorage` quota to 0. Some exotic browsers do the same. On quota full (~5MB across all keys), `setItem` throws `QuotaExceededError`.

**Fix.** Wrap every write in try/catch. Degrade to sessionStorage, then to cookie, then to URL-only. The tracker and propagator in this skill already do this — don't replace them with naive `localStorage.setItem` calls.

## 7. Bots inflate the connect rate denominator

Connect rate = LandingPageView / LinkClick. Meta Ads filters bots from LinkClick by default. Cloudflare Analytics does not. Raw comparison shows 15-25% gap that is just bots.

**Fix.** Either:

- Filter Cloudflare Analytics to `cf.botManagement.verifiedBot === false`.
- Or run a 24h campaign to a 404 path to calibrate the bot share for that geo/audience.

Without this, you'll chase a phantom 20-point gap that has nothing to do with Worker performance.

## 8. `*.workers.dev` rejected by Pixel allowlists

Meta Pixel and other tracking pixels often have a domain allowlist. Preview deploys at `your-worker.workers.dev` may show "Unidentified domain" in Test Events.

**Fix.** Always validate on the production custom domain, not on the preview URL. If you need preview events, configure the Pixel with the workers.dev domain explicitly OR use Meta's Test Event Code (`META_TEST_EVENT_CODE` env var).

## 9. Service Worker can cache `fbevents.js`

If the site registers a Service Worker with `cache-first` strategy, requests to `connect.facebook.net/en_US/fbevents.js` can be served from stale SW cache for days. Meta ships frequent updates; serving stale fbevents breaks new event types.

**Fix.** Exclude tracking hosts from the Service Worker scope. Or use `stale-while-revalidate` with a 1-hour `max-age` for third-party scripts.

```js
// In your SW
if (request.url.includes('connect.facebook.net') ||
    request.url.includes('googletagmanager.com')) {
  return fetch(request); // bypass cache entirely
}
```

## 10. CAPI dedup — never sum client + server events

When both `fbevents.js` and the CAPI proxy fire `Purchase` with the same `event_id`, Meta deduplicates and counts ONE conversion. In dashboards that aggregate `fb_pixel_purchase` (client) AND `purchase` (server-side) you would double-count.

**Rule.** Read only ONE of them — the client one if CAPI is opt-in fallback, the server one if you trust CAPI more. Never sum.

(This is the same gotcha from the WordPress sister skill; it applies the moment you ship CAPI.)

## 11. Cross-origin iframe `src` mutation throws SecurityError

If a Pixel/checkout iframe is already loaded and cross-origin, setting `iframe.src = ...` can throw `SecurityError` in some browsers.

**Fix.** Mutate `src` BEFORE the iframe enters the DOM (MutationObserver on `addedNodes`). Wrap any post-load mutation in try/catch. For already-loaded iframes that need an update, use `postMessage` if the iframe origin cooperates.

## 12. Redirect chain on `/r/*` routes

A fallback regex like `app.get('/r/*', handler)` can match more than intended. Fix the regex (`/r/[a-z0-9-]+`) AND watch `wrangler tail` for unexpected matches. See cause (f) in [causes-map.md](causes-map.md).

## 13. iOS Safari ITP clears `localStorage` after 7 days

Intelligent Tracking Prevention 2.3+ clears site data on third-party context after 7 days of no first-party interaction. Implication: long-tail re-engagement campaigns lose first-touch attribution stored in `localStorage`.

**Fix.** Server-side attribution via webhook (PURCHASE_APPROVED carries sck/slug from the URL, no client-side dependency). Or shorten the attribution window in dashboards to 7 days max for iOS Safari users.

There is no client-side workaround. Accept the limit and build server-side defenses.
