-- ============================================================================
-- Migration: 20260620120700_cron_schedules.sql
-- Date:      2026-06-20
-- Task:      T-311
-- Purpose:   Registra os 3 cron jobs do P4: sync-dispatcher (1min),
--            sync-worker (1min) e a limpeza diária das respostas do pg_net.
--            Cada job chama private.invoke_edge_function (T-310) ou roda SQL.
-- Spec refs: §4.4 (cron schedules), §6.6 (job definitions)
--
-- Design notes:
--   * Idempotente: remove os jobs por nome antes de reagendar (cron.schedule
--     com mesmo nome atualiza, mas o DELETE garante zero duplicatas em qualquer
--     estado anterior).
--   * Só os 3 jobs do P4 aqui; slots de fases futuras documentados no fim.
--
-- Rollback:  DELETE FROM cron.job WHERE jobname IN
--              ('unibill-sync-dispatcher','unibill-sync-worker',
--               'cleanup-pg-net-responses');
-- ============================================================================

-- ============================================================================
-- 1. (Re)agendar os 3 jobs do P4 — idempotente por nome
-- ============================================================================
-- cron.schedule(jobname, schedule, command) faz UPSERT por nome (pg_cron ≥1.5):
-- re-rodar atualiza o job existente, sem duplicar. Usamos a API de função (não
-- DELETE FROM cron.job direto — a tabela cron.job não é acessível ao role da
-- migration: 42501; cron.schedule é SECURITY DEFINER e roda como o owner).
SELECT cron.schedule(
  'unibill-sync-dispatcher', '* * * * *',
  $cron$SELECT private.invoke_edge_function('sync-dispatcher')$cron$
);
SELECT cron.schedule(
  'unibill-sync-worker', '* * * * *',
  $cron$SELECT private.invoke_edge_function('sync-worker')$cron$
);
SELECT cron.schedule(
  'cleanup-pg-net-responses', '0 5 * * *',
  $cron$DELETE FROM net._http_response WHERE created < now() - interval '7 days'$cron$
);

-- ----------------------------------------------------------------------------
-- Slots de cron de fases futuras (NÃO criados aqui — referência):
--   unibill-extraction-worker            '* * * * *'    (P5)
--   unibill-capacity-monitor             '*/5 * * * *'  (P7)
--   unibill-capacity-evictor             '* * * * *'    (P7)
--   unibill-retention-hard-ceiling       '0 3 * * *'    (P7)
--   unibill-rate-limit-cleanup           '0 4 * * *'    (P7)
--   unibill-health-snapshots-aggregator  '30 4 * * *'   (P7)
--   unibill-archive-domain-events        '0 3 * * 0'    (P7)
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 2. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120700_cron_schedules',
  'Registra os 3 cron jobs do P4 (sync-dispatcher 1min, sync-worker 1min, '
  'cleanup-pg-net-responses diário 05:00) de forma idempotente.'
)
ON CONFLICT (migration_name) DO NOTHING;
