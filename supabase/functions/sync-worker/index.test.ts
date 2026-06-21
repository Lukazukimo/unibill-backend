import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler, type ImapFetchFn } from './index.ts';

const NOW = Date.parse('2026-06-21T14:00:00.000Z');

type Prior = { id: string; status: string; errors_count: number; started_at: string } | null;

type Scn = {
  messages?: Array<{ msg_id: number; read_ct: number; message: Record<string, unknown> }>;
  config?: Array<{ key: string; value: unknown }>;
  configError?: boolean;
  readError?: boolean;
  circuit?: string;
  rateCount?: number;
  claimed?: Array<{ id: string; email_address: string }>;
  lookup?: { email_address: string } | null;
  prior?: Prior;
  paused?: boolean;
};

function fakeClient(scn: Scn = {}) {
  const cap = {
    deletes: [] as number[],
    setVts: [] as Record<string, unknown>[],
    toDlqs: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    circuitFailures: [] as Record<string, unknown>[],
    circuitSuccesses: [] as Record<string, unknown>[],
    recordErrors: [] as Record<string, unknown>[],
    runUpserts: [] as Record<string, unknown>[],
    runUpdates: [] as Record<string, unknown>[],
    ceUpdates: [] as Record<string, unknown>[],
  };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      switch (name) {
        case 'queue_read':
          if (scn.readError) return Promise.resolve(settled(null, { message: 'read boom' }));
          return Promise.resolve(settled(
            (scn.messages ?? []).map((m) => ({
              msg_id: m.msg_id,
              read_ct: m.read_ct,
              enqueued_at: 't',
              vt: 't',
              message: m.message,
            })),
          ));
        case 'queue_delete':
          cap.deletes.push(args.p_msg_id as number);
          return Promise.resolve(settled(true));
        case 'queue_set_vt':
          cap.setVts.push(args);
          return Promise.resolve(settled(null));
        case 'queue_to_dlq':
          cap.toDlqs.push(args);
          return Promise.resolve(settled(1));
        case 'circuit_begin':
          return Promise.resolve(settled(scn.circuit ?? 'closed'));
        case 'rate_limit_consume':
          return Promise.resolve(settled(scn.rateCount ?? 1));
        case 'circuit_record_success':
          cap.circuitSuccesses.push(args);
          return Promise.resolve(settled(null));
        case 'circuit_record_failure':
          cap.circuitFailures.push(args);
          return Promise.resolve(settled(null));
        case 'record_mailbox_error':
          cap.recordErrors.push(args);
          return Promise.resolve(settled(scn.paused ?? false));
        default:
          return Promise.resolve(settled(null));
      }
    },
    from(table: string) {
      if (table === 'app_settings') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () => c,
          in: () =>
            scn.configError
              ? Promise.resolve(settled(null, { message: 'cfg boom' }))
              : Promise.resolve(settled(scn.config ?? [])),
        };
        return { select: () => c };
      }
      if (table === 'domain_events') {
        return {
          insert: (row: Record<string, unknown>) => {
            cap.events.push(row);
            return Promise.resolve(settled(null));
          },
        };
      }
      if (table === 'connected_emails') {
        return {
          update: (patch: Record<string, unknown>) => {
            cap.ceUpdates.push(patch);
            const chain: Record<string, unknown> = {
              eq: () => chain,
              or: () => chain,
              select: () => Promise.resolve(settled(scn.claimed ?? [])),
              then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
                Promise.resolve(settled(null)).then(f, r),
            };
            return chain;
          },
          select: () => {
            const c: Record<string, unknown> = {
              eq: () => c,
              maybeSingle: () => Promise.resolve(settled(scn.lookup ?? null)),
            };
            return c;
          },
        };
      }
      if (table === 'sync_runs') {
        return {
          select: () => {
            const c: Record<string, unknown> = {
              eq: () => c,
              maybeSingle: () => Promise.resolve(settled(scn.prior ?? null)),
            };
            return c;
          },
          upsert: (row: Record<string, unknown>) => {
            cap.runUpserts.push(row);
            return { select: () => ({ single: () => Promise.resolve(settled({ id: 'run-1' })) }) };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              cap.runUpdates.push(patch);
              return Promise.resolve(settled(null));
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, cap };
}

const CONFIG = [
  { key: 'sync.max_retries', value: { v: 3 } },
  { key: 'sync.consecutive_error_threshold', value: { v: 5 } },
  { key: 'sync.interval_minutes', value: { v: 60 } },
  { key: 'sync.visibility_timeout_s', value: { v: 120 } },
  { key: 'sync.retry_base_s', value: { v: 60 } },
  { key: 'sync.retry_cap_s', value: { v: 1800 } },
];
const okFetch: ImapFetchFn = () =>
  Promise.resolve({ messages_seen: 2, invoices_created: 1, duplicates_skipped: 1 });
const job = (over: Record<string, unknown> = {}) => ({
  connected_email_id: 'ce1',
  correlation_id: 'corr1',
  idempotency_key: 'ce1:2026-06-21T13:47:00.000Z',
  ...over,
});
const claimedRow = [{ id: 'ce1', email_address: 'a@b.com' }];

function run(scn: Scn, doImapFetch: ImapFetchFn, now: () => number = () => NOW) {
  const f = fakeClient(scn);
  return {
    f,
    res: buildHandler({ client: f.client, requireAuth: () => true, now, doImapFetch })(
      new Request('https://x.test/sync-worker', { method: 'POST' }),
    ),
  };
}

Deno.test('happy path: first sight → claim → run → fetch → success + metrics + ACK', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 7, read_ct: 1, message: job() }],
    claimed: claimedRow,
    prior: null,
  }, okFetch);
  const body = await (await res).json();
  assertEquals(body.done, 1);
  assertEquals(f.cap.deletes, [7]);
  assertEquals(f.cap.runUpserts[0].trigger_source, 'scheduled');
  assertEquals(f.cap.runUpserts[0].errors_count, 0);
  const success = f.cap.runUpdates.find((u) => u.status === 'success');
  assertEquals(success?.messages_seen, 2);
  assertEquals(success?.invoices_created, 1);
  assertEquals(success?.duplicates_skipped, 1);
  assert(f.cap.ceUpdates.some((u) => u.consecutive_errors === 0));
});

Deno.test('dead-letters after max_retries REAL failures (errors_count), with payload', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 9, read_ct: 1, message: job() }],
    prior: { id: 'r0', status: 'failed', errors_count: 3, started_at: '2026-06-21T13:00:00.000Z' },
  }, okFetch);
  const body = await (await res).json();
  assertEquals(body.dlq, 1);
  assertEquals(f.cap.toDlqs.length, 1);
  const ev = f.cap.events.find((e) => e.event_type === 'email.sync.dead_lettered');
  assert(ev);
  assertEquals((ev!.payload as { data: { attempts: number } }).data.attempts, 3);
});

Deno.test('dead-letters a poison message past the delivery safety cap', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 9, read_ct: 13, message: job() }], // > max(maxRetries*4, 12)
    prior: { id: 'r0', status: 'failed', errors_count: 1, started_at: '2026-06-21T13:00:00.000Z' },
  }, okFetch);
  assertEquals((await (await res).json()).dlq, 1);
  assertEquals(f.cap.toDlqs.length, 1);
});

Deno.test('skips a duplicate dispatch (claim returns no row)', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 5, read_ct: 1, message: job() }],
    prior: null,
    claimed: [],
  }, okFetch);
  assertEquals((await (await res).json()).skipped, 1);
  assertEquals(f.cap.deletes, [5]);
  assertEquals(f.cap.runUpserts.length, 0);
});

Deno.test('skips when a prior run already succeeded', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 6, read_ct: 1, message: job() }],
    prior: { id: 'r0', status: 'success', errors_count: 0, started_at: '2026-06-21T13:00:00.000Z' },
  }, okFetch);
  assertEquals((await (await res).json()).skipped, 1);
  assertEquals(f.cap.deletes, [6]);
});

Deno.test('skips a concurrent in-flight duplicate (prior running & fresh)', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 6, read_ct: 1, message: job() }],
    prior: {
      id: 'r0',
      status: 'running',
      errors_count: 0,
      started_at: new Date(NOW).toISOString(),
    },
  }, okFetch);
  assertEquals((await (await res).json()).skipped, 1);
  assertEquals(f.cap.deletes, [6]);
  assertEquals(f.cap.runUpserts.length, 0);
});

Deno.test('real failure: errors_count++ + record_mailbox_error (redacted) + backoff value', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 8, read_ct: 1, message: job() }],
    claimed: claimedRow,
    prior: null,
    paused: false,
  }, () => Promise.reject(new Error('imap connect failed pwqprsltuvwxabcd')));
  const body = await (await res).json();
  assertEquals(body.retried, 1);
  assertEquals(f.cap.recordErrors.length, 1);
  assert(String(f.cap.recordErrors[0].p_error).includes('[REDACTED_APP_PASSWORD]'));
  const failed = f.cap.runUpdates.find((u) => u.status === 'failed');
  assertEquals(failed?.errors_count, 1);
  assertEquals(f.cap.setVts[0].p_vt_offset, 60); // backoff(1) = base 60
  assertEquals(f.cap.deletes.length, 0);
  assert(!f.cap.events.some((e) => e.event_type === 'email.sync.auto_paused'));
});

Deno.test('retry of a prior FAILED run: skip claim, trigger_source=retry, errors_count preserved, backoff grows', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 8, read_ct: 2, message: job() }],
    prior: { id: 'r0', status: 'failed', errors_count: 1, started_at: '2026-06-21T13:00:00.000Z' },
    lookup: { email_address: 'a@b.com' },
  }, () => Promise.reject(new Error('still down')));
  const body = await (await res).json();
  assertEquals(body.retried, 1);
  assertEquals(f.cap.runUpserts[0].trigger_source, 'retry');
  assertEquals(f.cap.runUpserts[0].errors_count, 1);
  assertEquals(f.cap.ceUpdates.length, 0); // claim skipped
  const failed = f.cap.runUpdates.find((u) => u.status === 'failed');
  assertEquals(failed?.errors_count, 2);
  assertEquals(f.cap.setVts[0].p_vt_offset, 120); // backoff(2) = 60*2
});

Deno.test('emits auto_paused exactly once on the threshold transition', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 8, read_ct: 1, message: job() }],
    claimed: claimedRow,
    prior: null,
    paused: true,
  }, () => Promise.reject(new Error('imap down')));
  await (await res).json();
  const paused = f.cap.events.filter((e) => e.event_type === 'email.sync.auto_paused');
  assertEquals(paused.length, 1);
  assertEquals((paused[0].payload as { data: { threshold: number } }).data.threshold, 5);
});

Deno.test('rate-limit backs off WITHOUT a mailbox/circuit error', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 8, read_ct: 1, message: job() }],
    claimed: claimedRow,
    prior: null,
    rateCount: 11,
  }, okFetch);
  assertEquals((await (await res).json()).retried, 1);
  assertEquals(f.cap.setVts.length, 1);
  assertEquals(f.cap.recordErrors.length, 0);
  assertEquals(f.cap.circuitFailures.length, 0);
});

Deno.test('open circuit backs off without recording a mailbox error', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 8, read_ct: 1, message: job() }],
    claimed: claimedRow,
    prior: null,
    circuit: 'open',
  }, okFetch);
  assertEquals((await (await res).json()).retried, 1);
  assertEquals(f.cap.recordErrors.length, 0);
  assertEquals(f.cap.setVts.length, 1);
});

Deno.test('retry whose mailbox got auto-paused (lookup inactive) is dropped', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [{ msg_id: 8, read_ct: 2, message: job() }],
    prior: { id: 'r0', status: 'failed', errors_count: 1, started_at: '2026-06-21T13:00:00.000Z' },
    lookup: null,
  }, okFetch);
  assertEquals((await (await res).json()).skipped, 1);
  assertEquals(f.cap.deletes, [8]);
});

Deno.test('processes a batch with mixed outcomes + correct tally', async () => {
  const { f, res } = run({
    config: CONFIG,
    messages: [
      { msg_id: 1, read_ct: 1, message: job({ idempotency_key: 'k1' }) },
      { msg_id: 2, read_ct: 1, message: job({ idempotency_key: 'k2' }) },
    ],
    claimed: claimedRow,
    prior: null,
  }, okFetch);
  const body = await (await res).json();
  assertEquals(body.processed, 2);
  assertEquals(body.done, 2);
  assertEquals(f.cap.deletes.sort(), [1, 2]);
});

Deno.test('runtime cap stops the loop, leaving later messages for the next tick', async () => {
  let i = 0;
  const clock = () => (i++ < 2 ? NOW : NOW + 1_000_000);
  const { f, res } = run(
    {
      config: CONFIG,
      messages: [
        { msg_id: 1, read_ct: 1, message: job({ idempotency_key: 'k1' }) },
        { msg_id: 2, read_ct: 1, message: job({ idempotency_key: 'k2' }) },
      ],
      claimed: claimedRow,
      prior: null,
    },
    okFetch,
    clock,
  );
  const body = await (await res).json();
  assertEquals(body.processed, 1);
  assertEquals(f.cap.deletes, [1]);
});

Deno.test('returns 500 on config / queue-read failure; 401 / 405', async () => {
  assertEquals((await run({ configError: true }, okFetch).res).status, 500);
  assertEquals((await run({ config: CONFIG, readError: true }, okFetch).res).status, 500);

  const a = fakeClient({ config: CONFIG });
  const r401 = await buildHandler({
    client: a.client,
    requireAuth: () => false,
    now: () => NOW,
    doImapFetch: okFetch,
  })(new Request('https://x.test/sync-worker', { method: 'POST' }));
  assertEquals(r401.status, 401);
  const r405 = await buildHandler({
    client: a.client,
    requireAuth: () => true,
    now: () => NOW,
    doImapFetch: okFetch,
  })(new Request('https://x.test/sync-worker', { method: 'GET' }));
  assertEquals(r405.status, 405);
});
