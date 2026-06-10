/**
 * auth-login-guard — proxy in front of supabase.auth.signInWithPassword().
 *
 * Ref: T-204, spec §9.1 Lockout
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. parse + validate body { email, password, captcha_token? }
 *   2. checkLockout(email) — if blocked, return HTTP 423 with retry_after
 *   3. forward credentials to supabase.auth.signInWithPassword()
 *      - on success: clearLockout(email), return the session payload
 *      - on failure: recordFailure(email)
 *          - if threshold crossed: send unlock email (Supabase recovery link)
 *            + emit domain_event 'auth.lockout.triggered', return HTTP 423
 *          - else: return HTTP 401
 *
 * The Flutter client calls THIS endpoint instead of
 * supabase.auth.signInWithPassword() directly, so the lockout policy is
 * enforced server-side and cannot be bypassed by changing devices.
 */

import { createClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { emitDomainEvent } from '../_shared/events.ts';
import {
  buildServiceClient,
  checkLockout,
  clearLockout,
  recordFailure,
} from '../_shared/lockout.ts';

type LoginRequest = {
  email: string;
  password: string;
};

function isLoginRequest(value: unknown): value is LoginRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.email === 'string' && typeof v.password === 'string'
    && v.email.length > 0 && v.password.length > 0;
}

function jsonResponse(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}

export const handler = withCorrelation(async (ctx, req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  if (!isLoginRequest(body)) {
    return jsonResponse(400, { error: 'invalid_body', detail: 'email + password required' });
  }

  const email = body.email.trim().toLowerCase();
  const service = buildServiceClient();
  const now = new Date();

  // 1) lockout gate
  const status = await checkLockout(email, now, service);
  if (status.kind === 'blocked') {
    return jsonResponse(
      423,
      {
        error: 'locked',
        retry_after: status.retry_after_seconds,
        block_started_at: status.block_started_at,
      },
      { 'retry-after': String(status.retry_after_seconds) },
    );
  }

  // 2) attempt the actual sign-in (anon client — Supabase Auth enforces creds)
  const anonClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { auth: { persistSession: false } },
  );

  const { data, error } = await anonClient.auth.signInWithPassword({
    email,
    password: body.password,
  });

  if (!error && data?.session) {
    // SUCCESS — reset both counter and any stale block bucket
    await clearLockout(email, service);
    return jsonResponse(200, {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: data.session.token_type,
      user: { id: data.user?.id, email: data.user?.email },
    });
  }

  // 3) FAILURE — record + maybe trip the lockout
  const result = await recordFailure(email, now, service);

  if (result.threshold_crossed) {
    // Fire unlock-link via Supabase recovery + emit domain event.
    // Both side-effects are best-effort: the 423 response is the contract.
    try {
      await anonClient.auth.resetPasswordForEmail(email, {
        redirectTo: Deno.env.get('UNIBILL_UNLOCK_REDIRECT_URL')
          ?? 'unibill://auth/recovery',
      });
    } catch (_e) {
      // do not leak provider errors back to caller
    }

    try {
      await emitDomainEvent({
        type: 'auth.lockout.triggered',
        aggregate_type: 'auth_login',
        // anonymized aggregate id — we do not have an auth.users uuid here
        // (the credential may be for an unknown email)
        aggregate_id: '00000000-0000-0000-0000-000000000000',
        correlation_id: ctx.correlation_id,
        actor_type: 'system',
        payload: {
          version: 1,
          data: {
            email_hash_prefix: email.slice(0, 2) + '***',
            fail_count: result.fail_count,
            window_minutes: 30,
            block_minutes: 60,
          },
        },
      });
    } catch (_e) {
      // event emission is best-effort — surface via logs once wired
    }

    return jsonResponse(
      423,
      {
        error: 'locked',
        retry_after: 60 * 60,
        unlock_email_sent: true,
      },
      { 'retry-after': String(60 * 60) },
    );
  }

  // Below threshold — generic 401 (do NOT leak how many attempts remain)
  return jsonResponse(401, { error: 'invalid_credentials' });
});

// Only auto-serve under Deno (not under `deno test`, which sets DENO_TEST=1)
if (import.meta.main) {
  Deno.serve(handler);
}
