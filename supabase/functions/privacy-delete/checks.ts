/**
 * checks.ts — pre-flight gates for §9.4 account deletion.
 *
 * Ref: T-609 (#119), spec §9.4 / §E (privacy/my-account), BR-021.
 * Date: 2026-06-25
 *
 *   - confirmationMatches: the caller must retype their own email (case- and
 *     whitespace-insensitive). A mismatch is a 400 — a guard against accidental
 *     irreversible deletion.
 *   - findSoleAdminHouseholds: the caller cannot delete while they are the ONLY
 *     active admin of a household (it would orphan it). Mirrors the
 *     enforce_min_one_admin trigger exactly (active admins, soft-deleted ignored)
 *     so the 422 pre-empts the EXCEPTION the soft-delete would otherwise raise.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

/** True iff `confirmationEmail` equals `callerEmail` ignoring case/whitespace. */
export function confirmationMatches(confirmationEmail: unknown, callerEmail: string): boolean {
  if (typeof confirmationEmail !== 'string') return false;
  return confirmationEmail.trim().toLowerCase() === callerEmail.trim().toLowerCase();
}

type Row = Record<string, unknown>;

function unwrap(res: { data: unknown; error: { message: string } | null }, what: string): Row[] {
  if (res.error) throw new Error(`privacy-delete ${what} query failed: ${res.error.message}`);
  return (res.data ?? []) as Row[];
}

/**
 * Returns the household_ids where the caller is the sole active admin (and so
 * must hand over the role before deleting). Empty array = safe to proceed.
 */
export async function findSoleAdminHouseholds(
  userId: string,
  client: SupabaseClient,
): Promise<string[]> {
  const mine = unwrap(
    await client
      .from('members')
      .select('household_id')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .is('deleted_at', null),
    'my-admin-households',
  );
  const householdIds = [...new Set(mine.map((r) => r.household_id as string))];
  if (householdIds.length === 0) return [];

  const admins = unwrap(
    await client
      .from('members')
      .select('household_id')
      .eq('role', 'admin')
      .is('deleted_at', null)
      .in('household_id', householdIds),
    'household-admin-counts',
  );

  const counts = new Map<string, number>();
  for (const r of admins) {
    const h = r.household_id as string;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return householdIds.filter((h) => (counts.get(h) ?? 0) <= 1);
}
