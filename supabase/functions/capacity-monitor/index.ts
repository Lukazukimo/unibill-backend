/**
 * capacity-monitor — POST /capacity-monitor (pg_cron, every 5 min). Measures DB +
 * Storage + queue usage, classifies green/yellow/orange/red (§10.2), writes a
 * capacity_snapshots row, and reacts (BR-010/011/012):
 *   - any resource >= orange → enqueue an eviction job (capacity_eviction_queue);
 *   - crossing to red       → pause ingestion (features.ingestion_enabled=false)
 *                             + capacity.threshold_crossed event + admin email;
 *   - recovered to <= red-5% → resume ingestion + capacity.ingestion.resumed.
 *
 * Ref: T-602 (#107), spec §4.4 / §10.2 / §10.6 / §D / BR-010..012.
 * Date: 2026-06-25
 *
 * measure() (the SECURITY DEFINER SQL), the admin-email sender and the event
 * emitter are injected; classify is pure. The snapshot write, the eviction
 * enqueue and the ingestion toggle run against the (injectable) service client,
 * so the loop is unit-tested without a real DB. There is no withStructuredLog in
 * _shared — withCorrelation + the structured `log` helper provide the same.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import {
  getGlobalConfig,
  readBoolConfig,
  readConfig,
  readNumberConfig,
} from '../_shared/config.ts';
import { requireServiceRole } from '../_shared/serviceAuth.ts';
import { queueSend } from '../_shared/queue.ts';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';
import { atLeast, type CapacityThresholds, classify, usagePct, worst } from './classify.ts';
import { type CapacityMetrics, measure as defaultMeasure, type MeasureFn } from './measure.ts';

export const CAPACITY_EVICTION_QUEUE = 'capacity_eviction_queue';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const CFG_DB_LIMIT = 'capacity.db_limit_bytes';
const CFG_STORAGE_LIMIT = 'capacity.storage_limit_bytes';
const CFG_YELLOW = 'capacity.yellow_threshold_pct';
const CFG_ORANGE = 'capacity.orange_threshold_pct';
const CFG_RED = 'capacity.red_threshold_pct';
const CFG_TARGET = 'capacity.target_pct';
const CFG_INGESTION = 'features.ingestion_enabled';
const CFG_ADMIN_EMAIL = 'notifications.admin_email';

export type EmitEventFn = (e: DomainEventInput) => Promise<void>;
export type SendAdminEmailFn = (to: string, subject: string, body: string) => Promise<void>;

export type HandlerDeps = {
  client?: SupabaseClient;
  requireAuth?: (req: Request) => boolean;
  now?: () => number;
  measure?: MeasureFn;
  emitEvent?: EmitEventFn;
  sendAdminEmail?: SendAdminEmailFn;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// No email provider is wired yet (only notifications.admin_email exists). The
// durable record is the capacity.threshold_crossed domain event; this logs the
// alert best-effort. Tests inject a capturing mock.
const defaultSendAdminEmail: SendAdminEmailFn = (to, subject) => {
  log.warn('capacity-monitor: admin alert (no email provider wired)', { to, subject });
  return Promise.resolve();
};

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const requireAuth = deps.requireAuth ?? ((req: Request) => requireServiceRole(req));
  const now = deps.now ?? (() => Date.now());
  const measure = deps.measure ?? defaultMeasure;
  const sendAdminEmail = deps.sendAdminEmail ?? defaultSendAdminEmail;

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
    if (!requireAuth(req)) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'service_role required' });
    }
    const client = deps.client ?? buildServiceClient();
    // Bind the resolved client into the default event emitter (tests inject their own).
    const emitEvent = deps.emitEvent ?? ((e: DomainEventInput) => emitDomainEvent(e, { client }));

    let cfg: Map<string, unknown>;
    try {
      cfg = await getGlobalConfig([
        CFG_DB_LIMIT,
        CFG_STORAGE_LIMIT,
        CFG_YELLOW,
        CFG_ORANGE,
        CFG_RED,
        CFG_TARGET,
        CFG_INGESTION,
        CFG_ADMIN_EMAIL,
      ], { client });
    } catch (e) {
      log.error('capacity-monitor: config read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'config_failed' });
    }

    const thresholds: CapacityThresholds = {
      yellowPct: readNumberConfig(cfg, CFG_YELLOW, 70),
      orangePct: readNumberConfig(cfg, CFG_ORANGE, 80),
      redPct: readNumberConfig(cfg, CFG_RED, 90),
    };
    const dbLimit = readNumberConfig(cfg, CFG_DB_LIMIT, 524_288_000);
    const storageLimit = readNumberConfig(cfg, CFG_STORAGE_LIMIT, 1_073_741_824);
    const targetPct = readNumberConfig(cfg, CFG_TARGET, 60);
    const resumePct = thresholds.redPct - 5; // BR-012: resume at <= 85% after red
    let ingestionEnabled = readBoolConfig(cfg, CFG_INGESTION, true);
    const adminEmail = readConfig<string>(cfg, CFG_ADMIN_EMAIL, '');

    let metrics: CapacityMetrics;
    try {
      metrics = await measure(client);
    } catch (e) {
      log.error('capacity-monitor: measure failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'measure_failed' });
    }

    const dbPct = usagePct(metrics.db_bytes, dbLimit);
    const storagePct = usagePct(metrics.storage_bytes, storageLimit);
    const dbStatus = classify(dbPct, thresholds);
    const storageStatus = classify(storagePct, thresholds);
    const overall = worst(dbStatus, storageStatus);
    const overallPct = Math.max(dbPct, storagePct);
    const nowIso = new Date(now()).toISOString();

    // (f) snapshot
    await client.from('capacity_snapshots').insert({
      checked_at: nowIso,
      db_bytes: metrics.db_bytes,
      db_limit_bytes: dbLimit,
      db_pct: dbPct,
      db_status: dbStatus,
      db_per_table: metrics.db_per_table,
      storage_bytes: metrics.storage_bytes,
      storage_limit_bytes: storageLimit,
      storage_pct: storagePct,
      storage_status: storageStatus,
      storage_per_bucket: metrics.storage_per_bucket,
      queue_depths: metrics.queue_depths,
      thresholds_snapshot: { ...thresholds, targetPct, dbLimit, storageLimit },
    });

    // (g) enqueue eviction per resource that is >= orange (BR-010)
    let enqueued = 0;
    for (
      const r of [
        { resource_type: 'db', status: dbStatus, pct: dbPct },
        { resource_type: 'storage', status: storageStatus, pct: storagePct },
      ]
    ) {
      if (atLeast(r.status, 'orange')) {
        await queueSend(CAPACITY_EVICTION_QUEUE, {
          resource_type: r.resource_type,
          trigger_reason: `${r.resource_type}_${r.status}`,
          trigger_pct: r.pct,
          target_pct: targetPct,
          correlation_id: ctx.correlation_id,
        }, { client });
        enqueued++;
      }
    }

    // (h) cross to red → pause ingestion + event + email (BR-011)
    if (overall === 'red' && ingestionEnabled) {
      await setIngestion(client, false);
      ingestionEnabled = false;
      await emitEvent({
        type: 'capacity.threshold_crossed',
        aggregate_type: 'capacity',
        aggregate_id: NIL_UUID,
        correlation_id: ctx.correlation_id,
        actor_type: 'system',
        payload: { version: 1, data: { status: 'red', db_pct: dbPct, storage_pct: storagePct } },
      }).catch((e) =>
        log.warn('capacity-monitor: threshold_crossed event failed', { err: String(e) })
      );
      if (adminEmail) {
        await sendAdminEmail(
          adminEmail,
          'Unibill: capacity RED — ingestion paused',
          `DB ${dbPct}% / Storage ${storagePct}% crossed the red threshold (${thresholds.redPct}%). Ingestion paused; eviction enqueued.`,
        ).catch((e) =>
          log.warn('capacity-monitor: admin email failed', { err: redactSecrets(String(e)) })
        );
      }
    } else if (!ingestionEnabled && overallPct <= resumePct) {
      // (i) recovered after red → resume ingestion (BR-012)
      await setIngestion(client, true);
      ingestionEnabled = true;
      await emitEvent({
        type: 'capacity.ingestion.resumed',
        aggregate_type: 'capacity',
        aggregate_id: NIL_UUID,
        correlation_id: ctx.correlation_id,
        actor_type: 'system',
        payload: { version: 1, data: { db_pct: dbPct, storage_pct: storagePct } },
      }).catch((e) =>
        log.warn('capacity-monitor: ingestion.resumed event failed', { err: String(e) })
      );
    }

    return jsonResponse(200, {
      db_status: dbStatus,
      storage_status: storageStatus,
      db_pct: dbPct,
      storage_pct: storagePct,
      overall,
      enqueued,
      ingestion_enabled: ingestionEnabled,
    });
  });
}

async function setIngestion(client: SupabaseClient, enabled: boolean): Promise<void> {
  await client
    .from('app_settings')
    .update({ value: { v: enabled } })
    .eq('key', CFG_INGESTION)
    .eq('scope', 'global');
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
