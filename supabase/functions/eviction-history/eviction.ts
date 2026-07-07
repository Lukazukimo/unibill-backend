// =============================================================================
// eviction-history/eviction.ts
// -----------------------------------------------------------------------------
// Pure row shaping + limit parsing for the sys-admin eviction-history browser
// (#34 / T-529). eviction_runs is a low-volume ops log (a row only when capacity
// crosses a threshold), so a simple "most recent N" read suffices — no keyset.
// =============================================================================

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// deno-lint-ignore no-explicit-any
type Json = any;

export type EvictionRunView = {
  id: string;
  resource_type: string;
  trigger_reason: string;
  trigger_pct: number;
  target_pct: number;
  final_pct: number | null;
  total_freed_bytes: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  steps: Json;
  error_summary: string | null;
};

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
const numOrNull = (v: unknown): number | null => (v == null ? null : num(v));

export function parseLimit(params: URLSearchParams): number {
  let limit = Number.parseInt(params.get('limit') ?? '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return limit;
}

export function toRun(row: Record<string, unknown>): EvictionRunView {
  return {
    id: String(row.id),
    resource_type: String(row.resource_type),
    trigger_reason: String(row.trigger_reason),
    trigger_pct: num(row.trigger_pct),
    target_pct: num(row.target_pct),
    final_pct: numOrNull(row.final_pct),
    total_freed_bytes: num(row.total_freed_bytes),
    status: String(row.status),
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    duration_ms: row.duration_ms == null ? null : num(row.duration_ms),
    steps: row.steps ?? [],
    error_summary: row.error_summary == null ? null : String(row.error_summary),
  };
}
