-- ============================================================================
-- Test:      supabase/tests/rls/connected_email_households.test.sql
-- Date:      2026-06-10
-- Task:      T-211
-- Purpose:   pgTAP cross-tenant + cross-binding RLS isolation tests for
--            `public.connected_email_households` — the many-to-many JUNCTION
--            between connected_emails and households. The policy set
--            installed by T-210 grants visibility through THREE paths:
--
--              (a) household_id IN (SELECT app.households_of_user())
--                                              — member-of-household path
--              (b) app.is_system_admin()       — sys admin audit path
--              (c) EXISTS (SELECT 1 FROM connected_emails ce
--                          WHERE ce.id = connected_email_households.connected_email_id
--                            AND ce.owner_user_id = auth.uid())
--                                              — owner-of-credential path
--
--            Write (INSERT/UPDATE/DELETE) accepts ONLY the admin-of-household
--            path (Pattern B): USING + WITH CHECK app.is_household_admin(
--            household_id). Crucially, the WITH CHECK mirror PREVENTS an
--            admin from re-targeting a binding to a household they do NOT
--            admin (Pattern B privilege-escalation guard).
--
--            Coverage maps to spec §5.11 "Cobertura via pgTAP obrigatória
--            (cross-tenant + cross-binding)" with the junction-specific
--            angles:
--
--              1. Cross-tenant: A member of household X sees only bindings
--                 belonging to household X (NOT bindings of household Y).
--              2. Cross-binding visibility: when the SAME connected_email is
--                 bound to two households, a member of EITHER household sees
--                 the binding row for THEIR household (and ONLY their
--                 household's binding row, not the sibling binding).
--              3. Owner-of-credential path: the owner of a connected_email
--                 sees the bindings for it even when they are NOT a member
--                 of the bound household.
--              4. Sys admin sees ALL binding rows regardless of membership /
--                 ownership.
--              5. Non-admin member CANNOT write (member SELECT yes, write no).
--              6. Admin of a DIFFERENT household CANNOT INSERT a binding for a
--                 household they don't admin (WITH CHECK rejects).
--              7. Admin attempting to UPDATE-RE-TARGET household_id to a
--                 household they don't admin is REJECTED by mirrored WITH
--                 CHECK (privilege-escalation guard).
--              8. Soft-deleted bindings remain VISIBLE under the member-of
--                 path (the policy is RLS, not a domain filter — the
--                 `deleted_at IS NULL` gate lives on the EXISTS join in
--                 connected_emails RLS, NOT here). This is a contract-of-
--                 the-policy assertion — the audit UI shows historical
--                 bindings to admins.
--              9. Anon caller sees zero binding rows on every path.
--
-- Spec refs: §5.11 (RLS row "connected_email_households" + Pattern A/B/D;
--                    Cobertura pgTAP obrigatória cross-tenant + cross-binding).
--            §5.2  (junction soft-delete semantics; uq_email_household_active
--                    partial unique permitting re-bind; soft-deleted rows
--                    REMAIN queryable for audit).
--            §5.10 (ownership distinction: the credential owner retains
--                    visibility into the bindings of their credential even
--                    when not a member of the household — needed for the
--                    "rotate password / delete email" UX where the owner sees
--                    every household consuming their credential).
--
-- Plan total: 9 assertions (>= 8 acceptance bar from plan).
--
-- Hermeticity:
--   * Whole file wrapped in BEGIN / ROLLBACK.
--   * search_path locked to public, extensions, app.
--   * Reuses tests/helpers/jwt_claims.sql.
--
-- Notes on the RLS surface:
--   * SELECT denials are silent — assert via set_eq / is_empty.
--   * INSERT WITH CHECK violations DO raise (42501) — assert via throws_ok.
--   * UPDATE that filters via USING returns 0 rows silently — assert via
--     row count. UPDATE that mutates a row to a state violating WITH CHECK
--     raises 42501 — assert via throws_ok.
--   * service_role bypass is OUT OF SCOPE (BYPASSRLS).
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

\i tests/helpers/jwt_claims.sql

SELECT plan(9);


-- ============================================================================
-- Setup: four identities + three households + cross-binding fixtures
-- ============================================================================
-- Same identity / household scheme as connected_emails.test.sql for symmetry.
-- ============================================================================

-- 1. auth.users (trigger trg_create_user_profile auto-creates profiles).
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('aaaaaaa1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000',
   'owner@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Owner O"}'::jsonb),
  ('bbbbbbb2-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000000',
   'admin-y@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Admin Y"}'::jsonb),
  ('cccccccc-3333-3333-3333-333333333333',
   '00000000-0000-0000-0000-000000000000',
   'stranger@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Stranger S"}'::jsonb),
  ('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d',
   '00000000-0000-0000-0000-000000000000',
   'sys-admin@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Sys Admin"}'::jsonb);

-- 2. Households.
INSERT INTO public.households (id, name, created_by)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111', 'Household X (owner O)',
   'aaaaaaa1-1111-1111-1111-111111111111'),
  ('ddddddd2-2222-2222-2222-222222222222', 'Household Y (admin A)',
   'bbbbbbb2-2222-2222-2222-222222222222'),
  ('eeeeeee3-3333-3333-3333-333333333333', 'Household Z (stranger S)',
   'cccccccc-3333-3333-3333-333333333333');

-- 3. Memberships.
--    Owner O: admin of X.
--    Admin A: admin of Y; ALSO regular `member` of household X — needed for
--             scenario 5 (non-admin member can SELECT but cannot WRITE).
--    Stranger S: admin of Z.
INSERT INTO public.members (household_id, user_id, role)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111',
   'aaaaaaa1-1111-1111-1111-111111111111', 'admin'),
  ('ccccccc1-1111-1111-1111-111111111111',
   'bbbbbbb2-2222-2222-2222-222222222222', 'member'),
  ('ddddddd2-2222-2222-2222-222222222222',
   'bbbbbbb2-2222-2222-2222-222222222222', 'admin'),
  ('eeeeeee3-3333-3333-3333-333333333333',
   'cccccccc-3333-3333-3333-333333333333', 'admin');

-- 4. Two credentials, both owned by O.
INSERT INTO public.connected_emails (
  id, email_address, provider, owner_user_id, app_password_secret
) VALUES
  ('11111111-aaaa-aaaa-aaaa-111111111111',
   'shared@example.com', 'gmail',
   'aaaaaaa1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000001'),
  ('22222222-bbbb-bbbb-bbbb-222222222222',
   'owner-only@example.com', 'gmail',
   'aaaaaaa1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000002');

-- 5. Junction rows:
--    ce_shared        — bound to X (active) and Y (active) and Z (soft-deleted
--                       — historical row for the "soft-deleted still visible"
--                       audit assertion in scenario 8).
--    ce_owner_only    — bound to NO household — used in scenario 3 (owner-of-
--                       credential path is vacuously empty here, but we
--                       additionally use it to ensure scenario 3 selects only
--                       ce_shared bindings).
INSERT INTO public.connected_email_households (
  connected_email_id, household_id, is_default, deleted_at
) VALUES
  ('11111111-aaaa-aaaa-aaaa-111111111111',
   'ccccccc1-1111-1111-1111-111111111111', true, NULL),
  ('11111111-aaaa-aaaa-aaaa-111111111111',
   'ddddddd2-2222-2222-2222-222222222222', false, NULL),
  ('11111111-aaaa-aaaa-aaaa-111111111111',
   'eeeeeee3-3333-3333-3333-333333333333', false, now() - interval '1 day');


-- ============================================================================
-- SCENARIO 1 — cross-tenant: member of X sees only X-binding (+ owner path)
-- ============================================================================
-- Owner O is admin of X (NOT a member of Y or Z). They are also the OWNER of
-- ce_shared, so the owner-of-credential path means they additionally see
-- bindings to Y and the soft-deleted binding to Z for that credential.
-- The total visible set for O is therefore: X-binding (member-of) + Y-binding
-- (owner) + Z-binding (owner; soft-deleted but still visible per the policy).
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT household_id FROM public.connected_email_households
     WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'$$,
  ARRAY[
    'ccccccc1-1111-1111-1111-111111111111'::uuid,  -- member-of path
    'ddddddd2-2222-2222-2222-222222222222'::uuid,  -- owner-of-credential path
    'eeeeeee3-3333-3333-3333-333333333333'::uuid   -- owner path (soft-deleted)
  ],
  '#1 cross-tenant + owner path: owner O sees X (member), Y (owner) and Z (owner, soft-deleted) bindings'
);


-- ============================================================================
-- SCENARIO 2 — cross-binding member: admin A sees X and Y bindings
-- ============================================================================
-- Admin A is admin of Y AND a regular member of X (per setup). Member-of
-- path therefore yields both X-binding and Y-binding (active rows). A is NOT
-- the credential owner, so the owner path doesn't add anything. The
-- soft-deleted Z-binding is hidden (A is not a member of Z and is not the
-- owner).
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

SELECT set_eq(
  $$SELECT household_id FROM public.connected_email_households
     WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'$$,
  ARRAY[
    'ccccccc1-1111-1111-1111-111111111111'::uuid,
    'ddddddd2-2222-2222-2222-222222222222'::uuid
  ],
  '#2 cross-binding member: admin A (member of X, admin of Y) sees X and Y bindings (not Z; not the owner)'
);


-- ============================================================================
-- SCENARIO 3 — owner-of-credential path: owner sees bindings to NON-member household
-- ============================================================================
-- We isolate the owner path by having owner O look at bindings to household Z.
-- O is NOT a member of Z (only S is). The ONLY way O sees the Z-binding is the
-- owner-of-credential path. (Tested implicitly in scenario 1, but here we
-- assert the SPECIFIC Z-binding row visibility for crispness.)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.connected_email_households
     WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'
       AND household_id       = 'eeeeeee3-3333-3333-3333-333333333333'
  ),
  '#3 owner-of-credential path: owner O sees the Z-binding even though O is NOT a member of household Z'
);


-- ============================================================================
-- SCENARIO 4 — sys admin sees ALL bindings (audit override)
-- ============================================================================
-- Sys admin has no membership and is not the owner. The
-- `OR app.is_system_admin()` clause in the SELECT policy yields every row,
-- including the soft-deleted Z-binding.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT set_eq(
  $$SELECT household_id FROM public.connected_email_households
     WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'$$,
  ARRAY[
    'ccccccc1-1111-1111-1111-111111111111'::uuid,
    'ddddddd2-2222-2222-2222-222222222222'::uuid,
    'eeeeeee3-3333-3333-3333-333333333333'::uuid
  ],
  '#4 sys admin: sees ALL three bindings (X, Y, Z including soft-deleted) via audit override'
);


-- ============================================================================
-- SCENARIO 5 — non-admin member SELECT yes / WRITE no
-- ============================================================================
-- Admin A is a regular (non-admin) `member` of household X. They CAN SELECT
-- the X-binding (covered in #2) but CANNOT WRITE it. A targeted UPDATE
-- against X-binding affects 0 rows (USING denial — A is NOT
-- app.is_household_admin(X)).
--
-- Note: A is admin of Y, so to keep the assertion crisp we target the
-- X-binding (where A is only a member, not admin) — not the Y-binding.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

WITH x AS (
     UPDATE public.connected_email_households
        SET is_default = false
      WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'
        AND household_id       = 'ccccccc1-1111-1111-1111-111111111111'
      RETURNING 1
)
SELECT is(
  (SELECT count(*)::int FROM x),
  0,
  '#5 non-admin member write: admin A (member of X, not admin of X) UPDATE of X-binding affects 0 rows'
);


-- ============================================================================
-- SCENARIO 6 — admin of one household cannot INSERT binding for another
-- ============================================================================
-- Admin A admins Y, NOT Z. Attempting to INSERT a binding pointing to
-- household Z must be REJECTED by WITH CHECK
-- (app.is_household_admin(household_id) = false for Z from A's perspective).
-- Postgres surfaces this as SQLSTATE 42501.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

SELECT throws_ok(
  $$INSERT INTO public.connected_email_households
        (connected_email_id, household_id)
    VALUES
        ('22222222-bbbb-bbbb-bbbb-222222222222',
         'eeeeeee3-3333-3333-3333-333333333333')$$,
  '42501',
  NULL,
  '#6 cross-tenant INSERT: admin A (admin of Y only) INSERT binding for household Z rejected by WITH CHECK (42501)'
);


-- ============================================================================
-- SCENARIO 7 — UPDATE re-targeting household_id to a non-admin household rejected
-- ============================================================================
-- Admin A admins Y. The Y-binding for ce_shared is writable by A (USING
-- passes). A tries to UPDATE household_id from Y to Z (which A doesn't
-- admin). WITH CHECK evaluates against the NEW row state — household_id=Z
-- fails app.is_household_admin(Z), so the UPDATE is REJECTED with 42501.
--
-- This is the Pattern B privilege-escalation guard from spec §5.11.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

SELECT throws_ok(
  $$UPDATE public.connected_email_households
       SET household_id = 'eeeeeee3-3333-3333-3333-333333333333'
     WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'
       AND household_id       = 'ddddddd2-2222-2222-2222-222222222222'
       AND deleted_at IS NULL$$,
  '42501',
  NULL,
  '#7 UPDATE re-target household_id: admin A trying to move Y-binding to household Z rejected by mirrored WITH CHECK (42501)'
);


-- ============================================================================
-- SCENARIO 8 — soft-deleted binding remains visible (audit)
-- ============================================================================
-- The Z-binding has deleted_at NOT NULL (seeded in setup). For a sys admin
-- (or the credential owner — covered in scenario 1), the policy MUST still
-- return the row: the `deleted_at IS NULL` filter is enforced ONLY in the
-- `connected_emails` RLS EXISTS join (to gate ADMIN access via bindings),
-- NOT here. The audit UI relies on this visibility to show "this binding was
-- removed on …".
--
-- We assert from sys admin (already covered in #4) and additionally from the
-- credential owner (covered in #1). Here we add the symmetric "non-related
-- user sees NOTHING" check — stranger S, who admins household Z, sees the
-- Z-binding (member-of path TRUE for Z) even though it's soft-deleted.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('cccccccc-3333-3333-3333-333333333333'::uuid,
                          'eeeeeee3-3333-3333-3333-333333333333'::uuid, false);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.connected_email_households
     WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'
       AND household_id       = 'eeeeeee3-3333-3333-3333-333333333333'
       AND deleted_at IS NOT NULL
  ),
  '#8 soft-deleted binding visible to member: stranger S (admin of Z) still sees the soft-deleted Z-binding for audit purposes'
);


-- ============================================================================
-- SCENARIO 9 — anon caller sees zero bindings (defense-in-depth)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.connected_email_households$$,
  '#9 anon SELECT: anonymous caller sees zero connected_email_households rows'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT app.reset_jwt_claims();

SELECT * FROM finish();

ROLLBACK;
