/**
 * runs.ts — `*_runs` row lifecycle helper.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * `withRunRow(table, initial, fn)` inserts a row into `sync_runs`,
 * `extraction_runs` or `eviction_runs` at the start of work, then on
 * completion UPDATEs `status`, `duration_ms`, `error_summary` based on
 * whether `fn` resolved or threw. The run_id is passed to `fn` so the
 * caller can correlate child entities.
 *
 * STUB: signatures only — full implementation deferred.
 */

export type RunsTable = 'sync_runs' | 'extraction_runs' | 'eviction_runs';

export type RunInitial = Record<string, unknown>;

/**
 * Wraps work in a run row. Always resolves or rethrows whatever `fn` did;
 * the run row's final status is set as a side-effect.
 */
export async function withRunRow<T>(
  table: RunsTable,
  initial: RunInitial,
  fn: (run_id: string) => Promise<T>,
): Promise<T> {
  // STUB: generate a synthetic run_id so callers can wire flow today.
  void table;
  void initial;
  const run_id = crypto.randomUUID();
  return await fn(run_id);
}
