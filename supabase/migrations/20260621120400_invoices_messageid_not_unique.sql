-- ============================================================================
-- Migration: 20260621120400_invoices_messageid_not_unique.sql
-- Date:      2026-06-21
-- Task:      T-326 fix (multi-PDF email correctness)
-- Purpose:   Demote the (connected_email_id, source_message_id) UNIQUE index to
--            a plain lookup index. A single email can legitimately carry MORE
--            THAN ONE distinct invoice PDF (a provider bundling bills) — same
--            Message-ID, different file_hash. With the UNIQUE index, the second
--            PDF's INSERT in app.ingest_invoice (ON CONFLICT DO NOTHING) hit the
--            message-id constraint and was SILENTLY DROPPED → data loss.
--
--            Dedupe is now content-based ONLY: uq_invoices_household_filehash_active
--            (household_id, file_hash) WHERE deleted_at IS NULL — the right
--            granularity (one row per distinct PDF per household, regardless of
--            how many PDFs share an email). source_message_id stays on the row
--            (observability: "which email did this come from") + a NON-unique
--            index supports that lookup.
-- Spec refs: §5.3 (invoices), §6.4 (capture/dedupe) — supersedes the T-301
--            message-id uniqueness which assumed one invoice per email.
--
-- Rollback:  swap the two statements (recreate the partial UNIQUE; drop the
--            plain index). NOTE: recreating UNIQUE will fail if multi-PDF rows
--            already exist.
-- ============================================================================

DROP INDEX IF EXISTS public.uq_invoices_email_messageid_active;

CREATE INDEX IF NOT EXISTS idx_invoices_email_messageid
  ON public.invoices (connected_email_id, source_message_id)
  WHERE deleted_at IS NULL AND source_message_id IS NOT NULL;

COMMENT ON INDEX public.idx_invoices_email_messageid IS
  'Lookup (não-unique) por (connected_email_id, source_message_id) — "quais '
  'faturas vieram deste email". NÃO é dedupe: um email pode trazer vários PDFs '
  'distintos. Dedupe real = uq_invoices_household_filehash_active. Spec §6.4.';

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260621120400_invoices_messageid_not_unique',
  'Demove o UNIQUE (connected_email_id, source_message_id) p/ índice de lookup '
  'não-unique: um email pode ter múltiplos PDFs distintos (dedupe é só por '
  'household+file_hash). Corrige perda de dados no app.ingest_invoice (T-326).'
)
ON CONFLICT (migration_name) DO NOTHING;
