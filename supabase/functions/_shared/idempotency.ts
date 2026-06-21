/**
 * idempotency.ts — deterministic-key idempotency guard.
 *
 * Ref: T-317, spec §4.2.1 / §6.1
 * Date: 2026-06-21 (replaces the T-125 stub)
 *
 * `withIdempotency(table, keyField, keyValue, body)` does a fast-path SELECT for
 * an existing row keyed `(keyField = keyValue)` and skips `body` if one is found,
 * returning `{ skipped: true, reason: 'duplicate' }`. Otherwise it runs `body`
 * and returns `{ skipped: false }`.
 *
 * KEY UNIQUENESS: the fast-path SELECT matches on `keyField = keyValue` ALONE,
 * so `keyValue` MUST be globally unique for the chosen `keyField` — not merely
 * unique within a composite constraint. The P4 sync key satisfies this because
 * it embeds the discriminator: `idempotency_key = connected_email_id || ':' ||
 * minute` (see `uq_sync_runs_idempotency`). Do NOT pass a `keyField` that is
 * only unique in combination with other columns, or this will report false
 * duplicates across rows that share the value.
 *
 * RACE SAFETY: the SELECT is only a fast path. The authoritative guarantee is a
 * UNIQUE constraint on the row that `body` writes. On the rare check-then-act
 * race, two callers both see "no row", both run `body`, and the second `body`'s
 * INSERT raises `23505`. This helper does NOT swallow that — `body` (or its
 * caller) must handle the unique violation.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

export type IdempotencyResult = {
  /** true if `body` was skipped because the key was already present. */
  skipped: boolean;
  /** Human-readable reason when skipped (e.g. 'duplicate'). */
  reason?: string;
};

export type WithIdempotencyDeps = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
};

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function withIdempotency(
  table: string,
  keyField: string,
  keyValue: string,
  body: () => Promise<void>,
  deps?: WithIdempotencyDeps,
): Promise<IdempotencyResult> {
  const client = deps?.client ?? buildServiceClient();
  const { data, error } = await client
    .from(table)
    .select(keyField)
    .eq(keyField, keyValue)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`withIdempotency: lookup on ${table}.${keyField} failed: ${error.message}`);
  }
  if (data) {
    return { skipped: true, reason: 'duplicate' };
  }
  await body();
  return { skipped: false };
}
