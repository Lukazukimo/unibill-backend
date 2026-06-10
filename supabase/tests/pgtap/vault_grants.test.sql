-- ============================================================================
-- Test:      supabase/tests/pgtap/vault_grants.test.sql
-- Date:      2026-06-10
-- Task:      T-209
-- Purpose:   pgTAP test suite for the defense-in-depth GRANT/REVOKE matrix
--            installed by migration 20260616120200_vault_grants.sql.
--
--            We assert four invariants from spec §9.3.1:
--
--              (A) `authenticated` and `anon` cannot SELECT
--                  vault.decrypted_secrets — must fail with
--                  SQLSTATE 42501 (insufficient_privilege).
--              (B) `authenticated` and `anon` cannot EXECUTE
--                  vault.create_secret directly — must fail with 42501.
--              (C) `authenticated` and `anon` do not have USAGE on
--                  schema vault.
--              (D) `service_role` retains USAGE on schema vault, plus
--                  EXECUTE on vault.create_secret and SELECT on
--                  vault.decrypted_secrets (so workers / rotation paths
--                  keep working via the SECURITY DEFINER wrappers'
--                  underlying calls).
--
-- Spec refs: §9.3.1 ("GRANT/REVOKE matrix (defesa em profundidade)") —
--                   the verbatim REVOKE ALL ON ALL TABLES + ALL FUNCTIONS
--                   IN SCHEMA vault FROM anon, authenticated; and explicit
--                   GRANT USAGE ON SCHEMA vault TO service_role.
--            §9.3   (overall vault threat model — end-user JS = zero direct
--                   access; everything via SECURITY DEFINER wrappers).
--
-- Test plan (10 assertions):
--   ok        #1: has_schema_privilege('authenticated', 'vault', 'USAGE') = false
--   ok        #2: has_schema_privilege('anon',          'vault', 'USAGE') = false
--   ok        #3: has_schema_privilege('service_role',  'vault', 'USAGE') = true
--   ok        #4: has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') = false
--   ok        #5: has_table_privilege('anon',          'vault.decrypted_secrets', 'SELECT') = false
--   ok        #6: has_function_privilege('authenticated', 'vault.create_secret(text,text,text,uuid)', 'EXECUTE') = false
--   ok        #7: has_function_privilege('anon',          'vault.create_secret(text,text,text,uuid)', 'EXECUTE') = false
--   throws_ok #8: as authenticated, SELECT vault.decrypted_secrets RAISES 42501
--   throws_ok #9: as authenticated, EXECUTE vault.create_secret(…) RAISES 42501
--   ok       #10: as service_role, SELECT count(*) FROM vault.decrypted_secrets succeeds
--                 (round-trip proves the GRANT still allows access — we capture
--                  the count in a TEMP table and assert ok if no error fired).
--
-- Hermeticity:
--   * Wrapped in BEGIN / ROLLBACK so any role-switch side-effects (RESET ROLE
--     at the end) and any temp-table state vanish.
--   * Uses SET LOCAL ROLE / RESET ROLE inside DO blocks to switch identity
--     for the throws_ok checks. SET LOCAL is reverted at end-of-transaction
--     automatically by ROLLBACK, but we RESET ROLE explicitly after each
--     impersonation to keep the rest of the script under the original
--     privileged role.
--   * We do NOT insert anything into vault.secrets — the privilege
--     assertions are introspective (pg_catalog) and the throws_ok cases
--     fail before any side-effect lands.
--
-- Notes on the resolved function signature for vault.create_secret:
--   The supabase_vault extension declares:
--     vault.create_secret(new_secret text,
--                         new_name text DEFAULT NULL,
--                         new_description text DEFAULT '',
--                         new_key_id uuid DEFAULT NULL) RETURNS uuid
--   has_function_privilege() needs the canonical identity-arguments string.
--   We use 'vault.create_secret(text, text, text, uuid)' which matches the
--   full 4-arg signature. (Postgres stores the function under its full
--   signature; default values do not produce extra catalog rows.)
-- ============================================================================


BEGIN;

-- pgtap lives in `extensions` (installed by T-105). Include `vault` in the
-- search_path so the unqualified table reference in throws_ok #8 resolves
-- to vault.decrypted_secrets when executed inside the impersonated role.
-- (Actually we always fully qualify in the test bodies; this is belt-and-
-- braces for the surrounding catalog queries.)
SET LOCAL search_path = public, extensions, app, vault;

SELECT plan(10);


-- ============================================================================
-- ok #1 — authenticated has NO USAGE on schema vault
-- ============================================================================
SELECT ok(
  NOT has_schema_privilege('authenticated', 'vault', 'USAGE'),
  'ok #1: authenticated does NOT have USAGE on schema vault'
);


-- ============================================================================
-- ok #2 — anon has NO USAGE on schema vault
-- ============================================================================
SELECT ok(
  NOT has_schema_privilege('anon', 'vault', 'USAGE'),
  'ok #2: anon does NOT have USAGE on schema vault'
);


-- ============================================================================
-- ok #3 — service_role retains USAGE on schema vault
-- ============================================================================
-- The explicit GRANT in the migration ensures this even if a future
-- platform reset stripped the Supabase default.
SELECT ok(
  has_schema_privilege('service_role', 'vault', 'USAGE'),
  'ok #3: service_role retains USAGE on schema vault'
);


-- ============================================================================
-- ok #4 — authenticated cannot SELECT vault.decrypted_secrets (privilege bit)
-- ============================================================================
-- has_table_privilege checks the per-relation ACL. We REVOKEd ALL on ALL
-- TABLES IN SCHEMA vault from authenticated, so SELECT must be false.
SELECT ok(
  NOT has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT'),
  'ok #4: authenticated has NO SELECT on vault.decrypted_secrets'
);


-- ============================================================================
-- ok #5 — anon cannot SELECT vault.decrypted_secrets (privilege bit)
-- ============================================================================
SELECT ok(
  NOT has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT'),
  'ok #5: anon has NO SELECT on vault.decrypted_secrets'
);


-- ============================================================================
-- ok #6 — authenticated cannot EXECUTE vault.create_secret (privilege bit)
-- ============================================================================
-- Full 4-arg signature per supabase_vault extension declaration.
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'vault.create_secret(text, text, text, uuid)',
    'EXECUTE'
  ),
  'ok #6: authenticated has NO EXECUTE on vault.create_secret(text,text,text,uuid)'
);


-- ============================================================================
-- ok #7 — anon cannot EXECUTE vault.create_secret (privilege bit)
-- ============================================================================
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'vault.create_secret(text, text, text, uuid)',
    'EXECUTE'
  ),
  'ok #7: anon has NO EXECUTE on vault.create_secret(text,text,text,uuid)'
);


-- ============================================================================
-- throws_ok #8 — actual runtime check: authenticated session, SELECT vault.*
--                must RAISE SQLSTATE 42501 (insufficient_privilege)
-- ============================================================================
-- The privilege bit checks above (ok #4-#7) test the ACL; this one proves
-- the ACL is *actually enforced* at runtime by switching to the
-- authenticated role via SET LOCAL ROLE and attempting the SELECT. Postgres
-- raises ERROR 42501 'permission denied for schema vault' (or 'for relation
-- decrypted_secrets' depending on which check trips first) — either way
-- SQLSTATE is 42501.
--
-- The throws_ok body runs the query in the SAME session, so SET LOCAL ROLE
-- is in effect; pgTAP wraps the query in a savepoint internally for error
-- capture. After throws_ok returns, the role is still 'authenticated' until
-- we RESET ROLE explicitly below.
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT id, decrypted_secret FROM vault.decrypted_secrets LIMIT 1 $$,
  '42501',
  NULL,
  'throws_ok #8: authenticated SELECT vault.decrypted_secrets raises 42501 (insufficient_privilege)'
);


-- ============================================================================
-- throws_ok #9 — actual runtime check: authenticated session, EXECUTE
--                vault.create_secret(…) must RAISE 42501.
-- ============================================================================
-- Still under SET LOCAL ROLE authenticated from the previous step. We
-- attempt the call with a dummy plaintext; even if the EXECUTE privilege
-- check succeeded somehow, the function body would need USAGE on schema
-- vault (which is also revoked). Either failure mode yields SQLSTATE 42501.
SELECT throws_ok(
  $$ SELECT vault.create_secret(
       'pgtap-vault-grants-must-not-create',
       'pgtap_test_unreachable',
       'should be rejected before any side-effect'
     ) $$,
  '42501',
  NULL,
  'throws_ok #9: authenticated EXECUTE vault.create_secret raises 42501 (insufficient_privilege)'
);

-- Reset role for the service_role positive check. ROLLBACK at end would
-- restore it automatically but we want subsequent assertions to run under
-- the original test role explicitly.
RESET ROLE;


-- ============================================================================
-- ok #10 — service_role retains runtime access to vault.decrypted_secrets
-- ============================================================================
-- Positive control: confirm that the GRANT-side of the matrix actually
-- works. We switch to service_role, run a harmless SELECT count(*) FROM
-- vault.decrypted_secrets (returns 0 in a fresh DB, but the important
-- thing is the call does NOT raise). We capture success in a TEMP table
-- and assert via a single ok() that the row landed.
--
-- We wrap the SELECT in a DO block with an EXCEPTION handler that records
-- failure, so pgTAP can report it cleanly instead of aborting the suite.
DO $$
DECLARE
  v_count bigint;
  v_error text := NULL;
BEGIN
  SET LOCAL ROLE service_role;

  BEGIN
    SELECT count(*) INTO v_count FROM vault.decrypted_secrets;
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLSTATE || ': ' || SQLERRM;
    v_count := -1;
  END;

  RESET ROLE;

  CREATE TEMP TABLE _t209_service_role_check ON COMMIT DROP AS
    SELECT v_count AS row_count, v_error AS err;
END $$;

SELECT ok(
  (SELECT err IS NULL AND row_count >= 0 FROM _t209_service_role_check),
  'ok #10: service_role can SELECT count(*) FROM vault.decrypted_secrets without error'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
