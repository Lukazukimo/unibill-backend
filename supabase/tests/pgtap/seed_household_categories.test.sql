-- ============================================================================
-- Test:      supabase/tests/pgtap/seed_household_categories.test.sql
-- Task:      T-119 (§5.4)
-- Purpose:   pgTAP assertions for app.seed_household_categories(uuid): the
--            function exists + is service_role-only, clones the 7 system-default
--            categories into a household (is_system=true, correct Material
--            color/icon), and is idempotent (a re-run inserts 0 rows).
--            Self-fixturing (BEGIN/ROLLBACK); the template rows come from the
--            migration's initial population (seeds are not loaded in test-db).
-- ============================================================================
BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(10);

-- Fixture: one household. No AFTER INSERT trigger fires, so categories are
-- populated only by the explicit function call below.
INSERT INTO public.households (id, name, created_by)
VALUES (
  '40000010-1111-1111-1111-111111111111',
  'Seed Test Household',
  'a1a1a1a1-1111-1111-1111-111111111111'
);

-- 1. The function exists with the expected signature.
SELECT has_function(
  'app', 'seed_household_categories', ARRAY['uuid'],
  'app.seed_household_categories(uuid) exists'
);

-- 2. EXECUTE is service_role only (backend-called; not reachable by clients).
SELECT ok(
  has_function_privilege('service_role', 'app.seed_household_categories(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app.seed_household_categories(uuid)', 'EXECUTE'),
  'EXECUTE on seed_household_categories is service_role only'
);

-- 3. The migration populated the template with the 7 system defaults.
SELECT is(
  (SELECT count(*)::int FROM app.invoice_category_templates),
  7, 'template holds the 7 default categories'
);

-- 4. First call clones all 7 and returns the inserted count.
SELECT is(
  app.seed_household_categories('40000010-1111-1111-1111-111111111111'::uuid),
  7, 'first seed inserts 7 categories'
);

-- 5. The household now has exactly 7 active categories.
SELECT is(
  (SELECT count(*)::int FROM public.invoice_categories
   WHERE household_id = '40000010-1111-1111-1111-111111111111'
     AND deleted_at IS NULL),
  7, 'household has 7 categories after seeding'
);

-- 6. Every seeded category is flagged is_system=true.
SELECT is(
  (SELECT count(*)::int FROM public.invoice_categories
   WHERE household_id = '40000010-1111-1111-1111-111111111111'
     AND is_system),
  7, 'all seeded categories are is_system=true'
);

-- 7. The names match the template set (order-independent).
SELECT set_eq(
  $$ SELECT name FROM public.invoice_categories
     WHERE household_id = '40000010-1111-1111-1111-111111111111' $$,
  ARRAY['Luz', 'Água', 'Gás', 'Internet', 'Telefone', 'Streaming', 'Outros'],
  'seeded category names match the template'
);

-- 8. Stable Material color + icon carried through for a representative row.
SELECT is(
  (SELECT color || '|' || icon FROM public.invoice_categories
   WHERE household_id = '40000010-1111-1111-1111-111111111111'
     AND name = 'Luz'),
  '#FBC02D|bolt', 'Luz carries the expected Material color + icon'
);

-- 9. Idempotent: a second call inserts nothing.
SELECT is(
  app.seed_household_categories('40000010-1111-1111-1111-111111111111'::uuid),
  0, 'second seed is a no-op (0 inserted)'
);

-- 10. And the household still has exactly 7 (no duplicates).
SELECT is(
  (SELECT count(*)::int FROM public.invoice_categories
   WHERE household_id = '40000010-1111-1111-1111-111111111111'
     AND deleted_at IS NULL),
  7, 'count stays 7 after the idempotent re-run'
);

SELECT * FROM finish();
ROLLBACK;
