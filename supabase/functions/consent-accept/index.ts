/**
 * consent-accept — POST /consent/accept: registra um consent ATIVO por finalidade
 * (terms | privacy | telemetry | marketing) para o usuário autenticado.
 *
 * Ref:  T-228, spec §5.9 (consent_log, granular per purpose, partial UNIQUE
 *        ativa-por-purpose) + §9.4 (LGPD evidência granular)
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. Method gate (POST only) — anything else → 405.
 *   2. JWT extraction (caller user id) — 401 if missing/invalid.
 *   3. Body parse + validation:
 *        - purpose      : enum ('terms' | 'privacy' | 'telemetry' | 'marketing')
 *        - version      : non-empty text, max 64 chars (ex: "terms-v1.2-2026-06")
 *        - legal_basis  : enum ('consent' | 'legitimate_interest'
 *                                | 'legal_obligation' | 'contract')
 *        - revoke_existing: optional boolean (default false). When true, the
 *          handler revokes ANY active row for the same (user, purpose) BEFORE
 *          inserting — used by re-consent flows where the previous active row
 *          must be archived.
 *      → 422 on validation failure with field-level details.
 *   4. ip_address: extracted from request headers (x-forwarded-for, x-real-ip,
 *      fly-client-ip — first valid inet wins). NULL if none parsable.
 *   5. user_agent: extracted from request headers (user-agent), truncated to
 *      512 chars to bound storage.
 *   6. If `revoke_existing=true`, UPDATE consent_log SET revoked_at=now(),
 *      revoked_reason='superseded' WHERE user_id=me AND purpose=:purpose
 *      AND revoked_at IS NULL — best-effort; if the partial unique would still
 *      conflict we surface 409 (see step 7).
 *   7. INSERT consent_log row. The partial UNIQUE
 *      `uq_consent_active_per_purpose ON (user_id, purpose) WHERE revoked_at
 *      IS NULL` guarantees at most one active row per (user, purpose); a race
 *      that produces 23505 maps to HTTP 409 with detail explaining how to
 *      resolve (revoke first, then re-accept).
 *   8. Emit domain_event `consent.accepted` (best-effort; never unwinds).
 *   9. Return 200 with the inserted row + the user's full active-consent
 *      summary (per-purpose latest active version), so the client UI doesn't
 *      need a follow-up GET to render Settings → Privacidade.
 *
 * Response shape (200):
 *   {
 *     consent: {
 *       id, user_id, purpose, version, legal_basis, accepted_at,
 *       revoked_at: null
 *     },
 *     active: [
 *       { purpose, version, accepted_at }, ...
 *     ]
 *   }
 *
 * Response shape (409 — duplicate active):
 *   {
 *     error: 'consent_already_active',
 *     detail: 'an active consent for this purpose+version already exists',
 *     existing: { version, accepted_at }
 *   }
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
import {
  emitDomainEvent,
  type DomainEventInput,
} from '../_shared/events.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsentPurpose = 'terms' | 'privacy' | 'telemetry' | 'marketing';
export type LegalBasis =
  | 'consent'
  | 'legitimate_interest'
  | 'legal_obligation'
  | 'contract';

export const CONSENT_PURPOSES: ReadonlyArray<ConsentPurpose> = [
  'terms',
  'privacy',
  'telemetry',
  'marketing',
] as const;

export const LEGAL_BASES: ReadonlyArray<LegalBasis> = [
  'consent',
  'legitimate_interest',
  'legal_obligation',
  'contract',
] as const;

export type AcceptConsentRequest = {
  purpose: ConsentPurpose;
  version: string;
  legal_basis: LegalBasis;
  revoke_existing?: boolean;
};

export type ConsentRow = {
  id: string;
  user_id: string;
  purpose: ConsentPurpose;
  version: string;
  legal_basis: LegalBasis;
  accepted_at: string;
  revoked_at: string | null;
};

export type AcceptConsentResponse = {
  consent: ConsentRow;
  active: Array<{
    purpose: ConsentPurpose;
    version: string;
    accepted_at: string;
  }>;
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

const VERSION_MAX_LENGTH = 64;
const USER_AGENT_MAX_LENGTH = 512;
const PG_UNIQUE_VIOLATION = '23505';

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
 * Picks the first parsable inet from the standard forwarding chain.
 *
 * Order: x-forwarded-for (leftmost = original client), x-real-ip, fly-client-ip,
 * cf-connecting-ip. Returns `null` if no header parses. We intentionally do
 * NOT trust the value beyond "is this string a valid IP literal" — operators
 * upstream are responsible for stripping spoofed XFF entries at the edge.
 *
 * Accepts both IPv4 and IPv6; the DB column is inet so either is fine.
 */
export function extractClientIp(req: Request): string | null {
  const candidates: string[] = [];
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    for (const part of xff.split(',')) {
      const v = part.trim();
      if (v) candidates.push(v);
    }
  }
  for (const h of ['x-real-ip', 'fly-client-ip', 'cf-connecting-ip']) {
    const v = req.headers.get(h);
    if (v) candidates.push(v.trim());
  }
  for (const c of candidates) {
    if (isValidIp(c)) return c;
  }
  return null;
}

/**
 * Cheap-but-correct IP literal check. Postgres `inet` parser is the
 * authoritative gate; if this slips through, the INSERT will fail and we
 * surface 422. We only block obvious garbage here so we don't pollute the DB.
 */
export function isValidIp(s: string): boolean {
  if (!s) return false;
  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = s.match(v4);
  if (m) {
    for (let i = 1; i <= 4; i++) {
      const n = Number(m[i]);
      if (n < 0 || n > 255) return false;
    }
    return true;
  }
  // IPv6 — loose check: hex groups separated by ':' (and optional '::' once).
  // We don't validate every RFC 5952 quirk; Postgres will reject if invalid.
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(':');
}

/**
 * Validates the JSON body shape for POST /consent/accept.
 * Returns either the parsed value or a list of field-level errors.
 */
export function validateAcceptBody(value: unknown): {
  ok: true;
  data: {
    purpose: ConsentPurpose;
    version: string;
    legal_basis: LegalBasis;
    revoke_existing: boolean;
  };
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

  // version
  let version = '';
  if (typeof v.version !== 'string') {
    errors.push({ field: 'version', message: 'must be a string' });
  } else {
    version = v.version.trim();
    if (version.length === 0) {
      errors.push({ field: 'version', message: 'must not be empty' });
    } else if (version.length > VERSION_MAX_LENGTH) {
      errors.push({
        field: 'version',
        message: `max ${VERSION_MAX_LENGTH} chars`,
      });
    }
  }

  // legal_basis
  let legalBasis: LegalBasis | null = null;
  if (typeof v.legal_basis !== 'string') {
    errors.push({ field: 'legal_basis', message: 'must be a string' });
  } else if (!LEGAL_BASES.includes(v.legal_basis as LegalBasis)) {
    errors.push({
      field: 'legal_basis',
      message: `must be one of: ${LEGAL_BASES.join(', ')}`,
    });
  } else {
    legalBasis = v.legal_basis as LegalBasis;
  }

  // revoke_existing (optional)
  let revokeExisting = false;
  if (v.revoke_existing !== undefined) {
    if (typeof v.revoke_existing !== 'boolean') {
      errors.push({
        field: 'revoke_existing',
        message: 'must be a boolean if provided',
      });
    } else {
      revokeExisting = v.revoke_existing;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      purpose: purpose!,
      version,
      legal_basis: legalBasis!,
      revoke_existing: revokeExisting,
    },
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
    const parsed = validateAcceptBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, {
        error: 'validation_failed',
        details: parsed.errors,
      });
    }
    const { purpose, version, legal_basis, revoke_existing } = parsed.data;

    // 3) Extract LGPD evidence headers (best-effort).
    const ipAddress = extractClientIp(req);
    const userAgentRaw = req.headers.get('user-agent') ?? '';
    const userAgent = userAgentRaw.length > USER_AGENT_MAX_LENGTH
      ? userAgentRaw.slice(0, USER_AGENT_MAX_LENGTH)
      : (userAgentRaw || null);

    const client = deps.client ?? buildServiceClient();
    const now = clock();
    const nowIso = now.toISOString();

    // 4) Optional: revoke existing active row for (user, purpose) BEFORE insert.
    //    This is the re-consent flow: the previous version stays in history
    //    (revoked_at set) and we write a fresh active row in step 5.
    if (revoke_existing) {
      const { error: revErr } = await client
        .from('consent_log')
        .update({
          revoked_at: nowIso,
          revoked_reason: 'superseded',
        })
        .eq('user_id', caller.id)
        .eq('purpose', purpose)
        .is('revoked_at', null);
      if (revErr) {
        console.error(
          JSON.stringify({
            level: 'error',
            correlation_id: ctx.correlation_id,
            msg: 'consent_log pre-revoke failed',
            user_id: caller.id,
            purpose,
            error: redactSecrets(revErr.message),
          }),
        );
        return jsonResponse(500, {
          error: 'internal_error',
          code: 'pre_revoke_failed',
        });
      }
    }

    // 5) INSERT the active row. Partial UNIQUE
    //    uq_consent_active_per_purpose enforces at most ONE active per
    //    (user, purpose). A 23505 here means a duplicate active exists —
    //    map to 409 with the existing row attached so the client can decide
    //    whether to retry with revoke_existing=true.
    const { data: inserted, error: insErr } = await client
      .from('consent_log')
      .insert({
        user_id: caller.id,
        purpose,
        version,
        legal_basis,
        accepted_at: nowIso,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .select('id, user_id, purpose, version, legal_basis, accepted_at, revoked_at')
      .single();

    if (insErr) {
      // deno-lint-ignore no-explicit-any
      const code = (insErr as any).code as string | undefined;
      if (code === PG_UNIQUE_VIOLATION) {
        // Fetch the existing active row so the client can surface it.
        const { data: existing } = await client
          .from('consent_log')
          .select('version, accepted_at')
          .eq('user_id', caller.id)
          .eq('purpose', purpose)
          .is('revoked_at', null)
          .maybeSingle();
        return jsonResponse(409, {
          error: 'consent_already_active',
          detail:
            'an active consent for this purpose already exists; pass revoke_existing=true to supersede',
          existing: existing ?? null,
        });
      }
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'consent_log insert failed',
          user_id: caller.id,
          purpose,
          error: redactSecrets(insErr.message),
        }),
      );
      return jsonResponse(500, {
        error: 'internal_error',
        code: 'insert_failed',
      });
    }

    // 6) Fetch the user's full active-consent summary so the client UI does
    //    not need a follow-up GET. Cheap: indexed by uq_consent_active_per_purpose.
    const { data: activeRows } = await client
      .from('consent_log')
      .select('purpose, version, accepted_at')
      .eq('user_id', caller.id)
      .is('revoked_at', null)
      .order('purpose', { ascending: true });

    // 7) Emit domain_event consent.accepted (best-effort; never unwinds).
    try {
      await emitEvent({
        type: 'consent.accepted',
        aggregate_type: 'consent_log',
        aggregate_id: inserted.id as string,
        correlation_id: ctx.correlation_id,
        actor_type: 'user',
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: {
            purpose,
            consent_version: version,
            legal_basis,
            accepted_at: nowIso,
            superseded_previous: revoke_existing,
          },
        },
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'consent.accepted emit failed (non-fatal)',
          error: redactSecrets(e instanceof Error ? e.message : String(e)),
        }),
      );
    }

    const response: AcceptConsentResponse = {
      consent: inserted as ConsentRow,
      active: (activeRows ?? []).map((r) => ({
        purpose: r.purpose as ConsentPurpose,
        version: r.version as string,
        accepted_at: r.accepted_at as string,
      })),
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
