-- pgTAP: T-217 sys-admin management — app.record_admin_change (last-admin guard),
-- app.list_system_admins (self-gated), app.resolve_user_id_by_email, and the
-- service_role-only privilege matrix. Hermetic (BEGIN/ROLLBACK).
--
-- record_admin_change counts EFFECTIVE admins GLOBALLY from the ledger, so the
-- scenarios are SEQUENCED (each asserts against the running global count):
--   seed 1 admin -> revoke=UB004 -> add a 2nd -> revoke one=OK -> promote/idempotent.

BEGIN;

SET LOCAL search_path = public, extensions, app;

\ir ../helpers/jwt_claims.psql

SELECT plan(16);

-- ---------------------------------------------------------------------------
-- Seed auth.users. u_sole carries the claim (for the LIST test); the ledger
-- guard uses system_admin_grants, not the claim.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_app_meta_data)
VALUES
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'Sole@Test.Local', 'authenticated', 'authenticated', '{"is_system_admin": true}'::jsonb),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'b@test.local', 'authenticated', 'authenticated', '{}'::jsonb),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'none@test.local', 'authenticated', 'authenticated', '{}'::jsonb),
  ('50000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000000',
   'nonadmin@test.local', 'authenticated', 'authenticated', '{}'::jsonb);

-- Ledger: exactly one effective admin to start (u_sole granted by bootstrap).
INSERT INTO public.system_admin_grants (user_id, action, granted_by, reason)
VALUES ('50000000-0000-0000-0000-000000000001', 'granted', NULL, 'bootstrap');

-- ===========================================================================
-- Existence + privilege matrix
-- ===========================================================================
SELECT has_function('app', 'record_admin_change',
  ARRAY['uuid', 'text', 'uuid', 'text', 'uuid'],
  'record_admin_change(uuid,text,uuid,text,uuid) exists');

SELECT has_function('app', 'list_system_admins', ARRAY[]::text[],
  'list_system_admins() exists');

SELECT has_function('app', 'resolve_user_id_by_email', ARRAY['text'],
  'resolve_user_id_by_email(text) exists');

SELECT ok(
       has_function_privilege('service_role',  'app.record_admin_change(uuid,text,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'app.record_admin_change(uuid,text,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon',          'app.record_admin_change(uuid,text,uuid,text,uuid)', 'EXECUTE'),
  'record_admin_change EXECUTE is service_role ONLY');

SELECT ok(
       has_function_privilege('service_role',  'app.resolve_user_id_by_email(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'app.resolve_user_id_by_email(text)', 'EXECUTE'),
  'resolve_user_id_by_email EXECUTE is service_role ONLY');

SELECT ok(
       has_function_privilege('authenticated', 'app.list_system_admins()', 'EXECUTE')
  AND has_function_privilege('service_role',   'app.list_system_admins()', 'EXECUTE')
  AND NOT has_function_privilege('anon',       'app.list_system_admins()', 'EXECUTE'),
  'list_system_admins EXECUTE is authenticated+service_role (not anon)');

-- ===========================================================================
-- resolver (case-insensitive hit + miss)
-- ===========================================================================
SELECT is(
  app.resolve_user_id_by_email('sole@test.local'),
  '50000000-0000-0000-0000-000000000001'::uuid,
  'resolve_user_id_by_email is case-insensitive');

SELECT is(
  app.resolve_user_id_by_email('nobody@test.local'),
  NULL,
  'resolve_user_id_by_email returns NULL on a miss');

-- ===========================================================================
-- Last-admin guard — SEQUENCED against the global effective count
-- ===========================================================================

-- (1) Only one effective admin -> revoke MUST raise UB004.
SELECT throws_ok(
  $$ SELECT app.record_admin_change(
       '50000000-0000-0000-0000-000000000001'::uuid, 'revoked',
       '50000000-0000-0000-0000-000000000001'::uuid, 'self_revoke', NULL) $$,
  'UB004',
  'cannot revoke the last system admin',
  'revoking the sole effective admin raises UB004');

-- Promote a second admin (u_b): now two effective admins.
SELECT is(
  (app.record_admin_change(
     '50000000-0000-0000-0000-000000000002'::uuid, 'granted',
     '50000000-0000-0000-0000-000000000001'::uuid, 'peer_promotion', NULL) ->> 'changed')::boolean,
  true,
  'promoting a non-admin records a grant (changed=true)');

-- (2) With two effective admins, revoking one now succeeds.
SELECT is(
  (app.record_admin_change(
     '50000000-0000-0000-0000-000000000001'::uuid, 'revoked',
     '50000000-0000-0000-0000-000000000002'::uuid, 'peer_revocation', NULL) ->> 'effective_count')::int,
  1,
  'revoking one of two admins succeeds; effective_count drops to 1');

-- The revoke appended exactly one 'revoked' row for u_sole.
SELECT is(
  (SELECT count(*) FROM public.system_admin_grants
    WHERE user_id = '50000000-0000-0000-0000-000000000001'::uuid AND action = 'revoked'),
  1::bigint,
  'a revoked row was appended for the revoked admin');

-- ===========================================================================
-- Idempotency
-- ===========================================================================
-- u_b is now the sole effective admin (u_sole was revoked). Promote u_none.
SELECT is(
  (app.record_admin_change(
     '50000000-0000-0000-0000-000000000003'::uuid, 'granted',
     '50000000-0000-0000-0000-000000000002'::uuid, 'peer_promotion', NULL) ->> 'changed')::boolean,
  true,
  'promoting u_none records a grant');

-- Re-promoting an already-granted target is a no-op (no duplicate row).
SELECT is(
  (app.record_admin_change(
     '50000000-0000-0000-0000-000000000003'::uuid, 'granted',
     '50000000-0000-0000-0000-000000000002'::uuid, 'peer_promotion', NULL) ->> 'changed')::boolean,
  false,
  'promoting an already-granted target is a no-op (changed=false)');

SELECT is(
  (SELECT count(*) FROM public.system_admin_grants
    WHERE user_id = '50000000-0000-0000-0000-000000000003'::uuid AND action = 'granted'),
  1::bigint,
  'the idempotent re-promote did not append a duplicate grant');

-- ===========================================================================
-- list_system_admins — self-gated
-- ===========================================================================
-- As a sys-admin (u_sole carries the claim), the list includes the claim-admin.
SELECT app.set_jwt_claims('50000000-0000-0000-0000-000000000001'::uuid, NULL, true);
SET LOCAL search_path = public, extensions, app;  -- set_jwt_claims switched role

SELECT is(
  (SELECT count(*) FROM app.list_system_admins()
    WHERE email = 'sole@test.local'),
  1::bigint,
  'list_system_admins returns the claim-admin to a sys-admin caller');

SELECT app.reset_jwt_claims();
SET LOCAL search_path = public, extensions, app;

-- As a non-admin, the self-gate raises 42501.
SELECT app.set_jwt_claims('50000000-0000-0000-0000-000000000009'::uuid, NULL, false);
SET LOCAL search_path = public, extensions, app;

SELECT throws_ok(
  $$ SELECT * FROM app.list_system_admins() $$,
  '42501',
  'system_admin required',
  'list_system_admins raises 42501 for a non-admin caller');

SELECT app.reset_jwt_claims();

SELECT * FROM finish();

ROLLBACK;
