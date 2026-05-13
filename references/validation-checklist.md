# Validation Checklist — Post-Change

Run every item AFTER every cause fix. Skipping items here is how a fix that "looked right" ships with a regression.

The shortest useful subset (smoke test in 60 seconds):

- `wrangler dev` local + DevTools Fast 4G → `fbevents.js` Started at ≤ 2.500ms.
- Click any CTA → `dataLayer` push with full payload (`click_id`, `click_classes`, ..., `event_id`).
- Click inside an `<input>` → **no push** (PII guard).
- DevTools Console → `window.__pending.length === 0` after 2 seconds.

If you have 10 minutes, run all 11 items below.

---

## 1. `wrangler dev` locally

```bash
wrangler dev
```

Open DevTools → Network → throttle to **Fast 4G** → reload. Find `fbevents.js`. The "Started at" column should be ≤ 2.500ms. If it's higher locally, it's higher in production (production has TLS + edge routing + CDN, not all subtractive).

## 2. `wrangler tail` in production

```bash
wrangler tail your-worker-name --format=pretty
```

Open the production URL on a real mobile device. The tail should print:

- One GET for the HTML document.
- A handful of GETs for `/assets/*` with `cf-cache-status: HIT`.
- Zero 500/502 responses.
- Zero `console.log` you don't recognize (debug code left in production).

## 3. PageSpeed Insights (mobile)

URL: https://pagespeed.web.dev/

Run mobile only. Targets:

- Performance score ≥ 85.
- LCP ≤ 2,5s.
- TBT ≤ 200ms.
- CLS ≤ 0,1.

If any metric regresses vs. baseline, revert the last change and investigate.

## 4. DevTools Network in production

Open the production URL in **incognito**, Fast 4G throttle, Disable cache. Verify:

- Every `/assets/*` returns `cf-cache-status: HIT` (after the second visit).
- Zero redirect chains for the document itself.
- `fbevents.js` request fires within the first 2 seconds of page load.

## 5. Meta Test Events on real 4G mobile

**Not Wi-Fi.** Wi-Fi residential is 5-50x faster than 4G mobile. A page that fires PageView in 1s on Wi-Fi may take 8s on actual 4G in the field.

Open `business.facebook.com → Events Manager → [Pixel] → Test Events`. Add a code if not yet configured. Open the page from a real phone on cellular data. Expected: PageView event arrives in < 5s. If never: cause (h) CAPI is needed.

## 6. Click tracking smoke

DevTools Console:

```js
dataLayer
```

Click a CTA button. A new entry should appear with:

```js
{
  event: 'click',
  click_id: '...',
  click_classes: '...',
  click_text: '...',
  click_href: '...',
  click_target_kind: 'cta-...',
  page_slug: '...',
  event_id: 'uuid',
  ts: 1234567890
}
```

**PII guard smoke.** Click inside an `<input type="text">`. No new entry should appear. If one appears, the PII guard is not wired — re-check the tracker boot order.

**SPA navigation smoke.** If the page is a SPA: navigate to a different route (clicking a `<Link>` or programmatically). A `virtual_pageview` event should appear with the new path.

## 7. UTM propagation smoke + race condition

Open a fresh tab. Paste:

```
https://yoursite.com/?gclid=TEST123&utm_source=foo&utm_campaign=bar
```

In DevTools Console, look at the FIRST `dataLayer` push (usually the GTM `gtm.js` event, then `pageview`). The first content event MUST have `gclid: 'TEST123'`. If it doesn't, the source resolver is running asynchronously — fix the boot order in the tracker.

Then click an external checkout link. The href on the click event should preserve `gclid=TEST123`.

## 8. Test events on `*.workers.dev` preview domain

If you deploy a preview to `your-worker.workers.dev`:

- Many Pixel setups have a domain allowlist that rejects `*.workers.dev`.
- Match Quality in Test Events may show "Unidentified" or "Limited".
- This is NOT a tracker bug. Always validate on the custom production domain before declaring success.

## 9. Bot filtering before comparing connect rate

Connect rate = LandingPageView / LinkClick.

- Meta Ads filters bots by default (Quality Filter).
- Cloudflare Analytics does NOT filter bots — raw request counts.

Comparing the two raw can show 15-25% discrepancy that is just bots. Filter Cloudflare-side via:

```
cf.botManagement.verifiedBot === true → drop
```

Or in dashboards, subtract `Cloudflare Bot Score < 30` traffic from the denominator.

For a baseline read: run a campaign for 24h to a 404 path → 100% of that traffic is bots → calibrate the bot share for the geo/audience.

## 10. Consent smoke (LGPD/GDPR contexts)

If the site has a CMP:

- Open the page → "Reject" the cookie banner → click CTA → confirm `dataLayer` push does NOT happen.
- Reload → "Accept" the cookie banner → confirm the deferred event drains from `window.__pendingConsent` into `dataLayer`.

If `window.__cfg.consentBypass = true` (B2B/implied consent), skip this section but document why.

## 11. Cloudflare Analytics + Meta Ads Manager (delayed)

These metrics need time to accumulate:

- **Cloudflare Analytics** (1-2h after deploy): cache hit ratio ≥ 80% on routes that should be cached. If lower, recheck cause (e) and the `_headers` file.
- **Meta Ads Manager** (48-72h): connect rate ≥ 90% in the campaign's "Landing Page View / Link Click" column. This is the final verdict. PageSpeed scores and DevTools are intermediate signals; this is the outcome.

If 72h after the fixes connect rate is still below 80%, escalate to cause (h) CAPI + cause (i) sGTM.
