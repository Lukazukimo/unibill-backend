/**
 * consent-accept tests — method/auth gates, body validation, ip extraction,
 * happy path, 409 on duplicate active, 409→200 via revoke_existing, event
 * emission shape.
 *
 * Ref:  T-228, spec §5.9 (granular consent + partial UNIQUE active per
 *        purpose) + §9.4 (LGPD evidence model)
 * Date: 2026-06-10
 *
 * The handler is exercised end-to-end via `buildHandler({...})` with the JWT
 * and Supabase client deps stubbed (same pattern as emails-connect / emails-delete).
 *
 * Covered branches:
 *   - method gate (non-POST)                                          → 405
 *   - JWT missing                                                      → 401
 *   - invalid JSON body                                                → 400
 *   - missing/invalid purpose / version / legal_basis / revoke_existing → 422
 *   - happy path (terms): row inserted, ip + ua captured, event emitted → 200
 *   - duplicate active (DB returns 23505)                              → 409
 *   - revoke_existing=true supersedes previous active row              → 200
 *                                                                       + payload.superseded_previous=true
 *                                                                       + previous row marked revoked_at + reason='superseded'
 *   - pre-revoke UPDATE error → 500
 *   - insert error (non-unique) → 500
 *   - active summary returned alongside the inserted row
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  type AcceptConsentResponse,
  buildHandler,
  CONSENT_PURPOSES,
  type ConsentPurpose,
  extractClientIp,
  type HandlerDeps,
  isValidIp,
  LEGAL_BASES,
  validateAcceptBody,
} from './index.ts';
import { nonNull } from '../_shared/_test_utils.ts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test('isValidIp accepts v4 + v6 and rejects junk', () => {
  assertEquals(isValidIp('192.168.1.1'), true);
  assertEquals(isValidIp('255.255.255.255'), true);
  assertEquals(isValidIp('::1'), true);
  assertEquals(isValidIp('2001:db8::1'), true);
  assertEquals(isValidIp('not-an-ip'), false);
  assertEquals(isValidIp('999.0.0.0'), false);
  assertEquals(isValidIp(''), false);
});

Deno.test('extractClientIp prefers leftmost x-forwarded-for', () => {
  const req = new Request('https://x.test/', {
    headers: {
      'x-forwarded-for': '203.0.113.42, 198.51.100.1, 192.0.2.1',
      'x-real-ip': '10.0.0.1',
    },
  });
  assertEquals(extractClientIp(req), '203.0.113.42');
});

Deno.test('extractClientIp falls back to x-real-ip / fly-client-ip / cf-connecting-ip', () => {
  const req = new Request('https://x.test/', {
    headers: { 'cf-connecting-ip': '198.51.100.7' },
  });
  assertEquals(extractClientIp(req), '198.51.100.7');
});

Deno.test('extractClientIp returns null when no parsable IP', () => {
  const req = new Request('https://x.test/', {
    headers: { 'x-forwarded-for': 'garbage, also-garbage' },
  });
  assertEquals(extractClientIp(req), null);
});

Deno.test('validateAcceptBody rejects non-object body', () => {
  const r = validateAcceptBody('not an object');
  assert(!r.ok);
});

Deno.test('validateAcceptBody requires purpose / version / legal_basis', () => {
  const r = validateAcceptBody({});
  assert(!r.ok);
  if (!r.ok) {
    const fields = r.errors.map((e) => e.field).sort();
    assertEquals(fields, ['legal_basis', 'purpose', 'version']);
  }
});

Deno.test('validateAcceptBody enforces purpose enum', () => {
  const r = validateAcceptBody({
    purpose: 'unknown',
    version: 'v1',
    legal_basis: 'consent',
  });
  assert(!r.ok);
});

Deno.test('validateAcceptBody enforces legal_basis enum', () => {
  const r = validateAcceptBody({
    purpose: 'terms',
    version: 'v1',
    legal_basis: 'maybe',
  });
  assert(!r.ok);
});

Deno.test('validateAcceptBody enforces version max length', () => {
  const r = validateAcceptBody({
    purpose: 'terms',
    version: 'x'.repeat(100),
    legal_basis: 'consent',
  });
  assert(!r.ok);
});

Deno.test('validateAcceptBody accepts the canonical happy shape', () => {
  const r = validateAcceptBody({
    purpose: 'terms',
    version: 'terms-v1.2-2026-06',
    legal_basis: 'consent',
  });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.data.purpose, 'terms');
    assertEquals(r.data.revoke_existing, false);
  }
});

Deno.test('validateAcceptBody accepts revoke_existing=true', () => {
  const r = validateAcceptBody({
    purpose: 'terms',
    version: 'v2',
    legal_basis: 'consent',
    revoke_existing: true,
  });
  assert(r.ok);
  if (r.ok) assertEquals(r.data.revoke_existing, true);
});

Deno.test('validateAcceptBody rejects revoke_existing non-boolean', () => {
  const r = validateAcceptBody({
    purpose: 'terms',
    version: 'v1',
    legal_basis: 'consent',
    revoke_existing: 'yes',
  });
  assert(!r.ok);
});

Deno.test('CONSENT_PURPOSES + LEGAL_BASES exported with expected values', () => {
  assertEquals(CONSENT_PURPOSES.length, 4);
  assertEquals(LEGAL_BASES.length, 4);
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
  ip_address: string | null;
  user_agent: string | null;
};

type FakeState = {
  rows: ConsentRow[];
  /** Force the next INSERT to fail with the given error. */
  forceInsertError?: { code?: string; message: string };
  /** Force the next UPDATE to fail with the given error. */
  forceUpdateError?: { message: string };
  /** Track inserts/updates for assertions. */
  inserts: Array<Record<string, unknown>>;
  updates: Array<{
    patch: Record<string, unknown>;
    matched: ConsentRow[];
  }>;
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
    ip_address: null,
    user_agent: null,
    ...over,
  };
}

function freshState(over: Partial<FakeState> = {}): FakeState {
  return {
    rows: [],
    inserts: [],
    updates: [],
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    from(table: string) {
      if (table !== 'consent_log') {
        throw new Error(`unhandled table ${table}`);
      }
      return buildConsentBuilder(state);
    },
  };
}

// deno-lint-ignore no-explicit-any
function buildConsentBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];
  let mode: 'select' | 'insert' | 'update' = 'select';
  let insertPayload: Record<string, unknown> | null = null;
  let updatePatch: Record<string, unknown> | null = null;
  let orderCol: string | null = null;

  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select(_cols: string) {
      // .select() may be a terminal or chained method depending on call site.
      return builder;
    },
    insert(payload: Record<string, unknown>) {
      mode = 'insert';
      insertPayload = payload;
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
      if (mode === 'update') {
        return resolveUpdate();
      }
      return builder;
    },
    order(col: string) {
      orderCol = col;
      // .order() is a chain terminator for the "active summary" SELECT.
      const matched = state.rows.filter((r) => filters.every((f) => f(r)));
      matched.sort((a, b) =>
        String(a[orderCol as keyof ConsentRow]).localeCompare(
          String(b[orderCol as keyof ConsentRow]),
        )
      );
      return Promise.resolve({ data: matched, error: null });
    },
    maybeSingle() {
      const matched = state.rows.filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: matched[0] ?? null, error: null });
    },
    single() {
      if (mode === 'insert') return resolveInsert();
      const matched = state.rows.filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: matched[0] ?? null, error: null });
    },
  };

  function resolveInsert() {
    state.inserts.push(insertPayload!);
    if (state.forceInsertError) {
      return Promise.resolve({ data: null, error: state.forceInsertError });
    }
    // Enforce partial unique: at most one active per (user_id, purpose).
    const p = insertPayload!;
    const userId = p.user_id as string;
    const purpose = p.purpose as ConsentPurpose;
    const conflict = state.rows.find((r) =>
      r.user_id === userId && r.purpose === purpose && r.revoked_at === null
    );
    if (conflict) {
      return Promise.resolve({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });
    }
    const row: ConsentRow = {
      id: crypto.randomUUID(),
      user_id: userId,
      purpose,
      version: p.version as string,
      legal_basis: p.legal_basis as string,
      accepted_at: p.accepted_at as string,
      revoked_at: null,
      revoked_reason: null,
      ip_address: (p.ip_address as string | null) ?? null,
      user_agent: (p.user_agent as string | null) ?? null,
    };
    state.rows.push(row);
    return Promise.resolve({ data: row, error: null });
  }

  function resolveUpdate() {
    const matched = state.rows.filter((r) => filters.every((f) => f(r)));
    state.updates.push({ patch: updatePatch!, matched: matched.slice() });
    if (state.forceUpdateError) {
      return Promise.resolve({ data: null, error: state.forceUpdateError });
    }
    for (const m of matched) {
      const idx = state.rows.indexOf(m);
      state.rows[idx] = { ...m, ...(updatePatch as Partial<ConsentRow>) };
    }
    return Promise.resolve({ data: null, error: null });
  }

  return builder;
}

function callerStub(user: { id: string } | null): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

const FIXED_NOW = new Date('2026-06-10T12:00:00.000Z');
function fixedNow() {
  return FIXED_NOW;
}

function makeRequest(
  body: unknown,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request('https://x.test/consent/accept', {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: body === undefined || (opts.method && ['GET', 'HEAD'].includes(opts.method.toUpperCase()))
      ? undefined
      : JSON.stringify(body),
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
  const res = await handler(
    makeRequest({ purpose: 'terms', version: 'v1', legal_basis: 'consent' }),
  );
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

Deno.test('handler returns 422 on missing fields', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 422);
});

Deno.test('handler returns 422 on invalid enum values', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(
    makeRequest({
      purpose: 'foo',
      version: 'v1',
      legal_basis: 'bar',
    }),
  );
  assertEquals(res.status, 422);
});

Deno.test('happy path inserts active row, captures ip + user-agent, emits event', async () => {
  const state = freshState();
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
  const req = makeRequest(
    {
      purpose: 'terms',
      version: 'terms-v1.2-2026-06',
      legal_basis: 'consent',
    },
    {
      headers: {
        'x-forwarded-for': '203.0.113.5',
        'user-agent': 'TestAgent/1.0',
      },
    },
  );
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = (await res.json()) as AcceptConsentResponse;
  assertEquals(body.consent.purpose, 'terms');
  assertEquals(body.consent.version, 'terms-v1.2-2026-06');
  assertEquals(body.consent.accepted_at, FIXED_NOW.toISOString());
  assertEquals(body.consent.revoked_at, null);

  // Insert payload captured ip + ua + accepted_at
  assertEquals(state.inserts.length, 1);
  const ins = state.inserts[0];
  assertEquals(ins.ip_address, '203.0.113.5');
  assertEquals(ins.user_agent, 'TestAgent/1.0');
  assertEquals(ins.accepted_at, FIXED_NOW.toISOString());

  // Active summary contains the new row.
  assertEquals(body.active.length, 1);
  assertEquals(body.active[0].purpose, 'terms');

  // Event emitted with payload shape.
  assert(emitted !== null);
  const emittedEvent = nonNull<{ type: string; payload: unknown; aggregate_id: string }>(emitted);
  assertEquals(emittedEvent.type, 'consent.accepted');
  const payload = emittedEvent.payload as { version: number; data: Record<string, unknown> };
  assertEquals(payload.version, 1);
  assertEquals(payload.data.purpose, 'terms');
  assertEquals(payload.data.legal_basis, 'consent');
  assertEquals(payload.data.superseded_previous, false);
});

Deno.test('duplicate active row returns 409 with existing row attached', async () => {
  const state = freshState({
    rows: [makeRow({
      user_id: 'u1',
      purpose: 'terms',
      version: 'terms-v1-2026-01',
      accepted_at: '2026-01-01T00:00:00.000Z',
    })],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(
    makeRequest({
      purpose: 'terms',
      version: 'terms-v1.2-2026-06',
      legal_basis: 'consent',
    }),
  );
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, 'consent_already_active');
  assertEquals(body.existing.version, 'terms-v1-2026-01');
});

Deno.test('revoke_existing=true supersedes prior active and inserts new row', async () => {
  const previous = makeRow({
    user_id: 'u1',
    purpose: 'terms',
    version: 'terms-v1-2026-01',
  });
  const state = freshState({ rows: [previous] });
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
  const res = await handler(
    makeRequest({
      purpose: 'terms',
      version: 'terms-v2-2026-06',
      legal_basis: 'consent',
      revoke_existing: true,
    }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as AcceptConsentResponse;
  assertEquals(body.consent.version, 'terms-v2-2026-06');
  assertEquals(body.consent.revoked_at, null);

  // Previous row was revoked with reason=superseded.
  const revokedPrev = state.rows.find((r) => r.version === 'terms-v1-2026-01')!;
  assertEquals(revokedPrev.revoked_at, FIXED_NOW.toISOString());
  assertEquals(revokedPrev.revoked_reason, 'superseded');

  // Active summary contains ONLY the new row.
  assertEquals(body.active.length, 1);
  assertEquals(body.active[0].version, 'terms-v2-2026-06');

  // Event payload flags supersession.
  assert(emitted !== null);
  const emittedEvent = nonNull<{ payload: unknown }>(emitted);
  const payload = emittedEvent.payload as { data: { superseded_previous: boolean } };
  assertEquals(payload.data.superseded_previous, true);
});

Deno.test('pre-revoke UPDATE error returns 500 (insert not attempted)', async () => {
  const state = freshState({
    rows: [makeRow({ user_id: 'u1', purpose: 'terms' })],
    forceUpdateError: { message: 'transient PG outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(
    makeRequest({
      purpose: 'terms',
      version: 'v2',
      legal_basis: 'consent',
      revoke_existing: true,
    }),
  );
  assertEquals(res.status, 500);
  // INSERT must NOT have been attempted
  assertEquals(state.inserts.length, 0);
});

Deno.test('non-unique INSERT error returns 500', async () => {
  const state = freshState({
    forceInsertError: { code: '42P01', message: 'undefined_table' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(
    makeRequest({
      purpose: 'telemetry',
      version: 'tele-v1',
      legal_basis: 'consent',
    }),
  );
  assertEquals(res.status, 500);
});

Deno.test('telemetry purpose accept path is symmetrical (no telemetry purge here)', async () => {
  // accept must NEVER touch client_telemetry — that's only on revoke.
  const state = freshState();
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(
    makeRequest({
      purpose: 'telemetry',
      version: 'tele-v1',
      legal_basis: 'consent',
    }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as AcceptConsentResponse;
  assertEquals(body.consent.purpose, 'telemetry');
});
