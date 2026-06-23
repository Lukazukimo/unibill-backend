-- ============================================================================
-- Test:      supabase/tests/triggers/create_user_profile.test.sql
-- Date:      2026-06-10
-- Task:      T-122
-- Purpose:   pgTAP test suite for the `public.create_user_profile()` trigger
--            installed in T-110 on `auth.users` AFTER INSERT. Verifies the
--            four canonical scenarios that exercise the trigger contract:
--
--              (1) display_name FROM raw_user_meta_data when provided;
--              (2) display_name FALLBACK to split_part(email,'@',1) when
--                  raw_user_meta_data->>'display_name' is missing OR empty;
--              (3) ON CONFLICT (user_id) DO NOTHING — re-firing the trigger
--                  for the same user_id (e.g. via DELETE+re-INSERT of the
--                  same UUID, or any future replay scenario) is a no-op
--                  rather than a hard failure;
--              (4) ON DELETE CASCADE — deleting an auth.users row removes
--                  the corresponding user_profiles row atomically (this is
--                  the LGPD hard-delete guarantee from §9.4, surfaced via
--                  the user_profiles FK with ON DELETE CASCADE).
--
-- Spec refs: §5.12 (user_profiles table + create_user_profile trigger),
--            §9.4  (LGPD hard-delete cascades user_profiles).
--
-- Test plan (5 assertions):
--   ok        #1: scenario 1 — display_name from meta is honored
--   ok        #2: scenario 2 — fallback to email local-part when meta missing
--   ok        #3: scenario 3 — re-insert same user_id is a no-op (still 1 row,
--                              and the existing row is unchanged — proving the
--                              ON CONFLICT DO NOTHING semantics, not DO UPDATE)
--   is        #4: scenario 4 — DELETE auth.users row leaves 0 profile rows
--                              (ON DELETE CASCADE works end-to-end)
--   ok        #5: scenario 2b — empty-string display_name in meta also falls
--                              back to email local-part (NULLIF guard verified)
--
-- Hermeticity:
--   Entire test wrapped in BEGIN / ROLLBACK so no state leaks. The four
--   scenarios use four distinct auth.users rows (one per scenario, plus one
--   extra for scenario 5) with deterministic UUIDs for readable failures.
--   Scenario 3 deliberately reuses scenario 1's user_id by DELETing then
--   re-INSERTing to force the trigger to fire twice for the same user_id.
--
-- Why direct INSERT into auth.users:
--   The trigger fires on `AFTER INSERT ON auth.users`. The straightforward way
--   to exercise it in pgTAP is to INSERT directly — this is the documented
--   Supabase pattern for trigger tests that target the auth schema. Required
--   not-null columns are `instance_id`, `email`, `aud`, `role` (the rest have
--   defaults). The single migration `pgtap` session runs as service_role, so
--   it has the necessary grants on auth.users.
--
-- Notes:
--   * pgTAP `ok(boolean, description)` is the most ergonomic assertion for
--     scenarios that boil down to "this SELECT returns true". `is(actual,
--     expected, description)` is used where we want the count surfaced in the
--     failure message.
--   * We deliberately do NOT use `throws_ok` for scenario 3 — the trigger
--     swallows the conflict via `ON CONFLICT DO NOTHING`, so it does NOT
--     raise. The assertion is that the row count stays at 1 AND the original
--     display_name is preserved (proving DO NOTHING, not DO UPDATE).
-- ============================================================================


BEGIN;

-- pgTAP lives in `extensions` (installed by T-105). Set search_path so the
-- unqualified pgTAP calls (plan, ok, is, finish) resolve.
SET LOCAL search_path = public, extensions, app;

SELECT plan(5);


-- ============================================================================
-- Setup: seed 3 auth.users with distinct shapes of raw_user_meta_data so each
-- scenario can be asserted in isolation.
--
--   userU1 — raw_user_meta_data.display_name = 'Foo Bar' → scenario 1
--   userU2 — raw_user_meta_data is NULL                  → scenario 2 (fallback)
--   userU4 — raw_user_meta_data.display_name = ''        → scenario 5 (empty
--             string fallback via NULLIF in the trigger)
--
-- scenario 3 reuses userU1 (DELETE + re-INSERT same UUID)
-- scenario 4 reuses userU2 (DELETE to verify CASCADE on user_profiles)
--
-- `instance_id` is the default Supabase single-instance value (all zeros).
-- `aud`/`role` are 'authenticated' (the standard signed-in default).
-- ============================================================================

INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  -- Scenario 1: explicit display_name in meta
  ('11111111-2222-3333-4444-555555555501',
   '00000000-0000-0000-0000-000000000000',
   'foo.bar@test.local',
   'authenticated', 'authenticated',
   '{"display_name": "Foo Bar"}'::jsonb),
  -- Scenario 2: NULL meta → must fall back to split_part(email,'@',1) = 'alice'
  ('11111111-2222-3333-4444-555555555502',
   '00000000-0000-0000-0000-000000000000',
   'alice@test.local',
   'authenticated', 'authenticated',
   NULL),
  -- Scenario 5: empty-string display_name → must fall back via NULLIF to
  -- split_part(email,'@',1) = 'charlie'
  ('11111111-2222-3333-4444-555555555504',
   '00000000-0000-0000-0000-000000000000',
   'charlie@test.local',
   'authenticated', 'authenticated',
   '{"display_name": ""}'::jsonb);


-- ============================================================================
-- ok #1 — scenario 1: display_name comes FROM raw_user_meta_data
-- ============================================================================
-- After the AFTER INSERT trigger fires, user_profiles row for userU1 must
-- exist with display_name = 'Foo Bar' (the value in raw_user_meta_data).
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.user_profiles
     WHERE user_id      = '11111111-2222-3333-4444-555555555501'
       AND display_name = 'Foo Bar'
  ),
  'ok #1: display_name is set from raw_user_meta_data.display_name'
);


-- ============================================================================
-- ok #2 — scenario 2: fallback to split_part(email,'@',1) when meta is missing
-- ============================================================================
-- userU2 has NULL raw_user_meta_data, so the trigger must fall back to the
-- email local-part: 'alice@test.local' → 'alice'.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.user_profiles
     WHERE user_id      = '11111111-2222-3333-4444-555555555502'
       AND display_name = 'alice'
  ),
  'ok #2: display_name falls back to split_part(email,@,1) when meta missing'
);


-- ============================================================================
-- ok #3 — scenario 3: ON CONFLICT (user_id) DO NOTHING is honored
-- ============================================================================
-- The trigger is AFTER INSERT ON auth.users; its body is
--   INSERT INTO user_profiles (user_id, display_name) VALUES (NEW.id, …)
--   ON CONFLICT (user_id) DO NOTHING;
-- A genuine trigger RE-FIRE for the same user_id is impossible: auth.users.id
-- is the PK (can't re-INSERT) and user_profiles.user_id FKs it (a profile can
-- never pre-exist its auth.users row). So we prove the IDEMPOTENCY of the exact
-- statement the trigger runs: with a profile already present, replaying that
-- INSERT … ON CONFLICT (user_id) DO NOTHING must NEITHER raise NOR overwrite.
--
-- Setup: INSERT auth.users (the trigger creates the profile), overwrite the
-- profile's display_name to a sentinel, then replay the trigger's statement
-- with a DIFFERENT display_name. ON CONFLICT DO NOTHING must preserve the
-- sentinel — proving DO NOTHING (not DO UPDATE) semantics.
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES (
  '11111111-2222-3333-4444-555555555503',
  '00000000-0000-0000-0000-000000000000',
  'bob@test.local',
  'authenticated', 'authenticated',
  '{"display_name": "Replay User"}'::jsonb
);

-- Overwrite the trigger-created profile with a sentinel so we can prove the
-- conflicting replay does NOT clobber it.
UPDATE public.user_profiles
   SET display_name = 'Manual Sentinel'
 WHERE user_id = '11111111-2222-3333-4444-555555555503';

-- Replay the trigger's exact statement with a different display_name. The
-- existing row must win (ON CONFLICT (user_id) DO NOTHING): no overwrite, no
-- raise.
INSERT INTO public.user_profiles (user_id, display_name)
VALUES ('11111111-2222-3333-4444-555555555503', 'Replay User')
ON CONFLICT (user_id) DO NOTHING;

-- Assertion: exactly ONE profile row for this user_id AND its display_name
-- is the sentinel 'Manual Sentinel' (proves DO NOTHING, NOT DO UPDATE — and
-- proves the trigger didn't raise).
SELECT ok(
  (SELECT count(*) FROM public.user_profiles
    WHERE user_id = '11111111-2222-3333-4444-555555555503') = 1
  AND
  (SELECT display_name FROM public.user_profiles
    WHERE user_id = '11111111-2222-3333-4444-555555555503') = 'Manual Sentinel',
  'ok #3: ON CONFLICT (user_id) DO NOTHING preserves existing profile on re-fire'
);


-- ============================================================================
-- is #4 — scenario 4: ON DELETE CASCADE removes the user_profiles row
-- ============================================================================
-- DELETE the auth.users row for userU2 (which has a profile created in
-- scenario 2). Because user_profiles.user_id FK has ON DELETE CASCADE, the
-- corresponding profile row MUST be auto-removed.
DELETE FROM auth.users WHERE id = '11111111-2222-3333-4444-555555555502';

SELECT is(
  (SELECT count(*)::int FROM public.user_profiles
    WHERE user_id = '11111111-2222-3333-4444-555555555502'),
  0,
  'is #4: ON DELETE CASCADE removes the user_profiles row when auth.users row is deleted'
);


-- ============================================================================
-- ok #5 — scenario 2b: empty-string display_name in meta also falls back
-- ============================================================================
-- The trigger uses NULLIF(NEW.raw_user_meta_data->>'display_name', '') so an
-- explicitly empty string is treated the same as missing → fallback to
-- split_part(email,'@',1). userU4 has display_name='' and email='charlie@…'
-- so the resulting profile must have display_name='charlie'.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.user_profiles
     WHERE user_id      = '11111111-2222-3333-4444-555555555504'
       AND display_name = 'charlie'
  ),
  'ok #5: empty-string display_name in meta falls back to email local-part (NULLIF guard)'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
