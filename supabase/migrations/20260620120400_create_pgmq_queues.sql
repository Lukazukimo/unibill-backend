-- ============================================================================
-- Migration: 20260620120400_create_pgmq_queues.sql
-- Date:      2026-06-20
-- Task:      T-308
-- Purpose:   Cria as 4 filas pgmq do P4: email_sync_queue + email_sync_dlq
--            (sync-dispatcher → sync-worker) e invoice_queue + invoice_dlq
--            (sync-worker → extraction-worker). Restringe o acesso às filas a
--            service_role (workers); authenticated/anon não enfileiram nem leem.
-- Spec refs: §4.3 (tabela de filas + VT/retries), §13 (DLQ semantics), §5.11
--
-- Design notes:
--   * Extensão pgmq já habilitada no bootstrap (00000000000001). Criação das
--     filas é idempotente (guard via pgmq.list_queues()).
--   * pgmq não tem ACK: VT expira → re-entrega; read_ct conta tentativas;
--     ao atingir max_retries o worker move pro *_dlq. VT/retries são aplicados
--     pelo worker (pgmq.read(vt,...)), não são config da fila — documentados
--     aqui pra referência:
--       email_sync_queue  VT 120s  retries 3
--       invoice_queue     VT  90s  retries 3
--       *_dlq             manual / admin
--   * Acesso: GRANT a service_role; REVOKE de authenticated/anon/public.
--
-- Rollback:  SELECT pgmq.drop_queue('invoice_dlq');  (idem demais)
-- ============================================================================

-- ============================================================================
-- 1. Criar as 4 filas (idempotente)
-- ============================================================================
DO $$
DECLARE
  q text;
BEGIN
  FOREACH q IN ARRAY ARRAY[
    'email_sync_queue', 'email_sync_dlq', 'invoice_queue', 'invoice_dlq'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = q) THEN
      PERFORM pgmq.create(q);
    END IF;
  END LOOP;
END
$$;

-- ============================================================================
-- 2. Acesso: apenas service_role (workers)
-- ============================================================================
-- Tira o default público e concede explicitamente só a service_role. As
-- per-queue tables (pgmq.q_*/pgmq.a_*) são acessadas via as funções pgmq.
REVOKE ALL ON SCHEMA pgmq FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq FROM PUBLIC, authenticated, anon;

GRANT USAGE ON SCHEMA pgmq TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO service_role;

-- ============================================================================
-- 3. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120400_create_pgmq_queues',
  'Cria as 4 filas pgmq do P4 (email_sync_queue/dlq, invoice_queue/dlq) '
  'idempotentemente e restringe acesso a service_role.'
)
ON CONFLICT (migration_name) DO NOTHING;
