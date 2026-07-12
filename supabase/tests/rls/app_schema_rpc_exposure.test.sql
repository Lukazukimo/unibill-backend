-- ============================================================================
-- Test:      supabase/tests/rls/app_schema_rpc_exposure.test.sql
-- Date:      2026-07-12
-- Task:      T-639 (retro) — surfaced by get_advisors after the deploy pipeline
--            (T-638) ran `config push`, which applied config.toml's
--            `[api] schemas = ["public", "app"]` and exposed the `app` schema
--            via PostgREST on the hosted project.
-- Purpose:   The `app` schema MUST stay PostgREST-exposed (Edge Functions call
--            app.* helpers via service_role `.rpc()` without a schema qualifier),
--            so we cannot un-expose it. Instead, lock down the three helpers that
--            had EXECUTE for anon/authenticated unnecessarily:
--              * app.count_sys_admins(), app.assert_sys_admin_exists() — NOT
--                self-gated internal/bootstrap helpers (over-grant);
--              * app.audit_app_settings() — a trigger function.
--            service_role keeps EXECUTE on the two sys-admin helpers.
--            DELIBERATELY LEFT authenticated-executable (asserted here as a
--            regression guard): app.list_system_admins() is SELF-GATED (raises
--            unless the caller is a sys admin) and the RLS helpers
--            (is_household_admin, households_of_user, is_owner/admin_of_connected_email)
--            back dozens of RLS policies — revoking either would break a designed
--            path or RLS itself.
--
-- Hermeticity: pure grant-metadata assertions (has_function_privilege), no role
--            switching or seeding needed. BEGIN/ROLLBACK for consistency.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(13);

-- ----------------------------------------------------------------------------
-- 1. The three locked-down helpers are NOT executable by anon or authenticated.
-- ----------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'app.count_sys_admins()', 'EXECUTE'),
          'anon cannot EXECUTE app.count_sys_admins()');
SELECT ok(NOT has_function_privilege('authenticated', 'app.count_sys_admins()', 'EXECUTE'),
          'authenticated cannot EXECUTE app.count_sys_admins()');
SELECT ok(NOT has_function_privilege('anon', 'app.assert_sys_admin_exists()', 'EXECUTE'),
          'anon cannot EXECUTE app.assert_sys_admin_exists()');
SELECT ok(NOT has_function_privilege('authenticated', 'app.assert_sys_admin_exists()', 'EXECUTE'),
          'authenticated cannot EXECUTE app.assert_sys_admin_exists()');
SELECT ok(NOT has_function_privilege('anon', 'app.audit_app_settings()', 'EXECUTE'),
          'anon cannot EXECUTE the app.audit_app_settings trigger function');
SELECT ok(NOT has_function_privilege('authenticated', 'app.audit_app_settings()', 'EXECUTE'),
          'authenticated cannot EXECUTE the app.audit_app_settings trigger function');

-- ----------------------------------------------------------------------------
-- 2. service_role KEEPS EXECUTE on the sys-admin helpers (the admin-system-admins
--    Edge Function calls them via service_role .rpc()).
-- ----------------------------------------------------------------------------
SELECT ok(has_function_privilege('service_role', 'app.count_sys_admins()', 'EXECUTE'),
          'service_role can still EXECUTE app.count_sys_admins()');
SELECT ok(has_function_privilege('service_role', 'app.assert_sys_admin_exists()', 'EXECUTE'),
          'service_role can still EXECUTE app.assert_sys_admin_exists()');

-- ----------------------------------------------------------------------------
-- 3. Regression guard: the SELF-GATED sys-admin listing + the RLS helpers STAY
--    executable by authenticated (revoking would break a designed path / RLS).
-- ----------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'app.list_system_admins()', 'EXECUTE'),
          'authenticated STILL executes app.list_system_admins() (self-gated, deliberate)');
SELECT ok(has_function_privilege('authenticated', 'app.is_household_admin(uuid)', 'EXECUTE'),
          'authenticated STILL executes app.is_household_admin(uuid) (RLS depends on it)');
SELECT ok(has_function_privilege('authenticated', 'app.households_of_user()', 'EXECUTE'),
          'authenticated STILL executes app.households_of_user() (RLS depends on it)');
SELECT ok(has_function_privilege('authenticated', 'app.is_owner_of_connected_email(uuid)', 'EXECUTE'),
          'authenticated STILL executes app.is_owner_of_connected_email(uuid) (RLS)');
SELECT ok(has_function_privilege('authenticated', 'app.is_admin_of_connected_email(uuid)', 'EXECUTE'),
          'authenticated STILL executes app.is_admin_of_connected_email(uuid) (RLS)');

SELECT finish();
ROLLBACK;
