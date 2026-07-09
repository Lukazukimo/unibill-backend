// =============================================================================
// admin-system-admins/index.ts  —  POST /admin-system-admins (sys-admin)
// -----------------------------------------------------------------------------
// Promote/revoke a user's `is_system_admin` claim (#295 / T-217). Only an
// existing sys-admin may call it. The claim flip goes through the GoTrue Admin
// API (the single supported writer of auth.users); the atomic last-admin guard
// + append-only audit live in the SECURITY DEFINER RPC app.record_admin_change.
//
// ASYMMETRIC ordering makes the never-zero invariant provable:
//   promote = flip(true) -> record('granted')
//   revoke  = record('revoked')[UB004 guard] -> flip(false) -> assert-not-zero
// so the ledger's effective count is always <= the real claim count.
//
// verify_jwt defaults to true; the handler additionally requires the caller's
// `app_metadata.is_system_admin` claim.
// =============================================================================

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { deriveReason, parseRequest } from './admins.ts';

export type CallerResolver = (req: Request) => Promise<CallerUser | null>;

/** Flip the target's `app_metadata.is_system_admin` via the GoTrue Admin API. */
export type SetClaimFn = (
  client: SupabaseClient,
  userId: string,
  isAdmin: boolean,
) => Promise<void>;

export type EmitEventFn = (event: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  client?: SupabaseClient;
  getCallerUser?: CallerResolver;
  setSystemAdminClaim?: SetClaimFn;
  emitEvent?: EmitEventFn;
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

/** Default claim flip — mirrors privacy-delete's defaultDeleteUser seam. */
export const defaultSetSystemAdminClaim: SetClaimFn = async (client, userId, isAdmin) => {
  const { error } = await client.auth.admin.updateUserById(userId, {
    app_metadata: { is_system_admin: isAdmin },
  });
  if (error) {
    throw new Error(`admin-system-admins: updateUserById failed: ${error.message ?? ''}`);
  }
};

const WARNING = 'Target applies the claim change on next login or token refresh.';

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));
  const setClaim = deps.setSystemAdminClaim ?? defaultSetSystemAdminClaim;

  return withCorrelation(async (ctx, req) => {
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
    if ('error' in parsed) {
      return jsonResponse(422, { error: 'invalid_request', detail: parsed.error });
    }
    const { action, userId, email, note } = parsed.value;

    const client = deps.client ?? buildServiceClient();
    const emit = deps.emitEvent ?? ((e: DomainEventInput) => emitDomainEvent(e, { client }));

    // Resolve the target. email -> uuid via the service_role-only resolver;
    // a miss is a uniform 404 (no enumeration oracle).
    let targetId: string;
    if (userId) {
      targetId = userId;
    } else {
      const { data, error } = await client.rpc('resolve_user_id_by_email', { p_email: email });
      if (error) return jsonResponse(500, { error: 'internal_error' });
      if (!data) return jsonResponse(404, { error: 'user_not_found' });
      targetId = data as string;
    }

    const reason = deriveReason(action, targetId, caller.id);
    let changed = false;
    let effectiveCount = 0;

    try {
      if (action === 'promote') {
        // Flip the claim FIRST, then record — keeps ledger <= claim.
        await setClaim(client, targetId, true);
        const { data, error } = await client.rpc('record_admin_change', {
          p_target: targetId,
          p_action: 'granted',
          p_actor: caller.id,
          p_reason: reason,
          p_correlation: ctx.correlation_id,
        });
        if (error) return jsonResponse(500, { error: 'internal_error' });
        changed = (data as { changed?: boolean }).changed ?? false;
        effectiveCount = (data as { effective_count?: number }).effective_count ?? 0;
      } else {
        // Record + guard FIRST (UB004 if last), then flip the claim OFF.
        const { data, error } = await client.rpc('record_admin_change', {
          p_target: targetId,
          p_action: 'revoked',
          p_actor: caller.id,
          p_reason: reason,
          p_correlation: ctx.correlation_id,
        });
        if (error) {
          if ((error as { code?: string }).code === 'UB004') {
            return jsonResponse(409, {
              error: 'last_admin',
              detail: 'cannot revoke the last system admin',
            });
          }
          return jsonResponse(500, { error: 'internal_error' });
        }
        changed = (data as { changed?: boolean }).changed ?? false;
        effectiveCount = (data as { effective_count?: number }).effective_count ?? 0;

        // Flip the claim OFF, then assert the system still has an admin — and
        // FAIL CLOSED: on ANY failure (UB001, a transient/timeout error, or a
        // throw) re-admit the target rather than risk zero admins. A wrongly
        // re-admitted target is recoverable by a retry (which finds the ledger
        // already 'revoked' and re-flips off); zero admins is not.
        try {
          await setClaim(client, targetId, false);
          const assertRes = await client.rpc('assert_sys_admin_exists');
          if (assertRes.error) {
            throw new Error('post-revoke admin-count assertion failed');
          }
        } catch (_) {
          await setClaim(client, targetId, true).catch(() => {}); // compensate
          return jsonResponse(500, { error: 'internal_error' });
        }
      }
    } catch (_) {
      return jsonResponse(500, { error: 'internal_error' });
    }

    // Audit event — best-effort; never unwinds the applied change. The two
    // `type: '...'` literals below are what gen_events_doc.ts discovers.
    const eventBase = {
      actor_type: 'user' as const,
      actor_user_id: caller.id,
      aggregate_type: 'user',
      aggregate_id: targetId,
      correlation_id: ctx.correlation_id,
      payload: {
        version: 1,
        data: { reason, email: email ?? null, note: note ?? null, jwt_stale: true },
      },
    };
    try {
      await emit(
        action === 'promote'
          ? { type: 'system_admin.promoted', ...eventBase }
          : { type: 'system_admin.revoked', ...eventBase },
      );
    } catch (_) {
      // audit failure must not fail the admin action
    }

    return jsonResponse(200, {
      ok: true,
      action,
      user_id: targetId,
      email: email ?? null,
      changed,
      effective_admin_count: effectiveCount,
      jwt_stale: true,
      warning: WARNING,
    });
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
