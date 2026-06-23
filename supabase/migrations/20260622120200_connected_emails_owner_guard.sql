-- ============================================================================
-- Migration: 20260622120200_connected_emails_owner_guard.sql
-- Date:      2026-06-22
-- Task:      T-210 (corrective — close the owner_user_id privilege-escalation
--            gap left open by the RLS-only design; tracked in #213)
-- Purpose:   Prevent an ADMIN of a bound household from HIJACKING ownership of a
--            connected_email credential by changing `owner_user_id`.
--
--            THE GAP: the connected_emails UPDATE policy is (per spec §5.11
--            matrix) "owner OR admin-of-bound-household", with a MIRRORED
--            WITH CHECK. The author intended the mirror to "prevent changing
--            owner_user_id to escape RLS", but it does NOT: an admin of an
--            ACTIVE binding satisfies the predicate REGARDLESS of owner_user_id
--            (the admin path reads the junction, not the owner column). So an
--            admin can `UPDATE connected_emails SET owner_user_id = <themselves
--            or anyone>` and the WITH CHECK still passes (they still admin a
--            bound household) → silent ownership takeover, then they can unbind
--            and become the sole owner of a credential they never owned.
--            RLS alone cannot express "any role may UPDATE the row BUT only the
--            owner may change THIS column" — that needs a column-targeted
--            trigger. Spec §5.10 is explicit: owner_user_id is the real owner;
--            admins may remediate `last_error`/`status` but credential
--            ownership/destruction is the owner's prerogative.
--
--            Surfaced by tests/rls/connected_emails.test.sql scenario #9, which
--            asserts an admin's owner_user_id retarget is rejected (42501) — an
--            assertion the RLS policy could never satisfy on its own.
--
--            FIX: a BEFORE UPDATE OF owner_user_id trigger that rejects the
--            change unless the caller IS the current owner. service_role /
--            pg_cron / postgres (auth.uid() IS NULL) are exempt — they perform
--            legitimate ownership reorganization (e.g. app.anonymize_user, admin
--            tooling) and are trusted. anon never reaches the table (no grant).
--
-- Spec refs: §5.10 (ownership distinction — owner controls the credential;
--                    admins remediate operational fields only),
--            §5.11 (connected_emails RLS matrix — UPDATE = owner OR admin).
--
-- Design notes:
--   * `BEFORE UPDATE OF owner_user_id` narrows firing to statements that target
--     the column; the body re-checks IS DISTINCT so a no-op write (set to same
--     value) never raises.
--   * SECURITY INVOKER: the function only reads auth.uid() (GUC-backed, callable
--     by every role) and compares OLD/NEW — no table access, no need for definer
--     privileges. Keeping it INVOKER avoids gratuitous escalation.
--   * The owner themselves MAY still transfer ownership (auth.uid() =
--     OLD.owner_user_id) — owner-initiated transfer is allowed by §5.10; only
--     NON-owner authenticated callers are blocked.
--   * ERRCODE 42501 (insufficient_privilege) mirrors how RLS WITH CHECK
--     violations surface, so callers handle credential-write denials uniformly.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_guard_connected_email_owner_change
--     ON public.connected_emails;
--   DROP FUNCTION IF EXISTS app.guard_connected_email_owner_change();
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by review)
-- ----------------------------------------------------------------------------
--   * DO NOT exempt the `authenticated` role wholesale — that reopens the
--     takeover. The ONLY authenticated caller allowed to change owner_user_id
--     is the current owner (auth.uid() = OLD.owner_user_id).
--   * DO NOT widen this to a blanket BEFORE UPDATE — it must stay column-scoped
--     so ordinary remediation writes (last_error/status) by admins still work.
-- ----------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION app.guard_connected_email_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Block owner_user_id changes by anyone other than the current owner.
  -- auth.uid() IS NULL ⇒ service_role / pg_cron / postgres ⇒ trusted, exempt.
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     AND auth.uid() IS NOT NULL
     AND auth.uid() IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION
      'only the credential owner may change connected_emails.owner_user_id '
      '(spec §5.10); admins of bound households may remediate operational '
      'fields but not take over ownership'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.guard_connected_email_owner_change() IS
  'Trigger fn (T-210 corrective): rejeita mudança de connected_emails.owner_'
  'user_id por quem não é o owner atual (auth.uid() <> OLD.owner_user_id). '
  'service_role/pg_cron/postgres (auth.uid() NULL) isentos. Fecha escalada de '
  'privilégio que a RLS sozinha não cobre (§5.10). Ver #213.';

DROP TRIGGER IF EXISTS trg_guard_connected_email_owner_change
  ON public.connected_emails;
CREATE TRIGGER trg_guard_connected_email_owner_change
  BEFORE UPDATE OF owner_user_id ON public.connected_emails
  FOR EACH ROW
  EXECUTE FUNCTION app.guard_connected_email_owner_change();


-- ============================================================================
-- Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260622120200_connected_emails_owner_guard',
  'Trigger BEFORE UPDATE OF owner_user_id em connected_emails: só o owner atual '
  'pode mudar owner_user_id (service_role isento). Fecha escalada de '
  'privilégio (admin de binding tomava posse) — §5.10, #213.'
)
ON CONFLICT (migration_name) DO NOTHING;
