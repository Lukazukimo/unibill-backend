// =============================================================================
// admin-circuit-control/index.ts  —  POST /admin-circuit-control (sys-admin)
// -----------------------------------------------------------------------------
// Write side of the sys-admin chain-health pages (#32 / T-528, backend T-633):
// force a circuit breaker OPEN (with reason) or CLOSED, or inject a synthetic
// failure. force_* are admin overrides written straight to circuit_breakers;
// simulate_failure goes through app.circuit_record_failure (may trip after the
// threshold). Every action emits a `circuit.admin_controlled` audit event.
//
// verify_jwt defaults to true; the handler additionally requires the caller's
// `app_metadata.is_system_admin` claim.
// =============================================================================

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { emitDomainEvent } from '../_shared/events.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { breakerRow, parseRequest } from './control.ts';

export type CallerResolver = (req: Request) => Promise<CallerUser | null>;

export type HandlerDeps = {
  client?: SupabaseClient;
  getCallerUser?: CallerResolver;
  now?: () => Date;
};

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));
  const now = deps.now ?? (() => new Date());

  return withCorrelation(async (_ctx, req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

    const caller = await getCaller(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }
    if (!caller.is_system_admin) {
      return jsonResponse(403, { error: 'forbidden', detail: 'system_admin required' });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch (_) {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const parsed = parseRequest(body);
    if (!parsed) return jsonResponse(422, { error: 'invalid_request' });

    const client = deps.client ?? buildServiceClient();
    const { resource_type, resource_key, action, reason } = parsed;

    let state: string;
    try {
      if (action === 'simulate_failure') {
        const { data, error } = await client.rpc('circuit_record_failure', {
          p_resource_type: resource_type,
          p_resource_key: resource_key,
          p_reason: reason ?? 'admin synthetic probe',
        });
        if (error) throw new Error(error.message);
        state = typeof data === 'string' ? data : 'unknown';
      } else {
        const row = breakerRow(action, reason, now());
        const { error } = await client
          .from('circuit_breakers')
          .upsert(
            { resource_type, resource_key, ...row },
            { onConflict: 'resource_type,resource_key' },
          );
        if (error) throw new Error(error.message);
        state = row.state as string;
      }
    } catch (_) {
      return jsonResponse(500, { error: 'internal_error' });
    }

    // Audit trail — best-effort; never unwinds the applied action.
    try {
      await emitDomainEvent({
        type: 'circuit.admin_controlled',
        actor_type: 'user',
        // The acting admin, on the canonical queryable column (not just payload).
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: { resource_type, resource_key, action, reason, state },
        },
        aggregate_type: 'circuit_breaker',
        // circuit_breakers is keyed by (resource_type, resource_key), not a UUID;
        // domain_events.aggregate_id is `uuid NOT NULL`. Use the zero-UUID (the
        // codebase convention for non-UUID aggregates, cf. auth.lockout) and keep
        // the real identifiers in the payload — otherwise the insert would throw
        // on the bad uuid and the (best-effort) audit would be silently lost.
        aggregate_id: '00000000-0000-0000-0000-000000000000',
      }, { client });
    } catch (_) {
      // audit failure must not fail the admin action
    }

    return jsonResponse(200, { resource_type, resource_key, state });
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
