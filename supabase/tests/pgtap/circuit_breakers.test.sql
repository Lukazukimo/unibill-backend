-- ============================================================================
-- Test:      supabase/tests/pgtap/circuit_breakers.test.sql
-- Date:      2026-06-24
-- Task:      T-423 (#70) — pgTAP: circuit_breakers state machine transitions
-- Purpose:   Exercise the breaker state machine implemented by the atomic SQL
--            functions in 20260621120000_app_resilience_functions.sql (the SQL
--            backing the T-415 withChainBreaker / withCircuitBreaker helpers):
--              app.circuit_begin / circuit_record_success / circuit_record_failure
--
--            Transitions covered (§7.6 / §5.8):
--              1. initial closed (no row → circuit_begin returns 'closed')
--              2. N failures < threshold stay closed; the Nth (>= threshold)
--                 opens with opened_at + next_probe_at
--              3. next_probe_at in the past → circuit_begin flips to half_open
--                 (atomic UPDATE…RETURNING); a SECOND begin returns 'open'
--                 (only one probe wins — the single-winner guarantee)
--              4. half_open probe successes increment; probe_success_required
--                 reached → closed (records closed_at; opened_at kept as history)
--              5. probe failure re-opens with exponential backoff; the exponent
--                 caps at 6 (cooldown = base · 2^min(reopen,6))
--              6. Trigger B: threshold=1 (quota) opens on the FIRST failure
--
-- Spec refs: §7.6 (chain breaker), §5.8 (state machine + DDL), §4.2 (atomic flip).
--
-- ⚠️ Two documented divergences from the original T-423 wording (the test asserts
--    the IMPLEMENTED behavior, which is the source of truth):
--    - A clean recovery RESETS reopen_count to 0 (so the next outage starts at
--      the base cooldown) — the issue said "reopen_count preserved". The reset is
--      intentional (see circuit_record_success).
--    - The backoff caps the EXPONENT at 6 (base·2^6), it does NOT clamp to the
--      ai.chain.cooldown_max_sec (21600s) absolute ceiling. The absolute cap is a
--      documented follow-up (see chain_breaker.ts). With base 900 this lands at
--      57600s, above 21600 — so the cap test uses a small base to assert the
--      exponent behavior unambiguously.
--
-- Concurrency note: pgTAP runs single-session inside BEGIN/ROLLBACK, so the true
--   2-connection race isn't expressible here. Transition 3's "second circuit_begin
--   returns open" proves the same single-winner property: the flip is an atomic
--   UPDATE … WHERE state='open' … RETURNING, so a second caller sees half_open and
--   is rejected.
--
-- Hermetic: BEGIN/ROLLBACK; runs as the postgres owner (service_role-equivalent;
--   circuit_breakers has no RLS). Distinct resource_keys per phase avoid bleed.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions, app;

-- Force a reopen: backdate the probe window, win the probe (→ half_open), then
-- fail it (→ open with backoff). Returns the new cooldown in seconds, which (as
-- opened_at and next_probe_at are both now() in the same UPDATE) equals exactly
-- next_probe_at - opened_at.
CREATE FUNCTION pg_temp.force_reopen(p_type text, p_key text, p_base int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE s int;
BEGIN
  UPDATE public.circuit_breakers SET next_probe_at = now() - interval '1 second'
   WHERE resource_type = p_type AND resource_key = p_key;
  PERFORM app.circuit_begin(p_type, p_key);                          -- → half_open
  PERFORM app.circuit_record_failure(p_type, p_key, 1, p_base, 'probe-fail'); -- → open
  SELECT extract(epoch FROM (next_probe_at - opened_at))::int INTO s
    FROM public.circuit_breakers WHERE resource_type = p_type AND resource_key = p_key;
  RETURN s;
END $$;

CREATE FUNCTION pg_temp.reopen_seq(p_type text, p_key text, p_base int, p_n int)
RETURNS int[] LANGUAGE plpgsql AS $$
DECLARE r int[] := '{}'; i int;
BEGIN
  FOR i IN 1..p_n LOOP r := r || pg_temp.force_reopen(p_type, p_key, p_base); END LOOP;
  RETURN r;
END $$;

SELECT plan(16);


-- ============================================================================
-- Transition 1 — initial closed
-- ============================================================================
SELECT is(
  app.circuit_begin('ai_chain', 'pgtap-fsm')::text, 'closed',
  '#1 no row → circuit_begin returns closed (healthy)'
);


-- ============================================================================
-- Transition 2 — N failures reach the threshold → open
-- ============================================================================
-- 5 failures below the threshold of 6 stay closed.
SELECT app.circuit_record_failure('ai_chain', 'pgtap-fsm', 6, 1, 'error') FROM generate_series(1, 5);

SELECT is(
  (SELECT state::text FROM public.circuit_breakers
     WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  'closed',
  '#2 5 failures (< threshold 6) → still closed'
);

SELECT is(
  app.circuit_record_failure('ai_chain', 'pgtap-fsm', 6, 1, 'error')::text, 'open',
  '#3 the 6th failure (>= threshold) → open'
);

SELECT ok(
  (SELECT opened_at IS NOT NULL AND next_probe_at IS NOT NULL
     FROM public.circuit_breakers
    WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  '#4 open sets opened_at + next_probe_at'
);

SELECT is(
  (SELECT extract(epoch FROM (next_probe_at - opened_at))::int
     FROM public.circuit_breakers
    WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  1,
  '#5 initial open uses the base cooldown (1s, no doubling)'
);


-- ============================================================================
-- Transition 3 — next_probe_at past → half_open (single winner)
-- ============================================================================
UPDATE public.circuit_breakers SET next_probe_at = now() - interval '1 second'
 WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm';

SELECT is(
  app.circuit_begin('ai_chain', 'pgtap-fsm')::text, 'half_open',
  '#6 next_probe_at past → circuit_begin flips open→half_open'
);

SELECT is(
  (SELECT probes_sent FROM public.circuit_breakers
     WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  1,
  '#7 the winning probe incremented probes_sent'
);

SELECT is(
  app.circuit_begin('ai_chain', 'pgtap-fsm')::text, 'open',
  '#8 a SECOND begin returns open — only one probe wins (atomic single-winner)'
);


-- ============================================================================
-- Transition 4 — probe successes close after probe_success_required
-- ============================================================================
SELECT app.circuit_record_success('ai_chain', 'pgtap-fsm', 2);
SELECT is(
  (SELECT state::text FROM public.circuit_breakers
     WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  'half_open',
  '#9 1 probe success (< 2 required) → still half_open'
);

SELECT app.circuit_record_success('ai_chain', 'pgtap-fsm', 2);
SELECT is(
  (SELECT state::text FROM public.circuit_breakers
     WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  'closed',
  '#10 2nd probe success (>= required) → closed'
);

SELECT ok(
  (SELECT closed_at IS NOT NULL FROM public.circuit_breakers
     WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  '#11 a clean recovery records closed_at (opened_at is kept as history, not nulled)'
);

SELECT is(
  (SELECT reopen_count FROM public.circuit_breakers
     WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-fsm'),
  0,
  '#12 clean recovery RESETS reopen_count (next outage starts at base cooldown)'
);


-- ============================================================================
-- Transition 5 — re-open backoff: doubles per reopen, exponent caps at 6
-- ============================================================================
-- Open a fresh breaker at base cooldown 1 (closed→open, threshold 1).
SELECT app.circuit_record_failure('ai_chain', 'pgtap-backoff', 1, 1, 'error');
SELECT is(
  (SELECT extract(epoch FROM (next_probe_at - opened_at))::int
     FROM public.circuit_breakers
    WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-backoff'),
  1,
  '#13 fresh open at base cooldown (1s)'
);

-- 8 consecutive probe-failures: cooldown = base · 2^min(reopen,6) → caps at 2^6.
SELECT is(
  pg_temp.reopen_seq('ai_chain', 'pgtap-backoff', 1, 8),
  ARRAY[1, 2, 4, 8, 16, 32, 64, 64],
  '#14 backoff doubles each reopen; exponent caps at 6 (64=2^6) — note: NOT clamped to cooldown_max_sec'
);

SELECT is(
  (SELECT reopen_count FROM public.circuit_breakers
     WHERE resource_type = 'ai_chain' AND resource_key = 'pgtap-backoff'),
  8,
  '#15 reopen_count tracks every re-open (8)'
);


-- ============================================================================
-- Transition 6 — Trigger B: threshold 1 (quota) opens on the first failure
-- ============================================================================
SELECT is(
  app.circuit_record_failure('ai_chain', 'pgtap-quota', 1, 900, 'quota_exceeded')::text,
  'open',
  '#16 threshold=1 → a single failure opens immediately (Trigger B / quota)'
);


SELECT * FROM finish();

ROLLBACK;
