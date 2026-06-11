/**
 * auth-signup-guard — proxy in front of supabase.auth.signUp().
 *
 * Ref: T-205, spec §9.1 captcha + rate limits
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. parse + validate body { email, password, captcha_token? }
 *   2. per-IP rate limit (resource_type='auth_signup', window=60min, limit=5)
 *      - under threshold and NO captcha_token: forward straight to signUp()
 *      - over threshold: REQUIRE captcha — if missing → HTTP 429 captcha_required
 *      - if captcha_token present (any state): verify server-side before forwarding
 *   3. forward to supabase.auth.signUp() (anon client, server enforces creds)
 *      - on success: return the session payload
 *      - on failure: bubble the auth error code
 *
 * The Flutter client calls THIS endpoint instead of supabase.auth.signUp()
 * directly so the per-IP captcha policy is enforced server-side.
 */

import { createClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { extractClientIp, verifyCaptcha } from '../_shared/captcha.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import {
  countAndIncrementIp,
  IP_RATE_RESOURCE_SIGNUP,
  IP_RATE_SIGNUP_LIMIT,
  IP_RATE_WINDOW_MINUTES,
} from '../_shared/ip_rate.ts';

type SignupRequest = {
  email: string;
  password: string;
  captcha_token?: string | null;
};

function isSignupRequest(value: unknown): value is SignupRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.email === 'string' && typeof v.password === 'string' &&
    v.email.length > 0 && v.password.length > 0 &&
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

  if (!isSignupRequest(body)) {
    return jsonResponse(400, { error: 'invalid_body', detail: 'email + password required' });
  }

  const email = body.email.trim().toLowerCase();
  const ip = extractClientIp(req);
  const service = buildServiceClient();
  const now = new Date();

  // 1) per-IP rate limit gate — peek the bucket BEFORE forwarding, so we can
  //    decide whether captcha is required without burning a Supabase auth slot.
  const ipStatus = await countAndIncrementIp(
    ip,
    IP_RATE_RESOURCE_SIGNUP,
    IP_RATE_SIGNUP_LIMIT,
    now,
    service,
  );

  // 2) if the threshold was already crossed, captcha is MANDATORY
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
    // Under threshold but client volunteered a token — still verify so we never
    // accept arbitrary base64. Failures here are 429 (cheap to retry).
    const verdict = await verifyCaptcha(body.captcha_token, ip);
    if (!verdict.ok) {
      return jsonResponse(429, {
        error: 'captcha_invalid',
        captcha_reason: verdict.reason,
      });
    }
  }

  // 3) forward to Supabase Auth signUp (anon client — Supabase enforces creds)
  const anonClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { auth: { persistSession: false } },
  );

  const { data, error } = await anonClient.auth.signUp({
    email,
    password: body.password,
    options: {
      emailRedirectTo: Deno.env.get('UNIBILL_SIGNUP_REDIRECT_URL') ??
        'unibill://auth/callback',
    },
  });

  if (error) {
    // Surface generic shape — never leak internal Supabase error codes that
    // could be used to enumerate accounts. Map known weak-password errors.
    const code = error.code === 'weak_password' ? 'weak_password' : 'signup_failed';
    return jsonResponse(400, { error: code, message: error.message });
  }

  return jsonResponse(200, {
    user: data?.user ? { id: data.user.id, email: data.user.email } : null,
    session: data?.session
      ? {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        token_type: data.session.token_type,
      }
      : null,
    confirmation_required: data?.session == null,
  });
});

// Only auto-serve under Deno (not under `deno test`)
if (import.meta.main) {
  Deno.serve(handler);
}
