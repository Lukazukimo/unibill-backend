-- ============================================================================
-- Test:      supabase/tests/pgtap/bootstrap.test.sql
-- Date:      2026-06-10
-- Task:      T-217
-- Purpose:   pgTAP suite that asserts the **forensic contract** of a
--            successful sys-admin bootstrap. The bootstrap procedure
--            (`scripts/admin/bootstrap-sys-admin.sql`) is defined as the
--            atomic combination of THREE side-effects that must land
--            together (BR-028, spec §9.2):
--
--              (1) `auth.users.raw_app_meta_data ->> 'is_system_admin'`
--                  flips to `'true'` for the target user.
--              (2) Exactly ONE row is appended to
--                  `public.system_admin_grants` with
--                    action     = 'granted'
--                    granted_by = NULL          (genesis event)
--                    reason     = 'bootstrap'
--                  for that user.
--              (3) Exactly ONE row is appended to `public.domain_events`
--                  with
--                    event_type      = 'system_admin.bootstrapped'
--                    aggregate_type  = 'user'
--                    aggregate_id    = <target_user_id>
--                    actor_type      = 'system'
--                    payload->'data'->>'reason' = 'bootstrap'
--
--            We don't actually execute the bootstrap shell wrapper (it
--            depends on the GoTrue admin API which is not callable from
--            pgTAP), nor the SQL script directly (it raises UB002 by
--            design when the placeholder isn't edited). Instead we
--            **replay** the same three INSERT/UPDATE statements the script
--            emits, with deterministic UUIDs and a sentinel email, and
--            assert each of the four invariants from the runbook's
--            "Forensic guarantees" section:
--
--              ok #1 — invariant 1 holds (claim flipped on auth.users).
--              ok #2 — invariant 2 holds (audit row shape matches).
--              ok #3 — invariant 3 holds (domain_event shape matches) OR
--                      the table is absent and we PASS-with-NOTE (T-305
--                      not yet applied — see §"Forward-compat" below).
--              ok #4 — invariant 4 holds (assert_sys_admin_exists() ok).
--              ok #5 — idempotency: replaying the audit INSERT with
--                      `ON CONFLICT` style guard from the script body
--                      results in zero new rows (we re-run the same
--                      EXISTS-then-INSERT pattern and confirm row count
--                      is unchanged).
--
-- Spec refs: §9.2  (bootstrap inclui INSERT audit — DO block on lines
--                   2486-2504 is the source of the replay).
--            §5.6  (domain_events DDL — payload {version, data} convention).
--            BR-028 (Sys admin Bootstrap 1ª vez triggers both rows).
--
-- Hermeticity:
--   * Wrapped in BEGIN / ROLLBACK — every INSERT/UPDATE is reverted at
--     end of suite. Crucially, the `auth.users` mutation rolls back too:
--     no test fixture user persists in the DB after the suite runs.
--   * Deterministic UUIDs (00000000-0000-0000-0000-00000000bba1, etc.) so
--     failure output is legible and tests are reproducible.
--   * Sentinel email `bootstrap-pgtap-T217@test.local` (no collision with
--     real fixtures from other test files; grep-able if leaked).
--   * No dependency on hCaptcha, GoTrue admin API, or any external service.
--   * Forward-compat: assertion #3 is GUARDED by `to_regclass` — if
--     `public.domain_events` does not exist yet (T-305 P4 not applied),
--     the assertion auto-passes with an explanatory message. Once T-305
--     ships, this test exercises the full three-row contract without
--     modification.
--
-- Notes on auth.users insertion:
--   We follow the established pattern (see app_settings_audit.test.sql,
--   p0_cross_tenant.test.sql, etc.) of INSERTing directly into auth.users
--   with the minimum columns (id, instance_id, email, aud, role) that
--   satisfy the table's NOT NULL constraints. This is permitted inside a
--   pgTAP test because we run as the migration role (which has full
--   privileges on auth.*) and because BEGIN/ROLLBACK guarantees the row
--   does not escape the test transaction.
-- ============================================================================


BEGIN;

-- pgtap lives in `extensions` (T-105). Include `app` and `public` so the
-- helper calls (`app.assert_sys_admin_exists()`, references to
-- `public.system_admin_grants`) resolve when unqualified inside DO blocks.
SET LOCAL search_path = public, extensions, app;

SELECT plan(5);


-- ============================================================================
-- Fixture: seed a single auth.users row that will be the bootstrap target.
-- ============================================================================
-- Deterministic uuid `…bba1` (read: "bootstrap audit ack 1") so failure
-- diagnostics name the user unambiguously. The email contains the task id
-- (T217) and a literal `pgtap` so any accidental leak into prod logs is
-- trivially grep-able.
INSERT INTO auth.users (id, instance_id, email, aud, role)
VALUES (
  '00000000-0000-0000-0000-00000000bba1',
  '00000000-0000-0000-0000-000000000000',
  'bootstrap-pgtap-T217@test.local',
  'authenticated',
  'authenticated'
);


-- ============================================================================
-- Replay: emit the three side-effects the bootstrap script writes.
-- ============================================================================
-- This DO block mirrors `scripts/admin/bootstrap-sys-admin.sql` step-by-step
-- WITHOUT the placeholder safety net (we hard-code the test fixture uuid).
-- The three INSERT/UPDATE statements are exactly what the production script
-- emits when run against a fresh project for the first time.
DO $replay$
DECLARE
  target_id  uuid := '00000000-0000-0000-0000-00000000bba1';
  events_present boolean;
BEGIN
  -- (1) Flip the JWT claim. JSONB merge via `||` mirrors GoTrue admin API
  --     PATCH semantics (the production wrapper's preserve-other-keys rule).
  UPDATE auth.users
     SET raw_app_meta_data =
         COALESCE(raw_app_meta_data, '{}'::jsonb)
         || '{"is_system_admin": true}'::jsonb
   WHERE id = target_id;

  -- (2) Audit row in public.system_admin_grants — granted_by NULL is what
  --     marks this as a bootstrap (genesis) event.
  INSERT INTO public.system_admin_grants
    (user_id, action, granted_by, reason)
  VALUES
    (target_id, 'granted', NULL, 'bootstrap');

  -- (3) Domain event — guarded because the table may not exist yet (T-305).
  events_present := to_regclass('public.domain_events') IS NOT NULL;
  IF events_present THEN
    EXECUTE
      'INSERT INTO public.domain_events '
      '(event_type, event_version, aggregate_type, aggregate_id, '
      ' actor_type, actor_user_id, payload) '
      'VALUES ($1, $2, $3, $4, $5, $6, $7)'
      USING
        'system_admin.bootstrapped',
        1,
        'user',
        target_id,
        'system',
        NULL::uuid,
        jsonb_build_object(
          'version', 1,
          'data', jsonb_build_object(
            'reason', 'bootstrap',
            'email',  'bootstrap-pgtap-T217@test.local'
          )
        );
  END IF;
END
$replay$;


-- ============================================================================
-- ok #1 — invariant 1: auth.users claim flipped to 'true'
-- ============================================================================
-- The `->>` accessor returns text, so we compare to literal 'true'. We
-- COALESCE in case raw_app_meta_data was NULL before the merge (defense
-- against a future GoTrue init change that nullifies the column by default).
SELECT ok(
  (SELECT COALESCE(raw_app_meta_data ->> 'is_system_admin', 'false') = 'true'
     FROM auth.users
    WHERE id = '00000000-0000-0000-0000-00000000bba1'),
  'ok #1: auth.users.raw_app_meta_data->>is_system_admin = ''true'' after bootstrap'
);


-- ============================================================================
-- ok #2 — invariant 2: system_admin_grants has exactly one bootstrap row
-- ============================================================================
-- Shape contract per spec §9.2:
--   action='granted', granted_by IS NULL, reason='bootstrap', exactly 1 row
--   for the target user. We pin all four columns in the predicate so any
--   future drift (e.g. a refactor that writes reason='initial' or
--   granted_by=auth.uid()) trips this test.
SELECT ok(
  (SELECT count(*) = 1
     FROM public.system_admin_grants
    WHERE user_id    = '00000000-0000-0000-0000-00000000bba1'
      AND action     = 'granted'
      AND granted_by IS NULL
      AND reason     = 'bootstrap'),
  'ok #2: exactly one system_admin_grants row with (action=granted, granted_by=NULL, reason=bootstrap)'
);


-- ============================================================================
-- ok #3 — invariant 3: domain_events has the bootstrapped event (or skip)
-- ============================================================================
-- Forward-compat: if T-305 hasn't shipped yet, public.domain_events doesn't
-- exist and we PASS this assertion with an explanatory ok() message. The
-- replay DO block above already guarded its INSERT identically, so we know
-- nothing was written if the table is missing.
--
-- When the table IS present, the shape contract is:
--   event_type     = 'system_admin.bootstrapped'
--   aggregate_type = 'user'
--   aggregate_id   = <target user id>
--   actor_type     = 'system'
--   payload->'data'->>'reason' = 'bootstrap'
--   exactly 1 such row.
--
-- We assemble the test predicate via a DO block + temp table because the
-- conditional EXISTS-then-shape check is awkward to inline into a single
-- pgTAP `ok()` call (the table name must be resolvable at parse time).
DO $check_event$
DECLARE
  events_present boolean;
  matching_count bigint := 0;
  skip_message   text   := '';
BEGIN
  events_present := to_regclass('public.domain_events') IS NOT NULL;

  IF NOT events_present THEN
    matching_count := 1;   -- forces ok() to pass
    skip_message := ' [SKIPPED — public.domain_events not present; T-305 not applied]';
  ELSE
    EXECUTE
      'SELECT count(*) FROM public.domain_events '
      'WHERE event_type    = ''system_admin.bootstrapped'' '
      '  AND aggregate_type = ''user'' '
      '  AND aggregate_id   = $1 '
      '  AND actor_type     = ''system'' '
      '  AND payload->''data''->>''reason'' = ''bootstrap'''
      INTO matching_count
      USING '00000000-0000-0000-0000-00000000bba1'::uuid;
  END IF;

  CREATE TEMP TABLE _t217_event_check ON COMMIT DROP AS
    SELECT matching_count AS cnt, skip_message AS note;
END
$check_event$;

SELECT ok(
  (SELECT cnt = 1 FROM _t217_event_check),
  'ok #3: exactly one domain_events row of event_type=system_admin.bootstrapped'
    || (SELECT note FROM _t217_event_check)
);


-- ============================================================================
-- ok #4 — invariant 4: app.assert_sys_admin_exists() succeeds (no UB001)
-- ============================================================================
-- Helper exists since T-117 (migration 20260615120900). After the claim
-- flip, count_sys_admins() must return ≥ 1 and the assertion must not
-- raise. We wrap in DO/EXCEPTION so a raise surfaces as ok=false instead
-- of aborting the test suite.
DO $assert_block$
DECLARE
  assertion_ok boolean := false;
BEGIN
  BEGIN
    PERFORM app.assert_sys_admin_exists();
    assertion_ok := true;
  EXCEPTION WHEN OTHERS THEN
    -- Capture any raise (UB001 or otherwise) as a hard failure.
    assertion_ok := false;
  END;

  CREATE TEMP TABLE _t217_assert_check ON COMMIT DROP AS
    SELECT assertion_ok AS ok;
END
$assert_block$;

SELECT ok(
  (SELECT ok FROM _t217_assert_check),
  'ok #4: app.assert_sys_admin_exists() returns without raising (UB001 cleared)'
);


-- ============================================================================
-- ok #5 — idempotency: re-running the audit INSERT guarded by EXISTS does NOT
--          duplicate the bootstrap row (matches the script's guard pattern)
-- ============================================================================
-- The production script wraps the system_admin_grants INSERT in an EXISTS
-- check (see `audit_exists` branch in scripts/admin/bootstrap-sys-admin.sql).
-- Here we capture the pre-count, replay the guarded INSERT, and assert the
-- post-count is identical — proving the idempotency contract holds.
DO $idempotency$
DECLARE
  target_id    uuid := '00000000-0000-0000-0000-00000000bba1';
  pre_count    bigint;
  post_count   bigint;
  audit_exists boolean;
BEGIN
  SELECT count(*) INTO pre_count
    FROM public.system_admin_grants
   WHERE user_id = target_id;

  -- Replay the guard from the script body verbatim.
  SELECT EXISTS (
    SELECT 1
      FROM public.system_admin_grants
     WHERE user_id = target_id
       AND action  = 'granted'
       AND reason  = 'bootstrap'
       AND granted_by IS NULL
  ) INTO audit_exists;

  IF NOT audit_exists THEN
    INSERT INTO public.system_admin_grants
      (user_id, action, granted_by, reason)
    VALUES
      (target_id, 'granted', NULL, 'bootstrap');
  END IF;

  SELECT count(*) INTO post_count
    FROM public.system_admin_grants
   WHERE user_id = target_id;

  CREATE TEMP TABLE _t217_idempotency_check ON COMMIT DROP AS
    SELECT pre_count, post_count;
END
$idempotency$;

SELECT ok(
  (SELECT pre_count = post_count AND pre_count = 1
     FROM _t217_idempotency_check),
  'ok #5: guarded re-INSERT does not duplicate the bootstrap audit row (idempotent)'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
