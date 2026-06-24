/**
 * ai/classify_error_spec_table.test.ts — T-426 (#73). The §7.5.1 table from the
 * AI chain's point of view.
 *
 * There is NO separate classifyAiError: the AI providers (gemini/groq) throw the
 * same OcrHttpError / OcrInvalidResponseError / OcrTimeoutError types, and the AI
 * chain feeds them through the one shared classifyOcrError (../ocr/classify_error.ts).
 * This file is living documentation of how the AI-provider failure modes land on
 * the (status, tripsProvider, tripsChain) triple — with the emphasis on what the
 * AI CHAIN breaker (T-415, §7.6) actually keys off. The exhaustive row coverage
 * lives in ../ocr/classify_error_spec_table.test.ts.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  classifyOcrError,
  OcrHttpError,
  OcrInvalidResponseError,
  OcrTimeoutError,
} from '../ocr/classify_error.ts';

Deno.test('AI §7.6 Trigger B — a provider 402 (quota) opens the AI chain immediately', () => {
  const c = classifyOcrError(new OcrHttpError(402, 'quota'));
  assertEquals(c.status, 'quota_exceeded');
  assertEquals(c.chainImmediate, true); // → chain breaker threshold 1
  assertEquals(c.tripsChain, true);
});

Deno.test('AI — a model that returns malformed JSON is an INPUT problem: invalid_response spares the provider, still trips the chain', () => {
  const c = classifyOcrError(new OcrInvalidResponseError('model returned prose, not JSON'));
  assertEquals(c.status, 'invalid_response');
  assertEquals(c.tripsProvider, false); // the model may be fine; the output wasn't
  assertEquals(c.tripsChain, true); // but systemic bad output should still open the chain
});

Deno.test('AI — a deprecated/unknown model (HTTP 404) is a plain error (provider + chain)', () => {
  const c = classifyOcrError(new OcrHttpError(404, 'model gemini-x not found'));
  assertEquals(c.status, 'error');
  assertEquals(c.tripsProvider, true);
  assertEquals(c.tripsChain, true);
});

Deno.test('AI — 429 → rate_limited; timeout → timeout; both count against the provider', () => {
  const rl = classifyOcrError(new OcrHttpError(429, 'slow down'));
  assertEquals(rl.status, 'rate_limited');
  assertEquals(rl.tripsProvider, true);

  const to = classifyOcrError(new OcrTimeoutError());
  assertEquals(to.status, 'timeout');
  assertEquals(to.tripsProvider, true);
});

Deno.test('AI — every classified AI failure trips the chain (the chain sees ALL failures)', () => {
  const errs = [
    new OcrHttpError(402, 'quota'),
    new OcrHttpError(429, 'rate'),
    new OcrHttpError(500, 'boom'),
    new OcrHttpError(404, 'gone'),
    new OcrInvalidResponseError('bad'),
    new OcrTimeoutError(),
    new Error('network'),
  ];
  for (const e of errs) assert(classifyOcrError(e).tripsChain, `${e} should trip the chain`);
});
