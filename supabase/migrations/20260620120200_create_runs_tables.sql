-- ============================================================================
-- Migration: 20260620120200_create_runs_tables.sql
-- Date:      2026-06-20
-- Task:      T-306
-- Purpose:   Cria public.sync_runs e public.extraction_runs — tabelas de
--            observabilidade do pipeline. sync_runs registra cada execução do
--            IMAP sync (por connected_email); extraction_runs registra cada
--            tentativa de extração (por invoice). Idempotência do sync via
--            UNIQUE(connected_email_id, idempotency_key).
-- Spec refs: §5.6 (sync_runs/extraction_runs DDL), §6.1 (idempotency_key)
--
-- Design notes:
--   * sync_runs.connected_email_id e extraction_runs.invoice_id mantêm FK
--     (ownership). status/trigger_source são text livres (sem enum no spec).
--   * extraction_runs.method usa o enum public.extraction_method (criado em
--     T-301/§5.3).
--   * uq_sync_runs_idempotency (plan-mandated) garante 1 run por
--     (connected_email_id, idempotency_key) — dedupe de re-enfileiramento.
--   * Imutáveis após finished_at; sem updated_at/trigger.
--   * RLS em T-309 (Pattern D cross-binding via connected_email_households /
--     invoice→household; write service_role).
--
-- Rollback:  DROP TABLE IF EXISTS public.extraction_runs;
--            DROP TABLE IF EXISTS public.sync_runs;
-- ============================================================================

-- ============================================================================
-- 1. sync_runs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id                  uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  correlation_id      uuid NOT NULL,
  connected_email_id  uuid NOT NULL REFERENCES public.connected_emails(id),
  idempotency_key     text NOT NULL,
  trigger_source      text NOT NULL,        -- 'scheduled' | 'manual' | 'retry'
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         int,
  status              text NOT NULL,        -- 'running'|'success'|'partial'|'failed'
  messages_seen       int NOT NULL DEFAULT 0,
  invoices_created    int NOT NULL DEFAULT 0,
  duplicates_skipped  int NOT NULL DEFAULT 0,
  errors_count        int NOT NULL DEFAULT 0,
  error_summary       text,
  config_snapshot     jsonb,
  imap_uid_from       bigint,
  imap_uid_to         bigint
);

COMMENT ON TABLE public.sync_runs IS
  'Observabilidade do IMAP sync: uma row por execução por connected_email. '
  'Idempotência via UNIQUE(connected_email_id, idempotency_key). Spec §5.6.';

CREATE INDEX IF NOT EXISTS idx_sync_runs_email_time
  ON public.sync_runs (connected_email_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_corr
  ON public.sync_runs (correlation_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_runs_idempotency
  ON public.sync_runs (connected_email_id, idempotency_key);

COMMENT ON INDEX public.uq_sync_runs_idempotency IS
  'Idempotência do sync: 1 run por (connected_email_id, idempotency_key) — '
  'o dispatcher usa idempotency_key = connected_email_id||'':''||minuto. '
  'Spec §6.1.';

-- ============================================================================
-- 2. extraction_runs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.extraction_runs (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  correlation_id  uuid NOT NULL,
  invoice_id      uuid NOT NULL REFERENCES public.invoices(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     int,
  status          text NOT NULL,
  method          public.extraction_method,
  ai_calls_made   int NOT NULL DEFAULT 0,
  confidence      numeric(3,2),
  error_summary   text,
  config_snapshot jsonb
);

COMMENT ON TABLE public.extraction_runs IS
  'Observabilidade da extração: uma row por tentativa por invoice (método, '
  'confiança, ai_calls). Spec §5.6.';

CREATE INDEX IF NOT EXISTS idx_extraction_runs_invoice
  ON public.extraction_runs (invoice_id, started_at DESC);

-- ============================================================================
-- 3. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120200_create_runs_tables',
  'Cria public.sync_runs e public.extraction_runs (observabilidade do '
  'pipeline) com índices + UNIQUE(connected_email_id, idempotency_key) para '
  'idempotência do sync.'
)
ON CONFLICT (migration_name) DO NOTHING;
