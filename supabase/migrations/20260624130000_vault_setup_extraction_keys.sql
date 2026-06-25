-- ============================================================================
-- Migration: 20260624130000_vault_setup_extraction_keys.sql
-- Date:      2026-06-24
-- Task:      T-403 (#49)
-- Purpose:   Cria as entradas de Vault para as 5 chaves de provider de extração
--            (OCR.space, Google Vision, Gemini, Groq, OpenRouter) e liga cada
--            app_settings.*.api_key_secret_id ao uuid real do secret. O VALOR é
--            um placeholder — o segredo real é injetado post-deploy via
--            app.update_vault_secret(); até lá o worker usa o fallback de env
--            (wire.ts é vault-first, env-fallback — T-403).
-- Spec refs: §7.3 (Vault), §9.3, §6.5 (redaction).
--
-- Design notes:
--   * Usa o wrapper SECURITY DEFINER app.create_vault_secret (o role da migration
--     não tem INSERT direto em vault.secrets).
--   * Ordenação no `db reset`: migrations rodam ANTES do seed. Por isso esta
--     migration faz UPSERT das linhas api_key_secret_id (não só UPDATE — a tabela
--     ainda está vazia nesse momento) e o seed dessas 5 chaves passou a
--     `ON CONFLICT DO NOTHING` (app_settings_defaults.sql), preservando o uuid
--     real que esta migration grava.
--   * Idempotente: pula a criação se a chave já aponta p/ um uuid real
--     (não-placeholder), então um re-run não duplica secrets.
--
-- Rollback (manual): UPDATE app_settings SET value = jsonb_build_object('v',
--   '00000000-0000-0000-0000-000000000000') WHERE key LIKE '%.api_key_secret_id';
--   + DELETE FROM vault.secrets WHERE name LIKE 'unibill_%_api_key'; (via wrapper).
-- ============================================================================

DO $$
DECLARE
  v_id uuid;
  rec  record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('extraction.ocr_space.api_key_secret_id',     'extraction.ocr_space',     'unibill_ocr_space_api_key'),
      ('extraction.google_vision.api_key_secret_id', 'extraction.google_vision', 'unibill_google_vision_api_key'),
      ('ai.gemini.api_key_secret_id',                'ai',                       'unibill_gemini_api_key'),
      ('ai.groq.api_key_secret_id',                  'ai',                       'unibill_groq_api_key'),
      ('ai.openrouter.api_key_secret_id',            'ai',                       'unibill_openrouter_api_key')
    ) AS t(setting_key, category, secret_name)
  LOOP
    -- Already wired to a real (non-placeholder) uuid → don't create a duplicate.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.app_settings
       WHERE key = rec.setting_key AND scope = 'global'
         AND COALESCE(value ->> 'v', '') NOT IN ('', '00000000-0000-0000-0000-000000000000')
    );

    v_id := app.create_vault_secret(
      'SET_VIA_update_vault_secret_AT_DEPLOY',
      rec.secret_name,
      'Unibill provider API key (T-403). Placeholder — set the real key post-deploy '
        || 'via app.update_vault_secret(); until then the worker uses the env fallback.'
    );

    INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
    VALUES (
      rec.setting_key, 'global', NULL, jsonb_build_object('v', v_id::text), rec.category,
      'Ref para o Vault secret (wired por T-403). Valor real via app.update_vault_secret post-deploy.',
      false
    )
    ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
      SET value = EXCLUDED.value, updated_at = now();
  END LOOP;
END $$;

-- ============================================================================
-- Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260624130000_vault_setup_extraction_keys',
  'Cria os Vault secrets das 5 chaves de provider de extração (placeholder) e liga '
  'app_settings.*.api_key_secret_id aos uuids reais. Valor real injetado post-deploy.'
)
ON CONFLICT (migration_name) DO NOTHING;
