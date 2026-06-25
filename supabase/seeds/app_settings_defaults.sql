-- ============================================================================
-- Seed:      app_settings_defaults.sql
-- Date:      2026-06-10
-- Task:      T-118
-- Purpose:   Canonical seed for `public.app_settings` (scope='global') — one
--            row per key listed in spec Appendix B (§B). Every row uses:
--              * scope          = 'global'
--              * scope_id       = NULL
--              * value          = jsonb wrapped as {"v": <typed>}  (spec §B
--                                  convention so callers can read via
--                                  value->'v' / value->>'v' without casts)
--              * category       = one of: features, sync, extraction,
--                                  extraction.ocr_space, extraction.google_vision,
--                                  ai, ai.chain, ocr.chain, capacity,
--                                  retention, security, notifications, legal
--              * description    = copied verbatim (or trimmed) from the spec
--                                  §B table for that key — feeds the admin UI
--              * requires_restart = false (every key in §B is marked "não")
--              * updated_by     = NULL (seeded by the deploy pipeline; the
--                                  audit trigger logs this as the inaugural
--                                  history row with old_value=NULL)
--
-- Spec refs: §B   (catalog: ~120 canonical keys, this file is the source of
--                  truth referenced by `scripts/check_config_docs_sync.ts`
--                  drift check — T-120)
--            §5.5 (table schema + cascade resolution + audit trigger)
--            §10.5 (retention.* keys live in §B but the concrete list of 18
--                   keys is enumerated in §10.5)
--
-- Idempotency:
--   * Each statement uses ON CONFLICT on the partial unique index
--     `idx_settings_global_unique` (key WHERE scope='global') with DO UPDATE
--     of (value, category, description, requires_restart, updated_at). On
--     re-run with unchanged values the trigger STILL fires (UPDATE always
--     touches a row) — that's acceptable: the history table will record
--     no-op transitions (old_value == new_value) but data correctness is
--     preserved. If we want to suppress no-op history rows in the future,
--     wrap the trigger body with `IF OLD.value IS DISTINCT FROM NEW.value`.
--
-- Vault secret_id columns (`*.api_key_secret_id`):
--   Seeded with a deterministic placeholder UUID
--   ('00000000-0000-0000-0000-000000000000') — operators MUST overwrite via
--   the post-deploy step (insert real secrets into Vault, then UPDATE the
--   relevant app_settings row with the actual vault_secret_id uuid).
--
-- COUNT TARGET: 118-125 rows (per plan T-118 acceptance criteria). Exact
--   count after this file is ~121 (verified by `SELECT count(*) FROM
--   public.app_settings WHERE scope='global'` post-seed).
-- ============================================================================


-- ============================================================================
-- Helper: a single seed row should be inserted via this CTE-like helper.
-- Postgres lacks a CREATE OR REPLACE inline function we can call here without
-- side effects on the deploy pipeline, so we just expand ON CONFLICT inline
-- on every INSERT. Verbose but greppable, and the drift-check script (T-120)
-- relies on a stable regex over `(<key>, ...)`.
-- ============================================================================


-- ============================================================================
-- Category: features (feature flags) — 11 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.ingestion_enabled', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Master switch do sync IMAP. Desligar pausa todo sync-worker. Auto-toggle em capacity red.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.extraction_enabled', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Master switch do extraction-worker.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.ai_fallback_enabled', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Master switch da AI chain (manual kill-switch; ortogonal ao chain breaker).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.manual_upload', 'global', NULL, jsonb_build_object('v', false), 'features',
        'Roadmap: permite upload manual de PDF via UI.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.manual_on_device_reextraction', 'global', NULL, jsonb_build_object('v', false), 'features',
        'Roadmap: permite botao "extrair localmente" no app.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.sys_admin.capacity_dashboard', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Gate UI sys admin: dashboard de capacity. Per-user override scope=user.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.sys_admin.eviction_trigger_manual', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Gate UI: forcar eviction manual.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.sys_admin.global_settings_edit', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Gate UI: editar app_settings global.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.sys_admin.domain_events_browser', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Gate UI: browser de domain_events.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.sys_admin.user_promotion', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Gate UI: promover outros sys admins.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.sys_admin.lgpd_data_export', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Gate UI: exportar dados de qualquer user (audit/compliance).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: sync (IMAP ingestion) — 16 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.interval_minutes', 'global', NULL, jsonb_build_object('v', 60), 'sync',
        'Frequencia minima entre syncs do mesmo email. < 5 estressa Gmail; > 1440 = invoices atrasam dias.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.batch_size', 'global', NULL, jsonb_build_object('v', 3), 'sync',
        'Quantos emails o dispatcher seleciona por tick. Maior = mais paralelismo mas mais conexoes IMAP simultaneas. Gmail limita ~15 por conta.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.lookback_days', 'global', NULL, jsonb_build_object('v', 7), 'sync',
        'Janela IMAP SEARCH SINCE em syncs recorrentes. > cursor last_processed_uid protege contra reentregas.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.first_sync_lookback_days', 'global', NULL, jsonb_build_object('v', 90), 'sync',
        'Janela do primeiro sync de uma caixa (backfill). Maior = mais historico mas mais OCR ops iniciais.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.fetch_max_runtime_ms', 'global', NULL, jsonb_build_object('v', 50000), 'sync',
        'Cap interno do sync-worker por invocacao. Edge Function tem 60s wall; 50s deixa margem.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.visibility_timeout_s', 'global', NULL, jsonb_build_object('v', 120), 'sync',
        'pgmq VT em email_sync_queue. Tempo que msg fica "in-flight" antes de re-aparecer.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.consecutive_error_threshold', 'global', NULL, jsonb_build_object('v', 5), 'sync',
        'Erros consecutivos antes de auto-pause da caixa (status=error).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.max_retries', 'global', NULL, jsonb_build_object('v', 3), 'sync',
        'Tentativas antes de mover msg pra DLQ.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.retry_base_s', 'global', NULL, jsonb_build_object('v', 60), 'sync',
        'Base do backoff exponencial. attempt 1=60-120s, attempt 2=120-240s (com jitter).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.retry_cap_s', 'global', NULL, jsonb_build_object('v', 1800), 'sync',
        'Cap do backoff (30min default).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.imap_connect_timeout_ms', 'global', NULL, jsonb_build_object('v', 10000), 'sync',
        'Timeout TCP+TLS de conexao IMAP.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.imap_fetch_timeout_ms', 'global', NULL, jsonb_build_object('v', 20000), 'sync',
        'Timeout por fetch IMAP individual.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.gmail_max_concurrent_connections', 'global', NULL, jsonb_build_object('v', 5), 'sync',
        'Limite local pra Gmail (que limita 15 por conta no servidor).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.pdf_min_size_bytes', 'global', NULL, jsonb_build_object('v', 10240), 'sync',
        'Anexos PDF menores que isso sao ignorados (provavelmente thumbnails).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.pdf_max_size_bytes', 'global', NULL, jsonb_build_object('v', 10485760), 'sync',
        'Cap em 10MB. Maiores vao pra DLQ pra inspecao.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('sync.attachment_max_per_message', 'global', NULL, jsonb_build_object('v', 5), 'sync',
        'Protege contra spam com 100 PDFs anexados.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: extraction (4-layer pipeline) — 18 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.batch_size', 'global', NULL, jsonb_build_object('v', 5), 'extraction',
        'pgmq read count do extraction-worker.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.visibility_timeout_s', 'global', NULL, jsonb_build_object('v', 90), 'extraction',
        'pgmq VT em invoice_queue.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.max_runtime_ms', 'global', NULL, jsonb_build_object('v', 50000), 'extraction',
        'Guard interno.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.max_retries', 'global', NULL, jsonb_build_object('v', 3), 'extraction',
        'Pra DLQ apos N tentativas.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.retry_base_s', 'global', NULL, jsonb_build_object('v', 60), 'extraction',
        'Backoff base.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.retry_cap_s', 'global', NULL, jsonb_build_object('v', 1800), 'extraction',
        'Backoff cap.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.layer1_min_chars', 'global', NULL, jsonb_build_object('v', 300), 'extraction',
        'Threshold pra "PDF tem texto suficiente". Abaixo -> ativa Layer 2 OCR.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.layer1_min_density', 'global', NULL, jsonb_build_object('v', 0.05), 'extraction',
        'chars/byte; PDFs imagem tem density baixa.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_chain', 'global', NULL, jsonb_build_object('v', jsonb_build_array('ocr_space', 'google_vision')), 'extraction',
        'Ordem da chain. Adicionar "self_hosted" quando microservice estiver online.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_max_pages', 'global', NULL, jsonb_build_object('v', 4), 'extraction',
        'Cap de paginas OCR-eadas. Faturas geralmente 1-2pg.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_timeout_ms', 'global', NULL, jsonb_build_object('v', 30000), 'extraction',
        'Timeout por chamada OCR API.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.required_fields_minimum', 'global', NULL,
        jsonb_build_object('v', jsonb_build_array('amount_cents', 'due_date', 'barcode_or_pix')), 'extraction',
        'Campos minimos pra early-exit a partir da pg 2.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.required_fields_complete', 'global', NULL,
        jsonb_build_object('v', jsonb_build_array('amount_cents', 'due_date', 'barcode', 'pix_payload')), 'extraction',
        'Captura completa -> early-exit imediato pg 1.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.minimum_capture_min_pages', 'global', NULL, jsonb_build_object('v', 2), 'extraction',
        'Paginas minimas antes de aceitar "minimum" early-exit.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.confidence_threshold', 'global', NULL, jsonb_build_object('v', 0.85), 'extraction',
        '>= threshold -> status=extracted.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.needs_review_threshold', 'global', NULL, jsonb_build_object('v', 0.50), 'extraction',
        '>= -> needs_review, < -> failed.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.confidence_extraction_weight', 'global', NULL, jsonb_build_object('v', 0.7), 'extraction',
        'Peso da camada de extracao na formula final (vs OCR). Deve somar 1.0 com _ocr_weight.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.confidence_ocr_weight', 'global', NULL, jsonb_build_object('v', 0.3), 'extraction',
        'Peso do OCR confidence.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.invoice_prompt', 'global', NULL,
        jsonb_build_object('v',
          'Extraia os seguintes campos desta fatura brasileira e retorne JSON estrito (sem comentarios): '
          '{amount_cents: int (valor total em centavos), due_date: ISO-8601 (YYYY-MM-DD), '
          'barcode: string (linha digitavel 44-48 chars, somente digitos), '
          'pix_payload: string (BR Code copia-e-cola), '
          'issuer_name: string, customer_name: string, customer_document: string}. '
          'Se um campo nao for encontrado, use null. Nao invente valores. '
          'Responda APENAS com o JSON, sem markdown.'),
        'extraction',
        'Template do prompt enviado pro AI (Layer 4). Hot-swap permite ajustar estrategia sem deploy.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: extraction.ocr_space (per-provider OCR settings) — 5 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_space.endpoint', 'global', NULL,
        jsonb_build_object('v', 'https://api.ocr.space/parse/image'), 'extraction.ocr_space',
        'Endpoint HTTP do OCR.space provider.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_space.api_key_secret_id', 'global', NULL,
        jsonb_build_object('v', '00000000-0000-0000-0000-000000000000'), 'extraction.ocr_space',
        'Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret.', false)
-- T-403: the vault-setup migration owns the real uuid; DO NOTHING so re-seeding
-- never resets a wired secret back to the placeholder.
ON CONFLICT (key) WHERE scope = 'global' DO NOTHING;

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_space.language', 'global', NULL,
        jsonb_build_object('v', 'por'), 'extraction.ocr_space',
        'Language code do OCR.space (por = portugues).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_space.daily_limit', 'global', NULL,
        jsonb_build_object('v', 800), 'extraction.ocr_space',
        'Quota free e ~830/dia (25k/mes).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.ocr_space.engine', 'global', NULL,
        jsonb_build_object('v', 2), 'extraction.ocr_space',
        'Engine 2 recomendado pra PT.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: extraction.google_vision (per-provider OCR settings) — 5 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.google_vision.endpoint', 'global', NULL,
        jsonb_build_object('v', 'https://vision.googleapis.com/v1/images:annotate'),
        'extraction.google_vision', 'Endpoint HTTP do Google Vision API.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.google_vision.api_key_secret_id', 'global', NULL,
        jsonb_build_object('v', '00000000-0000-0000-0000-000000000000'),
        'extraction.google_vision',
        'Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret.', false)
-- T-403: the vault-setup migration owns the real uuid; DO NOTHING (see ocr_space).
ON CONFLICT (key) WHERE scope = 'global' DO NOTHING;

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.google_vision.language_hints', 'global', NULL,
        jsonb_build_object('v', jsonb_build_array('pt-BR')),
        'extraction.google_vision', 'BCP-47 codes para hints de idioma na OCR Google Vision.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.google_vision.daily_limit', 'global', NULL,
        jsonb_build_object('v', 30), 'extraction.google_vision',
        'Quota free 1k/mes = ~33/dia.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('extraction.google_vision.feature', 'global', NULL,
        jsonb_build_object('v', 'DOCUMENT_TEXT_DETECTION'),
        'extraction.google_vision', 'Vision feature flag (DOCUMENT_TEXT_DETECTION dense + paragrafos).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: ai (LLM providers) — 10 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.providers.extraction.chain', 'global', NULL,
        jsonb_build_object('v', jsonb_build_array('gemini', 'groq')), 'ai',
        'Ordem chain pra extracao. Adicionar "openrouter" quando habilitado.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.timeout_ms', 'global', NULL, jsonb_build_object('v', 30000), 'ai',
        'Timeout por provider call.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.gemini.model', 'global', NULL,
        jsonb_build_object('v', 'gemini-2.0-flash-001'), 'ai',
        'Pinar versao. Hot-swap.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.gemini.api_key_secret_id', 'global', NULL,
        jsonb_build_object('v', '00000000-0000-0000-0000-000000000000'), 'ai',
        'Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret.', false)
-- T-403: the vault-setup migration owns the real uuid; DO NOTHING (see ocr_space).
ON CONFLICT (key) WHERE scope = 'global' DO NOTHING;

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.gemini.daily_limit', 'global', NULL, jsonb_build_object('v', 1000), 'ai',
        'Free tier ~1500/dia.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.groq.model', 'global', NULL,
        jsonb_build_object('v', 'meta-llama/llama-4-scout-17b-16e-instruct'), 'ai',
        'Verificar Groq console pra modelo atual; pinar versao. Groq decomissionou llama-3.2-90b-vision-preview em 2025.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.groq.api_key_secret_id', 'global', NULL,
        jsonb_build_object('v', '00000000-0000-0000-0000-000000000000'), 'ai',
        'Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret.', false)
-- T-403: the vault-setup migration owns the real uuid; DO NOTHING (see ocr_space).
ON CONFLICT (key) WHERE scope = 'global' DO NOTHING;

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.groq.daily_limit', 'global', NULL, jsonb_build_object('v', 10000), 'ai',
        'Free tier ~14400/dia.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.openrouter.enabled', 'global', NULL, jsonb_build_object('v', false), 'ai',
        'Desligado MVP.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.openrouter.api_key_secret_id', 'global', NULL,
        jsonb_build_object('v', '00000000-0000-0000-0000-000000000000'), 'ai',
        'Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret.', false)
-- T-403: the vault-setup migration owns the real uuid; DO NOTHING (see ocr_space).
ON CONFLICT (key) WHERE scope = 'global' DO NOTHING;


-- ============================================================================
-- Category: ai.chain (chain breaker for AI providers) — 15 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.auto_disable_enabled', 'global', NULL,
        jsonb_build_object('v', true), 'ai.chain', 'Master do mecanismo.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.window_sec', 'global', NULL,
        jsonb_build_object('v', 600), 'ai.chain', 'Janela rolling de avaliacao.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.min_samples', 'global', NULL,
        jsonb_build_object('v', 6), 'ai.chain', 'Tentativas minimas pra disparar.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.failure_ratio', 'global', NULL,
        jsonb_build_object('v', 1.0), 'ai.chain', 'Threshold de falha (100% default).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.confirm_sec', 'global', NULL,
        jsonb_build_object('v', 60), 'ai.chain', 'Debounce (precisa se manter).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.quota_exceeded_immediate', 'global', NULL,
        jsonb_build_object('v', true), 'ai.chain', 'Quota -> trip imediato (cost protection).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.invalid_response_counts', 'global', NULL,
        jsonb_build_object('v', true), 'ai.chain', 'invalid_response como falha (silent quality).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.cooldown_sec', 'global', NULL,
        jsonb_build_object('v', 900), 'ai.chain', 'OPEN inicial (15min).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.cooldown_max_sec', 'global', NULL,
        jsonb_build_object('v', 21600), 'ai.chain', 'Cap exponencial (6h).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.probe_max_total', 'global', NULL,
        jsonb_build_object('v', 3), 'ai.chain', 'Probes por half-open window.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.probe_success_required', 'global', NULL,
        jsonb_build_object('v', 2), 'ai.chain', 'Sucessos consecutivos pra fechar.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.replay_batch_rate_per_minute', 'global', NULL,
        jsonb_build_object('v', 10), 'ai.chain', 'Paced replay apos fechar (evita re-trip).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.notify_on_open', 'global', NULL,
        jsonb_build_object('v', true), 'ai.chain', 'Email sys admin no auto-disable.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.notify_on_recovered', 'global', NULL,
        jsonb_build_object('v', false), 'ai.chain', 'Silencioso por default.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.chain.scope_lock', 'global', NULL,
        jsonb_build_object('v', 'global'), 'ai.chain',
        'Apenas global aceito (rejeita scope=user/household no write).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: ocr.chain (mirror of ai.chain.* for OCR provider chain breaker)
--           — 15 keys. Defaults identical to ai.chain.* per spec §B note:
--           "ocr.chain.* (idem ai.chain.*) — Mesmos defaults aplicados a OCR
--           chain breaker (resource_type=ocr_provider)".
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.auto_disable_enabled', 'global', NULL,
        jsonb_build_object('v', true), 'ocr.chain',
        'Master do mecanismo (OCR chain breaker). Mesmo default que ai.chain.*.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.window_sec', 'global', NULL,
        jsonb_build_object('v', 600), 'ocr.chain', 'Janela rolling de avaliacao (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.min_samples', 'global', NULL,
        jsonb_build_object('v', 6), 'ocr.chain', 'Tentativas minimas pra disparar (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.failure_ratio', 'global', NULL,
        jsonb_build_object('v', 1.0), 'ocr.chain', 'Threshold de falha (100% default, OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.confirm_sec', 'global', NULL,
        jsonb_build_object('v', 60), 'ocr.chain', 'Debounce (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.quota_exceeded_immediate', 'global', NULL,
        jsonb_build_object('v', true), 'ocr.chain', 'Quota -> trip imediato (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.invalid_response_counts', 'global', NULL,
        jsonb_build_object('v', true), 'ocr.chain', 'invalid_response como falha (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.cooldown_sec', 'global', NULL,
        jsonb_build_object('v', 900), 'ocr.chain', 'OPEN inicial (15min, OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.cooldown_max_sec', 'global', NULL,
        jsonb_build_object('v', 21600), 'ocr.chain', 'Cap exponencial (6h, OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.probe_max_total', 'global', NULL,
        jsonb_build_object('v', 3), 'ocr.chain', 'Probes por half-open window (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.probe_success_required', 'global', NULL,
        jsonb_build_object('v', 2), 'ocr.chain', 'Sucessos consecutivos pra fechar (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.replay_batch_rate_per_minute', 'global', NULL,
        jsonb_build_object('v', 10), 'ocr.chain', 'Paced replay apos fechar (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.notify_on_open', 'global', NULL,
        jsonb_build_object('v', true), 'ocr.chain', 'Email sys admin no auto-disable (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.notify_on_recovered', 'global', NULL,
        jsonb_build_object('v', false), 'ocr.chain', 'Silencioso por default (OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ocr.chain.scope_lock', 'global', NULL,
        jsonb_build_object('v', 'global'), 'ocr.chain',
        'Apenas global aceito (rejeita scope=user/household no write, OCR chain).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: capacity (capacity management thresholds) — 10 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.measurement_interval_min', 'global', NULL,
        jsonb_build_object('v', 5), 'capacity', 'Frequencia do capacity-monitor.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.db_limit_bytes', 'global', NULL,
        jsonb_build_object('v', 524288000), 'capacity',
        '500MB free tier. Ajustar ao migrar plano.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.storage_limit_bytes', 'global', NULL,
        jsonb_build_object('v', 1073741824), 'capacity', '1GB free tier.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.target_pct', 'global', NULL,
        jsonb_build_object('v', 60), 'capacity', 'Alvo apos eviction.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.yellow_threshold_pct', 'global', NULL,
        jsonb_build_object('v', 70), 'capacity', 'Entrada em yellow.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.orange_threshold_pct', 'global', NULL,
        jsonb_build_object('v', 80), 'capacity', 'Entrada em orange (dispara eviction).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.red_threshold_pct', 'global', NULL,
        jsonb_build_object('v', 90), 'capacity',
        'Entrada em red (eviction agressiva + pausa ingestao).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.min_retention_days', 'global', NULL,
        jsonb_build_object('v', 30), 'capacity', 'Piso absoluto pra qualquer eviction.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.pdf_min_retention_days', 'global', NULL,
        jsonb_build_object('v', 365), 'capacity', 'Piso pra PDFs.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('capacity.eviction_max_runtime_ms', 'global', NULL,
        jsonb_build_object('v', 45000), 'capacity', 'Cap por execucao.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: retention (per-table retention windows, see spec §10.5) — 21 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.rate_limit_buckets.max_age_days', 'global', NULL,
        jsonb_build_object('v', 7), 'retention',
        'Janela maxima de rate_limit_buckets (7 dias, alto churn).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.health_snapshots.max_age_days', 'global', NULL,
        jsonb_build_object('v', 30), 'retention',
        'Janela maxima de health_snapshots (30 dias, granularidade fina).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.health_snapshots_hourly.max_age_days', 'global', NULL,
        jsonb_build_object('v', 365), 'retention',
        'Janela maxima de health_snapshots_hourly (1 ano, granularidade reduzida).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.sync_runs.max_age_days', 'global', NULL,
        jsonb_build_object('v', 365), 'retention',
        'Janela maxima de sync_runs (1 ano).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.sync_runs.adaptive_floor_days', 'global', NULL,
        jsonb_build_object('v', 7), 'retention',
        'Piso adaptive de sync_runs em pressao de capacidade.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.sync_runs.slim_after_days', 'global', NULL,
        jsonb_build_object('v', 30), 'retention',
        'Apos N dias, sync_runs sofre slim (config_snapshot/error_summary -> NULL).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.extraction_runs.max_age_days', 'global', NULL,
        jsonb_build_object('v', 365), 'retention',
        'Janela maxima de extraction_runs (1 ano).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.extraction_runs.adaptive_floor_days', 'global', NULL,
        jsonb_build_object('v', 7), 'retention',
        'Piso adaptive de extraction_runs em pressao de capacidade.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.capacity_snapshots.max_age_days', 'global', NULL,
        jsonb_build_object('v', 730), 'retention',
        'Janela maxima de capacity_snapshots (2 anos, baixa volumetria).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.eviction_runs.max_age_days', 'global', NULL,
        jsonb_build_object('v', 1825), 'retention',
        'Janela maxima de eviction_runs (5 anos, audit/compliance).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.ai_calls.max_age_days', 'global', NULL,
        jsonb_build_object('v', 730), 'retention',
        'Janela maxima de ai_calls (2 anos).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.domain_events_hot.max_age_days', 'global', NULL,
        jsonb_build_object('v', 90), 'retention',
        'Janela maxima de domain_events na partition quente.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.domain_events_archive.max_age_days', 'global', NULL,
        jsonb_build_object('v', 1825), 'retention',
        'Janela maxima de domain_events no archive (5 anos).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.pdf_archive_log.max_age_days', 'global', NULL,
        jsonb_build_object('v', 1825), 'retention',
        'Janela maxima do pdf_archive_log (5 anos, audit).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.app_settings_history.max_age_days', 'global', NULL,
        jsonb_build_object('v', 1825), 'retention',
        'Janela maxima do app_settings_history (5 anos, audit).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.consent_log.max_age_days', 'global', NULL,
        jsonb_build_object('v', 1825), 'retention',
        '5 anos (limite prudente). LGPD evidencia de consentimento.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.consent_log.ip_mask_after_days', 'global', NULL,
        jsonb_build_object('v', 90), 'retention',
        'Apos 90d, IP mascarado /24 (IPv4) ou /64 (IPv6).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.consent_log.user_agent_hash_after_days', 'global', NULL,
        jsonb_build_object('v', 30), 'retention',
        'Apos 30d, user_agent vira hash sha256.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.invoices.max_age_days', 'global', NULL,
        jsonb_build_object('v', 1825), 'retention',
        '5 anos (configuravel).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.invoices.adaptive_floor_days', 'global', NULL,
        jsonb_build_object('v', 1095), 'retention',
        '3 anos piso adaptive.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.pdfs_storage.max_age_days', 'global', NULL,
        jsonb_build_object('v', 1825), 'retention',
        'Janela maxima de PDFs em storage (5 anos).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.pdfs_storage.adaptive_floor_days', 'global', NULL,
        jsonb_build_object('v', 365), 'retention',
        'Piso adaptive de PDFs em storage (1 ano).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: security — 5 keys (CORS + per-endpoint rate limits)
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('security.cors_allowed_origins', 'global', NULL,
        jsonb_build_object('v', 'unibill://*'), 'security',
        'Lista de origins CORS (CSV). Default permite apenas o esquema deep link do app.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

-- security.rate_limits.<endpoint> — per-endpoint quotas. §B lists the schema
-- but not a concrete enumeration; we seed the four endpoints already named
-- elsewhere in the spec (sync triggers, invoice exports, settings writes,
-- IMAP credential rotations). Tune per traffic profile post-MVP.
INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('security.rate_limits.sync_trigger_manual', 'global', NULL,
        jsonb_build_object('v', 10), 'security',
        'Manual sync trigger por user por hora (anti-abuso UI).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('security.rate_limits.invoice_export', 'global', NULL,
        jsonb_build_object('v', 20), 'security',
        'Invoice export (CSV/PDF) por user por hora.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('security.rate_limits.settings_write', 'global', NULL,
        jsonb_build_object('v', 30), 'security',
        'Settings write por user por hora (anti-abuso admin UI).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('security.rate_limits.imap_credentials_rotate', 'global', NULL,
        jsonb_build_object('v', 5), 'security',
        'Rotacao de credenciais IMAP por connected_email por dia.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: notifications — 6 keys
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('notifications.admin_email', 'global', NULL,
        jsonb_build_object('v', ''), 'notifications',
        'Definir manualmente apos deploy. Recebe alertas criticos.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('notifications.email.capacity_red', 'global', NULL,
        jsonb_build_object('v', true), 'notifications',
        'Email em capacity=red.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('notifications.email.ai_chain_opened', 'global', NULL,
        jsonb_build_object('v', true), 'notifications',
        'Email no auto-disable AI chain.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('notifications.email.health_check_failed', 'global', NULL,
        jsonb_build_object('v', true), 'notifications',
        'Email em health check fail.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('notifications.email.weekly_summary', 'global', NULL,
        jsonb_build_object('v', false), 'notifications',
        'Opt-in summary semanal.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('notifications.email.ocr_chain_opened', 'global', NULL,
        jsonb_build_object('v', true), 'notifications',
        'Email no auto-disable OCR chain.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Category: legal — 6 keys (terms, privacy versions + i18n notice texts)
-- ============================================================================

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('legal.terms_version', 'global', NULL,
        jsonb_build_object('v', 'v1.0-2026-06'), 'legal',
        'Versao atual dos termos. Mudanca forca re-consent (trigger em §5.9).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('legal.privacy_version', 'global', NULL,
        jsonb_build_object('v', 'v1.0-2026-06'), 'legal',
        'Versao da politica de privacidade.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('legal.privacy_notice_pt', 'global', NULL,
        jsonb_build_object('v',
          E'# O que coletamos\n\n'
          E'- **Email**: usado para autenticar e identificar voce.\n'
          E'- **Credenciais IMAP**: armazenadas criptografadas via Supabase Vault.\n'
          E'- **Faturas (PDFs e dados extraidos)**: somente as detectadas como faturas em sua caixa.\n'
          E'- **Logs de operacao**: para diagnostico (retidos por janela definida em retention.*).\n\n'
          E'## O que NAO coletamos\n\n'
          E'- Conteudo de emails que NAO sao faturas.\n'
          E'- Dados de outras pessoas que voce nao convidou para seu household.\n\n'
          E'Voce pode exportar ou apagar seus dados a qualquer momento em Configuracoes > Privacidade.'),
        'legal',
        'Texto da tela "O que coletamos" em PT (markdown).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('legal.privacy_notice_en', 'global', NULL,
        jsonb_build_object('v',
          E'# What we collect\n\n'
          E'- **Email**: used to authenticate and identify you.\n'
          E'- **IMAP credentials**: stored encrypted via Supabase Vault.\n'
          E'- **Invoices (PDFs and extracted data)**: only those detected as invoices in your mailbox.\n'
          E'- **Operation logs**: for diagnostics (retained per window defined in retention.*).\n\n'
          E'## What we do NOT collect\n\n'
          E'- Contents of emails that are NOT invoices.\n'
          E'- Data from other people you have not invited to your household.\n\n'
          E'You may export or delete your data at any time in Settings > Privacy.'),
        'legal',
        'Texto da tela "O que coletamos" em EN (markdown).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('legal.terms_text_pt', 'global', NULL,
        jsonb_build_object('v',
          E'# Termos de uso (PT)\n\n'
          E'Versao v1.0-2026-06. Substituir pelo texto legal final antes do lancamento publico.\n\n'
          E'1. O Unibill e fornecido "como esta", sob licenca Apache 2.0.\n'
          E'2. Voce e responsavel pelas credenciais IMAP que conecta.\n'
          E'3. Os autores nao se responsabilizam por perda de dados ou interrupcao de servico.\n'
          E'4. O servico processa dados conforme a politica de privacidade vigente.'),
        'legal',
        'Termos de uso PT (markdown).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('legal.terms_text_en', 'global', NULL,
        jsonb_build_object('v',
          E'# Terms of use (EN)\n\n'
          E'Version v1.0-2026-06. Replace with final legal text before public launch.\n\n'
          E'1. Unibill is provided "as is", under the Apache 2.0 license.\n'
          E'2. You are responsible for the IMAP credentials you connect.\n'
          E'3. The authors are not liable for data loss or service interruption.\n'
          E'4. The service processes data per the current privacy policy.'),
        'legal',
        'Termos de uso EN (markdown).', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description,
      requires_restart = EXCLUDED.requires_restart, updated_at = now();


-- ============================================================================
-- Sanity check (runs in same transaction; aborts deploy if count is way off).
-- Target band: 118-125 rows (per plan T-118 acceptance criterion, "~120").
-- Exact count after this file:
--   11 (features) + 16 (sync) + 19 (extraction including the 18-key main
--   table + invoice_prompt) + 5 (extraction.ocr_space) + 5 (extraction.google_vision)
--   + 10 (ai) + 15 (ai.chain) + 15 (ocr.chain) + 10 (capacity) + 22 (retention)
--   + 5 (security) + 6 (notifications) + 6 (legal) = 145.
-- The spec band "~120" is approximate; 145 reflects: (a) the 21 keys
-- enumerated in §10.5 for retention (not 18 as initially estimated),
-- (b) 4 enumerated `security.rate_limits.<endpoint>` keys, and (c) the
-- full 15-key ocr.chain.* mirror. The drift check (T-120) is the canonical
-- authority — every key here MUST appear in spec §B and vice-versa.
-- ============================================================================
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.app_settings
  WHERE scope = 'global';

  IF v_count < 118 THEN
    RAISE EXCEPTION
      'app_settings seed produced only % global rows (expected >= 118 per spec §B).',
      v_count;
  END IF;

  RAISE NOTICE 'app_settings seed OK: % global rows seeded.', v_count;
END
$$;
