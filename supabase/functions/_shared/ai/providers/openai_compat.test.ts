/**
 * openai_compat.test.ts — T-413 (Groq) + T-414 (OpenRouter). DI-fake fetch.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { classifyOcrError } from '../../ocr/classify_error.ts';
import type { AiCallContext } from '../types.ts';
import {
  createGroqProvider,
  createOpenRouterProvider,
  extractOpenAiText,
  GROQ_ENDPOINT,
  OPENROUTER_ENDPOINT,
} from './openai_compat.ts';

const CTX: AiCallContext = { correlation_id: 'c1', invoice_id: null, household_id: null };
const CFG = { model: 'llama-4-scout', prompt: 'PROMPT', timeoutMs: 30000 };

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
}

const OK = {
  choices: [{ message: { content: JSON.stringify({ amount_cents: 5000, confidence: 0.7 }) } }],
};

Deno.test('groq: success parses choice content', async () => {
  const p = createGroqProvider(CFG, { fetch: jsonFetch(200, OK), apiKey: 'k' });
  assertEquals(p.name, 'groq');
  const r = await p.extractStructured('t', CTX);
  assertEquals(r.fields.amount_cents, 5000);
  assertEquals(r.selfReported, 0.7);
});

Deno.test('groq: no choices → invalid_response', async () => {
  const p = createGroqProvider(CFG, { fetch: jsonFetch(200, { choices: [] }), apiKey: 'k' });
  const err = await p.extractStructured('t', CTX).catch((e) => e);
  assertEquals(classifyOcrError(err).status, 'invalid_response');
});

Deno.test('groq: HTTP 429 → rate_limited, 402 → quota_exceeded', async () => {
  for (const [status, want] of [[429, 'rate_limited'], [402, 'quota_exceeded']] as const) {
    const p = createGroqProvider(CFG, { fetch: jsonFetch(status, 'x'), apiKey: 'k' });
    const err = await p.extractStructured('t', CTX).catch((e) => e);
    assertEquals(classifyOcrError(err).status, want);
  }
});

Deno.test('groq: Bearer auth header, default endpoint, key not in URL', async () => {
  let url = '';
  let auth = '';
  const spy = ((u: string, init: RequestInit) => {
    url = String(u);
    auth = String((init.headers as Record<string, string>)?.authorization ?? '');
    return Promise.resolve(new Response(JSON.stringify(OK), { status: 200 }));
  }) as unknown as typeof fetch;
  const p = createGroqProvider(CFG, { fetch: spy, apiKey: 'SECRET' });
  await p.extractStructured('t', CTX);
  assertEquals(url, GROQ_ENDPOINT);
  assertEquals(auth, 'Bearer SECRET');
  assert(!url.includes('SECRET'));
});

Deno.test('openrouter: success + sends referer/title extra headers', async () => {
  let url = '';
  let headers: Record<string, string> = {};
  const spy = ((u: string, init: RequestInit) => {
    url = String(u);
    headers = init.headers as Record<string, string>;
    return Promise.resolve(new Response(JSON.stringify(OK), { status: 200 }));
  }) as unknown as typeof fetch;
  const p = createOpenRouterProvider(
    { ...CFG, referer: 'https://unibill.app', title: 'Unibill' },
    { fetch: spy, apiKey: 'OR-KEY' },
  );
  assertEquals(p.name, 'openrouter');
  const r = await p.extractStructured('t', CTX);
  assertEquals(r.fields.amount_cents, 5000);
  assertEquals(url, OPENROUTER_ENDPOINT);
  assertEquals(headers['HTTP-Referer'], 'https://unibill.app');
  assertEquals(headers['X-Title'], 'Unibill');
});

Deno.test('extractOpenAiText throws on a missing message', () => {
  let threw = false;
  try {
    extractOpenAiText({ choices: [{}] });
  } catch {
    threw = true;
  }
  assert(threw);
});
