/**
 * circuit.ts — per-resource circuit breaker (worker middleware).
 *
 * Ref: T-318, spec §4.2 / §5.8
 * Date: 2026-06-21 (replaces the T-125 stub)
 *
 * `withCircuitBreaker(resource_type, resource_key, fn)` gates `fn` behind the
 * breaker state in `public.circuit_breakers`. Every transition is atomic and
 * delegated to SQL functions (the supabase-js client can't express the
 * conditional UPDATE..RETURNING flip nor counter increments):
 *
 *   - begin → 'open'      : throw CircuitOpenError (do NOT run fn)
 *   - begin → 'closed'    : run fn normally
 *   - begin → 'half_open' : run fn as a probe (this caller won the atomic flip)
 *   - fn ok               : circuit_record_success (closes after N probes)
 *   - fn throws           : circuit_record_failure (may open), then rethrow
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { CircuitOpenError } from './errors.ts';
import { log } from './logging.ts';
import { redactSecrets } from './redact.ts';

export type WithCircuitBreakerDeps = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
  /** Consecutive failures (closed) before opening. Default 5. */
  threshold?: number;
  /** Base cool-down before the first probe, seconds. Default 60. */
  cooldownSeconds?: number;
  /** Successful probes (half_open) needed to close. Default 2. */
  closeAfter?: number;
};

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function withCircuitBreaker<T>(
  resource_type: string,
  resource_key: string,
  fn: () => Promise<T>,
  deps?: WithCircuitBreakerDeps,
): Promise<T> {
  const client = deps?.client ?? buildServiceClient();

  const { data: decision, error: beginErr } = await client.rpc('circuit_begin', {
    p_resource_type: resource_type,
    p_resource_key: resource_key,
  });
  if (beginErr) {
    throw new Error(
      `withCircuitBreaker: begin failed for ${resource_type}:${resource_key}: ${beginErr.message}`,
    );
  }
  if (decision === 'open') {
    throw new CircuitOpenError(resource_type, resource_key);
  }

  try {
    const result = await fn();
    // Bookkeeping is best-effort: never unwind a successful fn just because
    // recording it failed — but DO surface the record failure, else a broken
    // breaker (e.g. schema drift) silently degrades to a no-op that never opens.
    const { error: recErr } = await client.rpc('circuit_record_success', {
      p_resource_type: resource_type,
      p_resource_key: resource_key,
      p_close_after: deps?.closeAfter ?? 2,
    });
    if (recErr) {
      log.warn('circuit_record_success failed', {
        resource_type,
        resource_key,
        err: redactSecrets(recErr.message),
      });
    }
    return result;
  } catch (e) {
    const reason = redactSecrets(e instanceof Error ? e.message : String(e));
    const { error: recErr } = await client.rpc('circuit_record_failure', {
      p_resource_type: resource_type,
      p_resource_key: resource_key,
      p_threshold: deps?.threshold ?? 5,
      p_cooldown_seconds: deps?.cooldownSeconds ?? 60,
      p_reason: reason,
    });
    if (recErr) {
      log.warn('circuit_record_failure failed', {
        resource_type,
        resource_key,
        err: redactSecrets(recErr.message),
      });
    }
    throw e;
  }
}
