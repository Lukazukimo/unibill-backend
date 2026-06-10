/**
 * imap.ts — IMAP credential validator backed by `npm:imapflow`.
 *
 * Ref:  T-230, spec §6.4 (IMAP biblioteca/dedupe) + §6.5 (redação obrigatória)
 * Date: 2026-06-10
 *
 * Single public surface: `validateImapCredentials({ email, password, host,
 * port, useTls })` which opens a TLS connection, performs LOGIN, and returns
 * a tagged result:
 *
 *     ImapValidationResult =
 *       | { kind: 'ok' }
 *       | { kind: 'invalid_credentials' }
 *       | { kind: 'network_error'; message: string };
 *
 * Rules baked into this module (per §6.4 + §6.5):
 *   1. `logger: false` + `emitLogs: false` — imapflow's default logger echoes
 *      `LOGIN user pass` on auth failures; disabling it is mandatory.
 *   2. `tls: { rejectUnauthorized: true }` — no fallback to insecure TLS.
 *   3. Any error message bubbled out (via `network_error.message`) is wrapped
 *      in `redactSecrets()` so the literal app password can never leak into
 *      structured logs, `sync_runs.error_summary`, `connected_emails.last_error`
 *      or `domain_events.payload`.
 *   4. The `pass` reference is dropped (`finally { pass = null }`) after use
 *      so the GC can reclaim it sooner. JS strings are immutable so we cannot
 *      zero the buffer, but we can release the only reference we hold.
 *   5. `client.logout()` runs unconditionally in `finally` even on failure,
 *      mirroring the spec's "sempre, mesmo em erro" line in §6.4.
 *
 * Test-injection seam: callers in `imap.test.ts` pass `{ imapFactory }` to
 * substitute a fake ImapFlow constructor without touching `npm:` (which the
 * default `deno test` run does not allow).
 *
 * NON-GOALS (deferred to sync-worker tasks T-221+):
 *   - Mailbox enumeration / SEARCH / FETCH (this helper only validates LOGIN).
 *   - IDLE support, connection pooling, retries.
 *   - Capability negotiation beyond what imapflow does on connect().
 */

import { redactSecrets } from './redact.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Defaults for Gmail per spec §6.4. */
export const IMAP_GMAIL_HOST = 'imap.gmail.com';
export const IMAP_GMAIL_PORT = 993;
export const IMAP_USE_TLS_DEFAULT = true;

/**
 * Discriminated union returned by `validateImapCredentials`. Callers branch on
 * `kind` and never parse error strings — `network_error.message` is for logs
 * only (already redacted).
 */
export type ImapValidationResult =
  | { kind: 'ok' }
  | { kind: 'invalid_credentials' }
  | { kind: 'network_error'; message: string };

/** Parameters accepted by `validateImapCredentials`. */
export type ImapValidationParams = {
  email: string;
  password: string;
  host?: string;
  port?: number;
  useTls?: boolean;
};

/**
 * Minimal duck-typed surface we rely on from `npm:imapflow`. Kept narrow so
 * test fakes are trivial to author.
 */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
}

/** Constructor signature for the IMAP client (matches imapflow's `ImapFlow`). */
export type ImapClientFactory = (opts: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: false;
  emitLogs: false;
  tls: { rejectUnauthorized: boolean };
}) => ImapClientLike;

/** Optional test seam — production callers omit this. */
export type ValidateImapDeps = {
  imapFactory?: ImapClientFactory;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps a thrown error to one of our tagged result variants. imapflow signals
 * authentication failures via either:
 *   - `err.authenticationFailed === true`
 *   - `err.code === 'AUTHENTICATIONFAILED'`
 *   - a message containing "auth" / "Invalid credentials" / "[AUTHENTICATIONFAILED]"
 *
 * Anything else (TCP refused, TLS handshake error, timeout) is a transport
 * failure — surface as `network_error` so the caller can map to HTTP 502.
 */
export function classifyImapError(err: unknown): ImapValidationResult {
  const raw = err instanceof Error ? err.message : String(err);
  // deno-lint-ignore no-explicit-any
  const e = err as any;
  const code: string | undefined = typeof e?.code === 'string' ? e.code : undefined;
  const authFailed: boolean = e?.authenticationFailed === true;

  // Defensive: the spec says we MUST redact before bubbling. Run the message
  // through redactSecrets() up-front so even the `invalid_credentials` branch
  // (which doesn't expose the message) doesn't accidentally log a raw copy.
  const safe = redactSecrets(raw);

  if (authFailed || code === 'AUTHENTICATIONFAILED' || /authenticationfailed|invalid\s+credentials|auth(entication)?\s+failed/i.test(raw)) {
    return { kind: 'invalid_credentials' };
  }
  return { kind: 'network_error', message: safe };
}

/**
 * Lazy-loads `npm:imapflow` on first use. Deferred so unit tests that inject
 * `imapFactory` never trigger the `npm:` resolver (`deno test` is run without
 * network access in CI).
 */
async function defaultImapFactory(): Promise<ImapClientFactory> {
  // deno-lint-ignore no-explicit-any
  const mod: any = await import('npm:imapflow@^1.0.166');
  const ImapFlow = mod.ImapFlow ?? mod.default?.ImapFlow ?? mod.default;
  if (typeof ImapFlow !== 'function') {
    throw new Error('imapflow: unexpected module shape — ImapFlow constructor not found');
  }
  return (opts) => new ImapFlow(opts) as ImapClientLike;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Opens a TLS IMAP connection to `host:port` and attempts LOGIN as `email`
 * with the supplied `password`. Returns a tagged result; never throws on
 * expected failure modes (auth failed, transport error).
 *
 * Defaults to Gmail (`imap.gmail.com:993` over TLS). The `useTls=false` knob
 * exists for future non-Gmail providers and is NOT used by emails-connect in
 * the MVP.
 *
 * @example
 *   const r = await validateImapCredentials({ email, password });
 *   if (r.kind === 'ok')                 return 200;
 *   if (r.kind === 'invalid_credentials') return 401;
 *   // network_error -> 502 + log r.message (already redacted)
 */
export async function validateImapCredentials(
  params: ImapValidationParams,
  deps: ValidateImapDeps = {},
): Promise<ImapValidationResult> {
  const host = params.host ?? IMAP_GMAIL_HOST;
  const port = params.port ?? IMAP_GMAIL_PORT;
  const useTls = params.useTls ?? IMAP_USE_TLS_DEFAULT;

  // Local mutable so we can drop the reference in `finally`. JS strings can't
  // be wiped, but releasing the binding lets GC reclaim it sooner.
  let pass: string | null = params.password;

  // Resolve factory (test seam → lazy npm import in prod).
  let factory: ImapClientFactory;
  try {
    factory = deps.imapFactory ?? (await defaultImapFactory());
  } catch (e) {
    return {
      kind: 'network_error',
      message: redactSecrets(e instanceof Error ? e.message : String(e)),
    };
  }

  let client: ImapClientLike | null = null;
  try {
    client = factory({
      host,
      port,
      secure: useTls,
      auth: { user: params.email, pass: pass! },
      logger: false,
      emitLogs: false,
      tls: { rejectUnauthorized: true },
    });
    await client.connect();
    return { kind: 'ok' };
  } catch (e) {
    return classifyImapError(e);
  } finally {
    // (1) Drop password reference ASAP.
    pass = null;
    // (2) Best-effort logout — failures here are noise.
    if (client) {
      try {
        await client.logout();
      } catch (_e) {
        /* ignore */
      }
    }
  }
}
