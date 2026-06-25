/**
 * privacy-delete — DELETE /privacy/my-account (JWT user).
 *
 * LGPD right-to-erasure (§9.4). Validates the typed-back confirmation email,
 * blocks if the caller is the sole admin of any household (422 + handover list),
 * then runs the deletion sequence (orchestrator): soft-delete memberships +
 * owned emails, delete vault secrets, drop sys-admin grants, anonymize audit
 * refs (invoices remain), emit user.deleted, and finally remove the auth user.
 *
 * Ref:  T-609 (#119), spec §9.4 + §E (privacy/my-account), BR-021.
 * Date: 2026-06-25
 *
 * Flow:
 *   1. method gate (DELETE)                        → 405
 *   2. JWT → caller { id, email }                  → 401
 *   3. body parse { confirmation_email, reason? }  → 400 invalid_json
 *   4. confirmation_email === caller.email         → 400 confirmation_mismatch
 *   5. sole-admin households                        → 422 { households }
 *   6. orchestrator.deleteAccount                   → 200 { deletion_initiated }
 *
 * Idempotent: a repeat call after a completed deletion 401s (the JWT no longer
 * resolves); a repeat after a PARTIAL failure re-runs cleanly (every step is
 * safe to retry — see orchestrator.ts).
 *
 * Collaborators are injected (buildHandler) so the handler is unit-tested with
 * no real Storage / DB / Auth; production defaults are wired at the bottom.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { getCallerUser } from '../_shared/auth.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';
import { confirmationMatches, findSoleAdminHouseholds } from './checks.ts';
import {
  type Caller,
  defaultDeleteUser,
  defaultEmitEvent,
  deleteAccount,
  type DeleteUserFn,
} from './orchestrator.ts';
import { type DomainEventInput } from '../_shared/events.ts';

export type RunFn = (
  caller: Caller,
  client: SupabaseClient,
  correlationId: string,
) => Promise<{ deleted_at: string }>;

export type HandlerDeps = {
  getCallerUser: (req: Request) => Promise<Caller | null>;
  client?: SupabaseClient;
  findSoleAdmins?: (userId: string, client: SupabaseClient) => Promise<string[]>;
  /** Runs the deletion sequence. Default wires orchestrator.deleteAccount. */
  run?: RunFn;
  /** Overrides for the default `run` wiring. */
  emitEvent?: (e: DomainEventInput) => Promise<void>;
  deleteUser?: DeleteUserFn;
  now?: () => number;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const findSoleAdmins = deps.findSoleAdmins ?? findSoleAdminHouseholds;
  const now = deps.now ?? (() => Date.now());

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'DELETE') return jsonResponse(405, { error: 'method_not_allowed' });

    const caller = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const body = (raw ?? {}) as { confirmation_email?: unknown };

    if (!confirmationMatches(body.confirmation_email, caller.email)) {
      return jsonResponse(400, {
        error: 'confirmation_mismatch',
        detail: 'confirmation_email must match your account email',
      });
    }

    const client = deps.client ?? buildServiceClient();
    const run = deps.run ??
      ((c: Caller, cl: SupabaseClient, cid: string) =>
        deleteAccount(c, cl, {
          emitEvent: deps.emitEvent ?? defaultEmitEvent(cl),
          deleteUser: deps.deleteUser ?? defaultDeleteUser,
          now,
          correlationId: cid,
        }));

    try {
      const soleAdminOf = await findSoleAdmins(caller.id, client);
      if (soleAdminOf.length > 0) {
        return jsonResponse(422, {
          error: 'last_admin',
          detail: 'hand over admin in these households before deleting your account',
          households: soleAdminOf,
        });
      }

      await run(caller, client, ctx.correlation_id);

      log.info('privacy-delete: account deleted', {
        correlation_id: ctx.correlation_id,
        user_id: caller.id,
      });
      return jsonResponse(200, { deletion_initiated: true });
    } catch (e) {
      log.error('privacy-delete: deletion failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'deletion_failed' });
    }
  });
}

// --- bootstrap (production) -------------------------------------------------

export const handler = buildHandler({
  getCallerUser: (req: Request) => getCallerUser(req),
});

if (import.meta.main) {
  Deno.serve(handler);
}
