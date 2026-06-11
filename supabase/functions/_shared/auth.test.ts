/**
 * auth.test.ts — Deno unit tests for `_shared/auth.ts`.
 *
 * Ref:  T-230, spec §4.2.1 + §5.11
 * Date: 2026-06-10
 *
 * Coverage:
 *   - extractBearerToken: present / absent / malformed / lowercase scheme
 *   - getCallerUser: 401 when no header / invalid JWT / GoTrue error / no email
 *   - getCallerUser: returns identity + is_system_admin flag
 *   - loadHouseholdMemberships: maps rows + handles empty
 *   - requireCallerWithMemberships: composes both
 *   - nonAdminHouseholds / nonMemberHouseholds: set-diff semantics
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { makeRequest } from './_test_utils.ts';
import {
  type AuthenticatedCaller,
  extractBearerToken,
  getCallerUser,
  loadHouseholdMemberships,
  nonAdminHouseholds,
  nonMemberHouseholds,
  requireCallerWithMemberships,
} from './auth.ts';

// ---------------------------------------------------------------------------
// Fake Supabase client builder
// ---------------------------------------------------------------------------

type FakeUser = {
  id: string;
  email: string | null;
  app_metadata?: Record<string, unknown> | null;
};

type FakeAuthBehaviour =
  | { kind: 'ok'; user: FakeUser }
  | { kind: 'error'; message: string }
  | { kind: 'throws'; err: unknown };

type FakeMembersBehaviour =
  | { kind: 'rows'; rows: Array<{ household_id: string; role: 'admin' | 'member' }> }
  | { kind: 'error'; message: string };

/**
 * Builds a minimal Supabase client double covering only the surface our
 * helpers touch: `auth.getUser` + `from('members').select().eq().is()`.
 */
function fakeClient(opts: {
  auth?: FakeAuthBehaviour;
  members?: FakeMembersBehaviour;
}) {
  // deno-lint-ignore no-explicit-any
  const client: any = {
    auth: {
      getUser(_jwt: string) {
        const a = opts.auth;
        if (!a) return Promise.resolve({ data: { user: null }, error: null });
        if (a.kind === 'throws') return Promise.reject(a.err);
        if (a.kind === 'error') {
          return Promise.resolve({ data: { user: null }, error: { message: a.message } });
        }
        return Promise.resolve({ data: { user: a.user }, error: null });
      },
    },
    from(_table: string) {
      let userIdFilter = '';
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select(_cols: string) {
          return chain;
        },
        eq(col: string, value: string) {
          if (col === 'user_id') userIdFilter = value;
          return chain;
        },
        is(_col: string, _value: unknown) {
          // resolve here — `.is()` is the terminal call in loadHouseholdMemberships
          const m = opts.members;
          if (!m) return Promise.resolve({ data: [], error: null });
          if (m.kind === 'error') {
            return Promise.resolve({ data: null, error: { message: m.message } });
          }
          // ignore userIdFilter in fake — caller fixture controls rows
          void userIdFilter;
          return Promise.resolve({ data: m.rows, error: null });
        },
      };
      return chain;
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// extractBearerToken — pure
// ---------------------------------------------------------------------------

Deno.test('extractBearerToken: absent header → null', () => {
  assertEquals(extractBearerToken(makeRequest()), null);
});

Deno.test('extractBearerToken: non-Bearer scheme → null', () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Basic abc' } });
  assertEquals(extractBearerToken(req), null);
});

Deno.test('extractBearerToken: case-insensitive scheme + trim', () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'bearer   tok123  ' } });
  assertEquals(extractBearerToken(req), 'tok123');
});

Deno.test('extractBearerToken: empty after prefix → null', () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Bearer   ' } });
  assertEquals(extractBearerToken(req), null);
});

// ---------------------------------------------------------------------------
// getCallerUser
// ---------------------------------------------------------------------------

Deno.test('getCallerUser: no auth header → null (401-equivalent)', async () => {
  const result = await getCallerUser(makeRequest(), { client: fakeClient({}) });
  assertEquals(result, null);
});

Deno.test('getCallerUser: GoTrue returns error → null', async () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Bearer bad' } });
  const result = await getCallerUser(req, {
    client: fakeClient({ auth: { kind: 'error', message: 'invalid_token' } }),
  });
  assertEquals(result, null);
});

Deno.test('getCallerUser: GoTrue throws → null (defensive)', async () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Bearer bad' } });
  const result = await getCallerUser(req, {
    client: fakeClient({ auth: { kind: 'throws', err: new Error('network') } }),
  });
  assertEquals(result, null);
});

Deno.test('getCallerUser: user without email → null', async () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Bearer tok' } });
  const result = await getCallerUser(req, {
    client: fakeClient({
      auth: { kind: 'ok', user: { id: '00000000-0000-4000-8000-000000000aaa', email: null } },
    }),
  });
  assertEquals(result, null);
});

Deno.test('getCallerUser: happy path returns identity + is_system_admin=false', async () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Bearer tok' } });
  const result = await getCallerUser(req, {
    client: fakeClient({
      auth: {
        kind: 'ok',
        user: { id: '00000000-0000-4000-8000-000000000aaa', email: 'a@b.com' },
      },
    }),
  });
  assertEquals(result, {
    id: '00000000-0000-4000-8000-000000000aaa',
    email: 'a@b.com',
    is_system_admin: false,
  });
});

Deno.test('getCallerUser: reads app_metadata.is_system_admin=true', async () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Bearer tok' } });
  const result = await getCallerUser(req, {
    client: fakeClient({
      auth: {
        kind: 'ok',
        user: {
          id: '00000000-0000-4000-8000-000000000aaa',
          email: 'admin@b.com',
          app_metadata: { is_system_admin: true },
        },
      },
    }),
  });
  assert(result !== null);
  assertEquals(result!.is_system_admin, true);
});

Deno.test('getCallerUser: coerces app_metadata.is_system_admin="true" string', async () => {
  const req = makeRequest('https://e.test/', { headers: { authorization: 'Bearer tok' } });
  const result = await getCallerUser(req, {
    client: fakeClient({
      auth: {
        kind: 'ok',
        user: {
          id: '00000000-0000-4000-8000-000000000aaa',
          email: 'admin@b.com',
          app_metadata: { is_system_admin: 'true' },
        },
      },
    }),
  });
  assert(result !== null);
  assertEquals(result!.is_system_admin, true);
});

// ---------------------------------------------------------------------------
// loadHouseholdMemberships
// ---------------------------------------------------------------------------

Deno.test('loadHouseholdMemberships: maps rows', async () => {
  const rows = [
    { household_id: '00000000-0000-4000-8000-00000000aaa1', role: 'admin' as const },
    { household_id: '00000000-0000-4000-8000-00000000aaa2', role: 'member' as const },
  ];
  const result = await loadHouseholdMemberships(
    '00000000-0000-4000-8000-000000000aaa',
    fakeClient({ members: { kind: 'rows', rows } }),
  );
  assertEquals(result, rows);
});

Deno.test('loadHouseholdMemberships: empty when no rows', async () => {
  const result = await loadHouseholdMemberships(
    '00000000-0000-4000-8000-000000000aaa',
    fakeClient({ members: { kind: 'rows', rows: [] } }),
  );
  assertEquals(result, []);
});

Deno.test('loadHouseholdMemberships: throws on DB error', async () => {
  await assertRejects(() =>
    loadHouseholdMemberships(
      '00000000-0000-4000-8000-000000000aaa',
      fakeClient({ members: { kind: 'error', message: 'boom' } }),
    )
  );
});

// ---------------------------------------------------------------------------
// requireCallerWithMemberships
// ---------------------------------------------------------------------------

Deno.test('requireCallerWithMemberships: null when caller not authenticated', async () => {
  const result = await requireCallerWithMemberships(
    makeRequest(),
    fakeClient({}),
    { getCaller: () => Promise.resolve(null) },
  );
  assertEquals(result, null);
});

Deno.test('requireCallerWithMemberships: composes identity + memberships', async () => {
  const rows = [
    { household_id: '00000000-0000-4000-8000-00000000aaa1', role: 'admin' as const },
  ];
  const result = await requireCallerWithMemberships(
    makeRequest(),
    fakeClient({ members: { kind: 'rows', rows } }),
    {
      getCaller: () =>
        Promise.resolve({
          id: '00000000-0000-4000-8000-000000000aaa',
          email: 'a@b.com',
          is_system_admin: false,
        }),
    },
  );
  assertEquals(result, {
    id: '00000000-0000-4000-8000-000000000aaa',
    email: 'a@b.com',
    is_system_admin: false,
    memberships: rows,
  });
});

// ---------------------------------------------------------------------------
// nonAdminHouseholds / nonMemberHouseholds
// ---------------------------------------------------------------------------

const caller: AuthenticatedCaller = {
  id: '00000000-0000-4000-8000-000000000aaa',
  email: 'a@b.com',
  is_system_admin: false,
  memberships: [
    { household_id: 'h-admin', role: 'admin' },
    { household_id: 'h-member', role: 'member' },
  ],
};

Deno.test('nonAdminHouseholds: returns ids caller is not admin of', () => {
  assertEquals(nonAdminHouseholds(caller, ['h-admin', 'h-member', 'h-other']), [
    'h-member',
    'h-other',
  ]);
});

Deno.test('nonAdminHouseholds: empty when caller is admin of all', () => {
  assertEquals(nonAdminHouseholds(caller, ['h-admin']), []);
});

Deno.test('nonMemberHouseholds: returns ids caller is not in', () => {
  assertEquals(nonMemberHouseholds(caller, ['h-admin', 'h-member', 'h-other']), ['h-other']);
});

Deno.test('nonMemberHouseholds: empty when caller is member of all', () => {
  assertEquals(nonMemberHouseholds(caller, ['h-admin', 'h-member']), []);
});
