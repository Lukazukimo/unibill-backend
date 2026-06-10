/**
 * emails-connect — POST /emails/connect: registra um Gmail (email + app password)
 * para o usuário autenticado, valida IMAP, persiste a senha no Supabase Vault e
 * cria os vínculos `connected_emails` + `connected_email_households`.
 *
 * Ref:  T-212, spec §9.3.1 "Operações Vault" + §E "POST /emails/connect" + §6.4 IMAP
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. Method gate (POST only).
 *   2. JWT extraction (caller user id + email) — 401 if missing/invalid.
 *   3. Body parse + Zod-shape validation:
 *        - email_address: RFC-ish email, max 254 chars
 *        - app_password : EXACT 16 chars, lowercase letters (+ optional spaces).
 *                         The "with spaces" form is what Google's UI emits
 *                         ("abcd efgh ijkl mnop"); we normalize by stripping
 *                         spaces BEFORE counting & sending to IMAP.
 *        - household_ids: 1..N uuids, non-empty
 *      → 422 on validation failure with field-level details.
 *   4. Tenant guard: every household_id MUST have caller as an active admin
 *      (direct SELECT on public.members under service_role, equivalent to
 *      app.is_household_admin(uuid) but without depending on auth.uid() —
 *      which is unset under service_role). Spec §5.11: a non-admin cannot
 *      bind a credential into someone else's household.
 *   5. IMAP login probe against imap.gmail.com:993 (TLS) using the
 *      *normalized* password. We do NOT proceed to Vault if IMAP rejects.
 *      → 401 IMAP_AUTH_FAILED on invalid_credentials
 *      → 502 IMAP_NETWORK_ERROR on transport failure
 *      All errors flow through redactSecrets() before logging.
 *   6. Pre-flight uniqueness check on connected_emails.email_address
 *      (UNIQUE global per §5.2 schema): if someone else owns it → 409.
 *      Note: this check is best-effort; the actual UNIQUE index is the
 *      authoritative gate (handled in step 8 via 23505 sqlstate mapping).
 *   7. Vault: app.create_vault_secret(value, name, description) — wrapped
 *      via rpc('create_vault_secret', …) — returns the secret UUID.
 *      The plaintext password local variable is zeroed in a finally block
 *      (see §9.3.1 caller-side hygiene).
 *   8. Single "transaction" (Supabase JS lacks BEGIN/COMMIT for PostgREST,
 *      so we serialize via an INSERT to connected_emails followed by an
 *      INSERT to connected_email_households. If the second fails, we
 *      compensate by deleting the freshly-created vault secret AND the
 *      connected_emails row. The compensation is best-effort; the audit
 *      log captures any orphan for the cleanup runbook).
 *
 * Response shape (200):
 *   {
 *     connected_email_id: uuid,
 *     household_bindings: [{ household_id: uuid, is_default: boolean }]
 *   }
 *
 * Emits domain_event 'email.connected' (best-effort; failure to emit MUST NOT
 * unwind the user-visible success — events.ts is currently a stub).
 *
 * Test-injection seams (the handler is exported as `buildHandler({...})`):
 *   - `validateImap`    — stub in unit tests to avoid real IMAP network I/O
 *   - `getCallerUser`   — stub to inject a fixed { id, email } without JWT
 *   - `client`          — Supabase service-role client (already injectable
 *                         via buildServiceClient)
 *   - `emitEvent`       — defaults to events.ts emitDomainEvent stub
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
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

export type ConnectEmailRequest = {
  email_address: string;
  app_password: string;
  household_ids: string[];
};

export type ConnectEmailResponse = {
  connected_email_id: string;
  household_bindings: Array<{ household_id: string; is_default: boolean }>;
};

export type ImapValidationResult =
  | { kind: 'ok' }
  | { kind: 'invalid_credentials' }
  | { kind: 'network_error'; message: string };

/**
 * Mirrors the contract T-230 will land in `_shared/imap.ts`. Defined locally
 * so this function can ship + be unit-tested without waiting for that file
 * (and so that file can later re-export the same shape verbatim).
 */
export type ImapValidator = (params: {
  email: string;
  password: string;
  host: string;
  port: number;
  useTls: boolean;
}) => Promise<ImapValidationResult>;

export type CallerUser = { id: string; email: string };
export type CallerUserResolver = (req: Request) => Promise<CallerUser | null>;

export type EmitEventFn = (e: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  validateImap: ImapValidator;
  getCallerUser: CallerUserResolver;
  client?: SupabaseClient;
  emitEvent?: EmitEventFn;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAP_HOST_DEFAULT = 'imap.gmail.com';
const IMAP_PORT_DEFAULT = 993;
const IMAP_USE_TLS_DEFAULT = true;

const APP_PASSWORD_LENGTH = 16;
const EMAIL_MAX_LENGTH = 254;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pragmatic email regex — RFC compliance is delegated to Supabase Auth; here
// we only block egregious shapes that would never login.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Postgres unique_violation
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
 * Normalizes an app password as Google displays it: "abcd efgh ijkl mnop".
 * We strip whitespace and lower-case before validating length.
 */
export function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, '').toLowerCase();
}

/**
 * Zod-style validation done by hand to avoid pulling zod for a single shape.
 * Returns the parsed value on success or a list of human-readable field errors.
 *
 * The contract is identical to the spec §E:
 *   email_address: string, RFC-ish, max 254
 *   app_password : string, exactly 16 chars after whitespace strip, [a-z]
 *   household_ids: uuid[], non-empty, no duplicates
 */
export function validateConnectBody(value: unknown): {
  ok: true;
  data: { email_address: string; app_password_normalized: string; household_ids: string[] };
} | {
  ok: false;
  errors: Array<{ field: string; message: string }>;
} {
  const errors: Array<{ field: string; message: string }> = [];

  if (!value || typeof value !== 'object') {
    return { ok: false, errors: [{ field: '', message: 'body must be a JSON object' }] };
  }
  const v = value as Record<string, unknown>;

  // email_address
  let email = '';
  if (typeof v.email_address !== 'string') {
    errors.push({ field: 'email_address', message: 'must be a string' });
  } else {
    email = v.email_address.trim().toLowerCase();
    if (email.length === 0) {
      errors.push({ field: 'email_address', message: 'must not be empty' });
    } else if (email.length > EMAIL_MAX_LENGTH) {
      errors.push({ field: 'email_address', message: `max ${EMAIL_MAX_LENGTH} chars` });
    } else if (!EMAIL_RE.test(email)) {
      errors.push({ field: 'email_address', message: 'invalid email format' });
    }
  }

  // app_password
  let passwordNormalized = '';
  if (typeof v.app_password !== 'string') {
    errors.push({ field: 'app_password', message: 'must be a string' });
  } else {
    passwordNormalized = normalizeAppPassword(v.app_password);
    if (passwordNormalized.length !== APP_PASSWORD_LENGTH) {
      errors.push({
        field: 'app_password',
        message: `must be exactly ${APP_PASSWORD_LENGTH} lowercase letters (Google app password)`,
      });
    } else if (!/^[a-z]+$/.test(passwordNormalized)) {
      errors.push({
        field: 'app_password',
        message: 'must contain only lowercase letters [a-z]',
      });
    }
  }

  // household_ids
  let householdIds: string[] = [];
  if (!Array.isArray(v.household_ids)) {
    errors.push({ field: 'household_ids', message: 'must be an array of UUID strings' });
  } else if (v.household_ids.length === 0) {
    errors.push({ field: 'household_ids', message: 'must contain at least one household_id' });
  } else {
    const seen = new Set<string>();
    for (const [i, h] of v.household_ids.entries()) {
      if (typeof h !== 'string' || !UUID_RE.test(h)) {
        errors.push({ field: `household_ids[${i}]`, message: 'must be a UUID' });
        continue;
      }
      const lower = h.toLowerCase();
      if (seen.has(lower)) {
        errors.push({ field: `household_ids[${i}]`, message: 'duplicate household_id' });
        continue;
      }
      seen.add(lower);
      householdIds.push(lower);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      email_address: email,
      app_password_normalized: passwordNormalized,
      household_ids: householdIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Default resolvers (production)
// ---------------------------------------------------------------------------

/**
 * Default JWT → user resolver. Uses Supabase Auth `getUser(jwt)` to verify
 * the inbound Authorization header. Returns null on missing/invalid token —
 * the handler maps that to HTTP 401.
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
    if (!data.user.email) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
};

/**
 * Default IMAP validator. Wraps `npm:imapflow` with the recommended hardened
 * options from §6.4 (logger:false, emitLogs:false, rejectUnauthorized:true).
 *
 * Returns a *tagged* result rather than throwing so the caller can branch on
 * the type without parsing error messages. Any error message that leaks the
 * password is run through redactSecrets() before bubbling.
 *
 * Imported via dynamic `import('npm:imapflow')` so the module is only loaded
 * inside the serving runtime — unit tests inject `validateImap` directly and
 * never reach this code path (deno test runs without `npm:` network access).
 */
export const defaultValidateImap: ImapValidator = async (
  { email, password, host, port, useTls },
) => {
  // deno-lint-ignore no-explicit-any
  let client: any = null;
  try {
    // deno-lint-ignore no-explicit-any
    const mod: any = await import('npm:imapflow@^1.0.166');
    const ImapFlow = mod.ImapFlow ?? mod.default?.ImapFlow ?? mod.default;
    client = new ImapFlow({
      host,
      port,
      secure: useTls,
      auth: { user: email, pass: password },
      logger: false,
      emitLogs: false,
      tls: { rejectUnauthorized: true },
    });
    await client.connect();
    return { kind: 'ok' };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const safe = redactSecrets(raw);
    // imapflow throws `Error('Invalid credentials')` (or similar) with
    // `authenticationFailed: true`. We test the message defensively.
    // deno-lint-ignore no-explicit-any
    const code = (e as any)?.code as string | undefined;
    // deno-lint-ignore no-explicit-any
    const authFailed = (e as any)?.authenticationFailed === true;
    if (authFailed || code === 'AUTHENTICATIONFAILED' || /auth/i.test(raw)) {
      return { kind: 'invalid_credentials' };
    }
    return { kind: 'network_error', message: safe };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch (_e) {
        /* best-effort */
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const emitEvent = deps.emitEvent ?? emitDomainEvent;

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    // 1) JWT → caller
    const caller = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    // 2) Body parse + validation
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const parsed = validateConnectBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, {
        error: 'validation_failed',
        details: parsed.errors,
      });
    }
    const { email_address, app_password_normalized, household_ids } = parsed.data;

    const client = deps.client ?? buildServiceClient();

    // 3) Tenant guard — caller MUST be an active admin of every household.
    //
    //    `app.is_household_admin(uuid)` reads auth.uid() from the JWT — but
    //    here we run under service_role (no JWT), so we can't rely on it.
    //    Direct SELECT against public.members with the caller.id known from
    //    the JWT verification step is equivalent and explicit. RLS does not
    //    fire under service_role, which is what we want for this guard.
    {
      const { data, error } = await client
        .from('members')
        .select('household_id')
        .eq('user_id', caller.id)
        .eq('role', 'admin')
        .is('deleted_at', null)
        .in('household_id', household_ids);

      if (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            correlation_id: ctx.correlation_id,
            msg: 'admin membership query failed',
            error: redactSecrets(error.message),
          }),
        );
        return jsonResponse(500, { error: 'internal_error', code: 'admin_check_failed' });
      }
      const adminOf = new Set<string>((data ?? []).map((r) => r.household_id as string));
      const missing = household_ids.filter((h) => !adminOf.has(h));
      if (missing.length > 0) {
        return jsonResponse(403, {
          error: 'forbidden',
          detail: 'caller is not admin of every household_id',
          missing,
        });
      }
    }

    // 4) Pre-flight uniqueness check — best-effort, the UNIQUE index is the
    //    authoritative gate. We skip rows where deleted_at IS NOT NULL because
    //    soft-deleted credentials no longer "own" the address.
    {
      const { data: existing, error: existErr } = await client
        .from('connected_emails')
        .select('id, owner_user_id, deleted_at')
        .eq('email_address', email_address)
        .is('deleted_at', null)
        .limit(1);

      if (existErr) {
        console.error(
          JSON.stringify({
            level: 'error',
            correlation_id: ctx.correlation_id,
            msg: 'pre-flight uniqueness check failed',
            error: redactSecrets(existErr.message),
          }),
        );
        return jsonResponse(500, { error: 'internal_error', code: 'preflight_failed' });
      }
      if (existing && existing.length > 0) {
        const owner = existing[0].owner_user_id as string;
        if (owner !== caller.id) {
          return jsonResponse(409, {
            error: 'email_already_owned',
            detail: 'this email is already connected by another user',
          });
        }
        // Owner is the same user — also 409 (the spec only says "another
        // user"; we conservatively reject duplicate connections per-owner too
        // because the global UNIQUE index would block it anyway).
        return jsonResponse(409, {
          error: 'email_already_connected',
          detail: 'you have already connected this email',
        });
      }
    }

    // 5) IMAP probe
    const imapResult = await deps.validateImap({
      email: email_address,
      password: app_password_normalized,
      host: IMAP_HOST_DEFAULT,
      port: IMAP_PORT_DEFAULT,
      useTls: IMAP_USE_TLS_DEFAULT,
    });
    if (imapResult.kind === 'invalid_credentials') {
      return jsonResponse(401, {
        error: 'imap_auth_failed',
        detail: 'Gmail rejected the app password — generate a fresh one and retry',
      });
    }
    if (imapResult.kind === 'network_error') {
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'imap network error',
          error: imapResult.message, // already redacted by defaultValidateImap
        }),
      );
      return jsonResponse(502, {
        error: 'imap_network_error',
        detail: 'could not reach Gmail IMAP — retry shortly',
      });
    }

    // 6) Create Vault secret (wrapper: app.create_vault_secret)
    let secretId: string;
    {
      // Local copy so we can zero it in `finally`.
      // (JS strings are immutable; the best we can do is drop the reference.)
      let plaintext: string | null = app_password_normalized;
      try {
        const { data, error } = await client.rpc('create_vault_secret', {
          secret_value: plaintext,
          name: `gmail_app_pwd:${email_address}`,
          description: `App password Gmail user ${caller.id}`,
        });
        if (error) {
          console.error(
            JSON.stringify({
              level: 'error',
              correlation_id: ctx.correlation_id,
              msg: 'create_vault_secret rpc failed',
              error: redactSecrets(error.message),
            }),
          );
          return jsonResponse(500, { error: 'internal_error', code: 'vault_create_failed' });
        }
        if (typeof data !== 'string' || !UUID_RE.test(data)) {
          return jsonResponse(500, {
            error: 'internal_error',
            code: 'vault_returned_invalid_uuid',
          });
        }
        secretId = data;
      } finally {
        plaintext = null;
      }
    }

    // 7) INSERT connected_emails — UNIQUE on email_address may race; map 23505 to 409.
    const { data: createdRow, error: insertErr } = await client
      .from('connected_emails')
      .insert({
        email_address,
        owner_user_id: caller.id,
        provider: 'gmail',
        app_password_secret: secretId,
        imap_host: IMAP_HOST_DEFAULT,
        imap_port: IMAP_PORT_DEFAULT,
        imap_use_tls: IMAP_USE_TLS_DEFAULT,
        status: 'active',
        consecutive_errors: 0,
      })
      .select('id')
      .single();

    if (insertErr) {
      // Compensate: drop the freshly-created vault secret (we orphaned it).
      try {
        await client.rpc('delete_vault_secret', { secret_id: secretId });
      } catch (e) {
        console.error(
          JSON.stringify({
            level: 'warn',
            correlation_id: ctx.correlation_id,
            msg: 'vault compensation failed — orphan secret created',
            secret_id: secretId,
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          }),
        );
      }
      if (insertErr.code === PG_UNIQUE_VIOLATION) {
        return jsonResponse(409, {
          error: 'email_already_owned',
          detail: 'this email is already connected (race condition resolved)',
        });
      }
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'connected_emails insert failed',
          error: redactSecrets(insertErr.message),
        }),
      );
      return jsonResponse(500, { error: 'internal_error', code: 'insert_failed' });
    }
    const connectedEmailId = createdRow.id as string;

    // 8) INSERT connected_email_households (one row per household, first is_default=true)
    const bindings = household_ids.map((householdId, i) => ({
      connected_email_id: connectedEmailId,
      household_id: householdId,
      is_default: i === 0,
    }));

    const { data: insertedBindings, error: bindErr } = await client
      .from('connected_email_households')
      .insert(bindings)
      .select('household_id, is_default');

    if (bindErr) {
      // Compensate: hard-delete the connected_emails row + drop vault secret.
      // (We never returned the id to the caller, so this is invisible.)
      try {
        await client
          .from('connected_emails')
          .delete()
          .eq('id', connectedEmailId);
      } catch { /* best-effort compensation */ }
      try {
        await client.rpc('delete_vault_secret', { secret_id: secretId });
      } catch { /* best-effort compensation */ }
      console.error(
        JSON.stringify({
          level: 'error',
          correlation_id: ctx.correlation_id,
          msg: 'connected_email_households insert failed (compensated)',
          error: redactSecrets(bindErr.message),
        }),
      );
      return jsonResponse(500, { error: 'internal_error', code: 'bind_failed' });
    }

    // 9) Emit domain event (best-effort — never unwinds the success above)
    try {
      await emitEvent({
        type: 'email.connected',
        aggregate_type: 'connected_email',
        aggregate_id: connectedEmailId,
        household_id: household_ids[0],
        correlation_id: ctx.correlation_id,
        actor_type: 'user',
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: {
            email_address,
            household_ids,
            provider: 'gmail',
          },
        },
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'email.connected emit failed (non-fatal)',
          error: redactSecrets(e instanceof Error ? e.message : String(e)),
        }),
      );
    }

    const response: ConnectEmailResponse = {
      connected_email_id: connectedEmailId,
      household_bindings: (insertedBindings ?? []).map((b) => ({
        household_id: b.household_id as string,
        is_default: b.is_default as boolean,
      })),
    };
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
