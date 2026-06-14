-- ============================================================================
-- Migration: 20260617120200_link_invoices_category.sql
-- Date:      2026-06-14
-- Task:      T-303
-- Purpose:   Adiciona o FK invoices.category_id -> invoice_categories(id) agora
--            que AMBAS as tabelas existem (invoices em 20260617120000,
--            invoice_categories em 20260617120100). ON DELETE SET NULL: apagar
--            uma categoria não apaga as faturas — apenas as descategoriza.
--
--            Separado em sua própria migration por causa da ordem de criação
--            (nota explícita em §5.3): invoices é criada antes de
--            invoice_categories, então o FK não pode ser inline na primeira.
--
-- Spec refs: §5.3  (nota "Ordem de migrations" — FK adicionado via ALTER TABLE
--                   depois que ambas existem; ON DELETE SET NULL).
--
-- Design notes:
--   * Idempotente: ADD CONSTRAINT não tem IF NOT EXISTS, então envelopamos num
--     DO block que checa pg_constraint primeiro.
--   * Cria também um índice em category_id para acelerar o ON DELETE SET NULL e
--     as queries de agrupamento por categoria (FKs não criam índice no lado
--     filho automaticamente no Postgres).
--
-- Rollback:
--   * ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS fk_invoices_category;
--   * DROP INDEX IF EXISTS public.idx_invoices_category;
-- ============================================================================


-- ============================================================================
-- 1. FK invoices.category_id -> invoice_categories(id) ON DELETE SET NULL
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_invoices_category'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT fk_invoices_category
      FOREIGN KEY (category_id)
      REFERENCES public.invoice_categories(id)
      ON DELETE SET NULL;
  END IF;
END
$$;


-- ============================================================================
-- 2. Índice de suporte ao FK (acelera ON DELETE SET NULL + group-by categoria)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_invoices_category
  ON public.invoices (category_id)
  WHERE deleted_at IS NULL AND category_id IS NOT NULL;

COMMENT ON INDEX public.idx_invoices_category IS
  'Suporta o FK fk_invoices_category (ON DELETE SET NULL) e o agrupamento de '
  'faturas ativas por categoria. Parcial: só rows ativas e categorizadas.';


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260617120200_link_invoices_category',
  'FK invoices.category_id -> invoice_categories(id) ON DELETE SET NULL '
  '(idempotente via DO block) + índice parcial idx_invoices_category. Ordem '
  'de migrations conforme nota §5.3.'
)
ON CONFLICT (migration_name) DO NOTHING;
