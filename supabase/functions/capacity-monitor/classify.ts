/**
 * classify.ts — pure capacity classification (T-602, spec §10.2 / BR-010..012).
 *
 * pct → status against the green/yellow/orange/red thresholds, plus the helpers
 * the monitor needs to reason about the worst resource and threshold crossings.
 * No I/O — exhaustively unit-tested.
 */

export type CapacityStatus = 'green' | 'yellow' | 'orange' | 'red';

export interface CapacityThresholds {
  yellowPct: number; // capacity.yellow_threshold_pct (70)
  orangePct: number; // capacity.orange_threshold_pct (80)
  redPct: number; // capacity.red_threshold_pct    (90)
}

export const DEFAULT_THRESHOLDS: CapacityThresholds = {
  yellowPct: 70,
  orangePct: 80,
  redPct: 90,
};

const RANK: Record<CapacityStatus, number> = { green: 0, yellow: 1, orange: 2, red: 3 };

/** Usage percent (0..) rounded to 2dp; 0 when the limit is non-positive. */
export function usagePct(bytes: number, limitBytes: number): number {
  if (!(limitBytes > 0)) return 0;
  return Math.round((bytes / limitBytes) * 100 * 100) / 100;
}

/** Map a usage percent to a status (§10.2): >=red→red, >=orange→orange, >=yellow→yellow, else green. */
export function classify(pct: number, t: CapacityThresholds = DEFAULT_THRESHOLDS): CapacityStatus {
  if (pct >= t.redPct) return 'red';
  if (pct >= t.orangePct) return 'orange';
  if (pct >= t.yellowPct) return 'yellow';
  return 'green';
}

/** The more severe of two statuses. */
export function worst(a: CapacityStatus, b: CapacityStatus): CapacityStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/** True when `status` is at least as severe as `min`. */
export function atLeast(status: CapacityStatus, min: CapacityStatus): boolean {
  return RANK[status] >= RANK[min];
}
