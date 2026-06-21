-- ============================================================================
-- Migration: 20260621120300_app_record_mailbox_error.sql
-- Date:      2026-06-21
-- Task:      T-327 (auto-pause on consecutive IMAP errors)
-- Purpose:   app.record_mailbox_error — incrementa consecutive_errors de um
--            connected_email de forma ATÔMICA, grava last_error/last_error_at e,
--            ao atingir o threshold, faz auto-pause (status='active'→'error').
--            Retorna TRUE só na transição (caller emite email.sync.auto_paused
--            uma única vez). O supabase-js não faz `col = col + 1`, daí a fn SQL.
-- Spec refs: §5.8 (auto-pause / consecutive_error_threshold), §6.4 (worker)
--
-- Design notes:
--   * last_error truncado a 500 chars (o caller JÁ redige secrets antes).
--   * Auto-pause só dispara quando status='active' AND consecutive_errors >=
--     threshold; retorna FOUND da transição → emit-once (próxima chamada já
--     está 'error', não re-flipa, retorna false).
--   * Idempotente (CREATE OR REPLACE); EXECUTE só service_role.
--
-- Rollback:  DROP FUNCTION IF EXISTS app.record_mailbox_error(uuid, int, text);
-- ============================================================================

CREATE OR REPLACE FUNCTION app.record_mailbox_error(
  p_connected_email_id uuid,
  p_threshold          int,
  p_error              text
)
RETURNS boolean   -- true SÓ na transição active→error (emit auto_paused 1x)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count   int;
  v_active  boolean;
  v_paused  boolean := false;
BEGIN
  UPDATE public.connected_emails
     SET consecutive_errors = consecutive_errors + 1,
         last_error         = left(p_error, 500),
         last_error_at      = now()
   WHERE id = p_connected_email_id
   RETURNING consecutive_errors, (status = 'active') INTO v_count, v_active;
  IF NOT FOUND THEN
    RETURN false;  -- mailbox sumiu; nada a registrar
  END IF;

  IF v_active AND v_count >= GREATEST(p_threshold, 1) THEN
    UPDATE public.connected_emails
       SET status = 'error'
     WHERE id = p_connected_email_id AND status = 'active';
    v_paused := FOUND;  -- true se flipou agora (transição)
  END IF;

  RETURN v_paused;
END;
$$;

COMMENT ON FUNCTION app.record_mailbox_error(uuid, int, text) IS
  'Incremento atômico de consecutive_errors + last_error; auto-pause '
  '(status active→error) ao atingir threshold. Retorna true só na transição '
  '(emit email.sync.auto_paused 1x). service_role only. Spec §5.8 (T-327).';

REVOKE EXECUTE ON FUNCTION app.record_mailbox_error(uuid, int, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.record_mailbox_error(uuid, int, text) TO service_role;

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260621120300_app_record_mailbox_error',
  'app.record_mailbox_error: incremento atômico de consecutive_errors + '
  'auto-pause (active→error) ao atingir threshold; retorna true só na transição. '
  'service_role only.'
)
ON CONFLICT (migration_name) DO NOTHING;
