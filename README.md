# 90plus-page-cf-worker

A Claude Code / Claude Agent skill that diagnoses and fixes **low Meta Ads connect rate** (Landing Page View / Link Click) on **Cloudflare Workers** — Vite+React, HTML+JS, quizzes, landing pages, and A/B redirect routers.

Target: **connect rate >= 90%** by getting `fbevents.js` Started at <= 2.500ms on 4G mobile.

Sister skill to [`90plus-elementor-page`](https://github.com/emanuelcardosorodrigues/90plus-elementor-page) (WordPress + Elementor). Same outcome, different stack.

## Worker SEMPRE, Pages NUNCA

This skill encodes one absolute rule for Cloudflare deployments: **use Workers, not Pages.** Pages exists for three narrow exceptions (third-party-managed deploys, PR preview QA, fully static institutional sites). Everything else — landings, quizzes, dashboards, A/B routers, SSR apps — goes on a Worker.

The decision tree, exceptions, and trigger-phrase list live in [`references/worker-vs-pages-decision.md`](references/worker-vs-pages-decision.md).

## Why this skill exists

Three recurring problems on Cloudflare Worker-served pages:

1. **Connect rate plateaus below 80%** even after Lighthouse scores 95+. The root cause is almost always `fbevents.js` Started at > 4.000ms — invisible to PageSpeed.
2. **Pre-hydration clicks are lost** to the gap between HTML parse and JS hydration. SPAs are particularly bad: 200-2000ms window where the page looks interactive but the click listener is not attached yet.
3. **Click tracking is inconsistent.** Every project bolts a different listener spec, missing fields (`click_target_kind`, `event_id`), no PII guard, no consent gate. Downstream Tag Manager configs break silently.

This skill ships a universal listener spec + drop-in tracker, a 9-cause diagnostic map, and the edge cache / preconnect / pending-shim patterns that close the gap.

## What's in v1.0.0

- **Universal click tracker** (`assets/click-tracker-global.js`) — delegated capture-phase listener, PII guard, consent gate, SPA virtual pageview, anti-double-fire, storage fallbacks, debug mode, SemVer.
- **UTM propagator** (`assets/utm-propagator.js`) — MutationObserver-based UTM/gclid/fbclid propagation with cross-origin iframe safety, cookie 4KB truncation, ITP-aware fallbacks.
- **9-cause diagnostic map** — sintoma → causa raiz → fix → como validar.
- **Optional server-side CAPI proxy** (`assets/capi-proxy-snippet.ts`) — defense against adblockers and ITP. Same-event-id dedup with client-side Pixel.
- **Worker templates** — `wrangler.jsonc`, edge cache with `arrayBuffer()` pattern, CSP nonce snippet, `_headers` for static assets, Vite `index.html` with correct head ordering.
- **Validation checklist** — 11 items including bot filtering, consent smoke, SPA navigation smoke, `*.workers.dev` allowlist caveats.

## Install

Clone into your `~/.claude/skills/` directory:

```bash
git clone https://github.com/emanuelcardosorodrigues/90plus-page-cf-worker.git ~/.claude/skills/90plus-page-cf-worker
```

Claude Code (or Claude Agent SDK) auto-discovers skills in `~/.claude/skills/`. Restart your Claude session and the skill registers as `90plus-page-cf-worker`.

## How to invoke

The skill triggers automatically on phrases like:

- "connect rate baixa", "Meta Ads connect rate", "landing page views low"
- "Pixel dispara tarde", "fbevents.js slow"
- "Worker lento", "Cloudflare landing devagar"
- "vou criar projeto Pages" (urgent redirect to Workers)
- "cliques sumindo", "UTMs perdem", "gclid não propaga"

Or invoke explicitly: `/90plus-page-cf-worker connect rate is 65%`.

## File layout

```
90plus-page-cf-worker/
├── SKILL.md                          # main entry, frontmatter + workflow
├── README.md                         # this file
├── LICENSE                           # MIT
├── references/
│   ├── worker-vs-pages-decision.md   # the absolute rule
│   ├── causes-map.md                 # 9 causes diagnosed
│   ├── click-tracking-spec.md        # universal listener spec
│   ├── utm-propagation-spec.md       # attribution propagation
│   ├── validation-checklist.md       # 11-item post-change check
│   └── gotchas.md                    # 13 traps
└── assets/
    ├── click-tracker-global.js       # drop-in tracker (v1.0.0)
    ├── utm-propagator.js             # drop-in propagator
    ├── preconnect-head.html          # <head> preconnect block
    ├── pending-shim.html             # pre-hydration click queue
    ├── worker-edge-cache-snippet.ts  # cache.match + arrayBuffer pattern
    ├── capi-proxy-snippet.ts         # server-side CAPI (optional)
    ├── vite-index-template.html      # Vite index.html with correct head order
    ├── wrangler-template.jsonc       # minimal wrangler.jsonc
    └── _headers.template             # Cache-Control rules
```

## Diagnosis flow (4 layers + 1 parallel)

The skill diagnoses connect rate issues by running these in order:

1. **PageSpeed Insights mobile** — identify render-blocking work.
2. **DevTools Network** in production with Fast 4G throttle — measure `fbevents.js` Started at.
3. **Meta Test Events** on a real 4G mobile device — verify PageView arrives in < 5s.
4. **Meta Ads Manager** over 24-48h — compute Landing Page View / Link Click ratio.

Parallel: **`wrangler tail`** during steps 2-3 to catch middleware ordering bugs, redirect chains, and unexpected 500s.

## Application order

When fixing, apply changes in this order. Each step is safe to apply independently:

1. Preconnect block in `<head>`.
2. GTM inline in `index.html` (not in the React bundle).
3. `__pending` shim before tracker.
4. Click tracker + UTM propagator.
5. `cache.match` + `arrayBuffer()` pattern in the Worker.
6. `_headers` template for `Cache-Control: immutable` on `/assets/*`.
7. CAPI proxy endpoint (optional — only if (1)-(6) don't lift connect rate above 80%).

## What this skill does NOT cover

- KV/D1/Vectorize schema design.
- Authentication flows (cookies, JWT, sessions).
- Cloudflare Pages Functions — use Workers instead.
- Image optimization beyond `Cache-Control`.
- Next.js + OpenNext in a Worker — different boot model; warrants a separate skill.
- CDN/DNS setup, mTLS, Argo, Smart Routing.

## License

MIT — see [LICENSE](LICENSE).

## Related

- [90plus-elementor-page](https://github.com/emanuelcardosorodrigues/90plus-elementor-page) — sister skill for WordPress + Elementor with WP Rocket / Perfmatters.
