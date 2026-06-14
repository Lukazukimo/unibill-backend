/**
 * households-create tests — body validation + create flow (household + admin
 * member + domain event), with the JWT, Supabase client and event sink stubbed.
 *
 * Ref:  T-516, spec §8.5 onboarding, §5.1 members/households
 * Date: 2026-06-13
 *
 * The fake Supabase client covers exactly the two tables the handler touches:
 *   - households  (insert ... select('id, name').single(); delete().eq() for
 *                  compensation)
 *   - members     (insert with optional forced error)
 *
 * Covered branches:
 *   - validation: empty/whitespace/missing/non-string/over-long name → 422
 *   - non-POST                                                       → 405
 *   - JWT missing                                                    → 401
 *   - invalid JSON                                                   → 400
 *   - happy path → 200 { household_id, name, role:'admin' } + household row
 *                  + admin member row + household.created event
 *   - household insert failure → 500 household_insert_failed (no member, no event)
 *   - member insert failure    → 500 member_insert_failed + household compensated
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  buildHandler,
  type CreateHouseholdResponse,
  type HandlerDeps,
  NAME_MAX,
  validateCreateBody,
} from './index.ts';
import type { DomainEventInput } from '../_shared/events.ts';

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

Deno.test('validateCreateBody accepts a normal name and trims it', () => {
  const r = validateCreateBody({ name: '  Casa da Praia  ' });
  assert(r.ok);
  if (r.ok) assertEquals(r.data.name, 'Casa da Praia');
});

Deno.test('validateCreateBody rejects empty / whitespace-only name', () => {
  assert(!validateCreateBody({ name: '' }).ok);
  assert(!validateCreateBody({ name: '   ' }).ok);
});

Deno.test('validateCreateBody rejects missing name', () => {
  assert(!validateCreateBody({}).ok);
  assert(!validateCreateBody(null).ok);
});

Deno.test('validateCreateBody rejects a non-string name', () => {
  assert(!validateCreateBody({ name: 123 }).ok);
});

Deno.test('validateCreateBody rejects an over-long name', () => {
  assert(!validateCreateBody({ name: 'x'.repeat(NAME_MAX + 1) }).ok);
  assert(validateCreateBody({ name: 'x'.repeat(NAME_MAX) }).ok);
});

// ---------------------------------------------------------------------------
// Fake Supabase client — covers households + members
// ---------------------------------------------------------------------------

type HouseholdRow = { id: string; name: string; created_by: string };
type MemberRow = {
  id: string;
  household_id: string;
  user_id: string;
  role: 'admin' | 'member';
  invited_by: string | null;
  deleted_at: string | null;
};

type FakeState = {
  households: HouseholdRow[];
  members: MemberRow[];
  events: DomainEventInput[];
  forceHouseholdInsertError?: boolean;
  forceMemberInsertError?: boolean;
};

function uuid(): string {
  return crypto.randomUUID();
}

function freshState(opts: Partial<FakeState> = {}): FakeState {
  return { households: [], members: [], events: [], ...opts };
}

// households builder — insert(values).select(cols).single(); delete().eq()
// deno-lint-ignore no-explicit-any
function householdsBuilder(state: FakeState): any {
  let mode: 'insert' | 'delete' | null = null;
  let values: Partial<HouseholdRow> = {};
  const filters: Array<(r: HouseholdRow) => boolean> = [];

  // deno-lint-ignore no-explicit-any
  const b: any = {
    insert(v: Partial<HouseholdRow>) {
      mode = 'insert';
      values = v;
      return b;
    },
    select(_c: string) {
      return b;
    },
    single() {
      if (state.forceHouseholdInsertError) {
        return Promise.resolve({
          data: null,
          error: { code: 'XX000', message: 'household insert failed' },
        });
      }
      const row: HouseholdRow = {
        id: uuid(),
        name: values.name!,
        created_by: values.created_by!,
      };
      state.households.push(row);
      return Promise.resolve({ data: { id: row.id, name: row.name }, error: null });
    },
    delete() {
      mode = 'delete';
      return b;
    },
    eq(col: keyof HouseholdRow, val: unknown) {
      filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === val);
      return b;
    },
    then(resolve: (v: { data: null; error: null }) => unknown) {
      if (mode === 'delete') {
        state.households = state.households.filter((r) => !filters.every((f) => f(r)));
      }
      return resolve({ data: null, error: null });
    },
  };
  return b;
}

// members builder — insert(values) with optional forced error
// deno-lint-ignore no-explicit-any
function membersBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const b: any = {
    insert(v: Partial<MemberRow>) {
      if (state.forceMemberInsertError) {
        return Promise.resolve({
          data: null,
          error: { code: 'XX000', message: 'member insert failed' },
        });
      }
      state.members.push({
        id: uuid(),
        household_id: v.household_id!,
        user_id: v.user_id!,
        role: v.role!,
        invited_by: v.invited_by ?? null,
        deleted_at: null,
      });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return b;
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    from(table: string) {
      if (table === 'households') return householdsBuilder(state);
      if (table === 'members') return membersBuilder(state);
      throw new Error(`unhandled table: ${table}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CALLER = { id: '22222222-2222-4222-8222-222222222222', email: 'creator@example.com' };

function callerStub(
  user: { id: string; email: string } | null,
): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

function captureEvents(state: FakeState): HandlerDeps['emitEvent'] {
  return (e) => {
    state.events.push(e);
    return Promise.resolve();
  };
}

function post(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/households-create', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

function makeHandler(state: FakeState, caller = CALLER as { id: string; email: string } | null) {
  return buildHandler({
    getCallerUser: callerStub(caller),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
  });
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

Deno.test('rejects a non-POST method with 405', async () => {
  const state = freshState();
  const res = await makeHandler(state)(post({}, 'GET'));
  assertEquals(res.status, 405);
  assertEquals((await res.json()).error, 'method_not_allowed');
});

Deno.test('rejects a missing JWT with 401', async () => {
  const state = freshState();
  const res = await makeHandler(state, null)(post({ name: 'Casa' }));
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, 'unauthorized');
});

Deno.test('rejects invalid JSON with 400', async () => {
  const state = freshState();
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const res = await makeHandler(state)(req);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, 'invalid_json');
});

Deno.test('rejects an empty name with 422 and creates nothing', async () => {
  const state = freshState();
  const res = await makeHandler(state)(post({ name: '   ' }));
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error, 'validation_failed');
  assert(Array.isArray(body.details));
  assertEquals(state.households.length, 0);
  assertEquals(state.members.length, 0);
});

Deno.test('happy path: creates household + admin member + event → 200', async () => {
  const state = freshState();
  const res = await makeHandler(state)(post({ name: 'Casa da Praia' }));
  assertEquals(res.status, 200);

  const body = (await res.json()) as CreateHouseholdResponse;
  assertEquals(body.name, 'Casa da Praia');
  assertEquals(body.role, 'admin');
  assert(body.household_id);

  // household persisted, owned by the caller
  assertEquals(state.households.length, 1);
  assertEquals(state.households[0].created_by, CALLER.id);

  // creator is the admin member of the new household
  assertEquals(state.members.length, 1);
  assertEquals(state.members[0].user_id, CALLER.id);
  assertEquals(state.members[0].household_id, body.household_id);
  assertEquals(state.members[0].role, 'admin');

  // household.created emitted for the new household
  assertEquals(state.events.length, 1);
  assertEquals(state.events[0].type, 'household.created');
  assertEquals(state.events[0].aggregate_id, body.household_id);
  assertEquals(state.events[0].actor_user_id, CALLER.id);
});

Deno.test('household insert failure → 500 + no member, no event', async () => {
  const state = freshState({ forceHouseholdInsertError: true });
  const res = await makeHandler(state)(post({ name: 'Casa' }));
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.code, 'households_insert_failed');
  assertEquals(state.members.length, 0);
  assertEquals(state.events.length, 0);
});

Deno.test('member insert failure → 500 + household compensated (deleted)', async () => {
  const state = freshState({ forceMemberInsertError: true });
  const res = await makeHandler(state)(post({ name: 'Casa' }));
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.code, 'members_insert_failed');
  // the orphaned household was rolled back, no event emitted
  assertEquals(state.households.length, 0);
  assertEquals(state.events.length, 0);
});

Deno.test('event emission failure is best-effort → still 200 + rows persisted', async () => {
  const state = freshState();
  const handler = buildHandler({
    getCallerUser: callerStub(CALLER),
    client: makeFakeClient(state),
    emitEvent: () => Promise.reject(new Error('event sink down')),
  });
  const res = await handler(post({ name: 'Casa da Praia' }));

  // A failed event emit must NOT unwind the creation.
  assertEquals(res.status, 200);
  assertEquals(state.households.length, 1);
  assertEquals(state.members.length, 1);
  assertEquals(state.members[0].role, 'admin');
});
