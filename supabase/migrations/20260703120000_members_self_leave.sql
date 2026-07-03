-- ============================================================================
-- Migration: 20260703120000_members_self_leave.sql
-- Date:      2026-07-03
-- Task:      T-523 (#279) — backend self-leave enablement for the mobile leave
--            flow; leaveHousehold was a silent no-op for non-admin members.
-- Purpose:   Let a member leave a household on their own.
--
--            Until now the only write policy on public.members was
--            members_admin_write (admin-of-household, FOR ALL). A non-admin
--            member soft-deleting their OWN membership matched ZERO rows under
--            RLS, so PostgREST reported success while the row was untouched —
--            the mobile leaveHousehold() believed the leave worked when it did
--            not.
--
--            This adds two pieces:
--              1. RLS policy `members_self_leave` (FOR UPDATE, own row) so a
--                 member can update their own membership row; and
--              2. the `app.members_restrict_self_update()` BEFORE UPDATE trigger
--                 that limits a NON-admin self-update to the `deleted_at` column
--                 only. Without it, a self-update policy would also let a member
--                 set `role = 'admin'` on their own row (privilege escalation).
--                 Admins keep full write via members_admin_write
--                 (`app.is_household_admin` is true → the guard is skipped).
--
--            The existing `trg_min_one_admin` trigger still guards the last
--            admin (it already covers the soft-delete path), so a sole admin
--            cannot leave.
-- Spec refs: §5.1 (members + member_role), §5.11 (RLS patterns).
-- ============================================================================


-- ============================================================================
-- 1. RLS: a member may UPDATE their own membership row (self-leave).
-- ============================================================================
DROP POLICY IF EXISTS members_self_leave ON public.members;
CREATE POLICY members_self_leave ON public.members
  FOR UPDATE
  TO authenticated
  -- `deleted_at IS NULL` makes this path own its own invariant: only an ACTIVE
  -- membership is updatable, so leaving is one-directional (a member cannot
  -- clear their own deleted_at to self-re-admit — a former admin re-adding
  -- themselves AS admin would be privilege re-escalation). Without it, that
  -- safety would depend incidentally on members_select only ever exposing
  -- active rows — fragile if that policy is later broadened.
  USING (user_id = auth.uid() AND deleted_at IS NULL)
  WITH CHECK (user_id = auth.uid());

COMMENT ON POLICY members_self_leave ON public.members IS
  'Permite um membro atualizar a PRÓPRIA membership ATIVA (self-leave via '
  'deleted_at) — só ativa (deleted_at IS NULL) é atualizável, então sair é '
  'irreversível por este path. O trigger trg_members_restrict_self_update '
  'restringe um não-admin a alterar apenas deleted_at; admins escrevem via '
  'members_admin_write. Issue #279.';


-- ============================================================================
-- 2. Column guard: a non-admin self-update may change deleted_at only.
-- ============================================================================
-- Runs for every UPDATE. Admins of the household (members_admin_write) edit
-- freely; only a non-admin reaching their own row via members_self_leave is
-- restricted to soft-leaving. Anything else on that path is escalation.
CREATE OR REPLACE FUNCTION app.members_restrict_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Only constrain a genuine authenticated caller reaching their own row via
  -- members_self_leave. A NULL auth.uid() means postgres / service_role / admin
  -- tooling (migrations, Edge Functions, the enforce_min_one_admin path) — those
  -- are trusted and RLS does not apply to them, so the guard must stay out.
  IF auth.uid() IS NOT NULL AND NOT app.is_household_admin(OLD.household_id) THEN
    -- Allowlist: on the self-leave path only `deleted_at` may change (updated_at
    -- is set by trg_members_set_updated_at). Any other column — role above all,
    -- but also id / household_id / user_id / invited_by / joined_at / created_at
    -- — is rejected, so a member can leave but cannot escalate or rewrite their
    -- membership.
    IF NEW.id           IS DISTINCT FROM OLD.id
       OR NEW.household_id IS DISTINCT FROM OLD.household_id
       OR NEW.user_id      IS DISTINCT FROM OLD.user_id
       OR NEW.role         IS DISTINCT FROM OLD.role
       OR NEW.invited_by   IS DISTINCT FROM OLD.invited_by
       OR NEW.joined_at    IS DISTINCT FROM OLD.joined_at
       OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION
        'members: a non-admin may only set deleted_at on their own membership (self-leave)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.members_restrict_self_update() IS
  'BEFORE UPDATE guard: um não-admin (self-leave) só pode alterar deleted_at na '
  'própria membership — bloqueia escalada de role. Admins passam livres. #279.';

DROP TRIGGER IF EXISTS trg_members_restrict_self_update ON public.members;
CREATE TRIGGER trg_members_restrict_self_update
  BEFORE UPDATE ON public.members
  FOR EACH ROW
  EXECUTE FUNCTION app.members_restrict_self_update();
