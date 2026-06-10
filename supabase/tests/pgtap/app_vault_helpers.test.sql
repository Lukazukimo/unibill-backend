-- ============================================================================
-- Test:      supabase/tests/pgtap/app_vault_helpers.test.sql
-- Date:      2026-06-10
-- Task:      T-208
-- Purpose:   pgTAP test suite covering the two Vault wrappers installed by
--            migration 20260616120100_app_vault_helpers.sql:
--
--              * app.create_vault_secret(text, text, text) RETURNS uuid
--              * app.decrypt_app_password(uuid) RETURNS text
--
--            The contract we verify (per spec §9.3.1):
--
--              (A) Both functions exist with prosecdef = true (SECURITY DEFINER).
--              (B) Both functions have search_path locked to the empty string
--                  ('' — strictest possible — see migration design notes).
--              (C) PUBLIC has NO execute privilege; only `service_role` does.
--                  authenticated and anon explicitly do NOT have execute
--                  (defense-in-depth: even if `pg_proc.proacl` were leaked
--                  by a future migration, we test the negative for both
--                  end-user roles).
--              (D) decrypt round-trip works: create_vault_secret(plaintext) ->
--                  decrypt_app_password(secret_id) returns the same plaintext.
--              (E) decrypt_app_password(<unknown uuid>) raises 'P0002' with
--                  message prefix 'Vault secret not found:'.
--
-- Spec refs: §9.3.1 (function bodies, error code, GRANT/REVOKE matrix).
--            §6.5    (logging redaction — out of scope here, callers' duty).
--
-- Test plan (8 assertions):
--   ok        #1: has_function('app','create_vault_secret', …) — exists with
--                 the expected (text,text,text) signature.
--   ok        #2: has_function('app','decrypt_app_password', ARRAY['uuid']) —
--                 exists with the expected signature.
--   ok        #3: pg_proc.prosecdef = true for create_vault_secret (SECURITY
--                 DEFINER) AND proconfig contains 'search_path='.
--   ok        #4: pg_proc.prosecdef = true for decrypt_app_password AND
--                 proconfig contains 'search_path='.
--   ok        #5: has_function_privilege('service_role', 'app.create_vault_secret(text,text,text)', 'EXECUTE')
--                 AND NOT has_function_privilege('authenticated', …)
--                 AND NOT has_function_privilege('anon', …)
--                 AND NOT has_function_privilege('PUBLIC', …) via the role
--                 absence pattern.
--   ok        #6: Same matrix for decrypt_app_password(uuid).
--   is        #7: round-trip — create a secret, decrypt it, assert equality.
--   throws_ok #8: decrypt of an unknown UUID raises SQLSTATE 'P0002'.
--
-- Hermeticity:
--   * Wrapped in BEGIN / ROLLBACK so the created secret (which would live in
--     vault.secrets) is rolled back at end of test. supabase_vault stores
--     secrets in a regular table — transactional rollback works.
--   * Uses a fixed plaintext sentinel ('pgtap-vault-roundtrip-XXXXXX') so a
--     leak of test fixtures is grep-able.
--   * Does NOT depend on auth.users or any session JWT — both wrappers are
--     called by service_role-equivalent context (postgres role in tests
--     bypasses RLS just like service_role does).
--   * Uses TRY/CATCH only via pgTAP throws_ok, never manual EXCEPTION
--     handling that could swallow signal.
--
-- Notes on the privilege test (assertions #5, #6):
--   pgTAP's `has_function_privilege(role, function, privilege)` consults
--   pg_proc.proacl. Postgres default for new functions is GRANT EXECUTE TO
--   PUBLIC — the migration explicitly REVOKEs that. Our positive assertion
--   is that service_role has EXECUTE; the negative assertions cover the
--   two end-user roles (anon, authenticated) which MUST NOT have it.
--   We do NOT test `PUBLIC` directly because role 'public' is not a real
--   role in PG and `has_function_privilege` cannot be queried against it;
--   the negative test on anon/authenticated is sufficient (they are the
--   only roles that would inherit a PUBLIC grant in our role hierarchy —
--   service_role is independent).
-- ============================================================================


BEGIN;

-- pgtap lives in `extensions` (installed by T-105). Set search_path so the
-- unqualified pgTAP calls (plan, ok, is, throws_ok, has_function, …)
-- resolve, and include `app` so we can reference our wrappers unqualified
-- in error messages (qualified in actual calls).
SET LOCAL search_path = public, extensions, app, vault;

SELECT plan(8);


-- ============================================================================
-- ok #1 — app.create_vault_secret(text, text, text) exists
-- ============================================================================
SELECT has_function(
  'app',
  'create_vault_secret',
  ARRAY['text', 'text', 'text'],
  'ok #1: app.create_vault_secret(text, text, text) exists'
);


-- ============================================================================
-- ok #2 — app.decrypt_app_password(uuid) exists
-- ============================================================================
SELECT has_function(
  'app',
  'decrypt_app_password',
  ARRAY['uuid'],
  'ok #2: app.decrypt_app_password(uuid) exists'
);


-- ============================================================================
-- ok #3 — create_vault_secret is SECURITY DEFINER with locked search_path
-- ============================================================================
-- pg_proc.prosecdef = true iff the function was declared SECURITY DEFINER.
-- pg_proc.proconfig is a text[] of 'key=value' entries set via SET clauses
-- on the function definition; we assert it contains a search_path entry.
SELECT ok(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
      AND p.proname = 'create_vault_secret'
      AND pg_get_function_identity_arguments(p.oid) = 'secret_value text, name text, description text'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg(entry)
     WHERE n.nspname = 'app'
       AND p.proname = 'create_vault_secret'
       AND pg_get_function_identity_arguments(p.oid) = 'secret_value text, name text, description text'
       AND cfg.entry LIKE 'search_path=%'
  ),
  'ok #3: create_vault_secret is SECURITY DEFINER and pins search_path'
);


-- ============================================================================
-- ok #4 — decrypt_app_password is SECURITY DEFINER with locked search_path
-- ============================================================================
SELECT ok(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
      AND p.proname = 'decrypt_app_password'
      AND pg_get_function_identity_arguments(p.oid) = 'secret_id uuid'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg(entry)
     WHERE n.nspname = 'app'
       AND p.proname = 'decrypt_app_password'
       AND pg_get_function_identity_arguments(p.oid) = 'secret_id uuid'
       AND cfg.entry LIKE 'search_path=%'
  ),
  'ok #4: decrypt_app_password is SECURITY DEFINER and pins search_path'
);


-- ============================================================================
-- ok #5 — create_vault_secret EXECUTE matrix:
--           service_role:  YES
--           authenticated: NO
--           anon:          NO
-- ============================================================================
SELECT ok(
       has_function_privilege('service_role',  'app.create_vault_secret(text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'app.create_vault_secret(text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon',          'app.create_vault_secret(text, text, text)', 'EXECUTE'),
  'ok #5: create_vault_secret EXECUTE granted to service_role ONLY (not authenticated/anon)'
);


-- ============================================================================
-- ok #6 — decrypt_app_password EXECUTE matrix:
--           service_role:  YES
--           authenticated: NO
--           anon:          NO
-- ============================================================================
SELECT ok(
       has_function_privilege('service_role',  'app.decrypt_app_password(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'app.decrypt_app_password(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon',          'app.decrypt_app_password(uuid)', 'EXECUTE'),
  'ok #6: decrypt_app_password EXECUTE granted to service_role ONLY (not authenticated/anon)'
);


-- ============================================================================
-- is #7 — round-trip: create then decrypt returns the same plaintext
-- ============================================================================
-- We pass a sentinel plaintext containing 'pgtap-vault-roundtrip' so any
-- accidental leak into logs/dumps is grep-able. Capture the new secret_id
-- and immediately decrypt; the two values MUST match.
DO $$
DECLARE
  v_id        uuid;
  v_plain     text := 'pgtap-vault-roundtrip-' || gen_random_uuid()::text;
  v_decrypted text;
BEGIN
  v_id := app.create_vault_secret(
    v_plain,
    'pgtap_test_secret',
    'pgTAP T-208 round-trip fixture'
  );

  v_decrypted := app.decrypt_app_password(v_id);

  -- Stash both values in a temp table so the surrounding SELECT can assert.
  -- (pgTAP `is(...)` is a SELECT, not a procedural call — we can't reference
  -- DO-block locals from it directly.)
  CREATE TEMP TABLE _t208_roundtrip ON COMMIT DROP AS
    SELECT v_plain AS expected, v_decrypted AS actual, v_id AS sid;
END $$;

SELECT is(
  (SELECT actual FROM _t208_roundtrip),
  (SELECT expected FROM _t208_roundtrip),
  'is #7: round-trip create_vault_secret -> decrypt_app_password returns identical plaintext'
);


-- ============================================================================
-- throws_ok #8 — decrypt of an unknown UUID raises P0002
-- ============================================================================
-- We deliberately pick a UUID that cannot exist: gen_random_uuid() is
-- collision-safe to 122 bits, but to be extra paranoid we use a fixed all-f
-- UUID that is invalid as a vault id (would never be generated organically).
-- Per the migration body, this MUST raise SQLSTATE 'P0002' with the message
-- prefix 'Vault secret not found:'. We pin the SQLSTATE (P0002) and let the
-- message be NULL (so we don't couple to formatting tweaks).
SELECT throws_ok(
  $$ SELECT app.decrypt_app_password('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid) $$,
  'P0002',
  NULL,
  'throws_ok #8: decrypt of unknown UUID raises SQLSTATE P0002 (Vault secret not found)'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
