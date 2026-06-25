/**
 * index.test.ts — T-603 capacity-evictor consumer loop. fakeClient (queue RPCs +
 * eviction_runs insert/update via withRunRow) + injected runEviction.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler, type EvictionJob, type EvictionResult } from './index.ts';

const NOW = Date.parse('2026-06-25T12:00:00.000Z');

function fakeClient(messages: Array<{ msg_id: number; read_ct: number; message: EvictionJob }>) {
  const cap = {
    deletes: [] as number[],
    setVts: [] as Record<string, unknown>[],
    toDlqs: [] as Record<string, unknown>[],
    runInserts: [] as Record<string, unknown>[],
    runUpdates: [] as Record<string, unknown>[],
  };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      switch (name) {
        case 'queue_read':
          return Promise.resolve(settled(
            messages.map((m) => ({
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
        default:
          return Promise.resolve(settled(null));
      }
    },
    from(table: string) {
      if (table === 'eviction_runs') {
        return {
          insert: (row: Record<string, unknown>) => {
            cap.runInserts.push(row);
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

const job = (over: Partial<EvictionJob> = {}): EvictionJob => ({
  resource_type: 'db',
  trigger_reason: 'db_red',
  trigger_pct: 95,
  target_pct: 60,
  correlation_id: 'corr1',
  ...over,
});

const msg = (over: Partial<EvictionJob> = {}, read_ct = 1) => ({
  msg_id: 9,
  read_ct,
  message: job(over),
});

const result = (over: Partial<EvictionResult> = {}): EvictionResult => ({
  steps: [{ tier: 1, action: 'trim_logs', detail: {} }],
  finalPct: 55,
  converged: true,
  freedBytes: 1000,
  ...over,
});

function mk(messages: ReturnType<typeof msg>[], runEviction: () => Promise<EvictionResult>) {
  const f = fakeClient(messages);
  const handler = buildHandler({
    client: f.client,
    requireAuth: () => true,
    now: () => NOW,
    runEviction,
  });
  return { handler, cap: f.cap };
}

const post = () => new Request('https://x/capacity-evictor', { method: 'POST' });

Deno.test('converged run → eviction_runs success + freed/steps + ACK', async () => {
  const { handler, cap } = mk([msg()], () => Promise.resolve(result()));
  const body = await (await handler(post())).json();
  assertEquals(body, { processed: 1, done: 1, dlq: 0, retried: 0 });
  assertEquals(cap.runInserts.length, 1);
  assertEquals(cap.runInserts[0].resource_type, 'db');
  const fin = cap.runUpdates.find((u) => 'final_pct' in u)!;
  assertEquals(fin.status, 'success');
  assertEquals(fin.final_pct, 55);
  assertEquals(fin.total_freed_bytes, 1000);
  assertEquals(cap.deletes, [9]);
});

Deno.test('non-converged run → eviction_runs partial, still ACKed', async () => {
  const { handler, cap } = mk(
    [msg()],
    () => Promise.resolve(result({ converged: false, finalPct: 72 })),
  );
  const body = await (await handler(post())).json();
  assertEquals(body.done, 1);
  assertEquals(cap.runUpdates.find((u) => 'final_pct' in u)!.status, 'partial');
  assertEquals(cap.deletes, [9]);
});

Deno.test('read_ct past the retry cap → DLQ, no run', async () => {
  const { handler, cap } = mk([msg({}, 4)], () => Promise.resolve(result()));
  const body = await (await handler(post())).json();
  assertEquals(body.dlq, 1);
  assertEquals(cap.toDlqs.length, 1);
  assertEquals(cap.runInserts.length, 0);
  assertEquals(cap.deletes.length, 0);
});

Deno.test('runEviction throws → backoff (set_vt) + retry, no ACK; run recorded failed', async () => {
  const { handler, cap } = mk([msg()], () => Promise.reject(new Error('measure boom')));
  const body = await (await handler(post())).json();
  assertEquals(body.retried, 1);
  assertEquals(cap.setVts.length, 1);
  assertEquals(cap.deletes.length, 0);
  assert(cap.runUpdates.some((u) => u.status === 'failed'));
});

Deno.test('auth: non-POST → 405; missing service role → 401', async () => {
  const { handler } = mk([], () => Promise.resolve(result()));
  assertEquals(
    (await handler(new Request('https://x/capacity-evictor', { method: 'GET' }))).status,
    405,
  );
  const f = fakeClient([]);
  const denied = buildHandler({
    client: f.client,
    requireAuth: () => false,
    runEviction: () => Promise.resolve(result()),
  });
  assertEquals((await denied(post())).status, 401);
});
