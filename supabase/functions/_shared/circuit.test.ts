import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { CircuitOpenError } from './errors.ts';
import { withCircuitBreaker } from './circuit.ts';

function fakeClient(
  opts: { decision?: string; beginError?: { message: string }; recordError?: { message: string } } =
    {},
) {
  const calls = { rpc: [] as Array<{ name: string; args: Record<string, unknown> }> };
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      if (name === 'circuit_begin') {
        return Promise.resolve(
          opts.beginError
            ? { data: null, error: opts.beginError }
            : { data: opts.decision ?? 'closed', error: null },
        );
      }
      // circuit_record_success / circuit_record_failure
      return Promise.resolve({ data: null, error: opts.recordError ?? null });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const names = (calls: { rpc: Array<{ name: string }> }) => calls.rpc.map((c) => c.name);

Deno.test('withCircuitBreaker runs fn and records success when closed', async () => {
  const { client, calls } = fakeClient({ decision: 'closed' });
  const out = await withCircuitBreaker('imap', 'a@b.com', () => Promise.resolve(42), { client });
  assertEquals(out, 42);
  assertEquals(names(calls), ['circuit_begin', 'circuit_record_success']);
  // default tuning is forwarded to the SQL bookkeeping call.
  const rec = calls.rpc.find((c) => c.name === 'circuit_record_success');
  assertEquals(rec?.args.p_close_after, 2);
});

Deno.test('withCircuitBreaker forwards threshold/cooldown/closeAfter overrides', async () => {
  const { client, calls } = fakeClient({ decision: 'closed' });
  await withCircuitBreaker(
    'imap',
    'a@b.com',
    () => Promise.reject(new Error('x')),
    { client, threshold: 3, cooldownSeconds: 120, closeAfter: 1 },
  ).catch(() => {});
  const rec = calls.rpc.find((c) => c.name === 'circuit_record_failure');
  assertEquals(rec?.args.p_threshold, 3);
  assertEquals(rec?.args.p_cooldown_seconds, 120);
});

Deno.test('withCircuitBreaker does NOT unwind a successful fn when bookkeeping rpc errors', async () => {
  const { client } = fakeClient({ decision: 'closed', recordError: { message: 'record boom' } });
  const out = await withCircuitBreaker('imap', 'a@b.com', () => Promise.resolve('ok'), { client });
  assertEquals(out, 'ok'); // success preserved despite record_success rpc error
});

Deno.test('withCircuitBreaker proceeds as a probe when half_open', async () => {
  const { client, calls } = fakeClient({ decision: 'half_open' });
  await withCircuitBreaker('imap', 'a@b.com', () => Promise.resolve('p'), { client });
  assertEquals(names(calls), ['circuit_begin', 'circuit_record_success']);
});

Deno.test('withCircuitBreaker throws CircuitOpenError and skips fn when open', async () => {
  const { client, calls } = fakeClient({ decision: 'open' });
  let ran = false;
  let err: unknown = null;
  try {
    await withCircuitBreaker('imap', 'a@b.com', () => {
      ran = true;
      return Promise.resolve('x');
    }, { client });
  } catch (e) {
    err = e;
  }
  assert(err instanceof CircuitOpenError);
  assert(!ran);
  assertEquals(names(calls), ['circuit_begin']);
});

Deno.test('withCircuitBreaker records failure (redacted) and rethrows on fn throw', async () => {
  const { client, calls } = fakeClient({ decision: 'closed' });
  let err: unknown = null;
  try {
    await withCircuitBreaker(
      'imap',
      'a@b.com',
      () => Promise.reject(new Error('auth failed pwqprsltuvwxabcd')),
      { client },
    );
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error);
  assertEquals(names(calls), ['circuit_begin', 'circuit_record_failure']);
  const failCall = calls.rpc.find((c) => c.name === 'circuit_record_failure');
  const reason = String(failCall?.args.p_reason);
  assert(reason.includes('[REDACTED_APP_PASSWORD]'));
  assert(!reason.includes('pwqprsltuvwxabcd'));
});

Deno.test('withCircuitBreaker surfaces an error when the begin rpc fails', async () => {
  const { client } = fakeClient({ beginError: { message: 'begin boom' } });
  let threw = false;
  try {
    await withCircuitBreaker('imap', 'a@b.com', () => Promise.resolve('x'), { client });
  } catch {
    threw = true;
  }
  assert(threw);
});
