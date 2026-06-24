-- ============================================================================
-- Migration: 20260624120000_cron_extraction_worker.sql
-- Date:      2026-06-24
-- Task:      T-425 (#71)
-- Purpose:   Agenda o cron job do P5 'unibill-extraction-worker' (1min), que
--            invoca a Edge Function extraction-worker (T-418) via
--            private.invoke_edge_function (T-310) — drena a invoice_queue e roda
--            a extração das 4 camadas. Slot já reservado/documentado na migration
--            20260620120700_cron_schedules (T-311).
-- Spec refs: §4.4 (cron schedules), §6.6 (job definitions), §7.1 (pipeline).
--
-- Design notes:
--   * cron.schedule(jobname, schedule, command) faz UPSERT por nome (pg_cron
--     ≥1.5): re-rodar atualiza o job existente, sem duplicar.
--   * Mesmo comando/forma dos jobs do P4 (sync-dispatcher/sync-worker). A função
--     é SECURITY DEFINER e roda como o owner (a tabela cron.job não é acessível
--     ao role da migration: 42501).
--   * verify_jwt=true em config.toml + requireServiceRole (camada 2) protegem a
--     função; o cron envia o service_role bearer via invoke_edge_function.
--
-- Rollback:  SELECT cron.unschedule('unibill-extraction-worker');
-- ============================================================================

SELECT cron.schedule(
  'unibill-extraction-worker', '* * * * *',
  $cron$SELECT private.invoke_edge_function('extraction-worker')$cron$
);

-- ============================================================================
-- Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260624120000_cron_extraction_worker',
  'Agenda o cron job unibill-extraction-worker (1min) que invoca a Edge '
  'Function extraction-worker (T-418) via private.invoke_edge_function.'
)
ON CONFLICT (migration_name) DO NOTHING;
