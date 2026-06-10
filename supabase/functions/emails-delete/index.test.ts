/**
 * emails-delete tests — method/path gates, ownership/sys-admin gate, soft
 * delete cascade (row + bindings), vault hard-delete, and event emission.
 *
 * Ref:  T-214, spec §9.3.1 ("System admin pode 'revogar acesso'") + §E DELETE /emails/:id
 * Date: 2026-06-10
 *
 * The handler is exercised end-to-end via `buildHandler({...})` with the JWT
 * and Supabase client deps stubbed (same pattern as emails-rotate / emails-connect).
 *
 * Covered branches:
 *   - method gate (non-DELETE)                                        → 405
 *   - malformed path / missing id                                      → 404
 *   - JWT missing                                                      → 401
 *   - connected_emails row not found                                   → 404
 *   - caller is neither owner nor sys admin                            → 403
 *                                                                       + vault rpc NOT called
 *                                                                       + bindings NOT touched
 *   - row already soft-deleted (idempotent re-call)                    → 200
 *                                                                       + vault rpc NOT called again
 *                                                                       + no second event emitted
 *   - happy path as OWNER                                              → 200
 *                                                                       + bindings soft-deleted
 *                                                                       + connected_emails.deleted_at + status='revoked'
 *                                                                       + vault rpc called with secret_id
 *                                                                       + email.revoked emitted
 *   - happy path as SYSTEM ADMIN (non-owner)                           → 200
 *                                                                       + event payload by_system_admin=true
 *   - vault rpc returns error → 200 (we already soft-deleted, log + continue)
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
import { nonNull } from '../_shared/_test_utils.ts';
  buildHandler,
  extractConnectedEmailId,
  type DeleteEmailResponse,
  type HandlerDeps,
} from './index.ts';

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

Deno.test('extractConnectedEmailId parses /emails/:id', () => {
  const url = new URL('https://x.test/emails/11111111-1111-4111-8111-111111111111');
  assertEquals(extractConnectedEmailId(url), '11111111-1111-4111-8111-111111111111');
});

Deno.test('extractConnectedEmailId parses /emails/:id/ (trailing slash)', () => {
  const url = new URL('https://x.test/emails/11111111-1111-4111-8111-111111111111/');
  assertEquals(extractConnectedEmailId(url), '11111111-1111-4111-8111-111111111111');
});

Deno.test('extractConnectedEmailId parses the Supabase function URL with id suffix', () => {
  const url = new URL(
    'https://x.test/functions/v1/emails-delete/22222222-2222-4222-8222-222222222222',
  );
  assertEquals(extractConnectedEmailId(url), '22222222-2222-4222-8222-222222222222');
});

Deno.test('extractConnectedEmailId prefers ?id= query param when present', () => {
  const url = new URL(
    'https://x.test/functions/v1/emails-delete?id=33333333-3333-4333-8333-333333333333',
  );
  assertEquals(extractConnectedEmailId(url), '33333333-3333-4333-8333-333333333333');
});

Deno.test('extractConnectedEmailId returns null on a malformed path', () => {
  const url = new URL('https://x.test/emails/not-a-uuid');
  assertEquals(extractConnectedEmailId(url), null);
});

Deno.test('extractConnectedEmailId rejects sibling endpoints (/emails/:id/rotate-password)', () => {
  // Defensive — this endpoint owns /emails/:id only; siblings like
  // /emails/:id/rotate-password must NOT match.
  const url = new URL('https://x.test/emails/11111111-1111-4111-8111-111111111111/rotate-password');
  assertEquals(extractConnectedEmailId(url), null);
});

// ---------------------------------------------------------------------------
// Fake Supabase client — minimal builder covering what the handler exercises
// ---------------------------------------------------------------------------

type ConnectedEmailRow = {
  id: string;
  email_address: string;
  owner_user_id: string;
  app_password_secret: string;
  status: string;
  updated_at: string;
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
  rpcCalls: Array<{ fn: string; args: unknown }>;
  /** Force a particular response from the next delete_vault_secret rpc. */
  vaultRpcOverride?: { data: unknown; error: { message: string } | null };
  /** Force an error from the next connected_emails UPDATE. */
  forceRevokeError?: { message: string };
  /** Force an error from the next connected_email_households UPDATE. */
  forceBindingsError?: { message: string };
  /** Force an error from the connected_emails SELECT. */
  forceLoadError?: { message: string };
};

function makeRow(over: Partial<ConnectedEmailRow> = {}): ConnectedEmailRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email_address: 'a@b.co',
    owner_user_id: 'u1',
    app_password_secret: '99999999-9999-4999-8999-999999999999',
    status: 'active',
    updated_at: '2026-06-10T00:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

function makeBinding(over: Partial<BindingRow> = {}): BindingRow {
  return {
    id: crypto.randomUUID(),
    connected_email_id: '11111111-1111-4111-8111-111111111111',
    household_id: crypto.randomUUID(),
    updated_at: '2026-06-10T00:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

/**
 * Tiny fake that supports the chain shapes the handler uses:
 *   - connected_emails:
 *       .select(cols).eq('id', id).maybeSingle()
 *       .update(patch).eq('id', id).is('deleted_at', null)
 *   - connected_email_households:
 *       .update(patch).eq('connected_email_id', id).is('deleted_at', null)
 *   - rpc('delete_vault_secret', { secret_id })
 */
// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    rpc(fn: string, args: unknown) {
      state.rpcCalls.push({ fn, args });
      if (fn === 'delete_vault_secret') {
        if (state.vaultRpcOverride) return Promise.resolve(state.vaultRpcOverride);
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unhandled rpc ${fn}` } });
    },
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
  let updatePatch: Record<string, unknown> | null = null;
  let mode: 'select' | 'update' = 'select';

  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select(_cols: string) {
      mode = 'select';
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
      // Only `deleted_at IS NULL` is exercised by the handler.
      filters.push((r) => r[col] === val);
      // `.is()` is terminal for UPDATE chains in PostgREST — resolve here.
      if (mode === 'update') {
        return resolveUpdate();
      }
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

  function resolveUpdate() {
    if (state.forceRevokeError) {
      return Promise.resolve({ data: null, error: state.forceRevokeError });
    }
    const matches = state.rows.filter((r) => filters.every((f) => f(r)));
    for (const m of matches) {
      const idx = state.rows.indexOf(m);
      state.rows[idx] = { ...m, ...updatePatch } as ConnectedEmailRow;
    }
    return Promise.resolve({ data: null, error: null });
  }

  return builder;
}

// deno-lint-ignore no-explicit-any
function buildBindingsBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];
  // deno-lint-ignore no-explicit-any
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
      // `.is()` is the terminal call for the bindings UPDATE.
      if (state.forceBindingsError) {
        return Promise.resolve({ data: null, error: state.forceBindingsError });
      }
      const matches = state.bindings.filter((b) => filters.every((f) => f(b)));
      for (const m of matches) {
        const idx = state.bindings.indexOf(m);
        state.bindings[idx] = { ...m, ...updatePatch } as BindingRow;
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  return builder;
}

function freshState(opts: Partial<FakeState> = {}): FakeState {
  return {
    rows: [],
    bindings: [],
    rpcCalls: [],
    ...opts,
  };
}

function callerStub(user: { id: string; isSystemAdmin: boolean } | null): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

function makeRequest(opts: {
  id?: string | null;
  method?: string;
} = {}): Request {
  const id = opts.id === undefined ? '11111111-1111-4111-8111-111111111111' : opts.id;
  const path = id === null
    ? 'https://x.test/emails/not-a-uuid'
    : `https://x.test/emails/${id}`;
  return new Request(path, {
    method: opts.method ?? 'DELETE',
  });
}

const FIXED_NOW = new Date('2026-06-10T12:34:56.000Z');
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
  const res = await handler(makeRequest({ method: 'POST' }));
  assertEquals(res.status, 405);
});

Deno.test('handler returns 404 when path id is invalid', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id: null }));
  assertEquals(res.status, 404);
});

Deno.test('handler returns 401 when JWT missing', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub(null),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 401);
});

Deno.test('handler returns 404 when connected_emails row missing', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 404);
});

Deno.test('handler returns 500 when initial SELECT errors', async () => {
  const state = freshState({ forceLoadError: { message: 'PG outage' } });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 500);
  // No state mutation should have happened
  assertEquals(state.rpcCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Authorization gate — owner vs sys admin vs neither
// ---------------------------------------------------------------------------

Deno.test('handler returns 403 when caller is neither owner nor sys admin', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const secretId = '99999999-9999-4999-8999-999999999999';
  const state = freshState({
    rows: [makeRow({ id, owner_user_id: 'someone-else', app_password_secret: secretId })],
    bindings: [makeBinding({ connected_email_id: id })],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, 'forbidden');
  // Bindings must NOT be touched on auth failure
  assert(state.bindings[0].deleted_at === null);
  // Vault must NOT be touched on auth failure
  assertEquals(state.rpcCalls.find((r) => r.fn === 'delete_vault_secret'), undefined);
  // Credential row untouched
  assertEquals(state.rows[0].status, 'active');
  assertEquals(state.rows[0].deleted_at, null);
});

// ---------------------------------------------------------------------------
// Idempotency: already-revoked row
// ---------------------------------------------------------------------------

Deno.test('handler returns 200 for already soft-deleted credential (idempotent re-call)', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    rows: [makeRow({
      id,
      owner_user_id: 'u1',
      status: 'revoked',
      deleted_at: '2026-06-09T00:00:00.000Z',
    })],
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
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as DeleteEmailResponse;
  assertEquals(body.soft_deleted, true);
  // Vault rpc NOT called on idempotent re-call
  assertEquals(state.rpcCalls.find((r) => r.fn === 'delete_vault_secret'), undefined);
  // No second event emitted
  assertEquals(emitted, 0);
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

Deno.test('handler happy path as OWNER: 200 + cascade soft-delete + vault hard-delete + event', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const secretId = '99999999-9999-4999-8999-999999999999';
  const householdA = crypto.randomUUID();
  const householdB = crypto.randomUUID();
  const state = freshState({
    rows: [makeRow({ id, owner_user_id: 'u1', app_password_secret: secretId })],
    bindings: [
      makeBinding({ connected_email_id: id, household_id: householdA }),
      makeBinding({ connected_email_id: id, household_id: householdB }),
      // Unrelated binding to a DIFFERENT credential — MUST stay untouched.
      makeBinding({
        connected_email_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        household_id: householdA,
      }),
    ],
  });
  let emitted: { type: string; aggregate_id: string; payload: unknown } | null = null;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = { type: e.type, aggregate_id: e.aggregate_id, payload: e.payload };
      return Promise.resolve();
    },
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as DeleteEmailResponse;
  assertEquals(body.soft_deleted, true);

  // Credential row: deleted_at + status=revoked + updated_at bumped
  const row = state.rows[0];
  assertEquals(row.deleted_at, FIXED_NOW.toISOString());
  assertEquals(row.status, 'revoked');
  assertEquals(row.updated_at, FIXED_NOW.toISOString());
  // app_password_secret preserved for audit linkage
  assertEquals(row.app_password_secret, secretId);

  // Bindings: only the two targeting this credential are soft-deleted.
  const targetBindings = state.bindings.filter((b) => b.connected_email_id === id);
  for (const b of targetBindings) {
    assertEquals(b.deleted_at, FIXED_NOW.toISOString());
    assertEquals(b.updated_at, FIXED_NOW.toISOString());
  }
  const unrelated = state.bindings.find((b) =>
    b.connected_email_id !== id
  );
  assert(unrelated !== undefined);
  assertEquals(unrelated!.deleted_at, null);

  // Vault: rpc called exactly once with the credential's secret_id.
  const vaultCalls = state.rpcCalls.filter((r) => r.fn === 'delete_vault_secret');
  assertEquals(vaultCalls.length, 1);
  const args = vaultCalls[0].args as { secret_id: string };
  assertEquals(args.secret_id, secretId);

  // Event: email.revoked with correct payload
  assert(emitted !== null);
  const emittedEvent = nonNull(emitted);
  assertEquals(emittedEvent.type, 'email.revoked');
  assertEquals(emittedEvent.aggregate_id, id);
  const payload = emittedEvent.payload as { version: number; data: Record<string, unknown> };
  assertEquals(payload.version, 1);
  assertEquals(payload.data.vault_secret_id, secretId);
  assertEquals(payload.data.revoked_at, FIXED_NOW.toISOString());
  assertEquals(payload.data.email_address, 'a@b.co');
  assertEquals(payload.data.by_system_admin, false);
});

Deno.test('handler happy path as SYSTEM ADMIN (non-owner): 200 + payload by_system_admin=true', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const secretId = '99999999-9999-4999-8999-999999999999';
  const state = freshState({
    rows: [makeRow({ id, owner_user_id: 'someone-else', app_password_secret: secretId })],
    bindings: [makeBinding({ connected_email_id: id })],
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
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 200);
  // Row soft-deleted + revoked
  assertEquals(state.rows[0].status, 'revoked');
  assertEquals(state.rows[0].deleted_at, FIXED_NOW.toISOString());
  // Vault destroyed
  assertEquals(state.rpcCalls.filter((r) => r.fn === 'delete_vault_secret').length, 1);
  // Event flags sys admin actor
  assert(emitted !== null);
  const emittedEvent = nonNull(emitted);
  const payload = emittedEvent.payload as { data: { by_system_admin: boolean } };
  assertEquals(payload.data.by_system_admin, true);
});

// ---------------------------------------------------------------------------
// Vault failure tolerance
// ---------------------------------------------------------------------------

Deno.test('handler still returns 200 when vault rpc errors (credential is already soft-deleted)', async () => {
  // The credential row + bindings are already revoked at this point. Failing
  // the vault delete leaves an operator-recoverable orphan secret, but the
  // user-visible revocation is complete.
  const id = '11111111-1111-4111-8111-111111111111';
  const secretId = '99999999-9999-4999-8999-999999999999';
  const state = freshState({
    rows: [makeRow({ id, owner_user_id: 'u1', app_password_secret: secretId })],
    bindings: [makeBinding({ connected_email_id: id })],
    vaultRpcOverride: { data: null, error: { message: 'transient vault outage' } },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 200);
  // Row + bindings still soft-deleted
  assertEquals(state.rows[0].deleted_at, FIXED_NOW.toISOString());
  assertEquals(state.rows[0].status, 'revoked');
  assertEquals(state.bindings[0].deleted_at, FIXED_NOW.toISOString());
});

Deno.test('handler treats vault rpc returning false (already-gone) as success', async () => {
  // The wrapper returns FALSE when the row was already missing (idempotent).
  // The handler must accept it as success — not raise, not 500.
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    rows: [makeRow({ id, owner_user_id: 'u1' })],
    bindings: [makeBinding({ connected_email_id: id })],
    vaultRpcOverride: { data: false, error: null },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 200);
});

// ---------------------------------------------------------------------------
// Failure cascade — bindings UPDATE error stops the flow
// ---------------------------------------------------------------------------

Deno.test('handler returns 500 if bindings UPDATE fails (credential left intact)', async () => {
  // If we cannot soft-delete the bindings, we DO NOT proceed to revoke the
  // credential or destroy the vault. Operator sees a clean 500 and can retry.
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    rows: [makeRow({ id, owner_user_id: 'u1' })],
    bindings: [makeBinding({ connected_email_id: id })],
    forceBindingsError: { message: 'transient PG outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 500);
  // Vault MUST NOT be touched
  assertEquals(state.rpcCalls.find((r) => r.fn === 'delete_vault_secret'), undefined);
  // Credential row still active
  assertEquals(state.rows[0].deleted_at, null);
  assertEquals(state.rows[0].status, 'active');
});

Deno.test('handler returns 500 if credential UPDATE fails (bindings already revoked)', async () => {
  // If the credential UPDATE fails AFTER bindings were soft-deleted, we
  // surface 500. The bindings are now in an inconsistent intermediate state
  // (revoked while credential remains active) — operators see the 500 log
  // and either re-run DELETE (idempotent) or fix manually. Better than
  // silently leaving an active credential with no live bindings.
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    rows: [makeRow({ id, owner_user_id: 'u1' })],
    bindings: [makeBinding({ connected_email_id: id })],
    forceRevokeError: { message: 'transient PG outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', isSystemAdmin: false }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 500);
  // Vault MUST NOT be touched (we never reached step 8)
  assertEquals(state.rpcCalls.find((r) => r.fn === 'delete_vault_secret'), undefined);
});
