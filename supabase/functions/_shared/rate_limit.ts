/**
 * rate_limit.ts — snake_case alias kept for back-compat with T-125 bootstrap.
 *
 * Ref:  T-230 (replaces T-125 stub), spec §4.2.1
 * Date: 2026-06-10
 *
 * The spec canonicalises the helper name as `withRateLimit` in `rateLimit.ts`
 * (camelCase, §4.2.1). The original bootstrap (T-125) landed the file under
 * the snake_case path because that was the working name at the time. To avoid
 * breaking any caller that pinned this path, we re-export the real
 * implementation here and additionally expose the legacy `void`-returning
 * shape for ergonomic upgrades.
 *
 * NEW CALLERS: import from `./rateLimit.ts` directly.
 */

export {
  floorToRateWindow,
  peekRateLimit,
  type RateLimitStatus,
  type RateLimitWindow,
  type WithRateLimitDeps,
  withRateLimit,
} from './rateLimit.ts';

export { RateLimitError } from './errors.ts';

import { RateLimitError } from './errors.ts';

/**
 * Convenience helper to construct a RateLimitError (kept from the T-125 stub
 * so any test that imported it does not break).
 */
export function rateLimitErrorFor(
  resource_type: string,
  resource_key: string,
  limit: number,
): RateLimitError {
  return new RateLimitError(resource_type, resource_key, limit);
}
