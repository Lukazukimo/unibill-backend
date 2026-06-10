/**
 * circuit.ts — per-resource circuit breaker.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * Reads the row keyed `(resource_type, resource_key)` from `circuit_breakers`
 * and short-circuits with `CircuitOpenError` when state == 'open'. Transitions
 * to 'half_open' happen via an atomic UPDATE with RETURNING so parallel probes
 * don't double-fire (spec §4.2).
 *
 * STUB: signatures only — full implementation deferred.
 */

import { CircuitOpenError } from './errors.ts';

export type CircuitState = {
  state: 'closed' | 'open' | 'half_open';
  opened_at: Date | null;
  next_probe_at: Date | null;
  reopen_count: number;
  reason: string | null;
};

/**
 * Returns the current circuit state for a `(resource_type, resource_key)` pair.
 * STUB: always returns a synthetic 'closed' state.
 */
export function getCircuitState(
  _resource_type: string,
  _resource_key: string,
): Promise<CircuitState> {
  return Promise.resolve({
    state: 'closed',
    opened_at: null,
    next_probe_at: null,
    reopen_count: 0,
    reason: null,
  });
}

/**
 * Wraps an async function with the circuit breaker. Throws `CircuitOpenError`
 * if the circuit is open. On success in `half_open`, closes the circuit. On
 * failure, increments `reopen_count` and arms the next probe.
 */
export async function withCircuitBreaker<T>(
  resource_type: string,
  resource_key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const state = await getCircuitState(resource_type, resource_key);
  if (state.state === 'open') {
    throw new CircuitOpenError(resource_type, resource_key, state.reason);
  }
  // STUB: no failure-counting / state mutation yet.
  return await fn();
}
