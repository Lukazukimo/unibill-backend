/**
 * classify_error_spec_table.test.ts — T-426 (#73). The CANONICAL §7.5.1 table.
 *
 * Living documentation: one labeled case per row of the spec's failure→status
 * table, asserting the full (status, tripsProvider, tripsChain, chainImmediate)
 * tuple that classifyOcrError returns. If the mapping drifts from §7.5.1 a row
 * fails with its label, pointing straight at the divergent contract.
 *
 * classifyOcrError is the SINGLE classifier shared by both the OCR and the AI
 * chains (there is no separate classifyAiError) — see classify_error.ts. The AI
 * angle is documented in ../ai/classify_error_spec_table.test.ts.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { CircuitOpenError, RateLimitError } from '../errors.ts';
import {
  classifyOcrError,
  type OcrErrorClassification,
  OcrHttpError,
  OcrInvalidResponseError,
  OcrTimeoutError,
} from './classify_error.ts';

type Row = { label: string; err: unknown; expect: OcrErrorClassification };

// Each row mirrors a §7.5.1 line. Order matters in the classifier (429 before
// 402/quota before timeout, etc.), so cases that probe precedence are explicit.
const ROWS: Row[] = [
  {
    label:
      '§7.5.1 — per-provider breaker already OPEN → circuit_open, spares provider, trips chain',
    err: new CircuitOpenError('ai_provider', 'gemini'),
    expect: { status: 'circuit_open', tripsProvider: false, tripsChain: true },
  },
  {
    label: '§7.5.1 — typed RateLimitError → rate_limited, trips both',
    err: new RateLimitError('ai_provider', 'gemini', 100),
    expect: { status: 'rate_limited', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — HTTP 429 → rate_limited, trips both',
    err: new OcrHttpError(429, 'Too Many Requests'),
    expect: { status: 'rate_limited', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — HTTP 402 → quota_exceeded, trips chain IMMEDIATELY (Trigger B)',
    err: new OcrHttpError(402, 'Payment Required'),
    expect: {
      status: 'quota_exceeded',
      tripsProvider: true,
      tripsChain: true,
      chainImmediate: true,
    },
  },
  {
    label: '§7.5.1 — quota signal in the message → quota_exceeded (chainImmediate)',
    err: new Error('insufficient_quota for this project'),
    expect: {
      status: 'quota_exceeded',
      tripsProvider: true,
      tripsChain: true,
      chainImmediate: true,
    },
  },
  {
    label: '§7.5.1 — quota signal in a non-402 HTTP body → quota_exceeded (chainImmediate)',
    err: new OcrHttpError(403, 'Forbidden', 'daily quota exceeded'),
    expect: {
      status: 'quota_exceeded',
      tripsProvider: true,
      tripsChain: true,
      chainImmediate: true,
    },
  },
  {
    label: '§7.5.1 — typed OcrTimeoutError → timeout, trips both',
    err: new OcrTimeoutError(),
    expect: { status: 'timeout', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — AbortError (DOMException) → timeout, trips both',
    err: new DOMException('aborted', 'AbortError'),
    expect: { status: 'timeout', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — timeout signal in the message → timeout, trips both',
    err: new Error('connect ETIMEDOUT 1.2.3.4:443'),
    expect: { status: 'timeout', tripsProvider: true, tripsChain: true },
  },
  {
    label:
      '§7.5.1 — OcrInvalidResponseError (2xx unparseable) → invalid_response, SPARES provider, trips chain',
    err: new OcrInvalidResponseError('not valid JSON'),
    expect: { status: 'invalid_response', tripsProvider: false, tripsChain: true },
  },
  {
    label: '§7.5.1 — HTTP 500 (server error) → error, trips both',
    err: new OcrHttpError(500, 'Internal Server Error'),
    expect: { status: 'error', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — HTTP 404 (deprecated model / other 4xx) → error, trips both',
    err: new OcrHttpError(404, 'model not found'),
    expect: { status: 'error', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — unknown/network Error → error, trips both',
    err: new Error('socket hang up'),
    expect: { status: 'error', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — total over a thrown string → error',
    err: 'weird string failure',
    expect: { status: 'error', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — total over thrown null → error',
    err: null,
    expect: { status: 'error', tripsProvider: true, tripsChain: true },
  },
  {
    label: '§7.5.1 — a RAW number 402 is NOT an OcrHttpError → error (only typed 402 is quota)',
    err: 402,
    expect: { status: 'error', tripsProvider: true, tripsChain: true },
  },
];

for (const row of ROWS) {
  Deno.test(row.label, () => {
    assertEquals(classifyOcrError(row.err), row.expect);
  });
}

// Cross-cutting invariant: invalid_response and circuit_open are the ONLY
// statuses that spare the per-provider breaker (§7.5.1 — input/already-open, not
// provider health); every other failure counts the provider. And every failure
// without exception counts the chain.
Deno.test('§7.5.1 invariant — only invalid_response & circuit_open spare the provider; all trip the chain', () => {
  for (const row of ROWS) {
    const c = classifyOcrError(row.err);
    const sparesProvider = c.status === 'invalid_response' || c.status === 'circuit_open';
    assertEquals(c.tripsProvider, !sparesProvider, `tripsProvider for ${c.status}`);
    assertEquals(c.tripsChain, true, `tripsChain for ${c.status}`);
  }
});
