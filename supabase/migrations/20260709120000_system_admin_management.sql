-- Migration: 20260709120000_system_admin_management
-- Task: T-217
-- Purpose: Backend for sys-admin admins management — the atomic last-admin guard
--   (app.record_admin_change), the email->uuid resolver, and the self-gated
--   list of current admins. Consumed by the Edge Function `admin-system-admins`
--   (which owns the GoTrue claim flip) and the mobile /sys-admin/admins page.
--   No new table (reuses public.system_admin_grants, T-216); no write to auth.*.
-- Spec refs: §9.2, §9.4

-- ============================================================================
-- 1. Resolver: email -> user_id (service_role only; keeps the email oracle off
--    the `authenticated` surface). auth.users is not readable by authenticated.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.resolve_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id
  FROM auth.users u
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.resolve_user_id_by_email(text) IS
  'T-217: resolve a login email to its auth.users id. SECURITY DEFINER, '
  'service_role only (email->uuid oracle must not be reachable by authenticated).';

REVOKE ALL ON FUNCTION app.resolve_user_id_by_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.resolve_user_id_by_email(text) TO service_role;

-- ============================================================================
-- 2. Atomic membership mutation + last-admin guard.
--    Serializes all admin membership changes under an advisory xact lock and
--    counts EFFECTIVE membership from the append-only ledger (latest action
--    per user = 'granted'), joined to auth.users to drop deleted/anonymized
--    phantoms. Because the caller (Edge Function) uses ASYMMETRIC ordering —
--    promote flips the claim BEFORE recording 'granted', revoke records
--    'revoked' BEFORE clearing the claim — the ledger's effective count is
--    always <= the real claim count, so guarding ledger_effective >= 1 proves
--    claim_count >= 1 (the system never reaches zero admins).
--    Revoking the last effective admin raises SQLSTATE UB004 (mapped to 409).
-- ============================================================================
CREATE OR REPLACE FUNCTION app.record_admin_change(
  p_target      uuid,
  p_action      text,
  p_actor       uuid,
  p_reason      text,
  p_correlation uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_effective bigint;
  v_latest    text;
BEGIN
  IF p_action NOT IN ('granted', 'revoked') THEN
    RAISE EXCEPTION 'record_admin_change: p_action must be granted|revoked, got %', p_action
      USING ERRCODE = '22023';
  END IF;

  -- Serialize every admin-membership mutation so the count read and the append
  -- can never interleave (closes the last-admin TOCTOU). Released on commit.
  PERFORM pg_advisory_xact_lock(hashtext('unibill:sysadmin_membership')::bigint);

  -- Effective admins = distinct real users whose latest ledger action is
  -- 'granted'. The auth.users join drops phantom rows (deleted/anonymized).
  SELECT count(*)
  INTO v_effective
  FROM (
    SELECT DISTINCT ON (g.user_id) g.user_id, g.action
    FROM public.system_admin_grants g
    ORDER BY g.user_id, g.granted_at DESC
  ) latest
  JOIN auth.users u ON u.id = latest.user_id
  WHERE latest.action = 'granted';

  -- Target's current effective state per the ledger.
  SELECT g.action
  INTO v_latest
  FROM public.system_admin_grants g
  WHERE g.user_id = p_target
  ORDER BY g.granted_at DESC
  LIMIT 1;

  IF p_action = 'revoked' THEN
    IF v_latest IS DISTINCT FROM 'granted' THEN
      -- Not currently granted per the ledger — idempotent no-op (the caller
      -- still reconciles the claim to false afterward).
      RETURN jsonb_build_object(
        'changed', false, 'note', 'already_revoked', 'effective_count', v_effective
      );
    END IF;
    IF v_effective <= 1 THEN
      RAISE EXCEPTION 'cannot revoke the last system admin'
        USING ERRCODE = 'UB004';
    END IF;
    INSERT INTO public.system_admin_grants (user_id, action, granted_by, reason, correlation_id)
    VALUES (p_target, 'revoked', p_actor, p_reason, p_correlation);
    RETURN jsonb_build_object('changed', true, 'effective_count', v_effective - 1);
  ELSE
    -- granted
    IF v_latest = 'granted' THEN
      RETURN jsonb_build_object(
        'changed', false, 'note', 'already_granted', 'effective_count', v_effective
      );
    END IF;
    INSERT INTO public.system_admin_grants (user_id, action, granted_by, reason, correlation_id)
    VALUES (p_target, 'granted', p_actor, p_reason, p_correlation);
    RETURN jsonb_build_object('changed', true, 'effective_count', v_effective + 1);
  END IF;
END;
$$;

COMMENT ON FUNCTION app.record_admin_change(uuid, text, uuid, text, uuid) IS
  'T-217: atomic admin-membership ledger write with the last-admin guard '
  '(advisory-locked ledger-effective count; raises SQLSTATE UB004 on the last '
  'admin). SECURITY DEFINER, service_role only. Returns {changed, effective_count}.';

REVOKE ALL ON FUNCTION app.record_admin_change(uuid, text, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.record_admin_change(uuid, text, uuid, text, uuid)
  TO service_role;

-- ============================================================================
-- 3. List current system admins (self-gated read for the mobile page).
--    Source of truth for membership is the claim; the ledger only supplies the
--    granted-at timestamp. Self-gates on the CALLER's is_system_admin claim
--    (read from auth.jwt(), correct even inside SECURITY DEFINER) so a
--    non-admin gets 42501 -> PostgREST 403 and never sees any email.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.list_system_admins()
RETURNS TABLE (user_id uuid, email text, granted_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.is_system_admin() THEN
    RAISE EXCEPTION 'system_admin required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::text,
    (
      SELECT g.granted_at
      FROM public.system_admin_grants g
      WHERE g.user_id = u.id AND g.action = 'granted'
      ORDER BY g.granted_at DESC
      LIMIT 1
    )
  FROM auth.users u
  WHERE (u.raw_app_meta_data ->> 'is_system_admin') = 'true'
  ORDER BY u.email;
END;
$$;

COMMENT ON FUNCTION app.list_system_admins() IS
  'T-217: list current system admins (user_id, email, granted_at) for the '
  'sys-admin admins page. SECURITY DEFINER but self-gates on the caller''s '
  'is_system_admin claim; a non-admin gets 42501. auth.users is otherwise '
  'unreadable by authenticated.';

REVOKE ALL ON FUNCTION app.list_system_admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_system_admins() TO authenticated, service_role;

-- ============================================================================
-- 4. Migration registry
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260709120000_system_admin_management',
  'T-217 sys-admin management: app.resolve_user_id_by_email + app.record_admin_change '
  '(advisory-locked ledger-count last-admin guard, SQLSTATE UB004) + '
  'app.list_system_admins (self-gated). Consumed by Edge Function admin-system-admins. '
  'No new table; no auth.users write.'
)
ON CONFLICT (migration_name) DO NOTHING;
