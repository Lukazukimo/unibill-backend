/**
 * sync-dispatcher — POST /sync-dispatcher (pg_cron, every 1 min via
 * private.invoke_edge_function). Selects the connected_emails due for an IMAP
 * sync and enqueues one job per mailbox onto `email_sync_queue` for the
 * sync-worker to process.
 *
 * Ref: T-324, spec §4.4 / §6.1 / §6.6 / §9.1
 * Date: 2026-06-21
 *
 * Flow:
 *   1. POST only (405 otherwise).
 *   2. Service-role bearer check (401) — defense-in-depth vs external calls.
 *   3. Gate on features.ingestion_enabled (master kill-switch) → skip if off.
 *   4. SELECT active mailboxes whose last_sync_at is null or older than
 *      sync.interval_minutes, oldest first, up to sync.batch_size.
 *   5. Drop mailboxes whose IMAP circuit breaker is OPEN (the worker would
 *      reject them anyway — avoid pointless queue churn).
 *   6. Enqueue {connected_email_id, correlation_id, idempotency_key, attempt}
 *      onto email_sync_queue. idempotency_key = `<email_id>:<minute-floor>` so a
 *      double-fire in the same minute dedupes at the worker (sync_runs unique).
 *
 * Returns 200 with { enqueued, selected, skipped_open_circuit } (or
 * { skipped: 'ingestion_disabled', enqueued: 0 }). The dispatcher does NOT emit
 * per-dispatch domain events — the worker's sync_runs row is the per-mailbox
 * observability record.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { getGlobalConfig, readBoolConfig, readNumberConfig } from '../_shared/config.ts';
import { requireServiceRole } from '../_shared/serviceAuth.ts';
import { queueSend } from '../_shared/queue.ts';
import { log } from '../_shared/logging.ts';

export const EMAIL_SYNC_QUEUE = 'email_sync_queue';

const CFG_INGESTION_ENABLED = 'features.ingestion_enabled';
const CFG_BATCH_SIZE = 'sync.batch_size';
const CFG_INTERVAL_MINUTES = 'sync.interval_minutes';

export type HandlerDeps = {
  client?: SupabaseClient;
  /** Auth predicate (defaults to the service-role gate); injectable for tests. */
  requireAuth?: (req: Request) => boolean;
  /** ms-epoch clock (defaults to Date.now); injectable for tests. */
  now?: () => number;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type ConnectedEmailRow = { id: string; email_address: string };

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const requireAuth = deps.requireAuth ?? ((req: Request) => requireServiceRole(req));
  const now = deps.now ?? (() => Date.now());

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }
    if (!requireAuth(req)) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'service_role required' });
    }

    const client = deps.client ?? buildServiceClient();
    const nowMs = now();

    // 1) Config gate + batch params. A config-store read failure must not crash
    //    the handler (withCorrelation does not wrap errors) — return a logged
    //    500 like the other query branches.
    let cfg: Map<string, unknown>;
    try {
      cfg = await getGlobalConfig(
        [CFG_INGESTION_ENABLED, CFG_BATCH_SIZE, CFG_INTERVAL_MINUTES],
        { client },
      );
    } catch (e) {
      log.error('sync-dispatcher: config read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'config_failed' });
    }
    if (!readBoolConfig(cfg, CFG_INGESTION_ENABLED, true)) {
      return jsonResponse(200, { skipped: 'ingestion_disabled', enqueued: 0 });
    }
    const batchSize = readNumberConfig(cfg, CFG_BATCH_SIZE, 3);
    const intervalMinutes = readNumberConfig(cfg, CFG_INTERVAL_MINUTES, 60);

    // 2) Select due mailboxes (active, never synced or stale), oldest first.
    const cutoff = new Date(nowMs - intervalMinutes * 60_000).toISOString();
    const { data: emails, error: emailsErr } = await client
      .from('connected_emails')
      .select('id, email_address')
      .eq('status', 'active')
      .is('deleted_at', null)
      .or(`last_sync_at.is.null,last_sync_at.lt.${cutoff}`)
      .order('last_sync_at', { ascending: true, nullsFirst: true })
      .limit(batchSize);
    if (emailsErr) {
      log.error('sync-dispatcher: connected_emails query failed', {
        correlation_id: ctx.correlation_id,
        err: emailsErr.message,
      });
      return jsonResponse(500, { error: 'internal_error', code: 'select_failed' });
    }
    const due = (emails ?? []) as ConnectedEmailRow[];
    if (due.length === 0) {
      return jsonResponse(200, { enqueued: 0, selected: 0, skipped_open_circuit: 0 });
    }

    // 3) Drop mailboxes with an OPEN imap circuit breaker (best-effort — the
    //    worker's circuit_begin gates regardless, so a query failure is non-fatal).
    //    Only 'open' is pre-filtered; 'half_open' is intentionally admitted so the
    //    worker's circuit_begin can win the atomic open→half_open probe.
    const openKeys = new Set<string>();
    const { data: breakers, error: breakersErr } = await client
      .from('circuit_breakers')
      .select('resource_key')
      .eq('resource_type', 'imap')
      .eq('state', 'open')
      .in('resource_key', due.map((e) => e.email_address));
    if (breakersErr) {
      log.warn('sync-dispatcher: circuit_breakers query failed (proceeding)', {
        correlation_id: ctx.correlation_id,
        err: breakersErr.message,
      });
    } else {
      for (const b of (breakers ?? []) as Array<{ resource_key: string }>) {
        openKeys.add(b.resource_key);
      }
    }

    // 4) Enqueue one job per eligible mailbox.
    //    idempotency_key = `<email_id>:<minute-floor>` dedupes a same-minute
    //    double-fire at the worker (sync_runs unique). KNOWN LIMITATION: a sync
    //    that runs longer than a minute (or a queue backlog) lets the next tick
    //    re-select the same still-in-flight mailbox under a DIFFERENT minute key,
    //    so it is not deduped here — a worker-side in-flight lease closes that gap
    //    (T-325). Data integrity holds meanwhile: invoice dedupe (uq
    //    household+file_hash / email+message_id) prevents duplicate invoices.
    const minuteFloor = new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString();
    let enqueued = 0;
    let skippedOpen = 0;
    for (const email of due) {
      if (openKeys.has(email.email_address)) {
        skippedOpen++;
        continue;
      }
      const payload = {
        connected_email_id: email.id,
        correlation_id: ctx.correlation_id,
        idempotency_key: `${email.id}:${minuteFloor}`,
        attempt: 1,
      };
      try {
        await queueSend(EMAIL_SYNC_QUEUE, payload, { client });
        enqueued++;
      } catch (e) {
        log.warn('sync-dispatcher: enqueue failed (skipping mailbox)', {
          correlation_id: ctx.correlation_id,
          connected_email_id: email.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return jsonResponse(200, {
      enqueued,
      selected: due.length,
      skipped_open_circuit: skippedOpen,
    });
  });
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
