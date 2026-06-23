-- ============================================================================
-- Test:      supabase/tests/rls/utility_parsers.test.sql
-- Date:      2026-06-23
-- Task:      T-330 (#41) — utility_parsers RLS (anon denied; authenticated SELECT only)
-- Purpose:   pgTAP RLS / privilege tests for `public.utility_parsers`.
--
--            utility_parsers holds the parser fingerprints (sender/subject
--            regexes, amount/due-date extractors) used by the ingestion
--            pipeline. Per spec §5.11 it is AUTHENTICATED-SELECT-ONLY: any
--            signed-in user may read the parser catalog, but nobody writes it
--            through the API (the catalog is curated via migrations/seeds and
--            mutated only by `service_role`). anon is excluded entirely so the
--            parser fingerprints never leak to the public (anon) URL.
--
--            Live policy / grant reality this test pins:
--              * The ONLY policy is `utility_parsers_select`
--                  FOR SELECT TO authenticated USING (true)
--                — qual is the literal `true`, so it is identity-independent:
--                  every authenticated caller sees every parser row (this is a
--                  shared catalog, NOT a per-tenant table).
--              * Migration 20260622120100_grant_table_privileges granted ONLY
--                SELECT on utility_parsers to `authenticated`. There is no
--                INSERT/UPDATE/DELETE grant for authenticated and no write
--                policy → every write is rejected at the GRANT layer (42501),
--                before RLS WITH CHECK is ever evaluated.
--              * `anon` has NO grant of any DML kind on the table → an anon
--                SELECT is rejected at the GRANT layer (42501), before RLS.
--
--            Assertions:
--              1. Authenticated caller U1 SELECTs the seeded parser row.
--              2. A DIFFERENT authenticated caller U2 SELECTs the SAME row —
--                 proves the policy qual is `true` (shared catalog, not
--                 tenant-scoped); identity does not change visibility.
--              3. anon SELECT denied at the grant layer → 42501.
--              4. Authenticated INSERT denied at the grant layer → 42501.
--              5. Authenticated UPDATE denied at the grant layer → 42501.
--              6. Authenticated DELETE denied at the grant layer → 42501.
--
-- Spec refs: §5.11 (RLS policy row "utility_parsers": authenticated SELECT
--                   only, no anon, no API write).
--
-- Migration refs: 20260620120000_create_utility_parsers (table + select policy),
--                 20260622120100_grant_table_privileges (SELECT-only grant to
--                 authenticated; no write grant; anon ungranted).
--
-- Plan total: 6 assertions.
--
-- Hermeticity: BEGIN/ROLLBACK; search_path locked; JWT helper reused; identity
--   reset between scenarios. Self-fixturing — seeds its own rows inside the
--   transaction (supabase/seeds/* are NOT auto-applied).
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.psql

SELECT plan(6);


-- ============================================================================
-- Setup (as postgres): two authenticated identities + one parser row.
--
-- No household/membership rows are needed: the SELECT policy is USING (true)
-- and reads no membership table, so any valid authenticated identity suffices.
-- We still create real auth.users rows so the impersonated `sub` resolves to a
-- genuine user (mirrors the other RLS tests and keeps auth.uid() honest).
--
--   user U1 = 'a1a1a1a1-...'  (authenticated reader)
--   user U2 = 'a2a2a2a2-...'  (a DIFFERENT authenticated reader)
-- ============================================================================
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('a1a1a1a1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000',
   'u1@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U1 reader"}'::jsonb),
  ('a2a2a2a2-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000000',
   'u2@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U2 reader"}'::jsonb);

-- A valid parser row. NOT NULL columns are utility_key, display_name,
-- sender_patterns (text[]); version defaults to 1 and active defaults to true.
INSERT INTO public.utility_parsers
  (id, utility_key, display_name, sender_patterns, active)
VALUES
  ('11700001-1111-1111-1111-111111111111',
   't330-cemig', 'CEMIG (T-330 fixture)',
   ARRAY['@cemig.com.br']::text[], true);


-- ============================================================================
-- SCENARIO 1 — authenticated U1 SELECTs the seeded parser row
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          NULL, false);

SELECT set_eq(
  $$SELECT id FROM public.utility_parsers
      WHERE id = '11700001-1111-1111-1111-111111111111'$$,
  ARRAY['11700001-1111-1111-1111-111111111111'::uuid],
  '#1 authenticated SELECT: U1 reads the seeded parser row (USING true)'
);


-- ============================================================================
-- SCENARIO 2 — a DIFFERENT authenticated caller U2 sees the SAME row
-- ============================================================================
-- The policy qual is the literal `true`, so visibility is identity-independent:
-- utility_parsers is a shared catalog, not a per-tenant table. U2 (a different
-- user, no membership setup) must see exactly the same row as U1.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a2a2a2a2-2222-2222-2222-222222222222'::uuid,
                          NULL, false);

SELECT set_eq(
  $$SELECT id FROM public.utility_parsers
      WHERE id = '11700001-1111-1111-1111-111111111111'$$,
  ARRAY['11700001-1111-1111-1111-111111111111'::uuid],
  '#2 authenticated SELECT is a shared catalog: a different user U2 sees the same row (qual=true)'
);


-- ============================================================================
-- SCENARIO 3 — anon SELECT denied at the grant layer (42501)
-- ============================================================================
-- anon has NO grant on utility_parsers (migration 20260622120100). Denial
-- happens at the privilege layer (42501) before RLS — the parser fingerprints
-- are never exposed to the public (anon) URL.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT throws_ok(
  $$SELECT 1 FROM public.utility_parsers$$,
  '42501',
  NULL,
  '#3 anon SELECT DENIED: anonymous caller has no GRANT → permission denied (42501)'
);


-- ============================================================================
-- SCENARIO 4 — authenticated INSERT denied at the grant layer (42501)
-- ============================================================================
-- authenticated holds SELECT only; there is no INSERT grant and no write
-- policy. The INSERT is rejected at the GRANT layer (42501) before RLS WITH
-- CHECK is reached.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          NULL, false);

SELECT throws_ok(
  $$INSERT INTO public.utility_parsers (utility_key, display_name, sender_patterns)
    VALUES ('t330-rejected', 'Rejected', ARRAY['@x']::text[])$$,
  '42501',
  NULL,
  '#4 authenticated INSERT DENIED: no write grant → permission denied (42501)'
);


-- ============================================================================
-- SCENARIO 5 — authenticated UPDATE denied at the grant layer (42501)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          NULL, false);

SELECT throws_ok(
  $$UPDATE public.utility_parsers
       SET active = false
     WHERE id = '11700001-1111-1111-1111-111111111111'$$,
  '42501',
  NULL,
  '#5 authenticated UPDATE DENIED: no write grant → permission denied (42501)'
);


-- ============================================================================
-- SCENARIO 6 — authenticated DELETE denied at the grant layer (42501)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          NULL, false);

SELECT throws_ok(
  $$DELETE FROM public.utility_parsers
     WHERE id = '11700001-1111-1111-1111-111111111111'$$,
  '42501',
  NULL,
  '#6 authenticated DELETE DENIED: no write grant → permission denied (42501)'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT app.reset_jwt_claims();

SELECT * FROM finish();

ROLLBACK;
