-- ============================================================================
-- Test:      supabase/tests/pgtap/consent_log_retention.test.sql
-- Date:      2026-06-25
-- Task:      T-610 (#120) — §10.5 retention.consent_log.* jobs
-- Purpose:   Drive the three consent_log retention functions over a seeded set
--            of rows and assert: IPs older than ip_mask_after_days(90) are
--            masked to /24 (IPv4) or /64 (IPv6); user_agents older than
--            user_agent_hash_after_days(30) become a 64-char sha256 hex; rows
--            older than max_age_days(1825) are hard-deleted; and every job is
--            idempotent (a second run changes nothing).
-- Spec refs: §10.5 (retention.consent_log.*), §9.4.
--
-- BEGIN/ROLLBACK; runs as postgres. auth.users insert fires create_user_profile.
-- All fixture rows are pre-revoked (revoked_at set) so purpose='terms' can repeat
-- for one user without tripping uq_consent_active_per_purpose (WHERE revoked_at
-- IS NULL); retention filters on accepted_at, so revoked_at is irrelevant to it.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(11);

-- ---- fixture --------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-0000-0000-0000-00000000c001', 'ret@x.co');

INSERT INTO public.consent_log (id, user_id, purpose, version, legal_basis, accepted_at, revoked_at, ip_address, user_agent)
VALUES
  -- ip4 old → masked /24
  ('11111111-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000c001', 'terms', '1', 'consent',
   now() - interval '100 days', now() - interval '100 days', '192.168.1.45', NULL),
  -- ip6 old → masked /64
  ('11111111-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-00000000c001', 'terms', '1', 'consent',
   now() - interval '100 days', now() - interval '100 days', '2001:db8::dead:beef', NULL),
  -- ip4 recent → untouched
  ('11111111-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-00000000c001', 'terms', '1', 'consent',
   now() - interval '10 days', now() - interval '10 days', '10.0.0.5', NULL),
  -- ua old → hashed
  ('11111111-0000-0000-0000-0000000000c4', 'aaaaaaaa-0000-0000-0000-00000000c001', 'terms', '1', 'consent',
   now() - interval '40 days', now() - interval '40 days', NULL,
   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'),
  -- ua recent → untouched
  ('11111111-0000-0000-0000-0000000000c5', 'aaaaaaaa-0000-0000-0000-00000000c001', 'terms', '1', 'consent',
   now() - interval '10 days', now() - interval '10 days', NULL, 'curl/8.0'),
  -- very old → hard-ceiling deleted
  ('11111111-0000-0000-0000-0000000000c6', 'aaaaaaaa-0000-0000-0000-00000000c001', 'terms', '1', 'consent',
   now() - interval '2000 days', now() - interval '2000 days', NULL, NULL);

-- ---- IP mask --------------------------------------------------------------
SELECT app.consent_log_mask_ips();

SELECT is(
  (SELECT ip_address FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c1'),
  '192.168.1.0/24'::inet,
  '#1 IPv4 older than 90d masked to /24'
);
SELECT is(
  (SELECT ip_address FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c2'),
  '2001:db8::/64'::inet,
  '#2 IPv6 older than 90d masked to /64'
);
SELECT is(
  (SELECT ip_address FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c3'),
  '10.0.0.5'::inet,
  '#3 recent IP (<90d) left untouched'
);
SELECT is(
  app.consent_log_mask_ips(),
  0,
  '#4 mask job is idempotent (2nd run masks 0 rows)'
);

-- ---- UA hash --------------------------------------------------------------
SELECT app.consent_log_hash_user_agents();

SELECT matches(
  (SELECT user_agent FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c4'),
  '^[0-9a-f]{64}$',
  '#5 user_agent older than 30d becomes a 64-char sha256 hex'
);
SELECT is(
  (SELECT user_agent FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c4'),
  encode(digest('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'sha256'), 'hex'),
  '#6 the hash is sha256 of the original user_agent'
);
SELECT is(
  (SELECT user_agent FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c5'),
  'curl/8.0',
  '#7 recent user_agent (<30d) left untouched'
);
SELECT is(
  app.consent_log_hash_user_agents(),
  0,
  '#8 hash job is idempotent (2nd run hashes 0 rows)'
);

-- ---- hard ceiling ---------------------------------------------------------
SELECT app.consent_log_hard_ceiling();

SELECT is(
  (SELECT count(*) FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c6'),
  0::bigint,
  '#9 row older than max_age_days (1825) hard-deleted'
);
SELECT is(
  (SELECT count(*) FROM public.consent_log WHERE id = '11111111-0000-0000-0000-0000000000c1'),
  1::bigint,
  '#10 row within the ceiling survives'
);

-- ---- wrapper --------------------------------------------------------------
SELECT ok(
  (app.consent_log_retention()) ? 'rows_deleted',
  '#11 consent_log_retention() returns a jsonb summary with rows_deleted'
);

SELECT * FROM finish();

ROLLBACK;
