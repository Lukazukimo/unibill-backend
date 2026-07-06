// =============================================================================
// capacity-status/index.ts  —  GET /capacity-status  (sys-admin, #31 / T-527)
// -----------------------------------------------------------------------------
// Read side of the capacity dashboard: returns the latest capacity_snapshots
// measurement (DB + storage gauges, queue depths, thresholds). The observability
// tables are service-role-only (no RLS), so the mobile can't read them via
// PostgREST — this sys-admin-gated endpoint exposes the summary instead.
//
// verify_jwt defaults to true (no config.toml entry); the handler additionally
// requires the caller's `app_metadata.is_system_admin` claim.
// =============================================================================

import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { type CapacitySnapshotRow, toStatus } from './status.ts';

export type CallerResolver = (req: Request) => Promise<CallerUser | null>;
export type SnapshotLoader = () => Promise<CapacitySnapshotRow | null>;

export type HandlerDeps = {
  getCallerUser?: CallerResolver;
  loadSnapshot?: SnapshotLoader;
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

const SNAPSHOT_COLUMNS =
  'checked_at, db_pct, db_status, storage_pct, storage_status, queue_depths, thresholds_snapshot';

export const defaultLoadSnapshot: SnapshotLoader = async () => {
  const { data, error } = await buildServiceClient()
    .from('capacity_snapshots')
    .select(SNAPSHOT_COLUMNS)
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`capacity_snapshots read failed: ${error.message}`);
  return (data as CapacitySnapshotRow | null) ?? null;
};

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));
  const loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;

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

    let snapshot: CapacitySnapshotRow | null;
    try {
      snapshot = await loadSnapshot();
    } catch (_) {
      return jsonResponse(500, { error: 'internal_error' });
    }
    if (!snapshot) return jsonResponse(200, { snapshot: null });
    return jsonResponse(200, toStatus(snapshot));
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
