-- ============================================================================
-- Migration: 20260615120700_create_app_helpers.sql
-- Date:      2026-06-10
-- Task:      T-113
-- Purpose:   Create the three core RLS helper functions in schema `app` used
--            by every row-level security policy across the Unibill data model:
--              * app.households_of_user()  — returns the set of household_id
--                the caller belongs to (active membership only).
--              * app.is_household_admin(h) — returns true iff caller is an
--                active admin of household `h`.
--              * app.is_system_admin()    — returns true iff caller's JWT
--                `app_metadata.is_system_admin` claim is the string `'true'`.
--                Uses defensive NULLIF/coalesce so an absent / empty / NULL
--                claim coerces to `false` rather than raising.
-- Spec refs: §5.11 (RLS — resumo de policies). The spec is explicit that all
--            helpers MUST live in schema `app` (not `auth`, which is owned by
--            GoTrue) — see the tech-5 finding referenced in §5.11.
--
-- Design notes:
--   * The first two helpers are STABLE SECURITY DEFINER so they can read
--     `public.members` even while called from a policy whose `current_user`
--     would otherwise be subject to that same table's RLS — defining-owner
--     bypass is the canonical pattern (Supabase RLS guide). `search_path` is
--     locked to `public, pg_temp` to prevent search-path hijacking attacks
--     (see CVE-2018-1058 class).
--   * `app.is_system_admin()` does NOT need SECURITY DEFINER: it only reads
--     `auth.jwt()`, which is a built-in stable function available to every
--     role. Keeping it INVOKER avoids unnecessary privilege escalation.
--   * All three are marked STABLE (not VOLATILE) so the planner can inline /
--     memoize them inside policy expressions evaluated per-row.
--   * `auth.uid()` returns NULL for unauthenticated / service_role callers;
--     `app.households_of_user()` will simply return an empty set, which is
--     the desired behaviour for anon (RLS denies by default) and harmless for
--     service_role (which bypasses RLS entirely).
--   * The defensive coercion in `app.is_system_admin()` handles three failure
--     modes uniformly: (a) no `app_metadata` object, (b) no `is_system_admin`
--     key, (c) key present but empty string. All three become `false`.
--   * GRANT EXECUTE is given to `authenticated` only — anon should never need
--     these (no policy ever references them for anon), and service_role
--     already bypasses RLS so calls are short-circuited there.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ----------------------------------------------------------------------------
--   * DO NOT create these helpers in schema `auth` — GoTrue owns it.
--   * DO NOT remove `SET search_path = public, pg_temp` from a SECURITY
--     DEFINER function — opens a search-path hijack vector.
--   * DO NOT change `auth.uid()` inside helpers to a parameter — every policy
--     in the spec assumes the helper reads the current JWT.
--   * DO NOT mark these VOLATILE — destroys planner caching inside policies.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. app.households_of_user() — SETOF uuid
-- ============================================================================
-- Returns the household_ids the *current* caller (auth.uid()) is an active
-- member of. Used by every "member-of household" RLS policy (Pattern A in
-- §5.11). Returns the empty set when the caller is anon / has no memberships.
CREATE OR REPLACE FUNCTION app.households_of_user()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT household_id
  FROM public.members
  WHERE user_id = auth.uid()
    AND deleted_at IS NULL;
$$;

COMMENT ON FUNCTION app.households_of_user() IS
  'Retorna SETOF uuid com os household_id que o caller (auth.uid()) participa '
  'ativamente (deleted_at IS NULL). SECURITY DEFINER + search_path locked. '
  'Base de todas as RLS policies de "member-of household" — ver spec §5.11.';

REVOKE ALL ON FUNCTION app.households_of_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.households_of_user() TO authenticated;


-- ============================================================================
-- 2. app.is_household_admin(uuid) — boolean
-- ============================================================================
-- Returns true iff the current caller (auth.uid()) is an active admin of the
-- household `h`. Used by every "admin-of household" RLS policy (Pattern B in
-- §5.11). Returns false (not NULL) when no row matches.
CREATE OR REPLACE FUNCTION app.is_household_admin(h uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.members
    WHERE household_id = h
      AND user_id = auth.uid()
      AND role = 'admin'
      AND deleted_at IS NULL
  );
$$;

COMMENT ON FUNCTION app.is_household_admin(uuid) IS
  'Retorna true iff o caller (auth.uid()) é admin ativo do household `h`. '
  'SECURITY DEFINER + search_path locked. Base de todas as RLS policies de '
  '"admin-of household" — ver spec §5.11.';

REVOKE ALL ON FUNCTION app.is_household_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_household_admin(uuid) TO authenticated;


-- ============================================================================
-- 3. app.is_system_admin() — boolean
-- ============================================================================
-- Reads `auth.jwt() -> 'app_metadata' ->> 'is_system_admin'` and coerces
-- defensively to boolean. Returns false when the claim is missing, NULL, or
-- the empty string (avoids "invalid input syntax for type boolean: """ on
-- empty claims). Does NOT need SECURITY DEFINER — `auth.jwt()` is a built-in
-- callable by every role.
CREATE OR REPLACE FUNCTION app.is_system_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- Defensive coercion:
  --   * If `app_metadata` key absent -> `->>` returns NULL -> coalesce -> false
  --   * If key present but empty string -> NULLIF turns it into NULL -> false
  --   * If key is the literal string 'true' -> cast to boolean true
  --   * If key is any other non-empty string -> cast may error; we trust GoTrue
  --     to only ever write 'true'/'false' here (bootstrap script T-117).
  SELECT coalesce(
    NULLIF(auth.jwt() -> 'app_metadata' ->> 'is_system_admin', '')::boolean,
    false
  );
$$;

COMMENT ON FUNCTION app.is_system_admin() IS
  'Retorna true iff o JWT do caller tem app_metadata.is_system_admin = "true". '
  'Coerção defensiva NULLIF + coalesce: claim ausente / NULL / empty string '
  'retornam false (não raise). Ver spec §5.11 e bootstrap script T-117.';

REVOKE ALL ON FUNCTION app.is_system_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_system_admin() TO authenticated;


-- ============================================================================
-- 4. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120700_create_app_helpers',
  'RLS helpers: app.households_of_user(), app.is_household_admin(uuid), '
  'app.is_system_admin() — base para todas as policies do spec §5.11.'
)
ON CONFLICT (migration_name) DO NOTHING;
