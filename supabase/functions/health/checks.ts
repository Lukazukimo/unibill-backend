/**
 * health/checks.ts — pure health classification (§11.4) + the small transforms
 * the handler feeds with DB rows. No I/O, fully unit-tested.
 *
 * Ref: T-613 (#124), spec §11.4 / §E (GET /health).
 * Date: 2026-06-25
 *
 * Status matrix (§11.4):
 *   - down  (503): db unreachable OR capacity=red OR ai_chain open > 1h
 *   - degraded (200): a soft check fails — capacity=orange OR last sync > 90min
 *   - ok    (200): db reachable, sync < 90min, capacity green/yellow, ai_chain
 *                  not open > 1h
 * Missing data (no sync run yet / no capacity snapshot) does NOT alarm — absence
 * of a signal is treated as healthy so a fresh deploy isn't reported degraded.
 */

export type CapacityStatus = 'green' | 'yellow' | 'orange' | 'red';
export type CircuitState = 'closed' | 'open' | 'half_open';
export type HealthStatus = 'ok' | 'degraded' | 'down';

export const SYNC_STALE_MINUTES = 90;
export const AI_CHAIN_DOWN_MINUTES = 60;

export type HealthSignals = {
  dbOk: boolean;
  /** Minutes since the last sync_run started; null when none has ever run. */
  lastSyncMinutesAgo: number | null;
  /** Worst capacity status of the latest snapshot; null when none exists. */
  capacityStatus: CapacityStatus | null;
  aiChainState: CircuitState;
  /** Minutes the ai_chain breaker has been open; null when not open. */
  aiChainOpenMinutes: number | null;
};

const CAPACITY_RANK: Record<CapacityStatus, number> = { green: 0, yellow: 1, orange: 2, red: 3 };

/** Returns the more severe of two capacity statuses. */
export function worstCapacity(a: CapacityStatus, b: CapacityStatus): CapacityStatus {
  return CAPACITY_RANK[a] >= CAPACITY_RANK[b] ? a : b;
}

/** Classifies overall health into a status + HTTP code per §11.4. */
export function classifyHealth(s: HealthSignals): { status: HealthStatus; code: 200 | 503 } {
  const aiOpenTooLong = s.aiChainState === 'open' &&
    s.aiChainOpenMinutes !== null &&
    s.aiChainOpenMinutes > AI_CHAIN_DOWN_MINUTES;

  if (!s.dbOk || s.capacityStatus === 'red' || aiOpenTooLong) {
    return { status: 'down', code: 503 };
  }

  const syncStale = s.lastSyncMinutesAgo !== null && s.lastSyncMinutesAgo > SYNC_STALE_MINUTES;
  const capacityDegraded = s.capacityStatus === 'orange';
  if (syncStale || capacityDegraded) {
    return { status: 'degraded', code: 200 };
  }

  return { status: 'ok', code: 200 };
}

/** Whole minutes between `iso` and `nowMs`; null when `iso` is null. */
export function minutesSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  return Math.floor((nowMs - new Date(iso).getTime()) / 60_000);
}

export type QueueDepthSummary = { invoice: number; email: number; dlq: number };

/** Maps the pgmq depth map to {invoice, email, dlq} (both DLQs summed). */
export function summarizeQueueDepths(map: Record<string, number>): QueueDepthSummary {
  const n = (k: string) => (typeof map[k] === 'number' ? map[k] : 0);
  return {
    invoice: n('invoice_queue'),
    email: n('email_sync_queue'),
    dlq: n('invoice_dlq') + n('email_sync_dlq'),
  };
}

export type CircuitRow = { state: CircuitState; opened_at: string | null };

/**
 * Collapses the ai_chain breaker rows into a single state + how long it has
 * been open. State precedence: open > half_open > closed. When multiple rows
 * are open, reports the longest-open duration (the worst case for "open > 1h").
 */
export function reduceAiChain(
  rows: CircuitRow[],
  nowMs: number,
): { state: CircuitState; openMinutes: number | null } {
  const openRows = rows.filter((r) => r.state === 'open');
  if (openRows.length > 0) {
    const mins = openRows
      .map((r) => minutesSince(r.opened_at, nowMs))
      .filter((m): m is number => m !== null);
    return { state: 'open', openMinutes: mins.length > 0 ? Math.max(...mins) : null };
  }
  if (rows.some((r) => r.state === 'half_open')) {
    return { state: 'half_open', openMinutes: null };
  }
  return { state: 'closed', openMinutes: null };
}
