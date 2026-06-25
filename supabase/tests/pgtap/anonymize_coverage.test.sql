-- ============================================================================
-- Test:      supabase/tests/pgtap/anonymize_coverage.test.sql
-- Date:      2026-06-25
-- Task:      T-607 (#117) — §5.10 "Auditoria contínua via CI" coverage guard
-- Purpose:   Fail CI if a NEW foreign key to auth.users appears in a public-schema
--            table that is NOT on the canonical whitelist. Every such FK must be
--            either rewritten to a sentinel or hard-deleted by
--            app.anonymize_user_references (§5.10) / the §9.4 delete-account flow,
--            otherwise deleting a user would hit an unhandled FK violation in
--            production. This is the standing safety net for the anonymize
--            contract: add an auth.users FK without handling it → red build.
--
-- Whitelist = the OWNERSHIP columns (audit columns were FK-dropped in T-606):
--   client_telemetry.user_id        — DELETEd by anonymize
--   connected_emails.owner_user_id  — soft-deleted rows hard-deleted by anonymize;
--                                       actives removed by §9.4 before user delete
--   members.user_id                 — idem
--   user_profiles.user_id           — deleted by §9.4 delete-account flow
--   system_admin_grants.user_id     — grants removed by §9.4 when the admin user goes
--
-- If this fails: either drop the new FK (audit → Approach A) and add the column
-- to anonymize_user_references, or — if it is genuine ownership — handle it in
-- the delete flow and add it to this whitelist with a justification.
--
-- BEGIN/ROLLBACK; read-only (only SELECTs pg_constraint).
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(1);

SELECT set_eq(
  $$ SELECT cl.relname || '.' || a.attname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f'
        AND c.confrelid = 'auth.users'::regclass
        AND n.nspname = 'public' $$,
  ARRAY[
    'client_telemetry.user_id',
    'connected_emails.owner_user_id',
    'members.user_id',
    'system_admin_grants.user_id',
    'user_profiles.user_id'
  ],
  'public-schema FKs → auth.users == the canonical anonymize whitelist (a new, '
    || 'unhandled FK fails the build — see §5.10 / anonymize_user_references)'
);

SELECT * FROM finish();

ROLLBACK;
