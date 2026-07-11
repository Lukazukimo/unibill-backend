-- ============================================================================
-- Test:      supabase/tests/rls/service_role_tables_hardening.test.sql
-- Date:      2026-07-11
-- Task:      T-637 (retro) — security hardening surfaced by the Supabase
--            advisor during cloud provisioning (#1).
-- Purpose:   Lock the invariant that the 10 RLS-off tables in the
--            PostgREST-exposed `public` (8) and `app` (2) schemas are NOT
--            reachable by the anon/authenticated roles. They were created
--            without RLS; on hosted Supabase, the public-schema default grants
--            hand anon+authenticated full CRUD on every public table, so before
--            the hardening migration the public anon key (shipped in the mobile
--            app) could read client_telemetry PII, zero-out rate_limit_buckets,
--            flip circuit_breakers, etc. via PostgREST. Enabling RLS (no policy)
--            closes it: service_role has BYPASSRLS, everyone else is denied.
--
--            Also asserts two function-hardening findings from the same advisor:
--              * public.create_user_profile() (a signup TRIGGER, never an RPC)
--                is NOT EXECUTE-able by anon/authenticated;
--              * the 4 helpers flagged for a mutable search_path now pin one.
--
-- Hermeticity: BEGIN/ROLLBACK. Seed as service_role (BYPASSRLS), then assert
--            the deny paths as anon and authenticated via the jwt_claims
--            helpers. search_path is locked to public, extensions, app so the
--            unqualified pgTAP + helper symbols resolve.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.psql

SELECT plan(19);

-- ----------------------------------------------------------------------------
-- 1. RLS is enabled on all 10 RLS-off tables in the PostgREST-exposed schemas
--    (8 public + 2 app) — the core invariant: RLS on + no policy denies every
--    non-BYPASSRLS role.
-- ----------------------------------------------------------------------------
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.circuit_breakers'::regclass),
          'circuit_breakers has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rate_limit_buckets'::regclass),
          'rate_limit_buckets has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.capacity_snapshots'::regclass),
          'capacity_snapshots has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pdf_archive_log'::regclass),
          'pdf_archive_log has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.eviction_runs'::regclass),
          'eviction_runs has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.health_snapshots'::regclass),
          'health_snapshots has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.health_snapshots_hourly'::regclass),
          'health_snapshots_hourly has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.client_telemetry'::regclass),
          'client_telemetry has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'app.migration_metadata'::regclass),
          'app.migration_metadata has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'app.invoice_category_templates'::regclass),
          'app.invoice_category_templates has RLS enabled');

-- ----------------------------------------------------------------------------
-- 2. Behavioral proof on rate_limit_buckets (tamper target). The mechanism is
--    uniform across all 8 (RLS on + no policy), so one table exercises it end
--    to end. service_role (BYPASSRLS) seeds + sees the row; anon/authenticated
--    see zero rows and cannot INSERT.
-- ----------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$ INSERT INTO public.rate_limit_buckets
       (resource_type, resource_key, window_start, window_size, count)
     VALUES ('seed', 'k-seed', now(), interval '1 minute', 1) $$,
  'service_role can write rate_limit_buckets (BYPASSRLS)'
);
SELECT is(
  (SELECT count(*)::int FROM public.rate_limit_buckets),
  1,
  'service_role sees the seeded rate_limit_buckets row'
);
RESET ROLE;

-- The local CLI stack does NOT auto-grant anon/authenticated on public tables,
-- but hosted Supabase DOES — that ambient grant is exactly what exposed these
-- tables. Grant the privileges here so the ONLY gate under test is RLS itself,
-- proving RLS denies even under the permissive hosted grant posture.
GRANT SELECT, INSERT ON public.rate_limit_buckets TO anon, authenticated;

SELECT app.set_jwt_anon();
SELECT is(
  (SELECT count(*)::int FROM public.rate_limit_buckets),
  0,
  'anon sees zero rows in rate_limit_buckets (RLS filters the seeded row)'
);
SELECT throws_ok(
  $$ INSERT INTO public.rate_limit_buckets
       (resource_type, resource_key, window_start, window_size, count)
     VALUES ('anon', 'k-anon', now(), interval '1 minute', 1) $$,
  '42501'::text, NULL::text,
  'anon INSERT into rate_limit_buckets is blocked by RLS'
);
RESET ROLE;

SELECT app.set_jwt_claims('00000000-0000-0000-0000-0000000000aa'::uuid);
SELECT is(
  (SELECT count(*)::int FROM public.rate_limit_buckets),
  0,
  'authenticated sees zero rows in rate_limit_buckets (RLS filters)'
);
SELECT throws_ok(
  $$ INSERT INTO public.rate_limit_buckets
       (resource_type, resource_key, window_start, window_size, count)
     VALUES ('auth', 'k-auth', now(), interval '1 minute', 1) $$,
  '42501'::text, NULL::text,
  'authenticated INSERT into rate_limit_buckets is blocked by RLS'
);
SELECT app.reset_jwt_claims();

-- ----------------------------------------------------------------------------
-- 3. create_user_profile() is a signup trigger, not an RPC — anon and
--    authenticated must NOT be able to EXECUTE it via /rest/v1/rpc.
-- ----------------------------------------------------------------------------
SELECT ok(
  NOT has_function_privilege('anon', 'public.create_user_profile()', 'EXECUTE'),
  'anon cannot EXECUTE public.create_user_profile()'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.create_user_profile()', 'EXECUTE'),
  'authenticated cannot EXECUTE public.create_user_profile()'
);

-- ----------------------------------------------------------------------------
-- 4. The 4 advisor-flagged helpers now pin a search_path (no longer mutable).
-- ----------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (
            ('app', 'set_updated_at'),
            ('app', 'is_system_admin'),
            ('public', 'enforce_min_one_admin'),
            ('public', 'normalize_invitation_email'))
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
         WHERE c LIKE 'search_path=%')),
  4,
  'all 4 advisor-flagged helpers have a pinned search_path'
);

SELECT finish();
ROLLBACK;
