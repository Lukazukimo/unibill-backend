// =============================================================================
// capacity-status/status.ts
// -----------------------------------------------------------------------------
// Pure mapping of a `capacity_snapshots` row into the sys-admin dashboard's
// capacity view (#31 / T-527). The dashboard shows DB + storage gauges (percent
// + green/yellow/orange/red status), queue depths, and the thresholds in force.
// =============================================================================

// deno-lint-ignore no-explicit-any
type Json = any;

export type CapacitySnapshotRow = {
  checked_at: string;
  db_pct: number;
  db_status: string;
  storage_pct: number;
  storage_status: string;
  queue_depths: Json;
  thresholds_snapshot: Json;
};

export type CapacityStatus = {
  checked_at: string;
  db: { pct: number; status: string };
  storage: { pct: number; status: string };
  queue_depths: Json;
  thresholds: Json;
};

/** Shapes a raw snapshot row into the dashboard response. */
export function toStatus(row: CapacitySnapshotRow): CapacityStatus {
  return {
    checked_at: row.checked_at,
    db: { pct: Number(row.db_pct), status: row.db_status },
    storage: { pct: Number(row.storage_pct), status: row.storage_status },
    queue_depths: row.queue_depths ?? {},
    thresholds: row.thresholds_snapshot ?? {},
  };
}
