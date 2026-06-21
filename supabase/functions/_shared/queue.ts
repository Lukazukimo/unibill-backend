/**
 * queue.ts — typed pgmq access for the ingestion workers.
 *
 * Ref: T-324/T-325, spec §4.3 / §6.4 / §13
 * Date: 2026-06-21
 *
 * Thin wrappers over the `app.queue_*` SQL functions (migration
 * 20260621120100), called via rpc by the service-role workers. pgmq itself is
 * NOT exposed through PostgREST, so all queue access goes through `app.*`.
 *
 * Conventions:
 *   - visibility-timeout / delay / vt-offset are in SECONDS.
 *   - DLQ "move" is atomic via `queueToDlq` (send to dlq + delete from main in
 *     one DB transaction).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

export type QueueMessage<T> = {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: T;
};

export type QueueDeps = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
};

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Enqueue `msg` onto `queue` (optionally after `delaySeconds`). Returns msg_id. */
export async function queueSend(
  queue: string,
  msg: unknown,
  deps?: QueueDeps & { delaySeconds?: number },
): Promise<number> {
  const client = deps?.client ?? buildServiceClient();
  const { data, error } = await client.rpc('queue_send', {
    p_queue: queue,
    p_msg: msg,
    p_delay: deps?.delaySeconds ?? 0,
  });
  if (error) throw new Error(`queueSend(${queue}) failed: ${error.message}`);
  return data as number;
}

/** Read up to `qty` messages, hiding them for `vtSeconds`. */
export async function queueRead<T = unknown>(
  queue: string,
  vtSeconds: number,
  qty: number,
  deps?: QueueDeps,
): Promise<QueueMessage<T>[]> {
  const client = deps?.client ?? buildServiceClient();
  const { data, error } = await client.rpc('queue_read', {
    p_queue: queue,
    p_vt: vtSeconds,
    p_qty: qty,
  });
  if (error) throw new Error(`queueRead(${queue}) failed: ${error.message}`);
  return (data ?? []) as QueueMessage<T>[];
}

/** ACK (delete) a processed message. Returns whether a row was removed. */
export async function queueDelete(
  queue: string,
  msgId: number,
  deps?: QueueDeps,
): Promise<boolean> {
  const client = deps?.client ?? buildServiceClient();
  const { data, error } = await client.rpc('queue_delete', {
    p_queue: queue,
    p_msg_id: msgId,
  });
  if (error) throw new Error(`queueDelete(${queue}, ${msgId}) failed: ${error.message}`);
  return data as boolean;
}

/** Re-arm the visibility timeout by `vtOffsetSeconds` (retry backoff). */
export async function queueSetVt(
  queue: string,
  msgId: number,
  vtOffsetSeconds: number,
  deps?: QueueDeps,
): Promise<void> {
  const client = deps?.client ?? buildServiceClient();
  const { error } = await client.rpc('queue_set_vt', {
    p_queue: queue,
    p_msg_id: msgId,
    p_vt_offset: vtOffsetSeconds,
  });
  if (error) throw new Error(`queueSetVt(${queue}, ${msgId}) failed: ${error.message}`);
}

/** Atomically move a message from `mainQueue` to `dlqQueue`. Returns the dlq msg_id. */
export async function queueToDlq(
  mainQueue: string,
  dlqQueue: string,
  msgId: number,
  msg: unknown,
  deps?: QueueDeps,
): Promise<number> {
  const client = deps?.client ?? buildServiceClient();
  const { data, error } = await client.rpc('queue_to_dlq', {
    p_main: mainQueue,
    p_dlq: dlqQueue,
    p_msg_id: msgId,
    p_msg: msg,
  });
  if (error) {
    throw new Error(`queueToDlq(${mainQueue} -> ${dlqQueue}, ${msgId}) failed: ${error.message}`);
  }
  return data as number;
}
