/**
 * emails-rotate — PATCH /emails/:id/rotate-password: rotates the Gmail app
 * password stored in Supabase Vault for a given `connected_emails` row,
 * preserving the secret UUID so in-flight IMAP workers stay coherent.
 *
 * Ref:  T-213, spec §9.3.1 "Rotação" + §E PATCH /emails/:id/rotate-password
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. Method gate (PATCH only). Anything else → 405.
 *   2. Path parse — `/emails/:id/rotate-password`. The :id is the
 *      connected_emails.id (NOT the vault uuid). Invalid path → 404.
 *   3. JWT extraction (caller user id + email) — 401 if missing/invalid.
 *   4. Body parse + validation:
 *        - new_app_password: EXACT 16 chars after whitespace strip,
 *                            lowercase [a-z] (same rule as connect flow).
 *      → 422 on validation failure with field-level details.
 *   5. Load connected_emails row — 404 if not found, 403 if soft-deleted
 *      or revoked (rotating a dead credential makes no sense), 403 if
 *      caller.id !== owner_user_id (only the owner rotates).
 *   6. Re-validate IMAP with the NEW password against the SAME
 *      imap_host/port/use_tls stored on the row. If Gmail rejects, return
 *      401 imap_auth_failed and DO NOT touch Vault. Network errors → 502.
 *   7. Vault swap via app.update_vault_secret(secret_id, new_value, new_name,
 *      new_description). The wrapper keeps the same uuid — workers in-flight
 *      finish with their buffered (old) plaintext and next decrypt picks
 *      the new value. Plaintext local variable is zeroed in `finally`.
 *   8. UPDATE connected_emails SET updated_at=now() (trigger does it
 *      automatically; we keep this as a single SELECT/touch to land a
 *      `rotated_at` timestamp we can return). We also reset
 *      consecutive_errors=0 and clear last_error (the user just proved
 *      the credential works again).
 *   9. Emit domain_event `email.password_rotated` (best-effort).
 *  10. Return { rotated_at: ISO timestamp }.
 *
 * Response shape (200):
 *   { rotated_at: string /* ISO 8601 timestamptz */ /* }
 *
 * Test-injection seams (handler exported as `buildHandler({...})`):
 *   - `validateImap`    — stub in unit tests to avoid real IMAP network I/O
 *   - `getCallerUser`   — stub to inject a fixed { id, email } without JWT
 *   - `client`          — Supabase service-role client (injectable)
 *   - `emitEvent`       — defaults to events.ts emitDomainEvent stub
 *   - `now`             — clock stub for deterministic rotated_at assertion
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { redactSecrets } from '../_shared/redact.ts';
import {
  emitDomainEvent,
  type DomainEventInput,
} from '../_shared/events.ts';
import {
  defaultGetCallerUser,
  defaultValidateImap,
  normalizeAppPassword,
  type CallerUser,
  type CallerUserResolver,
  type ImapValidator,
} from '../emails-connect/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RotatePasswordRequest = {
  new_app_password: string;
};

export type RotatePasswordResponse = {
  rotated_at: string;
};

export type EmitEventFn = (e: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  validateImap: ImapValidator;
  getCallerUser: CallerUserResolver;
  client?: SupabaseClient;
  emitEvent?: EmitEventFn;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_PASSWORD_LENGTH = 16;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres SQLSTATE for plpgsql_no_data_found — raised by
// app.update_vault_secret when the secret_id row does not exist.
const PG_NO_DATA_FOUND = 'P0002';

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
 * Extracts the `:id` segment from a `/emails/:id/rotate-password`-shaped path.
 * Returns null when the URL does not match — handler maps that to 404 so an
 * attacker can't infer route topology by probing.
 *
 * Accepted shapes (the function is mounted at different prefixes depending on
 * deployment — Supabase Edge routes are `/functions/v1/emails-rotate` and the
 * client may also pass the trailing path as a query/body, so we be flexible):
 *   /emails/<uuid>/rotate-password
 *   /functions/v1/emails-rotate/<uuid>
 *   /functions/v1/emails-rotate?id=<uuid>          (fallback)
 */
export function extractConnectedEmailId(url: URL): string | null {
  // Prefer query param if present (explicit > implicit)
  const queryId = url.searchParams.get('id');
  if (queryId && UUID_RE.test(queryId)) return queryId.toLowerCase();

  // Pattern 1: /emails/:id/rotate-password
  const m1 = url.pathname.match(
    /\/emails\/([0-9a-f-]{36})\/rotate-password\/?$/i,
  );
  if (m1 && UUID_RE.test(m1[1])) return m1[1].toLowerCase();

  // Pattern 2: /<anything>/emails-rotate/:id
  const m2 = url.pathname.match(/\/emails-rotate\/([0-9a-f-]{36})\/?$/i);
  if (m2 && UUID_RE.test(m2[1])) return m2[1].toLowerCase();

  return null;
}

/**
 * Validates the rotate body. Same rules as `connect` for app_password — see
 * spec §E for the verbatim contract.
 */
export function validateRotateBody(value: unknown): {
  ok: true;
  data: { new_app_password_normalized: string };
} | {
  ok: false;
  errors: Array<{ field: string; message: string }>;
} {
  const errors: Array<{ field: string; message: string }> = [];

  if (!value || typeof value !== 'object') {
    return { ok: false, errors: [{ field: '', message: 'body must be a JSON object' }] };
  }
  const v = value as Record<string, unknown>;

  let normalized = '';
  if (typeof v.new_app_password !== 'string') {
    errors.push({ field: 'new_app_password', message: 'must be a string' });
  } else {
    normalized = normalizeAppPassword(v.new_app_password);
    if (normalized.length !== APP_PASSWORD_LENGTH) {
      errors.push({
        field: 'new_app_password',
        message: `must be exactly ${APP_PASSWORD_LENGTH} lowercase letters (Google app password)`,
      });
    } else if (!/^[a-z]+$/.test(normalized)) {
      errors.push({
        field: 'new_app_password',
        message: 'must contain only lowercase letters [a-z]',
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { new_app_password_normalized: normalized } };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const emitEvent = deps.emitEvent ?? emitDomainEvent;
  const clock = deps.now ?? (() => new Date());

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'PATCH') {
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

    // 3) Body parse + validation
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const parsed = validateRotateBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, { error: 'validation_failed', details: parsed.errors });
    }
    const { new_app_password_normalized } = parsed.data;

    const client = deps.client ?? buildServiceClient();

    // 4) Load connected_emails row (owner + secret_id + imap_*).
    //    Filter deleted_at IS NULL so revoked credentials present a 404 to
    //    non-owners without leaking existence (the owner gets a clear 403
    //    below once we confirmed it exists).
    const { data: row, error: loadErr } = await client
      .from('connected_emails')
      .select(
        'id, owner_user_id, email_address, app_password_secret, imap_host, imap_port, imap_use_tls, status, deleted_at',
      )
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
    if (row.owner_user_id !== caller.id) {
      // 403 with no detail — do not leak the email address or owner id.
      return jsonResponse(403, { error: 'forbidden', detail: 'not the owner of this credential' });
    }
    if (row.deleted_at !== null || row.status === 'revoked') {
      return jsonResponse(403, {
        error: 'credential_revoked',
        detail: 'this credential is revoked; reconnect the email instead of rotating',
      });
    }

    const secretId = row.app_password_secret as string;
    const emailAddress = row.email_address as string;
    const imapHost = row.imap_host as string;
    const imapPort = row.imap_port as number;
    const imapUseTls = row.imap_use_tls as boolean;

    // 5) IMAP re-validation with the NEW password against the SAME host/port.
    //    Spec §9.3.1: NEVER swap the vault value before proving the new
    //    credential works — otherwise the user locks themselves out.
    const imapResult = await deps.validateImap({
      email: emailAddress,
      password: new_app_password_normalized,
      host: imapHost,
      port: imapPort,
      useTls: imapUseTls,
    });
    if (imapResult.kind === 'invalid_credentials') {
      return jsonResponse(401, {
        error: 'imap_auth_failed',
        detail: 'Gmail rejected the new app password — generate a fresh one and retry',
      });
    }
    if (imapResult.kind === 'network_error') {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'imap network error during rotate',
          error: imapResult.message, // already redacted upstream
        }),
      );
      return jsonResponse(502, {
        error: 'imap_network_error',
        detail: 'could not reach Gmail IMAP — retry shortly',
      });
    }

    // 6) Vault in-place swap. The UUID is preserved (workers in-flight
    //    finish with their buffered plaintext; next decrypt picks new value).
    const now = clock();
    const nowIso = now.toISOString();
    {
      // Local copy so we can drop the reference in finally.
      let plaintext: string | null = new_app_password_normalized;
      try {
        const { data: rotatedId, error: rotErr } = await client.rpc(
          'update_vault_secret',
          {
            secret_id: secretId,
            new_value: plaintext,
            new_name: `gmail_app_pwd:${emailAddress} (rotated ${nowIso})`,
            new_description: `Rotated at ${nowIso} by user ${caller.id}`,
          },
        );
        if (rotErr) {
          // PostgREST surfaces the SQLSTATE in the `code` field. Map
          // 'P0002' (no data found) → 404 so the caller sees a clean error.
          if ((rotErr as { code?: string }).code === PG_NO_DATA_FOUND) {
            return jsonResponse(404, {
              error: 'vault_secret_not_found',
              detail: 'underlying vault secret missing — credential may be corrupted',
            });
          }
          console.error(
            JSON.stringify({
              level: 'error',
              correlation_id: ctx.correlation_id,
              msg: 'update_vault_secret rpc failed',
              error: redactSecrets(rotErr.message),
            }),
          );
          return jsonResponse(500, { error: 'internal_error', code: 'vault_update_failed' });
        }
        if (typeof rotatedId !== 'string' || rotatedId.toLowerCase() !== secretId.toLowerCase()) {
          // Defensive — the wrapper MUST echo back the same id.
          return jsonResponse(500, {
            error: 'internal_error',
            code: 'vault_returned_unexpected_id',
          });
        }
      } finally {
        plaintext = null;
      }
    }

    // 7) Update connected_emails: bump updated_at, reset error counters
    //    (the user just proved the credential works). The set_updated_at
    //    trigger handles updated_at on its own; we still set it explicitly so
    //    the returned `rotated_at` matches the row exactly.
    const { error: bumpErr } = await client
      .from('connected_emails')
      .update({
        updated_at: nowIso,
        consecutive_errors: 0,
        last_error: null,
        last_error_at: null,
        // If the credential was sitting in 'error' state, the successful IMAP
        // probe above proves it's healthy again — flip to 'active'.
        ...(row.status === 'error' ? { status: 'active' } : {}),
      })
      .eq('id', connectedEmailId);

    if (bumpErr) {
      // Vault was already rotated — we cannot undo. Log loudly and surface
      // a 200 to the user (rotation succeeded; the metadata bump is
      // secondary). Operators see the warn-level log and can fix manually.
      console.error(
        JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'rotate succeeded but metadata bump failed',
          connected_email_id: connectedEmailId,
          error: redactSecrets(bumpErr.message),
        }),
      );
    }

    // 8) Emit domain_event email.password_rotated (best-effort, never unwinds)
    try {
      await emitEvent({
        type: 'email.password_rotated',
        aggregate_type: 'connected_email',
        aggregate_id: connectedEmailId,
        correlation_id: ctx.correlation_id,
        actor_type: 'user',
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: {
            email_address: emailAddress,
            rotated_at: nowIso,
            vault_secret_id: secretId,
          },
        },
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'email.password_rotated emit failed (non-fatal)',
          error: redactSecrets(e instanceof Error ? e.message : String(e)),
        }),
      );
    }

    const response: RotatePasswordResponse = { rotated_at: nowIso };
    return jsonResponse(200, response);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap (production)
// ---------------------------------------------------------------------------

export const handler = buildHandler({
  validateImap: defaultValidateImap,
  getCallerUser: defaultGetCallerUser,
});

if (import.meta.main) {
  Deno.serve(handler);
}
