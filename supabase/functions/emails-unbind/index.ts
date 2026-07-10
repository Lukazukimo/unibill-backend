/**
 * emails-unbind — DELETE /emails/:id/households/:household_id.
 *
 * Soft-deletes a SINGLE `connected_email_households` binding (deleted_at=now())
 * without revoking the credential: the Gmail stays active for its other
 * households. Emits domain_event `email.household_unbound` (best-effort).
 *
 * This is the owner-based counterpart to the admin-based RLS
 * (`connected_email_households_admin_write`): the function runs with the
 * service-role client (bypasses RLS) and authorizes IN CODE by owner-of-email
 * OR sys admin — mirroring `emails-delete`, so the destructive blast radius is
 * consistent (a household admin who does not own the credential cannot unbind).
 *
 * Ref:  T-521 (#71 Slice 2), spec §5.2 / §E
 * Date: 2026-07-10
 *
 * Flow (per request):
 *   1. Method gate (DELETE only). Anything else → 405.
 *   2. Parse `id` (connected_email_id) + `household_id` — 404 on missing/malformed
 *      (do not leak topology).
 *   3. JWT extraction (caller user id) — 401 if missing/invalid.
 *   4. Load connected_emails row (owner + deleted_at) — 404 if not found,
 *      500 on a load error.
 *   5. Authorize: caller MUST be (owner_user_id == caller.id) OR a system
 *      admin. Otherwise → 403. (Performed BEFORE the idempotency short-circuit
 *      so a non-owner cannot infer state.)
 *   6. Idempotent short-circuit: if the credential is already soft-deleted, its
 *      bindings fell with it (emails-delete cascades) → 200 without touching
 *      anything.
 *   7. Soft-delete the ONE active binding:
 *        UPDATE connected_email_households
 *           SET deleted_at = now(), updated_at = now()
 *         WHERE connected_email_id = :id
 *           AND household_id = :household_id
 *           AND deleted_at IS NULL
 *         RETURNING id;
 *      (Partial unique index `uq_email_household_active` allows a later re-bind.)
 *   8. Emit domain_event `email.household_unbound` ONLY when a row was actually
 *      unbound (best-effort; a retry that unbinds nothing stays quiet).
 *   9. Return 200 { unbound: true } — idempotent (zero rows affected is success).
 *
 * Response shape (200):
 *   { unbound: true }
 *
 * Test-injection seams (handler exported as `buildHandler({...})`):
 *   - `getCallerUser`   — stub to inject { id, isSystemAdmin } without JWT
 *   - `client`          — Supabase service-role client (injectable)
 *   - `emitEvent`       — defaults to events.ts emitDomainEvent
 *   - `now`             — clock stub for deterministic timestamps in tests
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UnbindEmailResponse = {
  unbound: true;
};

/**
 * Authenticated caller. `isSystemAdmin` reflects the
 * `app_metadata.is_system_admin` claim baked into the JWT (spec §9.2).
 */
export type CallerUser = {
  id: string;
  isSystemAdmin: boolean;
};

export type CallerUserResolver = (req: Request) => Promise<CallerUser | null>;

export type EmitEventFn = (e: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  getCallerUser: CallerUserResolver;
  client?: SupabaseClient;
  emitEvent?: EmitEventFn;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type UnbindTarget = {
  emailId: string;
  householdId: string;
};

/**
 * Extracts `id` (connected_email_id) + `household_id` from the request URL.
 *
 * Returns null when either is missing/malformed — the handler maps that to 404
 * so an attacker cannot infer route topology by probing.
 *
 * Accepted shapes (query preferred — that is how the mobile client invokes it):
 *   ?id=<uuid>&household_id=<uuid>
 *   /emails/<uuid>/households/<uuid>
 *   /functions/v1/emails-unbind/<uuid>/<uuid>
 */
export function extractUnbindTarget(url: URL): UnbindTarget | null {
  const queryId = url.searchParams.get('id');
  const queryHousehold = url.searchParams.get('household_id');
  if (queryId && queryHousehold && UUID_RE.test(queryId) && UUID_RE.test(queryHousehold)) {
    return { emailId: queryId.toLowerCase(), householdId: queryHousehold.toLowerCase() };
  }

  // Pattern 1: /emails/<uuid>/households/<uuid>(/)?$
  const m1 = url.pathname.match(
    /\/emails\/([0-9a-f-]{36})\/households\/([0-9a-f-]{36})\/?$/i,
  );
  if (m1 && UUID_RE.test(m1[1]) && UUID_RE.test(m1[2])) {
    return { emailId: m1[1].toLowerCase(), householdId: m1[2].toLowerCase() };
  }

  // Pattern 2: /<anything>/emails-unbind/<uuid>/<uuid>(/)?$
  const m2 = url.pathname.match(
    /\/emails-unbind\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/?$/i,
  );
  if (m2 && UUID_RE.test(m2[1]) && UUID_RE.test(m2[2])) {
    return { emailId: m2[1].toLowerCase(), householdId: m2[2].toLowerCase() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default resolvers (production)
// ---------------------------------------------------------------------------

/**
 * Default JWT → caller resolver. Verifies the Authorization header with
 * Supabase Auth `getUser(jwt)` and reads `app_metadata.is_system_admin`.
 * Returns null on missing/invalid token — handler maps that to HTTP 401.
 */
export const defaultGetCallerUser: CallerUserResolver = async (req) => {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const jwt = auth.slice(7).trim();
  if (!jwt) return null;

  const client = buildServiceClient();
  try {
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const claim = (data.user.app_metadata as Record<string, unknown> | null)
      ?.['is_system_admin'];
    const isSystemAdmin = claim === true || claim === 'true';
    return { id: data.user.id, isSystemAdmin };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const emitEvent = deps.emitEvent ?? emitDomainEvent;
  const clock = deps.now ?? (() => new Date());

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'DELETE') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    // 1) Parse ids.
    const url = new URL(req.url);
    const target = extractUnbindTarget(url);
    if (!target) {
      return jsonResponse(404, { error: 'not_found' });
    }
    const { emailId, householdId } = target;

    // 2) JWT → caller.
    const caller: CallerUser | null = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    const client = deps.client ?? buildServiceClient();

    // 3) Load the credential (owner + deleted_at). We need owner BEFORE the
    //    auth check (cannot 403 a row we cannot read).
    const { data: row, error: loadErr } = await client
      .from('connected_emails')
      .select('id, owner_user_id, email_address, deleted_at')
      .eq('id', emailId)
      .maybeSingle();

    if (loadErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'connected_emails load failed',
          error: redactSecrets(loadErr.message),
        }),
      );
      return jsonResponse(500, { error: 'internal_error', code: 'load_failed' });
    }
    if (!row) {
      return jsonResponse(404, { error: 'not_found' });
    }

    // 4) Authorize: owner OR sys admin. Checked BEFORE the idempotency
    //    short-circuit so a non-owner probing sees the same 403 regardless of
    //    state (no information leak).
    const isOwner = row.owner_user_id === caller.id;
    if (!isOwner && !caller.isSystemAdmin) {
      return jsonResponse(403, {
        error: 'forbidden',
        detail: 'only the credential owner or a system admin can unbind',
      });
    }

    // 5) Idempotent short-circuit: a soft-deleted credential already dropped
    //    its bindings (emails-delete cascades), so there is nothing to unbind.
    if (row.deleted_at !== null) {
      return jsonResponse(200, { unbound: true } satisfies UnbindEmailResponse);
    }

    const nowIso = clock().toISOString();
    const emailAddress = row.email_address as string;

    // 6) Soft-delete the one active binding. RETURNING id tells us whether a
    //    row was actually unbound (drives the conditional event emit); zero
    //    rows is still success (idempotent — already unbound / never bound).
    const { data: affected, error: bindErr } = await client
      .from('connected_email_households')
      .update({ deleted_at: nowIso, updated_at: nowIso })
      .eq('connected_email_id', emailId)
      .eq('household_id', householdId)
      .is('deleted_at', null)
      .select('id');

    if (bindErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'connected_email_households unbind failed',
          connected_email_id: emailId,
          household_id: householdId,
          error: redactSecrets(bindErr.message),
        }),
      );
      return jsonResponse(500, { error: 'internal_error', code: 'unbind_failed' });
    }

    const unboundCount = Array.isArray(affected) ? affected.length : 0;

    // 7) Emit the event only when a binding was actually removed (a retry that
    //    unbinds nothing must not re-emit). Best-effort — never unwinds.
    if (unboundCount > 0) {
      try {
        await emitEvent({
          type: 'email.household_unbound',
          aggregate_type: 'connected_email',
          aggregate_id: emailId,
          correlation_id: ctx.correlation_id,
          actor_type: 'user',
          actor_user_id: caller.id,
          payload: {
            version: 1,
            data: {
              email_address: emailAddress,
              household_id: householdId,
              unbound_at: nowIso,
              by_system_admin: !isOwner && caller.isSystemAdmin,
            },
          },
        });
      } catch (e) {
        console.error(
          JSON.stringify({
            level: 'warn',
            correlation_id: ctx.correlation_id,
            msg: 'email.household_unbound emit failed (non-fatal)',
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          }),
        );
      }
    }

    return jsonResponse(200, { unbound: true } satisfies UnbindEmailResponse);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap (production)
// ---------------------------------------------------------------------------

export const handler = buildHandler({
  getCallerUser: defaultGetCallerUser,
});

if (import.meta.main) {
  Deno.serve(handler);
}
