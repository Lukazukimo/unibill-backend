-- ============================================================================
-- Migration: 20260711120000_rate_limit_consume_amount.sql
-- Date:      2026-07-11
-- Task:      T-319 follow-up (atomic rate-limit for all limiters)
-- Purpose:   Extend app.rate_limit_consume with an optional p_amount so it is
--            the single ATOMIC token-bucket primitive for every rate limiter.
--            The IP guard, login/reset lockout, invitation-redeem and telemetry
--            limiters previously did a non-atomic read-then-upsert (SELECT count
--            then UPSERT count+1), which loses updates under concurrent requests
--            from the same actor and lets a caller exceed its cap. Routing them
--            all through this one INSERT .. ON CONFLICT DO UPDATE count+amount
--            statement closes that race. Batched limiters (telemetry counts
--            events, not requests) pass p_amount > 1.
-- Spec refs: §5.8 / §4.2.1 (token-bucket helper contract), §9.1 (anti-abuse).
--
-- Design notes:
--   * Adding a parameter changes the function signature, so we DROP the 4-arg
--     version and CREATE the 5-arg one (a bare CREATE OR REPLACE would leave the
--     old overload behind and make the PostgREST rpc call ambiguous).
--   * p_amount DEFAULT 1 keeps every existing 4-arg caller (withRateLimit)
--     working unchanged. GREATEST(coalesce(p_amount,1),0) guards a null/negative.
--   * SECURITY DEFINER + search_path='' (fully-qualified names), service_role
--     only — identical posture to the original.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS app.rate_limit_consume(text,text,timestamptz,interval,integer);
--   -- then re-create the original 4-arg version from 20260621120000.
-- ============================================================================

DROP FUNCTION IF EXISTS app.rate_limit_consume(text, text, timestamptz, interval);

CREATE OR REPLACE FUNCTION app.rate_limit_consume(
  p_resource_type text,
  p_resource_key  text,
  p_window_start  timestamptz,
  p_window_size   interval,
  p_amount        integer DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_amount int := GREATEST(coalesce(p_amount, 1), 0);
  v_count  int;
BEGIN
  INSERT INTO public.rate_limit_buckets AS b
    (resource_type, resource_key, window_start, window_size, count)
  VALUES (p_resource_type, p_resource_key, p_window_start, p_window_size, v_amount)
  ON CONFLICT (resource_type, resource_key, window_start, window_size)
  DO UPDATE SET count = b.count + v_amount
  RETURNING b.count INTO v_count;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION app.rate_limit_consume(text, text, timestamptz, interval, integer) IS
  'Atomic token-bucket consume: adds p_amount (default 1) to the '
  '(resource_type, resource_key, window_start, window_size) bucket and returns '
  'the post-increment count, in one INSERT .. ON CONFLICT DO UPDATE statement '
  '(no read-then-write race). service_role only. T-319.';

REVOKE EXECUTE ON FUNCTION
  app.rate_limit_consume(text, text, timestamptz, interval, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  app.rate_limit_consume(text, text, timestamptz, interval, integer)
  TO service_role;

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260711120000_rate_limit_consume_amount',
  'Extend app.rate_limit_consume with p_amount (DEFAULT 1) so all rate limiters '
  '(IP guard, login/reset lockout, invitation redeem, telemetry) share one '
  'atomic INSERT .. ON CONFLICT DO UPDATE count+amount primitive, closing the '
  'non-atomic read-then-upsert race. service_role only.'
)
ON CONFLICT (migration_name) DO NOTHING;
