-- ============================================================================
-- Test:      supabase/tests/pgtap/rate_limit_consume.test.sql
-- Task:      T-319 follow-up (atomic rate-limit primitive with p_amount)
-- Purpose:   pgTAP assertions for app.rate_limit_consume: exists with the 5-arg
--            signature, service_role-only EXECUTE, increments by the default 1
--            and by an explicit amount (returning the post-increment count),
--            keys are independent, and a null amount coalesces to +1.
-- ============================================================================
BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(9);

SELECT has_function(
  'app', 'rate_limit_consume',
  ARRAY['text', 'text', 'timestamp with time zone', 'interval', 'integer'],
  'app.rate_limit_consume(..., integer) exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'app.rate_limit_consume(text,text,timestamptz,interval,integer)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'app.rate_limit_consume(text,text,timestamptz,interval,integer)',
    'EXECUTE'
  ),
  'EXECUTE is service_role only'
);

-- Default amount increments by 1 and returns the running count.
SELECT is(
  app.rate_limit_consume('t_a', 'k1', '2026-07-11T00:00:00Z', '1 minute'),
  1, 'first consume returns 1'
);
SELECT is(
  app.rate_limit_consume('t_a', 'k1', '2026-07-11T00:00:00Z', '1 minute'),
  2, 'second consume returns 2'
);

-- Explicit amount increments by N.
SELECT is(
  app.rate_limit_consume('t_b', 'k1', '2026-07-11T00:00:00Z', '1 minute', 5),
  5, 'consume(amount=5) returns 5'
);
SELECT is(
  app.rate_limit_consume('t_b', 'k1', '2026-07-11T00:00:00Z', '1 minute', 5),
  10, 'consume(amount=5) again returns 10'
);
SELECT is(
  app.rate_limit_consume('t_b', 'k1', '2026-07-11T00:00:00Z', '1 minute', 1),
  11, 'mixing a +1 onto the same bucket returns 11'
);

-- Different key starts fresh.
SELECT is(
  app.rate_limit_consume('t_a', 'k2', '2026-07-11T00:00:00Z', '1 minute'),
  1, 'a different resource_key starts a fresh bucket'
);

-- Null amount coalesces to +1 (defensive).
SELECT is(
  app.rate_limit_consume('t_c', 'k1', '2026-07-11T00:00:00Z', '1 minute', NULL),
  1, 'a null amount coalesces to +1'
);

SELECT * FROM finish();
ROLLBACK;
