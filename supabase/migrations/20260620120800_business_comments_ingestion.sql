-- ============================================================================
-- Migration: 20260620120800_business_comments_ingestion.sql
-- Date:      2026-06-20
-- Task:      T-312
-- Purpose:   COMMENT ON COLUMN de negócio (documentação viva) para colunas de
--            invoices, connected_emails e utility_parsers que precisam de
--            contexto de domínio (formatos, semântica, regras MVP).
-- Spec refs: Appendix G (business comments), §5.4 (utility_parsers)
--
-- Design notes:
--   * Idempotente por natureza: COMMENT ON COLUMN substitui o comentário.
--   * Aspas simples literais dobradas dentro das strings.
--
-- Rollback:  (re-aplicar versão anterior dos comentários, ou COMMENT ... IS NULL)
-- ============================================================================

-- ============================================================================
-- 1. invoices
-- ============================================================================
COMMENT ON COLUMN public.invoices.reference_period IS
  'Período de referência da fatura como aparece na nota — texto livre (ex: "05/2026", "Maio/2026", "04/2026 a 05/2026"). Não normalizar; UI exibe como veio.';
COMMENT ON COLUMN public.invoices.amount_cents IS
  'Valor a pagar em centavos. SEMPRE inteiro positivo. R$ 234,56 → 23456.';
COMMENT ON COLUMN public.invoices.barcode IS
  'Linha digitável do boleto (47 dígitos, sem espaços/pontos). NULL se fatura só PIX.';
COMMENT ON COLUMN public.invoices.pix_payload IS
  'BR code EMV string completa (começa com "00020126"). Mesmo conteúdo do QR Code; UI renderiza QR a partir disso.';
COMMENT ON COLUMN public.invoices.pix_key IS
  'Chave PIX explícita se vier separada do BR code (raro). Tipos: CPF/CNPJ/email/celular/aleatória.';
COMMENT ON COLUMN public.invoices.pix_txid IS
  'TX ID dentro do BR code, útil pra reconciliação se sistema futuro de pagamento usar.';
COMMENT ON COLUMN public.invoices.installation_id IS
  'Identificador único da unidade consumidora (UC Enel, hidrômetro Sabesp, etc.). Usado para agrupar invoices da mesma instalação.';
COMMENT ON COLUMN public.invoices.source_message_id IS
  'Header Message-ID do email original (RFC822). Chave de dedupe primária.';
COMMENT ON COLUMN public.invoices.idempotency_key IS
  'Chave determinística sha256(connected_email_id + message_id + file_hash) — dedupe na pgmq.';
COMMENT ON COLUMN public.invoices.extracted_payload IS
  'Payload completo da pipeline de extração (versionado {version, data}). Contém raw text excerpt, per-layer metadata, AI tokens, etc. Útil pra re-extração e debug.';
COMMENT ON COLUMN public.invoices.payment_confirmation_source IS
  'manual = user marcou; email_inference/invoice_inference = roadmap, futura detecção automática.';
COMMENT ON COLUMN public.invoices.pdf_archived_at IS
  'Quando NÃO NULL, PDF foi removido do Storage por capacity eviction. Dados extraídos ainda disponíveis; arquivo original perdido.';

-- ============================================================================
-- 2. connected_emails
-- ============================================================================
COMMENT ON COLUMN public.connected_emails.last_processed_uid IS
  'Cursor IMAP — maior UID já processado nesta caixa. Incrementado dentro do loop por mensagem (não após batch completo) pra resiliência a crashes.';
COMMENT ON COLUMN public.connected_emails.consecutive_errors IS
  'Erros consecutivos no sync. Atinge sync.consecutive_error_threshold (default 5) → auto-pause (status=error).';

-- ============================================================================
-- 3. utility_parsers
-- ============================================================================
COMMENT ON COLUMN public.utility_parsers.version IS
  'Versionamento; o parser vigente por utility_key é a row active=true (lookup via idx_parsers_active).';
COMMENT ON COLUMN public.utility_parsers.body_must_contain IS
  'Substrings que DEVEM aparecer no texto pra parser fazer match. ALL devem bater (não any).';
COMMENT ON COLUMN public.utility_parsers.consumption_extractor IS
  'Roadmap (tracking de consumo). SEMPRE NULL no MVP; o worker IGNORA esta coluna e invoices.consumption_data também fica NULL. Schema definido quando a feature de consumo entrar.';

-- ============================================================================
-- 4. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120800_business_comments_ingestion',
  'COMMENT ON COLUMN de negócio para invoices (12), connected_emails (2) e '
  'utility_parsers (3). Documentação viva (Appendix G).'
)
ON CONFLICT (migration_name) DO NOTHING;
