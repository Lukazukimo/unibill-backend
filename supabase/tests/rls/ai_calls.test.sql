-- ============================================================================
-- Test:      supabase/tests/rls/ai_calls.test.sql
-- Date:      2026-06-23
-- Task:      T-401 — ai_calls RLS (member-of-household OR sys-admin SELECT).
-- Purpose:   pgTAP RLS for public.ai_calls. SELECT visibility = the row's
--            household_id is one the caller is a MEMBER of (and is non-NULL),
--            OR the caller is a system admin. NULL-household rows (chain/probe
--            calls with no invoice) are visible to sys-admin only. Writes are
--            service_role-only; anon has no grant (denied at the grant layer).
--
--            Live policy (20260623120000_create_ai_calls.sql), ai_calls_select:
--              (household_id IS NOT NULL
--                AND household_id IN (SELECT app.households_of_user()))
--              OR app.is_system_admin()
--
--            Assertions (plan 5):
--              1. U1 (member of H1) sees ONLY the H1 row.
--              2. U2 (member of H2) sees ONLY the H2 row (isolation).
--              3. sys admin sees ALL three rows, including the NULL-household one.
--              4. U1 does NOT see the NULL-household row (member path requires a
--                 non-NULL household the caller belongs to).
--              5. anon SELECT is denied at the grant layer (42501).
--
-- Spec refs: §5.11 (ai_calls RLS matrix).
-- Hermeticity: BEGIN/ROLLBACK; search_path locked; JWT helper reused; identity
--   reset between scenarios. Self-fixturing.
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.psql

SELECT plan(5);


-- ============================================================================
-- Setup (as postgres): two members, a sys-admin user, two households, three
-- ai_calls rows (H1, H2, and one with NULL household).
-- ============================================================================
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('a1a1a1a1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000',
   'u1@test.local', 'authenticated', 'authenticated', '{"display_name":"U1"}'::jsonb),
  ('a2a2a2a2-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000000',
   'u2@test.local', 'authenticated', 'authenticated', '{"display_name":"U2"}'::jsonb),
  ('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d',
   '00000000-0000-0000-0000-000000000000',
   'sys@test.local', 'authenticated', 'authenticated', '{"display_name":"Sys"}'::jsonb);

INSERT INTO public.households (id, name, created_by)
VALUES
  ('40000001-1111-1111-1111-111111111111', 'H1', 'a1a1a1a1-1111-1111-1111-111111111111'),
  ('40000002-2222-2222-2222-222222222222', 'H2', 'a2a2a2a2-2222-2222-2222-222222222222');

INSERT INTO public.members (household_id, user_id, role)
VALUES
  ('40000001-1111-1111-1111-111111111111', 'a1a1a1a1-1111-1111-1111-111111111111', 'admin'),
  ('40000002-2222-2222-2222-222222222222', 'a2a2a2a2-2222-2222-2222-222222222222', 'admin');

INSERT INTO public.ai_calls (id, provider, purpose, status, household_id)
VALUES
  ('a1c00001-1111-1111-1111-111111111111', 'gemini', 'extraction', 'success',
   '40000001-1111-1111-1111-111111111111'),
  ('a1c00002-2222-2222-2222-222222222222', 'gemini', 'extraction', 'success',
   '40000002-2222-2222-2222-222222222222'),
  ('a1c00003-3333-3333-3333-333333333333', '__chain__', 'extraction', 'circuit_open',
   NULL);


-- #1 — U1 (member of H1) sees ONLY the H1 row.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);
SELECT set_eq(
  $$SELECT id FROM public.ai_calls
      WHERE id IN ('a1c00001-1111-1111-1111-111111111111',
                   'a1c00002-2222-2222-2222-222222222222',
                   'a1c00003-3333-3333-3333-333333333333')$$,
  ARRAY['a1c00001-1111-1111-1111-111111111111'::uuid],
  '#1 member of H1 sees only the H1 ai_calls row'
);

-- #2 — U2 (member of H2) sees ONLY the H2 row.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a2a2a2a2-2222-2222-2222-222222222222'::uuid,
                          '40000002-2222-2222-2222-222222222222'::uuid, false);
SELECT set_eq(
  $$SELECT id FROM public.ai_calls
      WHERE id IN ('a1c00001-1111-1111-1111-111111111111',
                   'a1c00002-2222-2222-2222-222222222222',
                   'a1c00003-3333-3333-3333-333333333333')$$,
  ARRAY['a1c00002-2222-2222-2222-222222222222'::uuid],
  '#2 isolation: member of H2 sees only the H2 row'
);

-- #3 — sys admin sees ALL three (including the NULL-household row).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid, NULL, true);
SELECT set_eq(
  $$SELECT id FROM public.ai_calls
      WHERE id IN ('a1c00001-1111-1111-1111-111111111111',
                   'a1c00002-2222-2222-2222-222222222222',
                   'a1c00003-3333-3333-3333-333333333333')$$,
  ARRAY['a1c00001-1111-1111-1111-111111111111'::uuid,
        'a1c00002-2222-2222-2222-222222222222'::uuid,
        'a1c00003-3333-3333-3333-333333333333'::uuid],
  '#3 sys-admin override sees all rows, incl. the NULL-household chain row'
);

-- #4 — U1 does NOT see the NULL-household row (member path needs a non-NULL hh).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);
SELECT is_empty(
  $$SELECT 1 FROM public.ai_calls
      WHERE id = 'a1c00003-3333-3333-3333-333333333333'$$,
  '#4 NULL-household row is invisible to a regular member (sys-admin only)'
);

-- #5 — anon SELECT denied at the grant layer.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();
SELECT throws_ok(
  $$SELECT 1 FROM public.ai_calls$$,
  '42501',
  NULL,
  '#5 anon SELECT denied at the grant layer (no DML grant → 42501)'
);


SELECT app.reset_jwt_claims();
SELECT * FROM finish();
ROLLBACK;
