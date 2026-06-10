/**
 * rate_limit.ts — token-bucket rate limiter backed by `rate_limit_buckets`.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * Increments a counter scoped to `(resource_type, resource_key, window)`
 * and throws `RateLimitError` once the bucket exceeds `limit`. Windows are
 * coarse buckets ('1minute' | '1hour' | '1day') keyed by truncated timestamp
 * — the table holds the current count and a TTL row per window.
 *
 * STUB: signatures only — full implementation deferred.
 */

import { RateLimitError } from './errors.ts';

export type RateLimitWindow = '1minute' | '1hour' | '1day';

/**
 * @param resource_type Logical resource category ('ai_provider', 'gmail_api', ...).
 * @param resource_key  Specific instance ('openai:gpt-4o-mini', 'user:<id>').
 * @param limit         Max events permitted in the window.
 * @param window        Window granularity.
 *
 * @throws {RateLimitError} when the bucket would exceed `limit`.
 */
export function withRateLimit(
  resource_type: string,
  resource_key: string,
  limit: number,
  _window: RateLimitWindow,
): Promise<void> {
  // STUB: never throws yet. Real impl will UPSERT + check returned count.
  void resource_type;
  void resource_key;
  void limit;
  return Promise.resolve();
}

/** Convenience helper to construct a RateLimitError (used by callers in tests). */
export function rateLimitErrorFor(
  resource_type: string,
  resource_key: string,
  limit: number,
): RateLimitError {
  return new RateLimitError(resource_type, resource_key, limit);
}
