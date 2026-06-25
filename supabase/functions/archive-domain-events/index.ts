/**
 * archive-domain-events — POST /archive-domain-events (pg_cron, weekly). Moves
 * the domain_events week-slice that just aged past the hot-retention window
 * (retention.domain_events_hot.max_age_days, default 90d) to cold Storage as a
 * gzipped JSONL file, then deletes the archived rows.
 *
 * Ref: T-605 (#115), spec §10.5 (retention.domain_events_*) / §5.13 (Storage) / §D.
 * Date: 2026-06-25
 *
 * Window = [now-(hot+7)d, now-hot d) — the 7-day slice that crossed the 90d
 * threshold this week. The object path is DETERMINISTIC from that window
 * (domain_events/YYYY/MM/week-WW.jsonl.gz), so re-running the same week
 * overwrites the file (upsert) and deletes only that week's rows — idempotent.
 *
 * The SELECT / upload / DELETE are injected; the JSONL+gzip serialization and
 * the window/path computation are pure → unit-tested with no Storage/DB. (There
 * is no withStructuredLog in _shared — withCorrelation + `log` provide it.)
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { getGlobalConfig, readNumberConfig } from '../_shared/config.ts';
import { requireServiceRole } from '../_shared/serviceAuth.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';

export const ARCHIVES_BUCKET = 'archives';
const SLICE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface ArchiveWindow {
  fromIso: string;
  toIso: string;
  objectPath: string;
}

/** ISO-8601 week number (Mon-based) for a UTC date. */
export function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // the Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}

/** The week-slice that just aged past `hotDays`: [now-(hot+slice), now-hot). */
export function archiveWindow(
  nowMs: number,
  hotDays: number,
  sliceDays = SLICE_DAYS,
): ArchiveWindow {
  const toMs = nowMs - hotDays * DAY_MS;
  const fromMs = nowMs - (hotDays + sliceDays) * DAY_MS;
  const from = new Date(fromMs);
  const yyyy = from.getUTCFullYear();
  const mm = String(from.getUTCMonth() + 1).padStart(2, '0');
  const ww = String(isoWeek(from)).padStart(2, '0');
  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    objectPath: `domain_events/${yyyy}/${mm}/week-${ww}.jsonl.gz`,
  };
}

/** Rows → JSONL (one JSON object per line, no trailing newline). */
export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

/** gzip a string → bytes (CompressionStream). */
export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type EventRow = { id: string; [k: string]: unknown };

export type HandlerDeps = {
  client?: SupabaseClient;
  requireAuth?: (req: Request) => boolean;
  now?: () => number;
  selectEvents?: (client: SupabaseClient, w: ArchiveWindow) => Promise<EventRow[]>;
  upload?: (client: SupabaseClient, path: string, bytes: Uint8Array) => Promise<void>;
  deleteEvents?: (client: SupabaseClient, ids: string[]) => Promise<void>;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const defaultSelect = async (client: SupabaseClient, w: ArchiveWindow): Promise<EventRow[]> => {
  const { data, error } = await client
    .from('domain_events')
    .select('*')
    .gte('occurred_at', w.fromIso)
    .lt('occurred_at', w.toIso)
    .order('occurred_at', { ascending: true });
  if (error) throw new Error(`select domain_events failed: ${error.message}`);
  return (data ?? []) as EventRow[];
};

const defaultUpload = async (
  client: SupabaseClient,
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  const { error } = await client.storage.from(ARCHIVES_BUCKET).upload(path, bytes, {
    contentType: 'application/gzip',
    upsert: true, // deterministic path → re-running the week overwrites
  });
  if (error) throw new Error(`upload ${path} failed: ${error.message}`);
};

const defaultDelete = async (client: SupabaseClient, ids: string[]): Promise<void> => {
  const { error } = await client.from('domain_events').delete().in('id', ids);
  if (error) throw new Error(`delete domain_events failed: ${error.message}`);
};

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const requireAuth = deps.requireAuth ?? ((req: Request) => requireServiceRole(req));
  const now = deps.now ?? (() => Date.now());
  const selectEvents = deps.selectEvents ?? defaultSelect;
  const upload = deps.upload ?? defaultUpload;
  const deleteEvents = deps.deleteEvents ?? defaultDelete;

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
    if (!requireAuth(req)) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'service_role required' });
    }
    const client = deps.client ?? buildServiceClient();

    let hotDays = 90;
    try {
      const cfg = await getGlobalConfig(['retention.domain_events_hot.max_age_days'], { client });
      hotDays = readNumberConfig(cfg, 'retention.domain_events_hot.max_age_days', 90);
    } catch (e) {
      log.error('archive-domain-events: config read failed', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'config_failed' });
    }

    const window = archiveWindow(now(), hotDays);

    try {
      const rows = await selectEvents(client, window);
      if (rows.length === 0) {
        return jsonResponse(200, { archived: 0, path: window.objectPath });
      }
      const bytes = await gzipText(toJsonl(rows));
      await upload(client, window.objectPath, bytes);
      await deleteEvents(client, rows.map((r) => r.id));
      log.info('archive-domain-events: archived', {
        correlation_id: ctx.correlation_id,
        archived: rows.length,
        path: window.objectPath,
      });
      return jsonResponse(200, {
        archived: rows.length,
        path: window.objectPath,
        bytes: bytes.length,
      });
    } catch (e) {
      log.error('archive-domain-events: archive failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'archive_failed' });
    }
  });
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
