-- =============================================================================
-- Script:    scripts/admin/bootstrap-sys-admin.sql
-- Date:      2026-06-10
-- Task:      T-217
-- Purpose:   Promote the **first** Supabase user to Unibill sys admin by
--            flipping `auth.users.raw_app_meta_data ->> 'is_system_admin'` to
--            `true` AND, in the same transaction, write the corresponding
--            forensics rows:
--              * `public.system_admin_grants` row with
--                `action='granted', granted_by=NULL, reason='bootstrap'`
--                (T-216 audit table — append-only).
--              * `public.domain_events` row
--                `event_type='system_admin.bootstrapped',
--                 aggregate_type='user', aggregate_id=<bootstrap_user_id>,
--                 actor_type='system'`
--                so the rest of the system (UI `/sys-admin/events`, future
--                webhooks, SIEM tails) observes the platform-superuser bit
--                being created exactly once per project lifetime.
--
--            This is the SQL companion to the GoTrue-API-based wrapper
--            `scripts/bootstrap_sys_admin.sh` (T-117). Use this `.sql` file
--            in **Supabase Studio → SQL editor** when:
--              (a) curl/jq are unavailable, OR
--              (b) you specifically want the audit + event rows written in
--                  the SAME transaction as the claim flip (the shell wrapper
--                  hits the GoTrue admin API which CANNOT participate in a
--                  Postgres transaction with the audit INSERTs).
--
--            The shell wrapper is the **default** path for fresh deploys
--            (idempotent, scriptable from CI). This SQL block is the
--            **forensically-canonical** path: every bootstrap row in
--            `system_admin_grants` written by this script is, by design,
--            atomically tied to the actual `auth.users` mutation that
--            granted the claim. Spec §9.2 sec-2 finding requires the audit
--            trail; running both side-by-side at bootstrap is fine because
--            the script is idempotent (see "Idempotency" below).
--
-- Spec refs: §9.2  ("Bootstrap inclui INSERT audit" — verbatim DO block on
--                   lines 2486-2504 of the spec is the canonical template
--                   for this file).
--            §5.6  (domain_events DDL — payload jsonb NOT NULL with
--                   {version, data} convention; actor_type 'system').
--            BR-028 (Sys admin Bootstrap (1ª vez): SQL no Studio → INSERT
--                   system_admin_grants + domain_event
--                   `system_admin.bootstrapped`).
--            §11.5 (Deploy inicial checklist step 10 — "Promover primeiro
--                   sys admin via SQL no Studio").
--
-- Pre-conditions:
--   1. Target user already exists in `auth.users` (must sign up via the
--      mobile app first). Lookup is by `email`.
--   2. Migration `20260616122000_create_system_admin_grants.sql` (T-216) is
--      applied — provides `public.system_admin_grants`.
--   3. Migration `20260615120900_create_sys_admin_helpers.sql` (T-117) is
--      applied — provides `app.count_sys_admins()` /
--      `app.assert_sys_admin_exists()` for post-run verification.
--   4. **Optional but recommended**: the P4 migration that creates
--      `public.domain_events` (T-305) is applied. If not, the script
--      degrades gracefully: it WRITES the audit row but SKIPS the
--      domain_event INSERT with a RAISE NOTICE explaining why. The shell
--      wrapper has no such dependency.
--
-- Usage (Supabase Studio → SQL editor):
--   1. Edit the `bootstrap_email` literal below to your founder address.
--   2. Run the entire file. Expect a NOTICE describing what happened.
--   3. Ask the user to sign OUT / sign IN — JWT claims only refresh at login.
--   4. Verify in Studio:
--        SELECT app.assert_sys_admin_exists();
--        SELECT * FROM public.system_admin_grants WHERE reason = 'bootstrap';
--        SELECT * FROM public.domain_events
--          WHERE event_type = 'system_admin.bootstrapped';
--
-- Idempotency:
--   Re-running this script is SAFE. The DO block checks BEFORE writing:
--     * If `is_system_admin` is already `'true'` on the user row → skip the
--       UPDATE (RAISE NOTICE 'already granted').
--     * If a row already exists in `system_admin_grants` for this user with
--       `reason='bootstrap', action='granted'` → skip the INSERT into
--       `system_admin_grants` (RAISE NOTICE 'audit row already present').
--     * If a `system_admin.bootstrapped` event for this user already exists
--       in `domain_events` → skip the event INSERT.
--   This means: re-running after a partial failure converges to the correct
--   end state, and re-running on a healthy bootstrap is a no-op.
--
-- Transactionality:
--   The DO block runs in an implicit transaction. If ANY of the three
--   side-effects (claim flip, audit row, domain event) fails, the entire
--   block aborts — you do NOT end up with a half-applied bootstrap.
--
-- Forbidden patterns (enforced by review):
--   * DO NOT remove the idempotency checks. The script MUST be safely
--     re-runnable from CI / runbook automation.
--   * DO NOT write `granted_by` to anything other than NULL for a bootstrap
--     row — the NULL is what makes the row identifiable as the genesis
--     event (spec §9.2: "NULL pra bootstrap (SQL direto)").
--   * DO NOT remove the `domain_events` INSERT — it is part of the audit
--     contract (BR-028). The `to_regclass` guard is for the rare case
--     where the operator runs this BEFORE T-305 is applied; in production
--     T-305 lands well before any bootstrap.
--   * DO NOT broaden the audit reason text beyond 'bootstrap' — that
--     literal is what the rest of the system pattern-matches on (UI
--     /sys-admin/events filter, pgTAP tests, SIEM rules).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Configuration — edit this single literal before running.
-- -----------------------------------------------------------------------------
-- Replace 'CHANGE_ME@example.com' with the email of the user you want to
-- promote. The user MUST already exist in auth.users (sign up via mobile app
-- first). The DO block does NOT accept psql variables (\set) because
-- Supabase Studio executes the file directly via the SQL editor, which does
-- not interpret psql meta-commands.
-- -----------------------------------------------------------------------------

DO $bootstrap$
DECLARE
  -- ⇩⇩⇩  EDIT THIS  ⇩⇩⇩
  bootstrap_email      text := 'CHANGE_ME@example.com';
  -- ⇧⇧⇧  EDIT THIS  ⇧⇧⇧

  bootstrap_user_id    uuid;
  current_claim        text;
  audit_exists         boolean;
  event_exists         boolean;
  events_table_present boolean;
BEGIN
  -- Safety net: refuse to run with the placeholder literal still in place.
  -- Catches the common "ran the script before editing it" mistake.
  IF bootstrap_email = 'CHANGE_ME@example.com' THEN
    RAISE EXCEPTION
      'Refusing to bootstrap: edit the `bootstrap_email` literal in '
      'scripts/admin/bootstrap-sys-admin.sql before running (currently '
      'still set to the placeholder ''CHANGE_ME@example.com'').'
      USING ERRCODE = 'UB002';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 1. Locate the target user in auth.users.
  -- ---------------------------------------------------------------------------
  SELECT id,
         COALESCE(raw_app_meta_data ->> 'is_system_admin', 'false')
    INTO bootstrap_user_id, current_claim
    FROM auth.users
   WHERE email = bootstrap_email;

  IF bootstrap_user_id IS NULL THEN
    RAISE EXCEPTION
      'Bootstrap aborted: no user with email % found in auth.users. '
      'Sign the user up via the mobile app first, then re-run this script.',
      bootstrap_email
      USING ERRCODE = 'UB003';
  END IF;

  RAISE NOTICE 'Bootstrap target: % (user_id=%, current is_system_admin=%)',
    bootstrap_email, bootstrap_user_id, current_claim;

  -- ---------------------------------------------------------------------------
  -- 2. Flip the JWT claim (idempotent).
  -- ---------------------------------------------------------------------------
  -- The GoTrue admin API uses JSONB merge semantics; we replicate that here
  -- via the `||` operator on JSONB so any OTHER keys already in
  -- raw_app_meta_data are preserved.
  IF current_claim = 'true' THEN
    RAISE NOTICE 'Claim already true — skipping UPDATE auth.users (idempotent).';
  ELSE
    UPDATE auth.users
       SET raw_app_meta_data =
           COALESCE(raw_app_meta_data, '{}'::jsonb)
           || '{"is_system_admin": true}'::jsonb
     WHERE id = bootstrap_user_id;

    RAISE NOTICE 'Promoted % to is_system_admin=true.', bootstrap_email;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 3. Write the audit row in public.system_admin_grants (idempotent).
  -- ---------------------------------------------------------------------------
  -- Check if a bootstrap row already exists for this user. The table is
  -- append-only by policy (no UPDATE policy), so the only way "already
  -- present" can be true is if this script ran successfully before.
  SELECT EXISTS (
    SELECT 1
      FROM public.system_admin_grants
     WHERE user_id = bootstrap_user_id
       AND action  = 'granted'
       AND reason  = 'bootstrap'
       AND granted_by IS NULL
  ) INTO audit_exists;

  IF audit_exists THEN
    RAISE NOTICE 'Audit row already present in system_admin_grants — skipping INSERT (idempotent).';
  ELSE
    INSERT INTO public.system_admin_grants
      (user_id, action, granted_by, reason)
    VALUES
      (bootstrap_user_id, 'granted', NULL, 'bootstrap');

    RAISE NOTICE 'Inserted audit row into public.system_admin_grants '
                 '(action=granted, granted_by=NULL, reason=bootstrap).';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 4. Emit domain_event `system_admin.bootstrapped` (idempotent, guarded).
  -- ---------------------------------------------------------------------------
  -- Guard: domain_events lands in T-305 (P4 batch). If this script is run
  -- against a project that has NOT yet applied T-305, we degrade gracefully:
  -- the claim flip + audit row still land, but the event is skipped with a
  -- RAISE NOTICE. The operator will see the warning and can re-run this
  -- script (which is idempotent) after T-305 ships to backfill the event.
  events_table_present := to_regclass('public.domain_events') IS NOT NULL;

  IF NOT events_table_present THEN
    RAISE NOTICE
      'public.domain_events not present yet (T-305 not applied). '
      'Skipping domain_event INSERT. Re-run this script after T-305 to '
      'backfill the system_admin.bootstrapped event.';
  ELSE
    -- Idempotency: skip if an event already exists for this user.
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.domain_events '
      'WHERE event_type = ''system_admin.bootstrapped'' '
      'AND aggregate_type = ''user'' '
      'AND aggregate_id = $1)'
      INTO event_exists
      USING bootstrap_user_id;

    IF event_exists THEN
      RAISE NOTICE 'Event system_admin.bootstrapped already present in domain_events — skipping (idempotent).';
    ELSE
      EXECUTE
        'INSERT INTO public.domain_events '
        '(event_type, event_version, aggregate_type, aggregate_id, '
        ' actor_type, actor_user_id, payload) '
        'VALUES ($1, $2, $3, $4, $5, $6, $7)'
        USING
          'system_admin.bootstrapped',
          1,
          'user',
          bootstrap_user_id,
          'system',
          NULL,   -- actor_user_id NULL — written by the platform itself,
                  -- not by a user-initiated request. The aggregate_id is the
                  -- promoted user; the "who did it" is forensically NULL for
                  -- bootstrap (cf. system_admin_grants.granted_by NULL).
          jsonb_build_object(
            'version', 1,
            'data', jsonb_build_object(
              'reason', 'bootstrap',
              'email',  bootstrap_email
            )
          );

      RAISE NOTICE 'Inserted domain_event system_admin.bootstrapped for user %.',
        bootstrap_user_id;
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 5. Final invariant check.
  -- ---------------------------------------------------------------------------
  -- assert_sys_admin_exists() raises SQLSTATE UB001 if zero sys admins are
  -- visible from a fresh SELECT. After step 2 it MUST succeed; if it
  -- doesn't, something is very wrong (e.g. the UPDATE didn't land because
  -- of a hidden constraint).
  PERFORM app.assert_sys_admin_exists();

  RAISE NOTICE 'Bootstrap complete. Ask % to sign OUT / sign IN to pick up '
               'the new JWT claim. Next promotions use the in-app peer flow '
               '(POST /admin/promote-system-admin).',
    bootstrap_email;
END
$bootstrap$;
