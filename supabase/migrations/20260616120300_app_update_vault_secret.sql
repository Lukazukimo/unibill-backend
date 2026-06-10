-- ============================================================================
-- Migration: 20260616120300_app_update_vault_secret.sql
-- Date:      2026-06-10
-- Task:      T-213
-- Purpose:   Install the third SECURITY DEFINER wrapper around `vault.*` ---
--            `app.update_vault_secret(secret_id, new_value, new_name,
--            new_description) RETURNS uuid` — used by the password rotation
--            Edge Function PATCH /emails/:id/rotate-password.
--
--            Unlike "delete-then-create" rotation, `vault.update_secret`
--            **mutates the row in-place**, so:
--              * `connected_emails.app_password_secret` (foreign uuid) keeps
--                pointing at the same secret row — zero schema mutation;
--              * any IMAP worker currently in-flight has the *previous*
--                plaintext already buffered in memory and finishes its session
--                cleanly. Its next decrypt call picks up the NEW value.
--
--            This avoids the race window that a delete+create rotation would
--            open (worker holding an FK to a destroyed uuid).
--
-- Spec refs: §9.3.1 ("Operações Vault — contrato completo") — verbatim block
--                    for the rotation flow:
--                       SELECT vault.update_secret(
--                         $1, $2, format('gmail_app_pwd:%s (rotated %s)', email, now()::text),
--                         format('Rotated at %s by user %s', now()::text, userId));
--            §9.3   (Supabase Vault for app passwords — overall threat model).
--            §E     (PATCH /emails/:id/rotate-password contract).
--
-- Design notes:
--
--   * `SET search_path = ''` — same invariant as T-208 wrappers. Every
--     reference (`vault.update_secret`) is fully schema-qualified.
--
--   * SECURITY DEFINER + owner=postgres + REVOKE PUBLIC + GRANT service_role:
--     identical posture to `app.create_vault_secret` / `app.decrypt_app_password`.
--     anon and authenticated cannot touch this function — only the Edge Function
--     running with service_role can.
--
--   * Return type is `uuid` (the SAME id the caller passed in) for symmetry
--     with `create_vault_secret`. The spec contract returns void from
--     vault.update_secret; we re-emit the id so the caller can log it without
--     a re-read and so the contract matches the create wrapper.
--
--   * The Supabase `vault.update_secret` extension function signature is:
--       vault.update_secret(
--         secret_id uuid,
--         new_secret text DEFAULT NULL,
--         new_name text DEFAULT NULL,
--         new_description text DEFAULT NULL,
--         new_key_id uuid DEFAULT NULL
--       ) RETURNS void
--     We pass NULL for `new_key_id` so the existing encryption key is preserved
--     (otherwise rotating would also rotate the KEY, which is a different
--     operation reserved for the admin runbook).
--
--   * `IF NOT FOUND` check: vault.update_secret silently no-ops on missing
--     ids (it's an UPDATE under the hood). We re-verify with a SELECT in
--     `vault.decrypted_secrets` count — if the row didn't exist before the
--     update either, raise P0002 so the Edge Function can map to a clean 404
--     (matching the decrypt_app_password contract).
--
--   * Idempotent: `CREATE OR REPLACE FUNCTION` + idempotent REVOKE/GRANT.
--
-- Caller contract (enforced by code review, not the DB):
--   * Edge Function MUST call via supabaseAdmin.rpc('update_vault_secret', {...})
--     — never SELECT vault.* directly.
--   * Caller MUST re-validate IMAP with the NEW password BEFORE calling this
--     wrapper. Vault swap is irreversible without another rotation, so
--     swapping with an invalid password would lock the user out.
--   * Caller MUST zero the plaintext local variable in a `finally` block after
--     the rpc call returns (same hygiene as create_vault_secret).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ----------------------------------------------------------------------------
--   * DO NOT GRANT EXECUTE on this wrapper to authenticated / anon —
--     service_role only.
--   * DO NOT remove `SET search_path = ''`.
--   * DO NOT skip the IMAP re-validation in the calling Edge Function — the
--     wrapper does not (and cannot) verify the new password is valid.
--   * DO NOT add a "create-new-uuid-and-delete-old" overload — that breaks
--     in-flight workers (the whole point of preferring update_secret).
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. app.update_vault_secret(secret_id, new_value, new_name, new_description)
--    RETURNS uuid (the SAME id passed in, for symmetry with create wrapper)
-- ============================================================================
CREATE OR REPLACE FUNCTION app.update_vault_secret(
  secret_id        uuid,
  new_value        text,
  new_name         text DEFAULT NULL,
  new_description  text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  exists_before boolean;
BEGIN
  -- Pre-check existence so we can raise P0002 deterministically on miss.
  -- vault.update_secret is a no-op on missing ids (under the hood it's an
  -- UPDATE … WHERE id = secret_id; zero rows affected silently). The Edge
  -- Function relies on this exception to return 404 → the user sees a clean
  -- "credential not found" instead of a phantom success.
  SELECT EXISTS (
    SELECT 1 FROM vault.secrets WHERE id = secret_id
  ) INTO exists_before;

  IF NOT exists_before THEN
    RAISE EXCEPTION 'Vault secret not found: %', secret_id
      USING ERRCODE = 'P0002';
  END IF;

  -- In-place mutation. Passing NULL for new_key_id preserves the existing
  -- encryption key (key rotation is a separate admin operation).
  PERFORM vault.update_secret(
    secret_id,
    new_value,
    new_name,
    new_description
  );

  RETURN secret_id;
END;
$$;

COMMENT ON FUNCTION app.update_vault_secret(uuid, text, text, text) IS
  'Wrapper SECURITY DEFINER em torno de vault.update_secret. Atualiza o '
  'plaintext (e opcionalmente name/description) de um secret existente '
  'mantendo o UUID — workers em-vôo continuam com o password antigo já '
  'buffered, próximo decrypt pega o novo. Levanta P0002 se o secret_id '
  'não existe. EXECUTE concedido apenas a service_role. Spec §9.3.1.';

REVOKE EXECUTE ON FUNCTION app.update_vault_secret(uuid, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.update_vault_secret(uuid, text, text, text) TO service_role;


-- ============================================================================
-- 2. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616120300_app_update_vault_secret',
  'Vault wrapper: app.update_vault_secret(uuid,text,text,text) — '
  'SECURITY DEFINER, search_path='''', EXECUTE service_role only. '
  'In-place mutation preserves uuid so in-flight workers stay coherent. '
  'Raises P0002 on missing secret_id. Spec §9.3.1 (rotation flow).'
)
ON CONFLICT (migration_name) DO NOTHING;
