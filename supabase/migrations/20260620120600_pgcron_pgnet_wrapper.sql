-- ============================================================================
-- Migration: 20260620120600_pgcron_pgnet_wrapper.sql
-- Date:      2026-06-20
-- Task:      T-310
-- Purpose:   Prepara o agendamento server-side: garante pg_cron + pg_net,
--            cria o schema private e o wrapper private.invoke_edge_function
--            que dispara Edge Functions (sync-dispatcher/worker) via pg_net,
--            autenticando com a service_role key guardada em GUC do banco
--            (não numa tabela visível por RLS).
-- Spec refs: §6.6 (pg_cron/pg_net + wrapper + GUCs + rotação)
--
-- Design notes:
--   * pg_cron/pg_net já habilitados no bootstrap; IF NOT EXISTS aqui é defensivo.
--   * GUCs app.service_role_key e app.edge_function_base ficam com PLACEHOLDER —
--     os valores reais são populados OUT-OF-BAND por ambiente (ops), pois a
--     migration roda em todos os ambientes. Rotação: re-ALTER DATABASE + reiniciar
--     conexões.
--   * Wrapper é SECURITY DEFINER SET search_path='' (não expõe a key a outras
--     schemas); retorna o request_id (bigint) do pg_net (assíncrono — resposta
--     cai em net._http_response, limpa por cron). REVOKE de PUBLIC, GRANT só a
--     postgres (o cron roda como owner).
--
-- Rollback:  DROP FUNCTION IF EXISTS private.invoke_edge_function(text, jsonb);
-- ============================================================================

-- ============================================================================
-- 1. Extensões (idempotente — já habilitadas no bootstrap)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================================
-- 2. Schema private (não exposto via PostgREST)
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

-- ============================================================================
-- 3. GUCs com a service_role key + base das Edge Functions — OUT-OF-BAND
-- ============================================================================
-- ⚠️ NÃO setamos os GUCs nesta migration: `ALTER DATABASE ... SET` exige
--    superuser e a migration roda como um role sem essa permissão (42501).
--    Além disso a service_role key é segredo e NÃO entra no git. Cada ambiente
--    (ops) popula UMA VEZ, fora do git, antes de habilitar o cron:
--
--      ALTER DATABASE postgres SET app.service_role_key  = '<jwt-service-role>';
--      ALTER DATABASE postgres SET app.edge_function_base =
--        'https://<project>.supabase.co/functions/v1';
--      -- depois: reiniciar conexões (rotação = re-ALTER + restart).
--
--    O wrapper abaixo lê esses GUCs em tempo de chamada (cron); se não
--    estiverem setados, a chamada falha — esperado até o ops popular.

-- ============================================================================
-- 4. Wrapper private.invoke_edge_function
-- ============================================================================
CREATE OR REPLACE FUNCTION private.invoke_edge_function(
  fn_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint   -- pg_net request_id (assíncrono)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_id bigint;
BEGIN
  SELECT net.http_post(
    url := current_setting('app.edge_function_base') || '/' || fn_name,
    body := body,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json',
      'x-correlation-id', extensions.gen_random_uuid()::text
    ),
    timeout_milliseconds := 5000
  ) INTO request_id;
  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION private.invoke_edge_function(text, jsonb) IS
  'Dispara uma Edge Function via pg_net autenticando com a service_role key '
  '(GUC app.service_role_key). SECURITY DEFINER search_path='''' p/ não expor a '
  'key. Assíncrono: retorna request_id; resposta em net._http_response. '
  'Spec §6.6.';

REVOKE EXECUTE ON FUNCTION private.invoke_edge_function(text, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION private.invoke_edge_function(text, jsonb) TO postgres;

-- ============================================================================
-- 5. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260620120600_pgcron_pgnet_wrapper',
  'Cria schema private + private.invoke_edge_function (SECURITY DEFINER, via '
  'pg_net) e os GUCs placeholder app.service_role_key/app.edge_function_base '
  '(populados out-of-band).'
)
ON CONFLICT (migration_name) DO NOTHING;
