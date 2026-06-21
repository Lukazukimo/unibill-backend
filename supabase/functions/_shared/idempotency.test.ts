import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withIdempotency } from './idempotency.ts';

function fakeClient(
  opts: { existing?: boolean; lookupError?: { message: string } } = {},
) {
  const calls = { selects: [] as Array<{ table: string; field: string; value: unknown }> };
  const client = {
    from(table: string) {
      return {
        select(field: string) {
          return {
            eq(_f: string, value: unknown) {
              return {
                limit(_n: number) {
                  return {
                    maybeSingle() {
                      calls.selects.push({ table, field, value });
                      if (opts.lookupError) {
                        return Promise.resolve({ data: null, error: opts.lookupError });
                      }
                      return Promise.resolve({
                        data: opts.existing ? { [field]: value } : null,
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

Deno.test('withIdempotency skips the body when the key already exists', async () => {
  const { client } = fakeClient({ existing: true });
  let ran = false;
  const res = await withIdempotency('sync_runs', 'idempotency_key', 'k1', () => {
    ran = true;
    return Promise.resolve();
  }, { client });
  assertEquals(res.skipped, true);
  assertEquals(res.reason, 'duplicate');
  assert(!ran);
});

Deno.test('withIdempotency runs the body when the key is fresh', async () => {
  const { client, calls } = fakeClient({ existing: false });
  let ran = false;
  const res = await withIdempotency('sync_runs', 'idempotency_key', 'k2', () => {
    ran = true;
    return Promise.resolve();
  }, { client });
  assertEquals(res.skipped, false);
  assert(ran);
  assertEquals(calls.selects[0], { table: 'sync_runs', field: 'idempotency_key', value: 'k2' });
});

Deno.test("withIdempotency propagates the body's unique-violation (does not swallow the 23505 backstop)", async () => {
  const { client } = fakeClient({ existing: false });
  const dupErr = Object.assign(new Error('duplicate key value'), { code: '23505' });
  let caught: unknown = null;
  try {
    await withIdempotency('sync_runs', 'idempotency_key', 'k4', () => Promise.reject(dupErr), {
      client,
    });
  } catch (e) {
    caught = e;
  }
  assertEquals(caught, dupErr); // surfaced, NOT turned into { skipped: true }
});

Deno.test('withIdempotency throws when the lookup fails', async () => {
  const { client } = fakeClient({ lookupError: { message: 'db down' } });
  let threw = false;
  try {
    await withIdempotency('sync_runs', 'idempotency_key', 'k3', () => Promise.resolve(), {
      client,
    });
  } catch {
    threw = true;
  }
  assert(threw);
});
