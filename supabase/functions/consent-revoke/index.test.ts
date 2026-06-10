/**
 * consent-revoke tests — method/auth gates, body validation, happy path,
 * 404 when no active row, telemetry purge side-effect, event emission.
 *
 * Ref:  T-228, spec §9.4 ("telemetria revogada: purga client_telemetry") +
 *        §5.9 (granular consent_log model)
 * Date: 2026-06-10
 *
 * The handler is exercised end-to-end via `buildHandler({...})` with the JWT
 * and Supabase client deps stubbed (same pattern as consent-accept).
 *
 * Covered branches:
 *   - method gate (non-POST)                                          → 405
 *   - JWT missing                                                      → 401
 *   - invalid JSON body                                                → 400
 *   - missing/invalid purpose, oversized reason                        → 422
 *   - happy path (terms revoke): row updated, event emitted, no purge  → 200
 *   - no active consent for purpose                                    → 404
 *   - telemetry revoke: row updated + client_telemetry purged (count)  → 200
 *                                                                       + payload.telemetry_purged = N
 *   - telemetry purge error: still 200, telemetry_purged=null          → 200
 *   - UPDATE error → 500
 *   - active summary returned after revocation
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  buildHandler,
  CONSENT_PURPOSES,
  type ConsentPurpose,
  type HandlerDeps,
  type RevokeConsentResponse,
  validateRevokeBody,
} from './index.ts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test('validateRevokeBody rejects non-object body', () => {
  const r = validateRevokeBody('nope');
  assert(!r.ok);
});

Deno.test('validateRevokeBody requires purpose', () => {
  const r = validateRevokeBody({});
  assert(!r.ok);
});

Deno.test('validateRevokeBody enforces purpose enum', () => {
  const r = validateRevokeBody({ purpose: 'spam' });
  assert(!r.ok);
});

Deno.test('validateRevokeBody defaults revoked_reason to user_request', () => {
  const r = validateRevokeBody({ purpose: 'telemetry' });
  assert(r.ok);
  if (r.ok) assertEquals(r.data.revoked_reason, 'user_request');
});

Deno.test('validateRevokeBody trims revoked_reason and treats empty as default', () => {
  const r = validateRevokeBody({ purpose: 'terms', revoked_reason: '   ' });
  assert(r.ok);
  if (r.ok) assertEquals(r.data.revoked_reason, 'user_request');
});

Deno.test('validateRevokeBody rejects oversized revoked_reason', () => {
  const r = validateRevokeBody({
    purpose: 'terms',
    revoked_reason: 'x'.repeat(300),
  });
  assert(!r.ok);
});

Deno.test('validateRevokeBody rejects non-string revoked_reason', () => {
  const r = validateRevokeBody({ purpose: 'terms', revoked_reason: 42 });
  assert(!r.ok);
});

Deno.test('CONSENT_PURPOSES exported with 4 values', () => {
  assertEquals(CONSENT_PURPOSES.length, 4);
});

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

type ConsentRow = {
  id: string;
  user_id: string;
  purpose: ConsentPurpose;
  version: string;
  legal_basis: string;
  accepted_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

type TelemetryRow = { id: string; user_id: string };

type FakeState = {
  rows: ConsentRow[];
  telemetry: TelemetryRow[];
  /** Force the UPDATE on consent_log to fail. */
  forceUpdateError?: { message: string };
  /** Force the DELETE on client_telemetry to fail. */
  forceTelemetryDeleteError?: { message: string };
  updates: Array<{ patch: Record<string, unknown>; matched: ConsentRow[] }>;
  deletes: Array<{ table: string; matched: number }>;
};

function makeRow(over: Partial<ConsentRow> = {}): ConsentRow {
  return {
    id: crypto.randomUUID(),
    user_id: 'u1',
    purpose: 'terms',
    version: 'terms-v1-2026-01',
    legal_basis: 'consent',
    accepted_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    revoked_reason: null,
    ...over,
  };
}

function freshState(over: Partial<FakeState> = {}): FakeState {
  return {
    rows: [],
    telemetry: [],
    updates: [],
    deletes: [],
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    from(table: string) {
      if (table === 'consent_log') return buildConsentBuilder(state);
      if (table === 'client_telemetry') return buildTelemetryBuilder(state);
      throw new Error(`unhandled table ${table}`);
    },
  };
}

// deno-lint-ignore no-explicit-any
function buildConsentBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];
  let mode: 'select' | 'update' = 'select';
  let updatePatch: Record<string, unknown> | null = null;
  let wantReturning = false;

  // The handler issues TWO query shapes against consent_log:
  //   (a) UPDATE chain ending with .select(cols) which PostgREST resolves
  //       to {data, error} when awaited. The chain looks like:
  //         .update(patch).eq().eq().is().select(cols)  → thenable
  //   (b) SELECT chain ending with .order(col) which resolves to {data, error}.
  //         .select(cols).eq().is().order(col)
  //
  // We model the builder as a thenable so it can serve both shapes uniformly.
  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select(_cols: string) {
      if (mode === 'update') {
        // .select() after .update() = RETURNING. Mark intent and stay thenable.
        wantReturning = true;
      }
      return builder;
    },
    update(patch: Record<string, unknown>) {
      mode = 'update';
      updatePatch = patch;
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    is(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    order(col: string) {
      const matched = state.rows.filter((r) => filters.every((f) => f(r)));
      matched.sort((a, b) =>
        String(a[col as keyof ConsentRow]).localeCompare(
          String(b[col as keyof ConsentRow]),
        )
      );
      return Promise.resolve({ data: matched, error: null });
    },
    then(
      onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) {
      if (mode === 'update') {
        return resolveUpdate().then(onFulfilled, onRejected);
      }
      const matched = state.rows.filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: matched, error: null }).then(
        onFulfilled,
        onRejected,
      );
    },
  };

  function resolveUpdate() {
    const matched = state.rows.filter((r) => filters.every((f) => f(r)));
    state.updates.push({ patch: updatePatch!, matched: matched.slice() });
    if (state.forceUpdateError) {
      return Promise.resolve({ data: null, error: state.forceUpdateError });
    }
    const updated: ConsentRow[] = [];
    for (const m of matched) {
      const idx = state.rows.indexOf(m);
      const next = { ...m, ...(updatePatch as Partial<ConsentRow>) };
      state.rows[idx] = next;
      updated.push(next);
    }
    if (wantReturning) {
      return Promise.resolve({ data: updated, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  return builder;
}

// deno-lint-ignore no-explicit-any
function buildTelemetryBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];

  // deno-lint-ignore no-explicit-any
  const builder: any = {
    delete(_opts: { count?: 'exact' } = {}) {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      // .eq() is terminal for the delete chain in our handler usage.
      if (state.forceTelemetryDeleteError) {
        state.deletes.push({ table: 'client_telemetry', matched: 0 });
        return Promise.resolve({
          data: null,
          error: state.forceTelemetryDeleteError,
          count: null,
        });
      }
      const matched = state.telemetry.filter((r) => filters.every((f) => f(r)));
      for (const m of matched) {
        const idx = state.telemetry.indexOf(m);
        state.telemetry.splice(idx, 1);
      }
      state.deletes.push({ table: 'client_telemetry', matched: matched.length });
      return Promise.resolve({
        data: null,
        error: null,
        count: matched.length,
      });
    },
  };
  return builder;
}

function callerStub(user: { id: string } | null): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

const FIXED_NOW = new Date('2026-06-10T15:00:00.000Z');
function fixedNow() {
  return FIXED_NOW;
}

function makeRequest(
  body: unknown,
  opts: { method?: string } = {},
): Request {
  return new Request('https://x.test/consent/revoke', {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

Deno.test('handler returns 405 for non-POST', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}, { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('handler returns 401 when JWT missing', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub(null),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ purpose: 'terms' }));
  assertEquals(res.status, 401);
});

Deno.test('handler returns 400 on invalid JSON body', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const req = new Request('https://x.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const res = await handler(req);
  assertEquals(res.status, 400);
});

Deno.test('handler returns 422 on missing purpose', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 422);
});

Deno.test('handler returns 404 when no active consent for purpose', async () => {
  const state = freshState({
    rows: [], // no active rows for this user
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ purpose: 'marketing' }));
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, 'no_active_consent');
});

Deno.test('happy path (terms): row marked revoked + reason captured + event emitted + no telemetry purge', async () => {
  const active = makeRow({
    user_id: 'u1',
    purpose: 'terms',
    version: 'terms-v1-2026-01',
  });
  const state = freshState({ rows: [active] });
  let emitted: { type: string; payload: unknown; aggregate_id: string } | null = null;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = {
        type: e.type,
        payload: e.payload,
        aggregate_id: e.aggregate_id,
      };
      return Promise.resolve();
    },
    now: fixedNow,
  });
  const res = await handler(
    makeRequest({ purpose: 'terms', revoked_reason: 'terms_updated' }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as RevokeConsentResponse;
  assertEquals(body.revoked.purpose, 'terms');
  assertEquals(body.revoked.revoked_at, FIXED_NOW.toISOString());
  assertEquals(body.revoked.revoked_reason, 'terms_updated');
  assertEquals(body.telemetry_purged, null);

  // Row mutated in place.
  assertEquals(state.rows[0].revoked_at, FIXED_NOW.toISOString());
  assertEquals(state.rows[0].revoked_reason, 'terms_updated');

  // Telemetry table NOT touched (purpose != telemetry).
  assertEquals(state.deletes.length, 0);

  // Active summary excludes the revoked row.
  assertEquals(body.active.length, 0);

  // Event emitted with payload shape.
  assert(emitted !== null);
  const emittedEvent = emitted as NonNullable<typeof emitted>;
  assertEquals(emittedEvent.type, 'consent.revoked');
  assertEquals(emittedEvent.aggregate_id, active.id);
  const payload = emittedEvent.payload as { version: number; data: Record<string, unknown> };
  assertEquals(payload.version, 1);
  assertEquals(payload.data.purpose, 'terms');
  assertEquals(payload.data.consent_version, 'terms-v1-2026-01');
  assertEquals(payload.data.revoked_reason, 'terms_updated');
  assertEquals(payload.data.telemetry_purged, null);
});

Deno.test('telemetry revoke purges client_telemetry and reports the count', async () => {
  const active = makeRow({
    user_id: 'u1',
    purpose: 'telemetry',
    version: 'tele-v1',
  });
  const state = freshState({
    rows: [active],
    telemetry: [
      { id: '1', user_id: 'u1' },
      { id: '2', user_id: 'u1' },
      { id: '3', user_id: 'u1' },
      { id: '4', user_id: 'other-user' }, // MUST stay
    ],
  });
  let emitted: { payload: unknown } | null = null;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = { payload: e.payload };
      return Promise.resolve();
    },
    now: fixedNow,
  });
  const res = await handler(makeRequest({ purpose: 'telemetry' }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as RevokeConsentResponse;
  assertEquals(body.revoked.purpose, 'telemetry');
  assertEquals(body.telemetry_purged, 3);

  // Only u1's rows were purged.
  assertEquals(state.telemetry.length, 1);
  assertEquals(state.telemetry[0].user_id, 'other-user');

  // Event payload carries the purge count.
  assert(emitted !== null);
  const emittedEvent = emitted as NonNullable<typeof emitted>;
  const payload = emittedEvent.payload as { data: { telemetry_purged: number } };
  assertEquals(payload.data.telemetry_purged, 3);
});

Deno.test('telemetry purge failure still returns 200 with telemetry_purged=null', async () => {
  // The user-facing revocation MUST succeed even if the downstream telemetry
  // purge errors; a daily reconcile cron will retry.
  const active = makeRow({
    user_id: 'u1',
    purpose: 'telemetry',
    version: 'tele-v1',
  });
  const state = freshState({
    rows: [active],
    telemetry: [{ id: '1', user_id: 'u1' }],
    forceTelemetryDeleteError: { message: 'transient PG outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ purpose: 'telemetry' }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as RevokeConsentResponse;
  assertEquals(body.telemetry_purged, null);
  // The consent_log row is still marked revoked.
  assertEquals(state.rows[0].revoked_at, FIXED_NOW.toISOString());
});

Deno.test('UPDATE error returns 500 (telemetry purge not attempted)', async () => {
  const active = makeRow({ user_id: 'u1', purpose: 'telemetry' });
  const state = freshState({
    rows: [active],
    telemetry: [{ id: '1', user_id: 'u1' }],
    forceUpdateError: { message: 'transient PG outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ purpose: 'telemetry' }));
  assertEquals(res.status, 500);
  // Telemetry table MUST NOT have been touched.
  assertEquals(state.deletes.length, 0);
  // Telemetry row intact.
  assertEquals(state.telemetry.length, 1);
});

Deno.test('duplicate revoke (no row active) returns 404 — idempotent re-call surface', async () => {
  // After the first revoke, calling again with the same purpose returns 404.
  // The client treats this as "already revoked" and stops asking.
  const active = makeRow({
    user_id: 'u1',
    purpose: 'marketing',
    version: 'mk-v1',
  });
  const state = freshState({ rows: [active] });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  // First revoke succeeds.
  const r1 = await handler(makeRequest({ purpose: 'marketing' }));
  assertEquals(r1.status, 200);
  // Second revoke finds no active row → 404.
  const r2 = await handler(makeRequest({ purpose: 'marketing' }));
  assertEquals(r2.status, 404);
});

Deno.test('active summary excludes revoked rows but includes other still-active purposes', async () => {
  const state = freshState({
    rows: [
      makeRow({ user_id: 'u1', purpose: 'terms', version: 'terms-v1' }),
      makeRow({ user_id: 'u1', purpose: 'privacy', version: 'priv-v1' }),
      makeRow({ user_id: 'u1', purpose: 'marketing', version: 'mk-v1' }),
    ],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ purpose: 'marketing' }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as RevokeConsentResponse;
  // Only terms + privacy remain active.
  const purposes = body.active.map((a) => a.purpose).sort();
  assertEquals(purposes, ['privacy', 'terms']);
});
