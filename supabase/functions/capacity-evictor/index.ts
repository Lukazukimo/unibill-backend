/**
 * capacity-evictor — POST /capacity-evictor (pg_cron, every 1 min). pgmq
 * consumer of capacity_eviction_queue. Per job it opens an eviction_runs row
 * (withRunRow) and frees space until usage <= target_pct or the runtime cap:
 *   - resource_type='db'      → tier-escalation (tier.ts §10.3): trim logs at the
 *                               adaptive floor, then floor/2, floor/4, then evict
 *                               old invoices, then capacity.critical + pause.
 *   - resource_type='storage' → PDF archive (archive_pdf.ts §10.4 / BR-016).
 * ACK on a completed run; backoff (set_vt) on a thrown error; DLQ after 3 deliveries.
 *
 * Ref: T-603 (#111), spec §10.3 / §10.4 / §10.6 / §D, BR-013 / BR-016.
 * Date: 2026-06-25
 *
 * The eviction itself is injected via `runEviction` (default = the real SQL +
 * Storage glue below) so the consumer loop is unit-tested with a fake; the tier
 * engine + PDF archive are tested in tier.test.ts / archive_pdf.test.ts.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { getGlobalConfig, readNumberConfig } from '../_shared/config.ts';
import { requireServiceRole } from '../_shared/serviceAuth.ts';
import {
  queueDelete,
  type QueueMessage,
  queueRead,
  queueSetVt,
  queueToDlq,
} from '../_shared/queue.ts';
import { withRunRow } from '../_shared/runs.ts';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';
import { measure } from '../capacity-monitor/measure.ts';
import { usagePct } from '../capacity-monitor/classify.ts';
import { escalate, type TierStep } from './tier.ts';
import { archivePdfs, type PdfRow } from './archive_pdf.ts';

export const CAPACITY_EVICTION_QUEUE = 'capacity_eviction_queue';
export const CAPACITY_EVICTION_DLQ = 'capacity_eviction_dlq';
const WORKER_READ_BATCH = 5;
const VISIBILITY_S = 120; // §4.3
const MAX_RETRIES = 3; // §4.3
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type EvictionJob = {
  resource_type: 'db' | 'storage';
  trigger_reason: string;
  trigger_pct: number;
  target_pct: number;
  correlation_id: string;
};

export interface EvictionResult {
  steps: TierStep[];
  finalPct: number;
  converged: boolean;
  freedBytes: number;
}

export type RunEvictionFn = (
  job: EvictionJob,
  runId: string,
  client: SupabaseClient,
) => Promise<EvictionResult>;

export type HandlerDeps = {
  client?: SupabaseClient;
  requireAuth?: (req: Request) => boolean;
  now?: () => number;
  runEviction?: RunEvictionFn;
};

type Outcome = 'done' | 'dlq' | 'retry';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 1800);
}

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const requireAuth = deps.requireAuth ?? ((req: Request) => requireServiceRole(req));
  const now = deps.now ?? (() => Date.now());
  const runEviction = deps.runEviction ?? defaultRunEviction;

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
    if (!requireAuth(req)) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'service_role required' });
    }
    const client = deps.client ?? buildServiceClient();

    let msgs: Array<QueueMessage<EvictionJob>>;
    try {
      msgs = await queueRead<EvictionJob>(
        CAPACITY_EVICTION_QUEUE,
        VISIBILITY_S,
        WORKER_READ_BATCH,
        {
          client,
        },
      );
    } catch (e) {
      log.error('capacity-evictor: queue read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'read_failed' });
    }

    const tally = { processed: 0, done: 0, dlq: 0, retried: 0 };
    for (const msg of msgs) {
      tally.processed++;
      const outcome = await processOne(msg, { client, now, runEviction, ctx });
      if (outcome === 'done') tally.done++;
      else if (outcome === 'dlq') tally.dlq++;
      else tally.retried++;
    }
    return jsonResponse(200, tally);
  });
}

async function processOne(
  msg: QueueMessage<EvictionJob>,
  p: {
    client: SupabaseClient;
    now: () => number;
    runEviction: RunEvictionFn;
    ctx: { correlation_id: string };
  },
): Promise<Outcome> {
  const { client, now, runEviction, ctx } = p;
  const job = msg.message;
  const correlationId = job.correlation_id ?? ctx.correlation_id;

  // Dead-letter a poison message after MAX_RETRIES deliveries.
  if (msg.read_ct > MAX_RETRIES) {
    await queueToDlq(CAPACITY_EVICTION_QUEUE, CAPACITY_EVICTION_DLQ, msg.msg_id, job, { client });
    return 'dlq';
  }

  try {
    await withRunRow(
      'eviction_runs',
      {
        correlation_id: correlationId,
        resource_type: job.resource_type,
        trigger_reason: job.trigger_reason,
        trigger_pct: job.trigger_pct,
        target_pct: job.target_pct,
      },
      (runId) => runEviction({ ...job, correlation_id: correlationId }, runId, client),
      {
        client,
        clock: now,
        finalize: (r: EvictionResult) => ({
          status: r.converged ? 'success' : 'partial',
          final_pct: r.finalPct,
          total_freed_bytes: r.freedBytes,
          steps: r.steps,
        }),
      },
    );
    await queueDelete(CAPACITY_EVICTION_QUEUE, msg.msg_id, { client });
    return 'done';
  } catch (e) {
    log.warn('capacity-evictor: run failed', {
      correlation_id: ctx.correlation_id,
      err: redactSecrets(e instanceof Error ? e.message : String(e)),
    });
    await queueSetVt(CAPACITY_EVICTION_QUEUE, msg.msg_id, backoffSeconds(msg.read_ct), { client });
    return 'retry';
  }
}

// ---------------------------------------------------------------------------
// Production eviction glue (not unit-tested — exercised via integration). Tiers
// + PDF archive logic live in tier.ts / archive_pdf.ts and ARE tested.
// ---------------------------------------------------------------------------

export const defaultRunEviction: RunEvictionFn = async (job, runId, client) => {
  const cfg = await getGlobalConfig([
    'capacity.db_limit_bytes',
    'capacity.storage_limit_bytes',
    'capacity.eviction_max_runtime_ms',
    'retention.sync_runs.adaptive_floor_days',
    'retention.invoices.adaptive_floor_days',
    'capacity.pdf_min_retention_days',
  ], { client });
  const dbLimit = readNumberConfig(cfg, 'capacity.db_limit_bytes', 524_288_000);
  const storageLimit = readNumberConfig(cfg, 'capacity.storage_limit_bytes', 1_073_741_824);
  const maxRuntimeMs = readNumberConfig(cfg, 'capacity.eviction_max_runtime_ms', 45_000);
  const logFloor = readNumberConfig(cfg, 'retention.sync_runs.adaptive_floor_days', 7);
  const invoiceFloor = readNumberConfig(cfg, 'retention.invoices.adaptive_floor_days', 1095);
  const pdfFloor = readNumberConfig(cfg, 'capacity.pdf_min_retention_days', 365);

  const isStorage = job.resource_type === 'storage';
  const limit = isStorage ? storageLimit : dbLimit;
  const measurePct = async () => {
    const m = await measure(client);
    return usagePct(isStorage ? m.storage_bytes : m.db_bytes, limit);
  };
  const measureBytes = async () =>
    (await measure(client))[isStorage ? 'storage_bytes' : 'db_bytes'];
  const bytesBefore = await measureBytes();

  let result: { steps: TierStep[]; finalPct: number; converged: boolean };
  if (isStorage) {
    const archived = await archivePdfs({
      correlationId: job.correlation_id,
      listOldPdfs: () => listOldPdfs(client, pdfFloor),
      deleteObject: async (bucket, path) => {
        const { error } = await client.storage.from(bucket).remove([path]);
        if (error) throw new Error(`storage remove failed: ${error.message}`);
      },
      recordArchive: (inv) => recordArchive(client, inv, runId),
      emitEvent: (e) => emitDomainEvent(e, { client }),
      onError: (inv, err) =>
        log.warn('capacity-evictor: pdf archive item failed', {
          invoice_id: inv.id,
          err: redactSecrets(err instanceof Error ? err.message : String(err)),
        }),
    });
    const finalPct = await measurePct();
    result = {
      steps: [{
        tier: 0,
        action: 'pdf_archive',
        detail: { archived: archived.archived, failed: archived.failed },
      }],
      finalPct,
      converged: finalPct <= job.target_pct,
    };
  } else {
    const esc = await escalate({
      measurePct,
      runTier: (tier) => runDbTier(client, tier, logFloor, invoiceFloor, job.correlation_id),
      onCritical: async () => {
        await emitDomainEvent({
          type: 'capacity.critical',
          aggregate_type: 'capacity',
          aggregate_id: NIL_UUID,
          correlation_id: job.correlation_id,
          actor_type: 'system',
          payload: { version: 1, data: { resource_type: job.resource_type } },
        }, { client });
        await setIngestion(client, false);
      },
      targetPct: job.target_pct,
      maxRuntimeMs,
      now: () => Date.now(),
    });
    result = { steps: esc.steps, finalPct: esc.finalPct, converged: esc.converged };
  }

  const bytesAfter = await measureBytes();
  return { ...result, freedBytes: Math.max(0, bytesBefore - bytesAfter) };
};

/** §10.3 db tier: 1 trims logs at the floor, 2 floor/2, 3 floor/4 (min 1), 4 evicts old invoices. */
async function runDbTier(
  client: SupabaseClient,
  tier: number,
  logFloor: number,
  invoiceFloor: number,
  correlationId: string,
): Promise<{ action: string; detail: Record<string, unknown> }> {
  if (tier <= 3) {
    const floor = tier === 1
      ? logFloor
      : tier === 2
      ? Math.floor(logFloor / 2)
      : Math.max(1, Math.floor(logFloor / 4));
    const cutoff = new Date(Date.now() - floor * 86_400_000).toISOString();
    for (const table of ['sync_runs', 'extraction_runs']) {
      await client.from(table).delete().lt('started_at', cutoff);
    }
    await emitDomainEvent({
      type: 'capacity.eviction.tier_escalated',
      aggregate_type: 'capacity',
      aggregate_id: NIL_UUID,
      correlation_id: correlationId,
      actor_type: 'system',
      payload: { version: 1, data: { tier, floor_days: floor } },
    }, { client });
    return { action: 'trim_logs', detail: { floor_days: floor, cutoff } };
  }
  // Tier 4: evict invoices older than the adaptive floor (batch of 100).
  const cutoff = new Date(Date.now() - invoiceFloor * 86_400_000).toISOString();
  const { data } = await client
    .from('invoices')
    .select('id')
    .lt('created_at', cutoff)
    .is('deleted_at', null)
    .limit(100);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
  if (ids.length > 0) {
    await client.from('invoices').delete().in('id', ids);
    await emitDomainEvent({
      type: 'capacity.eviction.tier_escalated',
      aggregate_type: 'capacity',
      aggregate_id: NIL_UUID,
      correlation_id: correlationId,
      actor_type: 'system',
      payload: { version: 1, data: { tier: 4, evicted_invoices: ids.length } },
    }, { client });
  }
  return { action: 'evict_invoices', detail: { evicted: ids.length, cutoff } };
}

async function listOldPdfs(client: SupabaseClient, pdfFloorDays: number): Promise<PdfRow[]> {
  const cutoff = new Date(Date.now() - pdfFloorDays * 86_400_000).toISOString();
  const { data, error } = await client
    .from('invoices')
    .select('id, household_id, storage_bucket, storage_path, file_hash, file_size_bytes')
    .not('storage_path', 'is', null)
    .is('pdf_archived_at', null)
    .lt('created_at', cutoff)
    .limit(100);
  if (error) throw new Error(`listOldPdfs failed: ${error.message}`);
  return (data ?? []) as unknown as PdfRow[];
}

async function recordArchive(client: SupabaseClient, inv: PdfRow, runId: string): Promise<void> {
  await client.from('invoices').update({ pdf_archived_at: new Date().toISOString() }).eq(
    'id',
    inv.id,
  );
  await client.from('pdf_archive_log').insert({
    invoice_id: inv.id,
    original_path: inv.storage_path,
    file_hash: inv.file_hash,
    file_size_bytes: inv.file_size_bytes ?? 0,
    archived_by_run: runId,
    archive_reason: 'capacity_storage_eviction',
  });
}

async function setIngestion(client: SupabaseClient, enabled: boolean): Promise<void> {
  await client
    .from('app_settings')
    .update({ value: { v: enabled } })
    .eq('key', 'features.ingestion_enabled')
    .eq('scope', 'global');
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
