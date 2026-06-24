-- ============================================================================
-- Migration: 20260623120000_create_ai_calls.sql
-- Date:      2026-06-23
-- Task:      T-401
-- Purpose:   Cria public.ai_calls — observabilidade de TODA chamada a provider
--            de IA/OCR. Uma row por tentativa: provider, model, tokens, latência,
--            status, chain-state snapshot, correlation_id. Decisão MVP (§7.3):
--            OCR REUSA esta tabela (provider IN ('ocr_space','google_vision'),
--            purpose='ocr', model/tokens NULL, pages_processed setado) — sem
--            tabela ocr_calls separada.
-- Spec refs: §5.6 (ai_calls DDL base), §7.3 (reuso p/ OCR + pages_processed),
--            §7.5.1 (classifyError → status), §5.11 (RLS matrix).
--
-- Design notes:
--   * NÃO é "extend": ai_calls nunca foi criada (T-306 criou só sync_runs/
--     extraction_runs, com ai_calls aparecendo só como COMMENT). Esta migration
--     cria a tabela COMPLETA — colunas base do §5.6 + colunas OCR/chain
--     (pages_processed, chain_state_at_call, is_probe, synthetic) do §7.3 — num
--     único CREATE. O título "extend" da issue #47 é artefato de planejamento.
--   * provider='__chain__' é o pseudo-provider de rows sintéticas do chain
--     breaker (synthetic=true); is_probe=true marca probes de half-open recovery.
--   * household_id/invoice_id NULLáveis (chamadas de chain/probe podem não ter
--     invoice). FK p/ households(id)/invoices(id) sem ON DELETE (restrict).
--   * RLS: SELECT member-of-household (quando household_id populado) OR sys-admin;
--     write service_role-only (sem policy de write — service_role bypassa RLS).
--     GRANT SELECT a authenticated é OBRIGATÓRIO (convenção T-114, migration
--     20260622120100) p/ a policy ser alcançável.
--   * Idempotente: CREATE TABLE IF NOT EXISTS; CHECK via DO/pg_constraint guard;
--     CREATE INDEX IF NOT EXISTS; DROP POLICY IF EXISTS antes de CREATE POLICY.
--
-- Rollback:  DROP TABLE IF EXISTS public.ai_calls;
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by review)
-- ----------------------------------------------------------------------------
--   * DO NOT GRANT anything on ai_calls to `anon` — observability is never
--     public.
--   * DO NOT GRANT INSERT/UPDATE/DELETE to `authenticated` — writes are
--     service_role-only (the workers run as service_role / BYPASSRLS). Only
--     SELECT is granted, matching the RLS SELECT policy.
-- ----------------------------------------------------------------------------


CREATE TABLE IF NOT EXISTS public.ai_calls (
  id                  uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  correlation_id      uuid,
  provider            text NOT NULL, -- gemini|groq|openrouter|ocr_space|google_vision|__chain__
  model               text,          -- NULL p/ OCR
  purpose             text NOT NULL, -- extraction|categorization|chat|ocr
  invoice_id          uuid REFERENCES public.invoices(id),
  household_id        uuid REFERENCES public.households(id),
  prompt_tokens       int,
  completion_tokens   int,
  pages_processed     int,           -- §7.3: OCR usage; NULL p/ AI
  latency_ms          int,
  status              text NOT NULL, -- §7.5.1
  error_summary       text,
  chain_state_at_call text,          -- snapshot do chain breaker no momento da call
  is_probe            boolean NOT NULL DEFAULT false,
  synthetic           boolean NOT NULL DEFAULT false,
  called_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_calls IS
  'Observabilidade de toda chamada a provider de IA/OCR: 1 row por tentativa '
  '(provider/model/tokens/latência/status/chain snapshot). OCR reusa esta tabela '
  '(purpose=ocr, pages_processed). Spec §5.6/§7.3.';

-- CHECK purpose (idempotent guard)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ai_calls_purpose'
      AND conrelid = 'public.ai_calls'::regclass) THEN
    ALTER TABLE public.ai_calls ADD CONSTRAINT chk_ai_calls_purpose
      CHECK (purpose IN ('extraction', 'categorization', 'chat', 'ocr'));
  END IF;
END $$;

-- CHECK status — full §7.5.1 domain (success + the classifyError failure modes)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ai_calls_status'
      AND conrelid = 'public.ai_calls'::regclass) THEN
    ALTER TABLE public.ai_calls ADD CONSTRAINT chk_ai_calls_status
      CHECK (status IN (
        'success', 'rate_limited', 'circuit_open', 'timeout',
        'error', 'invalid_response', 'quota_exceeded'
      ));
  END IF;
END $$;

-- Indexes (§5.6)
CREATE INDEX IF NOT EXISTS idx_ai_calls_provider_time
  ON public.ai_calls (provider, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_household
  ON public.ai_calls (household_id, called_at DESC)
  WHERE household_id IS NOT NULL;

-- RLS (§5.11): SELECT member-of-household OR sys-admin; write service_role-only.
ALTER TABLE public.ai_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_calls_select ON public.ai_calls;
CREATE POLICY ai_calls_select ON public.ai_calls
  FOR SELECT
  TO authenticated
  USING (
    (household_id IS NOT NULL AND household_id IN (SELECT app.households_of_user()))
    OR app.is_system_admin()
  );

-- GRANT (MANDATORY per T-114 convention 20260622120100): authenticated SELECT
-- only, mirroring extraction_runs/sync_runs. service_role is covered by the
-- ALTER DEFAULT PRIVILEGES from 20260622120100 (future postgres-created tables).
GRANT SELECT ON public.ai_calls TO authenticated;

-- Record this migration
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260623120000_create_ai_calls',
  'Cria public.ai_calls (observabilidade IA/OCR): colunas base §5.6 + OCR/chain '
  '(pages_processed, chain_state_at_call, is_probe, synthetic); CHECK purpose/'
  'status (§7.5.1); índices; RLS member-of-household/sys-admin + GRANT SELECT '
  'authenticated. OCR reusa a tabela (purpose=ocr).'
)
ON CONFLICT (migration_name) DO NOTHING;
