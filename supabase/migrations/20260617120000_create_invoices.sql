-- ============================================================================
-- Migration: 20260617120000_create_invoices.sql
-- Date:      2026-06-14
-- Task:      T-301
-- Purpose:   Implementa a tabela canônica public.invoices descrita em §5.3 do
--            spec — o registro central de uma fatura no Unibill, desde a
--            ingestão (status=queued) até a extração (extracted / needs_review /
--            failed) e o pagamento manual (paid_at). Cria também os três enums
--            de domínio usados pela tabela:
--
--              public.invoice_status              — ciclo de vida da extração.
--              public.extraction_method           — qual camada extraiu os dados.
--              public.payment_confirmation_source — origem da confirmação de
--                                                    pagamento (manual ou
--                                                    inferência).
--
--            Inclui o CHECK de formato do file_hash (sha256 hex lowercase), os
--            dois índices únicos PARCIAIS soft-delete-aware (dedupe por PDF e por
--            Message-ID) e os índices auxiliares de listagem/observabilidade.
--
--            ⚠️ Esta migration NÃO cria o FK invoices.category_id ->
--            invoice_categories(id): invoice_categories é criada depois
--            (20260617120100) e o FK é adicionado por
--            20260617120200_link_invoices_category.sql. Aqui category_id fica
--            como uuid puro (ver nota §5.3).
--
-- Spec refs: §5.3  (invoices DDL completo: enums, todas as colunas, CHECK
--                   chk_file_hash_format, partial unique indexes e índices de
--                   suporte; nota sobre a ordem de migrations do FK de
--                   category_id).
--            §5.10 (Approach A — colunas de AUDIT created_by/updated_by/paid_by
--                   NÃO têm FK para auth.users: o valor pode ser um id de
--                   system_actors (sentinel) após anonimização do usuário
--                   (anonymize_user_references). Por isso são uuid puro, sem
--                   REFERENCES. Integridade fica no app + helper
--                   user_display_name()).
--            §5.11 (RLS — habilitado em migration separada
--                   20260617120300_rls_invoices_categories.sql; invoices write =
--                   member-of household).
--
-- Design notes:
--   * PKs/uuid via extensions.gen_random_uuid() (convenção do repo — pgcrypto
--     vive em `extensions`).
--   * household_id e connected_email_id MANTÊM FK (ownership/origem real, não
--     audit). connected_email_id é nullable: faturas inseridas manualmente pelo
--     usuário não vêm de um email conectado.
--   * Audit (created_by/updated_by/paid_by): uuid SEM FK — ver §5.10 Approach A
--     acima. Sentinel '00000000-0000-0000-0000-000000000001' (deleted_user) é
--     gravado por anonymize_user_references no fluxo LGPD.
--   * Partial unique indexes (em vez de UNIQUE table constraints) porque a
--     constraint inline incluiria rows soft-deletadas, causando duplicate-key ao
--     re-receber a mesma fatura após delete. WHERE deleted_at IS NULL exclui
--     tombstones; o índice de Message-ID também exige source_message_id NOT NULL
--     (uploads manuais / mensagens sem Message-ID estável nunca colidem).
--   * Trigger app.set_updated_at() (T-107) anexado para bump de updated_at.
--   * Idempotente: CREATE TABLE/INDEX usam IF NOT EXISTS; enums envelopados em
--     DO blocks com EXISTS check (CREATE TYPE não tem IF NOT EXISTS); CHECK
--     adicionado via DO block guard (ADD CONSTRAINT não tem IF NOT EXISTS).
--
-- Rollback:
--   * DROP TABLE IF EXISTS public.invoices CASCADE;
--   * DROP TYPE IF EXISTS public.payment_confirmation_source;
--   * DROP TYPE IF EXISTS public.extraction_method;
--   * DROP TYPE IF EXISTS public.invoice_status;
--   (nessa ordem — tabela primeiro, depois enums)
-- ============================================================================


-- ============================================================================
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ============================================================================
--   * DO NOT add FK from created_by/updated_by/paid_by to auth.users — §5.10
--     Approach A: esses valores podem ser sentinels de system_actors.
--   * DO NOT use a UNIQUE table constraint for (household_id, file_hash) ou
--     (connected_email_id, source_message_id) — use os partial indexes abaixo
--     (soft-delete-aware), senão re-ingestão pós-delete quebra com 23505.
--   * DO NOT add the category_id FK here — ele depende de invoice_categories
--     (criada depois). Ver 20260617120200_link_invoices_category.sql.
-- ============================================================================


-- ============================================================================
-- 1. Enum: public.invoice_status — ciclo de vida da extração
-- ============================================================================
--   queued       — ingerida, aguardando o extraction-worker.
--   extracting   — worker em processamento.
--   extracted    — dados extraídos com confiança suficiente.
--   needs_review — extração ambígua/baixa confiança; requer revisão do usuário.
--   failed       — extração falhou após retries (vai para DLQ / re-extract).
--   duplicate    — detectada como duplicata de outra fatura (dedupe semântico).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'invoice_status' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.invoice_status AS ENUM (
      'queued', 'extracting', 'extracted', 'needs_review', 'failed', 'duplicate'
    );
  END IF;
END
$$;

COMMENT ON TYPE public.invoice_status IS
  'Ciclo de vida da extração de uma fatura: queued (aguardando worker) -> '
  'extracting -> extracted | needs_review (baixa confiança) | failed (após '
  'retries) | duplicate (dedupe semântico). Spec §5.3.';


-- ============================================================================
-- 2. Enum: public.extraction_method — qual camada extraiu os dados
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'extraction_method' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.extraction_method AS ENUM (
      'pdfjs',       -- texto nativo via pdfjs-dist (Layer 1)
      'ocr_api',     -- OCR.space / Google Vision / outro provider da chain (Layer 2)
      'regex',       -- regex per-utility (utility_parsers, Layer 3)
      'ai_fallback', -- AI provider chain (Gemini/Groq/OpenRouter, Layer 4)
      'manual',      -- editado/extraído manualmente pelo usuário
      'on_device'    -- futuro: extração on-device no Flutter (roadmap)
    );
  END IF;
END
$$;

COMMENT ON TYPE public.extraction_method IS
  'Camada que produziu os dados extraídos: pdfjs (texto nativo) | ocr_api | '
  'regex (utility_parsers) | ai_fallback (AI chain) | manual (usuário) | '
  'on_device (roadmap). Spec §5.3.';


-- ============================================================================
-- 3. Enum: public.payment_confirmation_source — origem da confirmação de pgto
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'payment_confirmation_source'
      AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.payment_confirmation_source AS ENUM (
      'manual', 'email_inference', 'invoice_inference'
    );
  END IF;
END
$$;

COMMENT ON TYPE public.payment_confirmation_source IS
  'Como o pagamento foi confirmado: manual (usuário marcou) | email_inference '
  '(inferido de email de confirmação) | invoice_inference (inferido da própria '
  'fatura seguinte). Spec §5.3.';


-- ============================================================================
-- 4. public.invoices — registro central da fatura
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.invoices (
  id                   uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  household_id         uuid NOT NULL REFERENCES public.households(id),
  connected_email_id   uuid REFERENCES public.connected_emails(id),
  correlation_id       uuid,
  idempotency_key      text,

  -- origem (email)
  source_message_id    text,
  source_uid           bigint,
  source_received_at   timestamptz,
  source_sender        text,   -- "From" do email (Layer 3 sender_patterns)
  source_subject       text,   -- "Subject" do email (Layer 3 subject_patterns)
  -- corpo do email NÃO é persistido (LGPD: minimização) — só PDFs no Storage +
  -- texto extraído em extracted_payload.

  -- arquivo
  storage_path         text NOT NULL,
  storage_bucket       text NOT NULL DEFAULT 'invoices',
  file_hash            text NOT NULL,  -- sha256 dos bytes do PDF, hex lowercase (64). CHECK abaixo.
  file_size_bytes      bigint,
  mime_type            text,
  pdf_archived_at      timestamptz,    -- preenchido em capacity eviction

  -- extração
  status                invoice_status NOT NULL DEFAULT 'queued',
  extraction_method     extraction_method,
  extraction_confidence numeric(3,2),
  extraction_error      text,
  extracted_at          timestamptz,
  retries               int NOT NULL DEFAULT 0,
  needs_review_reason   text,

  -- dados extraídos
  utility_key          text,
  category_id          uuid,   -- FK adicionada em 20260617120200 (ver nota §5.3)
  amount_cents         bigint,
  currency             text NOT NULL DEFAULT 'BRL',
  due_date             date,
  reference_period     text,

  -- pagamento (boleto + PIX)
  barcode              text,
  pix_payload          text,
  pix_key              text,
  pix_txid             text,
  payment_methods      text[] NOT NULL DEFAULT '{}',

  -- payee + customer + serviço
  payee_name           text,
  payee_document       text,
  customer_document    text,
  customer_name        text,
  installation_id      text,
  service_address      text,
  consumption_data     jsonb,  -- MVP: sempre NULL (tracking de consumo é roadmap)

  -- payload completo da extração
  extracted_payload    jsonb,  -- {version, data}

  -- pagamento manual
  paid_at              timestamptz,
  paid_by              uuid,   -- AUDIT (§5.10 Approach A): uuid SEM FK (pode ser sentinel)
  payment_note         text,
  payment_confirmation_source     payment_confirmation_source,
  payment_confirmation_confidence numeric(3,2),

  -- audit
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,   -- AUDIT (§5.10 Approach A): uuid SEM FK (pode ser sentinel)
  updated_by           uuid,   -- AUDIT (§5.10 Approach A): uuid SEM FK (pode ser sentinel)
  deleted_at           timestamptz
);

COMMENT ON TABLE public.invoices IS
  'Registro central de uma fatura: origem (email conectado ou upload manual), '
  'arquivo no Storage, dados extraídos (valor, vencimento, PIX/boleto, payee/'
  'customer) e pagamento manual. household_id e connected_email_id mantêm FK '
  '(ownership/origem). Colunas de audit (created_by/updated_by/paid_by) são '
  'uuid SEM FK por §5.10 Approach A (podem apontar para system_actors sentinel). '
  'Soft-delete via deleted_at. Spec §5.3.';


-- ----------------------------------------------------------------------------
-- 4a. COMMENT ON COLUMN (business-meaningful — data dictionary §G)
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN public.invoices.household_id IS
  'FK households(id). Tenant da fatura — base de toda a RLS de invoices '
  '(member-of household). Spec §5.3/§5.11.';
COMMENT ON COLUMN public.invoices.connected_email_id IS
  'FK connected_emails(id), nullable. NULL = fatura inserida manualmente (sem '
  'origem IMAP). Quando preenchido, identifica a credencial que ingeriu o PDF.';
COMMENT ON COLUMN public.invoices.correlation_id IS
  'uuid que correlaciona esta fatura com o sync_run/extraction_run que a '
  'originou (observabilidade end-to-end). Spec §5.6.';
COMMENT ON COLUMN public.invoices.idempotency_key IS
  'Chave de idempotência da ingestão = sha256(connected_email_id + '':'' + '
  'message_id + '':'' + file_hash). Evita inserir a mesma fatura duas vezes '
  'se o worker re-processar a mensagem. Spec §6.4.';
COMMENT ON COLUMN public.invoices.source_message_id IS
  'Message-ID do email de origem. Componente do índice único parcial de dedupe '
  'por mensagem (uq_invoices_email_messageid_active, só quando NOT NULL).';
COMMENT ON COLUMN public.invoices.source_uid IS
  'UID IMAP do email de origem na caixa (cursor incremental do worker).';
COMMENT ON COLUMN public.invoices.source_received_at IS
  'Data de recebimento do email (internalDate IMAP).';
COMMENT ON COLUMN public.invoices.source_sender IS
  'Header "From" do email. Usado pela Layer 3 (sender_patterns) p/ casar parser.';
COMMENT ON COLUMN public.invoices.source_subject IS
  'Header "Subject" do email. Usado pela Layer 3 (subject_patterns). O CORPO do '
  'email NÃO é persistido (LGPD: minimização).';
COMMENT ON COLUMN public.invoices.storage_path IS
  'Caminho do PDF no bucket de Storage: household-{uuid}/{YYYY-MM}/{uuid}.pdf.';
COMMENT ON COLUMN public.invoices.storage_bucket IS
  'Bucket de Storage do PDF. Default ''invoices'' (privado). Spec §5.3/§Storage.';
COMMENT ON COLUMN public.invoices.file_hash IS
  'sha256 dos bytes do PDF, hex LOWERCASE (64 chars). Validado por '
  'chk_file_hash_format (^[a-f0-9]{64}$). Componente do dedupe por PDF '
  '(uq_invoices_household_filehash_active).';
COMMENT ON COLUMN public.invoices.file_size_bytes IS
  'Tamanho do PDF em bytes (capacity accounting / retention).';
COMMENT ON COLUMN public.invoices.mime_type IS
  'MIME type do arquivo (validado por magic bytes na ingestão; esperado application/pdf).';
COMMENT ON COLUMN public.invoices.pdf_archived_at IS
  'Preenchido quando o PDF é evacuado do Storage por capacity eviction '
  '(retenção em duas camadas). NULL = PDF ainda presente. Spec §retention.';
COMMENT ON COLUMN public.invoices.status IS
  'Enum invoice_status. Ver o tipo public.invoice_status.';
COMMENT ON COLUMN public.invoices.extraction_method IS
  'Enum extraction_method — qual camada extraiu os dados.';
COMMENT ON COLUMN public.invoices.extraction_confidence IS
  'Confiança da extração (0.00–1.00). Abaixo do threshold -> status=needs_review.';
COMMENT ON COLUMN public.invoices.extraction_error IS
  'Mensagem de erro da extração (redatada de segredos). NULL quando extracted.';
COMMENT ON COLUMN public.invoices.extracted_at IS
  'Timestamp em que a extração concluiu (sucesso ou needs_review/failed final).';
COMMENT ON COLUMN public.invoices.retries IS
  'Contador de tentativas de extração. Atinge o máximo -> failed (DLQ).';
COMMENT ON COLUMN public.invoices.needs_review_reason IS
  'Motivo legível pelo qual a fatura caiu em needs_review (ex: valor ausente, '
  'vencimento ambíguo). Exibido no banner de revisão do app.';
COMMENT ON COLUMN public.invoices.category_id IS
  'FK invoice_categories(id) — adicionada em 20260617120200 (ON DELETE SET NULL). '
  'Categoria da fatura (Luz, Água, ...). NULL = não categorizada.';
COMMENT ON COLUMN public.invoices.utility_key IS
  'Chave da concessionária/serviço (ex: enel-sp), casada via utility_parsers.';
COMMENT ON COLUMN public.invoices.amount_cents IS
  'Valor da fatura em CENTAVOS (inteiro) na moeda `currency`. Evita float.';
COMMENT ON COLUMN public.invoices.currency IS
  'Moeda ISO-4217. Default ''BRL''.';
COMMENT ON COLUMN public.invoices.due_date IS
  'Data de vencimento. Base do índice idx_invoices_household_due (não pagas).';
COMMENT ON COLUMN public.invoices.reference_period IS
  'Período de referência/competência da fatura como TEXTO livre extraído (ex: '
  '"06/2026", "JUN/2026", "05/2026 a 06/2026") — preserva o formato original da '
  'concessionária sem normalização forçada.';
COMMENT ON COLUMN public.invoices.barcode IS
  'Linha digitável / código de barras do boleto (quando houver).';
COMMENT ON COLUMN public.invoices.pix_payload IS
  'Payload PIX copia-e-cola (BR Code EMV) completo — usado p/ gerar o QR no app.';
COMMENT ON COLUMN public.invoices.pix_key IS
  'Chave PIX do recebedor, quando extraída separadamente do payload.';
COMMENT ON COLUMN public.invoices.pix_txid IS
  'TXID do PIX (identificador da transação no BR Code), quando presente.';
COMMENT ON COLUMN public.invoices.payment_methods IS
  'Métodos de pagamento disponíveis nesta fatura (ex: {boleto,pix}). text[], '
  'default {}.';
COMMENT ON COLUMN public.invoices.payee_name IS
  'Nome do recebedor/cedente (concessionária).';
COMMENT ON COLUMN public.invoices.payee_document IS
  'CNPJ/CPF do recebedor (quando extraído).';
COMMENT ON COLUMN public.invoices.customer_document IS
  'CPF/CNPJ do cliente (titular da fatura).';
COMMENT ON COLUMN public.invoices.customer_name IS
  'Nome do cliente/titular na fatura.';
COMMENT ON COLUMN public.invoices.installation_id IS
  'Identificador da instalação/unidade consumidora (ex: nº da instalação Enel).';
COMMENT ON COLUMN public.invoices.service_address IS
  'Endereço de prestação do serviço (texto livre).';
COMMENT ON COLUMN public.invoices.consumption_data IS
  'jsonb de dados de consumo. MVP: sempre NULL (tracking de consumo é roadmap; '
  'o worker ignora). Spec §5.4 nota.';
COMMENT ON COLUMN public.invoices.extracted_payload IS
  'jsonb {version, data} com o payload completo/estruturado da extração — '
  'fonte de verdade versionada dos campos derivados.';
COMMENT ON COLUMN public.invoices.paid_at IS
  'Timestamp em que a fatura foi marcada como paga. NULL = não paga.';
COMMENT ON COLUMN public.invoices.paid_by IS
  'uuid de auth.users(id) OU sentinel system_actors de quem marcou como paga. '
  'SEM FK (§5.10 Approach A): após anonimização vira o sentinel deleted_user.';
COMMENT ON COLUMN public.invoices.payment_note IS
  'Nota livre do usuário sobre o pagamento.';
COMMENT ON COLUMN public.invoices.payment_confirmation_source IS
  'Enum payment_confirmation_source — como o pagamento foi confirmado.';
COMMENT ON COLUMN public.invoices.payment_confirmation_confidence IS
  'Confiança (0.00–1.00) quando o pagamento foi inferido (não-manual).';
COMMENT ON COLUMN public.invoices.created_by IS
  'uuid de auth.users(id) OU sentinel system_actors de quem criou a fatura. '
  'SEM FK (§5.10 Approach A).';
COMMENT ON COLUMN public.invoices.updated_by IS
  'uuid de auth.users(id) OU sentinel system_actors da última atualização. '
  'SEM FK (§5.10 Approach A).';
COMMENT ON COLUMN public.invoices.deleted_at IS
  'Soft-delete marker. NULL = ativa. NOT NULL = removida (tombstone): excluída '
  'dos índices únicos parciais (permite re-ingestão) e das queries de listagem '
  'do app (WHERE deleted_at IS NULL). RLS NÃO filtra deleted_at (workers/audit '
  'enxergam tombstones).';


-- ============================================================================
-- 5. CHECK: file_hash é sha256 hex lowercase (64 chars)
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_file_hash_format'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT chk_file_hash_format
      CHECK (file_hash ~ '^[a-f0-9]{64}$');
  END IF;
END
$$;


-- ============================================================================
-- 6. Trigger: bump updated_at em UPDATE
-- ============================================================================
DROP TRIGGER IF EXISTS trg_invoices_set_updated_at ON public.invoices;
CREATE TRIGGER trg_invoices_set_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 7. Índices únicos PARCIAIS (dedupe soft-delete-aware)
-- ============================================================================
-- Dedupe por PDF: NO MÁXIMO uma fatura ATIVA por (household, file_hash).
-- Soft-deletes não contam -> re-ingestão da mesma fatura após delete é possível.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_household_filehash_active
  ON public.invoices (household_id, file_hash)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.uq_invoices_household_filehash_active IS
  'Partial unique: 1 fatura ATIVA por (household_id, file_hash). Exclui '
  'tombstones (deleted_at NOT NULL) -> re-ingestão pós-delete não quebra. Spec §5.3.';

-- Dedupe por Message-ID: NO MÁXIMO uma fatura ATIVA por (credencial, message_id),
-- apenas quando source_message_id NOT NULL (uploads manuais / mail sem
-- Message-ID nunca colidem).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_email_messageid_active
  ON public.invoices (connected_email_id, source_message_id)
  WHERE deleted_at IS NULL AND source_message_id IS NOT NULL;

COMMENT ON INDEX public.uq_invoices_email_messageid_active IS
  'Partial unique: 1 fatura ATIVA por (connected_email_id, source_message_id), '
  'só quando source_message_id NOT NULL. NULLs (uploads manuais) nunca colidem. '
  'Spec §5.3.';


-- ============================================================================
-- 8. Índices auxiliares (perf — não-únicos)
-- ============================================================================
-- Listagem por status (ex: needs_review banner, filas) dentro do household.
CREATE INDEX IF NOT EXISTS idx_invoices_household_status
  ON public.invoices (household_id, status)
  WHERE deleted_at IS NULL;

-- Próximos vencimentos não pagos (dashboard/notificações).
CREATE INDEX IF NOT EXISTS idx_invoices_household_due
  ON public.invoices (household_id, due_date)
  WHERE deleted_at IS NULL AND paid_at IS NULL;

-- Agrupamento por concessionária/serviço.
CREATE INDEX IF NOT EXISTS idx_invoices_household_utility
  ON public.invoices (household_id, utility_key)
  WHERE deleted_at IS NULL;

-- Fast-path do banner "precisa revisão".
CREATE INDEX IF NOT EXISTS idx_invoices_needs_review
  ON public.invoices (household_id)
  WHERE status = 'needs_review' AND deleted_at IS NULL;


-- ============================================================================
-- 9. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260617120000_create_invoices',
  'Enums invoice_status + extraction_method + payment_confirmation_source; '
  'tabela public.invoices (§5.3) com household_id/connected_email_id FK, audit '
  'sem FK (§5.10 Approach A), CHECK chk_file_hash_format, dois partial unique '
  'indexes soft-delete-aware (dedupe por PDF e por Message-ID) e índices de '
  'listagem; trigger set_updated_at. category_id sem FK (link em 20260617120200).'
)
ON CONFLICT (migration_name) DO NOTHING;
