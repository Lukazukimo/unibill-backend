-- ============================================================================
-- Migration: 20260625160000_private_exports_bucket.sql
-- Date:      2026-06-25
-- Task:      T-608 (#118)
-- Purpose:   Cria o bucket de Storage privado 'private-exports' (§9.4 / §5.13)
--            onde a Edge Function privacy-export grava o zip de dados pessoais
--            do usuário em exports/{userId}/{timestamp}.zip.
--            Privado (public=false) + sem policies anon/authenticated → só
--            service_role (que bypassa RLS) escreve; o acesso do usuário é via
--            signed URL de 24h emitida pela função (NUNCA acesso direto ao
--            bucket — o zip carrega PII e o signed URL é o único caminho).
-- Spec refs: §9.4 (export-my-data), §5.13 (Storage layout), BR-019.
--
-- NOTA (follow-up): a expiração do OBJETO em 24h ("Storage cleanup automático",
--   spec §9.4) ainda não tem cron — o signed URL expira em 24h, mas o zip
--   persiste. Limpeza de objetos exports/ > 24h fica como task separada (ciclo
--   de vida de objeto de Storage). Rastreado no handoff.
--
-- Rollback: DELETE FROM storage.buckets WHERE id = 'private-exports';
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('private-exports', 'private-exports', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260625160000_private_exports_bucket',
  'Cria o bucket Storage privado private-exports (zip de export LGPD por usuário, T-608).'
)
ON CONFLICT (migration_name) DO NOTHING;
