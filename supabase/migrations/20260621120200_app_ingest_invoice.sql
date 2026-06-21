-- ============================================================================
-- Migration: 20260621120200_app_ingest_invoice.sql
-- Date:      2026-06-21
-- Task:      T-326 (transactional outbox for invoice capture)
-- Purpose:   app.ingest_invoice — captura de uma fatura (PDF) pelo sync-worker
--            de forma ATÔMICA (transactional outbox, spec §6.4): numa única
--            transação faz (1) INSERT na invoices, (2) pgmq.send no invoice_queue
--            p/ a extração e (3) INSERT do domain_event invoice.created. O
--            supabase-js NÃO faz transação multi-statement, então isso TEM que
--            ser uma função SQL.
-- Spec refs: §5.3 (invoices), §6.4 (captura + dedupe + outbox), §5.6 (eventos)
--
-- Design notes:
--   * Dedupe via ON CONFLICT DO NOTHING (sem target → pega QUALQUER violação
--     dos 2 índices únicos parciais: household+file_hash e email+message_id,
--     ambos WHERE deleted_at IS NULL). Se conflitou (duplicata) → retorna NULL
--     e NÃO enfileira nem emite evento (o invoice já existe).
--   * created_by/updated_by = sentinel system_worker (00..0002) — fatura criada
--     pelo worker, sem autor humano (§5.10 Approach A, sem FK).
--   * status inicial 'queued' (aguardando extração). storage_bucket default.
--   * O payload do evento carrega só metadados de email (sender/subject) — não
--     são credenciais; o caller (worker) já redige error strings antes de
--     qualquer persistência.
--
-- Rollback:  DROP FUNCTION IF EXISTS app.ingest_invoice(...);  (assinatura completa abaixo)
-- ============================================================================

CREATE OR REPLACE FUNCTION app.ingest_invoice(
  p_household_id       uuid,
  p_connected_email_id uuid,
  p_correlation_id     uuid,
  p_idempotency_key    text,
  p_source_message_id  text,
  p_source_uid         bigint,
  p_source_received_at timestamptz,
  p_source_sender      text,
  p_source_subject     text,
  p_storage_path       text,
  p_file_hash          text,
  p_file_size_bytes    bigint,
  p_mime_type          text
)
RETURNS uuid   -- invoice_id, ou NULL se duplicata (já existia)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.invoices (
    household_id, connected_email_id, correlation_id, idempotency_key,
    source_message_id, source_uid, source_received_at, source_sender, source_subject,
    storage_path, storage_bucket, file_hash, file_size_bytes, mime_type,
    status, created_by, updated_by
  )
  VALUES (
    p_household_id, p_connected_email_id, p_correlation_id, p_idempotency_key,
    p_source_message_id, p_source_uid, p_source_received_at, p_source_sender, p_source_subject,
    p_storage_path, 'invoices', p_file_hash, p_file_size_bytes, p_mime_type,
    'queued',
    '00000000-0000-0000-0000-000000000002',  -- system_worker sentinel
    '00000000-0000-0000-0000-000000000002'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN NULL;  -- duplicata (file_hash ou message_id já capturado) → no-op
  END IF;

  -- Transactional outbox: enfileira p/ extração + emite evento na MESMA tx.
  PERFORM pgmq.send('invoice_queue', jsonb_build_object(
    'invoice_id', v_id,
    'household_id', p_household_id,
    'correlation_id', p_correlation_id,
    'idempotency_key', p_idempotency_key
  ));

  INSERT INTO public.domain_events (
    event_type, event_version, aggregate_type, aggregate_id,
    household_id, correlation_id, payload, actor_type, actor_user_id
  )
  VALUES (
    'invoice.created', 1, 'invoice', v_id,
    p_household_id, p_correlation_id,
    jsonb_build_object('version', 1, 'data', jsonb_build_object(
      'sender', p_source_sender,
      'subject', p_source_subject,
      'file_size_bytes', p_file_size_bytes
    )),
    'worker', NULL
  );

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION app.ingest_invoice(
  uuid, uuid, uuid, text, text, bigint, timestamptz, text, text, text, text, bigint, text
) IS
  'Captura atômica de fatura (sync-worker, T-326): INSERT invoices (ON CONFLICT '
  'DO NOTHING = dedupe por file_hash/message_id) + pgmq.send(invoice_queue) + '
  'domain_event invoice.created, tudo numa tx. Retorna invoice_id, ou NULL se '
  'duplicata. SECURITY DEFINER, service_role only. Spec §6.4.';

REVOKE EXECUTE ON FUNCTION app.ingest_invoice(
  uuid, uuid, uuid, text, text, bigint, timestamptz, text, text, text, text, bigint, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.ingest_invoice(
  uuid, uuid, uuid, text, text, bigint, timestamptz, text, text, text, text, bigint, text
) TO service_role;

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260621120200_app_ingest_invoice',
  'app.ingest_invoice: outbox transacional da captura de fatura (INSERT invoices '
  'ON CONFLICT DO NOTHING + pgmq.send invoice_queue + domain_event invoice.created '
  'numa tx). Retorna invoice_id ou NULL (duplicata). service_role only.'
)
ON CONFLICT (migration_name) DO NOTHING;
