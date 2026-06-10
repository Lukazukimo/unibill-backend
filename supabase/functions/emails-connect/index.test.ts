/**
 * emails-connect tests — body validation, IMAP gating, vault + insert flow.
 *
 * Ref:  T-212, spec §9.3.1 + §E POST /emails/connect + §6.4 IMAP
 * Date: 2026-06-10
 *
 * The handler is exercised end-to-end via `buildHandler({...})` with the
 * IMAP, JWT and Supabase client deps stubbed. We do NOT spin up imapflow
 * here (it would attempt npm: import + real TCP).
 *
 * Covered branches:
 *   - validation: invalid email, invalid app_password length/charset, missing
 *                 household_ids → 422 with field-level details
 *   - JWT missing                                            → 401
 *   - caller not admin of a requested household              → 403
 *   - email already owned by ANOTHER user (pre-flight)       → 409
 *   - IMAP rejects credentials                               → 401 imap_auth_failed
 *   - IMAP network error                                     → 502 imap_network_error
 *   - happy path                                             → 200 + bindings
 *                                                              + vault rpc called
 *                                                              + connected_emails inserted
 *                                                              + bindings inserted with first=default
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  buildHandler,
  type ConnectEmailResponse,
  type HandlerDeps,
  type ImapValidator,
  normalizeAppPassword,
  validateConnectBody,
} from './index.ts';

// ---------------------------------------------------------------------------
// Pure-function tests (no client, no IMAP)
// ---------------------------------------------------------------------------

Deno.test('normalizeAppPassword strips whitespace and lowercases', () => {
  assertEquals(normalizeAppPassword('ABCD EFGH IJKL MNOP'), 'abcdefghijklmnop');
  assertEquals(normalizeAppPassword('  abcd  efgh\tijkl mnop  '), 'abcdefghijklmnop');
  assertEquals(normalizeAppPassword('abcdefghijklmnop'), 'abcdefghijklmnop');
});

Deno.test('validateConnectBody accepts a Google-style app password with spaces', () => {
  const r = validateConnectBody({
    email_address: 'Foo.Bar@Example.COM',
    app_password: 'abcd efgh ijkl mnop',
    household_ids: ['11111111-1111-4111-8111-111111111111'],
  });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.data.email_address, 'foo.bar@example.com');
    assertEquals(r.data.app_password_normalized, 'abcdefghijklmnop');
    assertEquals(r.data.household_ids, ['11111111-1111-4111-8111-111111111111']);
  }
});

Deno.test('validateConnectBody rejects short app_password', () => {
  const r = validateConnectBody({
    email_address: 'a@b.co',
    app_password: 'short',
    household_ids: ['11111111-1111-4111-8111-111111111111'],
  });
  assert(!r.ok);
  if (!r.ok) {
    assert(r.errors.some((e) => e.field === 'app_password'));
  }
});

Deno.test('validateConnectBody rejects app_password with digits', () => {
  const r = validateConnectBody({
    email_address: 'a@b.co',
    app_password: 'abcd1234efgh5678',
    household_ids: ['11111111-1111-4111-8111-111111111111'],
  });
  assert(!r.ok);
  if (!r.ok) {
    assert(r.errors.some((e) => e.field === 'app_password'));
  }
});

Deno.test('validateConnectBody rejects bad email', () => {
  const r = validateConnectBody({
    email_address: 'not-an-email',
    app_password: 'abcdefghijklmnop',
    household_ids: ['11111111-1111-4111-8111-111111111111'],
  });
  assert(!r.ok);
});

Deno.test('validateConnectBody rejects empty household_ids', () => {
  const r = validateConnectBody({
    email_address: 'a@b.co',
    app_password: 'abcdefghijklmnop',
    household_ids: [],
  });
  assert(!r.ok);
});

Deno.test('validateConnectBody rejects non-UUID household_ids', () => {
  const r = validateConnectBody({
    email_address: 'a@b.co',
    app_password: 'abcdefghijklmnop',
    household_ids: ['not-a-uuid'],
  });
  assert(!r.ok);
});

Deno.test('validateConnectBody dedupes inside household_ids', () => {
  const r = validateConnectBody({
    email_address: 'a@b.co',
    app_password: 'abcdefghijklmnop',
    household_ids: [
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ],
  });
  assert(!r.ok);
  if (!r.ok) {
    assert(r.errors.some((e) => e.message === 'duplicate household_id'));
  }
});

// ---------------------------------------------------------------------------
// Fake Supabase client — minimal builder covering what the handler exercises
// ---------------------------------------------------------------------------

type ConnectedEmailRow = {
  id: string;
  email_address: string;
  owner_user_id: string;
  provider: string;
  app_password_secret: string;
  imap_host: string;
  imap_port: number;
  imap_use_tls: boolean;
  status: string;
  consecutive_errors: number;
  deleted_at: string | null;
};

type BindingRow = {
  id: string;
  connected_email_id: string;
  household_id: string;
  is_default: boolean;
};

type MemberRow = {
  user_id: string;
  household_id: string;
  role: 'admin' | 'member';
};

type FakeState = {
  /** Pre-existing connected_emails rows (used by pre-flight 409 check). */
  connectedEmails: ConnectedEmailRow[];
  bindings: BindingRow[];
  /** Rows in public.members visible to the tenant-guard SELECT. */
  adminMemberships: MemberRow[];
  vaultSecrets: Set<string>;
  /** Captures rpc invocations for assertion. */
  rpcCalls: Array<{ fn: string; args: unknown }>;
  /** Force an error from the next insert into connected_emails. */
  forceInsertError?: { code?: string; message: string };
  /** Force an error from the next binding insert. */
  forceBindError?: { code?: string; message: string };
};

function uuid(): string {
  return crypto.randomUUID();
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    rpc(fn: string, args: unknown) {
      state.rpcCalls.push({ fn, args });
      if (fn === 'create_vault_secret') {
        const id = uuid();
        state.vaultSecrets.add(id);
        return Promise.resolve({ data: id, error: null });
      }
      if (fn === 'delete_vault_secret') {
        const a = args as { secret_id: string };
        state.vaultSecrets.delete(a.secret_id);
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unhandled rpc ${fn}` } });
    },
    from(table: string) {
      // ------------------------------------------------------------------
      // SELECT builder — only what the handler invokes.
      // ------------------------------------------------------------------
      // deno-lint-ignore no-explicit-any
      const selectBuilder = (rows: any[]) => {
        // deno-lint-ignore no-explicit-any
        const filters: Array<(r: any) => boolean> = [];
        // deno-lint-ignore no-explicit-any
        const b: any = {
          select(_cols: string) {
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
          limit(_n: number) {
            return Promise.resolve({
              data: rows.filter((r) => filters.every((f) => f(r))),
              error: null,
            });
          },
          single() {
            const matched = rows.filter((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data: matched[0] ?? null, error: null });
          },
        };
        return b;
      };

      // deno-lint-ignore no-explicit-any
      const insertBuilder = (sink: any[], force?: { code?: string; message: string }) => ({
        // deno-lint-ignore no-explicit-any
        insert(values: any) {
          if (force) {
            return {
              select(_cols?: string) {
                return {
                  single() {
                    return Promise.resolve({ data: null, error: force });
                  },
                  // Thenable so `await .insert().select()` resolves directly
                  // (the bindings-array path uses this shape).
                  then(resolve: (v: { data: null; error: typeof force }) => unknown) {
                    return resolve({ data: null, error: force });
                  },
                };
              },
            };
          }
          const list = Array.isArray(values) ? values : [values];
          const inserted = list.map((v) => ({ id: uuid(), ...v }));
          sink.push(...inserted);
          return {
            select(_cols?: string) {
              return {
                single() {
                  return Promise.resolve({ data: inserted[0], error: null });
                },
                then(resolve: (v: { data: typeof inserted; error: null }) => unknown) {
                  return resolve({ data: inserted, error: null });
                },
              };
            },
          };
        },
        delete() {
          return {
            eq(_col: string, val: unknown) {
              const idx = sink.findIndex((r) => r.id === val);
              if (idx >= 0) sink.splice(idx, 1);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      });

      if (table === 'connected_emails') {
        return {
          ...selectBuilder(state.connectedEmails),
          ...insertBuilder(state.connectedEmails, state.forceInsertError),
        };
      }
      if (table === 'connected_email_households') {
        return insertBuilder(state.bindings, state.forceBindError);
      }
      if (table === 'members') {
        // Bespoke filter chain used by the admin tenant guard:
        //   .select('household_id').eq(user_id).eq(role).is(deleted_at, null)
        //   .in('household_id', household_ids)
        // deno-lint-ignore no-explicit-any
        const b: any = {
          _userId: null as string | null,
          _role: null as string | null,
          _deletedNull: false,
          _householdIds: [] as string[],
          select(_c: string) {
            return b;
          },
          eq(col: string, val: unknown) {
            if (col === 'user_id') b._userId = val as string;
            if (col === 'role') b._role = val as string;
            return b;
          },
          is(col: string, val: unknown) {
            if (col === 'deleted_at' && val === null) b._deletedNull = true;
            return b;
          },
          in(_col: string, vals: string[]) {
            b._householdIds = vals;
            // Resolve only when .in() is called (terminal in the handler chain).
            const matches = state.adminMemberships.filter((m) =>
              m.user_id === b._userId
              && m.role === b._role
              && b._householdIds.includes(m.household_id)
            );
            return Promise.resolve({
              data: matches.map((m) => ({ household_id: m.household_id })),
              error: null,
            });
          },
        };
        return b;
      }
      throw new Error(`unhandled table ${table}`);
    },
  };
}

function freshState(opts: Partial<FakeState> = {}): FakeState {
  return {
    connectedEmails: [],
    bindings: [],
    adminMemberships: [],
    vaultSecrets: new Set(),
    rpcCalls: [],
    ...opts,
  };
}

/** Convenience: build a list of admin memberships for one user across N households. */
function adminsOf(userId: string, householdIds: string[]): MemberRow[] {
  return householdIds.map((h) => ({ user_id: userId, household_id: h, role: 'admin' as const }));
}

function callerStub(user: { id: string; email: string } | null): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

function imapStub(result: Awaited<ReturnType<ImapValidator>>): ImapValidator {
  return () => Promise.resolve(result);
}

function makeRequest(body: unknown): Request {
  return new Request('https://x.test/fn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

Deno.test('handler returns 405 for non-POST', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(freshState()),
  });
  const res = await handler(new Request('https://x', { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('handler returns 401 when JWT missing', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub(null),
    client: makeFakeClient(freshState()),
  });
  const res = await handler(
    makeRequest({
      email_address: 'a@b.co',
      app_password: 'abcdefghijklmnop',
      household_ids: ['11111111-1111-4111-8111-111111111111'],
    }),
  );
  assertEquals(res.status, 401);
});

Deno.test('handler returns 422 on validation failure', async () => {
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(freshState()),
  });
  const res = await handler(
    makeRequest({
      email_address: 'bad',
      app_password: 'short',
      household_ids: [],
    }),
  );
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error, 'validation_failed');
  assert(Array.isArray(body.details) && body.details.length >= 1);
});

Deno.test('handler returns 403 when caller is not admin of household', async () => {
  const householdId = '11111111-1111-4111-8111-111111111111';
  const state = freshState(); // empty admins map → caller is NOT admin
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
  });
  const res = await handler(
    makeRequest({
      email_address: 'a@b.co',
      app_password: 'abcdefghijklmnop',
      household_ids: [householdId],
    }),
  );
  assertEquals(res.status, 403);
});

Deno.test('handler returns 409 when email already owned by another user', async () => {
  const householdId = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    adminMemberships: adminsOf('u1', [householdId]),
    connectedEmails: [
      {
        id: uuid(),
        email_address: 'a@b.co',
        owner_user_id: 'u2-other',
        provider: 'gmail',
        app_password_secret: uuid(),
        imap_host: 'imap.gmail.com',
        imap_port: 993,
        imap_use_tls: true,
        status: 'active',
        consecutive_errors: 0,
        deleted_at: null,
      },
    ],
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
  });
  const res = await handler(
    makeRequest({
      email_address: 'a@b.co',
      app_password: 'abcdefghijklmnop',
      household_ids: [householdId],
    }),
  );
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, 'email_already_owned');
});

Deno.test('handler returns 401 imap_auth_failed when IMAP rejects', async () => {
  const householdId = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    adminMemberships: adminsOf('u1', [householdId]),
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'invalid_credentials' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
  });
  const res = await handler(
    makeRequest({
      email_address: 'a@b.co',
      app_password: 'abcdefghijklmnop',
      household_ids: [householdId],
    }),
  );
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, 'imap_auth_failed');
  // Vault MUST NOT be touched on IMAP failure
  assertEquals(
    state.rpcCalls.find((r) => r.fn === 'create_vault_secret'),
    undefined,
  );
});

Deno.test('handler returns 502 imap_network_error on transport failure', async () => {
  const householdId = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    adminMemberships: adminsOf('u1', [householdId]),
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'network_error', message: 'ECONNREFUSED [REDACTED]' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
  });
  const res = await handler(
    makeRequest({
      email_address: 'a@b.co',
      app_password: 'abcdefghijklmnop',
      household_ids: [householdId],
    }),
  );
  assertEquals(res.status, 502);
});

Deno.test('handler happy path: 200 with bindings + vault + insert', async () => {
  const householdA = '11111111-1111-4111-8111-111111111111';
  const householdB = '22222222-2222-4222-8222-222222222222';
  const state = freshState({
    adminMemberships: adminsOf('u1', [householdA, householdB]),
  });
  let emittedEvent: { type: string; aggregate_id: string } | null = null;
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emittedEvent = { type: e.type, aggregate_id: e.aggregate_id };
      return Promise.resolve();
    },
  });

  const res = await handler(
    makeRequest({
      email_address: 'a@b.co',
      app_password: 'abcd efgh ijkl mnop', // spaces OK
      household_ids: [householdA, householdB],
    }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as ConnectEmailResponse;
  assert(body.connected_email_id);
  assertEquals(body.household_bindings.length, 2);

  // First binding is the default per handler convention
  const aBind = body.household_bindings.find((b) => b.household_id === householdA);
  const bBind = body.household_bindings.find((b) => b.household_id === householdB);
  assert(aBind && bBind);
  assertEquals(aBind!.is_default, true);
  assertEquals(bBind!.is_default, false);

  // Vault was called exactly once
  const vaultCalls = state.rpcCalls.filter((r) => r.fn === 'create_vault_secret');
  assertEquals(vaultCalls.length, 1);

  // connected_emails row landed with the correct shape
  assertEquals(state.connectedEmails.length, 1);
  const row = state.connectedEmails[0];
  assertEquals(row.email_address, 'a@b.co');
  assertEquals(row.owner_user_id, 'u1');
  assertEquals(row.provider, 'gmail');
  assertEquals(row.imap_host, 'imap.gmail.com');
  assertEquals(row.imap_port, 993);
  assertEquals(row.imap_use_tls, true);

  // bindings landed
  assertEquals(state.bindings.length, 2);

  // domain_event emitted
  assert(emittedEvent !== null);
  assertEquals(emittedEvent!.type, 'email.connected');
  assertEquals(emittedEvent!.aggregate_id, body.connected_email_id);
});

Deno.test('handler maps 23505 from connected_emails insert race to 409', async () => {
  const householdId = '11111111-1111-4111-8111-111111111111';
  const state = freshState({
    adminMemberships: adminsOf('u1', [householdId]),
    forceInsertError: { code: '23505', message: 'duplicate key violates uq_connected_emails_email_address' },
  });
  const handler = buildHandler({
    validateImap: imapStub({ kind: 'ok' }),
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
  });
  const res = await handler(
    makeRequest({
      email_address: 'a@b.co',
      app_password: 'abcdefghijklmnop',
      household_ids: [householdId],
    }),
  );
  assertEquals(res.status, 409);

  // Vault secret was compensated (created then deleted)
  const created = state.rpcCalls.filter((r) => r.fn === 'create_vault_secret').length;
  const deleted = state.rpcCalls.filter((r) => r.fn === 'delete_vault_secret').length;
  assertEquals(created, 1);
  assertEquals(deleted, 1);
});
