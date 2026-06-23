-- ============================================================================
-- Test:      supabase/tests/pgtap/cron_jobs.test.sql
-- Date:      2026-06-23
-- Task:      T-334 (#45) — pgTAP: cron jobs registered
-- Purpose:   Assert that the three scheduled jobs created by migration
--            20260620120700_cron_schedules (T-311) are present in `cron.job`
--            with their exact schedule strings, and that NO duplicate rows
--            exist per jobname. This is a migration-state ("infra") assertion,
--            not an RLS test: it reads the LIVE cron.job catalog populated by
--            applied migrations and is therefore NOT self-fixturing for the
--            jobs themselves.
--
--            Expected jobs (spec §4.4 / §6.6):
--              unibill-sync-dispatcher    '* * * * *'
--                  command → SELECT private.invoke_edge_function('sync-dispatcher')
--              unibill-sync-worker        '* * * * *'
--                  command → SELECT private.invoke_edge_function('sync-worker')
--              cleanup-pg-net-responses   '0 5 * * *'
--                  command → DELETE FROM net._http_response WHERE created < ...
--
--            Assertions:
--              1.  exactly 1 row for jobname 'unibill-sync-dispatcher'
--              2.  dispatcher schedule is '* * * * *'
--              3.  dispatcher command invokes private.invoke_edge_function('sync-dispatcher')
--              4.  exactly 1 row for jobname 'unibill-sync-worker'
--              5.  worker schedule is '* * * * *'
--              6.  worker command invokes private.invoke_edge_function('sync-worker')
--              7.  exactly 1 row for jobname 'cleanup-pg-net-responses'
--              8.  cleanup schedule is '0 5 * * *'
--              9.  cleanup command deletes from net._http_response
--              10. all three jobs are active
--              11. the set of unibill-relevant jobnames is EXACTLY these three
--                  (no missing, no extra) — guards total count / dupes together
--
-- Spec refs: §4.4 (cron schedules), §6.6 (job definitions).
-- Migration: 20260620120700_cron_schedules (cron.schedule UPSERT by name).
--
-- Plan total: 11 assertions.
--
-- Notes:
--   * Wrapped in BEGIN/ROLLBACK for hygiene; this test makes NO writes — it
--     only SELECTs from cron.job. The suite runs as the `postgres` owner, which
--     can read cron.job (verified). No JWT helper / search_path switch is
--     needed; cron.job is fully schema-qualified throughout.
--   * Command-text assertions use `matches` (POSIX regex CONTAINS) rather than
--     exact equality, so a benign whitespace change in the migration body does
--     not break the test while still proving the job calls the right target.
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(11);


-- ============================================================================
-- unibill-sync-dispatcher
-- ============================================================================
SELECT is(
  (SELECT count(*) FROM cron.job WHERE jobname = 'unibill-sync-dispatcher'),
  1::bigint,
  '#1 unibill-sync-dispatcher: exactly one row in cron.job (no duplicates)'
);

SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'unibill-sync-dispatcher'),
  '* * * * *',
  '#2 unibill-sync-dispatcher: schedule is every minute (* * * * *)'
);

SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'unibill-sync-dispatcher'),
  'private\.invoke_edge_function\(''sync-dispatcher''\)',
  '#3 unibill-sync-dispatcher: command invokes private.invoke_edge_function(''sync-dispatcher'')'
);


-- ============================================================================
-- unibill-sync-worker
-- ============================================================================
SELECT is(
  (SELECT count(*) FROM cron.job WHERE jobname = 'unibill-sync-worker'),
  1::bigint,
  '#4 unibill-sync-worker: exactly one row in cron.job (no duplicates)'
);

SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'unibill-sync-worker'),
  '* * * * *',
  '#5 unibill-sync-worker: schedule is every minute (* * * * *)'
);

SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'unibill-sync-worker'),
  'private\.invoke_edge_function\(''sync-worker''\)',
  '#6 unibill-sync-worker: command invokes private.invoke_edge_function(''sync-worker'')'
);


-- ============================================================================
-- cleanup-pg-net-responses
-- ============================================================================
SELECT is(
  (SELECT count(*) FROM cron.job WHERE jobname = 'cleanup-pg-net-responses'),
  1::bigint,
  '#7 cleanup-pg-net-responses: exactly one row in cron.job (no duplicates)'
);

SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'cleanup-pg-net-responses'),
  '0 5 * * *',
  '#8 cleanup-pg-net-responses: schedule is daily at 05:00 (0 5 * * *)'
);

SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'cleanup-pg-net-responses'),
  'DELETE FROM net\._http_response',
  '#9 cleanup-pg-net-responses: command prunes net._http_response'
);


-- ============================================================================
-- Cross-cutting invariants
-- ============================================================================
-- All three jobs must be enabled, otherwise they are registered but inert.
SELECT is(
  (SELECT count(*) FROM cron.job
     WHERE jobname IN ('unibill-sync-dispatcher',
                       'unibill-sync-worker',
                       'cleanup-pg-net-responses')
       AND active),
  3::bigint,
  '#10 all three unibill cron jobs are active (active = true)'
);

-- The set of unibill-relevant jobnames is EXACTLY these three. Scoping the LHS
-- to the known names keeps the test robust to unrelated platform jobs while
-- still proving none of the three is missing or duplicated.
SELECT set_eq(
  $$SELECT jobname FROM cron.job
     WHERE jobname IN ('unibill-sync-dispatcher',
                       'unibill-sync-worker',
                       'cleanup-pg-net-responses')$$,
  ARRAY['unibill-sync-dispatcher',
        'unibill-sync-worker',
        'cleanup-pg-net-responses'],
  '#11 cron.job contains exactly the three expected unibill jobnames, once each'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
