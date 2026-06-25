-- ============================================================================
-- Test:      supabase/tests/pgtap/anonymize_user_references.test.sql
-- Date:      2026-06-25
-- Task:      T-607 (#117) — §5.10 mandatory anonymize test
-- Purpose:   Populate a real user across the tables anonymize_user_references
--            touches, run it, and assert the §5.10 contract: audit refs become
--            the 'deleted_user' sentinel, consent_log is scrubbed (PII nulled,
--            subject sentinel'd but row KEPT for LGPD evidence), client_telemetry
--            is deleted, and — after the §9.4 user_profiles cleanup — the
--            auth.users row deletes WITHOUT an FK violation. Plus the
--            uq_consent_active_per_purpose conflict.
-- Spec refs: §5.10 (anonymize), §9.4 (delete-my-account ordering).
--
-- BEGIN/ROLLBACK; runs as postgres. Inserting auth.users fires the
-- create_user_profile trigger (auto user_profiles row) — handled below.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(7);

-- Fixed test subject 'aaaaaaaa-0000-0000-0000-0000000a0001';
-- deleted_user sentinel = 00000000-0000-0000-0000-000000000001.

-- ---- fixture: populate the anonymize-touched tables -----------------------
INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-0000-0000-0000-0000000a0001', 'anon-test@x.com');
INSERT INTO public.households (name, created_by)
  VALUES ('anon-test-hh', 'aaaaaaaa-0000-0000-0000-0000000a0001');
INSERT INTO public.domain_events (event_type, aggregate_type, aggregate_id, payload, actor_type, actor_user_id)
  VALUES ('anon.test', 'user', 'aaaaaaaa-0000-0000-0000-0000000a0001',
          '{"version":1,"data":{}}'::jsonb, 'user', 'aaaaaaaa-0000-0000-0000-0000000a0001');
INSERT INTO public.consent_log (user_id, purpose, version, legal_basis, ip_address, user_agent)
  VALUES ('aaaaaaaa-0000-0000-0000-0000000a0001', 'terms', 1, 'consent', '1.2.3.4', 'UA/1.0');
INSERT INTO public.client_telemetry (event_type, payload, user_id)
  VALUES ('error', '{}'::jsonb, 'aaaaaaaa-0000-0000-0000-0000000a0001');

-- ---- act ------------------------------------------------------------------
SELECT app.anonymize_user_references('aaaaaaaa-0000-0000-0000-0000000a0001');

-- ---- assert ---------------------------------------------------------------
SELECT is(
  (SELECT created_by FROM public.households WHERE name = 'anon-test-hh'),
  '00000000-0000-0000-0000-000000000001'::uuid,
  '#1 households.created_by → deleted_user sentinel'
);
SELECT is(
  (SELECT actor_user_id FROM public.domain_events WHERE event_type = 'anon.test'),
  '00000000-0000-0000-0000-000000000001'::uuid,
  '#2 domain_events.actor_user_id → sentinel'
);
SELECT is(
  (SELECT user_id FROM public.consent_log WHERE legal_basis = 'consent' AND purpose = 'terms'),
  '00000000-0000-0000-0000-000000000001'::uuid,
  '#3 consent_log.user_id → sentinel (row kept for LGPD evidence)'
);
SELECT ok(
  (SELECT ip_address IS NULL AND user_agent IS NULL
     FROM public.consent_log WHERE legal_basis = 'consent' AND purpose = 'terms'),
  '#4 consent_log PII (ip_address, user_agent) scrubbed to NULL'
);
SELECT is(
  (SELECT count(*) FROM public.client_telemetry WHERE user_id = 'aaaaaaaa-0000-0000-0000-0000000a0001'),
  0::bigint,
  '#5 client_telemetry deleted for the user'
);

-- §9.4: anonymize does NOT touch user_profiles (the delete-account flow does);
-- mimic that final step, then the auth.users delete must be FK-clean.
DELETE FROM public.user_profiles WHERE user_id = 'aaaaaaaa-0000-0000-0000-0000000a0001';
SELECT lives_ok(
  $$ DELETE FROM auth.users WHERE id = 'aaaaaaaa-0000-0000-0000-0000000a0001' $$,
  '#6 auth.users row deletes without an FK violation after anonymize + profile cleanup'
);

-- ---- uq_consent_active_per_purpose: one active consent per (user, purpose) -
INSERT INTO public.consent_log (user_id, purpose, version, legal_basis)
  VALUES ('bbbbbbbb-0000-0000-0000-0000000b0001', 'privacy', 1, 'consent');
SELECT throws_ok(
  $$ INSERT INTO public.consent_log (user_id, purpose, version, legal_basis)
       VALUES ('bbbbbbbb-0000-0000-0000-0000000b0001', 'privacy', 1, 'consent') $$,
  '23505',
  NULL,
  '#7 a second ACTIVE consent for the same (user, purpose) violates uq_consent_active_per_purpose'
);

SELECT * FROM finish();

ROLLBACK;
