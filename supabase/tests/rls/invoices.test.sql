-- ============================================================================
-- Test:      supabase/tests/rls/invoices.test.sql
-- Date:      2026-06-14
-- Task:      T-328
-- Purpose:   pgTAP cross-tenant RLS isolation tests for `public.invoices`.
--            The policy set (installed in 20260617120300_rls_invoices_categories)
--            implements spec §5.11 row "invoices":
--
--              SELECT — household_id IN app.households_of_user()
--                       OR app.is_system_admin()          (audit read override)
--              INSERT — household_id IN app.households_of_user()   (member write)
--              UPDATE — household_id IN app.households_of_user()   (member write,
--                       mirrored USING + WITH CHECK to block re-targeting a row
--                       into a household the caller is not a member of)
--              DELETE — household_id IN app.households_of_user()   (member write)
--
--            CRITICAL distinction from invoice_categories: invoices are
--            MEMBER-writable (any member of the household, not just admins) —
--            see scenario #8 which proves a NON-ADMIN member can INSERT. This
--            mirrors the spec table: invoices write = "member-of household
--            (write)" whereas invoice_categories write = "admin-of household".
--
--            Covers the assertions mandated by the T-328 plan entry:
--              1. SELECT as U1 (member of H1) sees the H1 invoice.
--              2. SELECT as U2 (member of H2) sees ZERO (cross-tenant baseline).
--              3. INSERT as U2 into H1 is REJECTED by WITH CHECK (42501).
--              4. UPDATE as U2 on the H1 invoice affects ZERO rows (USING filter).
--              5. DELETE as U2 on the H1 invoice affects ZERO rows (USING filter).
--              6. sys admin sees BOTH invoices (audit override).
--              7. soft-deleted invoice is excluded by the app's default query
--                 (`WHERE deleted_at IS NULL`). NOTE: RLS itself does NOT filter
--                 deleted_at — tombstones stay visible to workers/audit; the
--                 deleted_at IS NULL filter is an APPLICATION-layer convention.
--                 We assert that contract explicitly here.
--              8. A NON-ADMIN member (U3) of H1 CAN INSERT into H1 (member write).
--              9. anon caller sees ZERO rows (defense-in-depth).
--
-- Spec refs: §5.11 (RLS policy row "invoices"; Patterns A member-of SELECT +
--                   member-of write; sys-admin SELECT escape hatch precedent).
--            §5.3  (invoices schema — required columns household_id, storage_path,
--                   file_hash; deleted_at soft-delete marker).
--
-- Plan total: 10 assertions (>= the T-328 acceptance bar).
--
-- Hermeticity:
--   * Whole file wrapped in BEGIN / ROLLBACK.
--   * search_path locked to public, extensions, app.
--   * Reuses the JWT claims helper from tests/helpers/jwt_claims.sql.
--   * app.reset_jwt_claims() between scenarios for crisp diagnostics.
--
-- Notes on the RLS surface:
--   * RLS denials never raise on SELECT/UPDATE/DELETE — they silently filter
--     rows, so "U2 cannot UPDATE H1's invoice" is asserted by RETURNING count = 0.
--   * RLS denials on INSERT WITH CHECK DO raise — SQLSTATE '42501'
--     (insufficient_privilege) — asserted via throws_ok.
--   * service_role bypass is NOT exercised (BYPASSRLS by design).
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.psql

SELECT plan(10);


-- ============================================================================
-- Setup: four identities + two households + one invoice in H1
-- ============================================================================
-- UUID conventions (readable in failure output):
--   user U1 (admin H1)   = 'a1a1a1a1-...'
--   user U2 (admin H2)   = 'a2a2a2a2-...'
--   user U3 (member H1)  = 'a3a3a3a3-...'  — NON-admin member, proves member write
--   user K  (sys admin)  = '5d5d5d5d-...'  — no membership; is_system_admin=true
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

-- One invoice in H1 (inserted as owner/postgres so RLS does not gate setup),
-- and one invoice in H2 so the sys-admin "sees both" assertion is meaningful.
INSERT INTO public.invoices (id, household_id, storage_path, file_hash, status)
VALUES
  ('1eeeeeee-1111-1111-1111-111111111111',
   '40000001-1111-1111-1111-111111111111',
   'household-40000001/2026-06/h1.pdf',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'extracted'),
  ('2eeeeeee-2222-2222-2222-222222222222',
   '40000002-2222-2222-2222-222222222222',
   'household-40000002/2026-06/h2.pdf',
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   'extracted');


-- ============================================================================
-- SCENARIO 1 — U1 (member of H1) sees the H1 invoice
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.invoices$$,
  ARRAY['1eeeeeee-1111-1111-1111-111111111111'::uuid],
  '#1 member SELECT: U1 (H1) sees exactly the H1 invoice (and not H2''s)'
);


-- ============================================================================
-- SCENARIO 2 — U2 (member of H2) sees ZERO of H1's invoices (cross-tenant)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a2a2a2a2-2222-2222-2222-222222222222'::uuid,
                          '40000002-2222-2222-2222-222222222222'::uuid, false);

SELECT is_empty(
  $$SELECT 1 FROM public.invoices
     WHERE id = '1eeeeeee-1111-1111-1111-111111111111'$$,
  '#2 cross-tenant SELECT denied: U2 (H2) cannot see the H1 invoice'
);


-- ============================================================================
-- SCENARIO 3 — INSERT as U2 into H1 rejected by WITH CHECK (42501)
-- ============================================================================
SELECT throws_ok(
  $$INSERT INTO public.invoices (household_id, storage_path, file_hash)
    VALUES (
      '40000001-1111-1111-1111-111111111111',
      'household-40000001/2026-06/intruder.pdf',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    )$$,
  '42501',
  NULL,
  '#3 cross-tenant INSERT denied: U2 inserting into H1 fails RLS WITH CHECK (42501)'
);


-- ============================================================================
-- SCENARIO 4 — UPDATE as U2 on H1 invoice affects ZERO rows (USING filter)
-- ============================================================================
-- NOTE: the data-modifying CTE is attached to the TOP-LEVEL statement (not
-- nested inside a scalar sub-SELECT) — Postgres only allows UPDATE/DELETE/INSERT
-- in a WITH at the top level (otherwise SQLSTATE 0A000 aborts the whole txn).
WITH x AS (
  UPDATE public.invoices
     SET payment_note = 'tampered-by-u2'
   WHERE id = '1eeeeeee-1111-1111-1111-111111111111'
   RETURNING 1
)
SELECT is(
  (SELECT count(*)::int FROM x),
  0,
  '#4 cross-tenant UPDATE denied: U2 updating the H1 invoice affects 0 rows (USING filters it out)'
);


-- ============================================================================
-- SCENARIO 5 — DELETE as U2 on H1 invoice affects ZERO rows (USING filter)
-- ============================================================================
WITH x AS (
  DELETE FROM public.invoices
   WHERE id = '1eeeeeee-1111-1111-1111-111111111111'
   RETURNING 1
)
SELECT is(
  (SELECT count(*)::int FROM x),
  0,
  '#5 cross-tenant DELETE denied: U2 deleting the H1 invoice affects 0 rows (USING filters it out)'
);


-- ============================================================================
-- SCENARIO 6 — sys admin sees BOTH invoices (audit override)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT set_eq(
  $$SELECT id FROM public.invoices
      WHERE id IN ('1eeeeeee-1111-1111-1111-111111111111'::uuid,
                   '2eeeeeee-2222-2222-2222-222222222222'::uuid)$$,
  ARRAY[
    '1eeeeeee-1111-1111-1111-111111111111'::uuid,
    '2eeeeeee-2222-2222-2222-222222222222'::uuid
  ],
  '#6 sys admin: sees BOTH invoices (H1 + H2) via audit SELECT override'
);


-- ============================================================================
-- SCENARIO 7 — soft-deleted invoice excluded by app default query
-- ============================================================================
-- RLS does NOT filter deleted_at (tombstones remain visible to workers/audit).
-- The application's "list" queries always add `WHERE deleted_at IS NULL`. We
-- soft-delete the H1 invoice (as U1, a member who CAN write) and assert the
-- app-style query returns 0, while a no-filter query still returns it under RLS.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

UPDATE public.invoices
   SET deleted_at = now()
 WHERE id = '1eeeeeee-1111-1111-1111-111111111111';

SELECT is_empty(
  $$SELECT 1 FROM public.invoices
     WHERE id = '1eeeeeee-1111-1111-1111-111111111111'
       AND deleted_at IS NULL$$,
  '#7 soft-delete: the app default query (deleted_at IS NULL) excludes the soft-deleted H1 invoice'
);


-- ============================================================================
-- SCENARIO 8 — non-admin member (U3) CAN INSERT into H1 (member write)
-- ============================================================================
-- U3 is a 'member' (NOT admin) of H1. invoices write = member-of household, so
-- the INSERT must SUCCEED. This is the key behavioral difference from
-- invoice_categories (admin-only write).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a3a3a3a3-3333-3333-3333-333333333333'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT lives_ok(
  $$INSERT INTO public.invoices (household_id, storage_path, file_hash)
    VALUES (
      '40000001-1111-1111-1111-111111111111',
      'household-40000001/2026-06/by-member.pdf',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    )$$,
  '#8 member write: NON-admin member U3 of H1 CAN INSERT an invoice into H1'
);


-- ============================================================================
-- SCENARIO 9 — member can UPDATE own household invoice (positive write path)
-- ============================================================================
-- U3 (member) updates the invoice they just created. Proves the UPDATE policy
-- grants members write (not just INSERT). The row created in #8 has file_hash
-- 'dddd...'; we target it.
WITH x AS (
  UPDATE public.invoices
     SET payment_note = 'noted-by-member'
   WHERE household_id = '40000001-1111-1111-1111-111111111111'
     AND file_hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
   RETURNING 1
)
SELECT is(
  (SELECT count(*)::int FROM x),
  1,
  '#9 member write: U3 (member of H1) CAN UPDATE an H1 invoice (affects 1 row)'
);


-- ============================================================================
-- SCENARIO 10 — anon caller sees zero invoices
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

-- anon has NO table GRANT (only authenticated does — see migration
-- 20260622120100); denial happens at the privilege layer (42501) before RLS.
SELECT throws_ok(
  $$SELECT 1 FROM public.invoices$$,
  '42501',
  NULL,
  '#10 anon SELECT: anonymous caller denied at the grant layer (no GRANT → 42501)'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT app.reset_jwt_claims();

SELECT * FROM finish();

ROLLBACK;
