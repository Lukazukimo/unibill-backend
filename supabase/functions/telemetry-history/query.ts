// =============================================================================
// telemetry-history/query.ts
// -----------------------------------------------------------------------------
// Pure query parsing, keyset cursor codec, and row shaping for the sys-admin
// client-telemetry browser (#34 / T-529). Mirrors domain-events: keyset on
// (occurred_at DESC, id DESC); filters by severity / event_type / time range.
// client_telemetry is already PII-scrubbed on ingest (spec §5.6), and user /
// household ids are intentionally omitted from the response.
// =============================================================================

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const MAX_FILTER_LEN = 200;

export type Cursor = { occurredAt: string; id: string };

export type TelemetryFilter = {
  severity: string | null;
  eventType: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  cursor: Cursor | null;
};

// deno-lint-ignore no-explicit-any
type Json = any;

export type TelemetryView = {
  id: string;
  occurred_at: string;
  event_type: string;
  severity: string | null;
  app_version: string | null;
  release_channel: string | null;
  session_id: string | null;
  payload: Json;
  device_info: Json;
};

const TIMESTAMP_RE = /^[0-9T:.+\- Z]{10,40}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/** base64 of "occurred_at|id" — opaque to the client. */
export function encodeCursor(occurredAt: string, id: string): string {
  return btoa(`${occurredAt}|${id}`);
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = atob(raw);
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const occurredAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    // Validated to timestamp/uuid char sets — blocks PostgREST `.or()` injection.
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

export function parseQuery(params: URLSearchParams): TelemetryFilter {
  let limit = Number.parseInt(params.get('limit') ?? '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return {
    severity: trimmed(params, 'severity'),
    eventType: trimmed(params, 'event_type'),
    from: trimmed(params, 'from'),
    to: trimmed(params, 'to'),
    limit,
    cursor: decodeCursor(trimmed(params, 'cursor')),
  };
}

/** Malformed timestamp filters are a 422, not a Postgres-cast 500. */
export function validateFilter(f: TelemetryFilter): string | null {
  if (f.from && !TIMESTAMP_RE.test(f.from)) return 'from must be a timestamp';
  if (f.to && !TIMESTAMP_RE.test(f.to)) return 'to must be a timestamp';
  return null;
}

export function toTelemetry(row: Record<string, unknown>): TelemetryView {
  return {
    id: String(row.id),
    occurred_at: String(row.occurred_at),
    event_type: String(row.event_type),
    severity: row.severity == null ? null : String(row.severity),
    app_version: row.app_version == null ? null : String(row.app_version),
    release_channel: row.release_channel == null ? null : String(row.release_channel),
    session_id: row.session_id == null ? null : String(row.session_id),
    payload: row.payload ?? {},
    device_info: row.device_info ?? null,
  };
}

/** The cursor for the page AFTER `items`, or null when it is the last page. */
export function nextCursor(items: TelemetryView[], limit: number): string | null {
  if (items.length < limit || items.length === 0) return null;
  const last = items[items.length - 1];
  return encodeCursor(last.occurred_at, last.id);
}
