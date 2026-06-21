import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { AmbiguousBindingError, BindingNotFoundError } from './errors.ts';
import { resolveTargetHousehold } from './household.ts';

function fakeClient(
  opts: {
    rows?: Array<{ household_id: string; is_default: boolean }>;
    error?: { message: string };
  } = {},
) {
  const calls: { eqs: Array<[string, unknown]>; isNulls: string[] } = { eqs: [], isNulls: [] };
  const client = {
    from(_table: string) {
      return {
        select(_cols: string) {
          const chain = {
            eq(col: string, value: unknown) {
              calls.eqs.push([col, value]);
              return chain;
            },
            is(col: string, _v: null) {
              calls.isNulls.push(col);
              return Promise.resolve(
                opts.error
                  ? { data: null, error: opts.error }
                  : { data: opts.rows ?? [], error: null },
              );
            },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

Deno.test('resolveTargetHousehold returns the only active binding', async () => {
  const { client, calls } = fakeClient({ rows: [{ household_id: 'h1', is_default: false }] });
  assertEquals(await resolveTargetHousehold('ce1', { client }), 'h1');
  // queried the active bindings of the email.
  assert(calls.eqs.some(([c, v]) => c === 'connected_email_id' && v === 'ce1'));
  assert(calls.isNulls.includes('deleted_at'));
});

Deno.test('resolveTargetHousehold returns the default when there are several bindings', async () => {
  const { client } = fakeClient({
    rows: [
      { household_id: 'h1', is_default: false },
      { household_id: 'h2', is_default: true },
      { household_id: 'h3', is_default: false },
    ],
  });
  assertEquals(await resolveTargetHousehold('ce1', { client }), 'h2');
});

Deno.test('resolveTargetHousehold throws AmbiguousBindingError when several bindings and no default', async () => {
  const { client } = fakeClient({
    rows: [
      { household_id: 'h1', is_default: false },
      { household_id: 'h2', is_default: false },
    ],
  });
  let err: unknown = null;
  try {
    await resolveTargetHousehold('ce1', { client });
  } catch (e) {
    err = e;
  }
  assert(err instanceof AmbiguousBindingError);
  assertEquals((err as AmbiguousBindingError).count, 2);
});

Deno.test('resolveTargetHousehold throws BindingNotFoundError when no active bindings', async () => {
  const { client } = fakeClient({ rows: [] });
  let err: unknown = null;
  try {
    await resolveTargetHousehold('ce1', { client });
  } catch (e) {
    err = e;
  }
  assert(err instanceof BindingNotFoundError);
});

Deno.test('resolveTargetHousehold throws when the lookup fails', async () => {
  const { client } = fakeClient({ error: { message: 'db down' } });
  let threw = false;
  try {
    await resolveTargetHousehold('ce1', { client });
  } catch (e) {
    threw = e instanceof Error && !(e instanceof BindingNotFoundError);
  }
  assert(threw);
});
