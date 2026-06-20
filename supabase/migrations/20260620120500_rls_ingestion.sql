-- ============================================================================
-- Migration: 20260620120500_rls_ingestion.sql
-- Date:      2026-06-20
-- Task:      T-309
-- Purpose:   Habilita RLS e cria policies para as tabelas de ingestão criadas
--            no P4: utility_parsers, domain_events, sync_runs, extraction_runs.
--            (invoices e invoice_categories já têm RLS em
--            20260617120300_rls_invoices_categories.sql; circuit_breakers e
--            rate_limit_buckets NÃO têm RLS — só service_role.)
-- Spec refs: §5.11 (matriz de RLS), §5.10 (helpers app.*)
--
-- Design notes:
--   * Helpers de T-113: app.households_of_user() (SETOF uuid), app.is_system_admin().
--   * Todas as 4 tabelas têm escrita SOMENTE por service_role (workers). Como
--     service_role tem BYPASSRLS, NÃO há policy de write — RLS habilitada +
--     ausência de policy de write = authenticated/anon não escrevem. Só
--     definimos a policy de SELECT.
--   * utility_parsers: SELECT a qualquer authenticated (NÃO anon) — evita expor
--     regex/fingerprints na URL pública; sem scoping por household (são globais).
--   * domain_events: SELECT membro-do-household; eventos system-wide
--     (household_id NULL) só pra sys-admin.
--   * sync_runs/extraction_runs: Pattern D (cross-binding) — connected_email é
--     N:N com household via connected_email_households; extraction_runs liga via
--     invoice → household.
--   * Idempotência: DROP POLICY IF EXISTS antes de cada CREATE POLICY.
--
-- Rollback:  DROP POLICY ... ; ALTER TABLE ... DISABLE ROW LEVEL SECURITY;
-- ============================================================================

-- ============================================================================
-- 1. utility_parsers — SELECT authenticated (global); write service_role only
-- ============================================================================
ALTER TABLE public.utility_parsers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utility_parsers_select ON public.utility_parsers;
CREATE POLICY utility_parsers_select ON public.utility_parsers
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 2. domain_events — SELECT membro-do-household OR sys-admin
-- ============================================================================
ALTER TABLE public.domain_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS domain_events_select ON public.domain_events;
CREATE POLICY domain_events_select ON public.domain_events
  FOR SELECT
  TO authenticated
  USING (
    (household_id IS NOT NULL
      AND household_id IN (SELECT app.households_of_user()))
    OR app.is_system_admin()
  );

-- ============================================================================
-- 3. sync_runs — SELECT via connected_email_households (Pattern D) OR sys-admin
-- ============================================================================
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_runs_select ON public.sync_runs;
CREATE POLICY sync_runs_select ON public.sync_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.connected_email_households ceh
      WHERE ceh.connected_email_id = sync_runs.connected_email_id
        AND ceh.household_id IN (SELECT app.households_of_user())
        AND ceh.deleted_at IS NULL
    )
    OR app.is_system_admin()
  );

-- ============================================================================
-- 4. extraction_runs — SELECT via invoice → household OR sys-admin
-- ============================================================================
ALTER TABLE public.extraction_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS extraction_runs_select ON public.extraction_runs;
CREATE POLICY extraction_runs_select ON public.extraction_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.invoices i
      WHERE i.id = extraction_runs.invoice_id
        AND i.household_id IN (SELECT app.households_of_user())
    )
    OR app.is_system_admin()
  );

-- ============================================================================
-- 5. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120500_rls_ingestion',
  'Habilita RLS + SELECT policies para utility_parsers (global authenticated), '
  'domain_events (membro/sys-admin), sync_runs/extraction_runs (Pattern D). '
  'Write em todas é service_role only (sem policy de write).'
)
ON CONFLICT (migration_name) DO NOTHING;
