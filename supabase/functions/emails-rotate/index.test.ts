/**
 * emails-rotate tests — body validation, ownership gate, IMAP probe,
 * vault swap and metadata bump.
 *
 * Ref:  T-213, spec §9.3.1 + §E PATCH /emails/:id/rotate-password
 * Date: 2026-06-10
 *
 * The handler is exercised end-to-end via `buildHandler({...})` with the
 * IMAP, JWT and Supabase client deps stubbed (same pattern as
 * emails-connect/index.test.ts).
 *
 * Covered branches:
 *   - method gate (non-PATCH)                                → 405
 *   - missing path id                                         → 404
 *   - JWT missing                                             → 401
 *   - invalid body (validation)                               → 422
 *   - connected_emails row not found                          → 404
 *   - caller is not owner                                     → 403
 *   - row soft-deleted / status=revoked                        → 403
 *   - IMAP rejects new password                                → 401 imap_auth_failed
 *   - IMAP network error                                       → 502 imap_network_error
 *   - vault wrapper raises P0002 (secret missing)              → 404
 *   - happy path                                               → 200
 *                                                                + vault rpc called with SAME id
 *                                                                + connected_emails updated_at bumped
 *                                                                + consecutive_errors reset
 *                                                                + email.password_rotated event emitted
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  buildHandler,
  extractConnectedEmailId,
  type HandlerDeps,
  type RotatePasswordResponse,
  validateRotateBody,
} from './index.ts';
import type { ImapValidator } from '../emails-connect/index.ts';
import { nonNull } from '../_shared/_test_utils.ts';

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

Deno.test('extractConnectedEmailId parses the canonical /emails/:id/rotate-password URL', () => {
  const url = new URL('https://x.test/emails/11111111-1111-4111-8111-111111111111/rotate-password');
  assertEquals(extractConnectedEmailId(url), '11111111-1111-4111-8111-111111111111');
});

Deno.test('extractConnectedEmailId parses the Supabase function URL with id suffix', () => {
  const url = new URL(
    'https://x.test/functions/v1/emails-rotate/22222222-2222-4222-8222-222222222222',
  );
  assertEquals(extractConnectedEmailId(url), '22222222-2222-4222-8222-222222222222');
});

Deno.test('extractConnectedEmailId prefers ?id= query param when present', () => {
  const url = new URL(
    'https://x.test/functions/v1/emails-rotate?id=33333333-3333-4333-8333-333333333333',
  );
  assertEquals(extractConnectedEmailId(url), '33333333-3333-4333-8333-333333333333');
});

Deno.test('extractConnectedEmailId returns null on a malformed path', () => {
  const url = new URL('https://x.test/emails/not-a-uuid/rotate-password');
  assertEquals(extractConnectedEmailId(url), null);
});

Deno.test('validateRotateBody accepts Google-style spaced password', () => {
  const r = validateRotateBody({ new_app_password: 'abcd efgh ijkl mnop' });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.data.new_app_password_normalized, 'abcdefghijklmnop');
  }
});

Deno.test('validateRotateBody rejects digits', () => {
  const r = validateRotateBody({ new_app_password: 'abcd1234efgh5678' });
  assert(!r.ok);
});

Deno.test('validateRotateBody rejects wrong length', () => {
  const r = validateRotateBody({ new_app_password: 'short' });
  assert(!r.ok);
});

Deno.test('validateRotateBody rejects non-object body', () => {
  const r = validateRotateBody('nope');
  assert(!r.ok);
});

// ---------------------------------------------------------------------------
// Fake Supabase client — minimal builder covering what the handler exercises
// ---------------------------------------------------------------------------

type ConnectedEmailRow = {
  id: string;
  email_address: string;
  owner_user_id: string;
  app_password_secret: string;
  imap_host: string;
  imap_port: number;
  imap_use_tls: boolean;
  status: string;
  consecutive_errors: number;
  last_error: string | null;
  last_error_at: string | null;
  updated_at: string;
  deleted_at: string | null;
};

type FakeState = {
  rows: ConnectedEmailRow[];
  rpcCalls: Array<{ fn: string; args: unknown }>;
  /** Force a particular response from the next update_vault_secret rpc. */
  vaultRpcOverride?: { data: unknown; error: { code?: string; message: string } | null };
  /** Force an error from the next connected_emails UPDATE. */
  forceUpdateError?: { code?: string; message: string };
};

function uuid(): string {
  return crypto.randomUUID();
}

function makeRow(over: Partial<ConnectedEmailRow> = {}): ConnectedEmailRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email_address: 'a@b.co',
    owner_user_id: 'u1',
    app_password_secret: uuid(),
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_use_tls: true,
    status: 'active',
    consecutive_errors: 0,
    last_error: null,
    last_error_at: null,
    updated_at: '2026-06-10T00:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    rpc(fn: string, args: unknown) {
      state.rpcCalls.push({ fn, args });
      if (fn === 'update_vault_secret') {
        if (state.vaultRpcOverride) {
          const o = state.vaultRpcOverride;
          return Promise.resolve(o);
        }
        const a = args as { secret_id: string };
        // Default: echo back the same uuid (matches the wrapper contract)
        return Promise.resolve({ data: a.secret_id, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unhandled rpc ${fn}` } });
    },
    from(table: string) {
      if (table !== 'connected_emails') throw new Error(`unhandled table ${table}`);

      // SELECT builder
      // deno-lint-ignore no-explicit-any
      const filters: Array<(r: any) => boolean> = [];
      // deno-lint-ignore no-explicit-any
      let updatePatch: Record<string, unknown> | null = null;

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
          const matched = state.rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        // deno-lint-ignore no-explicit-any
        update(patch: any) {
          updatePatch = patch;
          return builder;
        },
      };

      // The `.update(patch).eq(...)` chain ultimately returns a promise — we
      // mimic that via a thenable returned from the *last* .eq() in chain.
      // Approach: shadow eq() with a thenable-returning variant when an
      // update patch is buffered.
      const originalEq = builder.eq.bind(builder);
      builder.eq = (col: string, val: unknown) => {
        if (updatePatch !== null) {
          // Apply the update once we receive the row-id filter.
          if (state.forceUpdateError) {
            const err = state.forceUpdateError;
            updatePatch = null;
            return Promise.resolve({ data: null, error: err });
          }
          const idx = state.rows.findIndex((r) => r[col as keyof ConnectedEmailRow] === val);
          if (idx >= 0) {
            state.rows[idx] = { ...state.rows[idx], ...updatePatch } as ConnectedEmailRow;
          }
          updatePatch = null;
          return Promise.resolve({ data: null, error: null });
        }
        return originalEq(col, val);
      };

      return builder;
    },
  };
}

function freshState(opts: Partial<FakeState> = {}): FakeState {
  return {
    rows: [],
    rpcCalls: [],
    ...opts,
  };
}

function callerStub(user: { id: string; email: string } | null): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

function imapStub(result: Awaited<ReturnType<ImapValidator>>): ImapValidator {
  return () => Promise.resolve(result);
}

function makeRequest(opts: {
  id?: string | null;
  body?: unknown;
  method?: string;
}): Request {
  const id = opts.id === undefined ? '11111111-1111-4111-8111-111111111111' : opts.id;
  const path = id === null
    ? 'https://x.test/emails/not-a-uuid/rotate-password'
    : `https://x.test/emails/${id}/rotate-password`;
  return new Request(path, {
    method: opts.method ?? 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: opts.body === undefined
      ? JSON.stringify({ new_app_password: 'wxyzabcdefghijkl' })
      : JSON.stringify(opts.body),
  });
}

const FIXED_NOW = new Date('2026-06-10T12:34:56.000Z');
function fixedNow() {
  return FIXED_NOW;
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

Deno.test('handler returns 405 for non-PATCH', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ method: 'POST' }));
  assertEquals(res.status, 405);
});

Deno.test('handler returns 404 when path id is invalid', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id: null }));
  assertEquals(res.status, 404);
});

Deno.test('handler returns 401 when JWT missing', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub(null),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 401);
});

Deno.test('handler returns 422 on validation failure', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(freshState()),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ body: { new_app_password: 'short' } }));
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error, 'validation_failed');
  assert(Array.isArray(body.details) && body.details.length >= 1);
});

Deno.test('handler returns 404 when connected_emails row missing', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(freshState()), // no rows
    now: fixedNow,
  });
  const res = await handler(makeRequest({}));
  assertEquals(res.status, 404);
});

Deno.test('handler returns 403 when caller is not owner', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({ rows: [makeRow({ id, owner_user_id: 'someone-else' })] });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, 'forbidden');
  // Vault MUST NOT be touched on auth failure
  assertEquals(state.rpcCalls.find((r) => r.fn === 'update_vault_secret'), undefined);
});

Deno.test('handler returns 403 when credential is revoked / soft-deleted', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    rows: [makeRow({ id, status: 'revoked', deleted_at: '2026-06-09T00:00:00.000Z' })],
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, 'credential_revoked');
});

Deno.test('handler returns 401 imap_auth_failed when IMAP rejects new password', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({ rows: [makeRow({ id })] });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'invalid_credentials' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, 'imap_auth_failed');
  // Vault MUST NOT be touched on IMAP failure
  assertEquals(state.rpcCalls.find((r) => r.fn === 'update_vault_secret'), undefined);
});

Deno.test('handler returns 502 imap_network_error on transport failure', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({ rows: [makeRow({ id })] });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'network_error', message: 'ECONNREFUSED [REDACTED]' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 502);
  // Vault MUST NOT be touched on network error
  assertEquals(state.rpcCalls.find((r) => r.fn === 'update_vault_secret'), undefined);
});

Deno.test('handler returns 404 when vault wrapper raises P0002', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    rows: [makeRow({ id })],
    vaultRpcOverride: {
      data: null,
      error: { code: 'P0002', message: 'Vault secret not found' },
    },
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, 'vault_secret_not_found');
});

Deno.test('handler happy path: 200 + vault swap + metadata bump + event', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const oldSecretId = '99999999-9999-4999-8999-999999999999';
  const state = freshState({
    rows: [
      makeRow({
        id,
        owner_user_id: 'u1',
        app_password_secret: oldSecretId,
        status: 'error', // proves successful rotation flips back to active
        consecutive_errors: 7,
        last_error: 'IMAP auth failed last week',
        last_error_at: '2026-06-08T00:00:00.000Z',
        updated_at: '2026-06-08T00:00:00.000Z',
      }),
    ],
  });
  let emitted: { type: string; aggregate_id: string; payload: unknown } | null = null;
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = { type: e.type, aggregate_id: e.aggregate_id, payload: e.payload };
      return Promise.resolve();
    },
    now: fixedNow,
  });

  const res = await handler(makeRequest({ id, body: { new_app_password: 'wxyzabcdefghijkl' } }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as RotatePasswordResponse;
  assertEquals(body.rotated_at, FIXED_NOW.toISOString());

  // Vault was called with the SAME secret_id (in-place mutation)
  const vaultCalls = state.rpcCalls.filter((r) => r.fn === 'update_vault_secret');
  assertEquals(vaultCalls.length, 1);
  const vaultArgs = vaultCalls[0].args as {
    secret_id: string;
    new_value: string;
    new_name: string;
    new_description: string;
  };
  assertEquals(vaultArgs.secret_id, oldSecretId);
  assertEquals(vaultArgs.new_value, 'wxyzabcdefghijkl');
  assert(vaultArgs.new_name.startsWith('gmail_app_pwd:a@b.co'));
  assert(vaultArgs.new_description.includes('Rotated at'));
  assert(vaultArgs.new_description.includes('u1'));

  // connected_emails row mutated:
  //   * app_password_secret unchanged (in-place rotation)
  //   * status flipped back to active
  //   * consecutive_errors reset to 0
  //   * last_error/last_error_at cleared
  //   * updated_at bumped to FIXED_NOW
  const row = state.rows[0];
  assertEquals(row.app_password_secret, oldSecretId);
  assertEquals(row.status, 'active');
  assertEquals(row.consecutive_errors, 0);
  assertEquals(row.last_error, null);
  assertEquals(row.last_error_at, null);
  assertEquals(row.updated_at, FIXED_NOW.toISOString());

  // domain_event emitted
  assert(emitted !== null);
  const emittedEvent = nonNull<{ type: string; aggregate_id: string; payload: unknown }>(emitted);
  assertEquals(emittedEvent.type, 'email.password_rotated');
  assertEquals(emittedEvent.aggregate_id, id);
  const payload = emittedEvent.payload as { version: number; data: Record<string, unknown> };
  assertEquals(payload.version, 1);
  assertEquals(payload.data.vault_secret_id, oldSecretId);
  assertEquals(payload.data.rotated_at, FIXED_NOW.toISOString());
  assertEquals(payload.data.email_address, 'a@b.co');
});

Deno.test('handler still returns 200 when metadata UPDATE fails (vault already rotated)', async () => {
  // The rotation is irreversible — we must surface success to the user and
  // log the metadata bump failure for the operator runbook.
  const id = '11111111-1111-4111-8111-111111111111';
  const oldSecretId = '99999999-9999-4999-8999-999999999999';
  const state = freshState({
    rows: [makeRow({ id, app_password_secret: oldSecretId })],
    forceUpdateError: { message: 'transient PG outage' },
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  const res = await handler(makeRequest({ id }));
  assertEquals(res.status, 200);
  // Vault rpc still fired
  assertEquals(state.rpcCalls.filter((r) => r.fn === 'update_vault_secret').length, 1);
});

Deno.test('handler propagates the same path id into rpc args (no UUID drift)', async () => {
  // Regression guard — make sure we pass the row's app_password_secret to
  // the rpc, NOT the connected_emails.id from the URL.
  const id = '11111111-1111-4111-8111-111111111111';
  const vaultId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const state = freshState({
    rows: [makeRow({ id, app_password_secret: vaultId })],
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    now: fixedNow,
  });
  await handler(makeRequest({ id }));
  const args = state.rpcCalls.find((r) => r.fn === 'update_vault_secret')!.args as {
    secret_id: string;
  };
  assertEquals(args.secret_id, vaultId);
  assert(args.secret_id !== id);
});
