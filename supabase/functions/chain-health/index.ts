// =============================================================================
// chain-health/index.ts  —  GET /chain-health  (sys-admin, #32 / T-528)
// -----------------------------------------------------------------------------
// Read side of the AI/OCR chain-health pages: returns every `circuit_breakers`
// row (one per provider). The observability tables are service-role-only (no
// RLS), so the mobile reads them through this sys-admin-gated endpoint rather
// than PostgREST. The mobile groups by `resource_type` (AI vs OCR chain) and
// derives the tri-state chain pill from the per-provider states.
//
// verify_jwt defaults to true (no config.toml entry); the handler additionally
// requires the caller's `app_metadata.is_system_admin` claim.
// =============================================================================

import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { type BreakerView, type CircuitBreakerRow, toBreaker } from './chain.ts';

export type CallerResolver = (req: Request) => Promise<CallerUser | null>;
export type BreakersLoader = () => Promise<CircuitBreakerRow[]>;

export type HandlerDeps = {
  getCallerUser?: CallerResolver;
  loadBreakers?: BreakersLoader;
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

const BREAKER_COLUMNS =
  'resource_type, resource_key, state, failure_count, last_failure_at, opened_at, reason, probes_sent, probes_succeeded, updated_at';

export const defaultLoadBreakers: BreakersLoader = async () => {
  const { data, error } = await buildServiceClient()
    .from('circuit_breakers')
    .select(BREAKER_COLUMNS)
    .order('resource_type', { ascending: true })
    .order('resource_key', { ascending: true });
  if (error) throw new Error(`circuit_breakers read failed: ${error.message}`);
  return (data as CircuitBreakerRow[] | null) ?? [];
};

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));
  const loadBreakers = deps.loadBreakers ?? defaultLoadBreakers;

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

    let rows: CircuitBreakerRow[];
    try {
      rows = await loadBreakers();
    } catch (_) {
      return jsonResponse(500, { error: 'internal_error' });
    }
    const breakers: BreakerView[] = rows.map(toBreaker);
    return jsonResponse(200, { breakers });
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
