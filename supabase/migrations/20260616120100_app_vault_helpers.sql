-- ============================================================================
-- Migration: 20260616120100_app_vault_helpers.sql
-- Date:      2026-06-10
-- Task:      T-208
-- Purpose:   Install the two SECURITY DEFINER wrappers around `vault.*` that
--            every Edge Function / pg_cron worker MUST use to interact with
--            Supabase Vault:
--
--              * app.create_vault_secret(secret_value text, name text,
--                                         description text) RETURNS uuid
--                  — wraps `vault.create_secret(value, name, description)`
--                  and returns the new secret's UUID. Called by
--                  POST /emails/connect (T-212) when persisting Gmail app
--                  passwords; called by PATCH /emails/:id/rotate-password
--                  path (T-216) when rotating credentials (via the partner
--                  wrapper for vault.update_secret in a separate migration).
--
--              * app.decrypt_app_password(secret_id uuid) RETURNS text
--                  — reads `vault.decrypted_secrets` view, returns the
--                  plaintext app password OR raises P0002 ('Vault secret not
--                  found') when the row does not exist. Called by the IMAP
--                  worker (T-401+) immediately before each IMAP session and
--                  the returned plaintext MUST be zeroed in a `finally` block
--                  (see §6.5 redact contract, §9.3.1 caller-side hygiene).
--
-- Spec refs: §9.3.1 ("Operações Vault — contrato completo") — verbatim
--                   function bodies, REVOKE/GRANT matrix, P0002 error code,
--                   `SET search_path = ''` invariant.
--            §9.3 (Supabase Vault para app passwords) — overall threat model:
--                   end-user JS has zero direct access; everything goes
--                   through these two SECURITY DEFINER wrappers.
--
-- Design notes:
--
--   * `SET search_path = ''` (empty string) — strictly more defensive than
--     `SET search_path = pg_catalog, pg_temp`. With an empty path EVERY
--     reference inside the function body MUST be fully schema-qualified
--     (`vault.create_secret`, `vault.decrypted_secrets`). This is the
--     canonical hardening against the CVE-2018-1058 class (search-path
--     hijacking inside SECURITY DEFINER functions). See the spec §9.3.1
--     verbatim: `SET search_path = ''`.
--
--   * SECURITY DEFINER means the function runs with the privileges of its
--     OWNER, not the caller. The function owner is `postgres` (the role that
--     applies the migration), which has the required GRANT on `vault.*`.
--     Crucially:
--       - The caller does NOT need any GRANT on vault.* — they only need
--         EXECUTE on the wrapper.
--       - We REVOKE EXECUTE FROM PUBLIC (Postgres default is GRANT EXECUTE
--         to PUBLIC on every new function — silent footgun) and GRANT
--         EXECUTE TO service_role only. anon and authenticated cannot call
--         these wrappers at all, which is exactly the threat model in §9.3.
--
--   * decrypt_app_password raises 'P0002' explicitly (SQLSTATE 'P0002' is
--     plpgsql_no_data_found) so callers can distinguish "secret missing"
--     from "decryption failure" cleanly. The Edge Function error mapping
--     (T-219 errors middleware) maps P0002 -> 404 VAULT_SECRET_NOT_FOUND
--     in the response envelope.
--
--   * Function bodies are LANGUAGE plpgsql (not sql) deliberately: plpgsql
--     supports `RAISE EXCEPTION ... USING ERRCODE = 'P0002'`, sql does not.
--     The spec uses plpgsql for both wrappers for symmetry.
--
--   * IMMUTABLE/STABLE/VOLATILE: both wrappers default to VOLATILE (correct
--     — `vault.create_secret` is INSERT, `vault.decrypted_secrets` reads
--     state that can change). We do NOT mark them STABLE.
--
--   * Idempotency: `CREATE OR REPLACE FUNCTION` so the migration can be
--     re-applied without error. The REVOKE/GRANT statements are idempotent
--     by design (REVOKE on an absent grant is a no-op; GRANT is set-like).
--
-- Caller contract (enforced by code review / lint, not the DB):
--   * Edge Functions: call ONLY via supabaseAdmin.rpc('create_vault_secret', …)
--     or supabaseAdmin.rpc('decrypt_app_password', …) — never SELECT from
--     `vault.*` directly. The GRANT matrix in T-209 will additionally REVOKE
--     all vault.* access from anon/authenticated as belt-and-braces.
--   * Workers: zero the plaintext local variable in `finally`.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ----------------------------------------------------------------------------
--   * DO NOT call vault.create_secret / vault.decrypted_secrets directly
--     from Edge Functions or workers — always go through these wrappers.
--   * DO NOT GRANT EXECUTE on either wrapper to authenticated / anon —
--     service_role only. End-user JS must NEVER touch the wrappers.
--   * DO NOT remove `SET search_path = ''` from either function — opens a
--     search-path hijack vector.
--   * DO NOT change the SQLSTATE in decrypt_app_password from 'P0002' —
--     the errors middleware (T-219) maps that exact code to 404.
--   * DO NOT add an "or return NULL on miss" overload — silent NULL on a
--     missing secret would mask credential-rotation bugs in production.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. app.create_vault_secret(secret_value, name, description) RETURNS uuid
-- ============================================================================
-- Thin SECURITY DEFINER wrapper around vault.create_secret(value, name, desc).
-- Returns the new secret UUID. Caller (POST /emails/connect) immediately
-- persists this UUID into connected_emails.app_password_secret.
--
-- Both `name` and `description` are optional debug-only labels — they are
-- NEVER used for lookup (the UUID is the only handle that matters). The
-- recommended naming convention from §9.3.1 is:
--   name        = 'gmail_app_pwd:<email_address>'
--   description = 'App password Gmail user <owner_user_id>'
-- But this wrapper does not enforce that — callers compose the strings.
CREATE OR REPLACE FUNCTION app.create_vault_secret(
  secret_value text,
  name         text DEFAULT NULL,
  description  text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_id uuid;
BEGIN
  -- vault.create_secret is the public, stable API of the supabase_vault
  -- extension. Signature: (new_secret text, new_name text DEFAULT NULL,
  -- new_description text DEFAULT '', new_key_id uuid DEFAULT NULL) RETURNS uuid.
  -- We pass only the three positional args the spec contract specifies; the
  -- key_id defaults to the project's default vault key (correct for our
  -- single-tenant Supabase project).
  SELECT vault.create_secret(secret_value, name, description) INTO new_id;
  RETURN new_id;
END;
$$;

COMMENT ON FUNCTION app.create_vault_secret(text, text, text) IS
  'Wrapper SECURITY DEFINER em torno de vault.create_secret. Retorna o UUID '
  'do segredo recém-criado. Chamado por POST /emails/connect ao persistir '
  'app passwords Gmail. EXECUTE concedido apenas a service_role — ver '
  'spec §9.3.1.';

REVOKE EXECUTE ON FUNCTION app.create_vault_secret(text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.create_vault_secret(text, text, text) TO service_role;


-- ============================================================================
-- 2. app.decrypt_app_password(secret_id uuid) RETURNS text
-- ============================================================================
-- SECURITY DEFINER wrapper that reads `vault.decrypted_secrets` and returns
-- the plaintext app password. Raises 'P0002' (plpgsql_no_data_found) when
-- no row matches the given secret_id — callers MUST handle this explicitly
-- (the errors middleware maps it to HTTP 404 VAULT_SECRET_NOT_FOUND).
--
-- CRITICAL caller-side hygiene (NOT enforced by the DB — see §9.3.1):
--   * Store the returned text in a local variable scoped to the minimum
--     possible block.
--   * Pass it ONLY to the IMAP client.
--   * Zero the local variable in a `finally` block immediately after IMAP
--     login completes, success or failure.
--   * NEVER log it (the redactSecrets middleware will catch accidental logs
--     but defense-in-depth: don't log it in the first place).
CREATE OR REPLACE FUNCTION app.decrypt_app_password(secret_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pw text;
BEGIN
  -- vault.decrypted_secrets is a Supabase-provided view that decrypts on the
  -- fly. Reading from it is the only correct way to retrieve a plaintext
  -- secret — vault.secrets stores ciphertext only. The view applies access
  -- control via SECURITY DEFINER inside the extension; combined with our
  -- own REVOKE/GRANT (T-209), end-user roles have zero path to this view.
  SELECT decrypted_secret
    INTO pw
    FROM vault.decrypted_secrets
   WHERE id = secret_id;

  -- Distinguish "secret missing" (P0002) from "got NULL plaintext somehow"
  -- (which would itself be a bug — vault.create_secret rejects NULL values).
  -- We raise P0002 in either case; the spec only specifies the missing-row
  -- semantics, and NULL plaintext is treated as equivalent for callers.
  IF pw IS NULL THEN
    RAISE EXCEPTION 'Vault secret not found: %', secret_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN pw;
END;
$$;

COMMENT ON FUNCTION app.decrypt_app_password(uuid) IS
  'Wrapper SECURITY DEFINER que lê vault.decrypted_secrets. Retorna o app '
  'password em texto plano OU levanta P0002 (Vault secret not found) se o '
  'UUID não existir. Caller DEVE zerar a variável local após uso (finally). '
  'EXECUTE concedido apenas a service_role — ver spec §9.3.1 / §6.5.';

REVOKE EXECUTE ON FUNCTION app.decrypt_app_password(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.decrypt_app_password(uuid) TO service_role;


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616120100_app_vault_helpers',
  'Vault wrappers: app.create_vault_secret(text,text,text) + '
  'app.decrypt_app_password(uuid) — SECURITY DEFINER, search_path='''', '
  'EXECUTE service_role only, decrypt raises P0002 on miss. Spec §9.3.1.'
)
ON CONFLICT (migration_name) DO NOTHING;
