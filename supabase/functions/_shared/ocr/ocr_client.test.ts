/**
 * ocr_client.test.ts — T-409. Fully DI: rate-limit, breaker, ai_calls writer and
 * providers are injected fakes — no SQL RPCs, no network.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { CircuitOpenError, NoProviderAvailableError, RateLimitError } from '../errors.ts';
import type { AiCallRow } from '../ai_calls.ts';
import { createOcrClient, type OcrClientDeps } from './ocr_client.ts';
import type { CallContext, OcrProvider, OcrResult } from './types.ts';

const CTX: CallContext = { correlation_id: 'c1', invoice_id: 'i1', household_id: 'h1', page: 1 };

function provider(
  name: 'ocr_space' | 'google_vision',
  impl: () => Promise<OcrResult>,
): OcrProvider {
  return { name, ocrPdfPage: () => impl() };
}

/** Build a client with pass-through breaker/rate-limit + a capturing logger. */
function harness(over: Partial<OcrClientDeps> = {}) {
  const logs: AiCallRow[] = [];
  const deps: OcrClientDeps = {
    chain: over.chain ?? [],
    withRateLimitFn: over.withRateLimitFn ?? ((_n, _l, fn) => fn()),
    withBreakerFn: over.withBreakerFn ?? ((_n, fn) => fn()),
    logAiCall: (row) => {
      logs.push(row);
      return Promise.resolve();
    },
    now: (() => {
      let t = 1000;
      return () => (t += 5);
    })(),
  };
  return { client: createOcrClient(deps), logs };
}

Deno.test('returns the first provider success and logs one success row', async () => {
  const ok: OcrResult = { text: 'hello', confidence: 0.9 };
  const { client, logs } = harness({
    chain: [{ provider: provider('ocr_space', () => Promise.resolve(ok)), dailyLimit: 800 }],
  });
  const r = await client.ocrPage(new Uint8Array([1]), CTX);
  assertEquals(r.text, 'hello');
  assertEquals(logs.length, 1);
  assertEquals(logs[0].status, 'success');
  assertEquals(logs[0].provider, 'ocr_space');
  assertEquals(logs[0].purpose, 'ocr');
  assertEquals(logs[0].pages_processed, 1);
  assert((logs[0].latency_ms ?? -1) >= 0);
});

Deno.test('falls through to the second provider on an error (logs error then success)', async () => {
  const ok: OcrResult = { text: 'fromVision', confidence: 0.8 };
  const { client, logs } = harness({
    chain: [
      { provider: provider('ocr_space', () => Promise.reject(new Error('boom'))), dailyLimit: 800 },
      { provider: provider('google_vision', () => Promise.resolve(ok)), dailyLimit: 30 },
    ],
  });
  const r = await client.ocrPage(new Uint8Array([1]), CTX);
  assertEquals(r.text, 'fromVision');
  assertEquals(logs.map((l) => `${l.provider}:${l.status}`), [
    'ocr_space:error',
    'google_vision:success',
  ]);
});

Deno.test('a daily rate-limit on provider 1 skips it (does not touch the breaker) → provider 2', async () => {
  let breakerCalls = 0;
  const ok: OcrResult = { text: 'v', confidence: 0.7 };
  const { client, logs } = harness({
    chain: [
      {
        provider: provider('ocr_space', () => Promise.resolve({ text: 'NO', confidence: 1 })),
        dailyLimit: 0,
      },
      { provider: provider('google_vision', () => Promise.resolve(ok)), dailyLimit: 30 },
    ],
    // rate-limit gate: ocr_space is over budget → throw BEFORE the breaker runs
    withRateLimitFn: (name, _l, fn) =>
      name === 'ocr_space'
        ? Promise.reject(new RateLimitError('ocr_provider_daily', name, 0))
        : fn(),
    withBreakerFn: (_n, fn) => {
      breakerCalls++;
      return fn();
    },
  });
  const r = await client.ocrPage(new Uint8Array([1]), CTX);
  assertEquals(r.text, 'v');
  assertEquals(logs[0].provider, 'ocr_space');
  assertEquals(logs[0].status, 'rate_limited');
  assertEquals(breakerCalls, 1); // breaker only ran for google_vision, never for the rate-limited ocr_space
});

Deno.test('an open breaker on provider 1 → circuit_open log → provider 2', async () => {
  const ok: OcrResult = { text: 'v2', confidence: 0.6 };
  const { client, logs } = harness({
    chain: [
      {
        provider: provider('ocr_space', () => Promise.resolve({ text: 'NO', confidence: 1 })),
        dailyLimit: 800,
      },
      { provider: provider('google_vision', () => Promise.resolve(ok)), dailyLimit: 30 },
    ],
    withBreakerFn: (name, fn) =>
      name === 'ocr_space' ? Promise.reject(new CircuitOpenError('ocr_provider', name)) : fn(),
  });
  const r = await client.ocrPage(new Uint8Array([1]), CTX);
  assertEquals(r.text, 'v2');
  assertEquals(logs[0].status, 'circuit_open');
});

Deno.test('all providers fail → NoProviderAvailableError', async () => {
  const { client, logs } = harness({
    chain: [
      { provider: provider('ocr_space', () => Promise.reject(new Error('a'))), dailyLimit: 800 },
      { provider: provider('google_vision', () => Promise.reject(new Error('b'))), dailyLimit: 30 },
    ],
  });
  await assertRejects(
    () => client.ocrPage(new Uint8Array([1]), CTX),
    NoProviderAvailableError,
  );
  assertEquals(logs.length, 2);
  assertEquals(logs.every((l) => l.status === 'error'), true);
});
