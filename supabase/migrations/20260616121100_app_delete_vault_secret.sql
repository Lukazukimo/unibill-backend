-- ============================================================================
-- Migration: 20260616121100_app_delete_vault_secret.sql
-- Date:      2026-06-10
-- Task:      T-214
-- Purpose:   Install the fourth (and final, for the email-credential lifecycle)
--            SECURITY DEFINER wrapper around `vault.*` —
--            `app.delete_vault_secret(secret_id uuid) RETURNS boolean` —
--            used by the revocation Edge Function DELETE /emails/:id.
--
--            Unlike `update_vault_secret` (in-place mutation), the delete path
--            hard-deletes the row from `vault.secrets`. That is intentional:
--              * The user is revoking the credential, NOT rotating it. There
--                is no future password to hand to in-flight workers.
--              * `connected_emails.app_password_secret` continues to point at
--                a now-deleted vault row. Subsequent decrypt attempts raise
--                P0002 — which is exactly what we want: a worker that races
--                with revocation MUST fail fast on the next IMAP cycle so it
--                does not pretend the credential is still good.
--              * The decision to soft-delete `connected_emails` (and the
--                bindings) but HARD-delete the vault row is the LGPD-safer
--                stance: the audit trail of "who connected what email when"
--                stays queryable for legal hold + reporting, but the actual
--                plaintext credential leaves the database immediately.
--
-- Spec refs: §9.3.1 ("Operações Vault — contrato completo") — note the
--                    end-of-section bullet:
--                       "System admin pode 'revogar acesso' (DELETE secret +
--                        UPDATE connected_emails.status='revoked')"
--                    establishing the explicit DELETE semantic.
--            §9.3   (Supabase Vault for app passwords — overall threat model:
--                    end-user JS has zero direct access; every Vault mutation
--                    goes through a SECURITY DEFINER wrapper in schema `app`).
--            §E     (DELETE /emails/:id contract — `{ soft_deleted: true }`).
--            §5.10  (ownership lifecycle — `connected_emails` soft-delete via
--                    deleted_at + status='revoked'; vault is hard-deleted as
--                    PII hygiene; see also app.anonymize_user in T-228).
--
-- Design notes:
--
--   * `SET search_path = ''` — same invariant as T-208 / T-213 wrappers.
--     Every reference (`vault.secrets`) is fully schema-qualified.
--
--   * SECURITY DEFINER + owner=postgres + REVOKE PUBLIC + GRANT service_role:
--     identical posture to the other three wrappers. anon and authenticated
--     cannot touch this function — only the Edge Function running with
--     service_role can. Defense in depth on top of the schema-level grants
--     installed in T-209.
--
--   * Supabase Vault does NOT publish a `vault.delete_secret(uuid)` function;
--     the supported API is a plain `DELETE FROM vault.secrets WHERE id = $1`
--     under the `service_role` (or extension owner). Because this wrapper
--     runs SECURITY DEFINER as `postgres`, the DELETE succeeds even when
--     the caller (`service_role`) does not itself have DELETE on vault.secrets.
--
--   * Return type is `boolean`:
--       - `true`  → the row existed and was deleted (the "happy" path).
--       - `false` → the row was already gone (idempotent re-delete is a no-op).
--     This is intentional. The DELETE /emails/:id endpoint may be retried by
--     the client (network blip + idempotency layer). On the second call the
--     `connected_emails` row is already soft-deleted; the wrapper returns
--     `false` and the Edge Function still responds 200 `{ soft_deleted: true }`
--     so the client sees a stable, idempotent contract. Compare with the
--     decrypt / update wrappers, which raise P0002 on miss — those operations
--     have NO valid "already-gone" semantic; revocation does.
--
--   * `GET DIAGNOSTICS row_count` after the DELETE is the conventional way to
--     observe whether the DELETE actually removed a row. We rely on it rather
--     than a pre-SELECT to avoid a race window (concurrent revoke from two
--     tabs would otherwise return inconsistent booleans).
--
--   * Idempotent migration: `CREATE OR REPLACE FUNCTION` + idempotent
--     REVOKE/GRANT statements; metadata INSERT uses ON CONFLICT DO NOTHING.
--
-- Caller contract (enforced by code review / lint, not the DB):
--   * Edge Function MUST call via supabaseAdmin.rpc('delete_vault_secret', {…})
--     — never `DELETE FROM vault.secrets …` directly.
--   * Caller MUST treat `false` as success (idempotent re-call). Map a true
--     error (rpcErr) to 500; treat the boolean payload purely as a metric.
--   * Caller MUST perform the soft-delete of `connected_emails` and the
--     bindings in the SAME logical operation. The wrapper does NOT touch
--     business tables — orchestration is the Edge Function's job.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ----------------------------------------------------------------------------
--   * DO NOT GRANT EXECUTE on this wrapper to authenticated / anon —
--     service_role only.
--   * DO NOT remove `SET search_path = ''`.
--   * DO NOT change the return type to void — the boolean is part of the
--     idempotency contract documented above.
--   * DO NOT raise on missing rows. Revocation MUST be idempotent so client
--     retries are safe.
--   * DO NOT add a `CASCADE`-style overload that also deletes connected_emails
--     rows. The wrapper is single-purpose; orchestration belongs to the
--     Edge Function (so we can emit `email.revoked` with the correct payload
--     atomically with the soft-delete).
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. app.delete_vault_secret(secret_id uuid) RETURNS boolean
-- ============================================================================
-- Idempotent: returns TRUE iff a row was actually deleted, FALSE otherwise.
-- Never raises on missing rows — see "Caller contract" above.
CREATE OR REPLACE FUNCTION app.delete_vault_secret(secret_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected integer;
BEGIN
  -- Single statement, single round-trip. DELETE on a missing id is a no-op
  -- (zero rows affected); we surface that via the boolean return value.
  DELETE FROM vault.secrets WHERE id = secret_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

COMMENT ON FUNCTION app.delete_vault_secret(uuid) IS
  'Wrapper SECURITY DEFINER que hard-deleta uma row em vault.secrets. '
  'Retorna TRUE se a row existia (e foi deletada), FALSE se já estava ausente '
  '— idempotente por design para suportar retries do DELETE /emails/:id. '
  'EXECUTE concedido apenas a service_role. Spec §9.3.1 (revogação).';

REVOKE EXECUTE ON FUNCTION app.delete_vault_secret(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.delete_vault_secret(uuid) TO service_role;


-- ============================================================================
-- 2. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616121100_app_delete_vault_secret',
  'Vault wrapper: app.delete_vault_secret(uuid) RETURNS boolean — '
  'SECURITY DEFINER, search_path='''', EXECUTE service_role only. '
  'Hard-deleta vault.secrets row; idempotente (FALSE quando já ausente) '
  'pra suportar retries do DELETE /emails/:id. Spec §9.3.1 (revogação).'
)
ON CONFLICT (migration_name) DO NOTHING;
