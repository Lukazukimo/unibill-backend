// =============================================================================
// domain-events/index.ts  —  GET /domain-events  (sys-admin, #34 / T-529)
// -----------------------------------------------------------------------------
// Read side of the sys-admin domain-events browser: a keyset-paginated,
// filterable view of the append-only `domain_events` log. The observability
// tables are service-role-only (no RLS), so the mobile reads them through this
// sys-admin-gated endpoint.
//
// Filters (query params): event_type, actor_user_id, aggregate_id, from, to.
// Pagination: `limit` (<=100) + opaque `cursor` (keyset on occurred_at DESC,
// id DESC). Response: { events, next_cursor }.
//
// verify_jwt defaults to true; the handler additionally requires the caller's
// `app_metadata.is_system_admin` claim.
// =============================================================================

import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { type EventsFilter, nextCursor, parseQuery, toEvent, validateFilter } from './query.ts';

export type CallerResolver = (req: Request) => Promise<CallerUser | null>;
export type EventsLoader = (filter: EventsFilter) => Promise<Record<string, unknown>[]>;

export type HandlerDeps = {
  getCallerUser?: CallerResolver;
  loadEvents?: EventsLoader;
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

const EVENT_COLUMNS =
  'id, event_type, aggregate_type, aggregate_id, actor_type, actor_user_id, occurred_at, payload';

export const defaultLoadEvents: EventsLoader = async (f) => {
  let q = buildServiceClient()
    .from('domain_events')
    .select(EVENT_COLUMNS)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(f.limit);
  if (f.eventType) q = q.eq('event_type', f.eventType);
  if (f.actorUserId) q = q.eq('actor_user_id', f.actorUserId);
  if (f.aggregateId) q = q.eq('aggregate_id', f.aggregateId);
  if (f.from) q = q.gte('occurred_at', f.from);
  if (f.to) q = q.lte('occurred_at', f.to);
  if (f.cursor) {
    // Keyset: (occurred_at, id) < (cursor). Parts are validated in decodeCursor.
    q = q.or(
      `occurred_at.lt.${f.cursor.occurredAt},and(occurred_at.eq.${f.cursor.occurredAt},id.lt.${f.cursor.id})`,
    );
  }
  const { data, error } = await q;
  if (error) throw new Error(`domain_events read failed: ${error.message}`);
  return (data as Record<string, unknown>[]) ?? [];
};

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));
  const loadEvents = deps.loadEvents ?? defaultLoadEvents;

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
      rows = await loadEvents(filter);
    } catch (_) {
      return jsonResponse(500, { error: 'internal_error' });
    }
    const events = rows.map(toEvent);
    return jsonResponse(200, { events, next_cursor: nextCursor(events, filter.limit) });
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
