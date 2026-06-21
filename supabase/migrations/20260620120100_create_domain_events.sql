-- ============================================================================
-- Migration: 20260620120100_create_domain_events.sql
-- Date:      2026-06-20
-- Task:      T-305
-- Purpose:   Cria public.domain_events — o log append-only de eventos de
--            domínio (event sourcing leve). Workers e Edge Functions emitem
--            eventos (invoice.created, sync.completed, ai.chain.*, etc.) de
--            forma tx-aware (helper emitDomainEvent, T-320). household_id NULL
--            permite eventos system-wide (capacity.*, user.deleted, ...).
-- Spec refs: §5.6 (domain_events DDL + índices), §5.10 (Approach A audit FK)
--
-- Design notes:
--   * payload é {version, data} (convenção §5). Imutável: sem updated_at/trigger.
--   * actor_user_id é uuid SEM FK (§5.10 Approach A) — pode conter sentinel de
--     system_actors após anonimização; actor_type discrimina user|system|worker.
--   * household_id mantém FK (ownership) e é NULL para eventos system-wide.
--   * RLS adicionada em T-309 (SELECT membro-do-household OR sys-admin; write
--     service_role).
--
-- Rollback:  DROP TABLE IF EXISTS public.domain_events;
-- ============================================================================

-- ============================================================================
-- 1. Tabela domain_events
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.domain_events (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  event_type      text NOT NULL,
  event_version   int NOT NULL DEFAULT 1,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  household_id    uuid REFERENCES public.households(id),
  correlation_id  uuid,
  causation_id    uuid,
  payload         jsonb NOT NULL,              -- {version, data}
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,                        -- AUDIT (§5.10 Approach A): uuid SEM FK (pode ser sentinel system_actors)
  actor_type      text NOT NULL               -- 'user' | 'system' | 'worker'
);

COMMENT ON TABLE public.domain_events IS
  'Log append-only de eventos de domínio (event sourcing leve). Emitido '
  'tx-aware pelos workers/Edge Functions. household_id NULL = evento '
  'system-wide. payload é {version, data}. Spec §5.6.';

-- ============================================================================
-- 2. Índices (2 totais, 2 parciais)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_events_aggregate
  ON public.domain_events (aggregate_type, aggregate_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_events_household
  ON public.domain_events (household_id, occurred_at DESC)
  WHERE household_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_correlation
  ON public.domain_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_type_time
  ON public.domain_events (event_type, occurred_at DESC);

COMMENT ON INDEX public.idx_events_aggregate IS
  'Reconstrução por agregado (aggregate_type, aggregate_id, occurred_at). '
  'Spec §5.6.';
COMMENT ON INDEX public.idx_events_household IS
  'Timeline por household (parcial WHERE household_id IS NOT NULL). Spec §5.6.';
COMMENT ON INDEX public.idx_events_correlation IS
  'Trace por correlation_id (parcial WHERE NOT NULL). Spec §5.6.';
COMMENT ON INDEX public.idx_events_type_time IS
  'Browse por tipo de evento mais recente. Spec §5.6.';

-- ============================================================================
-- 3. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120100_create_domain_events',
  'Cria public.domain_events (log append-only de eventos de domínio) com os '
  '4 índices (agregado, household, correlation, tipo). household_id NULL = '
  'system-wide; actor_user_id sem FK (Approach A).'
)
ON CONFLICT (migration_name) DO NOTHING;
