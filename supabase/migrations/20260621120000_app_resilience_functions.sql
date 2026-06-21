-- ============================================================================
-- Migration: 20260621120000_app_resilience_functions.sql
-- Date:      2026-06-21
-- Task:      T-318, T-319 (atomic SQL backing for the worker middleware)
-- Purpose:   Funções SQL atômicas que sustentam os helpers de resiliência dos
--            workers — porque o client supabase-js NÃO faz transação
--            multi-statement nem expressões (count+1) num UPDATE:
--              * app.rate_limit_consume   — token-bucket atômico (INSERT..ON
--                                           CONFLICT DO UPDATE count+1)
--              * app.circuit_begin        — decisão de admissão + flip atômico
--                                           open→half_open (1 probe concorrente)
--              * app.circuit_record_success / _failure — máquina de estados do
--                                           circuit breaker (§5.8)
--            Chamadas via rpc por service_role (workers). SECURITY DEFINER +
--            search_path='' (nomes totalmente qualificados).
-- Spec refs: §4.2 (transição atômica do breaker), §5.8 (state machine + DDL),
--            §4.2.1 (helper contracts withCircuitBreaker / withRateLimit)
--
-- Design notes:
--   * As tabelas circuit_breakers / rate_limit_buckets NÃO têm RLS (T-307,
--     §5.11: só workers via service_role). As funções são SECURITY DEFINER por
--     consistência com os demais wrappers app.* e p/ independerem dos grants
--     default de service_role.
--   * circuit_begin retorna o estado EFETIVO p/ o caller:
--       'closed'    → seguir normal
--       'half_open' → seguir COMO PROBE (este caller venceu o flip open→half_open)
--       'open'      → rejeitar (aberto+esfriando, OU já há probe em voo)
--   * Backoff exponencial no reopen (probe falhou): cooldown * 2^min(reopen,6).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS app.circuit_record_failure(text,text,int,int,text);
--   DROP FUNCTION IF EXISTS app.circuit_record_success(text,text,int);
--   DROP FUNCTION IF EXISTS app.circuit_begin(text,text);
--   DROP FUNCTION IF EXISTS app.rate_limit_consume(text,text,timestamptz,interval);
-- ============================================================================

-- ============================================================================
-- 1. app.rate_limit_consume — token-bucket atômico (retorna o count novo)
-- ============================================================================
CREATE OR REPLACE FUNCTION app.rate_limit_consume(
  p_resource_type text,
  p_resource_key  text,
  p_window_start  timestamptz,
  p_window_size   interval
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO public.rate_limit_buckets AS b
    (resource_type, resource_key, window_start, window_size, count)
  VALUES (p_resource_type, p_resource_key, p_window_start, p_window_size, 1)
  ON CONFLICT (resource_type, resource_key, window_start, window_size)
  DO UPDATE SET count = b.count + 1
  RETURNING b.count INTO v_count;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION app.rate_limit_consume(text, text, timestamptz, interval) IS
  'Incrementa atomicamente o token-bucket (resource_type, resource_key, '
  'window_start, window_size) e retorna o count resultante. O caller compara '
  'com o limite e rejeita se count > limite. Spec §5.8 / §4.2.1 (T-319).';

-- ============================================================================
-- 2. app.circuit_begin — admissão + flip atômico open→half_open
-- ============================================================================
CREATE OR REPLACE FUNCTION app.circuit_begin(
  p_resource_type text,
  p_resource_key  text
)
RETURNS public.circuit_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state public.circuit_state;
BEGIN
  -- Flip atômico: só UM caller concorrente vence open→half_open (RETURNING).
  UPDATE public.circuit_breakers
     SET state = 'half_open',
         half_open_started_at = now(),
         probes_sent = probes_sent + 1,
         updated_at = now()
   WHERE resource_type = p_resource_type
     AND resource_key  = p_resource_key
     AND state = 'open'
     AND next_probe_at IS NOT NULL
     AND next_probe_at <= now()
   RETURNING state INTO v_state;
  IF FOUND THEN
    RETURN 'half_open';   -- venceu o probe → segue como sonda
  END IF;

  SELECT state INTO v_state
    FROM public.circuit_breakers
   WHERE resource_type = p_resource_type AND resource_key = p_resource_key;
  IF NOT FOUND THEN
    RETURN 'closed';      -- sem row = saudável
  END IF;
  IF v_state = 'closed' THEN
    RETURN 'closed';
  END IF;
  -- open (ainda esfriando) OU half_open (outra sonda em voo) → rejeita
  RETURN 'open';
END;
$$;

COMMENT ON FUNCTION app.circuit_begin(text, text) IS
  'Admissão do circuit breaker: retorna o estado EFETIVO p/ o caller — '
  '''closed''/''half_open'' = pode seguir (half_open = venceu o probe atômico), '
  '''open'' = rejeitar. Faz o flip atômico open→half_open. Spec §4.2 / §5.8 (T-318).';

-- ============================================================================
-- 3. app.circuit_record_success — sucesso de fn() (fecha após N probes)
-- ============================================================================
CREATE OR REPLACE FUNCTION app.circuit_record_success(
  p_resource_type text,
  p_resource_key  text,
  p_close_after   int DEFAULT 2
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state     public.circuit_state;
  v_succeeded int;
BEGIN
  SELECT state, probes_succeeded INTO v_state, v_succeeded
    FROM public.circuit_breakers
   WHERE resource_type = p_resource_type AND resource_key = p_resource_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;  -- implicitamente closed, nada a registrar
  END IF;

  IF v_state = 'half_open' THEN
    IF v_succeeded + 1 >= GREATEST(p_close_after, 1) THEN
      -- Clean recovery: reset reopen_count too, so the NEXT outage starts at
      -- the base cooldown (1x) instead of inheriting this lifecycle's backoff.
      UPDATE public.circuit_breakers
         SET state = 'closed', failure_count = 0, closed_at = now(),
             probes_sent = 0, probes_succeeded = 0, half_open_started_at = NULL,
             reopen_count = 0, reason = NULL, updated_at = now()
       WHERE resource_type = p_resource_type AND resource_key = p_resource_key;
    ELSE
      UPDATE public.circuit_breakers
         SET probes_succeeded = probes_succeeded + 1, updated_at = now()
       WHERE resource_type = p_resource_type AND resource_key = p_resource_key;
    END IF;
  ELSIF v_state = 'closed' THEN
    UPDATE public.circuit_breakers
       SET failure_count = 0, updated_at = now()
     WHERE resource_type = p_resource_type AND resource_key = p_resource_key
       AND failure_count <> 0;
  END IF;
END;
$$;

COMMENT ON FUNCTION app.circuit_record_success(text, text, int) IS
  'Registra sucesso: em half_open conta probes e fecha após p_close_after (2); '
  'em closed limpa o streak de falhas (failure_count=0). Spec §5.8 (T-318).';

-- ============================================================================
-- 4. app.circuit_record_failure — falha de fn() (pode abrir o breaker)
-- ============================================================================
CREATE OR REPLACE FUNCTION app.circuit_record_failure(
  p_resource_type    text,
  p_resource_key     text,
  p_threshold        int DEFAULT 5,
  p_cooldown_seconds int DEFAULT 60,
  p_reason           text DEFAULT NULL
)
RETURNS public.circuit_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state    public.circuit_state;
  v_failures int;
  v_reopen   int;
BEGIN
  INSERT INTO public.circuit_breakers AS c
    (resource_type, resource_key, state, failure_count, last_failure_at, reason, updated_at)
  VALUES (p_resource_type, p_resource_key, 'closed', 1, now(), p_reason, now())
  ON CONFLICT (resource_type, resource_key) DO UPDATE
    SET failure_count   = c.failure_count + 1,
        last_failure_at = now(),
        reason          = COALESCE(p_reason, c.reason),
        updated_at      = now()
  RETURNING state, failure_count, reopen_count INTO v_state, v_failures, v_reopen;

  IF v_state = 'half_open' THEN
    -- Probe falhou → reabre com backoff exponencial. NB: QUALQUER falha
    -- observada durante half_open reabre (não há nonce de probe); um caller
    -- antigo que começou em closed e só falha agora também reabre — conservador.
    UPDATE public.circuit_breakers
       SET state = 'open', opened_at = now(),
           next_probe_at = now() + make_interval(
             secs => (p_cooldown_seconds * power(2, LEAST(v_reopen, 6)))::int),
           reopen_count = reopen_count + 1,
           probes_sent = 0, probes_succeeded = 0, half_open_started_at = NULL,
           updated_at = now()
     WHERE resource_type = p_resource_type AND resource_key = p_resource_key
     RETURNING state INTO v_state;
  ELSIF v_state = 'closed' AND v_failures >= GREATEST(p_threshold, 1) THEN
    UPDATE public.circuit_breakers
       SET state = 'open', opened_at = now(),
           next_probe_at = now() + make_interval(secs => p_cooldown_seconds),
           updated_at = now()
     WHERE resource_type = p_resource_type AND resource_key = p_resource_key
     RETURNING state INTO v_state;
  END IF;

  RETURN v_state;
END;
$$;

COMMENT ON FUNCTION app.circuit_record_failure(text, text, int, int, text) IS
  'Registra falha (upsert + increment atômico). Em half_open reabre com backoff '
  'exponencial; em closed abre quando failure_count >= p_threshold (5). Retorna '
  'o estado resultante. p_reason já vem redatado pelo caller. Spec §4.2 / §5.8 (T-318).';

-- ============================================================================
-- 5. Grants — só service_role (workers); REVOKE do resto
-- ============================================================================
REVOKE EXECUTE ON FUNCTION app.rate_limit_consume(text, text, timestamptz, interval)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.circuit_begin(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.circuit_record_success(text, text, int)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.circuit_record_failure(text, text, int, int, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION app.rate_limit_consume(text, text, timestamptz, interval)
  TO service_role;
GRANT EXECUTE ON FUNCTION app.circuit_begin(text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION app.circuit_record_success(text, text, int)
  TO service_role;
GRANT EXECUTE ON FUNCTION app.circuit_record_failure(text, text, int, int, text)
  TO service_role;

-- ============================================================================
-- 6. Registro da migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260621120000_app_resilience_functions',
  'Funções SQL atômicas p/ os helpers de resiliência dos workers: '
  'rate_limit_consume (token-bucket) + circuit_begin/record_success/record_failure '
  '(state machine do circuit breaker). SECURITY DEFINER, EXECUTE só service_role.'
)
ON CONFLICT (migration_name) DO NOTHING;
