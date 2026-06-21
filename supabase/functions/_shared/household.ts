/**
 * household.ts — resolve the target household for a connected_email.
 *
 * Ref: T-322, spec §5.2 / §6.4
 * Date: 2026-06-21
 *
 * A Gmail account can feed several households (connected_email_households is a
 * many-to-many with a partial-unique single default). When the worker captures
 * an invoice it must route it to ONE household:
 *   - exactly one active binding        → that household
 *   - several, one marked is_default    → the default
 *   - several, none default             → AmbiguousBindingError
 *   - none                              → BindingNotFoundError
 *
 * "Active" = `deleted_at IS NULL` (soft-deleted bindings are ignored, matching
 * the partial unique index `uq_email_household_active`).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { AmbiguousBindingError, BindingNotFoundError } from './errors.ts';

export type ResolveHouseholdDeps = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
};

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function resolveTargetHousehold(
  connectedEmailId: string,
  deps?: ResolveHouseholdDeps,
): Promise<string> {
  const client = deps?.client ?? buildServiceClient();
  const { data, error } = await client
    .from('connected_email_households')
    .select('household_id, is_default')
    .eq('connected_email_id', connectedEmailId)
    .is('deleted_at', null);
  if (error) {
    throw new Error(
      `resolveTargetHousehold: lookup failed for ${connectedEmailId}: ${error.message}`,
    );
  }

  const bindings = (data ?? []) as Array<{ household_id: string; is_default: boolean }>;
  if (bindings.length === 0) {
    throw new BindingNotFoundError(connectedEmailId);
  }
  if (bindings.length === 1) {
    return bindings[0].household_id;
  }
  const def = bindings.find((b) => b.is_default);
  if (!def) {
    throw new AmbiguousBindingError(connectedEmailId, bindings.length);
  }
  return def.household_id;
}
