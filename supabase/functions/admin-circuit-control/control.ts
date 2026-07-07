// =============================================================================
// admin-circuit-control/control.ts
// -----------------------------------------------------------------------------
// Pure request validation + circuit-breaker row shaping for the sys-admin
// chain-health force/simulate actions (#32 / T-528, backend T-633).
//
// force_open / force_closed are admin overrides written straight to
// circuit_breakers; simulate_failure goes through the normal
// app.circuit_record_failure state machine (may trip after the threshold).
// =============================================================================

export type CircuitAction = 'force_open' | 'force_closed' | 'simulate_failure';
export const CIRCUIT_ACTIONS: CircuitAction[] = [
  'force_open',
  'force_closed',
  'simulate_failure',
];

/// Allowed resource types (AI/OCR chains) — guards against forcing arbitrary
/// breaker rows into existence.
export const CIRCUIT_RESOURCE_TYPES = [
  'ai_chain',
  'ai_provider',
  'ocr_chain',
  'ocr_provider',
];

export type ControlRequest = {
  resource_type: string;
  resource_key: string;
  action: CircuitAction;
  reason: string | null;
};

/** Validates the POST body; returns null when malformed (→ 422). */
export function parseRequest(raw: unknown): ControlRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const rt = o.resource_type;
  const rk = o.resource_key;
  const action = o.action;
  if (typeof rt !== 'string' || !CIRCUIT_RESOURCE_TYPES.includes(rt)) return null;
  if (typeof rk !== 'string' || rk.length === 0 || rk.length > 100) return null;
  if (typeof action !== 'string' || !CIRCUIT_ACTIONS.includes(action as CircuitAction)) {
    return null;
  }
  const reason = typeof o.reason === 'string' && o.reason.length > 0
    ? o.reason.slice(0, 500)
    : null;
  return { resource_type: rt, resource_key: rk, action: action as CircuitAction, reason };
}

/**
 * The circuit_breakers state columns to upsert for a force action. Returns the
 * fields only (the caller merges resource_type + resource_key).
 */
export function breakerRow(
  action: 'force_open' | 'force_closed',
  reason: string | null,
  now: Date,
  cooldownSeconds = 60,
): Record<string, unknown> {
  const iso = now.toISOString();
  // A forced state is a clean, deterministic override: reset the half-open /
  // backoff counters too, so an admin "reset" can't leave a stale probes_* or
  // reopen_count behind to corrupt a later outage's cooldown (upsert on an
  // existing row only writes the columns present here — no trigger backfills).
  const resetCounters = {
    probes_sent: 0,
    probes_succeeded: 0,
    reopen_count: 0,
  };
  if (action === 'force_open') {
    return {
      state: 'open',
      failure_count: 1,
      opened_at: iso,
      closed_at: null,
      half_open_started_at: null,
      next_probe_at: new Date(now.getTime() + cooldownSeconds * 1000).toISOString(),
      reason,
      updated_at: iso,
      ...resetCounters,
    };
  }
  return {
    state: 'closed',
    failure_count: 0,
    opened_at: null,
    closed_at: iso,
    half_open_started_at: null,
    next_probe_at: null,
    reason: null,
    updated_at: iso,
    ...resetCounters,
  };
}
