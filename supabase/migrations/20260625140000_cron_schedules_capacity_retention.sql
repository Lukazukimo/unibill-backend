-- ============================================================================
-- Migration: 20260625140000_cron_schedules_capacity_retention.sql
-- Date:      2026-06-25
-- Task:      T-604 (#114)
-- Purpose:   Agenda os 6 cron jobs do P7 (capacity + retenção) e cria as 2
--            funções SQL que dois deles chamam:
--              * app.retention_hard_ceiling()    — DELETE backstop por
--                retention.<table>.max_age_days (tabelas de observabilidade)
--              * app.aggregate_health_snapshots()— rollup 24h → hourly + poda 7d
--            Jobs: capacity-monitor (5min), capacity-evictor (1min),
--            retention-hard-ceiling (03:00), cleanup-rate-buckets (10min),
--            health-snapshots-aggregator (04:30), archive-domain-events (dom 02:00).
-- Spec refs: §4.4, §6.6, §10.5, §D, BR-025.
--
-- Design notes:
--   * Edge functions invocadas via private.invoke_edge_function (T-310, pg_net);
--     jobs SQL puros rodam inline / via app.* (SECURITY DEFINER).
--   * cron.schedule faz UPSERT por nome (idempotente). pg_cron loga execuções em
--     cron.job_run_details automaticamente.
--   * retention_hard_ceiling cobre as tabelas de observabilidade SEM FK de
--     entrada nem sensibilidade LGPD (sync_runs/extraction_runs/eviction_runs/
--     capacity_snapshots/health_snapshots_hourly/ai_calls). NÃO toca: invoices
--     (eviction Tier 4 + FK pdf_archive_log), domain_events (archive T-605),
--     consent_log/app_settings_history (LGPD/audit — T-610).
--   * health_snapshots (detalhe) é podado pelo aggregator a 7d, não aqui.
--
-- Rollback: SELECT cron.unschedule('unibill-capacity-monitor'); (idem demais)
--   DROP FUNCTION app.retention_hard_ceiling(), app.aggregate_health_snapshots();
-- ============================================================================

-- ============================================================================
-- 1. app.retention_hard_ceiling — DELETE backstop por max_age (observabilidade)
-- ============================================================================
CREATE OR REPLACE FUNCTION app.retention_hard_ceiling()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_days   int;
  v_n      bigint;
  rec      record;
BEGIN
  FOR rec IN SELECT * FROM (VALUES
    ('sync_runs',              'started_at', 'retention.sync_runs.max_age_days',              365),
    ('extraction_runs',        'started_at', 'retention.extraction_runs.max_age_days',        365),
    ('eviction_runs',          'started_at', 'retention.eviction_runs.max_age_days',          1825),
    ('capacity_snapshots',     'checked_at', 'retention.capacity_snapshots.max_age_days',     730),
    ('health_snapshots_hourly','hour',       'retention.health_snapshots_hourly.max_age_days', 365),
    ('ai_calls',               'called_at',  'retention.ai_calls.max_age_days',               730)
  ) AS t(tbl, col, cfg_key, default_days)
  LOOP
    v_days := COALESCE(
      (SELECT (value ->> 'v')::int FROM public.app_settings
        WHERE key = rec.cfg_key AND scope = 'global'),
      rec.default_days
    );
    EXECUTE format(
      'DELETE FROM public.%I WHERE %I < now() - make_interval(days => $1)',
      rec.tbl, rec.col
    ) USING v_days;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_result := v_result || pg_catalog.jsonb_build_object(rec.tbl, v_n);
  END LOOP;
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION app.retention_hard_ceiling() IS
  'Backstop de retenção: DELETE por retention.<table>.max_age_days nas tabelas de '
  'observabilidade (§10.5). Idempotente. cron unibill-retention-hard-ceiling (T-604).';

-- ============================================================================
-- 2. app.aggregate_health_snapshots — rollup 24h → hourly, poda detalhe 7d
-- ============================================================================
CREATE OR REPLACE FUNCTION app.aggregate_health_snapshots()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rolled bigint;
  v_pruned bigint;
BEGIN
  INSERT INTO public.health_snapshots_hourly
    (hour, db_ok_pct, avg_queue_depth, errors_per_hour, active_circuits_open_max)
  SELECT
    date_trunc('hour', h.checked_at) AS hour,
    pg_catalog.round(pg_catalog.avg(CASE WHEN h.db_ok THEN 1 ELSE 0 END) * 100, 2),
    pg_catalog.avg(COALESCE(h.invoice_queue_depth, 0) + COALESCE(h.email_sync_queue_depth, 0)),
    pg_catalog.count(*) FILTER (WHERE NOT h.db_ok),
    pg_catalog.max(h.active_circuits_open)
  FROM public.health_snapshots h
  WHERE h.checked_at >= now() - interval '24 hours'
  GROUP BY date_trunc('hour', h.checked_at)
  ON CONFLICT (hour) DO UPDATE SET
    db_ok_pct = EXCLUDED.db_ok_pct,
    avg_queue_depth = EXCLUDED.avg_queue_depth,
    errors_per_hour = EXCLUDED.errors_per_hour,
    active_circuits_open_max = EXCLUDED.active_circuits_open_max;
  GET DIAGNOSTICS v_rolled = ROW_COUNT;

  DELETE FROM public.health_snapshots WHERE checked_at < now() - interval '7 days';
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object('rolled_up', v_rolled, 'pruned_detail', v_pruned);
END;
$$;

COMMENT ON FUNCTION app.aggregate_health_snapshots() IS
  'Rollup das health_snapshots da última 24h em health_snapshots_hourly (upsert) '
  'e poda do detalhe > 7d (§5.7). cron unibill-health-snapshots-aggregator (T-604).';

REVOKE EXECUTE ON FUNCTION app.retention_hard_ceiling() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.aggregate_health_snapshots() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.retention_hard_ceiling() TO service_role;
GRANT EXECUTE ON FUNCTION app.aggregate_health_snapshots() TO service_role;

-- ============================================================================
-- 3. Os 6 cron jobs (idempotente por nome)
-- ============================================================================
SELECT cron.schedule(
  'unibill-capacity-monitor', '*/5 * * * *',
  $cron$SELECT private.invoke_edge_function('capacity-monitor')$cron$
);
SELECT cron.schedule(
  'unibill-capacity-evictor', '* * * * *',
  $cron$SELECT private.invoke_edge_function('capacity-evictor')$cron$
);
SELECT cron.schedule(
  'unibill-retention-hard-ceiling', '0 3 * * *',
  $cron$SELECT app.retention_hard_ceiling()$cron$
);
SELECT cron.schedule(
  'unibill-cleanup-rate-buckets', '*/10 * * * *',
  $cron$DELETE FROM public.rate_limit_buckets WHERE window_start < now() - interval '7 days'$cron$
);
SELECT cron.schedule(
  'unibill-health-snapshots-aggregator', '30 4 * * *',
  $cron$SELECT app.aggregate_health_snapshots()$cron$
);
SELECT cron.schedule(
  'unibill-archive-domain-events', '0 2 * * 0',
  $cron$SELECT private.invoke_edge_function('archive-domain-events')$cron$
);

-- ============================================================================
-- 4. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260625140000_cron_schedules_capacity_retention',
  'Agenda os 6 cron jobs do P7 (capacity-monitor/evictor, retention-hard-ceiling, '
  'cleanup-rate-buckets, health-snapshots-aggregator, archive-domain-events) + as '
  'funções app.retention_hard_ceiling e app.aggregate_health_snapshots.'
)
ON CONFLICT (migration_name) DO NOTHING;
