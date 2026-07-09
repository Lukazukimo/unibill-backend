import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import type { CallerUser } from '../_shared/auth.ts';
import type { DomainEventInput } from '../_shared/events.ts';
import { buildHandler, type HandlerDeps } from './index.ts';

const CALLER = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

type Row = Record<string, unknown>;
const sc = (c: FakeClient) => c as unknown as SupabaseClient;

class FakeClient {
  rpcCalls: Array<{ fn: string; params?: Row }> = [];
  rpcResults: Record<string, { data?: unknown; error?: unknown }> = {};
  constructor(private trace: string[]) {}
  rpc(fn: string, params?: Row) {
    this.rpcCalls.push({ fn, params });
    this.trace.push(`rpc:${fn}:${(params as Row | undefined)?.p_action ?? ''}`);
    return Promise.resolve(this.rpcResults[fn] ?? { data: null, error: null });
  }
}

function setup(opts: {
  caller?: CallerUser | null;
  rpc?: Record<string, { data?: unknown; error?: unknown }>;
  flipThrows?: boolean;
  emitThrows?: boolean;
} = {}) {
  const trace: string[] = [];
  const flips: Array<{ userId: string; value: boolean }> = [];
  const events: DomainEventInput[] = [];
  const client = new FakeClient(trace);
  client.rpcResults = opts.rpc ?? {};
  const caller = opts.caller === undefined
    ? ({ id: CALLER, email: 'admin@x', is_system_admin: true } as CallerUser)
    : opts.caller;
  const deps: HandlerDeps = {
    client: sc(client),
    getCallerUser: () => Promise.resolve(caller),
    setSystemAdminClaim: (_c, userId, value) => {
      trace.push(`flip:${value}`);
      flips.push({ userId, value });
      return opts.flipThrows ? Promise.reject(new Error('flip failed')) : Promise.resolve();
    },
    emitEvent: (e) => {
      events.push(e);
      return opts.emitThrows ? Promise.reject(new Error('emit failed')) : Promise.resolve();
    },
  };
  return { deps, trace, flips, events };
}

const req = (body: unknown, method = 'POST') =>
  new Request('https://x.test/admin-system-admins', {
    method,
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

const RECORD_OK = (changed: boolean, effective: number) => ({
  record_admin_change: { data: { changed, effective_count: effective }, error: null },
});

// ---- Gate + routing -------------------------------------------------------

Deno.test('missing JWT -> 401', async () => {
  const { deps } = setup({ caller: null });
  const res = await buildHandler(deps)(req({ action: 'promote', user_id: TARGET }));
  assertEquals(res.status, 401);
});

Deno.test('non-sys-admin -> 403', async () => {
  const { deps } = setup({ caller: { id: 'u', email: 'u@x', is_system_admin: false } });
  const res = await buildHandler(deps)(req({ action: 'promote', user_id: TARGET }));
  assertEquals(res.status, 403);
});

Deno.test('non-POST -> 405', async () => {
  const { deps } = setup();
  assertEquals((await buildHandler(deps)(req({}, 'GET'))).status, 405);
});

Deno.test('OPTIONS -> 204', async () => {
  const { deps } = setup();
  assertEquals((await buildHandler(deps)(req({}, 'OPTIONS'))).status, 204);
});

Deno.test('malformed JSON -> 400', async () => {
  const { deps } = setup();
  const bad = new Request('https://x.test/admin-system-admins', {
    method: 'POST',
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: 'not json',
  });
  assertEquals((await buildHandler(deps)(bad)).status, 400);
});

Deno.test('invalid request -> 422', async () => {
  const { deps } = setup();
  assertEquals((await buildHandler(deps)(req({ action: 'nope', user_id: TARGET }))).status, 422);
});

// ---- Promote --------------------------------------------------------------

Deno.test('promote: flips TRUE before recording granted; emits + 200', async () => {
  const { deps, trace, flips, events } = setup({ rpc: RECORD_OK(true, 2) });
  const res = await buildHandler(deps)(req({ action: 'promote', user_id: TARGET }));

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.action, 'promote');
  assertEquals(body.changed, true);
  assertEquals(body.effective_admin_count, 2);
  assertEquals(body.jwt_stale, true);
  // Asymmetric ordering: flip TRUE strictly before the ledger record.
  assertEquals(trace, ['flip:true', 'rpc:record_admin_change:granted']);
  assertEquals(flips, [{ userId: TARGET, value: true }]);
  assertEquals(events[0].type, 'system_admin.promoted');
  assertEquals(events[0].actor_user_id, CALLER);
  assertEquals(events[0].aggregate_id, TARGET);
  assertEquals((events[0].payload.data as Row).reason, 'peer_promotion');
});

Deno.test('promote by email: resolves, then proceeds', async () => {
  const { deps, flips } = setup({
    rpc: {
      resolve_user_id_by_email: { data: TARGET, error: null },
      ...RECORD_OK(true, 2),
    },
  });
  const res = await buildHandler(deps)(req({ action: 'promote', email: 'x@Y.com' }));
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.user_id, TARGET);
  assertEquals(flips, [{ userId: TARGET, value: true }]);
});

Deno.test('promote by email: a resolver miss -> 404', async () => {
  const { deps, flips } = setup({
    rpc: { resolve_user_id_by_email: { data: null, error: null } },
  });
  const res = await buildHandler(deps)(req({ action: 'promote', email: 'ghost@x.com' }));
  assertEquals(res.status, 404);
  assertEquals(flips, []); // never touched
});

Deno.test('promote idempotent (changed=false) still reconciles the flip', async () => {
  const { deps, flips } = setup({ rpc: RECORD_OK(false, 3) });
  const res = await buildHandler(deps)(req({ action: 'promote', user_id: TARGET }));
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.changed, false);
  assertEquals(flips, [{ userId: TARGET, value: true }]);
});

// ---- Revoke ---------------------------------------------------------------

Deno.test('revoke: records revoked before flipping FALSE; self_revoke reason', async () => {
  const { deps, trace, flips, events } = setup({
    rpc: { ...RECORD_OK(true, 1), assert_sys_admin_exists: { data: null, error: null } },
  });
  // target == caller -> self_revoke
  const res = await buildHandler(deps)(req({ action: 'revoke', user_id: CALLER }));

  assertEquals(res.status, 200);
  assertEquals((await res.json()).action, 'revoke');
  // record 'revoked' strictly before the flip OFF, then the safety assert.
  assertEquals(trace, [
    'rpc:record_admin_change:revoked',
    'flip:false',
    'rpc:assert_sys_admin_exists:',
  ]);
  assertEquals(flips, [{ userId: CALLER, value: false }]);
  assertEquals(events[0].type, 'system_admin.revoked');
  assertEquals((events[0].payload.data as Row).reason, 'self_revoke');
});

Deno.test('revoke of the last admin (UB004) -> 409, no flip', async () => {
  const { deps, flips } = setup({
    rpc: { record_admin_change: { data: null, error: { code: 'UB004' } } },
  });
  const res = await buildHandler(deps)(req({ action: 'revoke', user_id: TARGET }));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, 'last_admin');
  assertEquals(flips, []); // guard fired before any claim change
});

Deno.test('revoke that would zero admins (UB001) -> compensates + 500', async () => {
  const { deps, flips } = setup({
    rpc: {
      ...RECORD_OK(true, 0),
      assert_sys_admin_exists: { data: null, error: { code: 'UB001' } },
    },
  });
  const res = await buildHandler(deps)(req({ action: 'revoke', user_id: TARGET }));
  assertEquals(res.status, 500);
  // flipped false, then compensated back to true.
  assertEquals(flips, [
    { userId: TARGET, value: false },
    { userId: TARGET, value: true },
  ]);
});

Deno.test('revoke fails CLOSED on any assert error (transient), not just UB001', async () => {
  const { deps, flips } = setup({
    rpc: {
      ...RECORD_OK(true, 3),
      assert_sys_admin_exists: { data: null, error: { code: '57014' } }, // timeout
    },
  });
  const res = await buildHandler(deps)(req({ action: 'revoke', user_id: TARGET }));
  assertEquals(res.status, 500);
  // A non-UB001 assert error still compensates (re-admits the target).
  assertEquals(flips, [
    { userId: TARGET, value: false },
    { userId: TARGET, value: true },
  ]);
});

// ---- Failure isolation ----------------------------------------------------

Deno.test('a flip failure -> 500', async () => {
  const { deps } = setup({ rpc: RECORD_OK(true, 2), flipThrows: true });
  const res = await buildHandler(deps)(req({ action: 'promote', user_id: TARGET }));
  assertEquals(res.status, 500);
});

Deno.test('an event-emit failure is swallowed -> still 200', async () => {
  const { deps } = setup({ rpc: RECORD_OK(true, 2), emitThrows: true });
  const res = await buildHandler(deps)(req({ action: 'promote', user_id: TARGET }));
  assertEquals(res.status, 200);
});
