-- ============================================================================
-- Migration: 20260616121000_rls_connected_emails.sql
-- Date:      2026-06-10
-- Task:      T-210
-- Purpose:   Enable Row-Level Security (RLS) and create the full policy set
--            for the two tables that compose the "connected email" subsystem:
--
--              1. public.connected_emails           — credential + IMAP cursor.
--                                                     Visible to the owner OR
--                                                     to any admin of a household
--                                                     currently bound to the
--                                                     credential via the
--                                                     junction table.
--              2. public.connected_email_households — junction many-to-many
--                                                     between connected_emails
--                                                     and households. Visible
--                                                     to any member of the
--                                                     household; writable only
--                                                     by admins of the household.
--
--            All policies use the helpers created in T-113
--            (`app.households_of_user`, `app.is_household_admin`,
--            `app.is_system_admin`) and follow the RLS patterns documented in
--            spec §5.11.
--
-- Spec refs: §5.11 (RLS — resumo de policies, row "connected_emails" +
--                    row "connected_email_households", Patterns A/B/D DDL
--                    templates).
--            §5.2  (table definitions, soft-delete semantics — `deleted_at`
--                    excluded from cross-binding EXISTS join so revoked
--                    bindings stop conferring admin access).
--            §5.10 (ownership distinction — owner_user_id é o dono real;
--                    quem revoga / desconecta a credencial é o owner.
--                    Admin of a bound household pode editar last_error /
--                    status pra remediar mas a destruição da credencial
--                    Vault permanece responsabilidade do owner via
--                    app.anonymize_user em T-228).
--
-- Design notes (T-210 specific):
--   * connected_emails has NO household_id column — the row represents the
--     credential globally. Authorization is computed via the junction:
--       owner_user_id = auth.uid()
--         OR EXISTS (
--           SELECT 1 FROM connected_email_households ceh
--           WHERE ceh.connected_email_id = connected_emails.id
--             AND app.is_household_admin(ceh.household_id)
--             AND ceh.deleted_at IS NULL
--         )
--     The EXISTS join uses the helper `app.is_household_admin(uuid)` instead
--     of joining members directly — this keeps the policy declarative and
--     matches the rest of the codebase (Pattern B + Pattern D combined).
--   * `ceh.deleted_at IS NULL` is REQUIRED in the EXISTS predicate: a
--     soft-deleted binding must NOT continue granting admin access to the
--     credential. Spec §5.2 + §5.11 row sync_runs/extraction_runs (which
--     references the same pattern) both stipulate the `deleted_at` guard.
--   * For SELECT we use `FOR SELECT` policies (Pattern A/B). For write we use
--     a single `FOR ALL` policy with USING + WITH CHECK mirroring — this
--     prevents privilege escalation on UPDATE: a row that the caller cannot
--     see (USING fails) cannot be updated, and a row whose UPDATE would
--     produce a state where the caller no longer has access (WITH CHECK
--     fails) is rejected. The mirrored predicate makes that property
--     symmetric so the only way to "lose" a row via UPDATE is to no longer
--     be the owner / admin-of-binding after the change — exactly the desired
--     semantics.
--   * INSERT into connected_emails: the inserted row's `owner_user_id`
--     MUST equal `auth.uid()` (a user only creates credentials for THEIR
--     own email accounts). The EXISTS-via-junction predicate is FALSE at
--     INSERT time because the junction row doesn't exist yet, so we cannot
--     rely on the general write predicate. We split write policies into
--     two: a permissive owner-write policy (FOR ALL with USING +
--     WITH CHECK owner_user_id = auth.uid()) AND a separate admin-write
--     policy (FOR UPDATE / FOR DELETE only — NOT INSERT — using the
--     EXISTS-via-junction predicate). This gives admins the ability to
--     edit/remediate the credential without giving them the ability to
--     create new credentials owned by other users.
--   * INSERT into connected_email_households: admins of the household may
--     attach an existing credential to their household (the Edge Function
--     POST /emails/bind in T-212 enforces that the caller is also the
--     owner OR the credential is already bound to another household the
--     caller admins — those business rules live in the function, not RLS).
--     RLS here checks only the minimal invariant: caller must be admin of
--     the household being targeted.
--   * service_role bypasses RLS implicitly (BYPASSRLS). We do NOT add
--     explicit service_role policies — they would be dead code. The IMAP
--     worker (§6.4) and Edge Functions always run with service_role and
--     bypass these policies entirely.
--   * `anon` role: every policy below targets `authenticated` only.
--     Anonymous callers (auth.uid() IS NULL) match zero rows by
--     construction in any owner / admin predicate.
--   * sys-admin escape hatch: we add `OR app.is_system_admin()` to SELECT
--     policies (matching the precedent set in T-114 for households/members
--     etc.) so the audit UI `/sys-admin/connected_emails` works without
--     impersonation. Write policies do NOT grant sys admin escalation —
--     destructive operations on credentials must go through service_role
--     under explicit audit (system_admin_grants in T-216).
--   * Idempotency: every policy is created with `DROP POLICY IF EXISTS`
--     before `CREATE POLICY` (the only safe re-runnable pattern; Postgres
--     lacks CREATE POLICY IF NOT EXISTS). ALTER TABLE ... ENABLE RLS is a
--     no-op when RLS is already enabled.
--
-- Rollback:
--   * `ALTER TABLE public.connected_emails DISABLE ROW LEVEL SECURITY;`
--   * `ALTER TABLE public.connected_email_households DISABLE ROW LEVEL SECURITY;`
--   * Then `DROP POLICY IF EXISTS ...` for each of the policies below.
-- ============================================================================


-- ============================================================================
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ============================================================================
--   * DO NOT add explicit policies for service_role — it BYPASSRLS by default.
--   * DO NOT grant anon role any policy on these tables.
--   * DO NOT use `USING (true)` on any write policy — every write MUST be
--     scoped via owner / admin / sys-admin predicate.
--   * DO NOT omit `ceh.deleted_at IS NULL` from the EXISTS-via-junction
--     predicate — a soft-deleted binding must not confer access.
--   * DO NOT grant sys admin write access on these tables via policy.
--     Destructive credential operations must go through service_role with
--     auditable provenance (system_admin_grants, T-216).
-- ============================================================================


-- ============================================================================
-- 1. connected_emails — owner OR admin-of-bound-household
-- ============================================================================
-- SELECT: owner (auth.uid() = owner_user_id) OR admin of at least one
--          bound household (junction EXISTS join, filtered by
--          ceh.deleted_at IS NULL) OR sys admin.
-- INSERT: owner only (the user creating the credential MUST be the owner).
-- UPDATE / DELETE: owner OR admin-of-bound-household. Mirrored WITH CHECK
--                  prevents privilege escalation (e.g. changing
--                  owner_user_id to escape RLS on subsequent reads).
-- ============================================================================
ALTER TABLE public.connected_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connected_emails_select ON public.connected_emails;
CREATE POLICY connected_emails_select ON public.connected_emails
  FOR SELECT
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR app.is_system_admin()
    OR EXISTS (
      SELECT 1
      FROM public.connected_email_households ceh
      WHERE ceh.connected_email_id = connected_emails.id
        AND ceh.deleted_at IS NULL
        AND app.is_household_admin(ceh.household_id)
    )
  );

-- INSERT: only the owner may create the row. The junction does not yet
-- exist at INSERT time, so the EXISTS-via-binding predicate is FALSE for
-- new rows by construction. We therefore restrict INSERT to owner-only.
DROP POLICY IF EXISTS connected_emails_insert ON public.connected_emails;
CREATE POLICY connected_emails_insert ON public.connected_emails
  FOR INSERT
  TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

-- UPDATE: owner OR admin of a bound household may UPDATE. Mirrored WITH CHECK
-- prevents privilege escalation: post-UPDATE state must STILL satisfy the
-- predicate. In particular, an admin cannot change `owner_user_id` to
-- another user (the WITH CHECK is evaluated against NEW; if the admin is
-- not the owner of the new row AND no longer admins a bound household,
-- the UPDATE is rejected).
DROP POLICY IF EXISTS connected_emails_update ON public.connected_emails;
CREATE POLICY connected_emails_update ON public.connected_emails
  FOR UPDATE
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.connected_email_households ceh
      WHERE ceh.connected_email_id = connected_emails.id
        AND ceh.deleted_at IS NULL
        AND app.is_household_admin(ceh.household_id)
    )
  )
  WITH CHECK (
    owner_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.connected_email_households ceh
      WHERE ceh.connected_email_id = connected_emails.id
        AND ceh.deleted_at IS NULL
        AND app.is_household_admin(ceh.household_id)
    )
  );

-- DELETE: owner OR admin of a bound household may DELETE. In practice the
-- application uses soft-delete (UPDATE deleted_at) — hard DELETE is reserved
-- for app.anonymize_user (T-228, service_role). The policy is included for
-- completeness and to preserve symmetry with UPDATE.
DROP POLICY IF EXISTS connected_emails_delete ON public.connected_emails;
CREATE POLICY connected_emails_delete ON public.connected_emails
  FOR DELETE
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.connected_email_households ceh
      WHERE ceh.connected_email_id = connected_emails.id
        AND ceh.deleted_at IS NULL
        AND app.is_household_admin(ceh.household_id)
    )
  );


-- ============================================================================
-- 2. connected_email_households — member-of (SELECT) + admin-of (write)
-- ============================================================================
-- SELECT: any member of the household sees bindings for that household.
--          Plus: sys admin sees all bindings (audit UI). Plus: the owner of
--          the credential always sees its own bindings (even if not a member
--          of the household, which can happen during invitation flows or
--          right after a household admin un-invites the owner but before the
--          binding is removed).
-- INSERT / UPDATE / DELETE: admin of the household (Pattern B). Mirrored
--          WITH CHECK prevents an admin from re-targeting the row to a
--          household they do NOT admin (e.g. changing household_id).
-- ============================================================================
ALTER TABLE public.connected_email_households ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connected_email_households_select
  ON public.connected_email_households;
CREATE POLICY connected_email_households_select
  ON public.connected_email_households
  FOR SELECT
  TO authenticated
  USING (
    household_id IN (SELECT app.households_of_user())
    OR app.is_system_admin()
    OR EXISTS (
      SELECT 1
      FROM public.connected_emails ce
      WHERE ce.id = connected_email_households.connected_email_id
        AND ce.owner_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS connected_email_households_admin_write
  ON public.connected_email_households;
CREATE POLICY connected_email_households_admin_write
  ON public.connected_email_households
  FOR ALL
  TO authenticated
  USING (app.is_household_admin(household_id))
  WITH CHECK (app.is_household_admin(household_id));


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616121000_rls_connected_emails',
  'RLS enabled + full policy set for public.connected_emails (owner OR '
  'admin-of-bound-household, EXISTS join filtered by ceh.deleted_at IS NULL) '
  'and public.connected_email_households (member-of household SELECT, '
  'admin-of household write). INSERT into connected_emails restricted to '
  'owner only (junction does not yet exist at INSERT time). UPDATE / DELETE '
  'mirror USING and WITH CHECK to prevent privilege escalation. Sys admin '
  'gets SELECT-only escape hatch (no write). Uses helpers from T-113. Spec §5.11.'
)
ON CONFLICT (migration_name) DO NOTHING;
