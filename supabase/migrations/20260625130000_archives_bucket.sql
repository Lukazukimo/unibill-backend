-- ============================================================================
-- Migration: 20260625130000_archives_bucket.sql
-- Date:      2026-06-25
-- Task:      T-605 (#115)
-- Purpose:   Cria o bucket de Storage privado 'archives' (§5.13) onde o
--            archive-domain-events grava os domain_events frios como jsonl.gz.
--            Privado (public=false) + sem policies para anon/authenticated →
--            apenas service_role (que bypassa RLS) acessa.
-- Spec refs: §5.13 (Storage layout), §10.5.
--
-- Rollback: DELETE FROM storage.buckets WHERE id = 'archives';
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('archives', 'archives', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260625130000_archives_bucket',
  'Cria o bucket Storage privado archives (domain_events frios → jsonl.gz, T-605).'
)
ON CONFLICT (migration_name) DO NOTHING;
