-- ============================================================================
-- Migration: 20260615120600_create_consent_log.sql
-- Date:      2026-06-10
-- Task:      T-112
-- Purpose:   Create `public.consent_purpose` enum and `public.consent_log`
--            table — LGPD art. 8 §5 evidence of granular consent per finality
--            with versioning and revocation tracking. Includes partial UNIQUE
--            index enforcing "at most ONE active consent per (user, purpose)"
--            (WHERE revoked_at IS NULL), and a regular B-tree index for the
--            common lookup pattern (user_id, purpose, accepted_at DESC).
--            RLS is added in T-114 (own SELECT/INSERT, own UPDATE limited to
--            revoked_at/revoked_reason; sys admin sees all for audit).
-- Spec refs: §5.9  (consent_log schema, consent_purpose enum, indexes,
--                   trigger de re-consent, telemetria gate, revogação flow)
--            §5.10 ("Distinção importante" callout — user_id is ownership,
--                   FK to auth.users PRESERVED, not an audit pointer)
--            §9.4  (anonymize_user_references updates consent_log.user_id
--                   to a sentinel actor + nulls ip_address/user_agent —
--                   thus the FK must NOT cascade on user delete; the
--                   anonymize flow handles row preservation explicitly)
--
-- Design notes:
--   * `consent_purpose` enum lives in `public` for symmetry with `member_role`
--     and to allow application code & RLS policies to reference it without
--     schema-qualifying. Four values per spec §5.9:
--       terms      — Termos de uso (mandatory to use the app)
--       privacy    — Política de privacidade (mandatory)
--       telemetry  — Coleta de telemetria de erros (opt-in; gate em §5.9)
--       marketing  — Futuro: newsletters / comunicações comerciais (opt-in)
--     Created idempotently via DO block — CREATE TYPE has no IF NOT EXISTS.
--   * `user_id` HAS a FK to `auth.users(id)` and NO ON DELETE CASCADE — this
--     is intentional. Per spec §5.10 "Distinção importante", `user_id` columns
--     in consent_log represent real ownership (not an audit pointer), so the
--     FK is preserved during normal operation. On user deletion, §9.4
--     `anonymize_user_references` runs FIRST and UPDATEs consent_log.user_id
--     to a sentinel actor (system_actors row) + NULLs ip_address/user_agent,
--     thereby releasing the FK BEFORE auth.users DELETE happens. LGPD obriga
--     retenção de evidência de consentimento (5 anos por
--     `retention.consent_log.max_age_days = 1825`).
--   * `version text NOT NULL` — versão do documento aceito (ex:
--     "terms-v1.2-2026-06"). Trigger de re-consent (§5.9) compara essa coluna
--     com `app_settings.key='legal.terms_version'` no login do user.
--   * `legal_basis text NOT NULL` — base legal LGPD (consent | legitimate_interest
--     | legal_obligation | contract). Mantido text (não enum) pra permitir
--     expansão futura sem migration de enum.
--   * `accepted_at timestamptz NOT NULL DEFAULT now()` — momento do aceite,
--     imutável após insert.
--   * `revoked_at timestamptz` — NULL = consent ATIVO; preenchido (now())
--     na revogação. Junto com o partial unique index abaixo, garante que
--     no máximo UMA row ativa exista por (user, purpose).
--   * `revoked_reason text` — texto livre (ex: 'user_request', 'terms_updated',
--     'account_deletion'). Não enum por flexibilidade.
--   * `ip_address inet` — inet (não text) para storage eficiente (4B IPv4 ou
--     16B IPv6) e suporte nativo a operações de rede (subnet matching, etc.).
--     LGPD-relevante: mascarado /24 (v4) ou /64 (v6) após 90 dias pelo job
--     de retention (§9 retention.consent_log.ip_mask_after_days).
--   * `user_agent text` — string raw do UA do navegador no momento do aceite.
--     Convertido pra hash sha256 após 30 dias por
--     `retention.consent_log.user_agent_hash_after_days`.
--   * Partial UNIQUE index `uq_consent_active_per_purpose ON (user_id, purpose)
--     WHERE revoked_at IS NULL` — chave da modelagem. Permite que um user
--     tenha múltiplas rows históricas (revogadas) pra mesma purpose, mas no
--     máximo UMA ativa. Tentar inserir uma segunda ativa pra mesma (user,
--     purpose) viola o index (SQLSTATE 23505).
--   * Index regular `idx_consent_user_purpose ON (user_id, purpose,
--     accepted_at DESC)` — otimiza o lookup "histórico de consents do user
--     pra essa purpose, mais recente primeiro" (UI Privacidade, auditoria
--     LGPD, scripts de portabilidade de dados §9).
--   * Idempotente: CREATE TYPE em DO block, CREATE TABLE/INDEX com IF NOT
--     EXISTS. Não há triggers nessa migration (audit de mudanças no consent
--     é dispensável — cada revogação CRIA uma nova row UPDATE-ada, e o
--     histórico inteiro fica preservado pelo design append-friendly).
-- ============================================================================


-- ============================================================================
-- 1. Enum: public.consent_purpose
-- ============================================================================
-- Quatro finalidades canônicas (spec §5.9). Não usamos IF NOT EXISTS porque
-- CREATE TYPE não suporta — wrapper em DO block consulta pg_type pra evitar
-- erro em re-run. typnamespace = 'public'::regnamespace garante que o check
-- valida no schema certo (e não num enum homônimo em outro schema).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
     WHERE typname = 'consent_purpose'
       AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.consent_purpose AS ENUM (
      'terms',      -- Termos de uso (obrigatório pra usar o app)
      'privacy',    -- Política de privacidade (obrigatório)
      'telemetry',  -- Coleta de telemetria de erros (opt-in)
      'marketing'   -- Newsletters / comunicações comerciais (opt-in; pós-MVP)
    );
  END IF;
END
$$;

COMMENT ON TYPE public.consent_purpose IS
  'Finalidades canônicas de consentimento LGPD (spec §5.9). terms e privacy '
  'são obrigatórios pra uso do app; telemetry e marketing são opt-in '
  'explícitos. Usado por public.consent_log.purpose.';


-- ============================================================================
-- 2. consent_log — evidência granular de consentimento por finalidade
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.consent_log (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  purpose         public.consent_purpose NOT NULL,
  version         text NOT NULL,
  legal_basis     text NOT NULL,
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_reason  text,
  ip_address      inet,
  user_agent      text
);

COMMENT ON TABLE public.consent_log IS
  'LGPD art. 8 §5 — evidência granular de consentimento por finalidade '
  '(purpose) com versioning (version) e revogação (revoked_at). Append-only '
  'no fluxo normal: revogar = UPDATE setando revoked_at; novo consent = novo '
  'INSERT. Partial unique uq_consent_active_per_purpose garante no máximo 1 '
  'ativo por (user, purpose). RLS em T-114: own SELECT/INSERT, own UPDATE '
  'só pra revoked_at/revoked_reason, sys admin vê tudo (audit).';

COMMENT ON COLUMN public.consent_log.id IS
  'PK gerado por extensions.gen_random_uuid().';
COMMENT ON COLUMN public.consent_log.user_id IS
  'Owner do consent. FK pra auth.users(id) PRESERVADA (spec §5.10 — user_id '
  'é ownership, não audit). SEM ON DELETE CASCADE: §9.4 anonymize_user_'
  'references UPDATE-a pra sentinel ANTES do auth.users DELETE, preservando '
  'evidência LGPD por 5 anos (retention.consent_log.max_age_days = 1825).';
COMMENT ON COLUMN public.consent_log.purpose IS
  'Finalidade canônica (enum public.consent_purpose). terms/privacy '
  'obrigatórios; telemetry/marketing opt-in.';
COMMENT ON COLUMN public.consent_log.version IS
  'Versão do documento aceito (ex: "terms-v1.2-2026-06"). Trigger de '
  're-consent em §5.9 compara essa coluna com app_settings.key='
  '''legal.terms_version'' no login.';
COMMENT ON COLUMN public.consent_log.legal_basis IS
  'Base legal LGPD: consent | legitimate_interest | legal_obligation | '
  'contract. text (não enum) por flexibilidade futura.';
COMMENT ON COLUMN public.consent_log.accepted_at IS
  'Momento do aceite (default now()). Imutável após insert (RLS T-114 '
  'bloqueia UPDATE de qualquer coluna que não seja revoked_at/revoked_reason).';
COMMENT ON COLUMN public.consent_log.revoked_at IS
  'NULL = consent ATIVO. timestamptz = momento da revogação. Combinado com '
  'uq_consent_active_per_purpose garante no máximo 1 ativo por (user, purpose).';
COMMENT ON COLUMN public.consent_log.revoked_reason IS
  'Texto livre da razão da revogação (ex: "user_request", "terms_updated", '
  '"account_deletion"). NULL enquanto revoked_at IS NULL.';
COMMENT ON COLUMN public.consent_log.ip_address IS
  'IP do cliente no momento do aceite. inet (não text) por storage '
  'eficiente e suporte nativo a subnet ops. Mascarado /24 (v4) ou /64 (v6) '
  'após 90 dias (retention.consent_log.ip_mask_after_days). NULLed em §9.4 '
  'anonymize_user_references.';
COMMENT ON COLUMN public.consent_log.user_agent IS
  'User-Agent raw no momento do aceite. Convertido pra hash sha256 após 30 '
  'dias (retention.consent_log.user_agent_hash_after_days). NULLed em §9.4 '
  'anonymize_user_references.';


-- ============================================================================
-- 3. Partial UNIQUE index — at most ONE active consent per (user, purpose)
-- ============================================================================
-- Chave da modelagem granular LGPD: um user pode ter N rows históricas
-- (revogadas) pra mesma purpose, mas no máximo UMA ativa. Tentativa de
-- inserir uma segunda ativa pra mesma (user, purpose) viola e retorna
-- SQLSTATE 23505 (unique_violation). Necessário pra trigger de re-consent
-- (§5.9) e pra lookup "tem consent ativo pra X?" em O(log n).
CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_active_per_purpose
  ON public.consent_log (user_id, purpose)
  WHERE revoked_at IS NULL;

COMMENT ON INDEX public.uq_consent_active_per_purpose IS
  'Partial UNIQUE (user_id, purpose) WHERE revoked_at IS NULL — garante no '
  'máximo 1 consent ativo por finalidade por user. Rows revogadas (revoked_at '
  'NOT NULL) ficam fora do index e não conflitam.';


-- ============================================================================
-- 4. Index — histórico de consents por (user, purpose) mais recente primeiro
-- ============================================================================
-- Otimiza UI Privacidade ("mostre meu histórico de aceites/revogações pra
-- essa finalidade") e scripts LGPD de portabilidade de dados (§9 export).
-- accepted_at DESC permite index scan ordenado sem sort externo.
CREATE INDEX IF NOT EXISTS idx_consent_user_purpose
  ON public.consent_log (user_id, purpose, accepted_at DESC);

COMMENT ON INDEX public.idx_consent_user_purpose IS
  'B-tree composto (user_id, purpose, accepted_at DESC) — otimiza listagem '
  'do histórico de consents de um user pra uma purpose, mais recente '
  'primeiro. Usado em UI Privacidade e export LGPD (§9).';


-- ============================================================================
-- 5. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120600_create_consent_log',
  'Enum public.consent_purpose (terms|privacy|telemetry|marketing) + tabela '
  'public.consent_log com FK preservada pra auth.users (sem CASCADE; §9.4 '
  'anonymize handle) + partial UNIQUE uq_consent_active_per_purpose '
  '(user_id, purpose) WHERE revoked_at IS NULL + index idx_consent_user_'
  'purpose (user_id, purpose, accepted_at DESC). RLS em T-114.'
)
ON CONFLICT (migration_name) DO NOTHING;
