-- ============================================================================
-- Migration: 20260621120100_app_pgmq_wrappers.sql
-- Date:      2026-06-21
-- Task:      T-324/T-325 support (pgmq access for Edge Functions)
-- Purpose:   Expõe as operações pgmq aos workers (Edge Functions) via rpc.
--            O schema `pgmq` NÃO está nos schemas expostos pelo PostgREST
--            (config.toml: só public/app), então o client supabase-js não
--            consegue chamar pgmq.* diretamente. Estes wrappers em `app`
--            (schema exposto) repassam para pgmq.* e são chamados via
--            client.rpc('queue_*', {...}) pelo service_role.
-- Spec refs: §4.3 (filas), §6.4 (sync-worker), §13 (DLQ)
--
-- Design notes:
--   * SECURITY DEFINER + search_path='' (pgmq.* totalmente qualificado). O
--     service_role já tem EXECUTE em pgmq.* (T-308), mas DEFINER mantém o
--     contrato independente de grants default e consistente com os demais app.*.
--   * queue_read retorna jsonb (array de {msg_id, read_ct, enqueued_at, vt,
--     message}) — formato direto para o client JS.
--   * queue_to_dlq move uma msg para a *_dlq de forma ATÔMICA (send no dlq +
--     delete na main na MESMA transação) — sem isso o move seria 2 chamadas
--     com janela de inconsistência.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS app.queue_to_dlq(text,text,bigint,jsonb);
--   DROP FUNCTION IF EXISTS app.queue_set_vt(text,bigint,int);
--   DROP FUNCTION IF EXISTS app.queue_delete(text,bigint);
--   DROP FUNCTION IF EXISTS app.queue_read(text,int,int);
--   DROP FUNCTION IF EXISTS app.queue_send(text,jsonb,int);
-- ============================================================================

-- ----------------------------------------------------------------------------
-- queue_send → pgmq.send (retorna msg_id)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.queue_send(p_queue text, p_msg jsonb, p_delay int DEFAULT 0)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pgmq.send(p_queue, p_msg, p_delay);
$$;

COMMENT ON FUNCTION app.queue_send(text, jsonb, int) IS
  'Wrapper rpc p/ pgmq.send (enfileira; retorna msg_id). service_role only.';

-- ----------------------------------------------------------------------------
-- queue_read → pgmq.read (retorna jsonb array; vt em segundos)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.queue_read(p_queue text, p_vt int, p_qty int)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  -- Project the stable 5-key contract explicitly (pgmq.message_record also has
  -- last_read_at + headers; pinning the shape insulates the JS QueueMessage type
  -- from pgmq adding/renaming columns).
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'msg_id', r.msg_id,
      'read_ct', r.read_ct,
      'enqueued_at', r.enqueued_at,
      'vt', r.vt,
      'message', r.message
    )),
    '[]'::jsonb
  )
  FROM pgmq.read(p_queue, p_vt, p_qty) AS r;
$$;

COMMENT ON FUNCTION app.queue_read(text, int, int) IS
  'Wrapper rpc p/ pgmq.read (lê até p_qty msgs, torna-as invisíveis por p_vt s). '
  'Retorna jsonb array de {msg_id, read_ct, enqueued_at, vt, message}. service_role only.';

-- ----------------------------------------------------------------------------
-- queue_delete → pgmq.delete (ACK; retorna boolean)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.queue_delete(p_queue text, p_msg_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pgmq.delete(p_queue, p_msg_id);
$$;

COMMENT ON FUNCTION app.queue_delete(text, bigint) IS
  'Wrapper rpc p/ pgmq.delete (ACK de uma msg processada). service_role only.';

-- ----------------------------------------------------------------------------
-- queue_set_vt → pgmq.set_vt (backoff: estende a visibility timeout)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.queue_set_vt(p_queue text, p_msg_id bigint, p_vt_offset int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pgmq.set_vt(p_queue, p_msg_id, p_vt_offset);
END;
$$;

COMMENT ON FUNCTION app.queue_set_vt(text, bigint, int) IS
  'Wrapper rpc p/ pgmq.set_vt (re-arma a visibility timeout em p_vt_offset s — '
  'usado p/ backoff exponencial no retry). Best-effort: no-op silencioso se o '
  'msg_id não existir mais. service_role only.';

-- ----------------------------------------------------------------------------
-- queue_to_dlq → move atômico main→dlq (send no dlq + delete na main)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.queue_to_dlq(
  p_main text, p_dlq text, p_msg_id bigint, p_msg jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dlq_id  bigint;
  v_deleted boolean;
BEGIN
  -- Delete FIRST and require it to have removed a row: pgmq.delete returns
  -- false (does NOT raise) on a missing/wrong msg_id, so without this guard a
  -- retry or bad id would append a DUPLICATE to the DLQ (pgmq.send mints a new
  -- id every call) while reporting success. RAISE rolls back the whole tx
  -- (incl. the send below) → genuine exactly-once move.
  v_deleted := pgmq.delete(p_main, p_msg_id);
  IF NOT v_deleted THEN
    RAISE EXCEPTION 'queue_to_dlq: message % not found in %', p_msg_id, p_main
      USING ERRCODE = 'no_data_found';
  END IF;
  SELECT pgmq.send(p_dlq, p_msg) INTO v_dlq_id;
  RETURN v_dlq_id;
END;
$$;

COMMENT ON FUNCTION app.queue_to_dlq(text, text, bigint, jsonb) IS
  'Move uma msg da fila principal p/ a *_dlq atomicamente (pgmq.send no dlq + '
  'pgmq.delete na main na mesma TX). Retorna o msg_id no dlq. service_role only.';

-- ----------------------------------------------------------------------------
-- Grants: só service_role (workers)
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION app.queue_send(text, jsonb, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.queue_read(text, int, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.queue_delete(text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.queue_set_vt(text, bigint, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.queue_to_dlq(text, text, bigint, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION app.queue_send(text, jsonb, int) TO service_role;
GRANT EXECUTE ON FUNCTION app.queue_read(text, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION app.queue_delete(text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION app.queue_set_vt(text, bigint, int) TO service_role;
GRANT EXECUTE ON FUNCTION app.queue_to_dlq(text, text, bigint, jsonb) TO service_role;

-- ----------------------------------------------------------------------------
-- Registro da migration
-- ----------------------------------------------------------------------------
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260621120100_app_pgmq_wrappers',
  'Wrappers app.queue_send/read/delete/set_vt/to_dlq (SECURITY DEFINER) que '
  'expõem pgmq.* aos workers via rpc (pgmq não é schema exposto pelo PostgREST). '
  'EXECUTE só service_role.'
)
ON CONFLICT (migration_name) DO NOTHING;
