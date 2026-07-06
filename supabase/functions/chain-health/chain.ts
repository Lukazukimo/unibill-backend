// =============================================================================
// chain-health/chain.ts
// -----------------------------------------------------------------------------
// Pure mapping of `circuit_breakers` rows into the sys-admin chain-health view
// (#32 / T-528). Each row is one per-provider breaker (AI or OCR chain); the
// mobile groups them by `resource_type` and derives the tri-state chain pill.
// =============================================================================

export type CircuitBreakerRow = {
  resource_type: string;
  resource_key: string;
  state: string;
  failure_count: number;
  last_failure_at: string | null;
  opened_at: string | null;
  reason: string | null;
  probes_sent: number;
  probes_succeeded: number;
  updated_at: string;
};

export type BreakerView = {
  resource_type: string;
  resource_key: string;
  state: string;
  failure_count: number;
  last_failure_at: string | null;
  opened_at: string | null;
  reason: string | null;
  probes_sent: number;
  probes_succeeded: number;
  updated_at: string;
};

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

/** Shapes one breaker row into the chain-health response, coercing/defaulting. */
export function toBreaker(row: CircuitBreakerRow): BreakerView {
  return {
    resource_type: row.resource_type,
    resource_key: row.resource_key,
    state: row.state,
    failure_count: num(row.failure_count),
    last_failure_at: row.last_failure_at ?? null,
    opened_at: row.opened_at ?? null,
    reason: row.reason ?? null,
    probes_sent: num(row.probes_sent),
    probes_succeeded: num(row.probes_succeeded),
    updated_at: row.updated_at,
  };
}
