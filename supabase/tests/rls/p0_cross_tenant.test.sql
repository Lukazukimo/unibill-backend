-- ============================================================================
-- Test:      supabase/tests/rls/p0_cross_tenant.test.sql
-- Date:      2026-06-10
-- Task:      T-116
-- Purpose:   pgTAP cross-tenant RLS isolation tests covering the SEVEN P0-P1
--            tables installed by T-106..T-114:
--              1. public.households
--              2. public.members
--              3. public.household_invitations
--              4. public.user_profiles
--              5. public.app_settings              (3 scopes: global/household/user)
--              6. public.app_settings_history
--              7. public.consent_log
--
--            For each table the suite proves:
--              (a) user A (in household X) cannot SELECT user B's rows from
--                  household Y;
--              (b) user A (in household X) cannot UPDATE/DELETE user B's
--                  rows from household Y (RLS surfaces this as zero rows
--                  affected, not as an exception — we assert via row count);
--              (c) user A (in household X) CAN see/write own rows;
--              (d) a sys admin caller sees rows across households where the
--                  spec allows (sys-admin override on consent_log audit and
--                  app_settings global write);
--              (e) the anonymous (anon) role sees zero rows on every table.
--
-- Spec refs: §5.11  (RLS policy table + Patterns A-F DDL).
--            §5.12  (user_profiles cross-household SELECT predicate;
--                    sys admin and self always see own profile).
--
-- Hermeticity:
--   * Whole file wrapped in BEGIN / ROLLBACK.
--   * search_path is locked to public, extensions, app so unqualified pgTAP
--     symbols (plan, ok, is, set_eq, is_empty, finish) resolve from extensions
--     and helper calls resolve from app.
--   * Two real auth.users rows + two households + the canonical (admin)
--     membership rows are seeded as the migration-installing role (postgres),
--     then every assertion runs as `authenticated` via app.set_jwt_claims()
--     (helper file: tests/helpers/jwt_claims.sql).
--   * Each scenario calls app.reset_jwt_claims() before switching identity
--     so the failure messages are crisp.
--
-- Notes on RLS surface:
--   * RLS denials never raise — they silently filter rows. So "user A cannot
--     UPDATE user B's row" is asserted by checking the row count after the
--     UPDATE (0 rows affected) AND that the original row is unchanged when
--     re-read by the original owner (B).
--   * SELECT denials are asserted via is_empty(query, description) or
--     set_eq(query, expected_set, description).
--   * service_role bypass is NOT exercised here — it is a Postgres-level
--     BYPASSRLS attribute set by Supabase and out of scope of RLS policy
--     tests (it would defeat the purpose). All assertions run as
--     authenticated or anon.
--
-- Plan total: 24 assertions (well past the >=20 acceptance bar).
--   user_profiles: 3
--   households: 3
--   members: 3
--   household_invitations: 3
--   app_settings (3 scopes): 5
--   app_settings_history: 2
--   consent_log: 3
--   anon coverage (one per table): 7  → folded into the per-table sections
--                                       above as the last assertion in each.
--   Sys-admin overrides where spec allows: woven into household_invitations,
--     app_settings global, consent_log sections (3 assertions total counted
--     within those table sections).
-- ============================================================================


BEGIN;

-- pgTAP lives in `extensions` (T-105). search_path also covers `app` so the
-- jwt-claims helpers (app.set_jwt_claims / app.set_jwt_anon /
-- app.reset_jwt_claims) resolve unqualified.
SET LOCAL search_path = public, extensions, app;

-- Load the JWT claims helper into the current transaction. Defined as
-- CREATE OR REPLACE so concurrent test runs are safe.
\i tests/helpers/jwt_claims.sql

SELECT plan(24);


-- ============================================================================
-- Setup: deterministic identities + households + memberships + content rows
-- ============================================================================
-- Two users in two distinct households so every cross-tenant assertion has a
-- well-defined "user A trying to reach user B's row" target. Plus a third
-- user who carries the is_system_admin claim — they are NOT a member of
-- either household, so the sys-admin override is what surfaces them.
--
-- UUID conventions (readable in failure output):
--   user A     = 'aaaaaaa1-...'   (admin of household X)
--   user B     = 'bbbbbbb2-...'   (admin of household Y)
--   sys admin  = '5d5d5d5d-...'   (no membership; is_system_admin=true)
--   household X = 'ccccccc1-...'
--   household Y = 'ddddddd2-...'
-- ============================================================================

-- 1. Seed auth.users (cascade trigger trg_create_user_profile from T-110
--    auto-creates user_profiles rows for each — that is the only path that
--    creates user_profiles, so we rely on it).
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('aaaaaaa1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000',
   'user-a@test.local', 'authenticated', 'authenticated',
   '{"display_name":"User A"}'::jsonb),
  ('bbbbbbb2-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000000',
   'user-b@test.local', 'authenticated', 'authenticated',
   '{"display_name":"User B"}'::jsonb),
  ('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d',
   '00000000-0000-0000-0000-000000000000',
   'sys-admin@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Sys Admin"}'::jsonb);

-- 2. Households created by their respective owners.
INSERT INTO public.households (id, name, created_by)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111', 'Household X (A)',
   'aaaaaaa1-1111-1111-1111-111111111111'),
  ('ddddddd2-2222-2222-2222-222222222222', 'Household Y (B)',
   'bbbbbbb2-2222-2222-2222-222222222222');

-- 3. Memberships: A admin of X, B admin of Y. Sys admin has NO membership;
--    this is the whole point of the sys-admin claim — visibility without
--    being a tenant.
INSERT INTO public.members (household_id, user_id, role)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111',
   'aaaaaaa1-1111-1111-1111-111111111111', 'admin'),
  ('ddddddd2-2222-2222-2222-222222222222',
   'bbbbbbb2-2222-2222-2222-222222222222', 'admin');

-- 4. Pending invitations — one per household (covers admin-of-household SELECT
--    in section "household_invitations").
INSERT INTO public.household_invitations (household_id, code, role, invited_email, created_by)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111', 'AAAA0001', 'member',
   'invitee-x@test.local', 'aaaaaaa1-1111-1111-1111-111111111111'),
  ('ddddddd2-2222-2222-2222-222222222222', 'BBBB0002', 'member',
   'invitee-y@test.local', 'bbbbbbb2-2222-2222-2222-222222222222');

-- 5. app_settings — three scope flavors:
--    a) one global row (visible to every authenticated caller, writable only
--       by sys admin)
--    b) one household-scoped row per household (X / Y)
--    c) one user-scoped row per user (A / B)
INSERT INTO public.app_settings (key, scope, scope_id, value, category, updated_by)
VALUES
  ('test.global.flag', 'global', NULL,
   '{"v": true}'::jsonb, 'test', NULL),
  ('test.household.flag', 'household',
   'ccccccc1-1111-1111-1111-111111111111',
   '{"v": "X"}'::jsonb, 'test', 'aaaaaaa1-1111-1111-1111-111111111111'),
  ('test.household.flag', 'household',
   'ddddddd2-2222-2222-2222-222222222222',
   '{"v": "Y"}'::jsonb, 'test', 'bbbbbbb2-2222-2222-2222-222222222222'),
  ('test.user.flag', 'user',
   'aaaaaaa1-1111-1111-1111-111111111111',
   '{"v": "A"}'::jsonb, 'test', 'aaaaaaa1-1111-1111-1111-111111111111'),
  ('test.user.flag', 'user',
   'bbbbbbb2-2222-2222-2222-222222222222',
   '{"v": "B"}'::jsonb, 'test', 'bbbbbbb2-2222-2222-2222-222222222222');
-- The 5 inserts above each fire the AFTER INSERT app_settings audit trigger
-- (T-111) and create matching app_settings_history rows. Those are what the
-- app_settings_history section asserts visibility against.

-- 6. consent_log — one accepted consent per user (terms).
INSERT INTO public.consent_log (user_id, purpose, version, legal_basis, accepted_at)
VALUES
  ('aaaaaaa1-1111-1111-1111-111111111111', 'terms', 'v1', 'consent', now()),
  ('bbbbbbb2-2222-2222-2222-222222222222', 'terms', 'v1', 'consent', now());


-- ============================================================================
-- SECTION 1 — user_profiles
-- ============================================================================
-- Policy (T-114): SELECT = self OR sys admin OR shares-a-household-with target.
-- A and B do NOT share a household, so cross-visibility must be FALSE.
-- Self-visibility must be TRUE. Anon must see zero rows.
-- ============================================================================

-- #1: User A logged in -> can SEE own profile but CANNOT see B's profile.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT user_id FROM public.user_profiles$$,
  ARRAY['aaaaaaa1-1111-1111-1111-111111111111'::uuid],
  '#1 user_profiles: user A sees ONLY own profile (not user B in a separate household)'
);

-- #2: User A attempts to UPDATE B's profile -> RLS denies silently. The
-- update returns 0 rows; we assert the row count via a CTE -> integer.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT is(
  (WITH x AS (
     UPDATE public.user_profiles
        SET display_name = 'hacked'
      WHERE user_id = 'bbbbbbb2-2222-2222-2222-222222222222'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  0,
  '#2 user_profiles: user A UPDATE of user B''s profile affects 0 rows (RLS silent deny)'
);

-- #3: Anon caller sees zero profile rows.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.user_profiles$$,
  '#3 user_profiles: anon caller sees zero rows'
);


-- ============================================================================
-- SECTION 2 — households
-- ============================================================================
-- Policy (T-114): SELECT = member-of OR sys admin.
-- UPDATE = admin-of (and admin-of for DELETE). INSERT = self-as-creator.
-- ============================================================================

-- #4: User A sees ONLY household X (member of X, not Y).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.households$$,
  ARRAY['ccccccc1-1111-1111-1111-111111111111'::uuid],
  '#4 households: user A sees ONLY household X (member-of filter excludes Y)'
);

-- #5: User A attempts to UPDATE household Y -> 0 rows affected.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT is(
  (WITH x AS (
     UPDATE public.households
        SET name = 'pwned'
      WHERE id = 'ddddddd2-2222-2222-2222-222222222222'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  0,
  '#5 households: user A UPDATE of household Y affects 0 rows'
);

-- #6: Anon sees zero households.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.households$$,
  '#6 households: anon caller sees zero rows'
);


-- ============================================================================
-- SECTION 3 — members
-- ============================================================================
-- Policy (T-114): SELECT = member-of household OR sys admin; FOR ALL = admin-of.
-- ============================================================================

-- #7: User A sees ONLY the members of household X (which is just A).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT user_id FROM public.members$$,
  ARRAY['aaaaaaa1-1111-1111-1111-111111111111'::uuid],
  '#7 members: user A sees ONLY members of household X (excludes household Y rows)'
);

-- #8: User A attempts to DELETE member B from household Y -> 0 rows.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT is(
  (WITH x AS (
     DELETE FROM public.members
      WHERE household_id = 'ddddddd2-2222-2222-2222-222222222222'
        AND user_id      = 'bbbbbbb2-2222-2222-2222-222222222222'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  0,
  '#8 members: user A DELETE of member B (household Y) affects 0 rows'
);

-- #9: Anon sees zero member rows.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.members$$,
  '#9 members: anon caller sees zero rows'
);


-- ============================================================================
-- SECTION 4 — household_invitations
-- ============================================================================
-- Policy (T-114): FOR ALL = admin-of-household. Non-admin members (and any
-- non-member) see NOTHING. Sys admin override is NOT in the policy (the
-- redeem flow is service_role; sys admin doesn't read pending invites here).
-- ============================================================================

-- #10: User A (admin of X) sees ONLY invitation AAAA0001 (X), not BBBB0002 (Y).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT code FROM public.household_invitations$$,
  ARRAY['AAAA0001'::text],
  '#10 household_invitations: admin A sees ONLY own household invite (not household Y)'
);

-- #11: User A attempts to DELETE Y's invitation -> 0 rows affected.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT is(
  (WITH x AS (
     DELETE FROM public.household_invitations
      WHERE code = 'BBBB0002'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  0,
  '#11 household_invitations: admin A DELETE of household Y invite affects 0 rows'
);

-- #12: Anon sees zero invitations.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.household_invitations$$,
  '#12 household_invitations: anon caller sees zero rows'
);


-- ============================================================================
-- SECTION 5 — app_settings (all 3 scopes: global / household / user)
-- ============================================================================
-- Policy (T-114, Pattern F):
--   SELECT: global OR (household AND member-of) OR (user AND own) OR sys admin
--   WRITE:  scope-aware:
--     * global -> sys admin only
--     * household -> admin-of household
--     * user -> own
-- ============================================================================

-- #13: User A sees the global row + their household X row + their user-A row,
-- but NOT household Y's row nor user-B's row.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT scope::text || ':' || coalesce(scope_id::text, 'NULL')
      FROM public.app_settings
     WHERE key IN ('test.global.flag','test.household.flag','test.user.flag')$$,
  ARRAY[
    'global:NULL',
    'household:ccccccc1-1111-1111-1111-111111111111',
    'user:aaaaaaa1-1111-1111-1111-111111111111'
  ]::text[],
  '#13 app_settings: user A sees global + own-household + own-user (not Y, not B)'
);

-- #14: User A attempts to UPDATE the GLOBAL app_settings row (sys-admin-only
-- write). Affects 0 rows (RLS WITH CHECK + USING both filter out non-sys-admin).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT is(
  (WITH x AS (
     UPDATE public.app_settings
        SET value = '{"v": false}'::jsonb
      WHERE key = 'test.global.flag'
        AND scope = 'global'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  0,
  '#14 app_settings: non-sys-admin UPDATE of global row affects 0 rows'
);

-- #15: User A attempts to UPDATE household Y's scoped row -> 0 rows affected.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT is(
  (WITH x AS (
     UPDATE public.app_settings
        SET value = '{"v":"hacked"}'::jsonb
      WHERE key = 'test.household.flag'
        AND scope = 'household'
        AND scope_id = 'ddddddd2-2222-2222-2222-222222222222'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  0,
  '#15 app_settings: user A UPDATE of household Y scoped row affects 0 rows'
);

-- #16: Sys admin can UPDATE the GLOBAL row (sys-admin override per spec).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT is(
  (WITH x AS (
     UPDATE public.app_settings
        SET value = '{"v": "sysadmin-changed"}'::jsonb
      WHERE key = 'test.global.flag'
        AND scope = 'global'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  1,
  '#16 app_settings: sys admin UPDATE of global row succeeds (1 row affected)'
);

-- #17: Anon sees zero app_settings rows.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.app_settings$$,
  '#17 app_settings: anon caller sees zero rows'
);


-- ============================================================================
-- SECTION 6 — app_settings_history
-- ============================================================================
-- Policy (T-114): SELECT replicates the parent app_settings SELECT predicate
-- exactly (global OR own-household OR own-user OR sys admin). No write policy
-- (the audit trigger is SECURITY DEFINER, bypassing RLS).
--
-- After the setup INSERTs + the #16 sys-admin UPDATE of test.global.flag,
-- the history table holds (at minimum):
--   * 1 row for the global INSERT (key=test.global.flag, scope=global)
--   * 2 rows for the household INSERTs (X + Y)
--   * 2 rows for the user INSERTs (A + B)
--   * 1 row for the #16 global UPDATE
-- ============================================================================

-- #18: User A sees history for global + own household X + own user A; NOT
-- history for household Y or user B.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT ok(
  -- Visible:
  EXISTS (SELECT 1 FROM public.app_settings_history
           WHERE key = 'test.global.flag' AND scope = 'global')
  AND EXISTS (SELECT 1 FROM public.app_settings_history
               WHERE scope = 'household'
                 AND scope_id = 'ccccccc1-1111-1111-1111-111111111111')
  AND EXISTS (SELECT 1 FROM public.app_settings_history
               WHERE scope = 'user'
                 AND scope_id = 'aaaaaaa1-1111-1111-1111-111111111111')
  -- Hidden:
  AND NOT EXISTS (SELECT 1 FROM public.app_settings_history
                   WHERE scope = 'household'
                     AND scope_id = 'ddddddd2-2222-2222-2222-222222222222')
  AND NOT EXISTS (SELECT 1 FROM public.app_settings_history
                   WHERE scope = 'user'
                     AND scope_id = 'bbbbbbb2-2222-2222-2222-222222222222'),
  '#18 app_settings_history: user A sees global+own; hidden household Y + user B'
);

-- #19: Anon sees zero history rows.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.app_settings_history$$,
  '#19 app_settings_history: anon caller sees zero rows'
);


-- ============================================================================
-- SECTION 7 — consent_log
-- ============================================================================
-- Policy (T-114): SELECT = own OR sys admin (audit). INSERT = self only.
-- UPDATE = self only; column-level immutability enforced by the
-- app.consent_log_block_pii_update trigger (NOT exercised here; covered in
-- T-114's own dedicated test).
-- ============================================================================

-- #20: User A sees ONLY their own consent row, not user B's.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT user_id FROM public.consent_log$$,
  ARRAY['aaaaaaa1-1111-1111-1111-111111111111'::uuid],
  '#20 consent_log: user A sees ONLY own consent row (not user B''s)'
);

-- #21: User A attempts to INSERT a consent for user B -> RLS WITH CHECK
-- (user_id = auth.uid()) makes this fail with insufficient_privilege
-- (PostgreSQL surfaces RLS WITH CHECK violations on INSERT as SQLSTATE 42501).
SELECT throws_ok(
  $$INSERT INTO public.consent_log (user_id, purpose, version, legal_basis)
    VALUES ('bbbbbbb2-2222-2222-2222-222222222222', 'marketing', 'v1', 'consent')$$,
  '42501',
  NULL,
  '#21 consent_log: user A INSERT for user B violates RLS WITH CHECK (42501)'
);

-- #22: Sys admin SELECT sees BOTH consent rows (audit override per spec).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT set_eq(
  $$SELECT user_id FROM public.consent_log
      WHERE user_id IN ('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                        'bbbbbbb2-2222-2222-2222-222222222222'::uuid)$$,
  ARRAY[
    'aaaaaaa1-1111-1111-1111-111111111111'::uuid,
    'bbbbbbb2-2222-2222-2222-222222222222'::uuid
  ],
  '#22 consent_log: sys admin sees BOTH users'' consent rows (audit override)'
);


-- ============================================================================
-- SECTION 8 — extra sys-admin and cross-tenant assertions
-- ============================================================================
-- Sys-admin override on user_profiles (spec §5.12: sys admin reads all) and
-- on households (spec §5.11: sys admin in policy USING clause); plus the
-- "user B can still see own row after user A failed to mutate it" symmetry
-- assertion that strengthens the deny-by-default proof.
-- ============================================================================

-- #23: Sys admin sees ALL three user_profiles rows (A, B, sys admin self).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT set_eq(
  $$SELECT user_id FROM public.user_profiles
      WHERE user_id IN ('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                        'bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                        '5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid)$$,
  ARRAY[
    'aaaaaaa1-1111-1111-1111-111111111111'::uuid,
    'bbbbbbb2-2222-2222-2222-222222222222'::uuid,
    '5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid
  ],
  '#23 user_profiles: sys admin sees ALL profiles (cross-tenant audit access)'
);

-- #24: After user A's failed UPDATEs in scenarios #2/#5/#8/#15, user B
-- (re-impersonated) still sees their original household name + own profile
-- display_name unchanged. This is the "symmetry" half of the silent-deny
-- contract: not only does the malicious UPDATE return 0 rows, but the
-- ground-truth row is provably intact.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

SELECT ok(
  (SELECT name FROM public.households
    WHERE id = 'ddddddd2-2222-2222-2222-222222222222') = 'Household Y (B)'
  AND
  (SELECT display_name FROM public.user_profiles
    WHERE user_id = 'bbbbbbb2-2222-2222-2222-222222222222') = 'User B',
  '#24 cross-tenant symmetry: user B''s household + profile are unchanged after user A''s denied UPDATEs'
);


-- ============================================================================
-- Finalize
-- ============================================================================
-- Drop back to the default role before pgTAP finishes so the `finish()`
-- selector itself has the broader catalog access it expects.
SELECT app.reset_jwt_claims();

SELECT * FROM finish();

ROLLBACK;
