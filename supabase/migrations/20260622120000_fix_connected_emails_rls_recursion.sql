-- ============================================================================
-- Migration: 20260622120000_fix_connected_emails_rls_recursion.sql
-- Date:      2026-06-22
-- Task:      T-210 (corrective — fixes the RLS infinite recursion introduced by
--            20260616121000_rls_connected_emails.sql; tracked in #213)
-- Spec refs: §5.11 (RLS — connected_emails + connected_email_households; helpers
--            in schema app), §5.2 (soft-delete deleted_at gate), §5.10 (owner
--            path vs admin-of-binding path).
-- Purpose:   Eliminate the MUTUAL INFINITE RECURSION between the RLS policies of
--            the two "connected email" tables, discovered when the pgTAP suite
--            (tests/rls/connected_emails.test.sql + connected_email_households
--            .test.sql) was first run end-to-end:
--
--              connected_emails_{select,update,delete}.USING/WITH CHECK
--                contains  EXISTS (SELECT … FROM connected_email_households …)
--                → reading the junction fires the junction's RLS
--
--              connected_email_households_select.USING
--                contains  EXISTS (SELECT … FROM connected_emails …)
--                → reading connected_emails fires its RLS
--
--            → A reads B reads A reads B … → Postgres raises
--              `infinite recursion detected in policy for relation
--               "connected_emails"` (data-independent — fires at plan time, so
--              ANY authenticated direct query on either table errors).
--
--            The bug is LATENT in production today because every code path that
--            touches these tables runs as `service_role` (BYPASSRLS) — Edge
--            Functions and the IMAP worker. But ANY authenticated client query
--            (e.g. the mobile app reading `connected_emails` directly, or the
--            sys-admin audit UI) hits the recursion and fails hard.
--
--            FIX (canonical Supabase pattern for cross-table RLS cycles):
--            move each cross-table EXISTS into a `SECURITY DEFINER` helper in
--            schema `app`. A SECURITY DEFINER function runs as its owner
--            (`postgres`, which BYPASSRLS), so the inner read of the sibling
--            table does NOT re-enter that table's RLS → the cycle is broken.
--            The predicate logic is otherwise IDENTICAL to the inline EXISTS,
--            so authorization semantics are unchanged — this is a pure
--            de-recursion, not a policy redesign.
--
--              * app.is_admin_of_connected_email(uuid)  — replaces the inline
--                  EXISTS-on-junction in the connected_emails policies. Returns
--                  true iff the caller admins at least one household with an
--                  ACTIVE (deleted_at IS NULL) binding to the credential.
--              * app.is_owner_of_connected_email(uuid)  — replaces the inline
--                  EXISTS-on-connected_emails in the junction SELECT policy.
--                  Returns true iff the caller owns the credential.
--
--            Both mirror the established helpers in 20260615120700 (T-113):
--            STABLE, SECURITY DEFINER, `search_path` locked, EXECUTE granted to
--            `authenticated` only.
--
-- Design notes:
--   * Why SECURITY DEFINER breaks the cycle: Postgres' recursion guard tracks
--     the stack of relations whose RLS is being expanded. An inline subquery on
--     a sibling RLS'd table re-enters that table's policy expansion → cycle. A
--     function call is OPAQUE to policy expansion; the sibling read happens at
--     EXECUTION time, inside the definer's (postgres) security context, which
--     bypasses RLS entirely. Same reason app.is_household_admin() can read the
--     RLS'd `public.members` from inside a members policy without recursing.
--   * Semantics are PRESERVED, not changed: the helper bodies carry the exact
--     same filters the inline EXISTS carried (deleted_at IS NULL +
--     app.is_household_admin for the admin path; owner_user_id = auth.uid() for
--     the owner path). Bypassing the sibling's RLS inside the definer does not
--     widen access because the helper re-applies those filters explicitly — the
--     sibling RLS was never what enforced them.
--   * auth.uid() still resolves correctly inside a SECURITY DEFINER function:
--     it reads the `request.jwt.claims` GUC (session-scoped), which is
--     unaffected by the role switch that SECURITY DEFINER performs.
--   * Only the recursing policies are replaced. Untouched (no cross-table
--     EXISTS, no recursion):
--       - connected_emails_insert         (WITH CHECK owner_user_id=auth.uid())
--       - connected_email_households_admin_write (app.is_household_admin only)
--   * The sys-admin escape hatch (`OR app.is_system_admin()`) stays on SELECT
--     only, exactly as the original — write policies grant no sys-admin path.
--
-- Rollback:
--   Re-apply 20260616121000_rls_connected_emails.sql (restores the inline
--   EXISTS policies — which reintroduces the recursion), then:
--     DROP FUNCTION IF EXISTS app.is_admin_of_connected_email(uuid);
--     DROP FUNCTION IF EXISTS app.is_owner_of_connected_email(uuid);
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ----------------------------------------------------------------------------
--   * DO NOT re-introduce an inline EXISTS on the sibling RLS'd table in any of
--     these policies — that is exactly what caused the recursion. Always go
--     through the SECURITY DEFINER helper.
--   * DO NOT drop `SET search_path` from the helpers — search-path hijack vector
--     on a SECURITY DEFINER function (CVE-2018-1058 class).
--   * DO NOT omit `ceh.deleted_at IS NULL` from app.is_admin_of_connected_email
--     — a soft-deleted binding must not confer admin access (spec §5.2).
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. app.is_admin_of_connected_email(uuid) — admin-of-bound-household path
-- ============================================================================
-- Replaces the inline EXISTS-on-junction used by the connected_emails policies.
-- Returns true iff auth.uid() is an active admin of at least one household that
-- has an ACTIVE binding to the credential `p_connected_email_id`.
CREATE OR REPLACE FUNCTION app.is_admin_of_connected_email(p_connected_email_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.connected_email_households ceh
    WHERE ceh.connected_email_id = p_connected_email_id
      AND ceh.deleted_at IS NULL
      AND app.is_household_admin(ceh.household_id)
  );
$$;

COMMENT ON FUNCTION app.is_admin_of_connected_email(uuid) IS
  'Retorna true iff o caller (auth.uid()) é admin ativo de ALGUM household com '
  'binding ATIVO (deleted_at IS NULL) à credencial. SECURITY DEFINER + '
  'search_path locked — encapsula o EXISTS-na-junção das policies de '
  'connected_emails p/ quebrar a recursão mútua de RLS (ver migration header).';

REVOKE ALL ON FUNCTION app.is_admin_of_connected_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_admin_of_connected_email(uuid) TO authenticated;


-- ============================================================================
-- 2. app.is_owner_of_connected_email(uuid) — owner-of-credential path
-- ============================================================================
-- Replaces the inline EXISTS-on-connected_emails used by the junction SELECT
-- policy. Returns true iff auth.uid() owns the credential
-- `p_connected_email_id`.
CREATE OR REPLACE FUNCTION app.is_owner_of_connected_email(p_connected_email_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- NB: intentionally NO `ce.deleted_at IS NULL` filter — this mirrors the
  -- original junction SELECT policy's owner branch verbatim. The owner must
  -- retain visibility/audit of their credential's bindings regardless of the
  -- credential's own soft-delete state (asserted by connected_email_households
  -- test #1/#3). Do NOT "helpfully" add a deleted_at guard here.
  SELECT EXISTS (
    SELECT 1
    FROM public.connected_emails ce
    WHERE ce.id = p_connected_email_id
      AND ce.owner_user_id = auth.uid()
  );
$$;

COMMENT ON FUNCTION app.is_owner_of_connected_email(uuid) IS
  'Retorna true iff o caller (auth.uid()) é o owner_user_id da credencial. '
  'SECURITY DEFINER + search_path locked — encapsula o EXISTS-em-connected_'
  'emails da policy SELECT da junção p/ quebrar a recursão mútua de RLS.';

REVOKE ALL ON FUNCTION app.is_owner_of_connected_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_owner_of_connected_email(uuid) TO authenticated;


-- ============================================================================
-- 3. connected_emails — replace the 3 recursing policies (SELECT/UPDATE/DELETE)
-- ============================================================================
-- Each one swaps the inline EXISTS-on-junction for
-- app.is_admin_of_connected_email(connected_emails.id). The owner direct check
-- and the SELECT-only sys-admin hatch are preserved verbatim. INSERT is
-- untouched (no cross-table EXISTS).

DROP POLICY IF EXISTS connected_emails_select ON public.connected_emails;
CREATE POLICY connected_emails_select ON public.connected_emails
  FOR SELECT
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR app.is_system_admin()
    OR app.is_admin_of_connected_email(connected_emails.id)
  );

DROP POLICY IF EXISTS connected_emails_update ON public.connected_emails;
CREATE POLICY connected_emails_update ON public.connected_emails
  FOR UPDATE
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR app.is_admin_of_connected_email(connected_emails.id)
  )
  WITH CHECK (
    owner_user_id = auth.uid()
    OR app.is_admin_of_connected_email(connected_emails.id)
  );

DROP POLICY IF EXISTS connected_emails_delete ON public.connected_emails;
CREATE POLICY connected_emails_delete ON public.connected_emails
  FOR DELETE
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR app.is_admin_of_connected_email(connected_emails.id)
  );


-- ============================================================================
-- 4. connected_email_households — replace the recursing SELECT policy
-- ============================================================================
-- Swaps the inline EXISTS-on-connected_emails for
-- app.is_owner_of_connected_email(connected_email_households.connected_email_id).
-- The member-of and sys-admin paths are preserved verbatim. The admin_write
-- policy (app.is_household_admin only) is untouched (no recursion).

DROP POLICY IF EXISTS connected_email_households_select
  ON public.connected_email_households;
CREATE POLICY connected_email_households_select
  ON public.connected_email_households
  FOR SELECT
  TO authenticated
  USING (
    household_id IN (SELECT app.households_of_user())
    OR app.is_system_admin()
    OR app.is_owner_of_connected_email(connected_email_households.connected_email_id)
  );


-- ============================================================================
-- 5. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260622120000_fix_connected_emails_rls_recursion',
  'Corrige recursão infinita mútua de RLS entre connected_emails e '
  'connected_email_households movendo os EXISTS cruzados p/ helpers '
  'SECURITY DEFINER (app.is_admin_of_connected_email / '
  'app.is_owner_of_connected_email). Semântica preservada.'
)
ON CONFLICT (migration_name) DO NOTHING;
