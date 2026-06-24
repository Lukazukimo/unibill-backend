/**
 * extraction-worker — POST /extraction-worker (pg_cron, every 1 min). Drains
 * invoice_queue: per invoice it claims the row (queued|extracting → extracting),
 * opens an extraction_runs row, runs the 4-layer cascade (orchestrate.ts),
 * persists the result onto invoices + emits a domain event, ACKing on success
 * and applying backoff / DLQ on failure.
 *
 * Ref: T-418 (worker shell + loop + DLQ) + T-425 (cron). The cascade itself
 *      (orchestrate) + the real OCR/AI provider wiring (wire.ts) are INJECTED via
 *      `runExtraction` so this loop is fully unit-tested with fakes — no real
 *      PDFs, OCR or AI calls.
 * Date: 2026-06-24
 *
 * Per message (`{invoice_id, correlation_id, force?}`):
 *   1. load the invoice — gone ⇒ ACK + skip (orphan message).
 *   2. read_ct past the retry cap ⇒ move to invoice_dlq, mark the invoice failed,
 *      emit invoice.failed.
 *   3. already terminal (extracted/needs_review/failed/duplicate) & !force ⇒
 *      ACK + skip (idempotent — the dispatcher may re-enqueue).
 *   4. claim: atomic UPDATE status→'extracting' WHERE status IN (queued,
 *      extracting) [force: any]. 0 rows & !force ⇒ ACK + skip. (pgmq's VT means a
 *      redelivered 'extracting' has no concurrent holder, so reclaim is safe.)
 *   5. withRunRow('extraction_runs'): download the PDF, run the cascade, persist
 *      buildInvoiceUpdate(outcome) onto invoices, emit invoice.<status>. ACK.
 *      A thrown (infra) error ⇒ run row 'failed' + backoff (set_vt) ⇒ retry; the
 *      invoice stays 'extracting' and is reclaimed on redelivery.
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
import { emitDomainEvent } from '../_shared/events.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';
import type { UtilityParser } from './layers/layer3_regex.ts';
import { buildInvoiceUpdate, type ExtractionOutcome } from './payload.ts';
import type { OrchestrateInput } from './orchestrate.ts';
import { defaultDownloadPdf, defaultLoadParsers, defaultRunExtraction } from './wire.ts';

export const INVOICE_QUEUE = 'invoice_queue';
export const INVOICE_DLQ = 'invoice_dlq';
const WORKER_READ_BATCH = 10;

const CFG_VISIBILITY = 'extraction.visibility_timeout_s';
const CFG_MAX_RETRIES = 'extraction.max_retries';
const CFG_RETRY_BASE = 'extraction.retry_base_s';
const CFG_RETRY_CAP = 'extraction.retry_cap_s';
const CFG_RUNTIME_MS = 'extraction.worker_max_runtime_ms';

const TERMINAL = ['extracted', 'needs_review', 'failed', 'duplicate'];

export type ExtractionJob = {
  invoice_id: string;
  correlation_id: string;
  household_id?: string;
  force?: boolean;
};

export type InvoiceRow = {
  id: string;
  status: string;
  storage_bucket: string;
  storage_path: string;
  household_id: string | null;
  source_sender: string | null;
  source_subject: string | null;
};

/** Runs the 4-layer cascade for one invoice. Injected so the loop is testable. */
export type RunExtractionFn = (
  input: OrchestrateInput,
  client: SupabaseClient,
) => Promise<ExtractionOutcome>;

export type HandlerDeps = {
  client?: SupabaseClient;
  requireAuth?: (req: Request) => boolean;
  now?: () => number;
  runExtraction?: RunExtractionFn;
  loadParsers?: (client: SupabaseClient) => Promise<UtilityParser[]>;
  downloadPdf?: (client: SupabaseClient, bucket: string, path: string) => Promise<Uint8Array>;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function backoffSeconds(attempt: number, baseS: number, capS: number): number {
  return Math.min(baseS * 2 ** Math.max(0, attempt - 1), capS);
}

type Cfg = {
  visibilityS: number;
  maxRetries: number;
  retryBaseS: number;
  retryCapS: number;
  runtimeMs: number;
};

type Outcome = 'done' | 'dlq' | 'skip' | 'retry';

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const requireAuth = deps.requireAuth ?? ((req: Request) => requireServiceRole(req));
  const now = deps.now ?? (() => Date.now());
  const runExtraction = deps.runExtraction ?? defaultRunExtraction;
  const loadParsers = deps.loadParsers ?? defaultLoadParsers;
  const downloadPdf = deps.downloadPdf ?? defaultDownloadPdf;

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
    if (!requireAuth(req)) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'service_role required' });
    }
    const client = deps.client ?? buildServiceClient();

    let cfgMap: Map<string, unknown>;
    try {
      cfgMap = await getGlobalConfig([
        CFG_VISIBILITY,
        CFG_MAX_RETRIES,
        CFG_RETRY_BASE,
        CFG_RETRY_CAP,
        CFG_RUNTIME_MS,
      ], { client });
    } catch (e) {
      log.error('extraction-worker: config read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'config_failed' });
    }
    const cfg: Cfg = {
      visibilityS: readNumberConfig(cfgMap, CFG_VISIBILITY, 90),
      maxRetries: readNumberConfig(cfgMap, CFG_MAX_RETRIES, 3),
      retryBaseS: readNumberConfig(cfgMap, CFG_RETRY_BASE, 60),
      retryCapS: readNumberConfig(cfgMap, CFG_RETRY_CAP, 1800),
      runtimeMs: readNumberConfig(cfgMap, CFG_RUNTIME_MS, 50_000),
    };

    let msgs: Array<QueueMessage<ExtractionJob>>;
    try {
      msgs = await queueRead<ExtractionJob>(INVOICE_QUEUE, cfg.visibilityS, WORKER_READ_BATCH, {
        client,
      });
    } catch (e) {
      log.error('extraction-worker: queue read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'read_failed' });
    }

    // Parsers are global — load once per invocation, not per message.
    let parsers: UtilityParser[];
    try {
      parsers = await loadParsers(client);
    } catch (e) {
      log.error('extraction-worker: parser load failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'parsers_failed' });
    }

    const tally = { processed: 0, done: 0, dlq: 0, skipped: 0, retried: 0 };
    const startMs = now();
    for (const msg of msgs) {
      if (now() - startMs > cfg.runtimeMs) break; // leave the rest for the next tick
      tally.processed++;
      const outcome = await processOne(msg, {
        ctx,
        client,
        cfg,
        now,
        parsers,
        runExtraction,
        downloadPdf,
      });
      if (outcome === 'done') tally.done++;
      else if (outcome === 'dlq') tally.dlq++;
      else if (outcome === 'retry') tally.retried++;
      else tally.skipped++;
    }

    return jsonResponse(200, tally);
  });
}

type ProcessCtx = {
  ctx: { correlation_id: string };
  client: SupabaseClient;
  cfg: Cfg;
  now: () => number;
  parsers: UtilityParser[];
  runExtraction: RunExtractionFn;
  downloadPdf: (client: SupabaseClient, bucket: string, path: string) => Promise<Uint8Array>;
};

async function processOne(msg: QueueMessage<ExtractionJob>, p: ProcessCtx): Promise<Outcome> {
  const { client, cfg, now, ctx, parsers, runExtraction, downloadPdf } = p;
  const job = msg.message;
  const invoiceId = job.invoice_id;
  const correlationId = job.correlation_id ?? ctx.correlation_id;
  const force = job.force === true;
  const nowIso = () => new Date(now()).toISOString();

  // 1) Load the invoice. Orphan message (deleted invoice) → ACK + skip.
  const { data: invRaw } = await client
    .from('invoices')
    .select('id, status, storage_bucket, storage_path, household_id, source_sender, source_subject')
    .eq('id', invoiceId)
    .maybeSingle();
  const invoice = invRaw as InvoiceRow | null;
  if (!invoice) {
    await queueDelete(INVOICE_QUEUE, msg.msg_id, { client });
    return 'skip';
  }

  // 2) Dead-letter: too many deliveries (poison message). Mark the invoice failed.
  if (msg.read_ct > cfg.maxRetries) {
    await queueToDlq(INVOICE_QUEUE, INVOICE_DLQ, msg.msg_id, job, { client });
    await client.from('invoices').update({
      status: 'failed',
      extraction_error: 'max_retries_exceeded',
      extracted_at: nowIso(),
    }).eq('id', invoiceId);
    await emitDomainEvent({
      type: 'invoice.failed',
      aggregate_type: 'invoice',
      aggregate_id: invoiceId,
      household_id: invoice.household_id ?? undefined,
      correlation_id: correlationId,
      actor_type: 'system',
      payload: { version: 1, data: { reason: 'max_retries_exceeded', deliveries: msg.read_ct } },
    }, { client }).catch((e) =>
      log.warn('extraction-worker: dead_lettered event failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      })
    );
    return 'dlq';
  }

  // 3) Already terminal and not a forced re-extract → ACK + skip (idempotent).
  if (!force && TERMINAL.includes(invoice.status)) {
    await queueDelete(INVOICE_QUEUE, msg.msg_id, { client });
    return 'skip';
  }

  // 4) Claim the invoice: atomic status → 'extracting'. Normal claim only from
  //    queued|extracting (reclaim after a crashed attempt is safe under pgmq's
  //    VT — no concurrent holder); a forced re-extract claims from any status.
  let claim = client.from('invoices').update({ status: 'extracting' }).eq('id', invoiceId);
  if (!force) claim = claim.in('status', ['queued', 'extracting']);
  const { data: claimedRaw } = await claim.select('id');
  const claimed = (claimedRaw as Array<{ id: string }> | null) ?? [];
  if (claimed.length === 0 && !force) {
    await queueDelete(INVOICE_QUEUE, msg.msg_id, { client });
    return 'skip';
  }

  const input: OrchestrateInput = {
    pdfBytes: new Uint8Array(0), // replaced inside the run (download is part of the attempt)
    ctx: {
      correlation_id: correlationId,
      invoice_id: invoiceId,
      household_id: invoice.household_id,
    },
    matchContext: {
      senderEmail: invoice.source_sender ?? undefined,
      subject: invoice.source_subject ?? undefined,
    },
    parsers,
  };

  // 5) Run the attempt behind an extraction_runs row.
  try {
    const result = await withRunRow(
      'extraction_runs',
      {
        correlation_id: correlationId,
        invoice_id: invoiceId,
        trigger_source: force ? 'manual' : 'scheduled',
      },
      async (_runId) => {
        const pdfBytes = await downloadPdf(client, invoice.storage_bucket, invoice.storage_path);
        const outcome = await runExtraction({ ...input, pdfBytes }, client);

        await client.from('invoices').update(buildInvoiceUpdate(outcome, nowIso())).eq(
          'id',
          invoiceId,
        );
        await emitDomainEvent({
          type: `invoice.${outcome.status}`,
          aggregate_type: 'invoice',
          aggregate_id: invoiceId,
          household_id: invoice.household_id ?? undefined,
          correlation_id: correlationId,
          actor_type: 'system',
          payload: {
            version: 1,
            data: {
              method: outcome.method,
              confidence: outcome.confidence,
              needs_review_reason: outcome.needsReviewReason ?? null,
            },
          },
        }, { client }).catch((e) =>
          log.warn('extraction-worker: outcome event failed', {
            correlation_id: ctx.correlation_id,
            err: e instanceof Error ? e.message : String(e),
          })
        );
        return outcome;
      },
      {
        client,
        clock: now,
        finalize: (o: ExtractionOutcome) => ({
          status: o.status === 'extracted' ? 'success' : 'partial',
          method: o.method,
          confidence: o.confidence,
          ai_calls_made: o.payload.data.layer4 ? 1 : 0,
        }),
      },
    );
    void result;
    await queueDelete(INVOICE_QUEUE, msg.msg_id, { client });
    return 'done';
  } catch (e) {
    // Infra failure (download / OCR exhausted / AI all-providers-failed): back
    // off and retry. The invoice stays 'extracting' and is reclaimed next time.
    log.warn('extraction-worker: attempt failed', {
      correlation_id: ctx.correlation_id,
      err: redactSecrets(e instanceof Error ? e.message : String(e)),
    });
    const backoff = backoffSeconds(msg.read_ct, cfg.retryBaseS, cfg.retryCapS);
    await queueSetVt(INVOICE_QUEUE, msg.msg_id, backoff, { client });
    return 'retry';
  }
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
