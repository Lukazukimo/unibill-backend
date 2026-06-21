/**
 * sync-worker — POST /sync-worker (pg_cron, every 1 min). Drains
 * email_sync_queue: per job it claims the mailbox, opens a sync_runs row, and
 * runs the IMAP fetch behind the circuit-breaker + rate-limiter, ACKing on
 * success and applying backoff / DLQ / auto-pause on failure.
 *
 * Ref: T-325 (loop + composition + DLQ) + T-327 (auto-pause). T-326 doImapFetch
 *      is INJECTED here (real imapflow impl lands in a follow-up); this slice is
 *      the orchestration, fully unit-tested with a fake fetch + fake client.
 * Date: 2026-06-21
 *
 * Per-message (decisions key off sync_runs.errors_count = REAL failures, NOT
 * pgmq read_ct, which counts deliveries — a runtime-cap break / crash redelivers
 * without an attempt; read_ct is only a high poison-message safety net):
 *   1. prior run already SUCCEEDED, or is 'running' & fresh (another invocation
 *      has it) ⇒ ACK + skip.
 *   2. errors_count >= max_retries (or deliveries past the poison cap) ⇒ move to
 *      email_sync_dlq + emit email.sync.dead_lettered.
 *   3. Claim the mailbox: first sight of this key (no prior run) ⇒ atomic
 *      conditional UPDATE last_sync_at WHERE still-due (0 rows ⇒ duplicate
 *      dispatch / not-due / inactive ⇒ ACK + skip) — this dedupes the
 *      dispatcher's same-mailbox-across-minutes re-selection. A retry (prior run
 *      exists) skips the claim and only re-checks the box is still active.
 *   4. (re)open the sync_runs row 'running', preserving errors_count.
 *   5. withRateLimit(imap_fetch) → withCircuitBreaker(imap) → doImapFetch (rate
 *      outermost so our own throttling never trips the IMAP circuit breaker).
 *      ok ⇒ sync_runs success + reset error state + ACK. RateLimit/CircuitOpen ⇒
 *      backoff (set_vt), NOT a mailbox error. Other error ⇒ sync_runs failed
 *      (errors_count++) + record_mailbox_error (atomic ++ / auto-pause) + backoff.
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
import { withCircuitBreaker } from '../_shared/circuit.ts';
import { withRateLimit } from '../_shared/rateLimit.ts';
import { emitDomainEvent } from '../_shared/events.ts';
import { CircuitOpenError, RateLimitError } from '../_shared/errors.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';
import { doImapFetch as realDoImapFetch } from '../_shared/imapFetch.ts';

export const EMAIL_SYNC_QUEUE = 'email_sync_queue';
export const EMAIL_SYNC_DLQ = 'email_sync_dlq';
const WORKER_READ_BATCH = 10;
const IMAP_FETCH_LIMIT_PER_HOUR = 10;

const CFG_VISIBILITY = 'sync.visibility_timeout_s';
const CFG_MAX_RETRIES = 'sync.max_retries';
const CFG_ERR_THRESHOLD = 'sync.consecutive_error_threshold';
const CFG_RETRY_BASE = 'sync.retry_base_s';
const CFG_RETRY_CAP = 'sync.retry_cap_s';
const CFG_INTERVAL_MIN = 'sync.interval_minutes';
const CFG_RUNTIME_MS = 'sync.fetch_max_runtime_ms';

/** What doImapFetch (T-326) returns. */
export type ImapFetchResult = {
  messages_seen: number;
  invoices_created: number;
  duplicates_skipped: number;
};

export type ImapFetchInput = {
  connectedEmailId: string;
  emailAddress: string;
  correlationId: string;
  client: SupabaseClient;
};

export type ImapFetchFn = (input: ImapFetchInput) => Promise<ImapFetchResult>;

export type SyncJob = {
  connected_email_id: string;
  correlation_id: string;
  idempotency_key: string;
  attempt?: number;
};

export type HandlerDeps = {
  client?: SupabaseClient;
  requireAuth?: (req: Request) => boolean;
  now?: () => number;
  doImapFetch?: ImapFetchFn;
};

// Production fetch = the real imapflow impl (T-326); deps.doImapFetch overrides
// it in unit tests with a fake so the loop is testable without a network.
const defaultDoImapFetch: ImapFetchFn = (input) => realDoImapFetch(input);

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
  errThreshold: number;
  retryBaseS: number;
  retryCapS: number;
  intervalMin: number;
  runtimeMs: number;
};

type Outcome = 'done' | 'dlq' | 'skip' | 'retry';

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const requireAuth = deps.requireAuth ?? ((req: Request) => requireServiceRole(req));
  const now = deps.now ?? (() => Date.now());
  const doImapFetch = deps.doImapFetch ?? defaultDoImapFetch;

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
        CFG_ERR_THRESHOLD,
        CFG_RETRY_BASE,
        CFG_RETRY_CAP,
        CFG_INTERVAL_MIN,
        CFG_RUNTIME_MS,
      ], { client });
    } catch (e) {
      log.error('sync-worker: config read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'config_failed' });
    }
    const cfg: Cfg = {
      visibilityS: readNumberConfig(cfgMap, CFG_VISIBILITY, 120),
      maxRetries: readNumberConfig(cfgMap, CFG_MAX_RETRIES, 3),
      errThreshold: readNumberConfig(cfgMap, CFG_ERR_THRESHOLD, 5),
      retryBaseS: readNumberConfig(cfgMap, CFG_RETRY_BASE, 60),
      retryCapS: readNumberConfig(cfgMap, CFG_RETRY_CAP, 1800),
      intervalMin: readNumberConfig(cfgMap, CFG_INTERVAL_MIN, 60),
      runtimeMs: readNumberConfig(cfgMap, CFG_RUNTIME_MS, 50_000),
    };

    let msgs: Array<QueueMessage<SyncJob>>;
    try {
      msgs = await queueRead<SyncJob>(EMAIL_SYNC_QUEUE, cfg.visibilityS, WORKER_READ_BATCH, {
        client,
      });
    } catch (e) {
      log.error('sync-worker: queue read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'read_failed' });
    }

    const tally = { processed: 0, done: 0, dlq: 0, skipped: 0, retried: 0 };
    const startMs = now();
    for (const msg of msgs) {
      if (now() - startMs > cfg.runtimeMs) break; // leave the rest for the next tick
      tally.processed++;
      const outcome = await processOne(msg, { ctx, client, cfg, now, doImapFetch });
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
  doImapFetch: ImapFetchFn;
};

async function processOne(msg: QueueMessage<SyncJob>, p: ProcessCtx): Promise<Outcome> {
  const { client, cfg, now, ctx, doImapFetch } = p;
  const job = msg.message;
  const cid = job.connected_email_id;
  const key = job.idempotency_key;
  const nowIso = () => new Date(now()).toISOString();

  // Prior run for this (mailbox, idempotency_key). pgmq's read_ct counts
  // DELIVERIES not attempts (a runtime-cap break or a crash redelivers without
  // processing), so retry/DLQ/backoff key off sync_runs.errors_count (REAL
  // failures) and the claim keys off "is there a prior run" — never read_ct.
  const { data: priorRaw } = await client
    .from('sync_runs')
    .select('id, status, errors_count, started_at')
    .eq('connected_email_id', cid)
    .eq('idempotency_key', key)
    .maybeSingle();
  const prior = priorRaw as
    | { id: string; status: string; errors_count: number; started_at: string }
    | null;
  const priorErrors = prior?.errors_count ?? 0;

  // 1) Already done, or another invocation is processing it right now → ACK/skip.
  if (prior?.status === 'success') {
    await queueDelete(EMAIL_SYNC_QUEUE, msg.msg_id, { client });
    return 'skip';
  }
  if (
    prior?.status === 'running' &&
    now() - Date.parse(prior.started_at) < cfg.visibilityS * 1000
  ) {
    await queueDelete(EMAIL_SYNC_QUEUE, msg.msg_id, { client }); // concurrent in-flight dup
    return 'skip';
  }

  // 2) Dead-letter: maxRetries REAL failures reached, or a poison message that
  //    keeps crashing the worker (delivery safety net, well above maxRetries).
  if (priorErrors >= cfg.maxRetries || msg.read_ct > Math.max(cfg.maxRetries * 4, 12)) {
    await queueToDlq(EMAIL_SYNC_QUEUE, EMAIL_SYNC_DLQ, msg.msg_id, job, { client });
    await emitDomainEvent({
      type: 'email.sync.dead_lettered',
      aggregate_type: 'connected_email',
      aggregate_id: cid,
      correlation_id: job.correlation_id,
      actor_type: 'system',
      payload: {
        version: 1,
        data: { idempotency_key: key, attempts: priorErrors, deliveries: msg.read_ct },
      },
    }, { client }).catch((e) =>
      log.warn('sync-worker: dead_lettered event failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      })
    );
    return 'dlq';
  }

  // 3) Acquire the mailbox. First sight of this key (no prior run) → atomic claim
  //    via a conditional last_sync_at update: 0 rows ⇒ a DUPLICATE dispatch
  //    (another key already claimed) or not-due/inactive ⇒ ACK + skip. A retry
  //    (prior run exists) skips the claim — it already won it — and only
  //    re-checks the box is still active (auto-pause drops the retry).
  //    NB: last_sync_at doubles as the claim marker, so it is stamped at attempt
  //    START; true last-success is the sync_runs row, not this column.
  let emailAddress: string;
  if (!prior) {
    const cutoff = new Date(now() - cfg.intervalMin * 60_000).toISOString();
    const { data: claimed } = await client
      .from('connected_emails')
      .update({ last_sync_at: nowIso() })
      .eq('id', cid)
      .eq('status', 'active')
      .or(`last_sync_at.is.null,last_sync_at.lt.${cutoff}`)
      .select('id, email_address');
    if (!claimed || claimed.length === 0) {
      await queueDelete(EMAIL_SYNC_QUEUE, msg.msg_id, { client });
      return 'skip';
    }
    emailAddress = (claimed[0] as { email_address: string }).email_address;
  } else {
    const { data: row } = await client
      .from('connected_emails')
      .select('email_address')
      .eq('id', cid)
      .eq('status', 'active')
      .maybeSingle();
    if (!row) {
      await queueDelete(EMAIL_SYNC_QUEUE, msg.msg_id, { client }); // paused/error/removed
      return 'skip';
    }
    emailAddress = (row as { email_address: string }).email_address;
  }

  // 4) (Re)open the run row, preserving the real-failure count across retries.
  const attempt = priorErrors + 1;
  const { data: run, error: runErr } = await client
    .from('sync_runs')
    .upsert({
      connected_email_id: cid,
      idempotency_key: key,
      correlation_id: job.correlation_id,
      trigger_source: prior ? 'retry' : 'scheduled',
      status: 'running',
      started_at: nowIso(),
      errors_count: priorErrors,
    }, { onConflict: 'connected_email_id,idempotency_key' })
    .select('id')
    .single();
  if (runErr || !run) {
    log.warn('sync-worker: sync_runs upsert failed', {
      correlation_id: ctx.correlation_id,
      err: runErr?.message ?? 'no row',
    });
    return 'retry'; // run never opened → rely on the original VT for redelivery
  }
  const runId = (run as { id: string }).id;
  const startedMs = now();

  // 5) Fetch behind the rate limiter (OUTERMOST) + circuit breaker. Rate-limit
  //    is a pre-check so our own throttling never trips the IMAP breaker; only a
  //    real doImapFetch failure reaches withCircuitBreaker's catch. (An OPEN
  //    circuit consumes one rate token before short-circuiting — bounded by the
  //    backoff cadence; acceptable.)
  try {
    const result = await withRateLimit(
      'imap_fetch',
      emailAddress,
      { window: '1hour', limit: IMAP_FETCH_LIMIT_PER_HOUR },
      () =>
        withCircuitBreaker(
          'imap',
          emailAddress,
          () =>
            doImapFetch({
              connectedEmailId: cid,
              emailAddress,
              correlationId: job.correlation_id,
              client,
            }),
          { client },
        ),
      { client },
    );

    // 5a) Success.
    const finishedMs = now();
    await client.from('sync_runs').update({
      status: 'success',
      finished_at: new Date(finishedMs).toISOString(),
      duration_ms: finishedMs - startedMs,
      messages_seen: result.messages_seen,
      invoices_created: result.invoices_created,
      duplicates_skipped: result.duplicates_skipped,
    }).eq('id', runId);
    await client.from('connected_emails').update({
      consecutive_errors: 0,
      last_error: null,
      last_error_at: null,
      last_sync_at: nowIso(),
    }).eq('id', cid);
    // (circuit success already recorded by withCircuitBreaker on the way out.)
    await queueDelete(EMAIL_SYNC_QUEUE, msg.msg_id, { client });
    return 'done';
  } catch (e) {
    const reason = redactSecrets(e instanceof Error ? e.message : String(e));
    const finishedMs = now();
    const backoff = backoffSeconds(attempt, cfg.retryBaseS, cfg.retryCapS);

    // 5b) Throttle (rate limit / circuit open): NOT a mailbox failure — back off,
    //     do NOT bump the attempt counter (it self-resolves when the window /
    //     circuit clears).
    if (e instanceof RateLimitError || e instanceof CircuitOpenError) {
      await client.from('sync_runs').update({
        status: 'failed',
        finished_at: new Date(finishedMs).toISOString(),
        duration_ms: finishedMs - startedMs,
        error_summary: reason,
      }).eq('id', runId);
      await queueSetVt(EMAIL_SYNC_QUEUE, msg.msg_id, backoff, { client });
      return 'retry';
    }

    // 5c) Real failure: bump the attempt counter (errors_count), record the
    //     mailbox error (atomic ++ / auto-pause), back off. The IMAP circuit
    //     failure was already recorded by withCircuitBreaker.
    await client.from('sync_runs').update({
      status: 'failed',
      finished_at: new Date(finishedMs).toISOString(),
      duration_ms: finishedMs - startedMs,
      errors_count: attempt,
      error_summary: reason,
    }).eq('id', runId);
    const { data: paused, error: recErr } = await client.rpc('record_mailbox_error', {
      p_connected_email_id: cid,
      p_threshold: cfg.errThreshold,
      p_error: reason,
    });
    if (recErr) {
      log.warn('sync-worker: record_mailbox_error failed', {
        correlation_id: ctx.correlation_id,
        err: recErr.message,
      });
    }
    if (paused === true) {
      await emitDomainEvent({
        type: 'email.sync.auto_paused',
        aggregate_type: 'connected_email',
        aggregate_id: cid,
        correlation_id: job.correlation_id,
        actor_type: 'system',
        payload: { version: 1, data: { threshold: cfg.errThreshold } },
      }, { client }).catch((ev) =>
        log.warn('sync-worker: auto_paused event failed', {
          correlation_id: ctx.correlation_id,
          err: ev instanceof Error ? ev.message : String(ev),
        })
      );
    }
    await queueSetVt(EMAIL_SYNC_QUEUE, msg.msg_id, backoff, { client });
    return 'retry';
  }
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
