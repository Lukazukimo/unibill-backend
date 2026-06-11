/**
 * auth-consent-status — GET /auth/consent-status: returns the caller's active
 * consents plus a `needs_reconsent` flag indicating whether the user must
 * re-accept `terms` and/or `privacy` before being allowed into the app.
 *
 * Ref:  T-229, spec §5.9 ("Trigger de re-consent automático" — quando
 *        app_settings.key='legal.terms_version' muda, próximo login verifica
 *        que a versão ativa em consent_log bate com a publicada; se não bater,
 *        bloqueia entrada até re-aceitar) + BR-017 (Login bloqueia até
 *        re-aceitar, evento `consent.required`).
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. Method gate (GET only) — anything else → 405.
 *   2. JWT extraction (caller user id) — 401 if missing/invalid.
 *   3. Load published versions from app_settings (scope='global'):
 *        - legal.terms_version    → string (value->>'v')
 *        - legal.privacy_version  → string (value->>'v')
 *      Missing keys are treated as "no enforcement" — needs_reconsent=false
 *      for that purpose. We log a warn-level line because the seed should
 *      ALWAYS populate them (see seeds/app_settings_defaults.sql T-118), so
 *      a missing key means the env is mis-seeded.
 *   4. Load the user's ACTIVE consents (revoked_at IS NULL) for purposes
 *      terms + privacy. The partial UNIQUE
 *      `uq_consent_active_per_purpose ON (user_id, purpose) WHERE revoked_at
 *      IS NULL` guarantees at most one row per (user, purpose).
 *   5. Compare per-purpose:
 *        - If app_settings has a published version AND
 *          (no active row OR active.version != published) → re-consent needed.
 *   6. Emit domain_event `consent.required` (best-effort, never unwinds) when
 *      ANY purpose requires re-consent. Payload includes which purposes are
 *      stale + the published vs accepted versions, so observability dashboards
 *      can flag "terms_version was bumped but X users not yet re-prompted".
 *   7. Return 200 with:
 *        {
 *          needs_reconsent: bool,        // OR of per-purpose flags
 *          purposes: {
 *            terms:   { published, accepted, needs_reconsent },
 *            privacy: { published, accepted, needs_reconsent }
 *          },
 *          active: [{ purpose, version, accepted_at }, ...]   // full active set
 *        }
 *
 * Client contract (Flutter AuthBloc — T-229 mobile half):
 *   - Call after successful supabase.auth.signInWithPassword.
 *   - If needs_reconsent=true → push '/auth/consent' and BLOCK '/'.
 *   - Re-call after consent-accept returns 200; if needs_reconsent=false,
 *     unblock navigation.
 *
 * Why GET (and not POST)?
 *   - Idempotent + safe; can be called by AppLifecycleState.resumed on cold start.
 *   - No body; the JWT is the only input.
 *   - No mutation; mobile can cache the response with short TTL safely.
 *
 * Test-injection seams (handler exported as `buildHandler({...})`):
 *   - `getCallerUser` — stub to inject { id } without JWT
 *   - `client`        — Supabase service-role client (injectable)
 *   - `emitEvent`     — defaults to events.ts emitDomainEvent stub
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

/**
 * Purposes that GATE access to the app. If the published version for any of
 * these differs from the user's active accepted version, login is blocked
 * until the user re-accepts. (Telemetry/marketing are OPT-IN and never gate
 * access — they live in the `active` summary for the Settings screen.)
 */
export const GATING_PURPOSES: ReadonlyArray<Extract<ConsentPurpose, 'terms' | 'privacy'>> = [
  'terms',
  'privacy',
] as const;

export type PurposeStatus = {
  /** Version currently published in app_settings.legal.<purpose>_version. */
  published: string | null;
  /** Version the user has actively accepted (revoked_at IS NULL). */
  accepted: string | null;
  /**
   * True when a published version exists AND the accepted version is missing
   * or differs. `null` published means we don't enforce (mis-seeded env).
   */
  needs_reconsent: boolean;
};

export type ActiveConsentSummary = {
  purpose: ConsentPurpose;
  version: string;
  accepted_at: string;
};

export type ConsentStatusResponse = {
  /** True iff ANY gating purpose needs re-consent. Client gates routing on this. */
  needs_reconsent: boolean;
  /** Per-gating-purpose breakdown so the consent screen knows what to re-prompt. */
  purposes: {
    terms: PurposeStatus;
    privacy: PurposeStatus;
  };
  /** Full active-consent list, including non-gating purposes (telemetry/marketing). */
  active: ActiveConsentSummary[];
};

export type CallerUser = { id: string };
export type CallerUserResolver = (req: Request) => Promise<CallerUser | null>;
export type EmitEventFn = (e: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  getCallerUser: CallerUserResolver;
  client?: SupabaseClient;
  emitEvent?: EmitEventFn;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMS_KEY = 'legal.terms_version';
const PRIVACY_KEY = 'legal.privacy_version';

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
 * Extracts the published version string from an app_settings row.
 * Convention (spec §B / seed T-118): value is wrapped as `{"v": <typed>}`.
 * Returns null when row is missing, value is malformed, or `v` is not a string.
 */
export function extractVersionFromSetting(
  row: { value: unknown } | null | undefined,
): string | null {
  if (!row || row.value === null || row.value === undefined) return null;
  const value = row.value as unknown;
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>).v;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Computes the per-purpose status from published + accepted versions.
 * `null` published means "no enforcement" → never needs_reconsent.
 */
export function computePurposeStatus(
  published: string | null,
  accepted: string | null,
): PurposeStatus {
  const needs = published !== null && accepted !== published;
  return {
    published,
    accepted,
    needs_reconsent: needs,
  };
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

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'GET') {
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

    const client = deps.client ?? buildServiceClient();

    // 2) Load published gating versions from app_settings (scope='global').
    //    A single query with `.in(...)` is cheaper than two round-trips and
    //    keeps the endpoint p99 < 100ms even on cold connections.
    const { data: settingsRows, error: settingsErr } = await client
      .from('app_settings')
      .select('key, value')
      .eq('scope', 'global')
      .is('scope_id', null)
      .in('key', [TERMS_KEY, PRIVACY_KEY]);

    if (settingsErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'app_settings query failed',
          user_id: caller.id,
          error: redactSecrets(settingsErr.message),
        }),
      );
      return jsonResponse(500, {
        error: 'internal_error',
        code: 'settings_query_failed',
      });
    }

    const settingsByKey = new Map<string, { value: unknown }>();
    for (const row of settingsRows ?? []) {
      settingsByKey.set(row.key as string, { value: row.value });
    }
    const publishedTerms = extractVersionFromSetting(
      settingsByKey.get(TERMS_KEY),
    );
    const publishedPrivacy = extractVersionFromSetting(
      settingsByKey.get(PRIVACY_KEY),
    );

    if (publishedTerms === null || publishedPrivacy === null) {
      // Seed T-118 populates both; missing means env is mis-seeded. Don't
      // block the user (otherwise an ops slip locks everyone out), but log
      // a loud warn so observability catches it.
      console.warn(
        JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'consent-status: missing gating version key in app_settings',
          user_id: caller.id,
          terms_missing: publishedTerms === null,
          privacy_missing: publishedPrivacy === null,
        }),
      );
    }

    // 3) Load the user's ACTIVE consents (revoked_at IS NULL). We fetch ALL
    //    purposes (not just gating) so the response can populate the
    //    Settings → Privacidade screen in one round-trip.
    const { data: activeRows, error: activeErr } = await client
      .from('consent_log')
      .select('purpose, version, accepted_at')
      .eq('user_id', caller.id)
      .is('revoked_at', null)
      .order('purpose', { ascending: true });

    if (activeErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'consent_log query failed',
          user_id: caller.id,
          error: redactSecrets(activeErr.message),
        }),
      );
      return jsonResponse(500, {
        error: 'internal_error',
        code: 'consent_query_failed',
      });
    }

    const acceptedByPurpose = new Map<ConsentPurpose, string>();
    const active: ActiveConsentSummary[] = [];
    for (const row of activeRows ?? []) {
      const purpose = row.purpose as ConsentPurpose;
      const version = row.version as string;
      const acceptedAt = row.accepted_at as string;
      acceptedByPurpose.set(purpose, version);
      active.push({ purpose, version, accepted_at: acceptedAt });
    }

    // 4) Compute per-gating-purpose status.
    const termsStatus = computePurposeStatus(
      publishedTerms,
      acceptedByPurpose.get('terms') ?? null,
    );
    const privacyStatus = computePurposeStatus(
      publishedPrivacy,
      acceptedByPurpose.get('privacy') ?? null,
    );
    const needsReconsent = termsStatus.needs_reconsent ||
      privacyStatus.needs_reconsent;

    // 5) Emit domain_event consent.required when re-consent is needed.
    //    Best-effort: a failure here MUST NOT block the gating signal returned
    //    to the client (the LGPD invariant is upheld by the response itself).
    if (needsReconsent) {
      try {
        await emitEvent({
          type: 'consent.required',
          aggregate_type: 'consent_log',
          aggregate_id: caller.id, // user-scoped event; no consent row yet
          correlation_id: ctx.correlation_id,
          actor_type: 'user',
          actor_user_id: caller.id,
          payload: {
            version: 1,
            data: {
              stale_purposes: [
                termsStatus.needs_reconsent ? 'terms' : null,
                privacyStatus.needs_reconsent ? 'privacy' : null,
              ].filter((p): p is 'terms' | 'privacy' => p !== null),
              terms: {
                published: termsStatus.published,
                accepted: termsStatus.accepted,
              },
              privacy: {
                published: privacyStatus.published,
                accepted: privacyStatus.accepted,
              },
            },
          },
        });
      } catch (e) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            correlation_id: ctx.correlation_id,
            msg: 'consent.required emit failed (non-fatal)',
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          }),
        );
      }
    }

    const response: ConsentStatusResponse = {
      needs_reconsent: needsReconsent,
      purposes: {
        terms: termsStatus,
        privacy: privacyStatus,
      },
      active,
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
