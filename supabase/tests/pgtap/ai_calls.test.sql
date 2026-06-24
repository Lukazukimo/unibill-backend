-- ============================================================================
-- Test:      supabase/tests/pgtap/ai_calls.test.sql
-- Date:      2026-06-23
-- Task:      T-401 — public.ai_calls DDL + CHECK contract.
-- Purpose:   Constraint-level pgTAP for the ai_calls observability table: the
--            table + its OCR/chain-state columns exist, the purpose/status
--            CHECKs enforce the §7.5.1 domains, valid AI and OCR rows insert,
--            and RLS is enabled. (RLS policy behavior is in tests/rls/
--            ai_calls.test.sql.)
-- Spec refs: §5.6 (ai_calls DDL), §7.3 (OCR reuse + pages_processed), §7.5.1.
--
-- Hermeticity: BEGIN/ROLLBACK; runs as owner (postgres) — RLS owner-bypassed,
--   which is correct here (we test CONSTRAINTS, not policies). Self-fixturing.
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(8);


-- 1. The table exists.
SELECT has_table('public', 'ai_calls', '#1 public.ai_calls table exists');

-- 2-3. The OCR/chain-state extension columns exist (proves this is the extended
-- table the issue asked for, not just the base §5.6 shape).
SELECT has_column('public', 'ai_calls', 'pages_processed',
  '#2 ai_calls.pages_processed exists (OCR usage, §7.3)');
SELECT has_column('public', 'ai_calls', 'chain_state_at_call',
  '#3 ai_calls.chain_state_at_call exists (chain breaker snapshot)');

-- 4. A valid OCR row inserts (provider ocr_space, purpose ocr, model NULL,
--    pages_processed set).
SELECT lives_ok(
  $$INSERT INTO public.ai_calls
      (provider, purpose, status, pages_processed)
    VALUES ('ocr_space', 'ocr', 'success', 2)$$,
  '#4 valid OCR row inserts (purpose=ocr, model NULL, pages_processed set)'
);

-- 5. A valid AI row inserts (provider gemini, purpose extraction, model set).
SELECT lives_ok(
  $$INSERT INTO public.ai_calls
      (provider, model, purpose, status, prompt_tokens, completion_tokens, latency_ms)
    VALUES ('gemini', 'gemini-2.0-flash-001', 'extraction', 'success', 800, 120, 950)$$,
  '#5 valid AI row inserts (purpose=extraction, model set, tokens set)'
);

-- 6. CHECK rejects an unknown purpose.
SELECT throws_ok(
  $$INSERT INTO public.ai_calls (provider, purpose, status)
    VALUES ('gemini', 'bogus_purpose', 'success')$$,
  '23514',
  NULL,
  '#6 CHECK rejects an unknown purpose (23514)'
);

-- 7. CHECK rejects an unknown status.
SELECT throws_ok(
  $$INSERT INTO public.ai_calls (provider, purpose, status)
    VALUES ('gemini', 'extraction', 'bogus_status')$$,
  '23514',
  NULL,
  '#7 CHECK rejects a status outside the §7.5.1 domain (23514)'
);

-- 8. RLS is enabled on the table.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_calls'::regclass),
  '#8 row level security is enabled on ai_calls'
);


SELECT * FROM finish();
ROLLBACK;
