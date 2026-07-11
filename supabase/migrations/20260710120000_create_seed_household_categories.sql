-- ============================================================================
-- Migration: 20260710120000_create_seed_household_categories.sql
-- Date:      2026-07-10
-- Task:      T-119
-- Purpose:   Template das categorias de fatura default do sistema + a função
--            app.seed_household_categories(household_id) que as clona para um
--            household novo (is_system=true). O wiring do trigger / Edge
--            Function no fluxo de criação de household fica para P2 (fora do
--            escopo desta migration).
-- Spec refs: §5.4 (invoice_categories — "clonado de um template de sistema na
--            criação do household — seed/trigger em T-119").
--
-- Design notes:
--   * app.invoice_category_templates: tabela de referência (name PK, color,
--     icon, sort_order) — a fonte única em runtime. Populada AQUI (robusto: a
--     função opera a partir de uma migration limpa, sem depender do seed ser
--     carregado) e re-populável via supabase/seeds/invoice_categories_template.sql.
--   * app.seed_household_categories(uuid): SECURITY DEFINER, service_role only.
--     INSERT ... SELECT do template com ON CONFLICT (household_id, name) WHERE
--     deleted_at IS NULL DO NOTHING (casa o índice parcial idx_cat_name_household)
--     → idempotente (re-run = 0 novas). Retorna o nº de linhas inseridas.
--   * Cores/ícones alinhados aos tokens Material que o app mobile usa.
--   * Idempotente: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
--     INSERT ... ON CONFLICT DO NOTHING.
--
-- Rollback:
--   * DROP FUNCTION IF EXISTS app.seed_household_categories(uuid);
--   * DROP TABLE IF EXISTS app.invoice_category_templates;
-- ============================================================================


-- ============================================================================
-- 1. app.invoice_category_templates — categorias default do sistema
-- ============================================================================
CREATE TABLE IF NOT EXISTS app.invoice_category_templates (
  name       text PRIMARY KEY,
  color      text NOT NULL,
  icon       text NOT NULL,
  sort_order int  NOT NULL DEFAULT 0
);

COMMENT ON TABLE app.invoice_category_templates IS
  'Template das categorias de fatura default do sistema (§5.4). Clonadas para '
  'cada household novo por app.seed_household_categories (is_system=true). '
  'Fonte única em runtime; re-populável via seeds/invoice_categories_template.sql.';

-- Dados iniciais (mirror de supabase/seeds/invoice_categories_template.sql).
INSERT INTO app.invoice_category_templates (name, color, icon, sort_order) VALUES
  ('Luz', '#FBC02D', 'bolt', 1),
  ('Água', '#0288D1', 'water_drop', 2),
  ('Gás', '#F4511E', 'local_fire_department', 3),
  ('Internet', '#00897B', 'wifi', 4),
  ('Telefone', '#43A047', 'phone', 5),
  ('Streaming', '#8E24AA', 'play_circle', 6),
  ('Outros', '#757575', 'category', 7)
ON CONFLICT (name) DO NOTHING;


-- ============================================================================
-- 2. app.seed_household_categories(household_id) — clona o template
-- ============================================================================
CREATE OR REPLACE FUNCTION app.seed_household_categories(p_household_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO public.invoice_categories
    (household_id, name, color, icon, is_system, sort_order)
  SELECT p_household_id, t.name, t.color, t.icon, true, t.sort_order
  FROM app.invoice_category_templates t
  ON CONFLICT (household_id, name) WHERE deleted_at IS NULL DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION app.seed_household_categories(uuid) IS
  'T-119 (§5.4): clona as categorias default do template para o household dado '
  '(is_system=true). Idempotente via ON CONFLICT (household_id, name) WHERE '
  'deleted_at IS NULL DO NOTHING; retorna o nº de linhas inseridas. SECURITY '
  'DEFINER, service_role only (chamado pelo fluxo de criação de household).';

REVOKE ALL ON FUNCTION app.seed_household_categories(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.seed_household_categories(uuid) TO service_role;


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260710120000_create_seed_household_categories',
  'T-119 (§5.4): app.invoice_category_templates (7 categorias default do '
  'sistema: Luz/Água/Gás/Internet/Telefone/Streaming/Outros com cor+ícone '
  'Material) + app.seed_household_categories(uuid) que as clona para um '
  'household (is_system=true, idempotente). Trigger/wiring do household-create '
  'deferido para P2.'
)
ON CONFLICT (migration_name) DO NOTHING;
