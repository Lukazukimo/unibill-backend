-- ============================================================================
-- Migration: 20260615120100_create_households.sql
-- Date:      2026-06-10
-- Task:      T-107
-- Purpose:   Create `public.households` table (core multi-tenant aggregate) and
--            the shared `app.set_updated_at()` trigger helper. Every table in
--            the model that carries an `updated_at` column will attach this
--            trigger BEFORE UPDATE, so it lives in `app` (not duplicated).
-- Spec refs: §5.1  (households columns + types)
--            §5.10 (Approach A: drop FK constraints from audit columns —
--                   `created_by` references either auth.users(id) OR
--                   system_actors(id) once a user is anonymized; the FK would
--                   otherwise break ON DELETE of auth.users)
--
-- Design notes:
--   * `created_by` is declared as plain `uuid NOT NULL` — NO FOREIGN KEY to
--     auth.users (per spec §5.10 Approach A; same shape will apply to every
--     audit column in the schema: `updated_by`, `paid_by`, `invited_by`,
--     `actor_user_id`, `changed_by`, `granted_by`, `used_by`).
--   * `app.set_updated_at()` is intentionally generic — it returns NEW with
--     `updated_at = now()` and reuses across all mutable tables in subsequent
--     migrations (members, invoices, app_settings, etc.).
--   * Soft-delete is uniform via `deleted_at` (NULL = active). Hard deletes
--     are reserved for LGPD anonymize flow (§9.4) and never happen via UI.
--   * Idempotent: CREATE TABLE/FUNCTION/TRIGGER use IF NOT EXISTS / OR REPLACE
--     where supported; the trigger drop+recreate handles re-runs cleanly.
-- ============================================================================


-- ============================================================================
-- 1. Shared trigger helper: app.set_updated_at()
-- ============================================================================
-- Generic BEFORE UPDATE trigger function. Sets NEW.updated_at = now() and
-- returns NEW. Attached to every table that carries an `updated_at` column.
-- Lives in schema `app` to keep the canonical helper namespace clean and to
-- comply with spec §5.11 (no objects in `auth`).
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.set_updated_at() IS
  'Trigger helper compartilhado: BEFORE UPDATE seta NEW.updated_at = now(). '
  'Reutilizado em todas tabelas com coluna updated_at (households, members, '
  'invoices, app_settings, etc.). Ver spec §5.1.';


-- ============================================================================
-- 2. households — core multi-tenant aggregate
-- ============================================================================
-- Each household represents a shared billing context (e.g. uma casa, um casal,
-- uma república). Users participate via `members` (T-108). Invoices, connected
-- emails, settings — todos são escopados por household_id.
--
-- IMPORTANT: `created_by` has NO FK to auth.users (spec §5.10 Approach A).
-- After a user is anonymized, this column points to a system_actors UUID
-- (kind='deleted_user'). Integrity é validada no app + display via
-- `user_display_name(actor_id)` helper (T-106 / §5.10).
CREATE TABLE IF NOT EXISTS public.households (
  id           uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL,
  deleted_at   timestamptz
);

COMMENT ON TABLE public.households IS
  'Agregado multi-tenant raiz. Cada household agrupa membros (members), '
  'emails conectados (connected_emails), faturas (invoices) e settings '
  'próprios. Soft-delete via deleted_at (NULL = ativo). '
  'created_by é uuid puro sem FK (spec §5.10 Approach A — pode apontar '
  'pra auth.users(id) ou system_actors(id) após anonymize).';

COMMENT ON COLUMN public.households.id IS
  'PK gerado por gen_random_uuid().';
COMMENT ON COLUMN public.households.name IS
  'Nome amigável escolhido pelo criador (ex: "Casa do Centro").';
COMMENT ON COLUMN public.households.created_at IS
  'Timestamp de criação (imutável).';
COMMENT ON COLUMN public.households.updated_at IS
  'Atualizado automaticamente via trigger app.set_updated_at().';
COMMENT ON COLUMN public.households.created_by IS
  'UUID do criador. SEM FK constraint — pode referenciar auth.users(id) '
  'durante uso normal OU system_actors(id) após anonymize (§5.10 Approach A).';
COMMENT ON COLUMN public.households.deleted_at IS
  'Soft-delete marker. NULL = ativo; NOT NULL = removido. RLS oculta '
  'rows soft-deletadas em queries normais.';


-- ============================================================================
-- 3. Trigger: bump updated_at em cada UPDATE
-- ============================================================================
-- Drop+create garante idempotência sem precisar de CREATE TRIGGER IF NOT EXISTS
-- (que Postgres não suporta — só CREATE OR REPLACE TRIGGER em PG14+ e mesmo
-- assim com semântica diferente; DROP+CREATE é o pattern compatível e claro).
DROP TRIGGER IF EXISTS trg_households_set_updated_at ON public.households;
CREATE TRIGGER trg_households_set_updated_at
  BEFORE UPDATE ON public.households
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 4. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120100_create_households',
  'Tabela public.households + helper compartilhado app.set_updated_at() + '
  'trigger BEFORE UPDATE. created_by é uuid sem FK (Approach A §5.10).'
)
ON CONFLICT (migration_name) DO NOTHING;
