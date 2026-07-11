/**
 * emails-unbind tests — method/param gates, owner/sys-admin gate, single-binding
 * soft-delete (target only), idempotency, and conditional event emission.
 *
 * Ref:  T-521 (#71 Slice 2), spec §5.2 / §E
 * Date: 2026-07-10
 *
 * The handler is exercised via `buildHandler({...})` with the JWT + Supabase
 * client deps stubbed (same pattern as emails-delete).
 *
 * Covered branches:
 *   - method gate (non-DELETE)                                          → 405
 *   - missing/malformed id or household_id                              → 404
 *   - JWT missing                                                       → 401
 *   - connected_emails row not found                                    → 404
 *   - initial SELECT errors                                             → 500
 *   - caller is neither owner nor sys admin                             → 403
 *                                                                        + binding NOT touched
 *   - credential already soft-deleted (idempotent)                      → 200, no event
 *   - happy path OWNER: only the target binding is soft-deleted         → 200 + event
 *   - happy path SYS ADMIN (non-owner)                                  → 200 + by_system_admin=true
 *   - binding already gone (idempotent no-op)                           → 200, NO event
 *   - bindings UPDATE errors                                            → 500
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  buildHandler,
  extractUnbindTarget,
  type HandlerDeps,
  type UnbindEmailResponse,
} from './index.ts';
import { nonNull } from '../_shared/_test_utils.ts';

const EMAIL_ID = '11111111-1111-4111-8111-111111111111';
const HOUSEHOLD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOUSEHOLD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

Deno.test('extractUnbindTarget parses ?id=&household_id= query', () => {
  const url = new URL(
    `https://x.test/functions/v1/emails-unbind?id=${EMAIL_ID}&household_id=${HOUSEHOLD_A}`,
  );
  assertEquals(extractUnbindTarget(url), { emailId: EMAIL_ID, householdId: HOUSEHOLD_A });
});

Deno.test('extractUnbindTarget parses /emails/:id/households/:household_id', () => {
  const url = new URL(`https://x.test/emails/${EMAIL_ID}/households/${HOUSEHOLD_A}`);
  assertEquals(extractUnbindTarget(url), { emailId: EMAIL_ID, householdId: HOUSEHOLD_A });
});

Deno.test('extractUnbindTarget parses the Supabase function URL with two id suffixes', () => {
  const url = new URL(
    `https://x.test/functions/v1/emails-unbind/${EMAIL_ID}/${HOUSEHOLD_A}`,
  );
  assertEquals(extractUnbindTarget(url), { emailId: EMAIL_ID, householdId: HOUSEHOLD_A });
});

Deno.test('extractUnbindTarget returns null when household_id is missing', () => {
  const url = new URL(`https://x.test/functions/v1/emails-unbind?id=${EMAIL_ID}`);
  assertEquals(extractUnbindTarget(url), null);
});

Deno.test('extractUnbindTarget returns null on a malformed id', () => {
  const url = new URL(`https://x.test/emails/not-a-uuid/households/${HOUSEHOLD_A}`);
  assertEquals(extractUnbindTarget(url), null);
});

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

type ConnectedEmailRow = {
  id: string;
  email_address: string;
  owner_user_id: string;
  deleted_at: string | null;
};

type BindingRow = {
  id: string;
  connected_email_id: string;
  household_id: string;
  updated_at: string;
  deleted_at: string | null;
};

type FakeState = {
  rows: ConnectedEmailRow[];
  bindings: BindingRow[];
  /** Force an error from the connected_emails SELECT. */
  forceLoadError?: { message: string };
  /** Force an error from the connected_email_households UPDATE. */
  forceBindingsError?: { message: string };
};

function makeRow(over: Partial<ConnectedEmailRow> = {}): ConnectedEmailRow {
  return {
    id: EMAIL_ID,
    email_address: 'a@b.co',
    owner_user_id: 'u1',
    deleted_at: null,
    ...over,
  };
}

function makeBinding(over: Partial<BindingRow> = {}): BindingRow {
  return {
    id: crypto.randomUUID(),
    connected_email_id: EMAIL_ID,
    household_id: HOUSEHOLD_A,
    updated_at: '2026-07-01T00:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

/**
 * Tiny fake covering the two chains the handler uses:
 *   - connected_emails:  .select(cols).eq('id', id).maybeSingle()
 *   - connected_email_households:
 *       .update(patch).eq('connected_email_id', id).eq('household_id', hh)
 *         .is('deleted_at', null).select('id')  → RETURNING rows
 */
// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    from(table: string) {
      if (table === 'connected_emails') return buildConnectedEmailsBuilder(state);
      if (table === 'connected_email_households') return buildBindingsBuilder(state);
      throw new Error(`unhandled table ${table}`);
    },
  };
}

// deno-lint-ignore no-explicit-any
function buildConnectedEmailsBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];
  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select(_cols: string) {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    maybeSingle() {
      if (state.forceLoadError) {
        return Promise.resolve({ data: null, error: state.forceLoadError });
      }
      const matched = state.rows.filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: matched[0] ?? null, error: null });
    },
  };
  return builder;
}

// deno-lint-ignore no-explicit-any
function buildBindingsBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];
  let updatePatch: Record<string, unknown> | null = null;

  // deno-lint-ignore no-explicit-any
  const builder: any = {
    update(patch: Record<string, unknown>) {
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
    // Terminal: applies the update to the matched rows and RETURNS them.
    select(_cols: string) {
      if (state.forceBindingsError) {
        return Promise.resolve({ data: null, error: state.forceBindingsError });
      }
      const matches = state.bindings.filter((b) => filters.every((f) => f(b)));
      const returned: BindingRow[] = [];
      for (const m of matches) {
        const idx = state.bindings.indexOf(m);
        const updated = { ...m, ...updatePatch } as BindingRow;
        state.bindings[idx] = updated;
        returned.push(updated);
      }
      return Promise.resolve({ data: returned, error: null });
    },
  };
  return builder;
}

function freshState(opts: Partial<FakeState> = {}): FakeState {
  return { rows: [], bindings: [], ...opts };
}

function callerStub(
  user: { id: string; isSystemAdmin: boolean } | null,
): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

function makeRequest(opts: {
  emailId?: string | null;
  householdId?: string;
  method?: string;
} = {}): Request {
  const emailId = opts.emailId === undefined ? EMAIL_ID : opts.emailId;
  const householdId = opts.householdId ?? HOUSEHOLD_A;
  const path = emailId === null
    ? 'https://x.test/emails/not-a-uuid/households/' + householdId
    : `https://x.test/emails/${emailId}/households/${householdId}`;
  return new Request(path, { method: opts.method ?? 'DELETE' });
}

const FIXED_NOW = new Date('2026-07-10T12:34:56.000Z');
function fixedNow() {
  return FIXED_NOW;
}

// ---------------------------------------------------------------------------
// Handler tests — error paths
// ---------------------------------------------------------------------------

Deno.test('handler returns 405 for non-DELETE', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  assertEquals((await handler(makeRequest({ method: 'POST' }))).status, 405);
});

Deno.test('handler returns 404 when the target is malformed', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  assertEquals((await handler(makeRequest({ emailId: null }))).status, 404);
});

Deno.test('handler returns 401 when JWT missing', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub(null),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  assertEquals((await handler(makeRequest({}))).status, 401);
});

Deno.test('handler returns 404 when connected_emails row missing', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  assertEquals((await handler(makeRequest({}))).status, 404);
});

Deno.test('handler returns 500 when initial SELECT errors', async () => {
  const state = freshState({ forceLoadError: { message: 'PG outage' } });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  assertEquals((await handler(makeRequest({}))).status, 500);
});

// ---------------------------------------------------------------------------
// Authorization gate
// ---------------------------------------------------------------------------

Deno.test('handler returns 403 when caller is neither owner nor sys admin', async () => {
  const state = freshState({
    rows: [makeRow({ owner_user_id: 'someone-else' })],
    bindings: [makeBinding({ household_id: HOUSEHOLD_A })],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, 'forbidden');
  // Binding must NOT be touched on auth failure.
  assertEquals(state.bindings[0].deleted_at, null);
});

// ---------------------------------------------------------------------------
// Idempotency: already-revoked credential
// ---------------------------------------------------------------------------

Deno.test('handler returns 200 for an already soft-deleted credential (no event)', async () => {
  const state = freshState({
    rows: [makeRow({ owner_user_id: 'u1', deleted_at: '2026-07-09T00:00:00.000Z' })],
  });
  let emitted = 0;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    emitEvent: () => {
      emitted += 1;
      return Promise.resolve();
    },
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 200);
  assertEquals(((await res.json()) as UnbindEmailResponse).unbound, true);
  assertEquals(emitted, 0);
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

Deno.test('handler happy path OWNER: only the target binding is soft-deleted + event', async () => {
  const otherEmailId = '22222222-2222-4222-8222-222222222222';
  const state = freshState({
    rows: [makeRow({ owner_user_id: 'u1' })],
    bindings: [
      // Target: this email + household A → unbound.
      makeBinding({ connected_email_id: EMAIL_ID, household_id: HOUSEHOLD_A }),
      // Same email, DIFFERENT household → must stay.
      makeBinding({ connected_email_id: EMAIL_ID, household_id: HOUSEHOLD_B }),
      // Different email, same household → must stay.
      makeBinding({ connected_email_id: otherEmailId, household_id: HOUSEHOLD_A }),
    ],
  });
  let emitted:
    | { type: string; aggregate_id: string; household_id?: string; payload: unknown }
    | null = null;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = {
        type: e.type,
        aggregate_id: e.aggregate_id,
        household_id: e.household_id,
        payload: e.payload,
      };
      return Promise.resolve();
    },
    now: fixedNow,
  });
  const res = await handler(makeRequest({ emailId: EMAIL_ID, householdId: HOUSEHOLD_A }));
  assertEquals(res.status, 200);
  assertEquals(((await res.json()) as UnbindEmailResponse).unbound, true);

  const target = state.bindings.find(
    (b) => b.connected_email_id === EMAIL_ID && b.household_id === HOUSEHOLD_A,
  )!;
  assertEquals(target.deleted_at, FIXED_NOW.toISOString());
  assertEquals(target.updated_at, FIXED_NOW.toISOString());

  // Same email, other household — untouched.
  const sameEmailOther = state.bindings.find(
    (b) => b.connected_email_id === EMAIL_ID && b.household_id === HOUSEHOLD_B,
  )!;
  assertEquals(sameEmailOther.deleted_at, null);
  // Other email, same household — untouched.
  const otherEmail = state.bindings.find((b) => b.connected_email_id === otherEmailId)!;
  assertEquals(otherEmail.deleted_at, null);

  // Event: email.household_unbound with the target household in the payload.
  assert(emitted !== null);
  const ev = nonNull<
    { type: string; aggregate_id: string; household_id?: string; payload: unknown }
  >(emitted);
  assertEquals(ev.type, 'email.household_unbound');
  assertEquals(ev.aggregate_id, EMAIL_ID);
  // Household-specific event stamps the top-level household_id column.
  assertEquals(ev.household_id, HOUSEHOLD_A);
  const payload = ev.payload as { version: number; data: Record<string, unknown> };
  assertEquals(payload.version, 1);
  assertEquals(payload.data.household_id, HOUSEHOLD_A);
  assertEquals(payload.data.unbound_at, FIXED_NOW.toISOString());
  assertEquals(payload.data.by_system_admin, false);
});

Deno.test('handler happy path SYS ADMIN (non-owner): 200 + by_system_admin=true', async () => {
  const state = freshState({
    rows: [makeRow({ owner_user_id: 'someone-else' })],
    bindings: [makeBinding({ household_id: HOUSEHOLD_A })],
  });
  let emitted: { payload: unknown } | null = null;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'sysadmin', isSystemAdmin: true }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = { payload: e.payload };
      return Promise.resolve();
    },
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 200);
  assertEquals(state.bindings[0].deleted_at, FIXED_NOW.toISOString());
  assert(emitted !== null);
  const ev = nonNull<{ payload: unknown }>(emitted);
  const payload = ev.payload as { data: { by_system_admin: boolean } };
  assertEquals(payload.data.by_system_admin, true);
});

// ---------------------------------------------------------------------------
// Idempotent no-op: binding already gone
// ---------------------------------------------------------------------------

Deno.test('handler returns 200 with NO event when the binding was already unbound', async () => {
  const state = freshState({
    rows: [makeRow({ owner_user_id: 'u1' })],
    bindings: [
      makeBinding({ household_id: HOUSEHOLD_A, deleted_at: '2026-07-05T00:00:00.000Z' }),
    ],
  });
  let emitted = 0;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    emitEvent: () => {
      emitted += 1;
      return Promise.resolve();
    },
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 200);
  assertEquals(((await res.json()) as UnbindEmailResponse).unbound, true);
  // No active binding matched → no event.
  assertEquals(emitted, 0);
});

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

Deno.test('handler returns 500 if the bindings UPDATE fails', async () => {
  const state = freshState({
    rows: [makeRow({ owner_user_id: 'u1' })],
    bindings: [makeBinding({ household_id: HOUSEHOLD_A })],
    forceBindingsError: { message: 'transient PG outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 500);
  // Binding still active.
  assertEquals(state.bindings[0].deleted_at, null);
});
