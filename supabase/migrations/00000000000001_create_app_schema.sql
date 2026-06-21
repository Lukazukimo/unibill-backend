-- ============================================================================
-- Migration: 00000000000001_create_app_schema.sql
-- Date:      2026-06-09
-- Task:      T-105
-- Purpose:   Bootstrap Unibill database — create dedicated `app` schema for
--            helpers/infra, enable core Postgres extensions (pgcrypto, pgmq,
--            pg_cron, pg_net, supabase_vault) and pgtap (dev-only), and create
--            `app.migration_metadata` to track structural invariants.
-- Spec refs: §3.1 (extension versions: supabase_vault ≥0.2, pgmq ≥1.5,
--            pg_cron ≥1.6, pg_net ≥0.13), §5.10 (sentinel actors),
--            §5.11 (helpers/RLS — schema `auth` is Supabase-managed; all
--            helpers must live in schema `app`).
--
-- Design notes:
--   * Idempotent: CREATE ... IF NOT EXISTS everywhere — migration can be
--     re-run without error.
--   * `supabase_vault` is the public, stable extension built on top of
--     pgsodium. Per tech-6 finding we install ONLY supabase_vault — never
--     pgsodium directly (Supabase manages pgsodium internally; touching it
--     breaks the Vault contract).
--   * No objects are ever created in the `auth` schema (managed by GoTrue).
--     All helper functions, sentinel tables, and metadata live in `app`.
--   * `pgtap` is wrapped in a DO block so production environments (which
--     don't have it available) won't fail. Dev/test images ship with it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ----------------------------------------------------------------------------
--   * DO NOT create helper functions in `auth.*` — use `app.*`.
--   * DO NOT install pgsodium directly — use `supabase_vault`.
--   * DO NOT add tables/policies to the `auth` schema — extend via FK from
--     `public` or `app` (e.g. `public.user_profiles(user_id REFERENCES auth.users(id))`).
--   * DO NOT enable RLS on `vault.*` — service_role-only via SECURITY DEFINER.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. Schema `app` — Unibill-owned helpers, infra, sentinel data
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS app;

COMMENT ON SCHEMA app IS
  'Schema próprio para helpers e infra do Unibill (mantém auth schema intocado per Supabase guidance — ver spec §5.11).';

-- USAGE grants — functions in `app` are called from RLS policies (authenticated)
-- and from Edge Functions / pg_cron jobs (service_role). `anon` is included so
-- that public-facing helpers (none today, but reserved) don't trip permission
-- errors during local dev / future expansion.
GRANT USAGE ON SCHEMA app TO authenticated, service_role, anon;


-- ============================================================================
-- 2. Core extensions
-- ============================================================================
-- pgcrypto — gen_random_uuid(), digest(), HMAC. Installed in the dedicated
-- `extensions` schema that Supabase provisions for managed projects. Falling
-- back to `public` would pollute the namespace and trip lint rules; the
-- `extensions` schema exists on every modern Supabase project (2023+).
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- pgmq — queue API (invoice_queue, email_sync_queue, *_dlq). Spec §3.1 pins ≥1.5.
CREATE EXTENSION IF NOT EXISTS pgmq;

-- pg_cron — periodic dispatchers/workers (sync-dispatcher, sync-worker,
-- extraction-worker, capacity-monitor, capacity-evictor). Spec §3.1 pins ≥1.6.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- pg_net — async HTTP from Postgres (used by pg_cron to invoke Edge Functions
-- via SECURITY DEFINER wrapper, see §6.6). Spec §3.1 pins ≥0.13.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- supabase_vault — secret storage (IMAP credentials, OAuth tokens). Public,
-- stable extension built on pgsodium. Spec §3.1 pins ≥0.2. **Never install
-- pgsodium directly** — supabase_vault owns that contract.
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- pgtap — pgTAP test framework. Dev/test only; wrapped in DO block so prod
-- (where the extension is not available on Supabase Cloud) does not fail.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
EXCEPTION
  WHEN feature_not_supported OR undefined_file OR insufficient_privilege THEN
    RAISE NOTICE 'pgtap not available in this environment — skipping (dev/test only).';
END
$$;


-- ============================================================================
-- 3. `app.migration_metadata` — structural-invariant ledger
-- ============================================================================
-- Tracks which structural migrations have been applied. Distinct from
-- supabase_migrations.schema_migrations (which tracks file checksums): this
-- table records *semantic* invariants and lets future migrations check
-- preconditions (e.g. "system_actors must exist before applying RLS").
CREATE TABLE IF NOT EXISTS app.migration_metadata (
  migration_name text PRIMARY KEY,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  description    text
);

COMMENT ON TABLE app.migration_metadata IS
  'Registro de migrations estruturais aplicadas (invariantes semânticos). '
  'Complementa supabase_migrations.schema_migrations (que rastreia checksums de arquivo). '
  'Permite que migrations futuras verifiquem pré-condições via EXISTS.';

COMMENT ON COLUMN app.migration_metadata.migration_name IS
  'Filename da migration (sem .sql), ex: 00000000000001_create_app_schema.';
COMMENT ON COLUMN app.migration_metadata.applied_at IS
  'Timestamp da primeira aplicação bem-sucedida (não muda em re-runs idempotentes).';
COMMENT ON COLUMN app.migration_metadata.description IS
  'Resumo do que a migration estabeleceu (helpful para grep histórico).';


-- ============================================================================
-- 4. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '00000000000001_create_app_schema',
  'Bootstrap: schema app + core extensions (pgcrypto, pgmq, pg_cron, pg_net, supabase_vault) + pgtap (dev) + app.migration_metadata.'
)
ON CONFLICT (migration_name) DO NOTHING;
