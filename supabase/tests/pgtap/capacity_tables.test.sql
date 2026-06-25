-- ============================================================================
-- Test:      supabase/tests/pgtap/capacity_tables.test.sql
-- Date:      2026-06-24
-- Task:      T-601 (#106) — capacity/health/telemetry schema
-- Purpose:   Assert the migration 20260624140000_capacity_health_telemetry
--            created the §5.7/§5.6 schema exactly: the capacity_status enum
--            (green/yellow/orange/red), all 6 tables with their key columns +
--            indexes, and the capacity_eviction_queue / _dlq pgmq queues.
--
-- Spec refs: §5.7 (capacity tables), §5.6 (client_telemetry), §10.2 (enum).
-- Migration-state assertion (reads the live catalog); BEGIN/ROLLBACK hygiene,
-- no writes. Runs as postgres (service-role-equivalent).
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(16);

-- ---- enum ------------------------------------------------------------------
SELECT is(
  (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
     FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'capacity_status'),
  ARRAY['green', 'yellow', 'orange', 'red'],
  '#1 capacity_status enum has exactly green/yellow/orange/red (in order)'
);

-- ---- the 6 tables exist ----------------------------------------------------
SELECT has_table('public', 'capacity_snapshots', '#2 capacity_snapshots exists');
SELECT has_table('public', 'eviction_runs', '#3 eviction_runs exists');
SELECT has_table('public', 'pdf_archive_log', '#4 pdf_archive_log exists');
SELECT has_table('public', 'health_snapshots', '#5 health_snapshots exists');
SELECT has_table('public', 'health_snapshots_hourly', '#6 health_snapshots_hourly exists');
SELECT has_table('public', 'client_telemetry', '#7 client_telemetry exists');

-- ---- representative columns / types (DDL fidelity) -------------------------
SELECT col_type_is(
  'public', 'capacity_snapshots', 'db_status', 'capacity_status',
  '#8 capacity_snapshots.db_status is capacity_status'
);
SELECT col_type_is(
  'public', 'eviction_runs', 'steps', 'jsonb',
  '#9 eviction_runs.steps is jsonb'
);
SELECT col_type_is(
  'public', 'client_telemetry', 'payload', 'jsonb',
  '#10 client_telemetry.payload is jsonb'
);
SELECT has_column(
  'public', 'pdf_archive_log', 'archived_by_run',
  '#11 pdf_archive_log.archived_by_run exists (FK → eviction_runs)'
);

-- ---- indexes (exact names from spec) ---------------------------------------
SELECT ok(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_capacity_time'),
  '#12 idx_capacity_time on capacity_snapshots'
);
SELECT ok(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_eviction_runs_time'),
  '#13 idx_eviction_runs_time on eviction_runs'
);
SELECT ok(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_eviction_runs_resource'),
  '#14 idx_eviction_runs_resource on eviction_runs'
);
SELECT ok(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_telemetry_time'),
  '#15 idx_telemetry_time on client_telemetry'
);

-- ---- pgmq eviction queues --------------------------------------------------
SELECT is(
  (SELECT count(*) FROM pgmq.list_queues()
    WHERE queue_name IN ('capacity_eviction_queue', 'capacity_eviction_dlq')),
  2::bigint,
  '#16 capacity_eviction_queue + capacity_eviction_dlq created'
);

SELECT * FROM finish();

ROLLBACK;
