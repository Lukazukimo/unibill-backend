-- ============================================================================
-- Migration: 20260624140000_capacity_health_telemetry.sql
-- Date:      2026-06-24
-- Task:      T-601 (#106)
-- Purpose:   Capacity / health / telemetry schema do P7 (§5.7 + §5.6):
--              * enum public.capacity_status (green|yellow|orange|red)
--              * capacity_snapshots, eviction_runs, pdf_archive_log,
--                health_snapshots, health_snapshots_hourly  (§5.7)
--              * client_telemetry                            (§5.6)
--              * filas pgmq capacity_eviction_queue + _dlq    (§4.3)
--            DDL transcrito verbatim do spec §5.7/§5.6.
-- Spec refs: §5.6, §5.7, §10.x, §G.
--
-- Design notes:
--   * Service-role-only (sem RLS), como as demais tabelas de observabilidade/
--     resiliência (sync_runs, ai_calls, circuit_breakers — §5.11): só workers
--     via service_role escrevem; não há grant a authenticated/anon.
--   * invoices.pdf_archived_at já existe (migration de invoices) com COMMENT §G —
--     não recriado aqui.
--   * As chaves capacity.* / retention.* (§10.5/§10.6) já estão no seed
--     app_settings_defaults.sql (config-drift sincronizado) — não re-seedadas.
--   * gen_random_uuid() qualificado como extensions.gen_random_uuid() (convenção
--     do repo; pgcrypto vive no schema extensions).
--
-- Rollback:
--   DROP TABLE IF EXISTS public.client_telemetry, public.health_snapshots_hourly,
--     public.health_snapshots, public.pdf_archive_log, public.eviction_runs,
--     public.capacity_snapshots;
--   DROP TYPE IF EXISTS public.capacity_status;
--   SELECT pgmq.drop_queue('capacity_eviction_dlq'); SELECT pgmq.drop_queue('capacity_eviction_queue');
-- ============================================================================

-- ============================================================================
-- 1. Enum public.capacity_status (idempotente)
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
     WHERE typname = 'capacity_status' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.capacity_status AS ENUM ('green', 'yellow', 'orange', 'red');
  END IF;
END $$;

COMMENT ON TYPE public.capacity_status IS
  'Nível de capacity (§10.2): green 0-69% / yellow 70-79% / orange 80-89% / red 90%+.';

-- ============================================================================
-- 2. capacity_snapshots — uma medição (db + storage + filas) por tick (§5.7)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.capacity_snapshots (
  id                   uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  checked_at           timestamptz NOT NULL DEFAULT now(),
  db_bytes             bigint NOT NULL,
  db_limit_bytes       bigint NOT NULL,
  db_pct               numeric(5, 2) NOT NULL,
  db_status            public.capacity_status NOT NULL,
  db_per_table         jsonb NOT NULL,
  storage_bytes        bigint NOT NULL,
  storage_limit_bytes  bigint NOT NULL,
  storage_pct          numeric(5, 2) NOT NULL,
  storage_status       public.capacity_status NOT NULL,
  storage_per_bucket   jsonb NOT NULL,
  queue_depths         jsonb NOT NULL,
  thresholds_snapshot  jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capacity_time ON public.capacity_snapshots (checked_at DESC);

COMMENT ON TABLE public.capacity_snapshots IS
  'Medição de capacity por tick do capacity-monitor (§5.7). Service-role-only.';

-- ============================================================================
-- 3. eviction_runs — uma execução do capacity-evictor (§5.7)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.eviction_runs (
  id                uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  correlation_id    uuid NOT NULL,
  resource_type     text NOT NULL,
  trigger_reason    text NOT NULL,
  trigger_pct       numeric(5, 2) NOT NULL,
  target_pct        numeric(5, 2) NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       int,
  final_pct         numeric(5, 2),
  total_freed_bytes bigint NOT NULL DEFAULT 0,
  status            text NOT NULL,
  steps             jsonb NOT NULL DEFAULT '[]',
  error_summary     text
);

CREATE INDEX IF NOT EXISTS idx_eviction_runs_time ON public.eviction_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eviction_runs_resource
  ON public.eviction_runs (resource_type, started_at DESC);

COMMENT ON TABLE public.eviction_runs IS
  'Execução de eviction (tier-escalation §10.3); steps jsonb acumula cada passo. Service-role-only.';

-- ============================================================================
-- 4. pdf_archive_log — PDFs removidos do Storage por eviction (§5.7 / BR-016)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pdf_archive_log (
  invoice_id        uuid PRIMARY KEY REFERENCES public.invoices(id),
  original_path     text NOT NULL,
  file_hash         text NOT NULL,
  file_size_bytes   bigint NOT NULL,
  archived_at       timestamptz NOT NULL DEFAULT now(),
  archived_by_run   uuid REFERENCES public.eviction_runs(id),
  archive_reason    text NOT NULL
);

COMMENT ON TABLE public.pdf_archive_log IS
  'Registro de PDFs arquivados/removidos do Storage por capacity eviction (BR-016). '
  'invoices.pdf_archived_at marca o invoice; dados extraídos permanecem.';

-- ============================================================================
-- 5. health_snapshots — heartbeat detalhado (§5.7)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.health_snapshots (
  id                     uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  checked_at             timestamptz NOT NULL DEFAULT now(),
  db_ok                  boolean NOT NULL,
  email_sync_queue_depth int,
  invoice_queue_depth    int,
  dlq_email_depth        int,
  dlq_invoice_depth      int,
  oldest_unprocessed     timestamptz,
  active_circuits_open   int NOT NULL DEFAULT 0,
  ai_providers_status    jsonb
);

COMMENT ON TABLE public.health_snapshots IS
  'Heartbeat detalhado (§5.7). Após 7d vira health_snapshots_hourly. Service-role-only.';

-- ============================================================================
-- 6. health_snapshots_hourly — agregado horário (§5.7)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.health_snapshots_hourly (
  hour                     timestamptz PRIMARY KEY,
  db_ok_pct                numeric(5, 2),
  avg_queue_depth          numeric,
  errors_per_hour          int,
  active_circuits_open_max int
);

COMMENT ON TABLE public.health_snapshots_hourly IS
  'Agregado horário de health (§5.7): detalhe >7d colapsa aqui, retido ~30-365d.';

-- ============================================================================
-- 7. client_telemetry — telemetria do frontend (§5.6)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.client_telemetry (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  user_id         uuid REFERENCES auth.users(id), -- AUDIT-FK-OK: ownership (telemetry belongs to the user who emitted it; spec §5.6 DDL)
  household_id    uuid REFERENCES public.households(id),
  session_id      uuid,
  correlation_id  uuid,
  event_type      text NOT NULL,
  severity        text,
  payload         jsonb NOT NULL,
  device_info     jsonb,
  app_version     text,
  release_channel text
);

CREATE INDEX IF NOT EXISTS idx_telemetry_time ON public.client_telemetry (occurred_at DESC);

COMMENT ON TABLE public.client_telemetry IS
  'Telemetria do frontend (§5.6): event_type error|navigation|performance|feature_used. '
  'Service-role-only (ingestão via edge function).';

-- ============================================================================
-- 8. Filas pgmq de eviction (§4.3) — idempotente, service-role-only
-- ============================================================================
DO $$
DECLARE
  q text;
BEGIN
  FOREACH q IN ARRAY ARRAY['capacity_eviction_queue', 'capacity_eviction_dlq'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = q) THEN
      PERFORM pgmq.create(q);
    END IF;
  END LOOP;
END $$;

-- Re-aplica o grant nas novas tabelas pgmq.q_*/a_* (o GRANT ... ON ALL TABLES da
-- migration P4 só cobriu as filas existentes na época).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO service_role;

-- ============================================================================
-- 9. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260624140000_capacity_health_telemetry',
  'Capacity/health/telemetry do P7: enum capacity_status + capacity_snapshots, '
  'eviction_runs, pdf_archive_log, health_snapshots, health_snapshots_hourly, '
  'client_telemetry + filas pgmq capacity_eviction_queue/_dlq.'
)
ON CONFLICT (migration_name) DO NOTHING;
