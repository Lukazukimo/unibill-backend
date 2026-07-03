-- ============================================================================
-- Test:      supabase/tests/rls/members_self_leave.test.sql
-- Issue:     #279  (leaveHousehold was a silent no-op for non-admin members)
-- Purpose:   Prove the self-leave write path on public.members:
--              1. a non-admin member CAN soft-leave (set deleted_at) their OWN
--                 membership row;
--              2. a non-admin CANNOT escalate their role (e.g. → 'admin') via
--                 that same self-update — the column guard blocks it;
--              3. a non-admin CANNOT change household_id/user_id on their row;
--              4. a non-admin CANNOT soft-leave ANOTHER member's row (RLS
--                 filters it → row untouched);
--              5. the LAST admin still cannot self-leave (existing
--                 enforce_min_one_admin trigger covers the soft-delete path);
--              6. admins keep full write over members (members_admin_write
--                 unaffected).
--
-- Design:    members_self_leave RLS policy (FOR UPDATE, user_id = auth.uid())
--            + app.members_restrict_self_update() BEFORE UPDATE trigger that
--            restricts a NON-admin self-update to deleted_at only. Admins take
--            the members_admin_write path (is_household_admin → guard skipped).
--
-- Hermeticity: BEGIN/ROLLBACK; seed as the installing role (postgres), assert
--            as `authenticated` via app.set_jwt_claims(); reset to inspect true
--            row state (postgres bypasses RLS).
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.psql

SELECT plan(10);

-- ----------------------------------------------------------------------------
-- Fixtures: household X with admin A + two plain members C, D. Household Y
-- exists only as a valid FK target for the "change household_id" guard test.
--   A = admin of X          C, D = members of X          B = admin of Y
-- ----------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('aaaaaaa1-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
   'admin-a@test.local', 'authenticated', 'authenticated', '{"display_name":"A"}'::jsonb),
  ('ccccccc3-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
   'member-c@test.local', 'authenticated', 'authenticated', '{"display_name":"C"}'::jsonb),
  ('ddddddd4-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000',
   'member-d@test.local', 'authenticated', 'authenticated', '{"display_name":"D"}'::jsonb),
  ('bbbbbbb2-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
   'admin-b@test.local', 'authenticated', 'authenticated', '{"display_name":"B"}'::jsonb);

INSERT INTO public.households (id, name, created_by)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111', 'Household X', 'aaaaaaa1-1111-1111-1111-111111111111'),
  ('ddddddd2-2222-2222-2222-222222222222', 'Household Y', 'bbbbbbb2-2222-2222-2222-222222222222');

INSERT INTO public.members (household_id, user_id, role)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111', 'aaaaaaa1-1111-1111-1111-111111111111', 'admin'),
  ('ccccccc1-1111-1111-1111-111111111111', 'ccccccc3-3333-3333-3333-333333333333', 'member'),
  ('ccccccc1-1111-1111-1111-111111111111', 'ddddddd4-4444-4444-4444-444444444444', 'member'),
  ('ddddddd2-2222-2222-2222-222222222222', 'bbbbbbb2-2222-2222-2222-222222222222', 'admin');

-- ----------------------------------------------------------------------------
-- 1. Non-admin C CANNOT escalate their own role (column guard raises).
-- ----------------------------------------------------------------------------
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('ccccccc3-3333-3333-3333-333333333333'::uuid);
SELECT throws_ok(
  $$ UPDATE public.members SET role = 'admin'
       WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
         AND user_id = 'ccccccc3-3333-3333-3333-333333333333' $$,
  '23514'::text, NULL::text,
  'non-admin cannot escalate role on their own membership'
);

-- ----------------------------------------------------------------------------
-- 2. Non-admin C CANNOT move their row to another household (column guard).
-- ----------------------------------------------------------------------------
SELECT throws_ok(
  $$ UPDATE public.members SET household_id = 'ddddddd2-2222-2222-2222-222222222222'
       WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
         AND user_id = 'ccccccc3-3333-3333-3333-333333333333' $$,
  '23514'::text, NULL::text,
  'non-admin cannot change household_id on their own membership'
);

-- ----------------------------------------------------------------------------
-- 2b. Non-admin C CANNOT rewrite an audit column (created_at) — allowlist guard.
-- ----------------------------------------------------------------------------
SELECT throws_ok(
  $$ UPDATE public.members SET created_at = now() - interval '10 years'
       WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
         AND user_id = 'ccccccc3-3333-3333-3333-333333333333' $$,
  '23514'::text, NULL::text,
  'non-admin cannot rewrite created_at on their own membership (allowlist)'
);

-- ----------------------------------------------------------------------------
-- 3. Non-admin C CANNOT soft-leave D's row — RLS filters it (0 rows), so D's
--    membership is untouched.
-- ----------------------------------------------------------------------------
UPDATE public.members SET deleted_at = now()
  WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
    AND user_id = 'ddddddd4-4444-4444-4444-444444444444';
SELECT app.reset_jwt_claims();
SELECT is(
  (SELECT deleted_at FROM public.members
     WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
       AND user_id = 'ddddddd4-4444-4444-4444-444444444444'),
  NULL::timestamptz,
  'a non-admin cannot soft-leave another member''s row (RLS filtered)'
);

-- ----------------------------------------------------------------------------
-- 4. The LAST admin (A) still cannot self-leave (enforce_min_one_admin).
-- ----------------------------------------------------------------------------
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid);
SELECT throws_ok(
  $$ UPDATE public.members SET deleted_at = now()
       WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
         AND user_id = 'aaaaaaa1-1111-1111-1111-111111111111' $$,
  'P0001'::text, NULL::text,
  'the last admin cannot self-leave (enforce_min_one_admin still fires)'
);

-- ----------------------------------------------------------------------------
-- 5. Non-admin C CAN soft-leave their OWN row.
-- ----------------------------------------------------------------------------
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('ccccccc3-3333-3333-3333-333333333333'::uuid);
SELECT lives_ok(
  $$ UPDATE public.members SET deleted_at = now()
       WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
         AND user_id = 'ccccccc3-3333-3333-3333-333333333333' $$,
  'a non-admin member can soft-leave their own household'
);
SELECT app.reset_jwt_claims();
SELECT isnt(
  (SELECT deleted_at FROM public.members
     WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
       AND user_id = 'ccccccc3-3333-3333-3333-333333333333'),
  NULL::timestamptz,
  'C''s membership row is now soft-deleted (deleted_at set)'
);

-- ----------------------------------------------------------------------------
-- 5b. A member who has LEFT cannot self-re-admit (clear their own deleted_at):
--     the policy USING (deleted_at IS NULL) leaves the soft-deleted row
--     unreachable for update (UPDATE 0), so leaving is one-directional even if
--     members_select is later broadened. (A former admin re-adding themselves
--     AS admin would otherwise be privilege re-escalation.)
-- ----------------------------------------------------------------------------
SELECT app.set_jwt_claims('ccccccc3-3333-3333-3333-333333333333'::uuid);
UPDATE public.members SET deleted_at = NULL
  WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
    AND user_id = 'ccccccc3-3333-3333-3333-333333333333';
SELECT app.reset_jwt_claims();
SELECT isnt(
  (SELECT deleted_at FROM public.members
     WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
       AND user_id = 'ccccccc3-3333-3333-3333-333333333333'),
  NULL::timestamptz,
  'a member who left cannot self-re-admit (deleted_at stays set)'
);

-- ----------------------------------------------------------------------------
-- 6. Admins keep full write over members (members_admin_write unaffected):
--    A promotes D to admin.
-- ----------------------------------------------------------------------------
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid);
SELECT lives_ok(
  $$ UPDATE public.members SET role = 'admin'
       WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
         AND user_id = 'ddddddd4-4444-4444-4444-444444444444' $$,
  'an admin can still change a member''s role (admin_write path)'
);
SELECT app.reset_jwt_claims();
SELECT is(
  (SELECT role::text FROM public.members
     WHERE household_id = 'ccccccc1-1111-1111-1111-111111111111'
       AND user_id = 'ddddddd4-4444-4444-4444-444444444444'),
  'admin',
  'D was promoted to admin by A'
);

SELECT finish();
ROLLBACK;
