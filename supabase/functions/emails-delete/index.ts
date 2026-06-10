/**
 * emails-delete — DELETE /emails/:id: revokes a connected Gmail credential.
 *
 * Soft-deletes the `connected_emails` row (deleted_at=now(), status='revoked'),
 * soft-deletes every active `connected_email_households` binding for the same
 * credential, and HARD-deletes the corresponding `vault.secrets` row via
 * `app.delete_vault_secret`. Emits domain_event `email.revoked` (best-effort).
 *
 * Ref:  T-214, spec §9.3.1 ("System admin pode 'revogar acesso'") + §E DELETE /emails/:id
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. Method gate (DELETE only). Anything else → 405.
 *   2. Path parse — `/emails/:id`. The :id is the connected_emails.id (NOT
 *      the vault secret uuid). Invalid path → 404 (do not leak topology).
 *   3. JWT extraction (caller user id) — 401 if missing/invalid.
 *   4. Load connected_emails row — 404 if not found, idempotent 200 if
 *      already soft-deleted (so retries are stable).
 *   5. Authorize: caller MUST be (owner_user_id == caller.id) OR a system
 *      admin (`is_system_admin` claim). Otherwise → 403.
 *      Note: in spec §5.11, "admin of a bound household" also has SELECT on
 *      connected_emails, but the DELETE/revoke action is restricted to
 *      `owner OR sys admin` per §E and §9.3.1 — household admins cannot
 *      revoke a credential they do not own. This intentionally narrows the
 *      destructive blast radius.
 *   6. Soft-delete the bindings:
 *        UPDATE connected_email_households
 *           SET deleted_at = now(), updated_at = now()
 *         WHERE connected_email_id = :id
 *           AND deleted_at IS NULL;
 *      (Partial unique index `uq_email_household_active` is satisfied because
 *      deleted_at IS NOT NULL falls out of the index.)
 *   7. Soft-delete the credential row:
 *        UPDATE connected_emails
 *           SET deleted_at = now(), updated_at = now(), status = 'revoked'
 *         WHERE id = :id AND deleted_at IS NULL;
 *      We do NOT NULL-out `app_password_secret` so the audit row preserves
 *      the linkage; the vault row is destroyed below so the dangling pointer
 *      cannot be used to decrypt anything.
 *   8. Hard-delete the vault secret:
 *        SELECT app.delete_vault_secret(<secret_id>) AS deleted;
 *      `false` (already gone) is treated as success — see migration comments.
 *   9. Emit domain_event `email.revoked` (best-effort; never unwinds).
 *  10. Return 200 { soft_deleted: true }.
 *
 * Response shape (200):
 *   { soft_deleted: true }
 *
 * Test-injection seams (handler exported as `buildHandler({...})`):
 *   - `getCallerUser`   — stub to inject { id, isSystemAdmin } without JWT
 *   - `client`          — Supabase service-role client (injectable)
 *   - `emitEvent`       — defaults to events.ts emitDomainEvent stub
 *   - `now`             — clock stub for deterministic timestamps in tests
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { redactSecrets } from '../_shared/redact.ts';
import {
  emitDomainEvent,
  type DomainEventInput,
} from '../_shared/events.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeleteEmailResponse = {
  soft_deleted: true;
};

/**
 * Authenticated caller. `isSystemAdmin` reflects the `app_metadata.is_system_admin`
 * claim baked into the JWT by the bootstrap flow (spec §9.2). The default
 * resolver below pulls it from `data.user.app_metadata.is_system_admin`.
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

/**
 * Extracts the `:id` segment from a `/emails/:id`-shaped path.
 *
 * Returns null when the URL does not match — handler maps that to 404 so an
 * attacker can't infer route topology by probing.
 *
 * Accepted shapes (the function is mounted at different prefixes depending
 * on deployment — Supabase Edge routes are `/functions/v1/emails-delete`):
 *   /emails/<uuid>
 *   /functions/v1/emails-delete/<uuid>
 *   /functions/v1/emails-delete?id=<uuid>          (fallback)
 *
 * Notes:
 *   * We intentionally do NOT accept `/emails/<uuid>/anything` because that
 *     shape is owned by sibling endpoints (e.g. /emails/:id/rotate-password).
 *     A bare /emails/:id (with optional trailing slash) is the canonical
 *     contract for DELETE.
 */
export function extractConnectedEmailId(url: URL): string | null {
  // Prefer query param if present (explicit > implicit) — used by the
  // Supabase function shape that does not include the id in the path.
  const queryId = url.searchParams.get('id');
  if (queryId && UUID_RE.test(queryId)) return queryId.toLowerCase();

  // Pattern 1: /emails/<uuid>(/)?$
  const m1 = url.pathname.match(/\/emails\/([0-9a-f-]{36})\/?$/i);
  if (m1 && UUID_RE.test(m1[1])) return m1[1].toLowerCase();

  // Pattern 2: /<anything>/emails-delete/<uuid>(/)?$
  const m2 = url.pathname.match(/\/emails-delete\/([0-9a-f-]{36})\/?$/i);
  if (m2 && UUID_RE.test(m2[1])) return m2[1].toLowerCase();

  return null;
}

// ---------------------------------------------------------------------------
// Default resolvers (production)
// ---------------------------------------------------------------------------

/**
 * Default JWT → caller resolver. Verifies the Authorization header with
 * Supabase Auth `getUser(jwt)` and reads `app_metadata.is_system_admin`
 * (stored as a JSON boolean by the bootstrap script — see T-117 comments).
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
    // GoTrue stores the value as a JSON boolean; we also accept the legacy
    // string form ("true") that matches the SQL helper `app.is_system_admin`.
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

    // 1) Path → connected_email_id
    const url = new URL(req.url);
    const connectedEmailId = extractConnectedEmailId(url);
    if (!connectedEmailId) {
      return jsonResponse(404, { error: 'not_found' });
    }

    // 2) JWT → caller
    const caller: CallerUser | null = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    const client = deps.client ?? buildServiceClient();

    // 3) Load connected_emails row (owner + secret_id + status + deleted_at).
    //    We need owner_user_id BEFORE the auth check (cannot 403 a row we
    //    cannot read), and we need app_password_secret AFTER auth so we can
    //    forward it to the vault wrapper. One SELECT covers both.
    const { data: row, error: loadErr } = await client
      .from('connected_emails')
      .select('id, owner_user_id, email_address, app_password_secret, status, deleted_at')
      .eq('id', connectedEmailId)
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

    // 4) Authorize: owner OR sys admin. Anything else → 403.
    //    The auth check is performed BEFORE the idempotency short-circuit so a
    //    non-owner probing a revoked id sees the same 403 regardless of state
    //    (no information leak about whether the credential ever existed for
    //    another user).
    const isOwner = row.owner_user_id === caller.id;
    if (!isOwner && !caller.isSystemAdmin) {
      return jsonResponse(403, {
        error: 'forbidden',
        detail: 'only the credential owner or a system admin can revoke',
      });
    }

    // 5) Idempotent short-circuit: if the row is already soft-deleted, we
    //    return 200 without touching anything else. The vault secret was
    //    destroyed by the first DELETE; re-deleting it would be a no-op
    //    (the wrapper returns FALSE), and re-emitting the event is wrong.
    if (row.deleted_at !== null) {
      return jsonResponse(200, { soft_deleted: true } satisfies DeleteEmailResponse);
    }

    const now = clock();
    const nowIso = now.toISOString();
    const secretId = row.app_password_secret as string;
    const emailAddress = row.email_address as string;

    // 6) Soft-delete every active binding first. We do bindings BEFORE the
    //    parent row so a partial failure leaves the credential row visible
    //    (with bindings already gone) instead of leaving orphan active
    //    bindings to a revoked credential — easier to diagnose & remediate.
    const { error: bindErr } = await client
      .from('connected_email_households')
      .update({ deleted_at: nowIso, updated_at: nowIso })
      .eq('connected_email_id', connectedEmailId)
      .is('deleted_at', null);

    if (bindErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'connected_email_households soft-delete failed',
          connected_email_id: connectedEmailId,
          error: redactSecrets(bindErr.message),
        }),
      );
      return jsonResponse(500, { error: 'internal_error', code: 'bindings_revoke_failed' });
    }

    // 7) Soft-delete the credential row + flip status to 'revoked'.
    //    `eq('deleted_at', null)` doesn't compose in PostgREST (use is.null);
    //    we use .is('deleted_at', null) for the guard so a concurrent
    //    revoke from another tab loses the race cleanly (zero rows updated,
    //    we still return 200 — the other tab already did the work).
    const { error: revErr } = await client
      .from('connected_emails')
      .update({
        deleted_at: nowIso,
        updated_at: nowIso,
        status: 'revoked',
      })
      .eq('id', connectedEmailId)
      .is('deleted_at', null);

    if (revErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'connected_emails soft-delete failed',
          connected_email_id: connectedEmailId,
          error: redactSecrets(revErr.message),
        }),
      );
      return jsonResponse(500, { error: 'internal_error', code: 'credential_revoke_failed' });
    }

    // 8) Hard-delete the vault secret via SECURITY DEFINER wrapper.
    //    `false` = the secret was already gone (idempotent re-call) and is
    //    treated as success per the wrapper contract (migration T-214 docs).
    //    A true rpc error (rpcErr) is logged loudly but we DO NOT unwind the
    //    soft-deletes above: a vault secret left behind is a recoverable
    //    operator concern, while leaving the credential active after the user
    //    asked to revoke would be a security issue. Operators see the WARN
    //    log and can re-run app.delete_vault_secret manually.
    {
      const { error: vaultErr } = await client.rpc('delete_vault_secret', {
        secret_id: secretId,
      });
      if (vaultErr) {
        console.error(
          JSON.stringify({
            level: 'warn',
            correlation_id: ctx.correlation_id,
            msg: 'delete_vault_secret rpc failed (credential already soft-deleted)',
            connected_email_id: connectedEmailId,
            vault_secret_id: secretId,
            error: redactSecrets(vaultErr.message),
          }),
        );
      }
    }

    // 9) Emit domain_event email.revoked (best-effort, never unwinds).
    try {
      await emitEvent({
        type: 'email.revoked',
        aggregate_type: 'connected_email',
        aggregate_id: connectedEmailId,
        correlation_id: ctx.correlation_id,
        actor_type: 'user',
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: {
            email_address: emailAddress,
            revoked_at: nowIso,
            vault_secret_id: secretId,
            by_system_admin: !isOwner && caller.isSystemAdmin,
          },
        },
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'email.revoked emit failed (non-fatal)',
          error: redactSecrets(e instanceof Error ? e.message : String(e)),
        }),
      );
    }

    return jsonResponse(200, { soft_deleted: true } satisfies DeleteEmailResponse);
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
