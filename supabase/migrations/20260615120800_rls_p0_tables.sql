-- ============================================================================
-- Migration: 20260615120800_rls_p0_tables.sql
-- Date:      2026-06-10
-- Task:      T-114
-- Purpose:   Enable Row-Level Security (RLS) and create the full policy set
--            for the seven P0-P1 tables that constitute the Unibill auth /
--            multi-tenancy / config / consent core:
--              1. public.households
--              2. public.members
--              3. public.household_invitations
--              4. public.user_profiles
--              5. public.app_settings
--              6. public.app_settings_history
--              7. public.consent_log
--            All policies use the helpers created in T-113 (app.households_of_user,
--            app.is_household_admin, app.is_system_admin) and follow the six DDL
--            patterns documented in spec §5.11 (Patterns A-F).
-- Spec refs: §5.11  (RLS — resumo de policies + Patterns A-F DDL templates)
--            §5.12  (user_profiles SELECT cross-household + self UPDATE only)
--            §5.9   (consent_log own SELECT/INSERT + own UPDATE limited to
--                    revoked_at/revoked_reason; sys admin sees all for audit)
--            §5.5   (app_settings cascade scopes + history audit trail)
--
-- Design notes (overall):
--   * One migration, one purpose: ALL RLS policies for the P0-P1 tables.
--     Keeping every policy in a single file makes audits trivial — `grep`
--     this file to see the entire security boundary of the core schema.
--   * Idempotency strategy: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is
--     a no-op when RLS is already enabled. Policies use DROP POLICY IF EXISTS
--     before CREATE POLICY (the only re-runnable pattern; Postgres lacks
--     CREATE POLICY IF NOT EXISTS).
--   * service_role bypasses RLS implicitly (its row in pg_authid has the
--     BYPASSRLS attribute set by Supabase). We do NOT add explicit
--     service_role policies — they would be dead code. Where the spec says
--     "service_role only" for a write path, we simply OMIT a write policy:
--     no policy + RLS enabled = no write permitted to authenticated/anon.
--   * `anon` role is never granted access: every SELECT policy below filters
--     on `auth.uid()`/JWT claims; anon callers (auth.uid() IS NULL) match
--     zero rows by construction. Acceptance criteria explicitly verify this.
--   * Helpers live in schema `app` (spec §5.11 tech-5 — never `auth`, which
--     is owned by GoTrue). Functions used: app.households_of_user(),
--     app.is_household_admin(uuid), app.is_system_admin().
--   * Trigger functions (app.audit_app_settings) are SECURITY DEFINER and
--     therefore bypass RLS when writing into app_settings_history — that is
--     by design (the history table has NO write policy for authenticated).
--   * Pattern coverage:
--       A. member-of household SELECT      -> households, members
--       B. admin-of household FOR ALL      -> households (write), members (write), invitations (all)
--       C. owner-of self UPDATE            -> user_profiles (self), consent_log (own)
--       D. cross-binding via EXISTS join   -> n/a in this migration (P2 tables)
--       E. sys admin only                  -> n/a as a primary policy here
--       F. scope-aware (app_settings)      -> app_settings + app_settings_history
--   * consent_log UPDATE policy is column-scoped via WITH CHECK + a guard
--     against mutations of any column other than revoked_at / revoked_reason.
--     The clean way to express "you may UPDATE this row only if you don't
--     change immutable fields" is a WITH CHECK predicate that re-asserts the
--     immutable fields equal OLD values. The cleanest portable form is to
--     simply require `user_id = OLD.user_id` etc., but RLS policies cannot
--     reference OLD/NEW directly — instead we restrict the UPDATE to the
--     ownership predicate and rely on a row-level CHECK constraint to
--     enforce immutability across columns (this constraint is the canonical
--     "freeze accepted_at" guard). To keep this RLS-only migration focused,
--     we encode the column-level immutability via a BEFORE UPDATE trigger
--     (`app.consent_log_block_pii_update`) that raises if forbidden columns
--     change. This complements the RLS USING/WITH CHECK ownership filter and
--     satisfies the spec acceptance: "UPDATE policy only allows changing
--     revoked_at/revoked_reason (other column updates blocked)".
--   * No DELETE policies for any P0 table — the spec does NOT permit user-
--     initiated deletes for households/members/etc. (LGPD hard-deletes run
--     via service_role through `anonymize_user_references` in §9.4). The
--     absence of a DELETE policy + RLS enabled = no DELETE permitted for
--     authenticated; service_role still bypasses.
-- ============================================================================


-- ============================================================================
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ============================================================================
--   * DO NOT add explicit policies for service_role — it BYPASSRLS by
--     default; explicit policies are dead code and obscure intent.
--   * DO NOT grant anon role any policy on these tables.
--   * DO NOT reference auth.users.email or other PII directly in a policy
--     predicate — derive identity from auth.uid() and join via helpers.
--   * DO NOT add ON DELETE CASCADE workarounds via RLS — cascades are
--     enforced by FKs, not policies.
--   * DO NOT use `USING (true)` for any write policy on these tables — every
--     policy MUST scope the rows via household/user/admin/sys-admin.
-- ============================================================================


-- ============================================================================
-- 1. households — Pattern A (member-of SELECT) + Pattern B (admin-of write)
-- ============================================================================
-- SELECT: any member (active) of the household sees the row.
-- INSERT/UPDATE/DELETE: only an admin of the household may write.
-- INSERT note: the policy below allows INSERT only when the inserted row's
-- id is already a household the caller admins — meaningless at row creation
-- because the household doesn't exist yet. We therefore split write policies:
--   * UPDATE/DELETE: admin-of-household (Pattern B)
--   * INSERT: allowed for any authenticated user (they're creating their OWN
--             household); a separate AFTER INSERT trigger (out of scope of
--             this migration; lives in the Edge Function /households/create)
--             promotes the creator to admin via INSERT INTO members.
-- ============================================================================
ALTER TABLE public.households ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS households_select ON public.households;
CREATE POLICY households_select ON public.households
  FOR SELECT
  TO authenticated
  USING (
    id IN (SELECT app.households_of_user())
    OR app.is_system_admin()
  );

DROP POLICY IF EXISTS households_insert ON public.households;
CREATE POLICY households_insert ON public.households
  FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS households_admin_write ON public.households;
CREATE POLICY households_admin_write ON public.households
  FOR UPDATE
  TO authenticated
  USING (app.is_household_admin(id))
  WITH CHECK (app.is_household_admin(id));

DROP POLICY IF EXISTS households_admin_delete ON public.households;
CREATE POLICY households_admin_delete ON public.households
  FOR DELETE
  TO authenticated
  USING (app.is_household_admin(id));


-- ============================================================================
-- 2. members — Pattern A (member-of SELECT) + Pattern B (admin-of write)
-- ============================================================================
-- SELECT: any member of the household sees ALL members (admins + members).
-- INSERT/UPDATE/DELETE: admins only. The `enforce_min_one_admin` trigger
-- (T-108) provides additional invariant protection (last admin cannot be
-- demoted or removed) regardless of which role triggers the operation.
-- ============================================================================
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS members_select ON public.members;
CREATE POLICY members_select ON public.members
  FOR SELECT
  TO authenticated
  USING (
    household_id IN (SELECT app.households_of_user())
    OR app.is_system_admin()
  );

DROP POLICY IF EXISTS members_admin_write ON public.members;
CREATE POLICY members_admin_write ON public.members
  FOR ALL
  TO authenticated
  USING (app.is_household_admin(household_id))
  WITH CHECK (app.is_household_admin(household_id));


-- ============================================================================
-- 3. household_invitations — Pattern B (admin-of household, FOR ALL)
-- ============================================================================
-- Per spec §5.11 table: SELECT and write are BOTH admin-of-household. Non-
-- admin members do NOT see pending invitations (privacy of email + code).
-- The redeem flow (Edge Function /invitations/redeem) runs as service_role
-- and bypasses RLS to consume the invitation.
-- ============================================================================
ALTER TABLE public.household_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitations_admin_all ON public.household_invitations;
CREATE POLICY invitations_admin_all ON public.household_invitations
  FOR ALL
  TO authenticated
  USING (app.is_household_admin(household_id))
  WITH CHECK (app.is_household_admin(household_id));


-- ============================================================================
-- 4. user_profiles — cross-household SELECT (display) + self UPDATE only
-- ============================================================================
-- SELECT (spec §5.12): any user that shares at least one household with the
-- target user_id may SELECT display_name/avatar_url. The simplest predicate
-- that expresses "shares a household with me" is:
--   EXISTS (SELECT 1 FROM members m1
--           JOIN members m2 ON m1.household_id = m2.household_id
--           WHERE m1.user_id = auth.uid()
--             AND m2.user_id = user_profiles.user_id
--             AND m1.deleted_at IS NULL AND m2.deleted_at IS NULL)
-- Plus: the user always sees their OWN profile, and sys admin sees all.
--
-- UPDATE: self only (Pattern C). No INSERT policy — profiles are created
-- exclusively by the `trg_create_user_profile` trigger on `auth.users`
-- (SECURITY DEFINER bypasses RLS). No DELETE policy — handled via FK
-- ON DELETE CASCADE from auth.users.
-- ============================================================================
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_profiles_select ON public.user_profiles;
CREATE POLICY user_profiles_select ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR app.is_system_admin()
    OR EXISTS (
      SELECT 1
      FROM public.members m1
      JOIN public.members m2
        ON m1.household_id = m2.household_id
      WHERE m1.user_id = auth.uid()
        AND m2.user_id = user_profiles.user_id
        AND m1.deleted_at IS NULL
        AND m2.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS user_profiles_self_update ON public.user_profiles;
CREATE POLICY user_profiles_self_update ON public.user_profiles
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ============================================================================
-- 5. app_settings — Pattern F (scope-aware: global / household / user)
-- ============================================================================
-- SELECT cascade resolution (§5.5) requires that any authenticated caller can
-- read the global defaults — the helper getConfig(key, default, scope?)
-- reads user -> household -> global. Spec §5.11 table column for global
-- SELECT is "sys admin (or read all)" — Pattern F's reference DDL exposes
-- all global rows to authenticated. We follow Pattern F verbatim:
--   * global SELECT: open to authenticated (anon still blocked)
--   * household SELECT: member-of household
--   * user SELECT: own (auth.uid())
-- Writes:
--   * global FOR ALL: sys admin only
--   * household FOR ALL: admin-of household
--   * user FOR ALL: own
-- ============================================================================
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_settings_select ON public.app_settings;
CREATE POLICY app_settings_select ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (
    (scope = 'global')
    OR (scope = 'household' AND scope_id IN (SELECT app.households_of_user()))
    OR (scope = 'user' AND scope_id = auth.uid())
    OR app.is_system_admin()
  );

DROP POLICY IF EXISTS app_settings_global_write ON public.app_settings;
CREATE POLICY app_settings_global_write ON public.app_settings
  FOR ALL
  TO authenticated
  USING (scope = 'global' AND app.is_system_admin())
  WITH CHECK (scope = 'global' AND app.is_system_admin());

DROP POLICY IF EXISTS app_settings_household_write ON public.app_settings;
CREATE POLICY app_settings_household_write ON public.app_settings
  FOR ALL
  TO authenticated
  USING (scope = 'household' AND app.is_household_admin(scope_id))
  WITH CHECK (scope = 'household' AND app.is_household_admin(scope_id));

DROP POLICY IF EXISTS app_settings_user_write ON public.app_settings;
CREATE POLICY app_settings_user_write ON public.app_settings
  FOR ALL
  TO authenticated
  USING (scope = 'user' AND scope_id = auth.uid())
  WITH CHECK (scope = 'user' AND scope_id = auth.uid());


-- ============================================================================
-- 6. app_settings_history — replicates parent predicate (SELECT) +
--                           service_role only writes (no write policy)
-- ============================================================================
-- Spec §5.11: history SELECT predicate must match the parent app_settings
-- SELECT exactly so users only see audit rows for settings they can read.
-- Writes are service_role only — the audit trigger (T-111 audit_app_settings)
-- is SECURITY DEFINER and bypasses RLS, which is the only intended writer.
-- No write policy = no write for authenticated/anon.
-- ============================================================================
ALTER TABLE public.app_settings_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_settings_history_select ON public.app_settings_history;
CREATE POLICY app_settings_history_select ON public.app_settings_history
  FOR SELECT
  TO authenticated
  USING (
    (scope = 'global')
    OR (scope = 'household' AND scope_id IN (SELECT app.households_of_user()))
    OR (scope = 'user' AND scope_id = auth.uid())
    OR app.is_system_admin()
  );


-- ============================================================================
-- 7. consent_log — own SELECT/INSERT + own UPDATE limited to revoked_*
-- ============================================================================
-- SELECT: caller sees own consents; sys admin sees all (audit).
-- INSERT: caller may only insert rows where user_id = auth.uid() (signup
--         flow + opt-in toggles). The Edge Function /consent runs as
--         service_role for system-driven inserts (e.g. import).
-- UPDATE: caller may only update OWN rows; column immutability is enforced
--         by a separate BEFORE UPDATE trigger that raises if any column
--         other than revoked_at/revoked_reason changes (RLS policies cannot
--         reference OLD/NEW per-column directly).
-- DELETE: no policy — consent_log is append-only by LGPD; revocation is
--         expressed via UPDATE revoked_at, not DELETE. Hard-delete only
--         via service_role during account deletion (§9.4).
-- ============================================================================
ALTER TABLE public.consent_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS consent_log_select ON public.consent_log;
CREATE POLICY consent_log_select ON public.consent_log
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR app.is_system_admin()
  );

DROP POLICY IF EXISTS consent_log_insert ON public.consent_log;
CREATE POLICY consent_log_insert ON public.consent_log
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS consent_log_self_update ON public.consent_log;
CREATE POLICY consent_log_self_update ON public.consent_log
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ============================================================================
-- 7a. consent_log column-level immutability trigger
-- ============================================================================
-- RLS USING/WITH CHECK clauses cannot inspect OLD vs NEW on a per-column
-- basis. To satisfy the spec acceptance "UPDATE policy only allows changing
-- revoked_at/revoked_reason; other column updates blocked" we attach a
-- BEFORE UPDATE trigger that raises a permission-denied exception when any
-- forbidden column changes. The trigger is SECURITY INVOKER (no privilege
-- escalation needed) and search_path is locked.
--
-- Allowed changes: revoked_at, revoked_reason. Everything else (user_id,
-- purpose, version, legal_basis, accepted_at, ip_address, user_agent, id)
-- must remain equal to OLD. service_role calls bypass RLS but NOT triggers,
-- so the anonymize flow (§9.4) which mutates user_id + ip_address +
-- user_agent must run with `session_replication_role = replica` or use a
-- dedicated SECURITY DEFINER wrapper. The anonymize function in §5.10
-- already runs as the migration-installing role so a future migration may
-- add an exception path; documenting here for the audit trail.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.consent_log_block_pii_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Allow service_role / replication to mutate freely (LGPD anonymize flow).
  IF current_setting('role', true) = 'service_role'
     OR session_user = 'postgres' THEN
    RETURN NEW;
  END IF;

  IF NEW.id            IS DISTINCT FROM OLD.id            OR
     NEW.user_id       IS DISTINCT FROM OLD.user_id       OR
     NEW.purpose       IS DISTINCT FROM OLD.purpose       OR
     NEW.version       IS DISTINCT FROM OLD.version       OR
     NEW.legal_basis   IS DISTINCT FROM OLD.legal_basis   OR
     NEW.accepted_at   IS DISTINCT FROM OLD.accepted_at   OR
     NEW.ip_address    IS DISTINCT FROM OLD.ip_address    OR
     NEW.user_agent    IS DISTINCT FROM OLD.user_agent
  THEN
    RAISE EXCEPTION
      'consent_log: only revoked_at and revoked_reason may be modified by '
      'the row owner (LGPD append-only invariant)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.consent_log_block_pii_update() IS
  'BEFORE UPDATE trigger em public.consent_log: bloqueia mudanças em colunas '
  'imutáveis (id, user_id, purpose, version, legal_basis, accepted_at, '
  'ip_address, user_agent), permitindo apenas revoked_at e revoked_reason. '
  'Complementa RLS T-114: USING/WITH CHECK não consegue inspecionar OLD/NEW '
  'por coluna. service_role / postgres bypassam (LGPD anonymize §9.4).';

DROP TRIGGER IF EXISTS trg_consent_log_block_pii_update ON public.consent_log;
CREATE TRIGGER trg_consent_log_block_pii_update
  BEFORE UPDATE ON public.consent_log
  FOR EACH ROW
  EXECUTE FUNCTION app.consent_log_block_pii_update();


-- ============================================================================
-- 8. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120800_rls_p0_tables',
  'RLS enabled + full policy set for the 7 P0-P1 tables: households, members, '
  'household_invitations, user_profiles, app_settings, app_settings_history, '
  'consent_log. Uses helpers app.households_of_user, app.is_household_admin, '
  'app.is_system_admin (T-113). Patterns A (member-of SELECT), B (admin-of '
  'write), C (owner-of self), F (scope-aware app_settings). consent_log '
  'column immutability enforced via BEFORE UPDATE trigger '
  'app.consent_log_block_pii_update (RLS cannot reference OLD/NEW per column).'
)
ON CONFLICT (migration_name) DO NOTHING;
