/**
 * ip_rate.ts — per-IP rate counters for auth-signup-guard and auth-reset-guard.
 *
 * Ref: T-205, spec §9.1 (5 signups/h/IP, 10 resets/h/IP)
 * Date: 2026-06-10
 *
 * Mirrors the bucket pattern from `lockout.ts` but keyed by IP instead of
 * email. The 60-minute window is fixed (per spec) and the resource_type is
 * passed in by the caller ('auth_signup' or 'auth_password_reset').
 *
 * When the bucket count crosses the configured limit, the caller responds
 * HTTP 429 { error: 'captcha_required' } and the Flutter UI renders the
 * hCaptcha widget for the next retry.
 *
 * NOTE: this module talks to PostgREST via service_role; the
 * `rate_limit_buckets` table has no RLS (spec §5.8).
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { floorToWindow } from './lockout.ts';

/** Resource type written to rate_limit_buckets for signups. */
export const IP_RATE_RESOURCE_SIGNUP = 'auth_signup';

/** Resource type written for password reset requests. */
export const IP_RATE_RESOURCE_RESET = 'auth_password_reset';

/** Single window across both buckets — spec §9.1. */
export const IP_RATE_WINDOW_MINUTES = 60;

/** Spec §9.1 — 5 signups per hour per IP. */
export const IP_RATE_SIGNUP_LIMIT = 5;

/** Spec §9.1 — 10 resets per hour per IP. */
export const IP_RATE_RESET_LIMIT = 10;

export type IpRateStatus = {
  /** Post-increment count for the current window. */
  count: number;
  /** True when `count > limit` — caller must require captcha. */
  over_limit: boolean;
};

/** Builds the bucket key. `ip` may be 'unknown' when no proxy header is set. */
export function ipRateKey(ip: string): string {
  return `ip:${ip}`;
}

/**
 * Increments the IP bucket by 1 and returns whether the post-increment count
 * exceeds `limit`. Idempotency is intentionally NOT enforced here — every call
 * counts (per spec §9.1: signup attempts, not unique submissions).
 *
 * @param ip            IP address (already normalized by extractClientIp).
 * @param resource_type 'auth_signup' or 'auth_password_reset'.
 * @param limit         Threshold beyond which captcha is required.
 * @param now           Override for tests; defaults to wall clock.
 * @param client        Supabase service-role client.
 */
export async function countAndIncrementIp(
  ip: string,
  resource_type: string,
  limit: number,
  now: Date,
  client: SupabaseClient,
): Promise<IpRateStatus> {
  const windowStart = floorToWindow(now, IP_RATE_WINDOW_MINUTES);

  // Atomic increment (INSERT .. ON CONFLICT DO UPDATE count+1) — no
  // read-then-upsert race under concurrent requests from the same IP.
  const { data, error } = await client.rpc('rate_limit_consume', {
    p_resource_type: resource_type,
    p_resource_key: ipRateKey(ip),
    p_window_start: windowStart.toISOString(),
    p_window_size: `${IP_RATE_WINDOW_MINUTES} minutes`,
  });
  if (error) throw error;

  const nextCount = data as number;
  return { count: nextCount, over_limit: nextCount > limit };
}

/**
 * Peeks the current bucket without incrementing. Used when we want to decide
 * whether to require captcha BEFORE doing any expensive work but cannot
 * double-count (e.g. when a previous middleware already counted).
 */
export async function peekIpRate(
  ip: string,
  resource_type: string,
  now: Date,
  client: SupabaseClient,
): Promise<number> {
  const windowStart = floorToWindow(now, IP_RATE_WINDOW_MINUTES);
  const { data, error } = await client
    .from('rate_limit_buckets')
    .select('count')
    .eq('resource_type', resource_type)
    .eq('resource_key', ipRateKey(ip))
    .eq('window_start', windowStart.toISOString())
    .maybeSingle();
  if (error) throw error;
  return (data?.count as number | undefined) ?? 0;
}
