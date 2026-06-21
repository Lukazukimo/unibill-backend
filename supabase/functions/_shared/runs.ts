/**
 * runs.ts — `*_runs` row lifecycle helper.
 *
 * Ref: T-321, spec §5.6 (sync_runs / extraction_runs) / §4.2.1
 * Date: 2026-06-21 (replaces the T-125 stub)
 *
 * `withRunRow(table, initial, fn, deps)` INSERTs a row with `status='running'`
 * at the start of work, runs `fn(run_id)`, then UPDATEs the row to its terminal
 * status:
 *   - success: `status='success'` (or whatever `deps.finalize` returns) +
 *     `finished_at` + `duration_ms` + any metrics from `finalize`.
 *   - failure: `status='failed'` + `errors_count=1` +
 *     `error_summary = redactSecrets(err.message)`, then rethrows.
 *
 * The terminal UPDATE is best-effort relative to `fn`'s own work: `fn` always
 * resolves/rethrows as written; the run row is a side-effect. `run_id` is passed
 * to `fn` so it can correlate child rows (invoices, events).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { log } from './logging.ts';
import { redactSecrets } from './redact.ts';

// Only tables that actually exist. `errors_count` lives ONLY on sync_runs.
export type RunsTable = 'sync_runs' | 'extraction_runs';

export type RunInitial = Record<string, unknown>;

export type WithRunRowDeps<T> = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
  /**
   * Maps `fn`'s result onto the terminal-UPDATE patch (metrics + an optional
   * status override, e.g. `{ status: 'partial', invoices_created: 2 }`). The
   * patch is spread AFTER `status: 'success'`, so it can override the status.
   */
  finalize?: (result: T) => Record<string, unknown>;
  /** Monotonic clock in ms (defaults to `Date.now`); injectable for tests. */
  clock?: () => number;
};

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function withRunRow<T>(
  table: RunsTable,
  initial: RunInitial,
  fn: (run_id: string) => Promise<T>,
  deps?: WithRunRowDeps<T>,
): Promise<T> {
  const client = deps?.client ?? buildServiceClient();
  const clock = deps?.clock ?? (() => Date.now());
  const startedMs = clock();

  const { data, error } = await client
    .from(table)
    .insert({ ...initial, status: 'running' })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(
      `withRunRow: failed to open ${table} row: ${error?.message ?? 'no id returned'}`,
    );
  }
  const run_id = (data as { id: string }).id;

  try {
    const result = await fn(run_id);
    const endMs = clock();
    const patch = deps?.finalize ? deps.finalize(result) : {};
    const { error: updErr } = await client.from(table).update({
      status: 'success',
      finished_at: new Date(endMs).toISOString(),
      duration_ms: endMs - startedMs,
      ...patch,
    }).eq('id', run_id);
    if (updErr) {
      log.warn('withRunRow: terminal success UPDATE failed', {
        table,
        run_id,
        err: redactSecrets(updErr.message),
      });
    }
    return result;
  } catch (e) {
    const endMs = clock();
    const msg = e instanceof Error ? e.message : String(e);
    // `errors_count` exists ONLY on sync_runs — extraction_runs has no such
    // column, so including it there would make the terminal UPDATE error out
    // and leave the row stuck at status='running'.
    const failPatch: Record<string, unknown> = {
      status: 'failed',
      finished_at: new Date(endMs).toISOString(),
      duration_ms: endMs - startedMs,
      error_summary: redactSecrets(msg),
    };
    if (table === 'sync_runs') {
      failPatch.errors_count = 1;
    }
    const { error: updErr } = await client.from(table).update(failPatch).eq('id', run_id);
    if (updErr) {
      log.warn('withRunRow: terminal failure UPDATE failed', {
        table,
        run_id,
        err: redactSecrets(updErr.message),
      });
    }
    throw e;
  }
}
