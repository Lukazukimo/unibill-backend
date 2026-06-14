-- ============================================================================
-- Migration: 20260617120100_create_invoice_categories.sql
-- Date:      2026-06-14
-- Task:      T-302
-- Purpose:   Implementa public.invoice_categories (§5.4) — as categorias de
--            fatura por household (Luz, Água, Gás, Internet, ...). Cada household
--            tem o seu próprio conjunto (clonado de um template de sistema na
--            criação do household — seed/trigger em T-119, fora do escopo desta
--            migration). is_system marca as categorias default clonadas.
--
--            O FK invoices.category_id -> invoice_categories(id) é adicionado
--            DEPOIS, em 20260617120200_link_invoices_category.sql (ordem de
--            migrations da nota §5.3).
--
-- Spec refs: §5.4  (invoice_categories DDL + índice único parcial por
--                   (household_id, name) WHERE deleted_at IS NULL).
--            §5.11 (RLS — habilitado em 20260617120300; SELECT member-of,
--                   write admin-of household).
--
-- Design notes:
--   * PK via extensions.gen_random_uuid() (convenção do repo).
--   * household_id MANTÉM FK (ownership/tenant real).
--   * idx_cat_name_household é PARTIAL UNIQUE WHERE deleted_at IS NULL — permite
--     recriar uma categoria com o mesmo nome após soft-delete sem violar UNIQUE
--     (o par histórico permanece queryable).
--   * Trigger app.set_updated_at() anexado.
--   * Idempotente: CREATE TABLE/INDEX com IF NOT EXISTS.
--
-- Rollback:
--   * DROP TABLE IF EXISTS public.invoice_categories CASCADE;
--   (CASCADE remove o FK invoices_category criado em 20260617120200 — em rollback
--    completo, reverter as migrations na ordem inversa.)
-- ============================================================================


-- ============================================================================
-- 1. public.invoice_categories — categorias por household
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.invoice_categories (
  id           uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES public.households(id),
  name         text NOT NULL,
  color        text,
  icon         text,
  is_system    boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

COMMENT ON TABLE public.invoice_categories IS
  'Categorias de fatura por household (Luz, Água, Gás, Internet, ...). Cada '
  'household tem seu conjunto, clonado de um template de sistema na criação '
  '(is_system=true nas defaults). SELECT = member-of household; write = '
  'admin-of household. Soft-delete via deleted_at. Spec §5.4.';

COMMENT ON COLUMN public.invoice_categories.household_id IS
  'FK households(id). Tenant da categoria — base da RLS (member SELECT / admin write).';
COMMENT ON COLUMN public.invoice_categories.name IS
  'Nome da categoria (ex: "Luz"). Único por household entre rows ativas '
  '(idx_cat_name_household, partial WHERE deleted_at IS NULL).';
COMMENT ON COLUMN public.invoice_categories.color IS
  'Cor hex para exibição no app (ex: #FFCC00). Nullable.';
COMMENT ON COLUMN public.invoice_categories.icon IS
  'Nome do ícone (Material/Cupertino) usado pelo app. Nullable.';
COMMENT ON COLUMN public.invoice_categories.is_system IS
  'true = categoria default clonada do template de sistema na criação do '
  'household; false = criada pelo usuário. Spec §5.4 / T-119.';
COMMENT ON COLUMN public.invoice_categories.sort_order IS
  'Ordem de exibição (ascendente). Default 0.';
COMMENT ON COLUMN public.invoice_categories.deleted_at IS
  'Soft-delete marker. NULL = ativa. Excluída do índice único parcial '
  '(permite recriar nome após delete) e das listagens do app. RLS não filtra '
  'deleted_at.';


-- ============================================================================
-- 2. Trigger: bump updated_at em UPDATE
-- ============================================================================
DROP TRIGGER IF EXISTS trg_invoice_categories_set_updated_at
  ON public.invoice_categories;
CREATE TRIGGER trg_invoice_categories_set_updated_at
  BEFORE UPDATE ON public.invoice_categories
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 3. Índice único parcial: nome único por household entre rows ativas
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_name_household
  ON public.invoice_categories (household_id, name)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.idx_cat_name_household IS
  'Partial unique: nome único por household entre categorias ATIVAS. Exclui '
  'soft-deletadas -> permite recriar mesmo nome após delete. Spec §5.4.';


-- ============================================================================
-- 4. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260617120100_create_invoice_categories',
  'Tabela public.invoice_categories (§5.4): categorias de fatura por household '
  '(household_id FK, name, color, icon, is_system, sort_order, soft-delete), '
  'índice único parcial idx_cat_name_household (household_id, name) WHERE '
  'deleted_at IS NULL, trigger set_updated_at.'
)
ON CONFLICT (migration_name) DO NOTHING;
