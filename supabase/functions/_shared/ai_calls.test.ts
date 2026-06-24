/**
 * ai_calls.test.ts — T-409. The writer is best-effort: it inserts the row and
 * NEVER throws, even when the DB errors or the client rejects.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { type AiCallRow, insertAiCall } from './ai_calls.ts';

const ROW: AiCallRow = {
  provider: 'ocr_space',
  purpose: 'ocr',
  status: 'success',
  pages_processed: 1,
  latency_ms: 12,
  correlation_id: 'c1',
};

function fakeClient(
  behaviour: { error: { message: string } | null } | Error,
  captured?: { row?: unknown },
): SupabaseClient {
  return {
    from: () => ({
      insert: (row: unknown) => {
        if (captured) captured.row = row;
        return behaviour instanceof Error ? Promise.reject(behaviour) : Promise.resolve(behaviour);
      },
    }),
  } as unknown as SupabaseClient;
}

Deno.test('inserts the row on the happy path', async () => {
  const captured: { row?: unknown } = {};
  await insertAiCall(ROW, { client: fakeClient({ error: null }, captured) });
  assertEquals((captured.row as AiCallRow).provider, 'ocr_space');
  assertEquals((captured.row as AiCallRow).status, 'success');
});

Deno.test('swallows a DB error (never throws)', async () => {
  let threw = false;
  try {
    await insertAiCall(ROW, { client: fakeClient({ error: { message: 'db down' } }) });
  } catch {
    threw = true;
  }
  assert(!threw, 'insertAiCall must not throw on a DB error');
});

Deno.test('swallows a rejected client (never throws)', async () => {
  let threw = false;
  try {
    await insertAiCall(ROW, { client: fakeClient(new Error('connection refused')) });
  } catch {
    threw = true;
  }
  assert(!threw, 'insertAiCall must not throw when the client rejects');
});
