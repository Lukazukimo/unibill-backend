/**
 * captcha.test.ts — Deno unit tests for `_shared/captcha.ts`.
 *
 * Ref:  T-230 (consolidates tests for the T-205 helper), spec §9.1
 * Date: 2026-06-10
 *
 * Coverage:
 *   - captchaEnabled honours HCAPTCHA_ENABLED env (defaults to true)
 *   - verifyCaptcha bypasses when disabled
 *   - verifyCaptcha returns 'missing_token' / 'missing_secret'
 *   - verifyCaptcha returns ok when hCaptcha says success=true
 *   - verifyCaptcha returns 'rejected' with codes when success=false
 *   - verifyCaptcha returns 'network_error' on fetch throw
 *   - verifyCaptcha returns 'network_error' on non-2xx
 *   - extractClientIp prefers x-forwarded-for, then x-real-ip, then cf
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { makeRequest } from './_test_utils.ts';
import {
  captchaEnabled,
  extractClientIp,
  type FetchFn,
  HCAPTCHA_VERIFY_URL,
  verifyCaptcha,
} from './captcha.ts';

/** Env stub builder. */
function env(map: Record<string, string>): (k: string) => string | undefined {
  return (k) => map[k];
}

/** Fetch stub that returns a JSON body with the given status. */
function jsonFetch(body: unknown, status = 200): FetchFn {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

// ---------------------------------------------------------------------------
// captchaEnabled
// ---------------------------------------------------------------------------

Deno.test('captchaEnabled: default true', () => {
  assertEquals(captchaEnabled(env({})), true);
});

Deno.test('captchaEnabled: explicit false', () => {
  assertEquals(captchaEnabled(env({ HCAPTCHA_ENABLED: 'false' })), false);
});

Deno.test('captchaEnabled: accepts 1/yes/true (case-insensitive)', () => {
  assertEquals(captchaEnabled(env({ HCAPTCHA_ENABLED: '1' })), true);
  assertEquals(captchaEnabled(env({ HCAPTCHA_ENABLED: 'YES' })), true);
  assertEquals(captchaEnabled(env({ HCAPTCHA_ENABLED: 'True' })), true);
});

// ---------------------------------------------------------------------------
// verifyCaptcha — bypass + presence
// ---------------------------------------------------------------------------

Deno.test('verifyCaptcha: bypasses when disabled', async () => {
  const r = await verifyCaptcha('some-token', '1.2.3.4', {
    getEnv: env({ HCAPTCHA_ENABLED: 'false' }),
  });
  assertEquals(r, { ok: true, bypassed: true });
});

Deno.test('verifyCaptcha: missing_token when token empty', async () => {
  const r = await verifyCaptcha('', '1.2.3.4', {
    getEnv: env({ HCAPTCHA_SECRET: 'secret' }),
  });
  assertEquals(r, { ok: false, reason: 'missing_token' });
});

Deno.test('verifyCaptcha: missing_secret when env unset', async () => {
  const r = await verifyCaptcha('tok', '1.2.3.4', {
    getEnv: env({}),
  });
  assertEquals(r, { ok: false, reason: 'missing_secret' });
});

// ---------------------------------------------------------------------------
// verifyCaptcha — happy + rejection paths
// ---------------------------------------------------------------------------

Deno.test('verifyCaptcha: success=true → ok (not bypassed)', async () => {
  const r = await verifyCaptcha('tok', '1.2.3.4', {
    getEnv: env({ HCAPTCHA_SECRET: 'secret' }),
    fetchFn: jsonFetch({ success: true }),
  });
  assertEquals(r, { ok: true, bypassed: false });
});

Deno.test('verifyCaptcha: success=false → rejected with codes', async () => {
  const r = await verifyCaptcha('tok', '1.2.3.4', {
    getEnv: env({ HCAPTCHA_SECRET: 'secret' }),
    fetchFn: jsonFetch({ success: false, 'error-codes': ['invalid-input-response'] }),
  });
  assertEquals(r, {
    ok: false,
    reason: 'rejected',
    codes: ['invalid-input-response'],
  });
});

Deno.test('verifyCaptcha: throw from fetch → network_error', async () => {
  const r = await verifyCaptcha('tok', '1.2.3.4', {
    getEnv: env({ HCAPTCHA_SECRET: 'secret' }),
    fetchFn: () => Promise.reject(new Error('boom')),
  });
  assertEquals(r, { ok: false, reason: 'network_error' });
});

Deno.test('verifyCaptcha: non-2xx → network_error', async () => {
  const r = await verifyCaptcha('tok', '1.2.3.4', {
    getEnv: env({ HCAPTCHA_SECRET: 'secret' }),
    fetchFn: jsonFetch({}, 503),
  });
  assertEquals(r, { ok: false, reason: 'network_error' });
});

Deno.test('verifyCaptcha: POSTs to canonical URL', async () => {
  let observedUrl: string | null = null;
  const r = await verifyCaptcha('tok', '1.2.3.4', {
    getEnv: env({ HCAPTCHA_SECRET: 'secret' }),
    fetchFn: (url, _init) => {
      observedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ success: true })));
    },
  });
  assertEquals(r, { ok: true, bypassed: false });
  assertEquals(observedUrl, HCAPTCHA_VERIFY_URL);
});

// ---------------------------------------------------------------------------
// extractClientIp
// ---------------------------------------------------------------------------

Deno.test('extractClientIp: x-forwarded-for takes left-most entry', () => {
  const req = makeRequest('https://e.test/', {
    headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
  });
  assertEquals(extractClientIp(req), '1.1.1.1');
});

Deno.test('extractClientIp: falls back to x-real-ip', () => {
  const req = makeRequest('https://e.test/', { headers: { 'x-real-ip': '3.3.3.3' } });
  assertEquals(extractClientIp(req), '3.3.3.3');
});

Deno.test('extractClientIp: falls back to cf-connecting-ip', () => {
  const req = makeRequest('https://e.test/', { headers: { 'cf-connecting-ip': '4.4.4.4' } });
  assertEquals(extractClientIp(req), '4.4.4.4');
});

Deno.test('extractClientIp: returns "unknown" when no header present', () => {
  assertEquals(extractClientIp(makeRequest()), 'unknown');
});

// ---------------------------------------------------------------------------
// Smoke — assert the URL constant is the canonical hCaptcha endpoint
// ---------------------------------------------------------------------------

Deno.test('HCAPTCHA_VERIFY_URL points at api.hcaptcha.com', () => {
  assert(HCAPTCHA_VERIFY_URL.startsWith('https://api.hcaptcha.com/'));
});
