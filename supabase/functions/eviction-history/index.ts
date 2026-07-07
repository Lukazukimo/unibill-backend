// =============================================================================
// eviction-history/index.ts  —  GET /eviction-history  (sys-admin, #34 / T-529)
// -----------------------------------------------------------------------------
// Read side of the sys-admin eviction-history browser: the most recent
// eviction_runs (tier / trigger, before→after %, bytes freed, status). The
// observability tables are service-role-only (no RLS), so the mobile reads them
// through this sys-admin-gated endpoint. Low volume → plain "last N" read.
//
// verify_jwt defaults to true; the handler additionally requires the caller's
// `app_metadata.is_system_admin` claim.
// =============================================================================

import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { type EvictionRunView, parseLimit, toRun } from './eviction.ts';

export type CallerResolver = (req: Request) => Promise<CallerUser | null>;
export type RunsLoader = (limit: number) => Promise<Record<string, unknown>[]>;

export type HandlerDeps = {
  getCallerUser?: CallerResolver;
  loadRuns?: RunsLoader;
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

const RUN_COLUMNS =
  'id, resource_type, trigger_reason, trigger_pct, target_pct, final_pct, total_freed_bytes, status, started_at, finished_at, duration_ms, steps, error_summary';

export const defaultLoadRuns: RunsLoader = async (limit) => {
  const { data, error } = await buildServiceClient()
    .from('eviction_runs')
    .select(RUN_COLUMNS)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`eviction_runs read failed: ${error.message}`);
  return (data as Record<string, unknown>[]) ?? [];
};

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));
  const loadRuns = deps.loadRuns ?? defaultLoadRuns;

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

    const limit = parseLimit(new URL(req.url).searchParams);
    let rows: Record<string, unknown>[];
    try {
      rows = await loadRuns(limit);
    } catch (_) {
      return jsonResponse(500, { error: 'internal_error' });
    }
    const runs: EvictionRunView[] = rows.map(toRun);
    return jsonResponse(200, { runs });
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
