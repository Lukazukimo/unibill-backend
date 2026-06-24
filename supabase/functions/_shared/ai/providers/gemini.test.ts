/**
 * gemini.test.ts — T-412. DI-fake fetch; no real Gemini call.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { classifyOcrError } from '../../ocr/classify_error.ts';
import type { AiCallContext } from '../types.ts';
import { createGeminiProvider } from './gemini.ts';

const CFG = { model: 'gemini-2.0-flash-001', prompt: 'PROMPT', timeoutMs: 30000 };
const CTX: AiCallContext = { correlation_id: 'c1', invoice_id: null, household_id: null };

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
}

const OK = {
  candidates: [{
    content: {
      parts: [{
        text: JSON.stringify({ amount_cents: 23456, due_date: '2026-06-15', confidence: 0.88 }),
      }],
    },
  }],
};

Deno.test('success: parses structured fields + self-reported confidence', async () => {
  const p = createGeminiProvider(CFG, { fetch: jsonFetch(200, OK), apiKey: 'k' });
  const r = await p.extractStructured('invoice text', CTX);
  assertEquals(r.fields.amount_cents, 23456);
  assertEquals(r.fields.due_date, '2026-06-15');
  assertEquals(r.selfReported, 0.88);
});

Deno.test('a blocked response → invalid_response', async () => {
  const p = createGeminiProvider(CFG, {
    fetch: jsonFetch(200, { promptFeedback: { blockReason: 'SAFETY' } }),
    apiKey: 'k',
  });
  const err = await p.extractStructured('t', CTX).catch((e) => e);
  assertEquals(classifyOcrError(err).status, 'invalid_response');
});

Deno.test('HTTP 429 → rate_limited, 500 → error', async () => {
  for (const [status, want] of [[429, 'rate_limited'], [500, 'error']] as const) {
    const p = createGeminiProvider(CFG, { fetch: jsonFetch(status, 'x'), apiKey: 'k' });
    const err = await p.extractStructured('t', CTX).catch((e) => e);
    assertEquals(classifyOcrError(err).status, want);
  }
});

Deno.test('model goes in the URL, key in x-goog-api-key header (never the URL)', async () => {
  let seenUrl = '';
  let seenKey = '';
  const spy = ((u: string, init: RequestInit) => {
    seenUrl = String(u);
    seenKey = String((init.headers as Record<string, string>)?.['x-goog-api-key'] ?? '');
    return Promise.resolve(new Response(JSON.stringify(OK), { status: 200 }));
  }) as unknown as typeof fetch;
  const p = createGeminiProvider(CFG, { fetch: spy, apiKey: 'SECRET' });
  await p.extractStructured('t', CTX);
  assertEquals(seenKey, 'SECRET');
  assert(seenUrl.includes('gemini-2.0-flash-001'));
  assert(!seenUrl.includes('SECRET'));
});
