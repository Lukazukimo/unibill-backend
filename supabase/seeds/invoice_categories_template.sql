-- ============================================================================
-- Seed:      invoice_categories_template.sql
-- Date:      2026-07-10
-- Task:      T-119
-- Purpose:   Categorias de fatura default do sistema (§5.4), clonadas para cada
--            household novo por app.seed_household_categories(). Esta é a cópia
--            viva e editável do template: a migration
--            20260710120000_create_seed_household_categories.sql já embute a
--            população inicial (para a função operar a partir de uma migration
--            limpa); re-rode este seed para atualizar o conjunto default sem
--            uma nova migration (só afeta households criados dali em diante).
-- Spec refs: §5.4
--
-- Idempotência: ON CONFLICT (name) DO NOTHING. Cores/ícones = tokens Material
-- usados pelo app mobile.
-- ============================================================================

INSERT INTO app.invoice_category_templates (name, color, icon, sort_order) VALUES
  ('Luz', '#FBC02D', 'bolt', 1),
  ('Água', '#0288D1', 'water_drop', 2),
  ('Gás', '#F4511E', 'local_fire_department', 3),
  ('Internet', '#00897B', 'wifi', 4),
  ('Telefone', '#43A047', 'phone', 5),
  ('Streaming', '#8E24AA', 'play_circle', 6),
  ('Outros', '#757575', 'category', 7)
ON CONFLICT (name) DO NOTHING;
