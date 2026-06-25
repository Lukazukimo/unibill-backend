/**
 * smoke.test.ts — T-419. runSmoke core with injected config/ping/recordCall.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { runSmoke, SENTINEL, type SmokeCallRow, type SmokeDeps } from './smoke.ts';

function cfgMap(over: Record<string, unknown> = {}): Map<string, unknown> {
  return new Map<string, unknown>(Object.entries({
    'ai.providers.extraction.chain': ['gemini', 'groq'],
    'ai.gemini.model': 'gemini-2.0-flash-001',
    'ai.groq.model': 'llama-x',
    ...over,
  }));
}

function deps(
  over: Partial<SmokeDeps> = {},
  cfg = cfgMap(),
): { deps: SmokeDeps; calls: SmokeCallRow[] } {
  const calls: SmokeCallRow[] = [];
  const base: SmokeDeps = {
    getConfig: () => Promise.resolve(cfg),
    ping: () => Promise.resolve({ httpStatus: 200 }),
    recordCall: (row) => {
      calls.push(row);
      return Promise.resolve();
    },
    apiKeyFor: () => 'key',
    now: () => 0,
    ...over,
  };
  return { deps: base, calls };
}

Deno.test('all providers 200 → ok, one synthetic ai_calls row per ping', async () => {
  const { deps: d, calls } = deps();
  const r = await runSmoke(d);
  assert(r.ok);
  assertEquals(r.results.map((x) => x.ok), [true, true]);
  assertEquals(calls.length, 2);
  assertEquals(calls.every((c) => c.status === 'success'), true);
});

Deno.test('a 404 → not ok, with the deprecated-model message + ai_calls error row', async () => {
  const { deps: d, calls } = deps({
    ping: (provider) => Promise.resolve({ httpStatus: provider === 'groq' ? 404 : 200 }),
  });
  const r = await runSmoke(d);
  assert(!r.ok);
  const groq = r.results.find((x) => x.provider === 'groq')!;
  assertEquals(groq.httpStatus, 404);
  assert(groq.reason!.includes('not available (HTTP 404)'));
  assert(groq.reason!.includes('Update ai.groq.model in app_settings'));
  assertEquals(calls.find((c) => c.provider === 'groq')!.status, 'error');
});

Deno.test('sentinel model → immediate fail, NO ping/record for that provider', async () => {
  let pings = 0;
  const { deps: d, calls } = deps(
    {
      ping: () => {
        pings++;
        return Promise.resolve({ httpStatus: 200 });
      },
    },
    cfgMap({ 'ai.groq.model': SENTINEL }),
  );
  const r = await runSmoke(d);
  assert(!r.ok);
  const groq = r.results.find((x) => x.provider === 'groq')!;
  assert(groq.reason!.includes(SENTINEL));
  assertEquals(pings, 1); // only gemini was pinged
  assertEquals(calls.length, 1); // no synthetic row for the un-pinged sentinel
});

Deno.test('missing API key → fail without a call', async () => {
  const { deps: d, calls } = deps({ apiKeyFor: (p) => (p === 'gemini' ? 'key' : undefined) });
  const r = await runSmoke(d);
  assert(!r.ok);
  assert(r.results.find((x) => x.provider === 'groq')!.reason!.includes('no API key'));
  assertEquals(calls.length, 1);
});

Deno.test('non-200/non-404 (e.g. 500) → fail with the HTTP status in the reason', async () => {
  const { deps: d } = deps({ ping: () => Promise.resolve({ httpStatus: 500 }) });
  const r = await runSmoke(d);
  assert(!r.ok);
  assert(r.results[0].reason!.includes('HTTP 500'));
});

Deno.test('a thrown ping (network/timeout) → fail, recorded as error', async () => {
  const { deps: d, calls } = deps({ ping: () => Promise.reject(new Error('aborted')) });
  const r = await runSmoke(d);
  assert(!r.ok);
  assert(r.results[0].reason!.includes('call failed: aborted'));
  assertEquals(calls[0].status, 'error');
});

Deno.test('empty chain → not ok (nothing to validate is a deploy-time misconfig)', async () => {
  const { deps: d } = deps({}, cfgMap({ 'ai.providers.extraction.chain': [] }));
  const r = await runSmoke(d);
  assertEquals(r.ok, false);
  assertEquals(r.results.length, 0);
});
