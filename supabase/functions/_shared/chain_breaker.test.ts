/**
 * chain_breaker.test.ts — T-415. Injected begin/recordSuccess/recordFailure
 * fakes — no SQL RPCs.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { ChainOpenError } from './errors.ts';
import { OcrHttpError } from './ocr/classify_error.ts';
import { type ChainBreakerDeps, type CircuitDecision, withChainBreaker } from './chain_breaker.ts';

function harness(decision: CircuitDecision) {
  const calls = {
    success: 0,
    failures: [] as Array<{ threshold: number; cooldownSec: number; reason: string }>,
    beginSeen: 0,
  };
  const deps: ChainBreakerDeps = {
    begin: () => {
      calls.beginSeen++;
      return Promise.resolve(decision);
    },
    recordSuccess: () => {
      calls.success++;
      return Promise.resolve();
    },
    recordFailure: (_t, _k, o) => {
      calls.failures.push(o);
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

Deno.test('open chain → ChainOpenError, fn never runs, nothing recorded', async () => {
  const { deps, calls } = harness('open');
  let ran = false;
  await assertRejects(
    () =>
      withChainBreaker('ai_chain', 'extraction_default', () => {
        ran = true;
        return Promise.resolve('x');
      }, deps),
    ChainOpenError,
  );
  assert(!ran);
  assertEquals(calls.success, 0);
  assertEquals(calls.failures.length, 0);
});

Deno.test('closed + success → recordSuccess; fn receives the chain state', async () => {
  const { deps, calls } = harness('closed');
  let seenState: CircuitDecision | null = null;
  const r = await withChainBreaker('ai_chain', 'k', (state) => {
    seenState = state;
    return Promise.resolve(42);
  }, deps);
  assertEquals(r, 42);
  assertEquals(seenState, 'closed');
  assertEquals(calls.success, 1);
  assertEquals(calls.failures.length, 0);
});

Deno.test('half_open + success → recordSuccess (probe); fn sees half_open', async () => {
  const { deps, calls } = harness('half_open');
  let seenState: CircuitDecision | null = null;
  await withChainBreaker('ai_chain', 'k', (state) => {
    seenState = state;
    return Promise.resolve('ok');
  }, deps);
  assertEquals(seenState, 'half_open');
  assertEquals(calls.success, 1);
});

Deno.test('closed + normal failure → recordFailure with the minSamples threshold', async () => {
  const { deps, calls } = harness('closed');
  await assertRejects(
    () => withChainBreaker('ai_chain', 'k', () => Promise.reject(new Error('boom')), deps),
    Error,
  );
  assertEquals(calls.failures.length, 1);
  assertEquals(calls.failures[0].threshold, 6); // default minSamples
  assertEquals(calls.failures[0].reason, 'error');
});

Deno.test('Trigger B: a quota failure opens immediately (threshold 1)', async () => {
  const { deps, calls } = harness('closed');
  await assertRejects(
    () =>
      withChainBreaker('ai_chain', 'k', () => Promise.reject(new OcrHttpError(402, 'quota')), deps),
    OcrHttpError,
  );
  assertEquals(calls.failures[0].threshold, 1);
  assertEquals(calls.failures[0].reason, 'quota_exceeded');
});

Deno.test('config overrides minSamples / cooldown', async () => {
  const { deps, calls } = harness('closed');
  deps.config = { minSamples: 3, cooldownSec: 120, probeSuccessRequired: 2 };
  await assertRejects(
    () => withChainBreaker('ocr_chain', 'k', () => Promise.reject(new Error('x')), deps),
    Error,
  );
  assertEquals(calls.failures[0].threshold, 3);
  assertEquals(calls.failures[0].cooldownSec, 120);
});
