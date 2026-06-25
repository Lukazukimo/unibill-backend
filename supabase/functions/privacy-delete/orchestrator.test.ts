/**
 * privacy-delete orchestrator tests — the §9.4 deletion sequence: soft-delete
 * memberships + owned emails (with vault-secret deletes), drop sys-admin grants,
 * anonymize (invoices REMAIN, audit FKs → sentinel), emit user.deleted, then
 * auth deleteUser. Plus: vault errors are best-effort, anonymize errors are
 * fatal, and the whole thing is idempotent.
 *
 * Ref: T-609 (#119), spec §9.4 / §E, BR-021.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { deleteAccount } from './orchestrator.ts';
import type { DomainEventInput } from '../_shared/events.ts';
import { nonNull } from '../_shared/_test_utils.ts';

const ME = 'u-me';
const NOW = Date.UTC(2026, 5, 25, 10, 0, 0);

type Row = Record<string, unknown>;
type Call = { fn: string; args: unknown };
type Mutation = { table: string; op: string; patch?: Row };

function makeFake(opts: {
  emails?: Row[];
  rpcError?: Record<string, string>;
  selectError?: Record<string, string>;
  mutateError?: Record<string, string>;
} = {}) {
  const rpcCalls: Call[] = [];
  const mutations: Mutation[] = [];
  // deno-lint-ignore no-explicit-any
  const client: any = {
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      const e = opts.rpcError?.[fn];
      return Promise.resolve({ data: null, error: e ? { message: e } : null });
    },
    from(table: string) {
      let mode: 'select' | 'update' | 'delete' = 'select';
      let patch: Row | undefined;
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: () => builder,
        update(p: Row) {
          mode = 'update';
          patch = p;
          return builder;
        },
        delete() {
          mode = 'delete';
          return builder;
        },
        eq: () => builder,
        is: () => builder,
        in: () => builder,
        then(resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) {
          if (mode === 'select') {
            const e = opts.selectError?.[table];
            const data = table === 'connected_emails' ? (opts.emails ?? []) : [];
            return Promise.resolve({ data, error: e ? { message: e } : null }).then(resolve);
          }
          mutations.push({ table, op: mode, patch });
          const e = opts.mutateError?.[table];
          return Promise.resolve({ data: null, error: e ? { message: e } : null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { client, rpcCalls, mutations };
}

function deps(over: Partial<{
  emitEvent: (e: DomainEventInput) => Promise<void>;
  // deno-lint-ignore no-explicit-any
  deleteUser: (client: any, userId: string) => Promise<void>;
  now: () => number;
}> = {}) {
  return {
    emitEvent: () => Promise.resolve(),
    deleteUser: () => Promise.resolve(),
    now: () => NOW,
    ...over,
  };
}

// --- full flow --------------------------------------------------------------

Deno.test('deleteAccount runs the full §9.4 sequence and never deletes invoices', async () => {
  const fake = makeFake({
    emails: [
      { id: 'e1', app_password_secret: 's1' },
      { id: 'e2', app_password_secret: 's2' },
    ],
  });
  let emitted: DomainEventInput | null = null;
  let deletedUser = '';

  const res = await deleteAccount(
    { id: ME, email: 'me@x.co' },
    fake.client,
    deps({
      emitEvent: (e) => {
        emitted = e;
        return Promise.resolve();
      },
      deleteUser: (_c, uid) => {
        deletedUser = uid;
        return Promise.resolve();
      },
    }),
  );

  // memberships + emails soft-deleted; grants dropped; invoices untouched
  assert(fake.mutations.some((m) => m.table === 'members' && m.op === 'update'));
  assert(fake.mutations.some((m) => m.table === 'connected_emails' && m.op === 'update'));
  assert(fake.mutations.some((m) => m.table === 'system_admin_grants' && m.op === 'delete'));
  assert(!fake.mutations.some((m) => m.table === 'invoices'), 'invoices must remain');

  // vault secrets deleted for every owned email
  const vaultSecrets = fake.rpcCalls.filter((c) => c.fn === 'delete_vault_secret')
    .map((c) => (c.args as { secret_id: string }).secret_id).sort();
  assertEquals(vaultSecrets, ['s1', 's2']);

  // anonymize called with the caller id
  const anon = fake.rpcCalls.find((c) => c.fn === 'anonymize_user_references');
  assertEquals((anon?.args as { target_user_id: string }).target_user_id, ME);

  // user.deleted emitted + auth user removed
  const ev = nonNull<DomainEventInput>(emitted);
  assertEquals(ev.type, 'user.deleted');
  assertEquals((ev.payload.data as Row).userId, ME);
  assertEquals((ev.payload.data as Row).deleted_at, new Date(NOW).toISOString());
  assertEquals(deletedUser, ME);

  assertEquals(res.deleted_at, new Date(NOW).toISOString());
});

// --- resilience -------------------------------------------------------------

Deno.test('deleteAccount tolerates a vault-secret delete error (best-effort)', async () => {
  const fake = makeFake({
    emails: [{ id: 'e1', app_password_secret: 's1' }],
    rpcError: { delete_vault_secret: 'vault boom' },
  });
  let deleted = '';
  const res = await deleteAccount(
    { id: ME, email: 'me@x.co' },
    fake.client,
    deps({
      deleteUser: (_c, uid) => {
        deleted = uid;
        return Promise.resolve();
      },
    }),
  );
  // still anonymized + deleted despite the vault error
  assert(fake.rpcCalls.some((c) => c.fn === 'anonymize_user_references'));
  assertEquals(deleted, ME);
  assertEquals(res.deleted_at, new Date(NOW).toISOString());
});

Deno.test('deleteAccount throws when anonymize fails (fatal)', async () => {
  const fake = makeFake({ rpcError: { anonymize_user_references: 'anon boom' } });
  await assertRejects(
    () => deleteAccount({ id: ME, email: 'me@x.co' }, fake.client, deps()),
    Error,
    'anon',
  );
});

Deno.test('deleteAccount is idempotent — a second run with nothing left still succeeds', async () => {
  const fake = makeFake({ emails: [] }); // already-deleted state
  let deleted = '';
  const res = await deleteAccount(
    { id: ME, email: 'me@x.co' },
    fake.client,
    deps({
      deleteUser: (_c, uid) => {
        deleted = uid;
        return Promise.resolve();
      },
    }),
  );
  assert(fake.rpcCalls.some((c) => c.fn === 'anonymize_user_references'));
  assertEquals(deleted, ME);
  assertEquals(res.deleted_at, new Date(NOW).toISOString());
});
