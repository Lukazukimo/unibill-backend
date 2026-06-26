# Configuration reference

> **Generated** — the table below is produced from the source-of-truth seed
> `supabase/seeds/app_settings_defaults.sql` by
> [`scripts/gen_configuration_doc.ts`](../scripts/gen_configuration_doc.ts).
> **Do not edit between the markers** — change the seed and re-run the generator
> (`deno run --allow-read --allow-write scripts/gen_configuration_doc.ts`).
>
> Every key lives in `public.app_settings` (scope `global`, value wrapped as
> `{"v": <typed>}`) and is read through the cascade resolver. See spec §B and
> the [data dictionary](data-dictionary.md).

<!-- BEGIN-GENERATED:config -->

### `ai` (10)

| Key | Default | Description |
|---|---|---|
| `ai.gemini.api_key_secret_id` | `00000000-0000-0000-0000-000000000000` | Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret. |
| `ai.gemini.daily_limit` | `1000` | Free tier ~1500/dia. |
| `ai.gemini.model` | `gemini-2.0-flash-001` | Pinar versao. Hot-swap. |
| `ai.groq.api_key_secret_id` | `00000000-0000-0000-0000-000000000000` | Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret. |
| `ai.groq.daily_limit` | `10000` | Free tier ~14400/dia. |
| `ai.groq.model` | `meta-llama/llama-4-scout-17b-16e-instruct` | Verificar Groq console pra modelo atual; pinar versao. Groq decomissionou llama-3.2-90b-vision-preview em 2025. |
| `ai.openrouter.api_key_secret_id` | `00000000-0000-0000-0000-000000000000` | Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret. |
| `ai.openrouter.enabled` | `false` | Desligado MVP. |
| `ai.providers.extraction.chain` | `jsonb_build_array('gemini', 'groq')` | Ordem chain pra extracao. Adicionar "openrouter" quando habilitado. |
| `ai.timeout_ms` | `30000` | Timeout por provider call. |

---

### `ai.chain` (15)

| Key | Default | Description |
|---|---|---|
| `ai.chain.auto_disable_enabled` | `true` | Master do mecanismo. |
| `ai.chain.confirm_sec` | `60` | Debounce (precisa se manter). |
| `ai.chain.cooldown_max_sec` | `21600` | Cap exponencial (6h). |
| `ai.chain.cooldown_sec` | `900` | OPEN inicial (15min). |
| `ai.chain.failure_ratio` | `1.0` | Threshold de falha (100% default). |
| `ai.chain.invalid_response_counts` | `true` | invalid_response como falha (silent quality). |
| `ai.chain.min_samples` | `6` | Tentativas minimas pra disparar. |
| `ai.chain.notify_on_open` | `true` | Email sys admin no auto-disable. |
| `ai.chain.notify_on_recovered` | `false` | Silencioso por default. |
| `ai.chain.probe_max_total` | `3` | Probes por half-open window. |
| `ai.chain.probe_success_required` | `2` | Sucessos consecutivos pra fechar. |
| `ai.chain.quota_exceeded_immediate` | `true` | Quota -> trip imediato (cost protection). |
| `ai.chain.replay_batch_rate_per_minute` | `10` | Paced replay apos fechar (evita re-trip). |
| `ai.chain.scope_lock` | `global` | Apenas global aceito (rejeita scope=user/household no write). |
| `ai.chain.window_sec` | `600` | Janela rolling de avaliacao. |

---

### `capacity` (10)

| Key | Default | Description |
|---|---|---|
| `capacity.db_limit_bytes` | `524288000` | 500MB free tier. Ajustar ao migrar plano. |
| `capacity.eviction_max_runtime_ms` | `45000` | Cap por execucao. |
| `capacity.measurement_interval_min` | `5` | Frequencia do capacity-monitor. |
| `capacity.min_retention_days` | `30` | Piso absoluto pra qualquer eviction. |
| `capacity.orange_threshold_pct` | `80` | Entrada em orange (dispara eviction). |
| `capacity.pdf_min_retention_days` | `365` | Piso pra PDFs. |
| `capacity.red_threshold_pct` | `90` | Entrada em red (eviction agressiva + pausa ingestao). |
| `capacity.storage_limit_bytes` | `1073741824` | 1GB free tier. |
| `capacity.target_pct` | `60` | Alvo apos eviction. |
| `capacity.yellow_threshold_pct` | `70` | Entrada em yellow. |

---

### `extraction` (19)

| Key | Default | Description |
|---|---|---|
| `extraction.batch_size` | `5` | pgmq read count do extraction-worker. |
| `extraction.confidence_extraction_weight` | `0.7` | Peso da camada de extracao na formula final (vs OCR). Deve somar 1.0 com _ocr_weight. |
| `extraction.confidence_ocr_weight` | `0.3` | Peso do OCR confidence. |
| `extraction.confidence_threshold` | `0.85` | >= threshold -> status=extracted. |
| `extraction.invoice_prompt` | `Extraia os seguintes campos desta fatura brasileira e retorne JSON estrito (sem comentarios): {amount_cents: int (valor total em centavos), due_date: ISO-8601 (YYYY-MM-DD), barcode: string (linha digitavel 44-48 chars, somente digitos), pix_payload: string (BR Code copia-e-cola), issuer_name: string, customer_name: string, customer_document: string}. Se um campo nao for encontrado, use null. Nao invente valores. Responda APENAS com o JSON, sem markdown.` | Template do prompt enviado pro AI (Layer 4). Hot-swap permite ajustar estrategia sem deploy. |
| `extraction.layer1_min_chars` | `300` | Threshold pra "PDF tem texto suficiente". Abaixo -> ativa Layer 2 OCR. |
| `extraction.layer1_min_density` | `0.05` | chars/byte; PDFs imagem tem density baixa. |
| `extraction.max_retries` | `3` | Pra DLQ apos N tentativas. |
| `extraction.max_runtime_ms` | `50000` | Guard interno. |
| `extraction.minimum_capture_min_pages` | `2` | Paginas minimas antes de aceitar "minimum" early-exit. |
| `extraction.needs_review_threshold` | `0.50` | >= -> needs_review, < -> failed. |
| `extraction.ocr_chain` | `jsonb_build_array('ocr_space', 'google_vision')` | Ordem da chain. Adicionar "self_hosted" quando microservice estiver online. |
| `extraction.ocr_max_pages` | `4` | Cap de paginas OCR-eadas. Faturas geralmente 1-2pg. |
| `extraction.ocr_timeout_ms` | `30000` | Timeout por chamada OCR API. |
| `extraction.required_fields_complete` | `jsonb_build_array('amount_cents', 'due_date', 'barcode', 'pix_payload')` | Captura completa -> early-exit imediato pg 1. |
| `extraction.required_fields_minimum` | `jsonb_build_array('amount_cents', 'due_date', 'barcode_or_pix')` | Campos minimos pra early-exit a partir da pg 2. |
| `extraction.retry_base_s` | `60` | Backoff base. |
| `extraction.retry_cap_s` | `1800` | Backoff cap. |
| `extraction.visibility_timeout_s` | `90` | pgmq VT em invoice_queue. |

---

### `extraction.google_vision` (5)

| Key | Default | Description |
|---|---|---|
| `extraction.google_vision.api_key_secret_id` | `00000000-0000-0000-0000-000000000000` | Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret. |
| `extraction.google_vision.daily_limit` | `30` | Quota free 1k/mes = ~33/dia. |
| `extraction.google_vision.endpoint` | `https://vision.googleapis.com/v1/images:annotate` | Endpoint HTTP do Google Vision API. |
| `extraction.google_vision.feature` | `DOCUMENT_TEXT_DETECTION` | Vision feature flag (DOCUMENT_TEXT_DETECTION dense + paragrafos). |
| `extraction.google_vision.language_hints` | `jsonb_build_array('pt-BR')` | BCP-47 codes para hints de idioma na OCR Google Vision. |

---

### `extraction.ocr_space` (5)

| Key | Default | Description |
|---|---|---|
| `extraction.ocr_space.api_key_secret_id` | `00000000-0000-0000-0000-000000000000` | Ref pra Vault secret. Substituir manualmente post-deploy pelo uuid real do vault_secret. |
| `extraction.ocr_space.daily_limit` | `800` | Quota free e ~830/dia (25k/mes). |
| `extraction.ocr_space.endpoint` | `https://api.ocr.space/parse/image` | Endpoint HTTP do OCR.space provider. |
| `extraction.ocr_space.engine` | `2` | Engine 2 recomendado pra PT. |
| `extraction.ocr_space.language` | `por` | Language code do OCR.space (por = portugues). |

---

### `features` (11)

| Key | Default | Description |
|---|---|---|
| `features.ai_fallback_enabled` | `true` | Master switch da AI chain (manual kill-switch; ortogonal ao chain breaker). |
| `features.extraction_enabled` | `true` | Master switch do extraction-worker. |
| `features.ingestion_enabled` | `true` | Master switch do sync IMAP. Desligar pausa todo sync-worker. Auto-toggle em capacity red. |
| `features.manual_on_device_reextraction` | `false` | Roadmap: permite botao "extrair localmente" no app. |
| `features.manual_upload` | `false` | Roadmap: permite upload manual de PDF via UI. |
| `features.sys_admin.capacity_dashboard` | `true` | Gate UI sys admin: dashboard de capacity. Per-user override scope=user. |
| `features.sys_admin.domain_events_browser` | `true` | Gate UI: browser de domain_events. |
| `features.sys_admin.eviction_trigger_manual` | `true` | Gate UI: forcar eviction manual. |
| `features.sys_admin.global_settings_edit` | `true` | Gate UI: editar app_settings global. |
| `features.sys_admin.lgpd_data_export` | `true` | Gate UI: exportar dados de qualquer user (audit/compliance). |
| `features.sys_admin.user_promotion` | `true` | Gate UI: promover outros sys admins. |

---

### `legal` (6)

| Key | Default | Description |
|---|---|---|
| `legal.privacy_notice_en` | `E'# What we collect\n\n'           E'- **Email**: used to authenticate and identify you.\n'           E'- **IMAP credentials**: stored encrypted via Supabase Vault.\n'           E'- **Invoices (PDFs and extracted data)**: only those detected as invoices in your mailbox.\n'           E'- **Operation logs**: for diagnostics (retained per window defined in retention.*).\n\n'           E'## What we do NOT collect\n\n'           E'- Contents of emails that are NOT invoices.\n'           E'- Data from other people you have not invited to your household.\n\n'           E'You may export or delete your data at any time in Settings > Privacy.'` | Texto da tela "O que coletamos" em EN (markdown). |
| `legal.privacy_notice_pt` | `E'# O que coletamos\n\n'           E'- **Email**: usado para autenticar e identificar voce.\n'           E'- **Credenciais IMAP**: armazenadas criptografadas via Supabase Vault.\n'           E'- **Faturas (PDFs e dados extraidos)**: somente as detectadas como faturas em sua caixa.\n'           E'- **Logs de operacao**: para diagnostico (retidos por janela definida em retention.*).\n\n'           E'## O que NAO coletamos\n\n'           E'- Conteudo de emails que NAO sao faturas.\n'           E'- Dados de outras pessoas que voce nao convidou para seu household.\n\n'           E'Voce pode exportar ou apagar seus dados a qualquer momento em Configuracoes > Privacidade.'` | Texto da tela "O que coletamos" em PT (markdown). |
| `legal.privacy_version` | `v1.0-2026-06` | Versao da politica de privacidade. |
| `legal.terms_text_en` | `E'# Terms of use (EN)\n\n'           E'Version v1.0-2026-06. Replace with final legal text before public launch.\n\n'           E'1. Unibill is provided "as is", under the Apache 2.0 license.\n'           E'2. You are responsible for the IMAP credentials you connect.\n'           E'3. The authors are not liable for data loss or service interruption.\n'           E'4. The service processes data per the current privacy policy.'` | Termos de uso EN (markdown). |
| `legal.terms_text_pt` | `E'# Termos de uso (PT)\n\n'           E'Versao v1.0-2026-06. Substituir pelo texto legal final antes do lancamento publico.\n\n'           E'1. O Unibill e fornecido "como esta", sob licenca Apache 2.0.\n'           E'2. Voce e responsavel pelas credenciais IMAP que conecta.\n'           E'3. Os autores nao se responsabilizam por perda de dados ou interrupcao de servico.\n'           E'4. O servico processa dados conforme a politica de privacidade vigente.'` | Termos de uso PT (markdown). |
| `legal.terms_version` | `v1.0-2026-06` | Versao atual dos termos. Mudanca forca re-consent (trigger em §5.9). |

---

### `notifications` (6)

| Key | Default | Description |
|---|---|---|
| `notifications.admin_email` | `` | Definir manualmente apos deploy. Recebe alertas criticos. |
| `notifications.email.ai_chain_opened` | `true` | Email no auto-disable AI chain. |
| `notifications.email.capacity_red` | `true` | Email em capacity=red. |
| `notifications.email.health_check_failed` | `true` | Email em health check fail. |
| `notifications.email.ocr_chain_opened` | `true` | Email no auto-disable OCR chain. |
| `notifications.email.weekly_summary` | `false` | Opt-in summary semanal. |

---

### `ocr.chain` (15)

| Key | Default | Description |
|---|---|---|
| `ocr.chain.auto_disable_enabled` | `true` | Master do mecanismo (OCR chain breaker). Mesmo default que ai.chain.*. |
| `ocr.chain.confirm_sec` | `60` | Debounce (OCR chain). |
| `ocr.chain.cooldown_max_sec` | `21600` | Cap exponencial (6h, OCR chain). |
| `ocr.chain.cooldown_sec` | `900` | OPEN inicial (15min, OCR chain). |
| `ocr.chain.failure_ratio` | `1.0` | Threshold de falha (100% default, OCR chain). |
| `ocr.chain.invalid_response_counts` | `true` | invalid_response como falha (OCR chain). |
| `ocr.chain.min_samples` | `6` | Tentativas minimas pra disparar (OCR chain). |
| `ocr.chain.notify_on_open` | `true` | Email sys admin no auto-disable (OCR chain). |
| `ocr.chain.notify_on_recovered` | `false` | Silencioso por default (OCR chain). |
| `ocr.chain.probe_max_total` | `3` | Probes por half-open window (OCR chain). |
| `ocr.chain.probe_success_required` | `2` | Sucessos consecutivos pra fechar (OCR chain). |
| `ocr.chain.quota_exceeded_immediate` | `true` | Quota -> trip imediato (OCR chain). |
| `ocr.chain.replay_batch_rate_per_minute` | `10` | Paced replay apos fechar (OCR chain). |
| `ocr.chain.scope_lock` | `global` | Apenas global aceito (rejeita scope=user/household no write, OCR chain). |
| `ocr.chain.window_sec` | `600` | Janela rolling de avaliacao (OCR chain). |

---

### `retention` (22)

| Key | Default | Description |
|---|---|---|
| `retention.ai_calls.max_age_days` | `730` | Janela maxima de ai_calls (2 anos). |
| `retention.app_settings_history.max_age_days` | `1825` | Janela maxima do app_settings_history (5 anos, audit). |
| `retention.capacity_snapshots.max_age_days` | `730` | Janela maxima de capacity_snapshots (2 anos, baixa volumetria). |
| `retention.consent_log.ip_mask_after_days` | `90` | Apos 90d, IP mascarado /24 (IPv4) ou /64 (IPv6). |
| `retention.consent_log.max_age_days` | `1825` | 5 anos (limite prudente). LGPD evidencia de consentimento. |
| `retention.consent_log.user_agent_hash_after_days` | `30` | Apos 30d, user_agent vira hash sha256. |
| `retention.domain_events_archive.max_age_days` | `1825` | Janela maxima de domain_events no archive (5 anos). |
| `retention.domain_events_hot.max_age_days` | `90` | Janela maxima de domain_events na partition quente. |
| `retention.eviction_runs.max_age_days` | `1825` | Janela maxima de eviction_runs (5 anos, audit/compliance). |
| `retention.extraction_runs.adaptive_floor_days` | `7` | Piso adaptive de extraction_runs em pressao de capacidade. |
| `retention.extraction_runs.max_age_days` | `365` | Janela maxima de extraction_runs (1 ano). |
| `retention.health_snapshots_hourly.max_age_days` | `365` | Janela maxima de health_snapshots_hourly (1 ano, granularidade reduzida). |
| `retention.health_snapshots.max_age_days` | `30` | Janela maxima de health_snapshots (30 dias, granularidade fina). |
| `retention.invoices.adaptive_floor_days` | `1095` | 3 anos piso adaptive. |
| `retention.invoices.max_age_days` | `1825` | 5 anos (configuravel). |
| `retention.pdf_archive_log.max_age_days` | `1825` | Janela maxima do pdf_archive_log (5 anos, audit). |
| `retention.pdfs_storage.adaptive_floor_days` | `365` | Piso adaptive de PDFs em storage (1 ano). |
| `retention.pdfs_storage.max_age_days` | `1825` | Janela maxima de PDFs em storage (5 anos). |
| `retention.rate_limit_buckets.max_age_days` | `7` | Janela maxima de rate_limit_buckets (7 dias, alto churn). |
| `retention.sync_runs.adaptive_floor_days` | `7` | Piso adaptive de sync_runs em pressao de capacidade. |
| `retention.sync_runs.max_age_days` | `365` | Janela maxima de sync_runs (1 ano). |
| `retention.sync_runs.slim_after_days` | `30` | Apos N dias, sync_runs sofre slim (config_snapshot/error_summary -> NULL). |

---

### `security` (5)

| Key | Default | Description |
|---|---|---|
| `security.cors_allowed_origins` | `unibill://*` | Lista de origins CORS (CSV). Default permite apenas o esquema deep link do app. |
| `security.rate_limits.imap_credentials_rotate` | `5` | Rotacao de credenciais IMAP por connected_email por dia. |
| `security.rate_limits.invoice_export` | `20` | Invoice export (CSV/PDF) por user por hora. |
| `security.rate_limits.settings_write` | `30` | Settings write por user por hora (anti-abuso admin UI). |
| `security.rate_limits.sync_trigger_manual` | `10` | Manual sync trigger por user por hora (anti-abuso UI). |

---

### `sync` (16)

| Key | Default | Description |
|---|---|---|
| `sync.attachment_max_per_message` | `5` | Protege contra spam com 100 PDFs anexados. |
| `sync.batch_size` | `3` | Quantos emails o dispatcher seleciona por tick. Maior = mais paralelismo mas mais conexoes IMAP simultaneas. Gmail limita ~15 por conta. |
| `sync.consecutive_error_threshold` | `5` | Erros consecutivos antes de auto-pause da caixa (status=error). |
| `sync.fetch_max_runtime_ms` | `50000` | Cap interno do sync-worker por invocacao. Edge Function tem 60s wall; 50s deixa margem. |
| `sync.first_sync_lookback_days` | `90` | Janela do primeiro sync de uma caixa (backfill). Maior = mais historico mas mais OCR ops iniciais. |
| `sync.gmail_max_concurrent_connections` | `5` | Limite local pra Gmail (que limita 15 por conta no servidor). |
| `sync.imap_connect_timeout_ms` | `10000` | Timeout TCP+TLS de conexao IMAP. |
| `sync.imap_fetch_timeout_ms` | `20000` | Timeout por fetch IMAP individual. |
| `sync.interval_minutes` | `60` | Frequencia minima entre syncs do mesmo email. < 5 estressa Gmail; > 1440 = invoices atrasam dias. |
| `sync.lookback_days` | `7` | Janela IMAP SEARCH SINCE em syncs recorrentes. > cursor last_processed_uid protege contra reentregas. |
| `sync.max_retries` | `3` | Tentativas antes de mover msg pra DLQ. |
| `sync.pdf_max_size_bytes` | `10485760` | Cap em 10MB. Maiores vao pra DLQ pra inspecao. |
| `sync.pdf_min_size_bytes` | `10240` | Anexos PDF menores que isso sao ignorados (provavelmente thumbnails). |
| `sync.retry_base_s` | `60` | Base do backoff exponencial. attempt 1=60-120s, attempt 2=120-240s (com jitter). |
| `sync.retry_cap_s` | `1800` | Cap do backoff (30min default). |
| `sync.visibility_timeout_s` | `120` | pgmq VT em email_sync_queue. Tempo que msg fica "in-flight" antes de re-aparecer. |

<!-- END-GENERATED:config -->
