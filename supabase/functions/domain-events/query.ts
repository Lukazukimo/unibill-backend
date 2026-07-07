// =============================================================================
// domain-events/query.ts
// -----------------------------------------------------------------------------
// Pure query parsing, keyset cursor codec, and row shaping for the sys-admin
// domain-events browser (#34 / T-529). Keyset pagination orders by
// (occurred_at DESC, id DESC); the cursor is the last row's (occurred_at, id).
// =============================================================================

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const MAX_FILTER_LEN = 200;

export type Cursor = { occurredAt: string; id: string };

export type EventsFilter = {
  eventType: string | null;
  actorUserId: string | null;
  aggregateId: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  cursor: Cursor | null;
};

// deno-lint-ignore no-explicit-any
type Json = any;

export type EventView = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: string;
  actor_user_id: string | null;
  occurred_at: string;
  payload: Json;
};

/** base64 of "occurred_at|id" — opaque to the client. */
export function encodeCursor(occurredAt: string, id: string): string {
  return btoa(`${occurredAt}|${id}`);
}

// The cursor is base64 client input spliced into the keyset `.or()` filter, so
// its parts are validated to timestamp/uuid character sets — this blocks any
// PostgREST filter injection (no commas/parens/operators can slip through).
const TIMESTAMP_RE = /^[0-9T:.+\- Z]{10,40}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = atob(raw);
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const occurredAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!TIMESTAMP_RE.test(occurredAt) || !UUID_RE.test(id)) return null;
    return { occurredAt, id };
  } catch (_) {
    return null;
  }
}

function trimmed(params: URLSearchParams, key: string): string | null {
  const v = params.get(key);
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, MAX_FILTER_LEN) : null;
}

export function parseQuery(params: URLSearchParams): EventsFilter {
  let limit = Number.parseInt(params.get('limit') ?? '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return {
    eventType: trimmed(params, 'event_type'),
    actorUserId: trimmed(params, 'actor_user_id'),
    aggregateId: trimmed(params, 'aggregate_id'),
    from: trimmed(params, 'from'),
    to: trimmed(params, 'to'),
    limit,
    cursor: decodeCursor(trimmed(params, 'cursor')),
  };
}

/**
 * Validates the filter values that reach the DB as typed columns, so malformed
 * client input is a 422 (caller error) rather than a Postgres cast failure the
 * handler would surface as an opaque 500. Returns an error message or null.
 */
export function validateFilter(f: EventsFilter): string | null {
  if (f.actorUserId && !UUID_RE.test(f.actorUserId)) {
    return 'actor_user_id must be a uuid';
  }
  if (f.aggregateId && !UUID_RE.test(f.aggregateId)) {
    return 'aggregate_id must be a uuid';
  }
  if (f.from && !TIMESTAMP_RE.test(f.from)) return 'from must be a timestamp';
  if (f.to && !TIMESTAMP_RE.test(f.to)) return 'to must be a timestamp';
  return null;
}

export function toEvent(row: Record<string, unknown>): EventView {
  return {
    id: String(row.id),
    event_type: String(row.event_type),
    aggregate_type: String(row.aggregate_type),
    aggregate_id: String(row.aggregate_id),
    actor_type: String(row.actor_type),
    actor_user_id: row.actor_user_id == null ? null : String(row.actor_user_id),
    occurred_at: String(row.occurred_at),
    payload: row.payload ?? {},
  };
}

/** The cursor for the page AFTER `events`, or null when it is the last page. */
export function nextCursor(events: EventView[], limit: number): string | null {
  if (events.length < limit || events.length === 0) return null;
  const last = events[events.length - 1];
  return encodeCursor(last.occurred_at, last.id);
}
