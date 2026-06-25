-- ============================================================================
-- Test:      supabase/tests/pgtap/capacity_cron.test.sql
-- Date:      2026-06-25
-- Task:      T-604 (#114) — capacity/retention cron jobs + their SQL functions
-- Purpose:   Assert migration 20260625140000 registered the 6 P7 cron jobs with
--            the right schedules + commands, and that the two backing functions
--            behave: app.retention_hard_ceiling (age backstop, idempotent) and
--            app.aggregate_health_snapshots (rollup + 7d prune); plus the inline
--            cleanup-rate-buckets DELETE only removes rows older than 7d.
-- Spec refs: §4.4, §6.6, §10.5, §D, BR-025.
--
-- BEGIN/ROLLBACK; the behavior cases insert fixtures (rolled back). Runs as the
-- postgres owner (the cron jobs + SECURITY DEFINER functions run as the owner).
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(11);

-- ---- the 6 jobs: names + schedules ----------------------------------------
SELECT is(
  (SELECT jsonb_object_agg(jobname, schedule) FROM cron.job
    WHERE jobname IN (
      'unibill-capacity-monitor', 'unibill-capacity-evictor', 'unibill-retention-hard-ceiling',
      'unibill-cleanup-rate-buckets', 'unibill-health-snapshots-aggregator', 'unibill-archive-domain-events'
    )),
  jsonb_build_object(
    'unibill-capacity-monitor', '*/5 * * * *',
    'unibill-capacity-evictor', '* * * * *',
    'unibill-retention-hard-ceiling', '0 3 * * *',
    'unibill-cleanup-rate-buckets', '*/10 * * * *',
    'unibill-health-snapshots-aggregator', '30 4 * * *',
    'unibill-archive-domain-events', '0 2 * * 0'
  ),
  '#1 all 6 capacity/retention cron jobs present with the exact schedules'
);

-- ---- the commands invoke the right target ---------------------------------
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'unibill-capacity-monitor'),
  'invoke_edge_function\(''capacity-monitor''\)', '#2 capacity-monitor invokes its edge function'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'unibill-archive-domain-events'),
  'invoke_edge_function\(''archive-domain-events''\)', '#3 archive-domain-events invokes its edge function'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'unibill-retention-hard-ceiling'),
  'app\.retention_hard_ceiling\(\)', '#4 retention-hard-ceiling calls app.retention_hard_ceiling'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'unibill-health-snapshots-aggregator'),
  'app\.aggregate_health_snapshots\(\)', '#5 health aggregator calls app.aggregate_health_snapshots'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'unibill-cleanup-rate-buckets'),
  'DELETE FROM public\.rate_limit_buckets', '#6 cleanup-rate-buckets prunes rate_limit_buckets'
);

-- ---- retention_hard_ceiling: deletes past max_age, keeps recent, idempotent -
INSERT INTO public.eviction_runs (correlation_id, resource_type, trigger_reason, trigger_pct, target_pct, status, started_at)
VALUES
  (gen_random_uuid(), 'db', 'test', 95, 60, 'success', now() - interval '2000 days'),  -- > 1825d → evicted
  (gen_random_uuid(), 'db', 'test', 95, 60, 'success', now() - interval '1 day');       -- recent → kept

SELECT lives_ok(
  $$ SELECT app.retention_hard_ceiling() $$,
  '#7 retention_hard_ceiling runs without error'
);

SELECT is(
  (SELECT count(*) FROM public.eviction_runs WHERE trigger_reason = 'test' AND started_at < now() - interval '1825 days'),
  0::bigint,
  '#8 retention_hard_ceiling deleted the eviction_runs row past max_age (1825d)'
);
SELECT is(
  (SELECT count(*) FROM public.eviction_runs WHERE trigger_reason = 'test'),
  1::bigint,
  '#9 retention_hard_ceiling kept the recent row (and a 2nd run is a no-op)'
);

-- ---- cleanup-rate-buckets: only > 7d removed ------------------------------
INSERT INTO public.rate_limit_buckets (resource_type, resource_key, window_start, window_size, count)
VALUES
  ('t', 'old', now() - interval '8 days', interval '1 hour', 1),
  ('t', 'new', now() - interval '1 day', interval '1 hour', 1);
DELETE FROM public.rate_limit_buckets WHERE window_start < now() - interval '7 days';
SELECT is(
  (SELECT string_agg(resource_key, ',' ORDER BY resource_key) FROM public.rate_limit_buckets WHERE resource_type = 't'),
  'new',
  '#10 cleanup-rate-buckets removed only the >7d bucket'
);

-- ---- aggregate_health_snapshots: rollup + prune detail > 7d ----------------
INSERT INTO public.health_snapshots (db_ok, invoice_queue_depth, active_circuits_open, checked_at)
VALUES
  (true, 3, 0, now() - interval '2 hours'),   -- recent → rolled up + kept
  (false, 9, 1, now() - interval '8 days');    -- old detail → pruned
SELECT app.aggregate_health_snapshots();
SELECT ok(
  (SELECT count(*) FROM public.health_snapshots_hourly WHERE hour >= now() - interval '24 hours') >= 1
  AND (SELECT count(*) FROM public.health_snapshots WHERE checked_at < now() - interval '7 days') = 0,
  '#11 aggregator rolled the last 24h into hourly and pruned detail older than 7d'
);

SELECT * FROM finish();

ROLLBACK;
