/**
 * lockout.ts — login lockout middleware backed by `rate_limit_buckets`.
 *
 * Ref: T-204, spec §9.1 Lockout
 * Date: 2026-06-10
 *
 * Implements the per-email login lockout policy:
 *   - count window:  30 minutes (rolling, bucket-based)
 *   - threshold:     10 failed attempts within the window
 *   - block window:  60 minutes after the threshold is hit
 *
 * The state lives in `rate_limit_buckets` with `resource_type='auth_login'`
 * and a key derived from the *lowercased* email. Two logical bucket families
 * are kept side-by-side because they cover different windows:
 *
 *   - resource_key = 'fail:<email>'   window_size = '30 minutes'   → counter
 *   - resource_key = 'block:<email>'  window_size = '60 minutes'   → flag
 *
 * The block bucket is created (count=1) the moment the counter crosses the
 * threshold. While that block bucket exists for the email, every login attempt
 * short-circuits to HTTP 423 Locked.
 *
 * `clearLockout()` deletes both buckets and is invoked by the unlock-link flow
 * and by a successful login (the latter resets the counter so a subsequent
 * mistyped password does not unfairly inherit prior failures).
 *
 * NOTE: this module talks to PostgREST via the service_role key — the table
 * has NO RLS (spec §5.8 / table-level rule). Callers MUST run in trusted
 * server-side contexts (Edge Functions, workers).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

/** Logical resource_type used by every key this module writes. */
export const LOCKOUT_RESOURCE_TYPE = 'auth_login';

/** Counter window — failed attempts are bucketed in 30-minute slots. */
export const FAIL_WINDOW_MINUTES = 30;

/** Block window — once tripped, the email is locked for 60 minutes. */
export const BLOCK_WINDOW_MINUTES = 60;

/** Failures within `FAIL_WINDOW_MINUTES` that trigger a block. */
export const FAIL_THRESHOLD = 10;

export type LockoutStatus =
  | { kind: 'ok'; fail_count: number }
  | { kind: 'blocked'; retry_after_seconds: number; block_started_at: string };

type RateLimitBucketRow = {
  resource_type: string;
  resource_key: string;
  window_start: string;
  window_size: string;
  count: number;
};

/** Returns now() truncated to the floor of the given window in minutes. */
export function floorToWindow(now: Date, windowMinutes: number): Date {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Normalizes the email so 'A@B.com' and 'a@b.com' share a bucket. */
export function lockoutKey(emailRaw: string, kind: 'fail' | 'block'): string {
  const email = emailRaw.trim().toLowerCase();
  return `${kind}:${email}`;
}

/** Builds a Supabase service-role client. Override `client` in tests. */
export function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Returns the current lockout status for an email. Does NOT increment counters.
 *
 * - 'blocked' when an unexpired `block:<email>` bucket exists.
 * - 'ok'      otherwise; `fail_count` reflects the current 30-min window.
 */
export async function checkLockout(
  email: string,
  now: Date = new Date(),
  client: SupabaseClient = buildServiceClient(),
): Promise<LockoutStatus> {
  const blockWindowStart = floorToWindow(now, BLOCK_WINDOW_MINUTES);
  const failWindowStart = floorToWindow(now, FAIL_WINDOW_MINUTES);

  // 1) check block bucket first — if present and still in-window, short-circuit
  const { data: blockRow, error: blockErr } = await client
    .from('rate_limit_buckets')
    .select('window_start, count')
    .eq('resource_type', LOCKOUT_RESOURCE_TYPE)
    .eq('resource_key', lockoutKey(email, 'block'))
    .gte('window_start', blockWindowStart.toISOString())
    .maybeSingle();

  if (blockErr) throw blockErr;

  if (blockRow) {
    const blockStartedAt = new Date(blockRow.window_start as string);
    const expiresAt = new Date(blockStartedAt.getTime() + BLOCK_WINDOW_MINUTES * 60_000);
    const retryAfter = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
    return {
      kind: 'blocked',
      retry_after_seconds: retryAfter,
      block_started_at: blockStartedAt.toISOString(),
    };
  }

  // 2) read the current fail bucket — drives downstream UX (no throw)
  const { data: failRow, error: failErr } = await client
    .from('rate_limit_buckets')
    .select('count')
    .eq('resource_type', LOCKOUT_RESOURCE_TYPE)
    .eq('resource_key', lockoutKey(email, 'fail'))
    .eq('window_start', failWindowStart.toISOString())
    .maybeSingle();

  if (failErr) throw failErr;

  return { kind: 'ok', fail_count: (failRow?.count as number | undefined) ?? 0 };
}

/**
 * Records ONE failed login attempt. Returns whether the threshold was crossed
 * by this attempt — when true, callers should emit `auth.lockout.triggered`
 * and dispatch the unlock email.
 *
 * Implementation note: we read-modify-write the bucket inside a single RPC
 * call via an UPSERT-with-increment. In Postgres this is one statement; in
 * PostgREST it's two round-trips guarded by ON CONFLICT.
 */
export async function recordFailure(
  email: string,
  now: Date = new Date(),
  client: SupabaseClient = buildServiceClient(),
): Promise<{ fail_count: number; threshold_crossed: boolean }> {
  const failWindowStart = floorToWindow(now, FAIL_WINDOW_MINUTES);
  const failKey = lockoutKey(email, 'fail');

  // Atomic increment of the fail bucket (no read-then-upsert race — parallel
  // failed logins for the same email must each count exactly once).
  const { data: failCount, error: failErr } = await client.rpc(
    'rate_limit_consume',
    {
      p_resource_type: LOCKOUT_RESOURCE_TYPE,
      p_resource_key: failKey,
      p_window_start: failWindowStart.toISOString(),
      p_window_size: `${FAIL_WINDOW_MINUTES} minutes`,
    },
  );
  if (failErr) throw failErr;

  const nextCount = failCount as number;
  const thresholdCrossed = nextCount >= FAIL_THRESHOLD;

  if (thresholdCrossed) {
    // Create the block bucket (window starts at 60-min floor of `now`)
    const blockWindowStart = floorToWindow(now, BLOCK_WINDOW_MINUTES);
    const blockRow: RateLimitBucketRow = {
      resource_type: LOCKOUT_RESOURCE_TYPE,
      resource_key: lockoutKey(email, 'block'),
      window_start: blockWindowStart.toISOString(),
      window_size: `${BLOCK_WINDOW_MINUTES} minutes`,
      count: 1,
    };
    const { error: blockErr } = await client
      .from('rate_limit_buckets')
      .upsert(blockRow, { onConflict: 'resource_type,resource_key,window_start,window_size' });
    if (blockErr) throw blockErr;
  }

  return { fail_count: nextCount, threshold_crossed: thresholdCrossed };
}

/**
 * Clears both fail and block buckets for an email. Called on:
 *   - successful login (resets the counter)
 *   - unlock-link consumption
 */
export async function clearLockout(
  email: string,
  client: SupabaseClient = buildServiceClient(),
): Promise<void> {
  const { error } = await client
    .from('rate_limit_buckets')
    .delete()
    .eq('resource_type', LOCKOUT_RESOURCE_TYPE)
    .in('resource_key', [lockoutKey(email, 'fail'), lockoutKey(email, 'block')]);
  if (error) throw error;
}

/**
 * Pure math helper exposed for tests: given a Date and a window in minutes,
 * is the supplied historical timestamp still inside the window?
 */
export function isWithinWindow(
  now: Date,
  pastTimestamp: Date,
  windowMinutes: number,
): boolean {
  const ageMs = now.getTime() - pastTimestamp.getTime();
  return ageMs < windowMinutes * 60_000;
}
