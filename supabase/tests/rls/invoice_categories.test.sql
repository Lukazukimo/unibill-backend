-- ============================================================================
-- Test:      supabase/tests/rls/invoice_categories.test.sql
-- Date:      2026-06-14
-- Task:      T-328 (companion — invoice_categories RLS)
-- Purpose:   pgTAP cross-tenant RLS isolation tests for
--            `public.invoice_categories`. The policy set (installed in
--            20260617120300_rls_invoices_categories) implements spec §5.11 row
--            "invoice_categories":
--
--              SELECT — household_id IN app.households_of_user()
--                       OR app.is_system_admin()        (member read + audit)
--              WRITE  — app.is_household_admin(household_id)   (Pattern B)
--                       (FOR ALL, mirrored USING + WITH CHECK)
--
--            CRITICAL distinction from invoices: categories are ADMIN-writable
--            only. Scenario #4 proves a NON-admin member CANNOT INSERT a
--            category, whereas the same actor CAN insert an invoice
--            (tests/rls/invoices.test.sql #8). This is the spec's deliberate
--            split: invoices write = member-of, categories write = admin-of.
--
--            Assertions:
--              1. U1 (admin H1) sees the H1 category.
--              2. U3 (NON-admin member of H1) sees the H1 category (member read).
--              3. U2 (admin H2) sees ZERO of H1's categories (cross-tenant).
--              4. U3 (member, not admin) INSERT into H1 REJECTED (42501).
--              5. U1 (admin H1) INSERT into H1 SUCCEEDS.
--              6. U2 (admin H2) INSERT into H1 REJECTED (42501) — admin of the
--                 WRONG household.
--              7. sys admin sees the H1 category (audit override).
--              8. anon caller sees ZERO categories.
--
-- Spec refs: §5.11 (RLS policy row "invoice_categories"; Pattern A member
--                   SELECT + Pattern B admin write).
--            §5.4  (invoice_categories schema — required columns household_id,
--                   name).
--
-- Plan total: 8 assertions.
--
-- Hermeticity: BEGIN/ROLLBACK; search_path locked; JWT helper reused;
--   reset between scenarios.
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.sql

SELECT plan(8);


-- ============================================================================
-- Setup: three identities + two households + one category in H1
-- ============================================================================
--   user U1 (admin H1)   = 'a1a1a1a1-...'
--   user U2 (admin H2)   = 'a2a2a2a2-...'
--   user U3 (member H1)  = 'a3a3a3a3-...'  — NON-admin member
--   user K  (sys admin)  = '5d5d5d5d-...'
--   household H1         = '40000001-...'
--   household H2         = '40000002-...'
-- ============================================================================
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('a1a1a1a1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000',
   'u1@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U1 admin H1"}'::jsonb),
  ('a2a2a2a2-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000000',
   'u2@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U2 admin H2"}'::jsonb),
  ('a3a3a3a3-3333-3333-3333-333333333333',
   '00000000-0000-0000-0000-000000000000',
   'u3@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U3 member H1"}'::jsonb),
  ('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d',
   '00000000-0000-0000-0000-000000000000',
   'sys@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Sys Admin"}'::jsonb);

INSERT INTO public.households (id, name, created_by)
VALUES
  ('40000001-1111-1111-1111-111111111111', 'Household H1',
   'a1a1a1a1-1111-1111-1111-111111111111'),
  ('40000002-2222-2222-2222-222222222222', 'Household H2',
   'a2a2a2a2-2222-2222-2222-222222222222');

INSERT INTO public.members (household_id, user_id, role)
VALUES
  ('40000001-1111-1111-1111-111111111111',
   'a1a1a1a1-1111-1111-1111-111111111111', 'admin'),
  ('40000002-2222-2222-2222-222222222222',
   'a2a2a2a2-2222-2222-2222-222222222222', 'admin'),
  ('40000001-1111-1111-1111-111111111111',
   'a3a3a3a3-3333-3333-3333-333333333333', 'member');

INSERT INTO public.invoice_categories (id, household_id, name, is_system)
VALUES
  ('ca700001-1111-1111-1111-111111111111',
   '40000001-1111-1111-1111-111111111111', 'Luz', true);


-- ============================================================================
-- SCENARIO 1 — U1 (admin H1) sees the H1 category
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.invoice_categories$$,
  ARRAY['ca700001-1111-1111-1111-111111111111'::uuid],
  '#1 admin SELECT: U1 (admin H1) sees the H1 category'
);


-- ============================================================================
-- SCENARIO 2 — U3 (NON-admin member of H1) sees the H1 category (member read)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a3a3a3a3-3333-3333-3333-333333333333'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.invoice_categories$$,
  ARRAY['ca700001-1111-1111-1111-111111111111'::uuid],
  '#2 member SELECT: U3 (non-admin member of H1) sees the H1 category'
);


-- ============================================================================
-- SCENARIO 3 — U2 (admin H2) sees ZERO of H1's categories (cross-tenant)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a2a2a2a2-2222-2222-2222-222222222222'::uuid,
                          '40000002-2222-2222-2222-222222222222'::uuid, false);

SELECT is_empty(
  $$SELECT 1 FROM public.invoice_categories
     WHERE id = 'ca700001-1111-1111-1111-111111111111'$$,
  '#3 cross-tenant SELECT denied: U2 (H2) cannot see the H1 category'
);


-- ============================================================================
-- SCENARIO 4 — U3 (member, not admin) INSERT into H1 REJECTED (42501)
-- ============================================================================
-- Categories are admin-write only. A non-admin member is rejected — this is the
-- key contrast with invoices (member-writable).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a3a3a3a3-3333-3333-3333-333333333333'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT throws_ok(
  $$INSERT INTO public.invoice_categories (household_id, name)
    VALUES ('40000001-1111-1111-1111-111111111111', 'Água')$$,
  '42501',
  NULL,
  '#4 member write DENIED: non-admin member U3 cannot INSERT a category (admin-only write, 42501)'
);


-- ============================================================================
-- SCENARIO 5 — U1 (admin H1) INSERT into H1 SUCCEEDS
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT lives_ok(
  $$INSERT INTO public.invoice_categories (household_id, name)
    VALUES ('40000001-1111-1111-1111-111111111111', 'Internet')$$,
  '#5 admin write: U1 (admin H1) CAN INSERT a category into H1'
);


-- ============================================================================
-- SCENARIO 6 — U2 (admin H2) INSERT into H1 REJECTED (42501)
-- ============================================================================
-- Being an admin of the WRONG household does not grant write to H1.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a2a2a2a2-2222-2222-2222-222222222222'::uuid,
                          '40000002-2222-2222-2222-222222222222'::uuid, false);

SELECT throws_ok(
  $$INSERT INTO public.invoice_categories (household_id, name)
    VALUES ('40000001-1111-1111-1111-111111111111', 'Gás')$$,
  '42501',
  NULL,
  '#6 cross-tenant write DENIED: U2 (admin of H2) cannot INSERT a category into H1 (42501)'
);


-- ============================================================================
-- SCENARIO 7 — sys admin sees the H1 category (audit override)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT set_eq(
  $$SELECT id FROM public.invoice_categories
      WHERE id = 'ca700001-1111-1111-1111-111111111111'$$,
  ARRAY['ca700001-1111-1111-1111-111111111111'::uuid],
  '#7 sys admin: sees the H1 category via audit SELECT override'
);


-- ============================================================================
-- SCENARIO 8 — anon caller sees zero categories
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

-- anon has NO table GRANT (only authenticated does — see migration
-- 20260622120100); denial happens at the privilege layer (42501) before RLS.
SELECT throws_ok(
  $$SELECT 1 FROM public.invoice_categories$$,
  '42501',
  NULL,
  '#8 anon SELECT: anonymous caller denied at the grant layer (no GRANT → 42501)'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT app.reset_jwt_claims();

SELECT * FROM finish();

ROLLBACK;
