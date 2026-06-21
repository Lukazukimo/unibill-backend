/**
 * rateLimit.ts — token-bucket rate limiter (per resource + time window).
 *
 * Ref: T-319, spec §5.8 / §4.2.1
 * Date: 2026-06-21 (rebuilds the file that `rate_limit.ts` re-exports)
 *
 * `withRateLimit(resource_type, resource_key, {window, limit}, fn)` consumes one
 * token from the current window's bucket via the atomic SQL function
 * `app.rate_limit_consume` (INSERT .. ON CONFLICT DO UPDATE count+1) and throws
 * `RateLimitError` when the resulting count exceeds `limit`; otherwise it runs
 * `fn`. `peekRateLimit` is a read-only view of the current bucket.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { RateLimitError } from './errors.ts';

export type RateLimitWindow = '1minute' | '1hour' | '1day';

export type RateLimitStatus = {
  count: number;
  limit: number;
  window: RateLimitWindow;
  window_start: string;
  exceeded: boolean;
};

export type WithRateLimitDeps = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
  /** ms-epoch clock (defaults to `Date.now`); injectable for tests. */
  clock?: () => number;
};

const WINDOW_MS: Record<RateLimitWindow, number> = {
  '1minute': 60_000,
  '1hour': 3_600_000,
  '1day': 86_400_000,
};

const WINDOW_INTERVAL: Record<RateLimitWindow, string> = {
  '1minute': '1 minute',
  '1hour': '1 hour',
  '1day': '1 day',
};

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Floors `nowMs` to the start of its window (UTC-aligned). */
export function floorToRateWindow(window: RateLimitWindow, nowMs: number): Date {
  const size = WINDOW_MS[window];
  return new Date(Math.floor(nowMs / size) * size);
}

export async function withRateLimit<T>(
  resource_type: string,
  resource_key: string,
  opts: { window: RateLimitWindow; limit: number },
  fn: () => Promise<T>,
  deps?: WithRateLimitDeps,
): Promise<T> {
  const client = deps?.client ?? buildServiceClient();
  const nowMs = (deps?.clock ?? (() => Date.now()))();
  const windowStart = floorToRateWindow(opts.window, nowMs);
  const { data, error } = await client.rpc('rate_limit_consume', {
    p_resource_type: resource_type,
    p_resource_key: resource_key,
    p_window_start: windowStart.toISOString(),
    p_window_size: WINDOW_INTERVAL[opts.window],
  });
  if (error) {
    throw new Error(
      `withRateLimit: consume failed for ${resource_type}:${resource_key}: ${error.message}`,
    );
  }
  // Fail CLOSED: a non-numeric result means the contract broke; never default
  // to 0 (which would let `fn` run as if well under the limit).
  if (typeof data !== 'number') {
    throw new Error(
      `withRateLimit: rate_limit_consume returned non-numeric count for ${resource_type}:${resource_key}`,
    );
  }
  const count = data;
  if (count > opts.limit) {
    throw new RateLimitError(resource_type, resource_key, opts.limit);
  }
  return await fn();
}

export async function peekRateLimit(
  resource_type: string,
  resource_key: string,
  opts: { window: RateLimitWindow; limit: number },
  deps?: WithRateLimitDeps,
): Promise<RateLimitStatus> {
  const client = deps?.client ?? buildServiceClient();
  const nowMs = (deps?.clock ?? (() => Date.now()))();
  const windowStart = floorToRateWindow(opts.window, nowMs);
  const { data, error } = await client
    .from('rate_limit_buckets')
    .select('count')
    .eq('resource_type', resource_type)
    .eq('resource_key', resource_key)
    .eq('window_start', windowStart.toISOString())
    .eq('window_size', WINDOW_INTERVAL[opts.window])
    .maybeSingle();
  if (error) {
    throw new Error(`peekRateLimit: lookup failed: ${error.message}`);
  }
  const count = data ? (data as { count: number }).count : 0;
  return {
    count,
    limit: opts.limit,
    window: opts.window,
    window_start: windowStart.toISOString(),
    exceeded: count > opts.limit,
  };
}
