import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler } from './index.ts';

const NOW = Date.parse('2026-06-21T13:47:32.500Z');
const MINUTE = '2026-06-21T13:47:00.000Z';

type FakeOpts = {
  config?: Array<{ key: string; value: unknown }>;
  emails?: Array<{ id: string; email_address: string }>;
  openBreakers?: Array<{ resource_key: string }>;
  sendError?: boolean;
  configError?: boolean;
  emailsError?: boolean;
  breakersError?: boolean;
};

function fakeClient(opts: FakeOpts = {}) {
  const enqueued: Array<Record<string, unknown>> = [];
  const filters = {
    connected_emails: [] as Array<[string, unknown]>,
    circuit_breakers: [] as Array<[string, unknown]>,
    app_settings: [] as Array<[string, unknown]>,
  };
  const captured: { limit?: number; order?: { col: string; opts: unknown } } = {};
  const settled = (data: unknown, error: { message: string } | null = null) =>
    Promise.resolve({ data, error });

  const client = {
    from(table: string) {
      if (table === 'app_settings') {
        const c: Record<string, unknown> = {
          eq: (k: string, v: unknown) => (filters.app_settings.push([k, v]), c),
          is: (k: string, v: unknown) => (filters.app_settings.push([k, v]), c),
          in: (k: string, v: unknown) => (
            filters.app_settings.push([k, v]),
              opts.configError ? settled(null, { message: 'cfg boom' }) : settled(opts.config ?? [])
          ),
        };
        return { select: () => c };
      }
      if (table === 'connected_emails') {
        const c: Record<string, unknown> = {
          eq: (k: string, v: unknown) => (filters.connected_emails.push([k, v]), c),
          is: (k: string, v: unknown) => (filters.connected_emails.push([k, v]), c),
          or: (s: string) => (filters.connected_emails.push(['or', s]), c),
          order: (col: string, o: unknown) => (captured.order = { col, opts: o }, c),
          limit: (n: number) => (
            captured.limit = n,
              opts.emailsError ? settled(null, { message: 'sel boom' }) : settled(opts.emails ?? [])
          ),
        };
        return { select: () => c };
      }
      if (table === 'circuit_breakers') {
        const c: Record<string, unknown> = {
          eq: (k: string, v: unknown) => (filters.circuit_breakers.push([k, v]), c),
          in: (k: string, v: unknown) => (
            filters.circuit_breakers.push([k, v]),
              opts.breakersError
                ? settled(null, { message: 'cb boom' })
                : settled(opts.openBreakers ?? [])
          ),
        };
        return { select: () => c };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'queue_send') {
        if (opts.sendError) return settled(null, { message: 'send boom' });
        enqueued.push(args);
        return settled(enqueued.length);
      }
      return settled(null);
    },
  } as unknown as SupabaseClient;
  return { client, enqueued, filters, captured };
}

const CONFIG_ON = [
  { key: 'features.ingestion_enabled', value: { v: true } },
  { key: 'sync.batch_size', value: { v: 5 } },
  { key: 'sync.interval_minutes', value: { v: 60 } },
];

function post(deps: Parameters<typeof buildHandler>[0]) {
  return buildHandler(deps)(new Request('https://x.test/sync-dispatcher', { method: 'POST' }));
}
const okDeps = (client: SupabaseClient) => ({ client, requireAuth: () => true, now: () => NOW });

Deno.test('sync-dispatcher enqueues each due email with idempotency_key + applies the due-filters', async () => {
  const f = fakeClient({
    config: CONFIG_ON,
    emails: [{ id: 'ce1', email_address: 'a@b.com' }, { id: 'ce2', email_address: 'c@d.com' }],
  });
  const res = await post(okDeps(f.client));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enqueued, 2);
  assertEquals(body.selected, 2);
  assertEquals(f.enqueued.length, 2);
  // payload
  assertEquals(f.enqueued[0].p_queue, 'email_sync_queue');
  const msg0 = f.enqueued[0].p_msg as Record<string, unknown>;
  assertEquals(msg0.connected_email_id, 'ce1');
  assertEquals(msg0.idempotency_key, `ce1:${MINUTE}`);
  assertEquals(msg0.attempt, 1);
  // due-filters actually applied (regression guard)
  assert(f.filters.connected_emails.some(([k, v]) => k === 'status' && v === 'active'));
  assert(f.filters.connected_emails.some(([k, v]) => k === 'deleted_at' && v === null));
  assert(f.filters.connected_emails.some(([k]) => k === 'or'));
  assertEquals(f.captured.limit, 5); // batch_size
  assertEquals(f.captured.order, {
    col: 'last_sync_at',
    opts: { ascending: true, nullsFirst: true },
  });
});

Deno.test('sync-dispatcher skips when ingestion is disabled', async () => {
  const f = fakeClient({
    config: [{ key: 'features.ingestion_enabled', value: { v: false } }],
    emails: [{ id: 'ce1', email_address: 'a@b.com' }],
  });
  const body = await (await post(okDeps(f.client))).json();
  assertEquals(body.skipped, 'ingestion_disabled');
  assertEquals(body.enqueued, 0);
  assertEquals(f.enqueued.length, 0);
});

Deno.test('sync-dispatcher uses defaults when config keys are absent (ingestion on, batch 3)', async () => {
  const f = fakeClient({ config: [], emails: [] });
  const res = await post(okDeps(f.client));
  assertEquals(res.status, 200);
  assertEquals(f.captured.limit, 3); // default sync.batch_size
});

Deno.test('sync-dispatcher filters out emails with an OPEN circuit breaker', async () => {
  const f = fakeClient({
    config: CONFIG_ON,
    emails: [{ id: 'ce1', email_address: 'a@b.com' }, { id: 'ce2', email_address: 'c@d.com' }],
    openBreakers: [{ resource_key: 'a@b.com' }],
  });
  const body = await (await post(okDeps(f.client))).json();
  assertEquals(body.enqueued, 1);
  assertEquals(body.skipped_open_circuit, 1);
  assertEquals((f.enqueued[0].p_msg as Record<string, unknown>).connected_email_id, 'ce2');
});

Deno.test('sync-dispatcher enqueues nothing when ALL due mailboxes are circuit-open', async () => {
  const f = fakeClient({
    config: CONFIG_ON,
    emails: [{ id: 'ce1', email_address: 'a@b.com' }, { id: 'ce2', email_address: 'c@d.com' }],
    openBreakers: [{ resource_key: 'a@b.com' }, { resource_key: 'c@d.com' }],
  });
  const body = await (await post(okDeps(f.client))).json();
  assertEquals(body.enqueued, 0);
  assertEquals(body.skipped_open_circuit, 2);
});

Deno.test('sync-dispatcher returns {selected:0} and skips the breaker query when nothing is due', async () => {
  const f = fakeClient({ config: CONFIG_ON, emails: [] });
  const body = await (await post(okDeps(f.client))).json();
  assertEquals(body.selected, 0);
  assertEquals(body.enqueued, 0);
  assertEquals(f.filters.circuit_breakers.length, 0); // never queried breakers
});

Deno.test('sync-dispatcher proceeds (enqueues all) when the circuit-breaker query errors', async () => {
  const f = fakeClient({
    config: CONFIG_ON,
    emails: [{ id: 'ce1', email_address: 'a@b.com' }],
    breakersError: true,
  });
  const res = await post(okDeps(f.client));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enqueued, 1); // best-effort: breaker failure does not block dispatch
  assertEquals(body.skipped_open_circuit, 0);
});

Deno.test('sync-dispatcher returns 500 when the config read fails', async () => {
  const f = fakeClient({ configError: true });
  const res = await post(okDeps(f.client));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).code, 'config_failed');
  assertEquals(f.enqueued.length, 0);
});

Deno.test('sync-dispatcher returns 500 when the connected_emails query fails', async () => {
  const f = fakeClient({ config: CONFIG_ON, emailsError: true });
  const res = await post(okDeps(f.client));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).code, 'select_failed');
  assertEquals(f.enqueued.length, 0);
});

Deno.test('sync-dispatcher returns 401 when the service-role check fails', async () => {
  const f = fakeClient({ config: CONFIG_ON, emails: [] });
  const res = await post({ client: f.client, requireAuth: () => false, now: () => NOW });
  assertEquals(res.status, 401);
  assertEquals(f.enqueued.length, 0);
});

Deno.test('sync-dispatcher rejects non-POST', async () => {
  const f = fakeClient({ config: CONFIG_ON });
  const res = await buildHandler(okDeps(f.client))(
    new Request('https://x.test/sync-dispatcher', { method: 'GET' }),
  );
  assertEquals(res.status, 405);
});

Deno.test('sync-dispatcher counts only successful enqueues (send failure does not throw)', async () => {
  const f = fakeClient({
    config: CONFIG_ON,
    emails: [{ id: 'ce1', email_address: 'a@b.com' }],
    sendError: true,
  });
  const res = await post(okDeps(f.client));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).enqueued, 0);
});
