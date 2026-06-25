/**
 * orchestrator.ts — the §9.4 account-deletion sequence (after the checks pass).
 *
 * Ref: T-609 (#119), spec §9.4 / §E (privacy/my-account), BR-021.
 * Date: 2026-06-25
 *
 * Steps (order matters — every FK to auth.users must be cleared before the
 * final auth deleteUser, see the T-607 coverage whitelist):
 *   1. soft-delete the caller's active memberships (trigger-safe: the sole-admin
 *      pre-check already ran)
 *   2. soft-delete the caller's owned connected_emails + DELETE their vault
 *      secrets (vault errors are best-effort — a leftover secret is recoverable;
 *      leaving the credential active after a delete request is not)
 *   3. DELETE the caller's system_admin_grants (its user_id FK is NOT cascade and
 *      anonymize does NOT touch it)
 *   4. anonymize_user_references(uid) — hard-deletes the now-soft-deleted members
 *      + connected_emails + client_telemetry, scrubs domain_events / consent_log,
 *      and sentinels invoice audit FKs (invoices REMAIN — §9.4 step 5)
 *   5. emit user.deleted { userId, deleted_at } (best-effort)
 *   6. auth deleteUser(uid) — removes auth.users (user_profiles cascades)
 *
 * Idempotent: re-running on an already-deleted user no-ops every step (0 rows
 * matched, anonymize is a no-op) and the injected deleteUser tolerates a missing
 * user. PostgREST has no cross-statement transaction; non-Postgres steps (vault,
 * auth) are compensated by being individually safe to retry.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';

export type Caller = { id: string; email: string };

export type DeleteUserFn = (client: SupabaseClient, userId: string) => Promise<void>;

export type DeleteAccountDeps = {
  emitEvent: (e: DomainEventInput) => Promise<void>;
  deleteUser: DeleteUserFn;
  now: () => number;
  correlationId?: string;
};

type Row = Record<string, unknown>;

function assertNoError(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`privacy-delete ${what} failed: ${error.message}`);
}

/**
 * Executes the §9.4 deletion sequence for `caller`. Returns the deletion
 * timestamp. Throws on a fatal step (membership/email/grant write, anonymize,
 * or auth deleteUser); vault-secret and event-emit failures are logged and
 * swallowed.
 */
export async function deleteAccount(
  caller: Caller,
  client: SupabaseClient,
  deps: DeleteAccountDeps,
): Promise<{ deleted_at: string }> {
  const deletedAt = new Date(deps.now()).toISOString();
  const cid = deps.correlationId;

  // 1) soft-delete active memberships
  {
    const { error } = await client
      .from('members')
      .update({ deleted_at: deletedAt })
      .eq('user_id', caller.id)
      .is('deleted_at', null);
    assertNoError(error, 'membership soft-delete');
  }

  // 2) soft-delete owned emails + delete their vault secrets
  const { data: emailRows, error: emailErr } = await client
    .from('connected_emails')
    .select('id, app_password_secret')
    .eq('owner_user_id', caller.id)
    .is('deleted_at', null);
  assertNoError(emailErr, 'owned-emails read');

  if ((emailRows ?? []).length > 0) {
    const { error: revokeErr } = await client
      .from('connected_emails')
      .update({ deleted_at: deletedAt, status: 'revoked' })
      .eq('owner_user_id', caller.id)
      .is('deleted_at', null);
    assertNoError(revokeErr, 'owned-emails soft-delete');

    for (const row of emailRows as Row[]) {
      const secretId = row.app_password_secret as string | null;
      if (!secretId) continue;
      const { error: vaultErr } = await client.rpc('delete_vault_secret', { secret_id: secretId });
      if (vaultErr) {
        log.warn('privacy-delete: vault secret delete failed (best-effort)', {
          correlation_id: cid,
          err: redactSecrets(vaultErr.message),
        });
      }
    }
  }

  // 3) drop sys-admin grants (FK not cascade; anonymize ignores it)
  {
    const { error } = await client
      .from('system_admin_grants')
      .delete()
      .eq('user_id', caller.id);
    assertNoError(error, 'system_admin_grants delete');
  }

  // 4) anonymize — sentinels audit refs, hard-deletes soft-deleted ownership rows
  {
    const { error } = await client.rpc('anonymize_user_references', { target_user_id: caller.id });
    assertNoError(error, 'anonymize_user_references');
  }

  // 5) emit user.deleted (best-effort)
  try {
    await deps.emitEvent({
      type: 'user.deleted',
      aggregate_type: 'user',
      aggregate_id: caller.id,
      correlation_id: cid,
      actor_type: 'user',
      actor_user_id: caller.id,
      payload: { version: 1, data: { userId: caller.id, deleted_at: deletedAt } },
    });
  } catch (e) {
    log.warn('privacy-delete: user.deleted emit failed (non-fatal)', {
      correlation_id: cid,
      err: redactSecrets(e instanceof Error ? e.message : String(e)),
    });
  }

  // 6) remove the auth user (cascades user_profiles)
  await deps.deleteUser(client, caller.id);

  return { deleted_at: deletedAt };
}

/**
 * Default auth deleteUser: calls the GoTrue admin API and treats a missing user
 * as success (idempotent re-call). Other errors are fatal.
 */
export const defaultDeleteUser: DeleteUserFn = async (client, userId) => {
  const { error } = await client.auth.admin.deleteUser(userId);
  if (!error) return;
  const msg = error.message ?? '';
  if (/not.?found/i.test(msg) || (error as { status?: number }).status === 404) {
    return; // already gone — idempotent
  }
  throw new Error(`privacy-delete auth deleteUser failed: ${msg}`);
};

/** Default event emitter bound to the given client. */
export function defaultEmitEvent(client: SupabaseClient): (e: DomainEventInput) => Promise<void> {
  return (e) => emitDomainEvent(e, { client });
}
