/**
 * ocr/classify_error.ts — map any thrown value from an OCR provider call to an
 * ai_calls status + breaker-counting flags.
 *
 * Ref:  T-406, spec §7.5.1 (call status table) + §7.6 (chain triggers)
 * Date: 2026-06-24
 *
 * The per-provider breaker and the chain breaker count DIFFERENT failure
 * subsets, so the classification carries both `tripsProvider` and `tripsChain`
 * (plus `chainImmediate` for quota — §7.6 Trigger B). PURE + TOTAL: never throws,
 * total over null/undefined/string/number/Error.
 */

import { CircuitOpenError, RateLimitError } from '../errors.ts';
import type { OcrCallStatus } from './types.ts';

export interface OcrErrorClassification {
  /** Never 'success' — this is the failure path. */
  status: Exclude<OcrCallStatus, 'success'>;
  /** Counts toward the per-provider circuit breaker (T-407/T-408 wrapping). */
  tripsProvider: boolean;
  /** Counts toward the OCR chain breaker (T-409/T-410). */
  tripsChain: boolean;
  /** quota_exceeded trips the chain IMMEDIATELY (§7.6 Trigger B). */
  chainImmediate?: boolean;
}

/** A non-2xx HTTP response from a provider. `bodySnippet` MUST be pre-redacted. */
export class OcrHttpError extends Error {
  readonly httpStatus: number;
  readonly bodySnippet?: string;
  constructor(httpStatus: number, message: string, bodySnippet?: string) {
    super(message);
    this.name = 'OcrHttpError';
    this.httpStatus = httpStatus;
    this.bodySnippet = bodySnippet;
  }
}

/** A 2xx response that could not be parsed / failed schema validation. */
export class OcrInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrInvalidResponseError';
  }
}

/** The per-call timeout (AbortSignal) fired. */
export class OcrTimeoutError extends Error {
  constructor(message = 'OCR provider call timed out') {
    super(message);
    this.name = 'OcrTimeoutError';
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'string') return err;
  return '';
}

const QUOTA_RE = /quota|insufficient_quota|exceeded/i;
const TIMEOUT_RE = /ETIMEDOUT|timed?\s*out|deadline/i;

/**
 * PURE + TOTAL. Classify a thrown value from an OCR/AI provider call.
 *
 * The §7.5.1 failure→status table (the canonical contract, exhaustively covered
 * by classify_error_spec_table.test.ts in this dir and ../ai/):
 *
 *   input                                   | status           | provider | chain | immediate
 *   ----------------------------------------+------------------+----------+-------+----------
 *   CircuitOpenError (provider already open) | circuit_open     |   no     |  yes  |   —
 *   RateLimitError / HTTP 429                | rate_limited     |   yes    |  yes  |   —
 *   HTTP 402 / quota in msg or body          | quota_exceeded   |   yes    |  yes  |  YES (§7.6 B)
 *   OcrTimeoutError / AbortError / "timeout" | timeout          |   yes    |  yes  |   —
 *   OcrInvalidResponseError (2xx unparseable)| invalid_response |   no     |  yes  |   —
 *   5xx / other 4xx / unknown / non-Error    | error            |   yes    |  yes  |   —
 *
 * provider = counts toward the per-provider breaker; chain = counts toward the
 * chain breaker; immediate = opens the chain on first occurrence (Trigger B).
 */
export function classifyOcrError(err: unknown): OcrErrorClassification {
  // 1. Per-provider breaker already open → don't double-count the provider.
  if (err instanceof CircuitOpenError) {
    return { status: 'circuit_open', tripsProvider: false, tripsChain: true };
  }

  const httpStatus = err instanceof OcrHttpError ? err.httpStatus : undefined;
  const bodySnippet = err instanceof OcrHttpError ? (err.bodySnippet ?? '') : '';
  const msg = messageOf(err);

  // 2. Rate limited (typed RateLimitError or HTTP 429).
  if (err instanceof RateLimitError || httpStatus === 429) {
    return { status: 'rate_limited', tripsProvider: true, tripsChain: true };
  }

  // 3. Quota exhausted (HTTP 402, or a quota signal in the message/body). OCR.space
  //    sometimes signals quota in a 200/403 body, hence the regex fallback.
  if (httpStatus === 402 || QUOTA_RE.test(msg) || QUOTA_RE.test(bodySnippet)) {
    return {
      status: 'quota_exceeded',
      tripsProvider: true,
      tripsChain: true,
      chainImmediate: true,
    };
  }

  // 4. Timeout (typed, AbortError, or a timeout signal in the message).
  const isAbort = err instanceof DOMException && err.name === 'AbortError';
  if (err instanceof OcrTimeoutError || isAbort || TIMEOUT_RE.test(msg)) {
    return { status: 'timeout', tripsProvider: true, tripsChain: true };
  }

  // 5. 2xx but unparseable → an INPUT problem, not provider health: count the
  //    chain (catches silent quality degradation) but spare the provider breaker.
  if (err instanceof OcrInvalidResponseError) {
    return { status: 'invalid_response', tripsProvider: false, tripsChain: true };
  }

  // 6-8. Server errors, other 4xx, and any unknown/network failure → 'error'.
  return { status: 'error', tripsProvider: true, tripsChain: true };
}
