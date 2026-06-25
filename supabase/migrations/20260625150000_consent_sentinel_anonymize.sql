-- ============================================================================
-- Migration: 20260625150000_consent_sentinel_anonymize.sql
-- Date:      2026-06-25
-- Task:      T-606 (#116)
-- Purpose:   LGPD anonymization: cria app.anonymize_user_references(target) per
--            §5.10 e DROPa as FK constraints de audit que ainda apontam pra
--            auth.users (Abordagem A), pra que a função possa trocar o id por um
--            sentinel (system_actors '...0001' = deleted_user) sem violar FK.
-- Spec refs: §5.9, §5.10, §9.4.
--
-- Estado pré-existente (P0/P1 — NÃO recriado aqui):
--   * consent_purpose enum + consent_log + uq_consent_active_per_purpose + §G
--     COMMENTs → migration 20260615120600.
--   * system_actors + 3 sentinels (00…0001/0002/0003) → migration 20260615120000.
--   * Audit columns created_by/updated_by/paid_by/invited_by/used_by/actor_user_id
--     em households/invoices/household_invitations/members/domain_events JÁ são
--     uuid SEM FK. Só 4 colunas de audit mantinham FK forte (abaixo).
--
-- FK drops (Abordagem A §5.10): as colunas de AUDIT que a função sentinela e que
--   ainda tinham FK → auth.users. Ownership (connected_emails.owner_user_id,
--   members.user_id, user_profiles.user_id, system_admin_grants.user_id) MANTÊM
--   FK — são hard-deletadas/tratadas no fluxo §9.4 (T-609).
--   NOTA: §5.10 (prosa) diz que consent_log.user_id manteria FK, mas a própria
--   função §5.10 troca consent_log.user_id por sentinel (LGPD: retém evidência,
--   anonimiza o titular) → a FK PRECISA cair. A função é a fonte da verdade.
--
-- Rollback: DROP FUNCTION app.anonymize_user_references(uuid); (FKs não são
--   re-adicionadas — Abordagem A é permanente.)
-- ============================================================================

-- ============================================================================
-- 1. Drop das FK de audit que apontavam pra auth.users (idempotente)
-- ============================================================================
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_updated_by_fkey;
ALTER TABLE public.app_settings_history DROP CONSTRAINT IF EXISTS app_settings_history_changed_by_fkey;
ALTER TABLE public.consent_log DROP CONSTRAINT IF EXISTS consent_log_user_id_fkey;
ALTER TABLE public.system_admin_grants DROP CONSTRAINT IF EXISTS system_admin_grants_granted_by_fkey;

-- ============================================================================
-- 2. anonymize_user_references — §5.10 (versão completa), qualificada
-- ============================================================================
CREATE OR REPLACE FUNCTION app.anonymize_user_references(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  sentinel uuid := '00000000-0000-0000-0000-000000000001'; -- system_actors 'deleted_user'
BEGIN
  -- 1. Audit fields → sentinel (deleted_user actor).
  UPDATE public.households SET created_by = sentinel WHERE created_by = target_user_id;
  UPDATE public.members SET invited_by = sentinel WHERE invited_by = target_user_id;
  UPDATE public.household_invitations SET created_by = sentinel WHERE created_by = target_user_id;
  UPDATE public.household_invitations SET used_by = sentinel WHERE used_by = target_user_id;
  UPDATE public.invoices SET paid_by = sentinel WHERE paid_by = target_user_id;
  UPDATE public.invoices SET created_by = sentinel WHERE created_by = target_user_id;
  UPDATE public.invoices SET updated_by = sentinel WHERE updated_by = target_user_id;
  UPDATE public.app_settings SET updated_by = sentinel WHERE updated_by = target_user_id;
  UPDATE public.app_settings_history SET changed_by = sentinel WHERE changed_by = target_user_id;
  UPDATE public.domain_events SET actor_user_id = sentinel WHERE actor_user_id = target_user_id;
  UPDATE public.system_admin_grants SET granted_by = sentinel WHERE granted_by = target_user_id;

  -- 2. consent_log: LGPD obriga reter a evidência de consentimento → anonimiza
  --    o titular (sentinel) e remove PII colateral (ip / user_agent).
  UPDATE public.consent_log
     SET user_id = sentinel, ip_address = NULL, user_agent = NULL
   WHERE user_id = target_user_id;

  -- 3. Ownership: hard-delete das rows soft-deletadas (libera FK antes do
  --    auth.users DELETE em §9.4); client_telemetry é PII → DELETE total.
  DELETE FROM public.connected_emails
   WHERE owner_user_id = target_user_id AND deleted_at IS NOT NULL;
  DELETE FROM public.members
   WHERE user_id = target_user_id AND deleted_at IS NOT NULL;
  DELETE FROM public.client_telemetry WHERE user_id = target_user_id;
END;
$$;

COMMENT ON FUNCTION app.anonymize_user_references(uuid) IS
  'LGPD: troca refs de audit do usuário por sentinel (deleted_user), scrub do '
  'consent_log (retém evidência) e hard-delete de ownership soft-deletado + '
  'client_telemetry. Chamada no fluxo delete-my-account (§9.4, T-609). §5.10.';

REVOKE EXECUTE ON FUNCTION app.anonymize_user_references(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.anonymize_user_references(uuid) TO service_role;

-- ============================================================================
-- 3. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260625150000_consent_sentinel_anonymize',
  'LGPD: app.anonymize_user_references (§5.10) + drop das 4 FK de audit '
  '(app_settings.updated_by, app_settings_history.changed_by, consent_log.user_id, '
  'system_admin_grants.granted_by) pra permitir sentinel.'
)
ON CONFLICT (migration_name) DO NOTHING;
