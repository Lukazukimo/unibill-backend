/**
 * invitations-redeem tests — body validation, rate limits, lockout, redeem flow.
 *
 * Ref:  T-215, spec §9.1 + §E POST /invitations/redeem + BR-026/BR-027
 * Date: 2026-06-10
 *
 * The handler is exercised end-to-end via `buildHandler({...})` with the
 * JWT, Supabase client and clock deps stubbed. The fake Supabase client
 * covers exactly the three tables the handler touches:
 *   - rate_limit_buckets         (peek/upsert/delete)
 *   - household_invitations      (select-by-code, update with CAS)
 *   - members                    (insert with optional UNIQUE 23505)
 *
 * Covered branches:
 *   - validation: missing/short/non-base32 code              → 422
 *   - JWT missing                                            → 401
 *   - per-IP rate limit > 10                                 → 429 scope=ip
 *   - per-user rate limit > 5                                → 429 scope=user
 *   - code locked (5 prior failures)                         → 404 (anti-enumeration)
 *                                                              + redeem_failed event
 *   - invite not found                                       → 404 + redeem_failed + counter+1
 *   - invite expired                                         → 404 + redeem_failed + counter+1
 *   - invited_email mismatch (BR-027)                        → 403 + redeem_failed + counter+1
 *   - happy path (invited_email NULL — open invite)          → 200 + members insert
 *                                                              + invitation update
 *                                                              + lockout cleared
 *                                                              + redeemed event
 *   - happy path (invited_email match)                       → 200
 *   - idempotency: user already member (UNIQUE 23505)        → 200 + invite still marked used
 *   - race: invitation consumed between lookup and update    → 404
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  buildHandler,
  CODE_FAIL_THRESHOLD,
  type HandlerDeps,
  normalizeCode,
  type RedeemInvitationResponse,
  RL_LIMIT_IP,
  RL_LIMIT_USER,
  RL_RESOURCE_REDEEM,
  RL_RESOURCE_REDEEM_CODE,
  validateRedeemBody,
} from './index.ts';
import type { DomainEventInput } from '../_shared/events.ts';

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

Deno.test('normalizeCode uppercases and trims', () => {
  assertEquals(normalizeCode('  abcd2345  '), 'ABCD2345');
  assertEquals(normalizeCode('ABCD2345'), 'ABCD2345');
});

Deno.test('validateRedeemBody accepts a valid base32 code', () => {
  const r = validateRedeemBody({ code: 'ABCD2345' });
  assert(r.ok);
  if (r.ok) assertEquals(r.data.code, 'ABCD2345');
});

Deno.test('validateRedeemBody normalizes lowercase before validation', () => {
  const r = validateRedeemBody({ code: 'abcd2345' });
  assert(r.ok);
  if (r.ok) assertEquals(r.data.code, 'ABCD2345');
});

Deno.test('validateRedeemBody rejects code with I (confusable)', () => {
  const r = validateRedeemBody({ code: 'ABCDIJK2' });
  assert(!r.ok);
});

Deno.test('validateRedeemBody rejects code with 0 (confusable)', () => {
  const r = validateRedeemBody({ code: 'ABCD2340' });
  assert(!r.ok);
});

Deno.test('validateRedeemBody rejects code with 1 (confusable)', () => {
  const r = validateRedeemBody({ code: 'ABCD2341' });
  assert(!r.ok);
});

Deno.test('validateRedeemBody rejects short code', () => {
  const r = validateRedeemBody({ code: 'ABC' });
  assert(!r.ok);
});

Deno.test('validateRedeemBody rejects non-string code', () => {
  const r = validateRedeemBody({ code: 12345678 });
  assert(!r.ok);
});

Deno.test('validateRedeemBody rejects missing body', () => {
  const r = validateRedeemBody(null);
  assert(!r.ok);
});

// ---------------------------------------------------------------------------
// Fake Supabase client — minimal builder covering what the handler exercises
// ---------------------------------------------------------------------------

type BucketRow = {
  resource_type: string;
  resource_key: string;
  window_start: string;
  window_size: string;
  count: number;
};

type InvitationRow = {
  id: string;
  household_id: string;
  code: string;
  role: 'admin' | 'member';
  invited_email: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
};

type MemberRow = {
  id: string;
  household_id: string;
  user_id: string;
  role: 'admin' | 'member';
  invited_by: string | null;
  deleted_at: string | null;
};

type FakeState = {
  buckets: BucketRow[];
  invitations: InvitationRow[];
  members: MemberRow[];
  /** If true, members.insert returns sqlstate 23505 (unique_violation). */
  forceMemberUniqueViolation?: boolean;
  /** If true, invitation update returns 0 rows (race: someone else consumed it). */
  forceInvitationUpdateRace?: boolean;
  /** Captured events for assertion. */
  events: DomainEventInput[];
};

function uuid(): string {
  return crypto.randomUUID();
}

function freshState(opts: Partial<FakeState> = {}): FakeState {
  return {
    buckets: [],
    invitations: [],
    members: [],
    events: [],
    ...opts,
  };
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    from(table: string) {
      if (table === 'rate_limit_buckets') {
        return bucketsBuilder(state);
      }
      if (table === 'household_invitations') {
        return invitationsBuilder(state);
      }
      if (table === 'members') {
        return membersBuilder(state);
      }
      throw new Error(`unhandled table: ${table}`);
    },
  };
}

// ---------------------------------------------------------------------------
// rate_limit_buckets builder — supports: select+eq+eq+eq+maybeSingle,
//   upsert(onConflict), delete+eq+eq
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function bucketsBuilder(state: FakeState): any {
  const filters: Array<(r: BucketRow) => boolean> = [];
  let mode: 'select' | 'delete' | null = null;

  // deno-lint-ignore no-explicit-any
  const b: any = {
    select(_c: string) {
      mode = 'select';
      return b;
    },
    eq(col: keyof BucketRow, val: unknown) {
      filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === val);
      return b;
    },
    maybeSingle() {
      const m = state.buckets.filter((r) => filters.every((f) => f(r)));
      if (m.length === 0) return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: m[0], error: null });
    },
    upsert(row: BucketRow, _opts: unknown) {
      // Idempotent upsert on the composite key
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
    delete() {
      mode = 'delete';
      return b;
    },
    then(resolve: (v: { data: null; error: null }) => unknown) {
      if (mode === 'delete') {
        state.buckets = state.buckets.filter((r) => !filters.every((f) => f(r)));
      }
      return resolve({ data: null, error: null });
    },
  };
  return b;
}

// ---------------------------------------------------------------------------
// household_invitations builder — supports:
//   select(cols).eq('code', x).is('used_at', null).maybeSingle()
//   update({used_at, used_by}).eq('id', x).is('used_at', null).select('id')
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function invitationsBuilder(state: FakeState): any {
  const filters: Array<(r: InvitationRow) => boolean> = [];
  let mode: 'select' | 'update' | null = null;
  let updateValues: Partial<InvitationRow> = {};

  // deno-lint-ignore no-explicit-any
  const b: any = {
    select(_c: string) {
      if (mode === 'update') return b; // chained after update; just return self
      mode = 'select';
      return b;
    },
    eq(col: keyof InvitationRow, val: unknown) {
      filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === val);
      return b;
    },
    is(col: keyof InvitationRow, val: unknown) {
      filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === val);
      return b;
    },
    maybeSingle() {
      const m = state.invitations.filter((r) => filters.every((f) => f(r)));
      if (m.length === 0) return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: m[0], error: null });
    },
    update(values: Partial<InvitationRow>) {
      mode = 'update';
      updateValues = values;
      return b;
    },
    then(resolve: (v: { data: Array<{ id: string }> | null; error: null }) => unknown) {
      if (mode === 'update') {
        if (state.forceInvitationUpdateRace) {
          return resolve({ data: [], error: null });
        }
        const matched = state.invitations.filter((r) => filters.every((f) => f(r)));
        for (const row of matched) {
          Object.assign(row, updateValues);
        }
        return resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
      }
      return resolve({ data: null, error: null });
    },
  };
  return b;
}

// ---------------------------------------------------------------------------
// members builder — supports: insert(values), delete().eq().eq()
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function membersBuilder(state: FakeState): any {
  const filters: Array<(r: MemberRow) => boolean> = [];
  let mode: 'delete' | null = null;

  // deno-lint-ignore no-explicit-any
  const b: any = {
    insert(values: Partial<MemberRow>) {
      if (state.forceMemberUniqueViolation) {
        return Promise.resolve({
          data: null,
          error: { code: '23505', message: 'duplicate key uq_members_household_user_active' },
        });
      }
      const row: MemberRow = {
        id: uuid(),
        household_id: values.household_id!,
        user_id: values.user_id!,
        role: values.role!,
        invited_by: values.invited_by ?? null,
        deleted_at: null,
      };
      state.members.push(row);
      return Promise.resolve({ data: null, error: null });
    },
    delete() {
      mode = 'delete';
      return b;
    },
    eq(col: keyof MemberRow, val: unknown) {
      filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === val);
      return b;
    },
    then(resolve: (v: { data: null; error: null }) => unknown) {
      if (mode === 'delete') {
        state.members = state.members.filter((r) => !filters.every((f) => f(r)));
      }
      return resolve({ data: null, error: null });
    },
  };
  return b;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_CODE = 'ABCD2345';
const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';
const INVITER_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_NOW = new Date('2026-06-10T12:00:00.000Z');

function makeInvitation(opts: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: uuid(),
    household_id: HOUSEHOLD_ID,
    code: VALID_CODE,
    role: 'member',
    invited_email: null,
    created_by: INVITER_ID,
    created_at: '2026-06-09T12:00:00.000Z',
    expires_at: '2026-06-16T12:00:00.000Z', // +7d from FIXED_NOW
    used_at: null,
    used_by: null,
    ...opts,
  };
}

function callerStub(user: { id: string; email: string } | null): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

function captureEvents(state: FakeState): HandlerDeps['emitEvent'] {
  return (e) => {
    state.events.push(e);
    return Promise.resolve();
  };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://x.test/fn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

Deno.test('handler returns 405 for non-POST', async () => {
  const state = freshState();
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(new Request('https://x', { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('handler returns 401 when JWT missing', async () => {
  const state = freshState();
  const handler = buildHandler({
    getCallerUser: callerStub(null),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 401);
});

Deno.test('handler returns 422 on invalid body', async () => {
  const state = freshState();
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: 'TOO_SHORT' }));
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error, 'validation_failed');
});

Deno.test('handler returns 400 on invalid JSON', async () => {
  const state = freshState();
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(
    new Request('https://x.test/fn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    }),
  );
  assertEquals(res.status, 400);
});

Deno.test('handler returns 429 on per-IP rate limit', async () => {
  const state = freshState({
    invitations: [makeInvitation()],
  });
  // Pre-populate IP bucket at exactly RL_LIMIT_IP — next increment goes over.
  const windowStart = new Date(
    Math.floor(FIXED_NOW.getTime() / (60 * 60_000)) * (60 * 60_000),
  ).toISOString();
  state.buckets.push({
    resource_type: RL_RESOURCE_REDEEM,
    resource_key: 'ip:1.2.3.4',
    window_start: windowStart,
    window_size: '60 minutes',
    count: RL_LIMIT_IP,
  });

  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(
    makeRequest({ code: VALID_CODE }, { 'x-forwarded-for': '1.2.3.4' }),
  );
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error, 'rate_limited');
  assertEquals(body.scope, 'ip');
});

Deno.test('handler returns 429 on per-user rate limit', async () => {
  const state = freshState({
    invitations: [makeInvitation()],
  });
  // Pre-populate user bucket at RL_LIMIT_USER; IP bucket stays under.
  const windowStart = new Date(
    Math.floor(FIXED_NOW.getTime() / (60 * 60_000)) * (60 * 60_000),
  ).toISOString();
  state.buckets.push({
    resource_type: RL_RESOURCE_REDEEM,
    resource_key: 'user:u1',
    window_start: windowStart,
    window_size: '60 minutes',
    count: RL_LIMIT_USER,
  });

  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(
    makeRequest({ code: VALID_CODE }, { 'x-forwarded-for': '9.9.9.9' }),
  );
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error, 'rate_limited');
  assertEquals(body.scope, 'user');
});

Deno.test('handler returns 404 when invite not found + emits redeem_failed', async () => {
  const state = freshState();
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, 'invite_not_found');

  // Counter incremented in the code lockout bucket
  const codeBucket = state.buckets.find(
    (b) =>
      b.resource_type === RL_RESOURCE_REDEEM_CODE &&
      b.resource_key === `code:${VALID_CODE}`,
  );
  assert(codeBucket);
  assertEquals(codeBucket!.count, 1);

  // Event emitted
  const failed = state.events.find((e) => e.type === 'invitation.redeem_failed');
  assert(failed);
  assertEquals((failed!.payload.data as { reason: string }).reason, 'invite_not_found');
});

Deno.test('handler returns 404 when invite is expired + emits redeem_failed', async () => {
  const state = freshState({
    invitations: [makeInvitation({
      expires_at: '2026-06-09T00:00:00.000Z', // before FIXED_NOW
    })],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 404);
  const failed = state.events.find((e) => e.type === 'invitation.redeem_failed');
  assert(failed);
  assertEquals((failed!.payload.data as { reason: string }).reason, 'invite_expired');
});

Deno.test('handler returns 403 on invited_email mismatch + emits redeem_failed (BR-027)', async () => {
  const state = freshState({
    invitations: [makeInvitation({
      invited_email: 'alice@example.com', // already lowercase per trigger T-227
    })],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'bob@example.com' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, 'email_mismatch');

  const failed = state.events.find((e) => e.type === 'invitation.redeem_failed');
  assert(failed);
  assertEquals((failed!.payload.data as { reason: string }).reason, 'email_mismatch');
});

Deno.test('handler returns 404 (anti-enumeration) when code is locked + emits redeem_failed', async () => {
  const state = freshState({
    invitations: [makeInvitation()], // invite EXISTS, but locked
  });
  // Pre-populate the lockout bucket at exactly the threshold.
  const windowMs = 24 * 60 * 60_000;
  const windowStart = new Date(
    Math.floor(FIXED_NOW.getTime() / windowMs) * windowMs,
  ).toISOString();
  state.buckets.push({
    resource_type: RL_RESOURCE_REDEEM_CODE,
    resource_key: `code:${VALID_CODE}`,
    window_start: windowStart,
    window_size: `${24 * 60} minutes`,
    count: CODE_FAIL_THRESHOLD,
  });

  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 404);
  const body = await res.json();
  // Anti-enumeration: same response shape as plain not-found
  assertEquals(body.error, 'invite_not_found');

  // No members row was created (DB never touched for invitation)
  assertEquals(state.members.length, 0);
  // Invitation still has used_at NULL
  assertEquals(state.invitations[0].used_at, null);

  // Continued brute-force is still recorded (sys admin visibility)
  const failed = state.events.find((e) => e.type === 'invitation.redeem_failed');
  assert(failed);
  assertEquals((failed!.payload.data as { reason: string }).reason, 'code_locked');
});

Deno.test('handler happy path: open invite (invited_email NULL) → 200', async () => {
  const invite = makeInvitation({ invited_email: null });
  const state = freshState({ invitations: [invite] });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as RedeemInvitationResponse;
  assertEquals(body.household_id, HOUSEHOLD_ID);
  assertEquals(body.role, 'member');

  // members row created
  assertEquals(state.members.length, 1);
  assertEquals(state.members[0].user_id, 'u1');
  assertEquals(state.members[0].household_id, HOUSEHOLD_ID);
  assertEquals(state.members[0].role, 'member');
  assertEquals(state.members[0].invited_by, INVITER_ID);

  // invitation marked used
  assertEquals(state.invitations[0].used_at, FIXED_NOW.toISOString());
  assertEquals(state.invitations[0].used_by, 'u1');

  // lockout bucket for this code was cleared (no row with resource_key=`code:${VALID_CODE}`)
  const codeBucketsRemaining = state.buckets.filter(
    (b) =>
      b.resource_type === RL_RESOURCE_REDEEM_CODE &&
      b.resource_key === `code:${VALID_CODE}`,
  );
  assertEquals(codeBucketsRemaining.length, 0);

  // domain_event redeemed emitted
  const redeemed = state.events.find((e) => e.type === 'invitation.redeemed');
  assert(redeemed);
  assertEquals(redeemed!.aggregate_id, invite.id);
  assertEquals(redeemed!.household_id, HOUSEHOLD_ID);

  // No redeem_failed event on happy path
  const failed = state.events.find((e) => e.type === 'invitation.redeem_failed');
  assertEquals(failed, undefined);
});

Deno.test('handler happy path: email-restricted invite, email matches → 200', async () => {
  const invite = makeInvitation({
    invited_email: 'alice@example.com',
    role: 'admin',
  });
  const state = freshState({ invitations: [invite] });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u-alice', email: 'Alice@Example.COM' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as RedeemInvitationResponse;
  assertEquals(body.role, 'admin');
  // member row uses the invitation role
  assertEquals(state.members[0].role, 'admin');
});

Deno.test('handler idempotency: user already member (23505) → 200 + invite still consumed', async () => {
  const invite = makeInvitation();
  const state = freshState({
    invitations: [invite],
    forceMemberUniqueViolation: true,
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 200);
  // Invitation still consumed
  assertEquals(state.invitations[0].used_at, FIXED_NOW.toISOString());
  // redeemed event emitted with already_member=true flag
  const redeemed = state.events.find((e) => e.type === 'invitation.redeemed');
  assert(redeemed);
  assertEquals((redeemed!.payload.data as { already_member: boolean }).already_member, true);
});

Deno.test('handler race: invite consumed between lookup and update → 404 + members rolled back', async () => {
  const invite = makeInvitation();
  const state = freshState({
    invitations: [invite],
    forceInvitationUpdateRace: true, // update returns 0 rows
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
    client: makeFakeClient(state),
    emitEvent: captureEvents(state),
    now: () => FIXED_NOW,
  });
  const res = await handler(makeRequest({ code: VALID_CODE }));
  assertEquals(res.status, 404);
  // Members row was compensated
  assertEquals(state.members.length, 0);
  // redeem_failed event with reason=invite_used
  const failed = state.events.find((e) => e.type === 'invitation.redeem_failed');
  assert(failed);
  assertEquals((failed!.payload.data as { reason: string }).reason, 'invite_used');
});

// #204 resolution: the handler's check order (IP → user → per-code lockout) is
// CORRECT and stays. The per-code lockout defends against DISTRIBUTED brute
// force (many callers each staying under their own IP/user caps but driving one
// code to the threshold); a single caller hammering one code trips their own
// per-user cap (5) first and is stopped with 429 — which does NOT leak code
// existence (the IP/user buckets are code-agnostic), so anti-enumeration holds
// either way. So the fix is the test, not the handler: exercise the lockout the
// way it is actually reachable (distributed), and separately pin the single-
// caller 429 behaviour.
Deno.test(
  'per-code lockout: 5 DISTRIBUTED failures lock the code; a fresh caller gets 404 (anti-enum)',
  async () => {
    // No invitation exists yet → every attempt is invite_not_found, and each
    // failure bumps the per-code bucket. Five DISTINCT (user, ip) pairs each
    // fail once, so no per-user (limit 5) or per-IP (limit 10) bucket trips —
    // the code bucket reaches CODE_FAIL_THRESHOLD purely via the code path.
    const state = freshState();
    for (let i = 0; i < CODE_FAIL_THRESHOLD; i++) {
      const handler = buildHandler({
        getCallerUser: callerStub({ id: `u${i}`, email: `u${i}@b.co` }),
        client: makeFakeClient(state),
        emitEvent: captureEvents(state),
        now: () => FIXED_NOW,
      });
      const res = await handler(
        makeRequest({ code: VALID_CODE }, { 'x-forwarded-for': `10.0.0.${i}` }),
      );
      assertEquals(res.status, 404);
    }

    const codeBucket = state.buckets.find(
      (b) =>
        b.resource_type === RL_RESOURCE_REDEEM_CODE &&
        b.resource_key === `code:${VALID_CODE}`,
    );
    assert(codeBucket);
    assertEquals(codeBucket!.count, CODE_FAIL_THRESHOLD);

    // A real invitation now exists for the locked code. A FRESH caller/IP (so no
    // per-user/IP limit trips) must still get 404 via the code-lockout branch —
    // NOT a 429 — and must not consume the invite; the counter tracks the
    // post-lockout attempt so sys admin can see continued brute force.
    state.invitations.push(makeInvitation());
    const freshHandler = buildHandler({
      getCallerUser: callerStub({ id: 'u-fresh', email: 'fresh@b.co' }),
      client: makeFakeClient(state),
      emitEvent: captureEvents(state),
      now: () => FIXED_NOW,
    });
    const res = await freshHandler(
      makeRequest({ code: VALID_CODE }, { 'x-forwarded-for': '10.0.0.99' }),
    );
    assertEquals(res.status, 404);
    assertEquals(state.members.length, 0);
    assertEquals(state.invitations[0].used_at, null);
    // Re-find: the fake's upsert REPLACES the bucket object, so the earlier
    // reference is stale — read the current one to see the post-lockout bump.
    const afterBucket = state.buckets.find(
      (b) =>
        b.resource_type === RL_RESOURCE_REDEEM_CODE &&
        b.resource_key === `code:${VALID_CODE}`,
    );
    assertEquals(afterBucket!.count, CODE_FAIL_THRESHOLD + 1);
  },
);

Deno.test(
  'single caller hammering one code is stopped by the per-user limit (429), not the code-lockout',
  async () => {
    // The per-user cap (5) is below the point a lone caller could reach a 6th
    // same-code failure, so it — not the code-lockout — is what stops them. The
    // 429 is code-agnostic (scope:user), so it leaks nothing about the code.
    const state = freshState();
    const handler = buildHandler({
      getCallerUser: callerStub({ id: 'u1', email: 'a@b.co' }),
      client: makeFakeClient(state),
      emitEvent: captureEvents(state),
      now: () => FIXED_NOW,
    });

    // First 5 attempts: under the per-user cap → 404 invite_not_found.
    for (let i = 0; i < RL_LIMIT_USER; i++) {
      const res = await handler(makeRequest({ code: VALID_CODE }));
      assertEquals(res.status, 404);
    }

    // 6th attempt from the same user: the user bucket now exceeds the cap → 429.
    const res = await handler(makeRequest({ code: VALID_CODE }));
    assertEquals(res.status, 429);
    const body = await res.json();
    assertEquals(body.error, 'rate_limited');
    assertEquals(body.scope, 'user');
  },
);
