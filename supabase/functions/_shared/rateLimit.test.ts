import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { RateLimitError } from './errors.ts';
import { floorToRateWindow, peekRateLimit, withRateLimit } from './rateLimit.ts';

function fakeClient(opts: { count?: number | null; rpcError?: { message: string } } = {}) {
  const calls = { rpc: [] as Array<{ name: string; args: Record<string, unknown> }> };
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      return Promise.resolve(
        opts.rpcError
          ? { data: null, error: opts.rpcError }
          : { data: 'count' in opts ? opts.count : 1, error: null },
      );
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function fakePeekClient(
  opts: { row?: { count: number } | null; error?: { message: string } } = {},
) {
  const calls = { eqs: [] as Array<[string, unknown]> };
  const client = {
    from(_table: string) {
      return {
        select(_cols: string) {
          const chain = {
            eq(col: string, value: unknown) {
              calls.eqs.push([col, value]);
              return chain;
            },
            maybeSingle() {
              return Promise.resolve(
                opts.error
                  ? { data: null, error: opts.error }
                  : { data: opts.row ?? null, error: null },
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

const T = Date.parse('2026-06-21T13:47:32.500Z');

Deno.test('floorToRateWindow floors to the window boundary (UTC)', () => {
  assertEquals(floorToRateWindow('1hour', T).toISOString(), '2026-06-21T13:00:00.000Z');
  assertEquals(floorToRateWindow('1minute', T).toISOString(), '2026-06-21T13:47:00.000Z');
  assertEquals(floorToRateWindow('1day', T).toISOString(), '2026-06-21T00:00:00.000Z');
});

Deno.test('withRateLimit runs fn and consumes a token when under the limit', async () => {
  const { client, calls } = fakeClient({ count: 3 });
  let ran = false;
  const out = await withRateLimit(
    'imap_fetch',
    'a@b.com',
    { window: '1hour', limit: 10 },
    () => {
      ran = true;
      return Promise.resolve('ok');
    },
    { client, clock: () => T },
  );
  assertEquals(out, 'ok');
  assert(ran);
  assertEquals(calls.rpc[0].name, 'rate_limit_consume');
  assertEquals(calls.rpc[0].args.p_window_start, '2026-06-21T13:00:00.000Z');
});

Deno.test('withRateLimit allows exactly AT the limit (count == limit)', async () => {
  const { client } = fakeClient({ count: 10 });
  let ran = false;
  const out = await withRateLimit('imap_fetch', 'a@b.com', { window: '1hour', limit: 10 }, () => {
    ran = true;
    return Promise.resolve('ok');
  }, { client });
  assertEquals(out, 'ok');
  assert(ran);
});

Deno.test('withRateLimit throws RateLimitError and skips fn at limit+1', async () => {
  const { client } = fakeClient({ count: 11 });
  let ran = false;
  let err: unknown = null;
  try {
    await withRateLimit('imap_fetch', 'a@b.com', { window: '1hour', limit: 10 }, () => {
      ran = true;
      return Promise.resolve('ok');
    }, { client });
  } catch (e) {
    err = e;
  }
  assert(err instanceof RateLimitError);
  assert(!ran);
});

Deno.test('withRateLimit fails CLOSED when consume returns a non-number', async () => {
  const { client } = fakeClient({ count: null });
  let ran = false;
  let err: unknown = null;
  try {
    await withRateLimit('imap_fetch', 'a@b.com', { window: '1hour', limit: 10 }, () => {
      ran = true;
      return Promise.resolve('ok');
    }, { client });
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error && !(err instanceof RateLimitError));
  assert(!ran);
});

Deno.test('peekRateLimit reads the floored bucket without consuming', async () => {
  const { client, calls } = fakePeekClient({ row: { count: 5 } });
  const status = await peekRateLimit('imap_fetch', 'a@b.com', { window: '1hour', limit: 10 }, {
    client,
    clock: () => T,
  });
  assertEquals(status.count, 5);
  assertEquals(status.exceeded, false);
  assertEquals(status.window_start, '2026-06-21T13:00:00.000Z');
  assert(calls.eqs.some(([c, v]) => c === 'window_start' && v === '2026-06-21T13:00:00.000Z'));
});

Deno.test('peekRateLimit reports count 0 / not exceeded when no bucket row exists', async () => {
  const { client } = fakePeekClient({ row: null });
  const status = await peekRateLimit('imap_fetch', 'a@b.com', { window: '1day', limit: 3 }, {
    client,
  });
  assertEquals(status.count, 0);
  assertEquals(status.exceeded, false);
});

Deno.test('withRateLimit surfaces a non-RateLimit error when the consume rpc fails', async () => {
  const { client } = fakeClient({ rpcError: { message: 'rpc boom' } });
  let threw = false;
  try {
    await withRateLimit(
      'imap_fetch',
      'a@b.com',
      { window: '1minute', limit: 5 },
      () => Promise.resolve('x'),
      { client },
    );
  } catch (e) {
    threw = e instanceof Error && !(e instanceof RateLimitError);
  }
  assert(threw);
});
