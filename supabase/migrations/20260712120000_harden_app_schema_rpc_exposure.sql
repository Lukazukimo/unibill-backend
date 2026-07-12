-- ============================================================================
-- Migration: 20260712120000_harden_app_schema_rpc_exposure.sql
-- Date:      2026-07-12
-- Task:      T-639 (retro) — surfaced by get_advisors after the deploy pipeline
--            (T-638) ran `config push`.
-- Purpose:   The pipeline's `config push` applied config.toml's
--            `[api] schemas = ["public", "app"]`, exposing the `app` schema via
--            PostgREST on the hosted project. The `app` schema MUST stay exposed
--            (Edge Functions call app.* helpers — rate_limit_consume,
--            seed_household_categories, circuit_*, queue_*, ingest_invoice, … —
--            via service_role `.rpc()` with no schema qualifier), so we cannot
--            un-expose it. Instead, revoke EXECUTE from anon/authenticated on the
--            three helpers that had it unnecessarily and are NOT meant for direct
--            authenticated calls:
--              * app.count_sys_admins(), app.assert_sys_admin_exists() — NOT
--                self-gated; internal/bootstrap helpers called by other
--                SECURITY DEFINER functions (as owner) and by service_role. The
--                anon/authenticated EXECUTE was an over-grant.
--              * app.audit_app_settings() — a trigger function (fires regardless
--                of any caller's EXECUTE privilege), reachable by anon only via
--                the default PUBLIC grant.
--            service_role KEEPS EXECUTE on the two sys-admin helpers.
-- Spec refs: §9.2 (sys-admin surface), §5.11 (RLS helper posture), §B (config).
--
-- Note:      DELIBERATELY NOT touched (their `authenticated` EXECUTE is correct):
--              * app.list_system_admins() — SELF-GATED (raises `system_admin
--                required` / 42501 unless the caller is a sys admin), so direct
--                authenticated calls are safe by design and are verified by
--                supabase/tests/pgtap/system_admin_management.test.sql.
--              * app.is_household_admin / households_of_user /
--                is_owner_of_connected_email / is_admin_of_connected_email —
--                dozens of RLS policies call them, so `authenticated` MUST keep
--                EXECUTE or RLS breaks. Their /rpc exposure returns only the
--                caller's own status (accepted advisor WARN).
--            Un-exposing `app` from the API would break the Edge Functions'
--            service_role rpc calls, so it is not an option.
--
-- Rollback:
--   GRANT EXECUTE ON FUNCTION app.count_sys_admins()        TO authenticated;
--   GRANT EXECUTE ON FUNCTION app.assert_sys_admin_exists() TO authenticated;
--   GRANT EXECUTE ON FUNCTION app.audit_app_settings()      TO PUBLIC;
-- ============================================================================

REVOKE EXECUTE ON FUNCTION app.count_sys_admins()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.assert_sys_admin_exists() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.audit_app_settings()      FROM PUBLIC, anon, authenticated;

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260712120000_harden_app_schema_rpc_exposure',
  'Revoke EXECUTE from anon/authenticated on 3 app SECURITY DEFINER helpers '
  '(count_sys_admins, assert_sys_admin_exists, audit_app_settings) that became '
  '/rest/v1/rpc-callable once config push exposed the app schema (T-638). '
  'service_role keeps EXECUTE on the sys-admin helpers. list_system_admins is '
  'left (self-gated) and the RLS helpers stay authenticated-executable (RLS '
  'depends on them). Surfaced by the security advisor after the first pipeline '
  'deploy.'
)
ON CONFLICT (migration_name) DO NOTHING;
