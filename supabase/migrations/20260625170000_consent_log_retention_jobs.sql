-- ============================================================================
-- Migration: 20260625170000_consent_log_retention_jobs.sql
-- Date:      2026-06-25
-- Task:      T-610 (#120)
-- Purpose:   Retenção do consent_log (§10.5): mascara IP após
--            retention.consent_log.ip_mask_after_days (90d → /24 IPv4, /64 IPv6),
--            faz hash sha256 do user_agent após user_agent_hash_after_days (30d),
--            e aplica o teto duro de max_age_days (1825d = 5 anos). Três funções
--            SECURITY DEFINER (testáveis isoladamente + idempotentes) + um wrapper
--            agendado num único cron diário às 04:00.
-- Spec refs: §10.5 (retention.consent_log.*), §9.4.
--
-- Estado pré-existente: as 3 chaves retention.consent_log.* já estão seedadas
--   (seeds/app_settings_defaults.sql); pgcrypto em `extensions` (digest sha256).
--   O teto duro de consent_log NÃO está em app.retention_hard_ceiling() (que cobre
--   só as tabelas de observabilidade) — por isso vive aqui.
--
-- Idempotência:
--   * IP: só atualiza quando o valor difere da forma já mascarada
--     (ip_address IS DISTINCT FROM network(...)) → re-rodar não re-mascara.
--   * UA: pula quem já é um hash hex de 64 chars (length=64 AND ~ ^[0-9a-f]{64}$)
--     → re-rodar não re-hasheia.
--   * cron.schedule faz UPSERT por nome.
--
-- Rollback: SELECT cron.unschedule('unibill-consent-log-retention');
--   DROP FUNCTION app.consent_log_retention(), app.consent_log_mask_ips(),
--   app.consent_log_hash_user_agents(), app.consent_log_hard_ceiling();
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. IP mask — /24 (IPv4) ou /64 (IPv6) após ip_mask_after_days (default 90)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.consent_log_mask_ips()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days int;
  v_n    int;
BEGIN
  v_days := COALESCE(
    (SELECT (value ->> 'v')::int FROM public.app_settings
      WHERE key = 'retention.consent_log.ip_mask_after_days' AND scope = 'global'),
    90);

  UPDATE public.consent_log c
     SET ip_address = network(set_masklen(
           c.ip_address, CASE WHEN family(c.ip_address) = 4 THEN 24 ELSE 64 END))::inet
   WHERE c.accepted_at < now() - make_interval(days => v_days)
     AND c.ip_address IS NOT NULL
     AND c.ip_address IS DISTINCT FROM network(set_masklen(
           c.ip_address, CASE WHEN family(c.ip_address) = 4 THEN 24 ELSE 64 END))::inet;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. UA hash — sha256 hex após user_agent_hash_after_days (default 30)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.consent_log_hash_user_agents()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days int;
  v_n    int;
BEGIN
  v_days := COALESCE(
    (SELECT (value ->> 'v')::int FROM public.app_settings
      WHERE key = 'retention.consent_log.user_agent_hash_after_days' AND scope = 'global'),
    30);

  UPDATE public.consent_log c
     SET user_agent = encode(extensions.digest(c.user_agent, 'sha256'), 'hex')
   WHERE c.accepted_at < now() - make_interval(days => v_days)
     AND c.user_agent IS NOT NULL
     -- já é um hash hex de 64 chars → não re-hasheia (idempotente)
     AND NOT (length(c.user_agent) = 64 AND c.user_agent ~ '^[0-9a-f]{64}$');

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Teto duro — DELETE após max_age_days (default 1825 = 5 anos)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.consent_log_hard_ceiling()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days int;
  v_n    int;
BEGIN
  v_days := COALESCE(
    (SELECT (value ->> 'v')::int FROM public.app_settings
      WHERE key = 'retention.consent_log.max_age_days' AND scope = 'global'),
    1825);

  DELETE FROM public.consent_log WHERE accepted_at < now() - make_interval(days => v_days);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Wrapper — roda os três na ordem e devolve o resumo
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.consent_log_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_masked  int;
  v_hashed  int;
  v_deleted int;
BEGIN
  v_masked  := app.consent_log_mask_ips();
  v_hashed  := app.consent_log_hash_user_agents();
  v_deleted := app.consent_log_hard_ceiling();
  RETURN jsonb_build_object(
    'ips_masked', v_masked, 'uas_hashed', v_hashed, 'rows_deleted', v_deleted);
END;
$$;

COMMENT ON FUNCTION app.consent_log_retention() IS
  'LGPD retention do consent_log (§10.5): mascara IP (90d), hash do user_agent '
  '(30d) e teto duro (1825d). Agendada no cron unibill-consent-log-retention '
  '04:00. Idempotente. T-610.';

-- ----------------------------------------------------------------------------
-- 5. GRANTs — só service_role (as funções rodam via cron / service-role)
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.consent_log_mask_ips() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.consent_log_hash_user_agents() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.consent_log_hard_ceiling() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.consent_log_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.consent_log_mask_ips() TO service_role;
GRANT EXECUTE ON FUNCTION app.consent_log_hash_user_agents() TO service_role;
GRANT EXECUTE ON FUNCTION app.consent_log_hard_ceiling() TO service_role;
GRANT EXECUTE ON FUNCTION app.consent_log_retention() TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Cron diário 04:00 (UPSERT por nome — idempotente)
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
  'unibill-consent-log-retention', '0 4 * * *',
  $cron$SELECT app.consent_log_retention()$cron$
);

-- ----------------------------------------------------------------------------
-- 7. Registro da migration
-- ----------------------------------------------------------------------------
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260625170000_consent_log_retention_jobs',
  'Retenção consent_log (§10.5): app.consent_log_mask_ips/_hash_user_agents/'
  '_hard_ceiling + wrapper consent_log_retention + cron 04:00. T-610.'
)
ON CONFLICT (migration_name) DO NOTHING;
