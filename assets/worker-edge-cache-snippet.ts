/**
 * Edge cache snippet for Cloudflare Workers.
 *
 * Why this snippet exists: the most common Worker bug we see is mutating a
 * cached `Response` without materializing its body first. The body of a
 * `Response` returned by `cache.match` is a `ReadableStream` that can be read
 * exactly once — read it, and the next consumer gets an empty body.
 *
 * Pattern:
 *   1. cache.match
 *   2. clone OR arrayBuffer
 *   3. mutate headers on a fresh Response
 *   4. cache.put the original (or skip if you don't need to update)
 *
 * Drop this into your Worker and adapt the cache key and personalization to
 * your route table. Do NOT version the API token — use `wrangler secret put`.
 */

import type { ExecutionContext } from '@cloudflare/workers-types';

interface Env {
  // Add bindings here as your Worker grows (KV, D1, R2, etc.)
  // EXAMPLE_KV: KVNamespace;
}

/**
 * Generate a per-request CSP nonce. The same nonce is injected into the
 * Content-Security-Policy header AND into every inline <script nonce="..."> tag.
 *
 * Use only if you ship strict CSP. If your CSP allows 'unsafe-inline', skip.
 */
function cspNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '');
}

/**
 * Build a cache key. Include in the key ANY dimension that affects the body.
 * Examples: A/B variant, user country, accept-language.
 *
 * DO NOT include user-identity (cookies, JWT) in the key — that defeats edge
 * cache. Personalize via response headers + client-side reads instead.
 */
function buildCacheKey(request: Request, variant: string): Request {
  const url = new URL(request.url);
  url.searchParams.set('_v', variant);
  return new Request(url.toString(), request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Skip caching for non-GET requests
    if (request.method !== 'GET') {
      return fetch(request);
    }

    // Determine the variant for this request (A/B, country, etc.)
    // Replace this with your real assignment logic.
    const variant = url.searchParams.get('pv') ?? 'default';

    const cacheKey = buildCacheKey(request, variant);
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) {
      // CRITICAL: materialize the body before mutating headers.
      const buf = await cached.arrayBuffer();
      const headers = new Headers(cached.headers);
      headers.set('x-cache-tier', 'edge-hit');
      return new Response(buf, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }

    // Cache miss — fetch origin or assets binding
    const origin = await fetch(request);

    // Clone before consuming the body, so we can both return AND cache.
    const buf = await origin.arrayBuffer();
    const headers = new Headers(origin.headers);

    // Inject CSP with per-request nonce (optional; remove if your CSP is loose)
    const nonce = cspNonce();
    headers.set(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com https://connect.facebook.net; img-src * data:; style-src 'self' 'unsafe-inline'; connect-src *`
    );

    // Mark cache tier
    headers.set('x-cache-tier', 'origin');
    // Allow short TTL on HTML; longer on assets (handled by _headers or routes)
    headers.set('Cache-Control', 'public, max-age=60, s-maxage=86400');

    const response = new Response(buf, {
      status: origin.status,
      statusText: origin.statusText,
      headers,
    });

    // Put a clone in the cache; never put the original or its body is consumed.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  },
};
