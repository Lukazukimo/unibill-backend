import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import {
  queueDelete,
  type QueueMessage,
  queueRead,
  queueSend,
  queueSetVt,
  queueToDlq,
} from './queue.ts';

function fakeClient(data: unknown = null, error: { message: string } | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data, error });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

Deno.test('queueSend forwards to rpc queue_send and returns the msg_id', async () => {
  const { client, calls } = fakeClient(123);
  const id = await queueSend('email_sync_queue', { a: 1 }, { client });
  assertEquals(id, 123);
  assertEquals(calls[0].name, 'queue_send');
  assertEquals(calls[0].args, { p_queue: 'email_sync_queue', p_msg: { a: 1 }, p_delay: 0 });
});

Deno.test('queueSend passes a non-zero delay', async () => {
  const { client, calls } = fakeClient(1);
  await queueSend('q', {}, { client, delaySeconds: 30 });
  assertEquals(calls[0].args.p_delay, 30);
});

Deno.test('queueRead returns typed messages', async () => {
  const rows: Array<QueueMessage<{ x: number }>> = [
    { msg_id: 7, read_ct: 1, enqueued_at: 't', vt: 't', message: { x: 9 } },
  ];
  const { client, calls } = fakeClient(rows);
  const msgs = await queueRead<{ x: number }>('email_sync_queue', 120, 5, { client });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].msg_id, 7);
  assertEquals(msgs[0].message.x, 9);
  assertEquals(calls[0].name, 'queue_read');
  assertEquals(calls[0].args, { p_queue: 'email_sync_queue', p_vt: 120, p_qty: 5 });
});

Deno.test('queueRead returns [] when rpc yields null', async () => {
  const { client } = fakeClient(null);
  assertEquals(await queueRead('q', 1, 1, { client }), []);
});

Deno.test('queueDelete returns the boolean ACK result', async () => {
  const { client, calls } = fakeClient(true);
  assertEquals(await queueDelete('q', 7, { client }), true);
  assertEquals(calls[0].name, 'queue_delete');
  assertEquals(calls[0].args, { p_queue: 'q', p_msg_id: 7 });
});

Deno.test('queueSetVt forwards the offset', async () => {
  const { client, calls } = fakeClient(null);
  await queueSetVt('q', 7, 300, { client });
  assertEquals(calls[0].name, 'queue_set_vt');
  assertEquals(calls[0].args, { p_queue: 'q', p_msg_id: 7, p_vt_offset: 300 });
});

Deno.test('queueToDlq forwards main/dlq/msg and returns the dlq id', async () => {
  const { client, calls } = fakeClient(55);
  const id = await queueToDlq('email_sync_queue', 'email_sync_dlq', 7, { a: 1 }, { client });
  assertEquals(id, 55);
  assertEquals(calls[0].name, 'queue_to_dlq');
  assertEquals(calls[0].args, {
    p_main: 'email_sync_queue',
    p_dlq: 'email_sync_dlq',
    p_msg_id: 7,
    p_msg: { a: 1 },
  });
});

Deno.test('queue helpers throw on rpc error', async () => {
  const { client } = fakeClient(null, { message: 'boom' });
  let threw = false;
  try {
    await queueSend('q', {}, { client });
  } catch {
    threw = true;
  }
  assert(threw);
});
