import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withRunRow } from './runs.ts';

const RUN_ID = '44444444-4444-4444-8444-444444444444';

function fakeRunsClient(opts: { insertError?: { message: string } } = {}) {
  const calls = {
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; patch: Record<string, unknown>; id: unknown }>,
  };
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          calls.inserts.push({ table, row });
          return {
            select() {
              return {
                single() {
                  return Promise.resolve(
                    opts.insertError
                      ? { data: null, error: opts.insertError }
                      : { data: { id: RUN_ID }, error: null },
                  );
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_col: string, val: unknown) {
              calls.updates.push({ table, patch, id: val });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const SYNC_INITIAL = {
  correlation_id: 'c',
  connected_email_id: 'e',
  idempotency_key: 'k',
  trigger_source: 'scheduled',
};

Deno.test('withRunRow opens a running row, runs fn, closes as success', async () => {
  const { client, calls } = fakeRunsClient();
  let seenRunId: string | null = null;
  const out = await withRunRow(
    'sync_runs',
    SYNC_INITIAL,
    (run_id) => {
      seenRunId = run_id;
      return Promise.resolve('done');
    },
    { client, clock: () => 1000 },
  );
  assertEquals(out, 'done');
  assertEquals(seenRunId, RUN_ID);
  assertEquals(calls.inserts.length, 1);
  assertEquals(calls.inserts[0].table, 'sync_runs');
  assertEquals(calls.inserts[0].row.status, 'running');
  assertEquals(calls.inserts[0].row.idempotency_key, 'k');
  assertEquals(calls.updates.length, 1);
  assertEquals(calls.updates[0].patch.status, 'success');
  assertEquals(calls.updates[0].id, RUN_ID);
});

Deno.test('withRunRow applies the finalize patch (partial + metrics)', async () => {
  const { client, calls } = fakeRunsClient();
  await withRunRow(
    'sync_runs',
    SYNC_INITIAL,
    () => Promise.resolve({ created: 2 }),
    {
      client,
      finalize: (r) => ({ status: 'partial', invoices_created: r.created }),
    },
  );
  assertEquals(calls.updates[0].patch.status, 'partial');
  assertEquals(calls.updates[0].patch.invoices_created, 2);
});

Deno.test('withRunRow marks failed and redacts error_summary on throw', async () => {
  const { client, calls } = fakeRunsClient();
  let threw = false;
  try {
    await withRunRow(
      'sync_runs',
      SYNC_INITIAL,
      () => Promise.reject(new Error('imap auth failed pwqprsltuvwxabcd')),
      { client },
    );
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(calls.updates[0].patch.status, 'failed');
  assertEquals(calls.updates[0].patch.errors_count, 1); // sync_runs HAS this column
  const summary = String(calls.updates[0].patch.error_summary);
  assert(summary.includes('[REDACTED_APP_PASSWORD]'));
  assert(!summary.includes('pwqprsltuvwxabcd'));
});

Deno.test('withRunRow on extraction_runs failure omits errors_count (no such column)', async () => {
  const { client, calls } = fakeRunsClient();
  let threw = false;
  try {
    await withRunRow(
      'extraction_runs',
      { correlation_id: 'c', invoice_id: 'i' },
      () => Promise.reject(new Error('boom')),
      { client },
    );
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(calls.updates[0].patch.status, 'failed');
  assertEquals('errors_count' in calls.updates[0].patch, false);
});

Deno.test('withRunRow throws and skips fn when the insert fails', async () => {
  const { client, calls } = fakeRunsClient({ insertError: { message: 'no insert' } });
  let ran = false;
  let threw = false;
  try {
    await withRunRow('sync_runs', { correlation_id: 'c' }, () => {
      ran = true;
      return Promise.resolve('x');
    }, { client });
  } catch {
    threw = true;
  }
  assert(threw);
  assert(!ran);
  assertEquals(calls.updates.length, 0);
});
