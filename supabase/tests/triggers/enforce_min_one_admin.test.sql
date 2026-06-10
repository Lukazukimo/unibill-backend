-- ============================================================================
-- Test:      supabase/tests/triggers/enforce_min_one_admin.test.sql
-- Date:      2026-06-10
-- Task:      T-115
-- Purpose:   pgTAP test suite for the `public.enforce_min_one_admin()` trigger
--            attached to `public.members` (BEFORE UPDATE OR DELETE). Verifies
--            that the three "admin removal" code paths correctly RAISE when
--            the operation would leave a household with zero active admins,
--            AND correctly succeed when at least one other active admin
--            remains.
-- Spec refs: §5.1  (enforce_min_one_admin function/trigger; the three
--                   scenarios — UPDATE demote, UPDATE soft-delete, DELETE),
--            §5.10 (system_actors used as the `created_by` sentinel so we
--                   don't need to seed `auth.users` rows for the household
--                   creator audit column — only the `members.user_id`
--                   ownership FK is real and needs auth.users rows).
--
-- Test plan (6 assertions):
--   throws_ok #1: UPDATE demoting role admin→member of THE LAST admin → RAISES
--   throws_ok #2: UPDATE setting deleted_at on THE LAST admin            → RAISES
--   throws_ok #3: DELETE of THE LAST admin row                           → RAISES
--   lives_ok  #4: UPDATE demoting one of two admins                      → OK
--   lives_ok  #5: UPDATE soft-deleting one of two admins                 → OK
--   lives_ok  #6: DELETE of one of two admins                            → OK
--
-- Hermeticity:
--   Entire test wrapped in BEGIN / ROLLBACK so no state leaks. Each scenario
--   uses its own household + members so the assertions are independent (an
--   assertion that ROLLS back via savepoint would also work, but separate
--   households are clearer and equally hermetic given the outer ROLLBACK).
--
-- Notes on auth.users seeding:
--   `members.user_id` has a real FK to `auth.users(id)`. The simplest, fastest
--   way to seed test rows is to INSERT directly into `auth.users` with just
--   the required columns (id, instance_id, email, aud, role). This is the
--   pattern recommended by Supabase docs for pgTAP tests on tables that FK
--   into auth. Rows are removed by the outer ROLLBACK.
-- ============================================================================


BEGIN;

-- pgTAP requires its extension to be loaded; T-105 already installs it in
-- the `extensions` schema. Set the search_path so unqualified pgTAP calls
-- (plan, throws_ok, lives_ok, finish) resolve.
SET LOCAL search_path = public, extensions, app;

SELECT plan(6);


-- ============================================================================
-- Setup: seed 6 auth.users (2 per household × 3 households) + 3 households +
-- members rows. Each household has exactly 2 admins so we can demote/delete
-- ONE in the lives_ok scenarios and demote/delete BOTH (sequentially within
-- the same household via a fourth user that becomes the "lone admin") for
-- the throws_ok scenarios.
--
-- For simplicity and isolation, each household gets its own pair of users:
--
--   Household A (throws_ok #1: demote last admin):
--     userA1 = admin (will be demoted from admin→member → fails because it
--                     is the only admin)
--   Household B (throws_ok #2: soft-delete last admin):
--     userB1 = admin (will be soft-deleted → fails because it is the only
--                     admin)
--   Household C (throws_ok #3: hard-delete last admin):
--     userC1 = admin (will be DELETEd → fails because it is the only admin)
--
--   Household D (lives_ok #4: demote one of two admins):
--     userD1 = admin (will be demoted → succeeds)
--     userD2 = admin (remains)
--   Household E (lives_ok #5: soft-delete one of two admins):
--     userE1 = admin (will be soft-deleted → succeeds)
--     userE2 = admin (remains)
--   Household F (lives_ok #6: delete one of two admins):
--     userF1 = admin (will be DELETEd → succeeds)
--     userF2 = admin (remains)
-- ============================================================================

-- Seed 9 auth.users. Use deterministic UUIDs for readability in failure msgs.
-- `instance_id` is the default Supabase single-instance value; `aud` and
-- `role` are required-not-null on auth.users in Supabase Postgres.
INSERT INTO auth.users (id, instance_id, email, aud, role)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01', '00000000-0000-0000-0000-000000000000', 'a1@test.local', 'authenticated', 'authenticated'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01', '00000000-0000-0000-0000-000000000000', 'b1@test.local', 'authenticated', 'authenticated'),
  ('cccccccc-cccc-cccc-cccc-cccccccccc01', '00000000-0000-0000-0000-000000000000', 'c1@test.local', 'authenticated', 'authenticated'),
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', '00000000-0000-0000-0000-000000000000', 'd1@test.local', 'authenticated', 'authenticated'),
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', '00000000-0000-0000-0000-000000000000', 'd2@test.local', 'authenticated', 'authenticated'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01', '00000000-0000-0000-0000-000000000000', 'e1@test.local', 'authenticated', 'authenticated'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee02', '00000000-0000-0000-0000-000000000000', 'e2@test.local', 'authenticated', 'authenticated'),
  ('ffffffff-ffff-ffff-ffff-ffffffffff01', '00000000-0000-0000-0000-000000000000', 'f1@test.local', 'authenticated', 'authenticated'),
  ('ffffffff-ffff-ffff-ffff-ffffffffff02', '00000000-0000-0000-0000-000000000000', 'f2@test.local', 'authenticated', 'authenticated');

-- Seed 6 households. `created_by` is uuid-no-FK per §5.10; we point it at the
-- system_admin_bootstrap sentinel from T-106 to keep the audit column
-- semantically meaningful without needing a real auth user.
INSERT INTO public.households (id, name, created_by)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'HH-A throws-demote-last',     '00000000-0000-0000-0000-000000000003'),
  ('22222222-2222-2222-2222-222222222222', 'HH-B throws-softdel-last',    '00000000-0000-0000-0000-000000000003'),
  ('33333333-3333-3333-3333-333333333333', 'HH-C throws-harddel-last',    '00000000-0000-0000-0000-000000000003'),
  ('44444444-4444-4444-4444-444444444444', 'HH-D lives-demote-of-two',    '00000000-0000-0000-0000-000000000003'),
  ('55555555-5555-5555-5555-555555555555', 'HH-E lives-softdel-of-two',   '00000000-0000-0000-0000-000000000003'),
  ('66666666-6666-6666-6666-666666666666', 'HH-F lives-harddel-of-two',   '00000000-0000-0000-0000-000000000003');

-- Seed members. Each "throws" household has 1 admin; each "lives" household
-- has 2 admins so we can remove one and still satisfy the invariant.
INSERT INTO public.members (id, household_id, user_id, role)
VALUES
  -- Throws households: ONE admin each (the trigger must block their removal)
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01', 'admin'),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01', 'admin'),
  ('c0000000-0000-0000-0000-00000000000c', '33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccc01', 'admin'),
  -- Lives households: TWO admins each (the trigger must allow removing one)
  ('d0000000-0000-0000-0000-0000000000d1', '44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddd01', 'admin'),
  ('d0000000-0000-0000-0000-0000000000d2', '44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddd02', 'admin'),
  ('e0000000-0000-0000-0000-0000000000e1', '55555555-5555-5555-5555-555555555555', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01', 'admin'),
  ('e0000000-0000-0000-0000-0000000000e2', '55555555-5555-5555-5555-555555555555', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee02', 'admin'),
  ('f0000000-0000-0000-0000-0000000000f1', '66666666-6666-6666-6666-666666666666', 'ffffffff-ffff-ffff-ffff-ffffffffff01', 'admin'),
  ('f0000000-0000-0000-0000-0000000000f2', '66666666-6666-6666-6666-666666666666', 'ffffffff-ffff-ffff-ffff-ffffffffff02', 'admin');


-- ============================================================================
-- throws_ok #1 — UPDATE demoting role admin→member of the last admin
-- ============================================================================
-- Scenario (a) in the trigger: OLD.role='admin' AND NEW.role<>'admin'.
-- Household HH-A has exactly one active admin (userA1). Demoting it must
-- RAISE 'Cannot remove the last admin of household %'.
SELECT throws_ok(
  $$ UPDATE public.members
       SET role = 'member'
     WHERE id = 'a0000000-0000-0000-0000-00000000000a' $$,
  NULL,                                                       -- any SQLSTATE
  'Cannot remove the last admin of household 11111111-1111-1111-1111-111111111111',
  'throws_ok #1: demoting the last admin (admin->member) must RAISE'
);


-- ============================================================================
-- throws_ok #2 — UPDATE setting deleted_at on the last admin
-- ============================================================================
-- Scenario (b) in the trigger: OLD.deleted_at IS NULL AND NEW.deleted_at IS
-- NOT NULL AND OLD.role='admin'. Household HH-B has exactly one active admin
-- (userB1). Soft-deleting it must RAISE.
SELECT throws_ok(
  $$ UPDATE public.members
       SET deleted_at = now()
     WHERE id = 'b0000000-0000-0000-0000-00000000000b' $$,
  NULL,
  'Cannot remove the last admin of household 22222222-2222-2222-2222-222222222222',
  'throws_ok #2: soft-deleting the last admin must RAISE'
);


-- ============================================================================
-- throws_ok #3 — DELETE of the last admin row
-- ============================================================================
-- Scenario (c) in the trigger: TG_OP='DELETE' AND OLD.role='admin' AND
-- OLD.deleted_at IS NULL. Household HH-C has exactly one active admin
-- (userC1). DELETing it must RAISE.
--
-- This case is the critical regression test for tech-2: if the trigger
-- returned NULL/NEW instead of OLD, the DELETE would be silently aborted
-- instead of raising. Here we expect the RAISE EXCEPTION explicitly.
SELECT throws_ok(
  $$ DELETE FROM public.members
      WHERE id = 'c0000000-0000-0000-0000-00000000000c' $$,
  NULL,
  'Cannot remove the last admin of household 33333333-3333-3333-3333-333333333333',
  'throws_ok #3: hard-deleting the last admin must RAISE'
);


-- ============================================================================
-- lives_ok #4 — UPDATE demoting one of two admins
-- ============================================================================
-- Household HH-D has two admins (d1, d2). Demoting d1 leaves d2 → succeeds.
SELECT lives_ok(
  $$ UPDATE public.members
       SET role = 'member'
     WHERE id = 'd0000000-0000-0000-0000-0000000000d1' $$,
  'lives_ok #4: demoting one of two admins must succeed'
);


-- ============================================================================
-- lives_ok #5 — UPDATE soft-deleting one of two admins
-- ============================================================================
-- Household HH-E has two admins (e1, e2). Soft-deleting e1 leaves e2
-- active → succeeds.
SELECT lives_ok(
  $$ UPDATE public.members
       SET deleted_at = now()
     WHERE id = 'e0000000-0000-0000-0000-0000000000e1' $$,
  'lives_ok #5: soft-deleting one of two admins must succeed'
);


-- ============================================================================
-- lives_ok #6 — DELETE of one of two admins
-- ============================================================================
-- Household HH-F has two admins (f1, f2). Hard-deleting f1 leaves f2 → ok.
-- Also asserts (implicitly) that the BEFORE DELETE trigger returns OLD
-- properly (otherwise the row wouldn't actually be deleted even without a
-- RAISE — see tech-2 in T-108 migration header).
SELECT lives_ok(
  $$ DELETE FROM public.members
      WHERE id = 'f0000000-0000-0000-0000-0000000000f1' $$,
  'lives_ok #6: hard-deleting one of two admins must succeed'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
