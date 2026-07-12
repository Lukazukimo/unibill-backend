-- ============================================================================
-- Migration: 20260711130000_harden_service_role_rls.sql
-- Date:      2026-07-11
-- Task:      T-637 (retro) — security hardening surfaced by the Supabase
--            security advisor during cloud provisioning (#1).
-- Purpose:   Close a real data-exposure / tamper hole. Eight "service-role-only"
--            tables were created in the `public` schema WITHOUT RLS. On hosted
--            Supabase, default privileges grant anon + authenticated full CRUD
--            on every public table, so the public anon key (shipped in the
--            mobile app) could reach them directly via PostgREST. Concretely,
--            with the anon key an attacker could:
--              * read client_telemetry session ids (PII);
--              * zero out / delete rate_limit_buckets (defeat brute-force
--                protection on auth + invitation redeem);
--              * flip circuit_breakers (DoS or hammer a failing provider);
--              * read / pollute the health, capacity, eviction, pdf-archive
--                ops tables.
--            Enabling RLS closes it: service_role has BYPASSRLS, so every worker
--            and admin-read Edge Function (all query via SUPABASE_SERVICE_ROLE_KEY)
--            is unaffected, while anon/authenticated get zero access (RLS on +
--            no policy = deny).
--
--            Also hardens two function findings from the same advisor:
--              * public.create_user_profile() is SECURITY DEFINER and was
--                EXECUTE-able by anon/authenticated via /rest/v1/rpc. It is a
--                signup TRIGGER on auth.users, never an RPC — REVOKE EXECUTE.
--                (The trigger still fires; trigger execution does not consult
--                the caller's EXECUTE privilege.)
--              * 4 helpers had a role-mutable search_path (injection surface).
--                Pin them to '' — every ref in their bodies is already
--                schema-qualified (public.members, auth.jwt()) or a pg_catalog
--                built-in (now(), lower(), count()).
--
-- Spec refs: §5.8 (rate-limit / circuit tables are service-role-only),
--            §5.6 / §5.7 (telemetry / health / capacity observability tables),
--            §9.1 (anti-abuse: rate-limit integrity), §5.11 (RLS posture).
--
-- Note:      The `app` schema is ALSO exposed via PostgREST (config.toml
--            `schemas = ["public", "app"]`), so the two RLS-off tables there —
--            app.migration_metadata and app.invoice_category_templates — are
--            reachable in principle too. Today the only thing blocking
--            anon/authenticated is the absence of table grants in `app`
--            (Supabase default privileges only grant on `public`), but that is a
--            single fragile control. For parity with the public tables and to
--            satisfy the advisor's "RLS off in an exposed schema" rule, this
--            migration enables RLS on them as well. Their only readers are
--            migrations (run as the superuser) and app.seed_household_categories()
--            (SECURITY DEFINER, service_role) — both bypass RLS, so nothing breaks.
--
-- Rollback:
--   ALTER TABLE public.circuit_breakers        DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.rate_limit_buckets      DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.capacity_snapshots      DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.pdf_archive_log         DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.eviction_runs           DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.health_snapshots        DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.health_snapshots_hourly DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.client_telemetry        DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE app.migration_metadata         DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE app.invoice_category_templates DISABLE ROW LEVEL SECURITY;
--   GRANT EXECUTE ON FUNCTION public.create_user_profile() TO anon, authenticated;
--   ALTER FUNCTION app.set_updated_at()                RESET search_path;
--   ALTER FUNCTION app.is_system_admin()               RESET search_path;
--   ALTER FUNCTION public.enforce_min_one_admin()      RESET search_path;
--   ALTER FUNCTION public.normalize_invitation_email() RESET search_path;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enable RLS on the 10 RLS-off tables in PostgREST-exposed schemas (8 in
--    `public`, 2 in `app`). No policies are added on purpose: service_role
--    (BYPASSRLS) keeps full access; every other role is denied. Existing grants
--    stay but are now gated by RLS.
-- ----------------------------------------------------------------------------
ALTER TABLE public.circuit_breakers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_buckets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdf_archive_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eviction_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_snapshots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_snapshots_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_telemetry        ENABLE ROW LEVEL SECURITY;

-- The two RLS-off tables in the (also PostgREST-exposed) `app` schema, for
-- parity. Readers bypass RLS: migrations run as the superuser; the only runtime
-- reader of the templates is app.seed_household_categories() (SECURITY DEFINER,
-- service_role). This migration's own trailing INSERT into app.migration_metadata
-- also runs as the superuser, so it is unaffected by the RLS we enable here.
ALTER TABLE app.migration_metadata         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invoice_category_templates ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 2. create_user_profile() is a trigger on auth.users, not an RPC — revoke the
--    default EXECUTE so it cannot be called as anon/authenticated via
--    /rest/v1/rpc/create_user_profile.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.create_user_profile()
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Pin a stable search_path on the 4 helpers the advisor flagged as mutable.
-- ----------------------------------------------------------------------------
ALTER FUNCTION app.set_updated_at()                SET search_path = '';
ALTER FUNCTION app.is_system_admin()               SET search_path = '';
ALTER FUNCTION public.enforce_min_one_admin()      SET search_path = '';
ALTER FUNCTION public.normalize_invitation_email() SET search_path = '';

-- ----------------------------------------------------------------------------
-- 4. Record this migration.
-- ----------------------------------------------------------------------------
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260711130000_harden_service_role_rls',
  'Enable RLS on 10 RLS-off tables in PostgREST-exposed schemas: 8 public '
  '(circuit_breakers, rate_limit_buckets, capacity_snapshots, pdf_archive_log, '
  'eviction_runs, health_snapshots, health_snapshots_hourly, client_telemetry) '
  'exposed to anon/authenticated via PostgREST default grants on hosted Supabase, '
  'plus 2 app (migration_metadata, invoice_category_templates) for parity since '
  'the app schema is also PostgREST-exposed. Revoke EXECUTE on the '
  'create_user_profile trigger function from anon/authenticated; pin search_path '
  'on set_updated_at / is_system_admin / enforce_min_one_admin / '
  'normalize_invitation_email. Surfaced by the security advisor during #1 '
  'provisioning.'
)
ON CONFLICT (migration_name) DO NOTHING;
