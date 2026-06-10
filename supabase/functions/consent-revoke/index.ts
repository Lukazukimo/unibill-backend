/**
 * consent-revoke — POST /consent/revoke: revoga o consent ATIVO de uma finalidade
 * para o usuário autenticado. Se `purpose='telemetry'`, também PURGA
 * client_telemetry WHERE user_id=me (per spec §9.4 "telemetria revogada").
 *
 * Ref:  T-228, spec §9.4 ("revogação granular", "telemetria revogada: cliente
 *        para de enviar imediatamente; backend purga client_telemetry") +
 *        §5.9 (consent_log granular per purpose)
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. Method gate (POST only) — anything else → 405.
 *   2. JWT extraction (caller user id) — 401 if missing/invalid.
 *   3. Body parse + validation:
 *        - purpose       : enum ('terms' | 'privacy' | 'telemetry' | 'marketing')
 *        - revoked_reason: optional text, max 256 chars (default 'user_request')
 *      → 422 on validation failure with field-level details.
 *   4. UPDATE consent_log SET revoked_at=now(), revoked_reason=:reason
 *      WHERE user_id=me AND purpose=:purpose AND revoked_at IS NULL
 *      RETURNING id, version, accepted_at;
 *      → If 0 rows updated → 404 (no active consent for this purpose).
 *   5. If purpose='telemetry', DELETE FROM client_telemetry WHERE user_id=me.
 *      Per §9.4 LGPD: opt-in withdrawn means we must stop processing and
 *      purge backlog. The DELETE is best-effort with a warn-level log on
 *      failure — the revocation itself is the user-facing primitive and
 *      MUST succeed; telemetry purge is a downstream side-effect we re-attempt
 *      via a daily reconciliation cron (out of scope for this PR).
 *   6. Emit domain_event `consent.revoked` with payload {purpose, version,
 *      revoked_reason, telemetry_purged_count?}.
 *   7. Return 200 with the revoked row summary + the user's remaining
 *      active-consent list so the client can re-render Settings immediately.
 *
 * Response shape (200):
 *   {
 *     revoked: {
 *       id, purpose, version, accepted_at, revoked_at, revoked_reason
 *     },
 *     active: [
 *       { purpose, version, accepted_at }, ...
 *     ],
 *     telemetry_purged: number | null    // null when purpose != 'telemetry'
 *   }
 *
 * Response shape (404):
 *   { error: 'no_active_consent', detail: 'no active consent for this purpose' }
 *
 * Test-injection seams (handler exported as `buildHandler({...})`):
 *   - `getCallerUser`   — stub to inject { id } without JWT
 *   - `client`          — Supabase service-role client (injectable)
 *   - `emitEvent`       — defaults to events.ts emitDomainEvent stub
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

export type ConsentPurpose = 'terms' | 'privacy' | 'telemetry' | 'marketing';

export const CONSENT_PURPOSES: ReadonlyArray<ConsentPurpose> = [
  'terms',
  'privacy',
  'telemetry',
  'marketing',
] as const;

export type RevokeConsentRequest = {
  purpose: ConsentPurpose;
  revoked_reason?: string;
};

export type RevokedConsentRow = {
  id: string;
  purpose: ConsentPurpose;
  version: string;
  accepted_at: string;
  revoked_at: string;
  revoked_reason: string;
};

export type RevokeConsentResponse = {
  revoked: RevokedConsentRow;
  active: Array<{
    purpose: ConsentPurpose;
    version: string;
    accepted_at: string;
  }>;
  telemetry_purged: number | null;
};

export type CallerUser = { id: string };
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

const REASON_MAX_LENGTH = 256;
const REASON_DEFAULT = 'user_request';

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
 * Validates the JSON body shape for POST /consent/revoke.
 * Returns either the parsed value or a list of field-level errors.
 */
export function validateRevokeBody(value: unknown): {
  ok: true;
  data: { purpose: ConsentPurpose; revoked_reason: string };
} | {
  ok: false;
  errors: Array<{ field: string; message: string }>;
} {
  const errors: Array<{ field: string; message: string }> = [];

  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      errors: [{ field: '', message: 'body must be a JSON object' }],
    };
  }
  const v = value as Record<string, unknown>;

  // purpose
  let purpose: ConsentPurpose | null = null;
  if (typeof v.purpose !== 'string') {
    errors.push({ field: 'purpose', message: 'must be a string' });
  } else if (!CONSENT_PURPOSES.includes(v.purpose as ConsentPurpose)) {
    errors.push({
      field: 'purpose',
      message: `must be one of: ${CONSENT_PURPOSES.join(', ')}`,
    });
  } else {
    purpose = v.purpose as ConsentPurpose;
  }

  // revoked_reason (optional)
  let reason = REASON_DEFAULT;
  if (v.revoked_reason !== undefined) {
    if (typeof v.revoked_reason !== 'string') {
      errors.push({
        field: 'revoked_reason',
        message: 'must be a string if provided',
      });
    } else {
      const trimmed = v.revoked_reason.trim();
      if (trimmed.length === 0) {
        // Treat empty as "use default" — friendlier than 422.
        reason = REASON_DEFAULT;
      } else if (trimmed.length > REASON_MAX_LENGTH) {
        errors.push({
          field: 'revoked_reason',
          message: `max ${REASON_MAX_LENGTH} chars`,
        });
      } else {
        reason = trimmed;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { purpose: purpose!, revoked_reason: reason } };
}

// ---------------------------------------------------------------------------
// Default resolvers (production)
// ---------------------------------------------------------------------------

/**
 * Default JWT → caller resolver. Verifies the Authorization header with
 * Supabase Auth `getUser(jwt)`. Returns null on missing/invalid token —
 * handler maps that to HTTP 401.
 */
export const defaultGetCallerUser: CallerUserResolver = async (req) => {
  const auth = req.headers.get('authorization') ??
    req.headers.get('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const jwt = auth.slice(7).trim();
  if (!jwt) return null;

  const client = buildServiceClient();
  try {
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user) return null;
    return { id: data.user.id };
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
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    // 1) JWT → caller
    const caller = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, {
        error: 'unauthorized',
        detail: 'missing or invalid JWT',
      });
    }

    // 2) Body parse + validation
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const parsed = validateRevokeBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, {
        error: 'validation_failed',
        details: parsed.errors,
      });
    }
    const { purpose, revoked_reason } = parsed.data;

    const client = deps.client ?? buildServiceClient();
    const now = clock();
    const nowIso = now.toISOString();

    // 3) UPDATE the active row. `.select(...)` returns the affected rows so
    //    we can detect "no active consent" (404) vs success (1+ rows).
    //    Partial UNIQUE uq_consent_active_per_purpose guarantees at most one
    //    active row per (user, purpose), so this MUST update 0 or 1 row.
    const { data: revokedRows, error: revErr } = await client
      .from('consent_log')
      .update({
        revoked_at: nowIso,
        revoked_reason,
      })
      .eq('user_id', caller.id)
      .eq('purpose', purpose)
      .is('revoked_at', null)
      .select('id, purpose, version, accepted_at, revoked_at, revoked_reason');

    if (revErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'consent_log revoke update failed',
          user_id: caller.id,
          purpose,
          error: redactSecrets(revErr.message),
        }),
      );
      return jsonResponse(500, {
        error: 'internal_error',
        code: 'revoke_failed',
      });
    }
    if (!revokedRows || revokedRows.length === 0) {
      return jsonResponse(404, {
        error: 'no_active_consent',
        detail: 'no active consent for this purpose',
      });
    }
    const revoked = revokedRows[0] as RevokedConsentRow;

    // 4) Telemetry-specific side-effect: purge client_telemetry rows for the
    //    user. Best-effort — if it fails we still return 200 (the revocation
    //    is what the user asked for; cleanup is a downstream concern handled
    //    by a daily reconcile cron). We surface the purged count so observers
    //    can spot anomalies.
    let telemetryPurged: number | null = null;
    if (purpose === 'telemetry') {
      const { error: delErr, count } = await client
        .from('client_telemetry')
        .delete({ count: 'exact' })
        .eq('user_id', caller.id);
      if (delErr) {
        console.error(
          JSON.stringify({
            level: 'warn',
            correlation_id: ctx.correlation_id,
            msg: 'client_telemetry purge failed (non-fatal; revocation still applied)',
            user_id: caller.id,
            error: redactSecrets(delErr.message),
          }),
        );
        telemetryPurged = null;
      } else {
        telemetryPurged = count ?? 0;
      }
    }

    // 5) Fetch the user's remaining active-consent summary. Indexed via
    //    uq_consent_active_per_purpose — cheap.
    const { data: activeRows } = await client
      .from('consent_log')
      .select('purpose, version, accepted_at')
      .eq('user_id', caller.id)
      .is('revoked_at', null)
      .order('purpose', { ascending: true });

    // 6) Emit domain_event consent.revoked (best-effort; never unwinds).
    try {
      await emitEvent({
        type: 'consent.revoked',
        aggregate_type: 'consent_log',
        aggregate_id: revoked.id,
        correlation_id: ctx.correlation_id,
        actor_type: 'user',
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: {
            purpose,
            consent_version: revoked.version,
            revoked_reason,
            revoked_at: nowIso,
            telemetry_purged: telemetryPurged,
          },
        },
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'consent.revoked emit failed (non-fatal)',
          error: redactSecrets(e instanceof Error ? e.message : String(e)),
        }),
      );
    }

    const response: RevokeConsentResponse = {
      revoked,
      active: (activeRows ?? []).map((r) => ({
        purpose: r.purpose as ConsentPurpose,
        version: r.version as string,
        accepted_at: r.accepted_at as string,
      })),
      telemetry_purged: telemetryPurged,
    };
    return jsonResponse(200, response);
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
