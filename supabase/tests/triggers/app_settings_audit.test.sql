-- ============================================================================
-- Test:      supabase/tests/triggers/app_settings_audit.test.sql
-- Date:      2026-06-10
-- Task:      T-123
-- Purpose:   pgTAP test suite covering the three audit-related invariants of
--            `public.app_settings` installed by T-111:
--
--              (A) the AFTER INSERT OR UPDATE trigger `trg_audit_app_settings`
--                  (calling `app.audit_app_settings()`) which snapshots each
--                  write into `public.app_settings_history` with the correct
--                  old_value / new_value / changed_by;
--              (B) the CHECK constraint `chk_scope_id` that enforces the
--                  "scope='global' XOR scope_id IS NOT NULL" invariant; and
--              (C) the two partial unique indexes
--                  (`idx_settings_global_unique` and
--                  `idx_settings_scoped_unique`) that together replace the
--                  illegal composite PK with NULL — they must reject duplicate
--                  global rows but allow a global + a scoped row for the same
--                  key (different scopes).
--
-- Spec refs: §5.5  (app_settings + app_settings_history schemas, partial
--                   unique indexes, CHECK chk_scope_id, audit-via-trigger).
--            §5.11 tech-3 (rationale for surrogate PK + partial unique indexes;
--                          this is the regression-test surface for that fix).
--            §5.11 tech-5 (audit trigger lives in schema `app`, not `auth`).
--
-- Test plan (6 assertions, one per scenario from the plan):
--   ok        #1: UPDATE of an app_settings row inserts a history row with
--                 old_value = OLD.value, new_value = NEW.value, changed_by
--                 propagated from NEW.updated_by.
--   is        #2: INSERT into app_settings ALSO inserts a history row
--                 (old_value IS NULL, new_value = NEW.value) — the spec says
--                 the trigger fires AFTER INSERT OR UPDATE, and the T-111
--                 migration explicitly creates it for both events. Assert via
--                 row count = 1 after an isolated INSERT.
--   throws_ok #3: INSERT with scope='global' AND scope_id IS NOT NULL must
--                 raise (CHECK chk_scope_id) — SQLSTATE 23514.
--   throws_ok #4: INSERT with scope='household' AND scope_id IS NULL must
--                 raise (CHECK chk_scope_id) — SQLSTATE 23514.
--   throws_ok #5: INSERT of a second global row with the same key must raise
--                 (partial unique idx_settings_global_unique) — SQLSTATE 23505.
--   lives_ok  #6: One global row + one household-scoped row for the SAME key
--                 both succeed (different scopes pass through different
--                 partial unique indexes; CHECK is satisfied for both).
--
-- Hermeticity:
--   Entire test wrapped in BEGIN / ROLLBACK so no state leaks. Each scenario
--   uses deterministic UUIDs and distinct keys to make failure messages
--   readable. The `changed_by` propagation test (#1) uses a single seeded
--   auth.users row so the FK in `app_settings_history.changed_by` is satisfied
--   without depending on session JWT (`auth.uid()` is NULL in the pgTAP
--   session, so the trigger's fallback chain would resolve to NULL — we
--   exercise the explicit NEW.updated_by path which is the higher-priority
--   branch in `app.audit_app_settings()`).
--
-- Notes on SQLSTATEs:
--   * `23514` — check_violation (CHECK constraint).
--   * `23505` — unique_violation (partial unique index).
--   pgTAP `throws_ok(query, sqlstate, message, description)` lets us assert
--   the exact SQLSTATE; we pass NULL for the message to avoid coupling to
--   Postgres-version-specific wording (the message text for CHECK violations
--   includes the constraint name and is stable across PG14-16, but pinning
--   the SQLSTATE is the more robust contract).
-- ============================================================================


BEGIN;

-- pgTAP lives in `extensions` (installed by T-105). Set search_path so the
-- unqualified pgTAP calls (plan, ok, is, throws_ok, lives_ok, finish) resolve.
SET LOCAL search_path = public, extensions, app;

SELECT plan(6);


-- ============================================================================
-- Setup: seed one auth.users row (acts as changed_by snapshot in scenario #1)
-- and two well-known household uuids that scenarios #4 and #6 will use as
-- scope_id values. We intentionally do NOT FK app_settings.scope_id to
-- households — the spec leaves that as a free uuid column resolved by the
-- application — so the household uuids here are just opaque identifiers.
--
-- Deterministic UUIDs make failure output legible.
-- ============================================================================

INSERT INTO auth.users (id, instance_id, email, aud, role)
VALUES (
  '99999999-9999-9999-9999-999999999901',
  '00000000-0000-0000-0000-000000000000',
  'settings-writer@test.local',
  'authenticated',
  'authenticated'
);


-- ============================================================================
-- ok #1 — UPDATE on app_settings inserts a history row with old/new + changed_by
-- ============================================================================
-- Insert a baseline row (this WILL fire the trigger once via the INSERT path —
-- that history row is asserted separately in scenario #2 with its own key, so
-- here we just clear the history immediately AFTER the INSERT to isolate the
-- UPDATE-specific assertion. This keeps each scenario's pre/post state crisp).
--
-- The key 'test.update_scenario' is unique to this scenario so the partial
-- unique index on (key) WHERE scope='global' cannot collide with anything
-- inserted later in the test.
INSERT INTO public.app_settings (key, scope, scope_id, value, category, updated_by)
VALUES (
  'test.update_scenario',
  'global',
  NULL,
  '{"v": 1}'::jsonb,
  'test',
  '99999999-9999-9999-9999-999999999901'
);

-- Drop the INSERT-trigger row so the UPDATE row is the only one matching the
-- key — keeps the assertion text below honest about "the history row".
DELETE FROM public.app_settings_history
 WHERE key = 'test.update_scenario';

-- Now perform the UPDATE the scenario actually exercises.
UPDATE public.app_settings
   SET value      = '{"v": 2}'::jsonb,
       updated_by = '99999999-9999-9999-9999-999999999901'
 WHERE key   = 'test.update_scenario'
   AND scope = 'global';

-- Assertion: exactly one history row exists for this key AND it has
-- old_value = {"v": 1}, new_value = {"v": 2}, changed_by = the writer uuid.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.app_settings_history
     WHERE key        = 'test.update_scenario'
       AND old_value  = '{"v": 1}'::jsonb
       AND new_value  = '{"v": 2}'::jsonb
       AND changed_by = '99999999-9999-9999-9999-999999999901'
  )
  AND (
    SELECT count(*) FROM public.app_settings_history
     WHERE key = 'test.update_scenario'
  ) = 1,
  'ok #1: UPDATE inserts history row with correct old_value/new_value/changed_by'
);


-- ============================================================================
-- is #2 — INSERT into app_settings ALSO inserts a history row
-- ============================================================================
-- T-111 creates the trigger AFTER INSERT OR UPDATE (both events). For INSERT,
-- the trigger function sets old_value = NULL and new_value = NEW.value. We
-- use a distinct key so the assertion's row-count is unambiguous.
INSERT INTO public.app_settings (key, scope, scope_id, value, category, updated_by)
VALUES (
  'test.insert_scenario',
  'global',
  NULL,
  '{"v": "hello"}'::jsonb,
  'test',
  '99999999-9999-9999-9999-999999999901'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.app_settings_history
    WHERE key        = 'test.insert_scenario'
      AND old_value  IS NULL
      AND new_value  = '{"v": "hello"}'::jsonb
      AND changed_by = '99999999-9999-9999-9999-999999999901'),
  1,
  'is #2: INSERT into app_settings inserts exactly one history row with old_value=NULL'
);


-- ============================================================================
-- throws_ok #3 — scope='global' with scope_id NOT NULL must violate CHECK
-- ============================================================================
-- CHECK chk_scope_id encodes: (scope='global' AND scope_id IS NULL) OR
-- (scope<>'global' AND scope_id IS NOT NULL). The row below violates the
-- first branch (global rows MUST have NULL scope_id). Postgres raises
-- SQLSTATE 23514 (check_violation) — we pin that SQLSTATE so the assertion
-- doesn't break on minor wording changes in the error message.
SELECT throws_ok(
  $$ INSERT INTO public.app_settings (key, scope, scope_id, value, category)
     VALUES ('test.check_global_with_scope_id',
             'global',
             '00000000-0000-0000-0000-000000000aaa',
             '{"v": 1}'::jsonb,
             'test') $$,
  '23514',
  NULL,
  'throws_ok #3: scope=global with scope_id NOT NULL violates CHECK chk_scope_id (23514)'
);


-- ============================================================================
-- throws_ok #4 — scope='household' with scope_id NULL must violate CHECK
-- ============================================================================
-- Same CHECK, second branch: non-global rows MUST have scope_id NOT NULL.
SELECT throws_ok(
  $$ INSERT INTO public.app_settings (key, scope, scope_id, value, category)
     VALUES ('test.check_household_without_scope_id',
             'household',
             NULL,
             '{"v": 1}'::jsonb,
             'test') $$,
  '23514',
  NULL,
  'throws_ok #4: scope=household with scope_id NULL violates CHECK chk_scope_id (23514)'
);


-- ============================================================================
-- throws_ok #5 — two global rows with the same key violate partial unique
-- ============================================================================
-- idx_settings_global_unique is a partial unique index on (key) WHERE
-- scope='global'. The first INSERT seeds a global row; the second attempts
-- to insert another global row with the SAME key and MUST raise SQLSTATE
-- 23505 (unique_violation).
INSERT INTO public.app_settings (key, scope, scope_id, value, category)
VALUES (
  'test.unique_global',
  'global',
  NULL,
  '{"v": 1}'::jsonb,
  'test'
);

SELECT throws_ok(
  $$ INSERT INTO public.app_settings (key, scope, scope_id, value, category)
     VALUES ('test.unique_global',
             'global',
             NULL,
             '{"v": 2}'::jsonb,
             'test') $$,
  '23505',
  NULL,
  'throws_ok #5: second global row with same key violates partial unique idx_settings_global_unique (23505)'
);


-- ============================================================================
-- lives_ok #6 — one global row + one household-scoped row for the same key
-- ============================================================================
-- The two partial unique indexes are disjoint:
--   * idx_settings_global_unique  covers WHERE scope='global'
--   * idx_settings_scoped_unique  covers WHERE scope<>'global'
-- So a global row and a household-scoped row with the SAME key occupy
-- DIFFERENT indexes and must both succeed. This is the spec's whole point
-- of the cascade (user > household > global > default) — the same key
-- naturally exists at multiple scopes.
--
-- The CHECK constraint is also satisfied: global row has scope_id NULL,
-- household row has scope_id NOT NULL.
--
-- Note: we use a fresh key not touched by any other scenario to keep the
-- assertion independent of side effects.
SELECT lives_ok(
  $$ INSERT INTO public.app_settings (key, scope, scope_id, value, category) VALUES
       ('test.multi_scope_ok', 'global',    NULL,                                  '{"v": "global-default"}'::jsonb, 'test'),
       ('test.multi_scope_ok', 'household', '00000000-0000-0000-0000-000000000bbb', '{"v": "household-override"}'::jsonb, 'test') $$,
  'lives_ok #6: one global + one household-scoped row for the same key both succeed'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
