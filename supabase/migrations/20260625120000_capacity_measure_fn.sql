-- ============================================================================
-- Migration: 20260625120000_capacity_measure_fn.sql
-- Date:      2026-06-25
-- Task:      T-602 (#107) — measurement primitive for capacity-monitor
-- Purpose:   app.measure_capacity() — uma medição atômica de uso de recursos
--            que o capacity-monitor (Edge Function) lê via rpc. Precisa de
--            SECURITY DEFINER porque service_role não tem acesso direto a
--            pg_database_size / storage.objects / pgmq por si só.
--            Retorna jsonb:
--              { db_bytes, db_per_table, storage_bytes, storage_per_bucket, queue_depths }
-- Spec refs: §10.2, §10.6, §D, BR-010..012.
--
-- Rollback: DROP FUNCTION IF EXISTS app.measure_capacity();
-- ============================================================================

CREATE OR REPLACE FUNCTION app.measure_capacity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_db_bytes           bigint;
  v_db_per_table       jsonb;
  v_storage_bytes      bigint;
  v_storage_per_bucket jsonb;
  v_queue_depths       jsonb;
BEGIN
  -- Total database size.
  v_db_bytes := pg_catalog.pg_database_size(pg_catalog.current_database());

  -- Top-25 public tables by total relation size → { relname: bytes }.
  SELECT COALESCE(pg_catalog.jsonb_object_agg(t.relname, t.sz), '{}'::jsonb)
    INTO v_db_per_table
  FROM (
    SELECT c.relname::text AS relname, pg_catalog.pg_total_relation_size(c.oid) AS sz
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_catalog.pg_total_relation_size(c.oid) DESC
     LIMIT 25
  ) t;

  -- Storage: total bytes + per-bucket, from the size in each object's metadata.
  SELECT COALESCE(pg_catalog.sum((o.metadata ->> 'size')::bigint), 0)
    INTO v_storage_bytes
  FROM storage.objects o;

  SELECT COALESCE(pg_catalog.jsonb_object_agg(b.bucket_id, b.sz), '{}'::jsonb)
    INTO v_storage_per_bucket
  FROM (
    SELECT o.bucket_id, COALESCE(pg_catalog.sum((o.metadata ->> 'size')::bigint), 0) AS sz
      FROM storage.objects o
     GROUP BY o.bucket_id
  ) b;

  -- pgmq queue depths → { queue_name: queue_length }.
  SELECT COALESCE(pg_catalog.jsonb_object_agg(m.queue_name, m.queue_length), '{}'::jsonb)
    INTO v_queue_depths
  FROM pgmq.metrics_all() m;

  RETURN pg_catalog.jsonb_build_object(
    'db_bytes', v_db_bytes,
    'db_per_table', v_db_per_table,
    'storage_bytes', v_storage_bytes,
    'storage_per_bucket', v_storage_per_bucket,
    'queue_depths', v_queue_depths
  );
END;
$$;

COMMENT ON FUNCTION app.measure_capacity() IS
  'Medição atômica de capacity (db_bytes/db_per_table/storage_bytes/storage_per_bucket/'
  'queue_depths) p/ o capacity-monitor (T-602). SECURITY DEFINER; EXECUTE só service_role.';

REVOKE EXECUTE ON FUNCTION app.measure_capacity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.measure_capacity() TO service_role;

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260625120000_capacity_measure_fn',
  'app.measure_capacity() — medição de db/storage/filas p/ o capacity-monitor (T-602).'
)
ON CONFLICT (migration_name) DO NOTHING;
