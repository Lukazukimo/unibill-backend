-- ============================================================================
-- Migration: 20260620120000_create_utility_parsers.sql
-- Date:      2026-06-20
-- Task:      T-304
-- Purpose:   Cria public.utility_parsers — o registro de parsers por
--            distribuidora (Layer 3 da extração: match por remetente/assunto +
--            regex de campos). Uma row active=true por utility_key define o
--            parser vigente; versionamento permite evoluir sem perder o
--            histórico. consumption_extractor é reservado (roadmap) e SEMPRE
--            NULL no MVP — o worker IGNORA esta coluna.
-- Spec refs: §5.4 (utility_parsers DDL + seed enel-sp), §6 (Layer 3 regex match)
--
-- Design notes:
--   * UNIQUE(utility_key, version) é a chave natural — versionar é trocar a row
--     active=true, não editar a vigente.
--   * idx_parsers_active (parcial WHERE active=true) serve o lookup quente do
--     worker (`.eq('utility_key', k).eq('active', true)`).
--   * RLS é adicionada em T-309 (SELECT authenticated; write service_role).
--     COMMENT ON COLUMN de negócio chega em T-312.
--   * consumption_extractor jsonb fica NULL no MVP (ver COMMENT inline).
--
-- Rollback:  DROP TABLE IF EXISTS public.utility_parsers;
-- ============================================================================

-- ============================================================================
-- 1. Tabela utility_parsers
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.utility_parsers (
  id                    uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  utility_key           text NOT NULL,
  display_name          text NOT NULL,
  default_category      text,

  -- Matching (Layer 3): remetente/assunto/corpo → identifica a distribuidora.
  sender_patterns       text[] NOT NULL,
  subject_patterns      text[],
  body_must_contain     text[],

  -- Extração de campos (regex aplicadas ao texto da fatura).
  amount_regex          text,
  due_date_regex        text,
  due_date_format       text,
  barcode_regex         text,
  pix_regex             text,
  reference_regex       text,
  installation_regex    text,
  customer_name_regex   text,
  service_address_regex text,

  -- Roadmap: extração de consumo (kWh/m³). SEMPRE NULL no MVP; o worker IGNORA
  -- esta coluna e invoices.consumption_data também permanece NULL. O schema
  -- será definido quando a primeira feature de tracking de consumo entrar.
  consumption_extractor jsonb,

  version               int NOT NULL DEFAULT 1,
  active                boolean NOT NULL DEFAULT true,
  notes                 text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_utility_parsers_key_version UNIQUE (utility_key, version)
);

COMMENT ON TABLE public.utility_parsers IS
  'Registro de parsers de fatura por distribuidora (Layer 3 da extração). '
  'Uma row active=true por utility_key é o parser vigente; UNIQUE(utility_key, '
  'version) versiona. Seeds reais por distribuidora (enel-sp etc.). Spec §5.4.';

-- ============================================================================
-- 2. Índice parcial para o lookup do parser ativo
-- ============================================================================
-- Quente no worker: dada uma utility_key, achar o parser vigente. Parcial em
-- active=true mantém o índice pequeno e a busca rápida.
CREATE INDEX IF NOT EXISTS idx_parsers_active
  ON public.utility_parsers (utility_key)
  WHERE active = true;

COMMENT ON INDEX public.idx_parsers_active IS
  'Lookup do parser vigente por utility_key (parcial WHERE active=true). '
  'Spec §5.4.';

-- ============================================================================
-- 3. updated_at bumper (helper compartilhado app.set_updated_at)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_utility_parsers_set_updated_at
  ON public.utility_parsers;
CREATE TRIGGER trg_utility_parsers_set_updated_at
  BEFORE UPDATE ON public.utility_parsers
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();

-- ============================================================================
-- 4. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120000_create_utility_parsers',
  'Cria public.utility_parsers (parsers de fatura por distribuidora, Layer 3) '
  'com UNIQUE(utility_key, version), índice parcial active e updated_at trigger.'
)
ON CONFLICT (migration_name) DO NOTHING;
