/**
 * Meta Conversions API (CAPI) proxy snippet for Cloudflare Workers.
 *
 * OPCIONAL. Apply this only after exhausting causes (a)-(g) in
 * references/causes-map.md. CAPI is the defense against adblockers and ITP that
 * block client-side `fbevents.js`.
 *
 * What it does:
 *   - Receives POST /api/capi from your client tracker with event payload.
 *   - Hashes PII server-side (SHA-256, lowercase + trim).
 *   - Forwards to Meta's Graph API with your server access token.
 *   - Uses the same `event_id` as the client-side Pixel event for dedup.
 *
 * What it does NOT do:
 *   - It does NOT replace `fbevents.js`. Keep both. Meta deduplicates by event_id.
 *   - It does NOT validate input rigorously. Add Zod / your validator of choice
 *     before shipping to production.
 *   - It does NOT handle retries. For high-volume conversions, push to a Queue.
 *
 * Setup (one time):
 *   wrangler secret put META_PIXEL_ID
 *   wrangler secret put META_CAPI_TOKEN
 *   # Optional: Meta Test Event code for debugging
 *   wrangler secret put META_TEST_EVENT_CODE
 *
 * Critical dedup note:
 *   `fb_pixel_purchase` (client) and `purchase` (server) with the same event_id
 *   are the SAME event. Do NOT sum them in dashboards. See feedback in
 *   90plus-page-cf-worker README.
 */

interface Env {
  META_PIXEL_ID: string;
  META_CAPI_TOKEN: string;
  META_TEST_EVENT_CODE?: string;
}

interface ClientPayload {
  event_name: string;
  event_id: string;
  event_time?: number; // unix seconds; defaults to now
  event_source_url?: string;
  user_data: {
    em?: string; // email — will be hashed
    ph?: string; // phone — will be hashed
    fn?: string; // first name — will be hashed
    ln?: string; // last name — will be hashed
    fbp?: string; // _fbp cookie — passthrough
    fbc?: string; // _fbc cookie — passthrough
    external_id?: string;
  };
  custom_data?: Record<string, unknown>;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashUserData(u: ClientPayload['user_data']) {
  const out: Record<string, string> = {};
  if (u.em) out.em = await sha256Hex(u.em);
  if (u.ph) out.ph = await sha256Hex(u.ph.replace(/\D/g, ''));
  if (u.fn) out.fn = await sha256Hex(u.fn);
  if (u.ln) out.ln = await sha256Hex(u.ln);
  if (u.external_id) out.external_id = await sha256Hex(u.external_id);
  if (u.fbp) out.fbp = u.fbp; // not hashed
  if (u.fbc) out.fbc = u.fbc; // not hashed
  return out;
}

export async function handleCapi(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let payload: ClientPayload;
  try {
    payload = await request.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  if (!payload.event_name || !payload.event_id || !payload.user_data) {
    return new Response('Missing required fields', { status: 400 });
  }

  const clientIp =
    request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';

  const hashedUserData = await hashUserData(payload.user_data);

  const event = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    event_time: payload.event_time ?? Math.floor(Date.now() / 1000),
    event_source_url: payload.event_source_url ?? request.headers.get('referer') ?? '',
    action_source: 'website',
    user_data: {
      ...hashedUserData,
      client_ip_address: clientIp,
      client_user_agent: userAgent,
    },
    custom_data: payload.custom_data ?? {},
  };

  const body: Record<string, unknown> = { data: [event] };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/v18.0/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Tracking failure must never break UX — always return 200 to the client,
    // log the upstream failure for observability.
    if (!res.ok) {
      console.log('[capi] upstream non-2xx', res.status, await res.text());
    }
  } catch (e) {
    console.log('[capi] fetch threw', e);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Example wiring (Hono or plain fetch handler):
 *
 *   import { handleCapi } from './capi-proxy-snippet';
 *
 *   export default {
 *     async fetch(req: Request, env: Env) {
 *       const url = new URL(req.url);
 *       if (url.pathname === '/api/capi') return handleCapi(req, env);
 *       // ... rest of routing
 *     }
 *   };
 */
