-- ============================================================================
-- Migration: 20260615120900_create_sys_admin_helpers.sql
-- Date:      2026-06-10
-- Task:      T-117
-- Purpose:   Add operational helpers that support the sys-admin bootstrap
--            workflow described in spec §9.2 and §11.5:
--              * app.assert_sys_admin_exists() — RAISES EXCEPTION when zero
--                users carry the `app_metadata.is_system_admin = true` claim.
--                Used by post-deploy verification (CI / runbook step) so the
--                project never lands in a "no admin" state silently.
--              * app.count_sys_admins() — small helper returning the current
--                count (used by the runbook + monitoring queries; keeps the
--                logic SQL-side and re-usable from Edge Functions).
-- Spec refs: §5.10 (sentinel actors / why we don't pollute `auth.users`),
--            §9.2  (JWT claim `is_system_admin` + bootstrap flow + audit),
--            §11.5 (Deploy inicial checklist — step 10 "Promover primeiro
--                   sys admin via SQL no Studio" is now replaced by the
--                   scripts/bootstrap_sys_admin.sh + runbook).
--
-- Design notes:
--   * The claim lives in `auth.users.raw_app_meta_data` as a JSONB key
--     (`is_system_admin`). The bootstrap script writes it via the GoTrue
--     admin API (PATCH /admin/users/:id with `{"app_metadata":{...}}`),
--     which is the only supported way to mutate it from outside the DB.
--   * `app.count_sys_admins()` is SECURITY DEFINER because `auth.users` is
--     not readable by `authenticated` — but we still want sys-admins (and
--     post-deploy verification scripts running as service_role) to be able
--     to call it cheaply. We DO NOT expose this to `anon`.
--   * `app.assert_sys_admin_exists()` is the asserting wrapper. It raises
--     a custom SQLSTATE `UB001` (Unibill bootstrap invariant) so callers
--     can pattern-match without parsing message text. The runbook documents
--     exactly when to expect / suppress this error.
--   * Filter `(raw_app_meta_data ->> 'is_system_admin') = 'true'` matches
--     the GoTrue serialization: the admin API stores booleans as JSON
--     booleans, but the `->>` operator always coerces to text — `true`
--     becomes the literal string 'true'. This matches the defensive read
--     done by `app.is_system_admin()` (helpers migration T-113).
--   * Idempotent: CREATE OR REPLACE FUNCTION + ON CONFLICT for metadata.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ----------------------------------------------------------------------------
--   * DO NOT modify `auth.users.raw_app_meta_data` from a migration. The
--     bootstrap is intentionally OUT-OF-BAND (scripts/bootstrap_sys_admin.sh)
--     so the first sys admin is tied to a real, existing GoTrue identity.
--   * DO NOT loosen the claim filter to `IS NOT NULL` — that would count any
--     user with the key present (including `false`) as a sys admin.
--   * DO NOT grant EXECUTE on these helpers to `anon` — bootstrap status is
--     not public information.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. app.count_sys_admins() — bigint
-- ============================================================================
-- Returns the number of `auth.users` whose `raw_app_meta_data ->>
-- 'is_system_admin'` equals the literal string 'true'. SECURITY DEFINER
-- because `auth.users` is not generally readable by `authenticated`.
CREATE OR REPLACE FUNCTION app.count_sys_admins()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::bigint
  FROM auth.users
  WHERE (raw_app_meta_data ->> 'is_system_admin') = 'true';
$$;

COMMENT ON FUNCTION app.count_sys_admins() IS
  'Conta os usuários com app_metadata.is_system_admin = "true" em auth.users. '
  'SECURITY DEFINER + search_path locked. Usado pela runbook de bootstrap '
  '(scripts/bootstrap_sys_admin.sh) e por verificações pós-deploy. Ver §9.2.';

REVOKE ALL ON FUNCTION app.count_sys_admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.count_sys_admins() TO authenticated, service_role;


-- ============================================================================
-- 2. app.assert_sys_admin_exists() — void
-- ============================================================================
-- Raises a custom EXCEPTION (SQLSTATE 'UB001') when no user currently holds
-- the `is_system_admin = true` claim. Designed to be called by:
--   * Post-deploy verification (`psql -c "SELECT app.assert_sys_admin_exists();"`)
--   * CI smoke tests against the dev project after seeding
--   * Runbook step in `docs/runbooks/bootstrap-sys-admin.md` (verify-after)
CREATE OR REPLACE FUNCTION app.assert_sys_admin_exists()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  admin_count bigint;
BEGIN
  SELECT app.count_sys_admins() INTO admin_count;

  IF admin_count = 0 THEN
    -- Custom SQLSTATE 'UB001' = Unibill bootstrap invariant violation.
    -- Callers (CI / runbook) can grep for this code to disambiguate from
    -- generic Postgres errors.
    RAISE EXCEPTION
      'Bootstrap invariant violated: zero users carry app_metadata.is_system_admin = true. '
      'Run scripts/bootstrap_sys_admin.sh --email <addr> against the target project '
      '(see docs/runbooks/bootstrap-sys-admin.md). Refs spec §9.2, §11.5.'
      USING ERRCODE = 'UB001';
  END IF;
END;
$$;

COMMENT ON FUNCTION app.assert_sys_admin_exists() IS
  'Raises EXCEPTION (SQLSTATE UB001) iff zero users têm a claim is_system_admin = true. '
  'Usado em smoke tests pós-deploy e na runbook de bootstrap. Ver §9.2 e §11.5.';

REVOKE ALL ON FUNCTION app.assert_sys_admin_exists() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_sys_admin_exists() TO authenticated, service_role;


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120900_create_sys_admin_helpers',
  'Sys-admin bootstrap helpers: app.count_sys_admins() + '
  'app.assert_sys_admin_exists() (SQLSTATE UB001). Suporta '
  'scripts/bootstrap_sys_admin.sh e checks pós-deploy. Ver §9.2 / §11.5.'
)
ON CONFLICT (migration_name) DO NOTHING;
