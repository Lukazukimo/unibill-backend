/**
 * ai_client.test.ts — T-416. Fully DI: chain breaker, per-provider breaker,
 * rate-limit, ai_calls writer and providers are injected fakes.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { ChainOpenError, NoProviderAvailableError } from '../errors.ts';
import type { AiCallRow } from '../ai_calls.ts';
import type { CircuitDecision } from '../chain_breaker.ts';
import { type AiClientDeps, createAiClient } from './ai_client.ts';
import type { AiCallContext, AiExtractResult, AiProvider } from './types.ts';

const CTX: AiCallContext = { correlation_id: 'c1', invoice_id: 'i1', household_id: 'h1' };

function provider(
  name: 'gemini' | 'groq' | 'openrouter',
  impl: () => Promise<AiExtractResult>,
): AiProvider {
  return { name, model: `${name}-model`, extractStructured: () => impl() };
}

function harness(over: Partial<AiClientDeps> = {}, chainState: CircuitDecision = 'closed') {
  const logs: AiCallRow[] = [];
  const deps: AiClientDeps = {
    chain: over.chain ?? [],
    withChainBreakerFn: over.withChainBreakerFn ?? ((fn) => fn(chainState)),
    withRateLimitFn: over.withRateLimitFn ?? ((_n, _l, fn) => fn()),
    withBreakerFn: over.withBreakerFn ?? ((_n, fn) => fn()),
    logAiCall: (row) => {
      logs.push(row);
      return Promise.resolve();
    },
    now: (() => {
      let t = 1000;
      return () => (t += 7);
    })(),
  };
  return { client: createAiClient(deps), logs };
}

const OK: AiExtractResult = { fields: { amount_cents: 23456 }, selfReported: 0.8 };

Deno.test('first provider success → returns + logs an extraction success row', async () => {
  const { client, logs } = harness({
    chain: [{ provider: provider('gemini', () => Promise.resolve(OK)), dailyLimit: 1000 }],
  });
  const r = await client.extractStructured('invoice text', CTX);
  assertEquals(r.fields.amount_cents, 23456);
  assertEquals(logs.length, 1);
  assertEquals(logs[0].status, 'success');
  assertEquals(logs[0].provider, 'gemini');
  assertEquals(logs[0].model, 'gemini-model');
  assertEquals(logs[0].purpose, 'extraction');
  assertEquals(logs[0].chain_state_at_call, 'closed');
});

Deno.test('falls through to the next provider on error (logs error then success)', async () => {
  const { client, logs } = harness({
    chain: [
      { provider: provider('gemini', () => Promise.reject(new Error('boom'))), dailyLimit: 1000 },
      { provider: provider('groq', () => Promise.resolve(OK)), dailyLimit: 10000 },
    ],
  });
  const r = await client.extractStructured('t', CTX);
  assertEquals(r.fields.amount_cents, 23456);
  assertEquals(logs.map((l) => `${l.provider}:${l.status}`), ['gemini:error', 'groq:success']);
});

Deno.test('chain breaker open → ChainOpenError (no providers tried)', async () => {
  let tried = false;
  const { client } = harness({
    chain: [{
      provider: provider('gemini', () => {
        tried = true;
        return Promise.resolve(OK);
      }),
      dailyLimit: 1000,
    }],
    withChainBreakerFn: () => Promise.reject(new ChainOpenError('extraction_default')),
  });
  await assertRejects(() => client.extractStructured('t', CTX), ChainOpenError);
  assert(!tried);
});

Deno.test('all providers fail → NoProviderAvailableError (inside the chain attempt)', async () => {
  const { client, logs } = harness({
    chain: [
      { provider: provider('gemini', () => Promise.reject(new Error('a'))), dailyLimit: 1000 },
      { provider: provider('groq', () => Promise.reject(new Error('b'))), dailyLimit: 10000 },
    ],
  });
  await assertRejects(() => client.extractStructured('t', CTX), NoProviderAvailableError);
  assertEquals(logs.length, 2);
  assertEquals(logs.every((l) => l.status === 'error' && l.chain_state_at_call === 'closed'), true);
});

Deno.test('half_open chain state is threaded into the ai_calls log', async () => {
  const { client, logs } = harness({
    chain: [{ provider: provider('gemini', () => Promise.resolve(OK)), dailyLimit: 1000 }],
  }, 'half_open');
  await client.extractStructured('t', CTX);
  assertEquals(logs[0].chain_state_at_call, 'half_open');
});
