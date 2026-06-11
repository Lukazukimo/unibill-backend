/**
 * auth-reset-guard — proxy in front of supabase.auth.resetPasswordForEmail().
 *
 * Ref: T-205, spec §9.1 captcha + rate limits
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. parse + validate body { email, captcha_token? }
 *   2. per-IP rate limit (resource_type='auth_password_reset', 60min, limit=10)
 *      - under threshold and NO captcha_token: forward straight to reset call
 *      - over threshold: REQUIRE captcha — if missing → HTTP 429 captcha_required
 *      - if captcha_token present: verify server-side before forwarding
 *   3. forward to supabase.auth.resetPasswordForEmail()
 *
 * IMPORTANT: per spec §9.1 we MUST always return HTTP 200 (or 429 captcha)
 * regardless of whether the email exists in auth.users — never leak account
 * enumeration via differential responses. Supabase's underlying call returns
 * void/202 either way; we mirror that contract.
 */

import { createClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { extractClientIp, verifyCaptcha } from '../_shared/captcha.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import {
  countAndIncrementIp,
  IP_RATE_RESET_LIMIT,
  IP_RATE_RESOURCE_RESET,
  IP_RATE_WINDOW_MINUTES,
} from '../_shared/ip_rate.ts';

type ResetRequest = {
  email: string;
  captcha_token?: string | null;
};

function isResetRequest(value: unknown): value is ResetRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.email === 'string' && v.email.length > 0 &&
    (v.captcha_token === undefined || v.captcha_token === null ||
      typeof v.captcha_token === 'string');
}

function jsonResponse(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

export const handler = withCorrelation(async (_ctx, req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  if (!isResetRequest(body)) {
    return jsonResponse(400, { error: 'invalid_body', detail: 'email required' });
  }

  const email = body.email.trim().toLowerCase();
  const ip = extractClientIp(req);
  const service = buildServiceClient();
  const now = new Date();

  const ipStatus = await countAndIncrementIp(
    ip,
    IP_RATE_RESOURCE_RESET,
    IP_RATE_RESET_LIMIT,
    now,
    service,
  );

  if (ipStatus.over_limit) {
    if (!body.captcha_token) {
      return jsonResponse(429, {
        error: 'captcha_required',
        site_key_hint: 'HCAPTCHA_SITE_KEY',
        ip_count: ipStatus.count,
        window_minutes: IP_RATE_WINDOW_MINUTES,
      });
    }
    const verdict = await verifyCaptcha(body.captcha_token, ip);
    if (!verdict.ok) {
      return jsonResponse(429, {
        error: 'captcha_required',
        captcha_reason: verdict.reason,
        codes: 'codes' in verdict ? verdict.codes : undefined,
      });
    }
  } else if (body.captcha_token) {
    const verdict = await verifyCaptcha(body.captcha_token, ip);
    if (!verdict.ok) {
      return jsonResponse(429, {
        error: 'captcha_invalid',
        captcha_reason: verdict.reason,
      });
    }
  }

  // Forward to Supabase Auth — anon client. Per spec §9.1 we always respond
  // 200 regardless of provider outcome to avoid enumeration leaks.
  const anonClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { auth: { persistSession: false } },
  );

  try {
    await anonClient.auth.resetPasswordForEmail(email, {
      redirectTo: Deno.env.get('UNIBILL_RECOVERY_REDIRECT_URL') ??
        'unibill://auth/recovery',
    });
  } catch (_e) {
    // intentionally swallowed — we never leak whether the email exists
  }

  return jsonResponse(200, { sent: true });
});

if (import.meta.main) {
  Deno.serve(handler);
}
