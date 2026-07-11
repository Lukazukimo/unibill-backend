/**
 * telemetry-ingest tests — method/auth gates, body validation (shape, batch
 * size, per-event byte cap), consent gate, per-user event rate limit, deep
 * redaction, and the insert shape.
 *
 * Ref:  T-513 (#85), spec §8.9 / Appendix E /telemetry/ingest, BR-018.
 *
 * Covered branches:
 *   - method gate (non-POST)                                → 405
 *   - JWT missing                                           → 401
 *   - invalid JSON                                          → 400 invalid_json
 *   - > 50 events / bad severity / missing field            → 422 validation_failed
 *   - event > 8 KB                                          → 413 payload_too_large
 *   - no active telemetry consent                           → 403 consent_required
 *   - over the per-user event limit                         → 429 rate_limited
 *   - happy path                                            → 200 { ingested } + rows persisted
 *   - payload deep-redacted before persistence
 *   - rate-limit increments by the batch size
 *   - insert error                                          → 500
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type HandlerDeps, type IngestResponse } from './index.ts';
import { fakeRateLimitConsume } from '../_shared/_test_utils.ts';

// ---------------------------------------------------------------------------
// Fake Supabase client — consent_log (select), rate_limit_buckets
// (select+upsert), client_telemetry (insert).
// ---------------------------------------------------------------------------

type ConsentRow = { user_id: string; purpose: string; revoked_at: string | null };
type BucketRow = {
  resource_type: string;
  resource_key: string;
  window_start: string;
  window_size: string;
  count: number;
};

type FakeState = {
  consent: ConsentRow[];
  buckets: BucketRow[];
  telemetry: Record<string, unknown>[];
  forceConsentError?: { message: string };
  forceInsertError?: { message: string };
};

function freshState(opts: Partial<FakeState> = {}): FakeState {
  return { consent: [], buckets: [], telemetry: [], ...opts };
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    rpc(fn: string, args: unknown) {
      if (fn === 'rate_limit_consume') {
        return Promise.resolve(
          fakeRateLimitConsume(state.buckets, args as Record<string, unknown>),
        );
      }
      return Promise.resolve({ data: null, error: { message: `unhandled rpc ${fn}` } });
    },
    from(table: string) {
      if (table === 'consent_log') return consentBuilder(state);
      if (table === 'rate_limit_buckets') return bucketBuilder(state);
      if (table === 'client_telemetry') return telemetryBuilder(state);
      throw new Error(`unhandled table ${table}`);
    },
  };
}

// deno-lint-ignore no-explicit-any
function consentBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];
  // deno-lint-ignore no-explicit-any
  const b: any = {
    select() {
      return b;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return b;
    },
    is(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return b;
    },
    maybeSingle() {
      if (state.forceConsentError) {
        return Promise.resolve({ data: null, error: state.forceConsentError });
      }
      const match = state.consent.find((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: match ? { id: 'consent-1' } : null, error: null });
    },
  };
  return b;
}

// deno-lint-ignore no-explicit-any
function bucketBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];
  // deno-lint-ignore no-explicit-any
  const b: any = {
    select() {
      return b;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return b;
    },
    maybeSingle() {
      const match = state.buckets.find((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: match ? { count: match.count } : null, error: null });
    },
    upsert(row: BucketRow, _opts: unknown) {
      const idx = state.buckets.findIndex(
        (r) =>
          r.resource_type === row.resource_type &&
          r.resource_key === row.resource_key &&
          r.window_start === row.window_start &&
          r.window_size === row.window_size,
      );
      if (idx >= 0) state.buckets[idx] = row;
      else state.buckets.push(row);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return b;
}

// deno-lint-ignore no-explicit-any
function telemetryBuilder(state: FakeState): any {
  return {
    insert(rows: Record<string, unknown>[]) {
      if (state.forceInsertError) {
        return Promise.resolve({ data: null, error: state.forceInsertError });
      }
      for (const r of rows) state.telemetry.push(r);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// Stubs + fixtures
// ---------------------------------------------------------------------------

function callerStub(id: string | null): HandlerDeps['getCallerUser'] {
  return () =>
    Promise.resolve(
      id === null ? null : { id, email: `${id}@test.co`, is_system_admin: false },
    );
}

const FIXED_NOW = new Date('2026-07-10T12:00:00.000Z');

function makeRequest(body: unknown, method = 'POST'): Request {
  return new Request('https://x.test/fn', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

function makeRawRequest(rawBody: string): Request {
  return new Request('https://x.test/fn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
}

function makeEvent(over: Record<string, unknown> = {}) {
  return {
    event_type: 'screen_view',
    severity: 'info',
    payload: { count: 1 },
    occurred_at: '2026-07-10T11:59:00.000Z',
    ...over,
  };
}

function withConsent(state: FakeState, userId: string): FakeState {
  state.consent.push({ user_id: userId, purpose: 'telemetry', revoked_at: null });
  return state;
}

function build(state: FakeState, id: string | null = 'u1') {
  return buildHandler({
    getCallerUser: callerStub(id),
    client: makeFakeClient(state),
    now: () => FIXED_NOW,
  });
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

Deno.test('returns 405 for non-POST', async () => {
  const res = await build(freshState())(makeRequest(null, 'GET'));
  assertEquals(res.status, 405);
});

Deno.test('returns 401 when the JWT is missing', async () => {
  const res = await build(freshState(), null)(makeRequest({ events: [makeEvent()] }));
  assertEquals(res.status, 401);
});

Deno.test('returns 400 on invalid JSON', async () => {
  const res = await build(freshState())(makeRawRequest('{not json'));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, 'invalid_json');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

Deno.test('returns 422 for more than 50 events', async () => {
  const events = Array.from({ length: 51 }, () => makeEvent());
  const res = await build(withConsent(freshState(), 'u1'))(makeRequest({ events }));
  assertEquals(res.status, 422);
  assertEquals((await res.json()).error, 'validation_failed');
});

Deno.test('returns 422 for an unknown severity', async () => {
  const res = await build(withConsent(freshState(), 'u1'))(
    makeRequest({ events: [makeEvent({ severity: 'critical' })] }),
  );
  assertEquals(res.status, 422);
});

Deno.test('returns 422 for an empty batch', async () => {
  const res = await build(withConsent(freshState(), 'u1'))(makeRequest({ events: [] }));
  assertEquals(res.status, 422);
});

Deno.test('returns 422 for a non-ISO occurred_at (would else 500 at the DB)', async () => {
  // "2026" parses via Date.parse but Postgres rejects it as timestamptz, so it
  // must be caught at validation (422), not blow up the INSERT (500).
  const res = await build(withConsent(freshState(), 'u1'))(
    makeRequest({ events: [makeEvent({ occurred_at: '2026' })] }),
  );
  assertEquals(res.status, 422);
});

Deno.test('returns 413 for an event over 8 KB', async () => {
  const big = makeEvent({ payload: { blob: 'x'.repeat(9000) } });
  const res = await build(withConsent(freshState(), 'u1'))(makeRequest({ events: [big] }));
  assertEquals(res.status, 413);
  assertEquals((await res.json()).error, 'payload_too_large');
});

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

Deno.test('returns 403 when there is no active telemetry consent', async () => {
  // Fresh state → no consent row for u1.
  const state = freshState();
  const res = await build(state)(makeRequest({ events: [makeEvent()] }));
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, 'consent_required');
  assertEquals(state.telemetry.length, 0);
});

Deno.test('a revoked telemetry consent is treated as no consent (403)', async () => {
  const state = freshState();
  state.consent.push({
    user_id: 'u1',
    purpose: 'telemetry',
    revoked_at: '2026-07-09T00:00:00.000Z',
  });
  const res = await build(state)(makeRequest({ events: [makeEvent()] }));
  assertEquals(res.status, 403);
});

// ---------------------------------------------------------------------------
// Happy path + redaction
// ---------------------------------------------------------------------------

Deno.test('happy path: 200 { ingested } and rows persisted with user_id', async () => {
  const state = withConsent(freshState(), 'u1');
  const res = await build(state)(
    makeRequest({
      events: [
        makeEvent({ event_type: 'a', payload: { x: 1 } }),
        makeEvent({ event_type: 'b', severity: 'warn', payload: { y: 2 }, screen: 'Home' }),
      ],
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(((await res.json()) as IngestResponse).ingested, 2);
  assertEquals(state.telemetry.length, 2);

  const first = state.telemetry[0];
  assertEquals(first.user_id, 'u1');
  assertEquals(first.event_type, 'a');
  assertEquals(first.severity, 'info');
  assertEquals(first.occurred_at, '2026-07-10T11:59:00.000Z');

  // The optional screen is folded into the persisted payload.
  const second = state.telemetry[1];
  assertEquals((second.payload as Record<string, unknown>).screen, 'Home');
});

Deno.test('deep-redacts secret-looking values in the payload before persisting', async () => {
  const state = withConsent(freshState(), 'u1');
  // A 16-lowercase-letter string is a Gmail app-password shape → redacted.
  const res = await build(state)(
    makeRequest({ events: [makeEvent({ payload: { note: 'abcdefghijklmnop' } })] }),
  );
  assertEquals(res.status, 200);
  const stored = state.telemetry[0].payload as Record<string, unknown>;
  assertEquals(stored.note, '[REDACTED_APP_PASSWORD]');
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

Deno.test('the rate-limit bucket increments by the batch size', async () => {
  const state = withConsent(freshState(), 'u1');
  await build(state)(makeRequest({ events: [makeEvent(), makeEvent(), makeEvent()] }));
  const bucket = state.buckets.find((b) => b.resource_key === 'user:u1');
  assert(bucket);
  assertEquals(bucket!.count, 3);
});

Deno.test('returns 429 once the per-user event limit is exceeded', async () => {
  const state = withConsent(freshState(), 'u1');
  const handler = build(state);
  const fifty = () => makeRequest({ events: Array.from({ length: 50 }, () => makeEvent()) });

  assertEquals((await handler(fifty())).status, 200); // bucket → 50
  assertEquals((await handler(fifty())).status, 200); // bucket → 100 (== limit, not over)

  // The 101st event tips it over the 100/min cap.
  const res = await handler(makeRequest({ events: [makeEvent()] }));
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error, 'rate_limited');
  assertEquals(body.scope, 'user');
  // The over-limit batch was NOT persisted.
  assertEquals(state.telemetry.length, 100);
});

// ---------------------------------------------------------------------------
// Insert failure
// ---------------------------------------------------------------------------

Deno.test('returns 500 when the insert fails', async () => {
  const state = withConsent(freshState(), 'u1');
  state.forceInsertError = { message: 'PG outage' };
  const res = await build(state)(makeRequest({ events: [makeEvent()] }));
  assertEquals(res.status, 500);
});
