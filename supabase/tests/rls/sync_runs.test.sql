-- ============================================================================
-- Test:      supabase/tests/rls/sync_runs.test.sql
-- Date:      2026-06-23
-- Task:      T-309 (#17) — cross-binding sync_runs RLS (the last open acceptance
--            criterion: "cross-binding sync_runs SELECT works when the user is
--            in any bound household").
-- Purpose:   pgTAP RLS tests for `public.sync_runs`. Visibility is Pattern D
--            (cross-binding): a sync_run is visible to a caller iff its
--            connected_email is bound — via an ACTIVE (deleted_at IS NULL)
--            connected_email_households row — to a household the caller is a
--            MEMBER of; OR the caller is a system admin. Crucially, visibility
--            derives from household MEMBERSHIP of a bound household, NOT from
--            ownership of the connected_email — that is the cross-binding
--            property this file pins.
--
--            Live policy (20260620120500_rls_ingestion.sql), sync_runs_select:
--              EXISTS (SELECT 1 FROM connected_email_households ceh
--                       WHERE ceh.connected_email_id = sync_runs.connected_email_id
--                         AND ceh.household_id IN (SELECT app.households_of_user())
--                         AND ceh.deleted_at IS NULL)
--              OR app.is_system_admin()
--            Writes are service_role-only (no authenticated write grant); anon
--            has no DML grant at all (denied at the GRANT layer → 42501).
--
--            Assertions (plan 6):
--              1. U1, a member of the bound household H1, sees SR (and not SR2).
--              2. U3, a DIFFERENT member of H1 (not the credential owner), also
--                 sees SR — proving visibility is membership-based, not owner-based.
--              3. U2, a member of the UNBOUND-for-SR household H2, sees only its
--                 own SR2 — cross-binding isolation (does not see SR).
--              4. A system admin sees BOTH SR and SR2 (audit override).
--              5. anon SELECT is denied at the grant layer (42501).
--              6. After the H1 binding is soft-deleted, U1 no longer sees SR —
--                 pinning the `ceh.deleted_at IS NULL` tombstone gate (run LAST
--                 because it mutates fixture state).
--
-- Spec refs: §5.11 (RLS — Pattern D cross-binding for sync_runs / extraction_runs).
--
-- Hermeticity: BEGIN/ROLLBACK; search_path locked; JWT helper reused; identity
--   reset between scenarios. Self-fixturing (supabase/seeds are not auto-applied).
--   RLS SELECT denials silently filter rows (assert via set_eq / is_empty); the
--   anon denial is at the privilege layer (42501, assert via throws_ok).
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.psql

SELECT plan(6);


-- ============================================================================
-- Setup (as postgres): identities, two households, two credentials + bindings,
-- two sync_runs (one per household).
-- ============================================================================

-- 1. auth.users (trigger auto-creates user_profiles).
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('a1a1a1a1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000',
   'u1-h1@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U1 (member of H1)"}'::jsonb),
  ('a3a3a3a3-3333-3333-3333-333333333333',
   '00000000-0000-0000-0000-000000000000',
   'u3-h1@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U3 (other member of H1)"}'::jsonb),
  ('a2a2a2a2-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000000',
   'u2-h2@test.local', 'authenticated', 'authenticated',
   '{"display_name":"U2 (member of H2)"}'::jsonb),
  ('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d',
   '00000000-0000-0000-0000-000000000000',
   'sys-admin@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Sys Admin"}'::jsonb);

-- 2. Households.
INSERT INTO public.households (id, name, created_by)
VALUES
  ('40000001-1111-1111-1111-111111111111', 'Household H1',
   'a1a1a1a1-1111-1111-1111-111111111111'),
  ('40000002-2222-2222-2222-222222222222', 'Household H2',
   'a2a2a2a2-2222-2222-2222-222222222222');

-- 3. Memberships: U1 + U3 in H1; U2 in H2. (Sys admin needs no membership.)
INSERT INTO public.members (household_id, user_id, role)
VALUES
  ('40000001-1111-1111-1111-111111111111',
   'a1a1a1a1-1111-1111-1111-111111111111', 'admin'),
  ('40000001-1111-1111-1111-111111111111',
   'a3a3a3a3-3333-3333-3333-333333333333', 'member'),
  ('40000002-2222-2222-2222-222222222222',
   'a2a2a2a2-2222-2222-2222-222222222222', 'admin');

-- 4. Two credentials. CE is owned by U1; CE2 owned by U2. (app_password_secret
--    is a uuid Vault ref.)
INSERT INTO public.connected_emails (
  id, email_address, provider, owner_user_id, app_password_secret
) VALUES
  ('ce700001-1111-1111-1111-111111111111',
   'h1-cred@example.com', 'gmail',
   'a1a1a1a1-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000001'),
  ('ce700002-2222-2222-2222-222222222222',
   'h2-cred@example.com', 'gmail',
   'a2a2a2a2-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-000000000002');

-- 5. Bindings: CE -> H1 (active), CE2 -> H2 (active).
INSERT INTO public.connected_email_households (
  connected_email_id, household_id, is_default, deleted_at
) VALUES
  ('ce700001-1111-1111-1111-111111111111',
   '40000001-1111-1111-1111-111111111111', true, NULL),
  ('ce700002-2222-2222-2222-222222222222',
   '40000002-2222-2222-2222-222222222222', true, NULL);

-- 6. One sync_run per credential. (Required NOT-NULL w/o default: correlation_id,
--    connected_email_id, idempotency_key, trigger_source, status.)
INSERT INTO public.sync_runs (
  id, correlation_id, connected_email_id, idempotency_key, trigger_source, status
) VALUES
  ('5a700001-1111-1111-1111-111111111111',
   'c0000001-1111-1111-1111-111111111111',
   'ce700001-1111-1111-1111-111111111111', 'idem-h1-001', 'cron', 'success'),
  ('5a700002-2222-2222-2222-222222222222',
   'c0000002-2222-2222-2222-222222222222',
   'ce700002-2222-2222-2222-222222222222', 'idem-h2-001', 'cron', 'success');


-- ============================================================================
-- SCENARIO 1 — U1 (member of bound H1) sees SR (the named criterion), not SR2
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.sync_runs
      WHERE id IN ('5a700001-1111-1111-1111-111111111111',
                   '5a700002-2222-2222-2222-222222222222')$$,
  ARRAY['5a700001-1111-1111-1111-111111111111'::uuid],
  '#1 cross-binding SELECT works: U1 (member of bound H1) sees SR, and NOT H2''s SR2'
);


-- ============================================================================
-- SCENARIO 2 — U3 (a DIFFERENT member of H1, not the credential owner) sees SR
-- ============================================================================
-- Proves visibility derives from household-binding MEMBERSHIP, not from owning
-- the connected_email (U3 owns nothing; CE is owned by U1).
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a3a3a3a3-3333-3333-3333-333333333333'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.sync_runs
      WHERE id IN ('5a700001-1111-1111-1111-111111111111',
                   '5a700002-2222-2222-2222-222222222222')$$,
  ARRAY['5a700001-1111-1111-1111-111111111111'::uuid],
  '#2 membership-based (not owner-based): a different member of H1 also sees SR'
);


-- ============================================================================
-- SCENARIO 3 — U2 (member of H2) sees only SR2 — cross-binding isolation
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('a2a2a2a2-2222-2222-2222-222222222222'::uuid,
                          '40000002-2222-2222-2222-222222222222'::uuid, false);

SELECT set_eq(
  $$SELECT id FROM public.sync_runs
      WHERE id IN ('5a700001-1111-1111-1111-111111111111',
                   '5a700002-2222-2222-2222-222222222222')$$,
  ARRAY['5a700002-2222-2222-2222-222222222222'::uuid],
  '#3 isolation: U2 (member of H2 only) sees its own SR2 and NOT H1''s SR'
);


-- ============================================================================
-- SCENARIO 4 — system admin sees BOTH runs (audit override)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_claims('5d5d5d5d-5d5d-5d5d-5d5d-5d5d5d5d5d5d'::uuid,
                          NULL, true);

SELECT set_eq(
  $$SELECT id FROM public.sync_runs
      WHERE id IN ('5a700001-1111-1111-1111-111111111111',
                   '5a700002-2222-2222-2222-222222222222')$$,
  ARRAY['5a700001-1111-1111-1111-111111111111'::uuid,
        '5a700002-2222-2222-2222-222222222222'::uuid],
  '#4 sys-admin override: is_system_admin() sees BOTH sync_runs'
);


-- ============================================================================
-- SCENARIO 5 — anon SELECT denied at the grant layer (42501)
-- ============================================================================
SELECT app.reset_jwt_claims();
SELECT app.set_jwt_anon();

SELECT throws_ok(
  $$SELECT 1 FROM public.sync_runs$$,
  '42501',
  NULL,
  '#5 anon SELECT denied at the grant layer: anon has no DML grant on sync_runs (42501)'
);


-- ============================================================================
-- SCENARIO 6 — soft-deleted binding hides the run (tombstone gate) — LAST
-- ============================================================================
-- Soft-delete CE's binding to H1 as a privileged statement, then re-impersonate
-- U1: the policy's `ceh.deleted_at IS NULL` join now excludes the binding, so SR
-- becomes invisible even to a member of the (formerly) bound household.
SELECT app.reset_jwt_claims();

UPDATE public.connected_email_households
   SET deleted_at = now()
 WHERE connected_email_id = 'ce700001-1111-1111-1111-111111111111'
   AND household_id = '40000001-1111-1111-1111-111111111111';

SELECT app.set_jwt_claims('a1a1a1a1-1111-1111-1111-111111111111'::uuid,
                          '40000001-1111-1111-1111-111111111111'::uuid, false);

SELECT is_empty(
  $$SELECT 1 FROM public.sync_runs
      WHERE id = '5a700001-1111-1111-1111-111111111111'$$,
  '#6 tombstone gate: after the H1 binding is soft-deleted, U1 no longer sees SR'
);


SELECT app.reset_jwt_claims();
SELECT * FROM finish();
ROLLBACK;
