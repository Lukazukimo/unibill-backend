// =============================================================================
// telemetry-history/index.ts  —  GET /telemetry-history (sys-admin, #34/T-529)
// -----------------------------------------------------------------------------
// Read side of the sys-admin client-telemetry browser: a keyset-paginated,
// severity/event-filterable view of client_telemetry. The observability tables
// are service-role-only (no RLS), so the mobile reads them through this
// sys-admin-gated endpoint. Telemetry is PII-scrubbed on ingest; user/household
// ids are not returned.
//
// verify_jwt defaults to true; the handler additionally requires the caller's
// `app_metadata.is_system_admin` claim.
// =============================================================================

import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import {
  nextCursor,
  parseQuery,
  type TelemetryFilter,
  toTelemetry,
  validateFilter,
} from './query.ts';

export type CallerResolver = (req: Request) => Promise<CallerUser | null>;
export type TelemetryLoader = (filter: TelemetryFilter) => Promise<Record<string, unknown>[]>;

export type HandlerDeps = {
  getCallerUser?: CallerResolver;
  loadTelemetry?: TelemetryLoader;
};

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'access-control-allow-methods': 'GET, OPTIONS',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

const TELEMETRY_COLUMNS =
  'id, occurred_at, event_type, severity, app_version, release_channel, session_id, payload, device_info';

export const defaultLoadTelemetry: TelemetryLoader = async (f) => {
  let q = buildServiceClient()
    .from('client_telemetry')
    .select(TELEMETRY_COLUMNS)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(f.limit);
  if (f.severity) q = q.eq('severity', f.severity);
  if (f.eventType) q = q.eq('event_type', f.eventType);
  if (f.from) q = q.gte('occurred_at', f.from);
  if (f.to) q = q.lte('occurred_at', f.to);
  if (f.cursor) {
    // Keyset: (occurred_at, id) < (cursor). Parts are validated in decodeCursor.
    q = q.or(
      `occurred_at.lt.${f.cursor.occurredAt},and(occurred_at.eq.${f.cursor.occurredAt},id.lt.${f.cursor.id})`,
    );
  }
  const { data, error } = await q;
  if (error) throw new Error(`client_telemetry read failed: ${error.message}`);
  return (data as Record<string, unknown>[]) ?? [];
};

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));
  const loadTelemetry = deps.loadTelemetry ?? defaultLoadTelemetry;

  return withCorrelation(async (_ctx, req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' });

    const caller = await getCaller(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }
    if (!caller.is_system_admin) {
      return jsonResponse(403, { error: 'forbidden', detail: 'system_admin required' });
    }

    const filter = parseQuery(new URL(req.url).searchParams);
    const invalid = validateFilter(filter);
    if (invalid) return jsonResponse(422, { error: 'invalid_request', detail: invalid });

    let rows: Record<string, unknown>[];
    try {
      rows = await loadTelemetry(filter);
    } catch (_) {
      return jsonResponse(500, { error: 'internal_error' });
    }
    const telemetry = rows.map(toTelemetry);
    return jsonResponse(200, { telemetry, next_cursor: nextCursor(telemetry, filter.limit) });
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
