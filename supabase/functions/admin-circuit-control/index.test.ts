import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler } from './index.ts';
import { breakerRow, parseRequest } from './control.ts';

const sc = (c: FakeClient) => c as unknown as SupabaseClient;

type Row = Record<string, unknown>;

class FakeClient {
  upserts: Array<{ table: string; row: Row; opts: unknown }> = [];
  rpcs: Array<{ fn: string; params: Row }> = [];
  events: Row[] = [];
  rpcState = 'open';
  upsertError: string | null = null;

  from(table: string) {
    return {
      upsert: (row: Row, opts: unknown) => {
        this.upserts.push({ table, row, opts });
        return Promise.resolve({ error: this.upsertError ? { message: this.upsertError } : null });
      },
      insert: (row: Row) => {
        if (table === 'domain_events') this.events.push(row);
        return Promise.resolve({ error: null });
      },
    };
  }
  rpc(fn: string, params: Row) {
    this.rpcs.push({ fn, params });
    return Promise.resolve({ data: this.rpcState, error: null });
  }
}

const AT = new Date('2026-07-06T12:00:00.000Z');
const admin = () => Promise.resolve({ id: 'admin-1', email: 'a@x', is_system_admin: true });
const req = (body: unknown, method = 'POST') =>
  new Request('https://x.test/admin-circuit-control', {
    method,
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
const deps = (client: FakeClient) => ({ client: sc(client), getCallerUser: admin, now: () => AT });

const OPEN = {
  resource_type: 'ocr_provider',
  resource_key: 'ocr_space',
  action: 'force_open',
  reason: 'manual',
};

Deno.test('parseRequest accepts a valid force_open body', () => {
  const p = parseRequest(OPEN);
  assertEquals(p?.action, 'force_open');
  assertEquals(p?.reason, 'manual');
});

Deno.test('parseRequest rejects an unknown resource_type / action', () => {
  assertEquals(parseRequest({ ...OPEN, resource_type: 'db' }), null);
  assertEquals(parseRequest({ ...OPEN, action: 'delete' }), null);
  assertEquals(parseRequest('nope'), null);
});

Deno.test('breakerRow(force_open) opens with a cooldown; force_closed resets', () => {
  const open = breakerRow('force_open', 'r', AT);
  assertEquals(open.state, 'open');
  assertEquals(open.opened_at, AT.toISOString());
  assertEquals(open.next_probe_at, '2026-07-06T12:01:00.000Z');
  const closed = breakerRow('force_closed', 'r', AT);
  assertEquals(closed.state, 'closed');
  assertEquals(closed.failure_count, 0);
  assertEquals(closed.reason, null);
  // Both forced states reset the half-open / backoff counters (no stale values).
  for (const r of [open, closed]) {
    assertEquals(r.probes_sent, 0);
    assertEquals(r.probes_succeeded, 0);
    assertEquals(r.reopen_count, 0);
  }
});

Deno.test('non-POST → 405', async () => {
  const res = await buildHandler(deps(new FakeClient()))(req(OPEN, 'GET'));
  assertEquals(res.status, 405);
});

Deno.test('missing JWT → 401', async () => {
  const res = await buildHandler({
    client: sc(new FakeClient()),
    getCallerUser: () => Promise.resolve(null),
    now: () => AT,
  })(req(OPEN));
  assertEquals(res.status, 401);
});

Deno.test('non-sys-admin → 403', async () => {
  const res = await buildHandler({
    client: sc(new FakeClient()),
    getCallerUser: () => Promise.resolve({ id: 'u', email: 'u@x', is_system_admin: false }),
    now: () => AT,
  })(req(OPEN));
  assertEquals(res.status, 403);
});

Deno.test('invalid body → 422', async () => {
  const res = await buildHandler(deps(new FakeClient()))(req({ resource_type: 'db' }));
  assertEquals(res.status, 422);
});

Deno.test('force_open upserts the breaker open + emits an audit event', async () => {
  const client = new FakeClient();
  const res = await buildHandler(deps(client))(req(OPEN));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).state, 'open');
  assertEquals(client.upserts.length, 1);
  assertEquals(client.upserts[0].row.resource_key, 'ocr_space');
  assertEquals(client.upserts[0].row.state, 'open');
  assertEquals(client.events.length, 1);
  assertEquals(client.events[0].event_type, 'circuit.admin_controlled');
  // Audit must attribute the admin on the canonical column and use a valid
  // UUID aggregate_id (a non-UUID would throw on insert and lose the audit).
  assertEquals(client.events[0].actor_user_id, 'admin-1');
  assertEquals(client.events[0].aggregate_id, '00000000-0000-0000-0000-000000000000');
});

Deno.test('force_closed upserts the breaker closed', async () => {
  const client = new FakeClient();
  const res = await buildHandler(deps(client))(
    req({ ...OPEN, action: 'force_closed', reason: null }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).state, 'closed');
  assertEquals(client.upserts[0].row.state, 'closed');
});

Deno.test('simulate_failure calls circuit_record_failure and returns its state', async () => {
  const client = new FakeClient();
  client.rpcState = 'open';
  const res = await buildHandler(deps(client))(
    req({ ...OPEN, action: 'simulate_failure' }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).state, 'open');
  assertEquals(client.rpcs.length, 1);
  assertEquals(client.rpcs[0].fn, 'circuit_record_failure');
  assertEquals(client.rpcs[0].params.p_resource_key, 'ocr_space');
  assertEquals(client.upserts.length, 0); // simulate goes through the state machine
});

Deno.test('an upsert error → 500', async () => {
  const client = new FakeClient();
  client.upsertError = 'boom';
  const res = await buildHandler(deps(client))(req(OPEN));
  assertEquals(res.status, 500);
});

Deno.test('OPTIONS → 204', async () => {
  const res = await buildHandler(deps(new FakeClient()))(
    new Request('https://x.test/admin-circuit-control', { method: 'OPTIONS' }),
  );
  assertEquals(res.status, 204);
  assert(res.headers.get('access-control-allow-methods')?.includes('POST'));
});
