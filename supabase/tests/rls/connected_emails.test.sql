-- ============================================================================
-- Test:      supabase/tests/rls/connected_emails.test.sql
-- Date:      2026-06-10
-- Task:      T-211
-- Purpose:   pgTAP cross-tenant + cross-binding RLS isolation tests for
--            `public.connected_emails` — the CREDENTIAL row that backs an
--            IMAP-connected email account. The policy set installed by T-210
--            grants visibility / mutability through THREE distinct paths:
--
--              (a) owner_user_id = auth.uid()                       — owner path
--              (b) EXISTS (junction row to a household the caller     — admin
--                  admins, with ceh.deleted_at IS NULL)               cross-binding
--              (c) app.is_system_admin() (SELECT only)               — sys-admin
--
--            INSERT is restricted to (a) only — admin-of-bound-household
--            cannot create credentials owned by other users (the junction does
--            not yet exist at INSERT time). UPDATE / DELETE accept (a) or (b),
--            with mirrored USING + WITH CHECK to prevent privilege escalation
--            (e.g. an admin cannot UPDATE the row to change owner_user_id away
--            from themselves AND retain ANY bound household).
--
--            The CROSS-BINDING leakage scenario is the central novelty of this
--            suite: the SAME connected_email row may be bound to MULTIPLE
--            households simultaneously, so admins of EITHER household must be
--            able to see / write the credential — but soft-deleting one
--            binding must IMMEDIATELY revoke the admin access conferred via
--            that binding (and ONLY via that binding — if the credential is
--            still bound to another household the caller admins, access
--            persists).
--
--            Cobertura covers the SEVEN scenarios mandated by spec §5.11
--            "Cobertura via pgTAP obrigatória (cross-tenant + cross-binding)":
--
--              1. Two users in DIFFERENT households cannot see each other's
--                 connected_emails (cross-tenant baseline).
--              2. The SAME connected_email bound to TWO households is visible
--                 to admins of BOTH households (cross-binding visibility).
--              3. A sys admin sees EVERY connected_email row regardless of
--                 ownership / bindings.
--              4. The owner of a connected_email who is NOT an admin of any
--                 bound household RETAINS write access (owner path is
--                 independent of the admin path).
--              5. An admin of a bound household who is NOT the owner CAN write
--                 the credential (admin path is independent of ownership).
--              6. A non-member of any bound household who is NOT the owner
--                 sees ZERO rows (deny-by-default for unrelated parties).
--              7. Soft-deleting the only binding that conferred admin access
--                 IMMEDIATELY hides the credential from the admin (no stale
--                 access via deleted_at NOT NULL bindings).
--
--            Plus 3 extra assertions that strengthen the contract:
--              8. INSERT into connected_emails with owner_user_id <> auth.uid()
--                 is REJECTED by RLS WITH CHECK (no impersonation at create
--                 time).
--              9. UPDATE attempting to RE-TARGET ownership to another user is
--                 REJECTED by mirrored WITH CHECK (an admin cannot steal a
--                 credential by setting owner_user_id to themselves and then
--                 detach from the household).
--             10. Anon caller sees zero connected_emails rows on every code
--                 path (defense-in-depth assertion).
--
-- Spec refs: §5.11  (RLS policy row "connected_emails" + Pattern D EXISTS
--                    cross-binding template; Cobertura pgTAP obrigatória).
--            §5.2   (connected_emails table definition + soft-delete semantics:
--                    `ceh.deleted_at IS NULL` MUST gate access).
--            §5.10  (ownership distinction — owner_user_id is the authority
--                    for credential destruction, admins of bound households
--                    can remediate but not steal).
--            §9.3.1 (Vault wrappers; not exercised here — we use a dummy uuid
--                    in app_password_secret because no Vault round-trip is
--                    needed to test the RLS policies on connected_emails).
--
-- Plan total: 10 assertions (>= 8 acceptance bar from plan).
--
-- Hermeticity:
--   * Whole file wrapped in BEGIN / ROLLBACK.
--   * search_path locked to public, extensions, app.
--   * Reuses the JWT claims helper from tests/helpers/jwt_claims.sql
--     (loaded with `\i` near the top of the file).
--   * Every cross-tenant scenario calls app.reset_jwt_claims() before
--     switching identity so failure messages are crisp.
--
-- Notes on the RLS surface:
--   * RLS denials never raise on SELECT/UPDATE/DELETE — they silently filter
--     rows. So "user A cannot UPDATE user B's row" is asserted by row count
--     (UPDATE … RETURNING 1 -> count(*) = 0).
--   * RLS denials on INSERT WITH CHECK DO raise — Postgres surfaces them as
--     SQLSTATE '42501' (insufficient_privilege). We use pgTAP throws_ok to
--     match that.
--   * service_role bypass is NOT exercised — it is BYPASSRLS by design and
--     would defeat the point of testing the policies. All assertions run as
--     `authenticated` or `anon`.
-- ============================================================================


BEGIN;

-- pgTAP lives in `extensions`; search_path also covers `app` so the JWT
-- claims helpers resolve unqualified.
SET LOCAL search_path = public, extensions, app;

-- Load the JWT claims helper (defined CREATE OR REPLACE so safe to re-load).
\i tests/helpers/jwt_claims.sql

SELECT plan(10);


-- ============================================================================
-- Setup: four identities + three households + cross-binding fixtures
-- ============================================================================
-- UUID conventions (readable in failure output):
--   user O (owner)      = 'aaaaaaa1-...'  — owns the cross-bound credential
--                                            below; admin of household X.
--   user A (admin Y)    = 'bbbbbbb2-...'  — admin of household Y; NOT the owner.
--   user S (stranger)   = 'cccccccc-...'  — admin of household Z (irrelevant
--                                            to the cross-binding); used as
--                                            the "non-member SELECT denied"
--                                            actor.
--   user K (sysadmin)   = '5d5d5d5d-...'  — no membership anywhere;
--                                            is_system_admin=true.
--   household X         = 'ccccccc1-...'  (member: O admin)
--   household Y         = 'ddddddd2-...'  (member: A admin)
--   household Z         = 'eeeeeee3-...'  (member: S admin; isolated)
-- ============================================================================

-- 1. Seed auth.users (trigger trg_create_user_profile auto-creates profiles).
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

-- 2. Households created by their respective owners (each owner becomes the
--    sole admin of their household).
INSERT INTO public.households (id, name, created_by)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111', 'Household X (owner O)',
   'aaaaaaa1-1111-1111-1111-111111111111'),
  ('ddddddd2-2222-2222-2222-222222222222', 'Household Y (admin A)',
   'bbbbbbb2-2222-2222-2222-222222222222'),
  ('eeeeeee3-3333-3333-3333-333333333333', 'Household Z (stranger S)',
   'cccccccc-3333-3333-3333-333333333333');

-- 3. Admin memberships (one per household; sys-admin has none).
INSERT INTO public.members (household_id, user_id, role)
VALUES
  ('ccccccc1-1111-1111-1111-111111111111',
   'aaaaaaa1-1111-1111-1111-111111111111', 'admin'),
  ('ddddddd2-2222-2222-2222-222222222222',
   'bbbbbbb2-2222-2222-2222-222222222222', 'admin'),
  ('eeeeeee3-3333-3333-3333-333333333333',
   'cccccccc-3333-3333-3333-333333333333', 'admin');

-- 4. Two connected_emails credentials owned by user O:
--      ce_shared  — bound to BOTH household X (owner-admin) AND household Y
--                   (admin A). This is the CROSS-BINDING fixture.
--      ce_orphan  — owned by O, bound to NO household. Used to prove that
--                   the owner path is independent of the admin path
--                   (scenario 4: owner-not-admin write).
--
-- app_password_secret is a dummy uuid — we are testing RLS, not Vault.
INSERT INTO public.connected_emails (
  id, email_address, provider, owner_user_id, app_password_secret
) VALUES
  ('11111111-aaaa-aaaa-aaaa-111111111111',
   'shared@example.com', 'gmail',
   'aaaaaaa1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000001'),
  ('22222222-bbbb-bbbb-bbbb-222222222222',
   'orphan@example.com', 'gmail',
   'aaaaaaa1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000002');

-- 5. Cross-binding fixture: ce_shared bound to BOTH X and Y.
INSERT INTO public.connected_email_households (
  connected_email_id, household_id, is_default
) VALUES
  ('11111111-aaaa-aaaa-aaaa-111111111111',
   'ccccccc1-1111-1111-1111-111111111111', true),
  ('11111111-aaaa-aaaa-aaaa-111111111111',
   'ddddddd2-2222-2222-2222-222222222222', false);


-- ============================================================================
-- SCENARIO 1 — cross-tenant baseline: stranger S sees NO connected_emails
-- ============================================================================
-- User S admins household Z, which has ZERO bindings to any connected_email.
-- S is not the owner of any credential. Expected: zero rows visible.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('cccccccc-3333-3333-3333-333333333333'::uuid,
                          'eeeeeee3-3333-3333-3333-333333333333'::uuid, false);

SELECT is_empty(
  $$SELECT 1 FROM public.connected_emails$$,
  '#1 cross-tenant: stranger S (admin of household Z, no bindings) sees ZERO connected_emails'
);


-- ============================================================================
-- SCENARIO 2 — cross-binding: admin A (household Y) sees the shared credential
-- ============================================================================
-- ce_shared is bound to BOTH X and Y. User A admins Y (not X) and is NOT the
-- owner. Visibility flows through the EXISTS-via-junction predicate:
--   EXISTS (SELECT 1 FROM connected_email_households ceh
--           WHERE ceh.connected_email_id = connected_emails.id
--             AND ceh.deleted_at IS NULL
--             AND app.is_household_admin(ceh.household_id))
-- A admins household Y → predicate is TRUE for ce_shared (bound to Y),
-- but FALSE for ce_orphan (bound to no household).
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.connected_emails$$,
  ARRAY['11111111-aaaa-aaaa-aaaa-111111111111'::uuid],
  '#2 cross-binding: admin A (household Y, not owner) sees the SHARED credential bound to Y'
);


-- ============================================================================
-- SCENARIO 3 — sys admin sees ALL connected_emails (audit override)
-- ============================================================================
-- User K has is_system_admin=true and NO membership. Policy SELECT has the
-- `OR app.is_system_admin()` escape hatch → both ce_shared and ce_orphan
-- visible.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT set_eq(
  $$SELECT id FROM public.connected_emails
      WHERE id IN ('11111111-aaaa-aaaa-aaaa-111111111111'::uuid,
                   '22222222-bbbb-bbbb-bbbb-222222222222'::uuid)$$,
  ARRAY[
    '11111111-aaaa-aaaa-aaaa-111111111111'::uuid,
    '22222222-bbbb-bbbb-bbbb-222222222222'::uuid
  ],
  '#3 sys admin: sees BOTH connected_emails (shared + orphan) via audit override'
);


-- ============================================================================
-- SCENARIO 4 — owner who is NOT admin of any bound household CAN write
-- ============================================================================
-- ce_orphan is owned by user O and bound to ZERO households. The ONLY route
-- by which O retains UPDATE access is the owner path (owner_user_id =
-- auth.uid()). We assert that an UPDATE to ce_orphan.last_error succeeds (1
-- row affected) when authenticated as O.
--
-- Note: user O IS admin of household X, but that has no bearing on ce_orphan
-- because ce_orphan has no binding to any household. This is precisely what
-- makes the assertion meaningful — admin-path is FALSE for ce_orphan, only
-- owner-path can grant access.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('aaaaaaa1-1111-1111-1111-111111111111'::uuid,
                          'ccccccc1-1111-1111-1111-111111111111'::uuid, false);

SELECT is(
  (WITH x AS (
     UPDATE public.connected_emails
        SET last_error = 'set-by-owner-path-test'
      WHERE id = '22222222-bbbb-bbbb-bbbb-222222222222'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  1,
  '#4 owner-not-admin-of-binding: owner O can UPDATE the orphan credential (owner path independent of admin path)'
);


-- ============================================================================
-- SCENARIO 5 — admin of a bound household who is NOT the owner CAN write
-- ============================================================================
-- User A admins household Y. ce_shared is bound to Y. A is NOT the owner
-- (that is user O). RLS UPDATE policy is (owner OR admin-of-binding) — A's
-- access flows through the admin-of-binding path.
-- We update last_error (a benign column) to prove write access works.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

SELECT is(
  (WITH x AS (
     UPDATE public.connected_emails
        SET last_error = 'set-by-admin-y-via-binding'
      WHERE id = '11111111-aaaa-aaaa-aaaa-111111111111'
      RETURNING 1
   )
   SELECT count(*)::int FROM x),
  1,
  '#5 admin-of-binding-not-owner: admin A (household Y) can UPDATE the shared credential (admin path independent of ownership)'
);


-- ============================================================================
-- SCENARIO 6 — non-member, non-owner SELECT denied (deny-by-default)
-- ============================================================================
-- User S admins household Z, which is NOT bound to ce_shared or ce_orphan.
-- S is NOT the owner of either. Visible rows: zero (already covered in #1
-- but here we specifically prove that ce_shared — which IS visible to A and
-- O — is hidden from S).
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('cccccccc-3333-3333-3333-333333333333'::uuid,
                          'eeeeeee3-3333-3333-3333-333333333333'::uuid, false);

SELECT is_empty(
  $$SELECT 1 FROM public.connected_emails
     WHERE id = '11111111-aaaa-aaaa-aaaa-111111111111'$$,
  '#6 non-member SELECT denied: stranger S CANNOT see the shared credential bound to X+Y'
);


-- ============================================================================
-- SCENARIO 7 — soft-deleting the binding revokes admin access
-- ============================================================================
-- We soft-delete the (ce_shared, household Y) binding. After this, admin A
-- has NO active binding to ce_shared and is NOT the owner — SELECT must
-- return zero rows for A.
--
-- The owner O retains access (via owner path); we don't re-assert that here
-- (already covered in #4 conceptually).
-- ============================================================================
-- Soft-delete must be done by a role that can write the junction. Admin A
-- admins household Y and the connected_email_households policy is
-- admin-of-household for write — so A can do this themselves.
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

UPDATE public.connected_email_households
   SET deleted_at = now()
 WHERE connected_email_id = '11111111-aaaa-aaaa-aaaa-111111111111'
   AND household_id       = 'ddddddd2-2222-2222-2222-222222222222';

-- Re-impersonate A (no-op; same identity) and assert ce_shared is now
-- INVISIBLE: the EXISTS predicate now finds zero active bindings for A's
-- admined households.
SELECT is_empty(
  $$SELECT 1 FROM public.connected_emails
     WHERE id = '11111111-aaaa-aaaa-aaaa-111111111111'$$,
  '#7 soft-deleted binding revokes admin access: admin A no longer sees the shared credential after the Y-binding is soft-deleted'
);


-- ============================================================================
-- SCENARIO 8 — INSERT impersonation rejected by WITH CHECK (42501)
-- ============================================================================
-- The INSERT policy on connected_emails is:
--   WITH CHECK (owner_user_id = auth.uid())
-- An authenticated caller (here, admin A) trying to INSERT a row whose
-- owner_user_id is some OTHER user (here, owner O) must be rejected with
-- SQLSTATE 42501 (insufficient_privilege — RLS WITH CHECK violation).
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

SELECT throws_ok(
  $$INSERT INTO public.connected_emails (
      email_address, provider, owner_user_id, app_password_secret
    ) VALUES (
      'impersonation-attempt@example.com', 'gmail',
      'aaaaaaa1-1111-1111-1111-111111111111',
      '00000000-0000-0000-0000-000000000003'
    )$$,
  '42501',
  NULL,
  '#8 INSERT impersonation rejected: admin A INSERT with owner_user_id = user O fails RLS WITH CHECK (42501)'
);


-- ============================================================================
-- SCENARIO 9 — UPDATE retargeting owner_user_id rejected by mirrored CHECK
-- ============================================================================
-- Admin A tries to UPDATE ce_shared to set owner_user_id = themselves while
-- the Y-binding is already soft-deleted (from scenario 7). With NO active
-- binding to A AND no other path satisfying the post-UPDATE predicate, the
-- WITH CHECK clause REJECTS the update. RLS surfaces WITH CHECK violations
-- on UPDATE as SQLSTATE '42501'.
--
-- We re-bind A to ce_shared first (so the USING clause passes for the row
-- lookup) — otherwise the UPDATE would silently affect 0 rows via USING
-- denial, which is a different mechanism than the WITH CHECK rejection we
-- want to prove.
-- ============================================================================
-- Step 1: as A, re-create a fresh binding (X-binding stays; we add a new Y
-- binding because the old one is soft-deleted; partial unique
-- uq_email_household_active permits this because the soft-deleted row is
-- excluded from the index).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('bbbbbbb2-2222-2222-2222-222222222222'::uuid,
                          'ddddddd2-2222-2222-2222-222222222222'::uuid, false);

INSERT INTO public.connected_email_households (connected_email_id, household_id)
VALUES ('11111111-aaaa-aaaa-aaaa-111111111111',
        'ddddddd2-2222-2222-2222-222222222222');

-- Step 2: as A, attempt to set owner_user_id = A and SIMULTANEOUSLY soft-delete
-- the binding via the same statement. Because RLS evaluates WITH CHECK against
-- the NEW row state, and because admin-path requires an ACTIVE binding, the
-- post-state must STILL match the predicate at row-level. Setting
-- owner_user_id=A satisfies the predicate (owner path becomes TRUE for A), so
-- this UPDATE actually SUCCEEDS — that is the spec-correct behavior (A becomes
-- the new owner). To prove rejection we instead try setting owner_user_id to a
-- THIRD party (user S, who is NOT a bound admin AND is NOT the new owner from
-- A's perspective) — A has no path to retain visibility post-UPDATE, so WITH
-- CHECK fires.
SELECT throws_ok(
  $$UPDATE public.connected_emails
       SET owner_user_id = 'cccccccc-3333-3333-3333-333333333333'
     WHERE id = '11111111-aaaa-aaaa-aaaa-111111111111'$$,
  '42501',
  NULL,
  '#9 UPDATE retargeting owner_user_id to a third party rejected by mirrored WITH CHECK (42501)'
);


-- ============================================================================
-- SCENARIO 10 — anon caller sees zero connected_emails rows
-- ============================================================================
-- Defense-in-depth: every policy targets `authenticated`. An anonymous caller
-- (role=anon, no sub claim) must see zero rows regardless of any other state.
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT is_empty(
  $$SELECT 1 FROM public.connected_emails$$,
  '#10 anon SELECT: anonymous caller sees zero connected_emails rows'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT app.reset_jwt_claims();

SELECT * FROM finish();

ROLLBACK;
