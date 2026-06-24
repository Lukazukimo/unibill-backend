/**
 * classify_error.test.ts — T-406. Pure mapping; no DB/network.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { CircuitOpenError, RateLimitError } from '../errors.ts';
import {
  classifyOcrError,
  OcrHttpError,
  OcrInvalidResponseError,
  OcrTimeoutError,
} from './classify_error.ts';

Deno.test('CircuitOpenError → circuit_open, does not re-trip the provider', () => {
  const c = classifyOcrError(new CircuitOpenError('ocr_provider', 'ocr_space'));
  assertEquals(c.status, 'circuit_open');
  assertEquals(c.tripsProvider, false);
  assertEquals(c.tripsChain, true);
});

Deno.test('RateLimitError and HTTP 429 → rate_limited', () => {
  assertEquals(
    classifyOcrError(new RateLimitError('ocr', 'ocr_space', 800)).status,
    'rate_limited',
  );
  assertEquals(classifyOcrError(new OcrHttpError(429, 'too many')).status, 'rate_limited');
});

Deno.test('HTTP 402 and quota signals → quota_exceeded with chainImmediate', () => {
  const a = classifyOcrError(new OcrHttpError(402, 'payment required'));
  assertEquals(a.status, 'quota_exceeded');
  assertEquals(a.chainImmediate, true);
  // quota signalled in a 200/403 body (OCR.space style)
  const b = classifyOcrError(new OcrHttpError(403, 'forbidden', 'monthly quota exceeded'));
  assertEquals(b.status, 'quota_exceeded');
  assertEquals(b.chainImmediate, true);
});

Deno.test('instanceof/status wins over a coincidental quota word in the body', () => {
  // a 429 whose body happens to contain "quota" is rate_limited, not quota_exceeded
  const c = classifyOcrError(new OcrHttpError(429, 'rate limited', 'quota note'));
  assertEquals(c.status, 'rate_limited');
});

Deno.test('timeouts → timeout (typed, AbortError, or message)', () => {
  assertEquals(classifyOcrError(new OcrTimeoutError()).status, 'timeout');
  assertEquals(classifyOcrError(new DOMException('aborted', 'AbortError')).status, 'timeout');
  assertEquals(classifyOcrError(new Error('connect ETIMEDOUT')).status, 'timeout');
});

Deno.test('OcrInvalidResponseError → invalid_response, spares the provider breaker', () => {
  const c = classifyOcrError(new OcrInvalidResponseError('2xx but junk'));
  assertEquals(c.status, 'invalid_response');
  assertEquals(c.tripsProvider, false);
  assertEquals(c.tripsChain, true);
});

Deno.test('5xx, other 4xx, and unknown failures → error', () => {
  assertEquals(classifyOcrError(new OcrHttpError(500, 'boom')).status, 'error');
  assertEquals(classifyOcrError(new OcrHttpError(404, 'nope')).status, 'error');
  assertEquals(classifyOcrError(new TypeError('network failure')).status, 'error');
});

Deno.test('classifyOcrError is total (never throws on odd inputs)', () => {
  for (const v of [null, undefined, 'str', 42, {}, []]) {
    const c = classifyOcrError(v);
    assertEquals(c.status, 'error');
    assertEquals(c.tripsChain, true);
  }
});
