import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { getGlobalConfig, readBoolConfig, readConfig, readNumberConfig } from './config.ts';

function fakeClient(
  rows: Array<{ key: string; value: unknown }> | null,
  error: { message: string } | null = null,
) {
  const calls = { filters: [] as Array<[string, unknown]> };
  const make = () => {
    const chain = {
      eq(c: string, v: unknown) {
        calls.filters.push([c, v]);
        return chain;
      },
      is(c: string, v: unknown) {
        calls.filters.push([c, v]);
        return chain;
      },
      in(c: string, v: unknown) {
        calls.filters.push([c, v]);
        return Promise.resolve({ data: rows, error });
      },
    };
    return chain;
  };
  const client = {
    from(_t: string) {
      return { select: (_c: string) => make() };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

Deno.test('getGlobalConfig unwraps value.v per key and filters to global scope', async () => {
  const { client, calls } = fakeClient([
    { key: 'features.ingestion_enabled', value: { v: true } },
    { key: 'sync.batch_size', value: { v: 3 } },
  ]);
  const cfg = await getGlobalConfig(['features.ingestion_enabled', 'sync.batch_size'], { client });
  assertEquals(cfg.get('features.ingestion_enabled'), true);
  assertEquals(cfg.get('sync.batch_size'), 3);
  assert(calls.filters.some(([c, v]) => c === 'scope' && v === 'global'));
  assert(calls.filters.some(([c, v]) => c === 'scope_id' && v === null));
  assert(calls.filters.some(([c]) => c === 'key'));
});

Deno.test('getGlobalConfig omits absent keys; readConfig falls back', async () => {
  const { client } = fakeClient([]);
  const cfg = await getGlobalConfig(['x'], { client });
  assertEquals(cfg.has('x'), false);
  assertEquals(readConfig(cfg, 'x', 99), 99);
});

Deno.test('readConfig returns the value when present, fallback on null/absent', () => {
  const m = new Map<string, unknown>([['a', 5], ['b', null]]);
  assertEquals(readConfig(m, 'a', 0), 5);
  assertEquals(readConfig(m, 'b', 0), 0);
  assertEquals(readConfig(m, 'c', 0), 0);
});

Deno.test('readNumberConfig coerces strings and falls back on null/absent/non-finite', () => {
  const m = new Map<string, unknown>([['n', 60], ['s', '120'], ['bad', 'abc'], ['z', null]]);
  assertEquals(readNumberConfig(m, 'n', 3), 60);
  assertEquals(readNumberConfig(m, 's', 3), 120); // string coerced
  assertEquals(readNumberConfig(m, 'bad', 3), 3); // NaN → fallback
  assertEquals(readNumberConfig(m, 'z', 3), 3); // null → fallback
  assertEquals(readNumberConfig(m, 'missing', 3), 3);
});

Deno.test('readBoolConfig coerces booleans/strings/numbers', () => {
  const m = new Map<string, unknown>([['t', true], ['s', 'true'], ['one', 1], ['zero', 0], [
    'z',
    null,
  ]]);
  assertEquals(readBoolConfig(m, 't', false), true);
  assertEquals(readBoolConfig(m, 's', false), true);
  assertEquals(readBoolConfig(m, 'one', false), true);
  assertEquals(readBoolConfig(m, 'zero', true), false);
  assertEquals(readBoolConfig(m, 'z', true), true); // null → fallback
  assertEquals(readBoolConfig(m, 'missing', true), true);
});

Deno.test('getGlobalConfig throws on query error', async () => {
  const { client } = fakeClient(null, { message: 'boom' });
  let threw = false;
  try {
    await getGlobalConfig(['x'], { client });
  } catch {
    threw = true;
  }
  assert(threw);
});
