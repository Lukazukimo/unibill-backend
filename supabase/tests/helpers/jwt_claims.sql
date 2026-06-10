-- ============================================================================
-- Helper:    supabase/tests/helpers/jwt_claims.sql
-- Date:      2026-06-10
-- Task:      T-116
-- Purpose:   pgTAP test-suite helper that fabricates a Supabase-style JWT
--            claims payload inside the current transaction so the RLS helpers
--            in schema `app` (`app.households_of_user`, `app.is_household_admin`,
--            `app.is_system_admin`) see the caller as a specific
--            `auth.users.id` with the right `app_metadata.is_system_admin`
--            flag, and so the built-in `auth.uid()` / `auth.jwt()` Supabase
--            functions return that identity.
--
-- Spec refs: §5.11 (RLS helpers + Patterns A-F live in schema `app`; sys-admin
--                   bypass via JWT `app_metadata.is_system_admin` claim).
--            §5.12 (user_profiles cross-household SELECT depends on the
--                   authenticated identity surfaced via auth.uid()).
--
-- Design notes:
--   * The supabase-cli + GoTrue stack source identity from the
--     `request.jwt.claims` GUC. Setting that GUC to a JSON object with at
--     least `{"sub": "<uuid>", "role": "authenticated", "app_metadata":
--     {"is_system_admin": "true"|"false"}}` is sufficient for both the
--     stock `auth.uid()` / `auth.jwt()` helpers and `app.is_system_admin()`
--     to behave as if the caller were a real signed-in user / sys admin.
--   * The companion `role` GUC is what controls which Postgres role evaluates
--     the policy (`authenticated` vs `service_role` vs `anon`). Calling
--     `SET LOCAL role = '<role>'` flips Postgres into that role's permission
--     set; pairing it with the claims GUC produces a deterministic test
--     fixture identical to what an HTTP request through PostgREST would
--     produce.
--   * Everything uses `SET LOCAL` so the side effects are scoped to the
--     enclosing transaction — combined with the test file's BEGIN/ROLLBACK
--     pattern there is no cross-test leakage and no need for an explicit
--     `reset_jwt_claims` (just `RESET ROLE` / `RESET request.jwt.claims` at
--     the end of a scenario; a convenience wrapper is provided below).
--   * `app.is_system_admin()` casts the claim via `NULLIF(... , '')::boolean`,
--     so we serialize the flag as the strings `'true'` / `'false'` to match
--     exactly what Supabase GoTrue writes to JWT app_metadata at bootstrap
--     (T-117). Passing the literal `false` here would round-trip to the
--     string `'false'` via `to_jsonb`, which is fine — Postgres parses
--     `'false'::boolean` correctly.
--   * The household_id parameter is intentionally a marker for the *intended*
--     scope of the impersonation (so test diagnostics can show "user A acting
--     in household X"). It is NOT injected into the JWT — RLS helpers derive
--     household membership by SELECTing `public.members WHERE user_id =
--     auth.uid()`, not by reading any JWT claim. Tests should still pre-seed
--     the members table accordingly.
--   * Compatible with both the standalone `psql` runner (via
--     `\i tests/helpers/jwt_claims.sql`) and `supabase test db` (which
--     concatenates files before executing).
--
-- Usage:
--   BEGIN;
--   \i tests/helpers/jwt_claims.sql       -- once per test file, near the top
--   SELECT app.set_jwt_claims('<user_uuid>'::uuid, NULL, false);
--   -- ... assertions ...
--   SELECT app.reset_jwt_claims();
--   SELECT app.set_jwt_claims('<other_uuid>'::uuid, NULL, true);
--   -- ... more assertions ...
--   ROLLBACK;
--
-- Forbidden patterns:
--   * DO NOT install these helpers via a migration — they exist purely for
--     test fixtures and must never be reachable in production. They live in
--     `app` because the tests already SET search_path = public, extensions,
--     app; creating them in `pg_temp` would force every caller to re-qualify.
--   * DO NOT call `SET` (without LOCAL) — that leaks GUCs to the connection
--     and breaks hermeticity across test files when supabase-cli reuses a
--     connection.
--   * DO NOT inject household_id into the JWT body — RLS reads memberships
--     from `public.members`, not from claims (spec §5.11).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. app.set_jwt_claims(user_id uuid, household_id uuid, is_sys_admin boolean)
-- ----------------------------------------------------------------------------
-- Sets the current transaction's `request.jwt.claims` GUC and switches the
-- Postgres role to `authenticated`. The `household_id` parameter is reserved
-- for test diagnostics (and may be threaded into a future claim if a custom
-- RLS helper ever reads it); it is NOT injected into the JWT body today.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_jwt_claims(
  user_id      uuid,
  household_id uuid    DEFAULT NULL,
  is_sys_admin boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  claims jsonb;
BEGIN
  -- Build the JWT body. `sub` is what `auth.uid()` returns (it parses the
  -- claim and casts to uuid). `app_metadata.is_system_admin` is the string
  -- 'true'/'false' to match GoTrue's exact serialization (the helper
  -- `app.is_system_admin()` does `NULLIF(... , '')::boolean`).
  claims := jsonb_build_object(
    'sub',  user_id::text,
    'role', 'authenticated',
    'aud',  'authenticated',
    'app_metadata', jsonb_build_object(
      'is_system_admin',
      CASE WHEN is_sys_admin THEN 'true' ELSE 'false' END
    ),
    -- Carry the household_id as a diagnostic-only claim so failing assertions
    -- can print "user X acting in household Y" if surfaced via auth.jwt().
    'test_household_id', coalesce(household_id::text, '')
  );

  PERFORM set_config('request.jwt.claims', claims::text, true);  -- true = LOCAL
  PERFORM set_config('role', 'authenticated', true);             -- evaluate as authenticated
  -- ROLE must also be switched at the SQL level so the planner respects the
  -- new identity for the remainder of the transaction. set_config does the
  -- GUC; the explicit SET LOCAL ROLE below activates it on the session.
  EXECUTE format('SET LOCAL ROLE %I', 'authenticated');
END;
$$;

COMMENT ON FUNCTION app.set_jwt_claims(uuid, uuid, boolean) IS
  'Test fixture (T-116): impersonate a Supabase-authenticated caller in the '
  'current transaction. Sets request.jwt.claims (sub, role, aud, '
  'app_metadata.is_system_admin) and switches the SQL role to authenticated. '
  'household_id is a diagnostic-only claim; RLS reads memberships from '
  'public.members. Always wrap test scenarios in BEGIN/ROLLBACK.';


-- ----------------------------------------------------------------------------
-- 2. app.set_jwt_anon() — exercise the anon-caller code path
-- ----------------------------------------------------------------------------
-- Many cross-tenant assertions require proving that an unauthenticated caller
-- sees zero rows. This helper switches to role `anon` and clears any sub
-- claim (so `auth.uid()` returns NULL, which RLS policies match against
-- nothing).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_jwt_anon()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'anon', 'aud', 'authenticated')::text,
    true
  );
  PERFORM set_config('role', 'anon', true);
  EXECUTE 'SET LOCAL ROLE anon';
END;
$$;

COMMENT ON FUNCTION app.set_jwt_anon() IS
  'Test fixture (T-116): impersonate an anonymous caller (role=anon, '
  'no sub claim). Used to prove SELECT-from-anon returns zero rows on every '
  'P0 table.';


-- ----------------------------------------------------------------------------
-- 3. app.reset_jwt_claims() — drop the GUC + return to the default role
-- ----------------------------------------------------------------------------
-- BEGIN/ROLLBACK wraps the whole test so this is technically optional, but
-- explicitly resetting between scenarios makes failure output far more
-- readable (no risk of one scenario's identity bleeding into another's
-- assertion message before ROLLBACK fires).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reset_jwt_claims()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('role', 'postgres', true);
  EXECUTE 'RESET ROLE';
END;
$$;

COMMENT ON FUNCTION app.reset_jwt_claims() IS
  'Test fixture (T-116): clear request.jwt.claims and return to the default '
  'role (postgres). Always called between scenarios for readable diagnostics; '
  'BEGIN/ROLLBACK is the actual hermeticity boundary.';
