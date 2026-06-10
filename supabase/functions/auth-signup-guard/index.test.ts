/**
 * auth-signup-guard tests — captcha gating + per-IP rate limit math.
 *
 * Ref: T-205, spec §9.1 captcha
 * Date: 2026-06-10
 *
 * Exercises the captcha shared helpers and the in-handler ip_rate counter
 * with stubs for fetch (hCaptcha verify endpoint) and the Supabase client
 * (`rate_limit_buckets`). The handler itself is integration-tested once the
 * Supabase test harness lands (deferred — plan T-226).
 *
 * Run via `deno task test` from repo root.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  captchaEnabled,
  extractClientIp,
  HCAPTCHA_ENABLED_ENV,
  HCAPTCHA_SECRET_ENV,
  type HCaptchaApiResponse,
  verifyCaptcha,
} from '../_shared/captcha.ts';
import {
  countAndIncrementIp,
  IP_RATE_RESOURCE_SIGNUP,
  IP_RATE_SIGNUP_LIMIT,
  IP_RATE_WINDOW_MINUTES,
  ipRateKey,
  peekIpRate,
} from '../_shared/ip_rate.ts';

// ---------------------------------------------------------------------------
// Constants (lock the spec)
// ---------------------------------------------------------------------------

Deno.test('spec constants: signup 5/h, reset 10/h, window 60min', () => {
  assertEquals(IP_RATE_SIGNUP_LIMIT, 5);
  assertEquals(IP_RATE_WINDOW_MINUTES, 60);
  assertEquals(IP_RATE_RESOURCE_SIGNUP, 'auth_signup');
});

Deno.test('ipRateKey produces deterministic key', () => {
  assertEquals(ipRateKey('1.2.3.4'), 'ip:1.2.3.4');
  assertEquals(ipRateKey('unknown'), 'ip:unknown');
});

// ---------------------------------------------------------------------------
// extractClientIp — header precedence
// ---------------------------------------------------------------------------

Deno.test('extractClientIp honors x-forwarded-for first hop', () => {
  const req = new Request('https://x', {
    headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.1' },
  });
  assertEquals(extractClientIp(req), '203.0.113.42');
});

Deno.test('extractClientIp falls back to x-real-ip', () => {
  const req = new Request('https://x', {
    headers: { 'x-real-ip': '198.51.100.7' },
  });
  assertEquals(extractClientIp(req), '198.51.100.7');
});

Deno.test('extractClientIp falls back to cf-connecting-ip', () => {
  const req = new Request('https://x', {
    headers: { 'cf-connecting-ip': '192.0.2.55' },
  });
  assertEquals(extractClientIp(req), '192.0.2.55');
});

Deno.test('extractClientIp returns "unknown" when no header present', () => {
  const req = new Request('https://x');
  assertEquals(extractClientIp(req), 'unknown');
});

// ---------------------------------------------------------------------------
// captchaEnabled — env flag parsing
// ---------------------------------------------------------------------------

Deno.test('captchaEnabled defaults to true in absence of env', () => {
  assertEquals(captchaEnabled(() => undefined), true);
});

Deno.test('captchaEnabled returns false when explicitly disabled', () => {
  const env = (k: string) => (k === HCAPTCHA_ENABLED_ENV ? 'false' : undefined);
  assertEquals(captchaEnabled(env), false);
});

Deno.test('captchaEnabled accepts 1/true/yes synonyms', () => {
  for (const v of ['true', 'TRUE', '1', 'yes']) {
    const env = (k: string) => (k === HCAPTCHA_ENABLED_ENV ? v : undefined);
    assertEquals(captchaEnabled(env), true, `expected '${v}' to be truthy`);
  }
});

// ---------------------------------------------------------------------------
// verifyCaptcha — bypass + happy path + failure modes
// ---------------------------------------------------------------------------

Deno.test('verifyCaptcha bypasses when env flag is off', async () => {
  const result = await verifyCaptcha('any-token', '1.2.3.4', {
    getEnv: (k) => (k === HCAPTCHA_ENABLED_ENV ? 'false' : undefined),
    fetchFn: () => Promise.reject(new Error('should not be called')),
  });
  assert(result.ok);
  if (result.ok) assertEquals(result.bypassed, true);
});

Deno.test('verifyCaptcha rejects missing token', async () => {
  const result = await verifyCaptcha(null, '1.2.3.4', {
    getEnv: (k) => (k === HCAPTCHA_SECRET_ENV ? 'sek' : 'true'),
    fetchFn: () => Promise.reject(new Error('should not be called')),
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, 'missing_token');
});

Deno.test('verifyCaptcha rejects when server secret unset', async () => {
  const result = await verifyCaptcha('token', '1.2.3.4', {
    getEnv: () => undefined,
    fetchFn: () => Promise.reject(new Error('should not be called')),
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, 'missing_secret');
});

Deno.test('verifyCaptcha returns ok on hCaptcha success', async () => {
  let calledWith: { url: string; body: string } | null = null;
  const fakeResp: HCaptchaApiResponse = { success: true };
  const env = (k: string) =>
    k === HCAPTCHA_SECRET_ENV ? 'shh-secret' : k === HCAPTCHA_ENABLED_ENV ? 'true' : undefined;

  const result = await verifyCaptcha('client-token', '1.2.3.4', {
    getEnv: env,
    fetchFn: (url, init) => {
      calledWith = { url, body: (init?.body as URLSearchParams).toString() };
      return Promise.resolve(
        new Response(JSON.stringify(fakeResp), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });

  assert(result.ok);
  if (result.ok) assertEquals(result.bypassed, false);
  assert(calledWith, 'siteverify must be called');
  const called = calledWith as NonNullable<typeof calledWith>;
  assertEquals(called.url, 'https://api.hcaptcha.com/siteverify');
  assert(called.body.includes('secret=shh-secret'));
  assert(called.body.includes('response=client-token'));
  assert(called.body.includes('remoteip=1.2.3.4'));
});

Deno.test('verifyCaptcha returns rejected on hCaptcha failure with codes', async () => {
  const fakeResp: HCaptchaApiResponse = {
    success: false,
    'error-codes': ['invalid-input-response'],
  };
  const env = (k: string) =>
    k === HCAPTCHA_SECRET_ENV ? 'sek' : k === HCAPTCHA_ENABLED_ENV ? 'true' : undefined;

  const result = await verifyCaptcha('bad-token', '1.2.3.4', {
    getEnv: env,
    fetchFn: () =>
      Promise.resolve(
        new Response(JSON.stringify(fakeResp), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
  assert(!result.ok);
  if (!result.ok) {
    assertEquals(result.reason, 'rejected');
    assertEquals(result.codes, ['invalid-input-response']);
  }
});

Deno.test('verifyCaptcha returns network_error on fetch throw', async () => {
  const env = (k: string) =>
    k === HCAPTCHA_SECRET_ENV ? 'sek' : k === HCAPTCHA_ENABLED_ENV ? 'true' : undefined;

  const result = await verifyCaptcha('token', '1.2.3.4', {
    getEnv: env,
    fetchFn: () => Promise.reject(new Error('boom')),
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, 'network_error');
});

Deno.test('verifyCaptcha returns network_error on non-2xx', async () => {
  const env = (k: string) =>
    k === HCAPTCHA_SECRET_ENV ? 'sek' : k === HCAPTCHA_ENABLED_ENV ? 'true' : undefined;
  const result = await verifyCaptcha('token', '1.2.3.4', {
    getEnv: env,
    fetchFn: () => Promise.resolve(new Response('oops', { status: 502 })),
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, 'network_error');
});

// ---------------------------------------------------------------------------
// countAndIncrementIp — per-IP rate counting flow
// ---------------------------------------------------------------------------

type Row = {
  resource_type: string;
  resource_key: string;
  window_start: string;
  window_size: string;
  count: number;
};

class FakeRateLimitTable {
  rows: Row[] = [];
  upsert(row: Row) {
    const i = this.rows.findIndex(
      (r) =>
        r.resource_type === row.resource_type
        && r.resource_key === row.resource_key
        && r.window_start === row.window_start
        && r.window_size === row.window_size,
    );
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
  }
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(table: FakeRateLimitTable): any {
  return {
    from(_t: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let pendingUpsert: Row | null = null;
      const builder = {
        select(_c: string) {
          return builder;
        },
        eq(col: keyof Row, val: unknown) {
          filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === val);
          return builder;
        },
        maybeSingle() {
          const m = table.rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: m[0] ?? null, error: null });
        },
        upsert(row: Row, _o: unknown) {
          pendingUpsert = row;
          return {
            then: (resolve: (v: { data: null; error: null }) => unknown) => {
              if (pendingUpsert) table.upsert(pendingUpsert);
              return resolve({ data: null, error: null });
            },
          };
        },
      };
      return builder;
    },
  };
}

Deno.test('countAndIncrementIp: first call yields count=1 under limit', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const now = new Date('2026-06-10T10:00:00.000Z');
  const r = await countAndIncrementIp(
    '1.2.3.4',
    IP_RATE_RESOURCE_SIGNUP,
    IP_RATE_SIGNUP_LIMIT,
    now,
    client,
  );
  assertEquals(r.count, 1);
  assertEquals(r.over_limit, false);
});

Deno.test('countAndIncrementIp: 6th signup attempt within 60min trips over_limit', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const now = new Date('2026-06-10T10:00:00.000Z');
  for (let i = 1; i <= 5; i++) {
    const r = await countAndIncrementIp(
      '1.2.3.4',
      IP_RATE_RESOURCE_SIGNUP,
      IP_RATE_SIGNUP_LIMIT,
      now,
      client,
    );
    assertEquals(r.count, i);
    assertEquals(r.over_limit, false, `attempt ${i} must NOT be over limit`);
  }
  const sixth = await countAndIncrementIp(
    '1.2.3.4',
    IP_RATE_RESOURCE_SIGNUP,
    IP_RATE_SIGNUP_LIMIT,
    now,
    client,
  );
  assertEquals(sixth.count, 6);
  assertEquals(sixth.over_limit, true);
});

Deno.test('countAndIncrementIp: window roll-over resets the counter', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const t0 = new Date('2026-06-10T10:00:00.000Z');
  for (let i = 0; i < 5; i++) {
    await countAndIncrementIp('1.2.3.4', IP_RATE_RESOURCE_SIGNUP, 5, t0, client);
  }
  // jump beyond 60min to land in the next bucket
  const t61 = new Date(t0.getTime() + 61 * 60_000);
  const next = await countAndIncrementIp(
    '1.2.3.4',
    IP_RATE_RESOURCE_SIGNUP,
    5,
    t61,
    client,
  );
  assertEquals(next.count, 1, 'new window must start at 1');
  assertEquals(next.over_limit, false);
});

Deno.test('peekIpRate returns 0 for an unseen IP', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const c = await peekIpRate(
    '9.9.9.9',
    IP_RATE_RESOURCE_SIGNUP,
    new Date('2026-06-10T10:00:00.000Z'),
    client,
  );
  assertEquals(c, 0);
});
