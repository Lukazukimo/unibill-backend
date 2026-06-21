-- ============================================================================
-- Migration: 20260620120300_create_resilience_tables.sql
-- Date:      2026-06-20
-- Task:      T-307
-- Purpose:   Cria a infra de resiliência dos workers: public.circuit_breakers
--            (estado de circuit breaker por recurso) e public.rate_limit_buckets
--            (token-bucket por janela). Ambas são manipuladas SOMENTE pelos
--            workers via service_role — sem RLS (não há acesso de usuário).
-- Spec refs: §5.8 (DDL), §4.2 (transição atômica do breaker), §5.11 (NO RLS)
--
-- Design notes:
--   * circuit_state enum: closed | open | half_open. Transição atômica do
--     half-open: UPDATE ... WHERE state='open' AND next_probe_at <= now()
--     RETURNING * (helper withCircuitBreaker, T-318).
--   * PKs compostas (resource_type, resource_key[, window_start, window_size]).
--   * RLS NÃO habilitada em nenhuma das duas (§5.11: "só workers via
--     service_role"). service_role tem BYPASSRLS, então não há policies.
--   * circuit_breakers.updated_at é setado explicitamente pelo helper na
--     transição atômica (RETURNING) — sem trigger, pra não mascarar o controle.
--
-- Rollback:  DROP TABLE IF EXISTS public.rate_limit_buckets;
--            DROP TABLE IF EXISTS public.circuit_breakers;
--            DROP TYPE  IF EXISTS public.circuit_state;
-- ============================================================================

-- ============================================================================
-- 1. Enum circuit_state
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'circuit_state' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.circuit_state AS ENUM ('closed', 'open', 'half_open');
  END IF;
END
$$;

COMMENT ON TYPE public.circuit_state IS
  'Estado do circuit breaker: closed (normal) | open (falhando, rejeita) | '
  'half_open (sondando recuperação). Spec §5.8.';

-- ============================================================================
-- 2. circuit_breakers
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.circuit_breakers (
  resource_type        text NOT NULL,
  resource_key         text NOT NULL,
  state                public.circuit_state NOT NULL DEFAULT 'closed',
  failure_count        int NOT NULL DEFAULT 0,
  last_failure_at      timestamptz,
  opened_at            timestamptz,
  closed_at            timestamptz,
  half_open_started_at timestamptz,
  next_probe_at        timestamptz,
  probes_sent          int NOT NULL DEFAULT 0,
  probes_succeeded     int NOT NULL DEFAULT 0,
  reopen_count         int NOT NULL DEFAULT 0,
  reason               text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, resource_key)
);

COMMENT ON TABLE public.circuit_breakers IS
  'Estado de circuit breaker por recurso (ex: ocr provider, ai provider, imap). '
  'Manipulada só por workers (service_role); SEM RLS. Spec §5.8.';

-- ============================================================================
-- 3. rate_limit_buckets
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  resource_type   text NOT NULL,
  resource_key    text NOT NULL,
  window_start    timestamptz NOT NULL,
  window_size     interval NOT NULL,
  count           int NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_type, resource_key, window_start, window_size)
);

COMMENT ON TABLE public.rate_limit_buckets IS
  'Token-bucket por (recurso, janela). Manipulada só por workers '
  '(service_role); SEM RLS. Limpeza por cron. Spec §5.8.';

CREATE INDEX IF NOT EXISTS idx_buckets_expiry
  ON public.rate_limit_buckets (window_start);

COMMENT ON INDEX public.idx_buckets_expiry IS
  'Suporta a limpeza por janela expirada (cron rate-limit-cleanup). Spec §5.8.';

-- ============================================================================
-- 4. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120300_create_resilience_tables',
  'Cria circuit_state enum + public.circuit_breakers + public.rate_limit_buckets '
  '(infra de resiliência dos workers, sem RLS — service_role only).'
)
ON CONFLICT (migration_name) DO NOTHING;
