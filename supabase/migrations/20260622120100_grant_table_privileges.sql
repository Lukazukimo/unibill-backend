-- ============================================================================
-- Migration: 20260622120100_grant_table_privileges.sql
-- Date:      2026-06-22
-- Task:      T-114 (corrective — base table-level GRANTs presupposed by the RLS
--            policy set; tracked in #213)
-- Spec refs: §5.11 (Policies — síntese: per-table SELECT vs INSERT/UPDATE/DELETE
--            matrix; the authenticated grants below mirror it), §9.3.1 (vault
--            stays service_role-only — untouched here).
-- Purpose:   Grant the BASE TABLE-LEVEL privileges that every RLS policy in this
--            schema silently presupposes but that no migration ever issued.
--
--            ROOT CAUSE: RLS filters ROWS, but a role still needs a table-level
--            DML GRANT (SELECT/INSERT/UPDATE/DELETE) to touch the table AT ALL —
--            the grant check happens BEFORE row security. In this database the
--            tables are created by the `postgres` role, whose default ACL in
--            schema `public` grants only `Dxt` (TRUNCATE/REFERENCES/TRIGGER) to
--            anon/authenticated/service_role — NOT the DML privileges. (Tables
--            created by `supabase_admin` would inherit full DML via its default
--            ACL, but `supabase db reset` / `db push` run migrations as
--            `postgres`.) Net effect today:
--
--              * `authenticated` → `permission denied for table …` on EVERY
--                public table except `system_actors` (the one table that issued
--                an explicit GRANT, in 20260615120000). Its RLS policies are
--                effectively dead code.
--              * `service_role` → SAME. BYPASSRLS skips row security but NOT the
--                table GRANT, so the workers / Edge Functions cannot read or
--                write either. Latent only because prior runtime validation ran
--                as `postgres` (the owner) and the Edge Functions are unit-
--                tested with DI fakes — the real service_role path was never
--                exercised against the DB.
--
--            This blocked the entire pgTAP `rls/` suite (every assertion runs as
--            `authenticated`) and is the reason cross-table RLS could never be
--            verified end-to-end (see #213).
--
--            FIX:
--              * service_role → GRANT ALL on every current public table +
--                sequence, plus ALTER DEFAULT PRIVILEGES so FUTURE postgres-
--                created objects are born accessible. service_role is the
--                trusted backend identity (BYPASSRLS); it legitimately needs
--                every table.
--              * authenticated → EXACTLY the DML verbs for which an RLS policy
--                targeting `authenticated` exists on each table (derived from
--                pg_policies, cross-checked against spec §5.11 "Policies —
--                síntese"). No more, no less — granting a verb with no matching
--                policy would be dead privilege; granting where the policy is
--                service_role-only would be a security hole.
--
-- Design notes:
--   * authenticated grant set, derived verb-by-verb from the live RLS policies:
--       full DML (S/I/U/D): households, members, connected_emails,
--         connected_email_households, invoices, invoice_categories,
--         app_settings, household_invitations
--       S/I/U (own rows, no delete): consent_log
--       S/U (own profile): user_profiles
--       SELECT only: app_settings_history, domain_events, extraction_runs,
--         sync_runs, system_admin_grants, utility_parsers, system_actors
--       NO authenticated grant (RLS-disabled, service_role only):
--         circuit_breakers, rate_limit_buckets
--   * `anon` gets NOTHING new — no policy targets anon, and utility_parsers is
--     deliberately authenticated-only (spec §5.11) to avoid leaking parser
--     fingerprints to the public Supabase URL.
--   * No authenticated grant needs a sequence: every authenticated-insertable
--     table uses a uuid PK (gen_random_uuid). The lone public sequence
--     (app_settings_history_id_seq) backs a service_role-only-write table.
--   * Idempotent: GRANT is set-union, ALTER DEFAULT PRIVILEGES is upsert.
--
-- CONVENTION (enforced by review — future migrations):
--   Every NEW public table that enables RLS with policies `TO authenticated`
--   MUST issue the matching `GRANT <verbs> ON public.<t> TO authenticated` in
--   the SAME migration. service_role is covered automatically by the ALTER
--   DEFAULT PRIVILEGES below; authenticated is NOT (its verb set is per-table)
--   and must be explicit. Omitting it reintroduces the `permission denied` bug.
--
-- Rollback:
--   REVOKE the grants below; the RLS policies remain but become unreachable
--   again (the pre-fix broken state). Not recommended.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by review)
-- ----------------------------------------------------------------------------
--   * DO NOT `GRANT … TO anon` on any of these tables — anon has no policy and
--     must retain zero direct access (utility_parsers especially, spec §5.11).
--   * DO NOT widen an authenticated grant beyond the verbs that have a matching
--     RLS policy — e.g. never GRANT INSERT/UPDATE/DELETE on domain_events,
--     sync_runs, extraction_runs, system_admin_grants, app_settings_history
--     (writes are service_role only per spec §5.11).
--   * DO NOT GRANT on circuit_breakers / rate_limit_buckets to authenticated —
--     RLS-disabled, service_role-only worker tables.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. service_role — trusted backend identity: full access to everything
-- ============================================================================
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Future postgres-created objects in public are born service_role-accessible
-- (prevents this gap from recurring for the backend identity).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;


-- ============================================================================
-- 2. authenticated — per-table, verb-for-verb with the RLS policies
-- ============================================================================

-- 2a. Full DML — tables with authenticated SELECT + write (member/owner/admin).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.households                  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.members                     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connected_emails            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connected_email_households  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_categories          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings                TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.household_invitations       TO authenticated;

-- 2b. SELECT + INSERT + UPDATE (own rows; no DELETE) — consent_log.
GRANT SELECT, INSERT, UPDATE ON public.consent_log TO authenticated;

-- 2c. SELECT + UPDATE (read cross-household; update own profile) — user_profiles.
GRANT SELECT, UPDATE ON public.user_profiles TO authenticated;

-- 2d. SELECT only — read access via RLS; writes are service_role-only.
GRANT SELECT ON public.app_settings_history TO authenticated;
GRANT SELECT ON public.domain_events        TO authenticated;
GRANT SELECT ON public.extraction_runs      TO authenticated;
GRANT SELECT ON public.sync_runs            TO authenticated;
GRANT SELECT ON public.system_admin_grants  TO authenticated;
GRANT SELECT ON public.utility_parsers      TO authenticated;
-- Re-affirm system_actors (already granted in 20260615120000; idempotent).
GRANT SELECT ON public.system_actors        TO authenticated;


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260622120100_grant_table_privileges',
  'Base table-level GRANTs presupostos pelas policies RLS: service_role GRANT '
  'ALL (tabelas+sequences+default privileges); authenticated com verbos '
  'casando 1:1 com as policies por tabela (spec §5.11). Conserta '
  'permission-denied sistêmico (#213).'
)
ON CONFLICT (migration_name) DO NOTHING;
