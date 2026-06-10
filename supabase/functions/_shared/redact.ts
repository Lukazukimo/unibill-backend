/**
 * redact.ts — defensive secret redaction for log lines.
 *
 * Ref: T-125 (initial set) + T-230 (Gmail app password + IMAP LOGIN patterns)
 * Spec: §6.5 "Vault decrypt — redação obrigatória de secrets em logs"
 * Date: 2026-06-10
 *
 * Scrubs OAuth tokens, JWTs, API keys, bearer headers, Gmail app passwords
 * (16 lowercase chars, optionally formatted with spaces) and raw IMAP LOGIN
 * command echoes from strings before they reach stdout / DB error columns.
 *
 * Pattern-based — meant as a safety net, NOT a substitute for never logging
 * the field in the first place. Used by:
 *   - `imap.ts#validateImapCredentials` (wraps every error.message)
 *   - `emails-connect/index.ts` (wraps every error.message before logging)
 *   - `sync_runs.error_summary`, `connected_emails.last_error` writers
 *   - `domain_events.payload` audit columns
 */

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // -- Gmail app passwords (per spec §6.5): 16 chars [a-z], either as a single
  //    block "abcdefghijklmnop" or in the 4×4 form Google displays in the UI
  //    "abcd efgh ijkl mnop" (separator: space or dash). Anchored on word
  //    boundaries so we don't false-positive on every 16-letter substring.
  //    NOTE: must come BEFORE the JWT pattern — a 16-letter alpha string
  //    cannot match the JWT regex (needs dots), so order doesn't matter for
  //    correctness; we keep it first because it's the most security-sensitive.
  { re: /\b(?:[a-z]{4}[\s-]){3}[a-z]{4}\b/gi, replacement: '[REDACTED_APP_PASSWORD]' },
  { re: /\b[a-z]{16}\b/g, replacement: '[REDACTED_APP_PASSWORD]' },

  // -- IMAP LOGIN command echo: `LOGIN user@example.com s3cr3t`
  //    imapflow used to echo this on auth-failed errors when logger=true; we
  //    keep this pattern as defence in depth in case any other lib emits it.
  { re: /LOGIN\s+\S+\s+\S+/gi, replacement: 'LOGIN [REDACTED_USER] [REDACTED]' },

  // -- `Authorization: Bearer xxx` / `Authorization: Basic xxx`
  { re: /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-]+/gi, replacement: '$1[REDACTED]' },
  { re: /(authorization\s*[:=]\s*basic\s+)\S+/gi, replacement: '$1[REDACTED]' },

  // -- JSON-style "access_token": "..." / "refresh_token": "..." / "id_token"
  {
    re: /("(?:access|refresh|id)_token"\s*:\s*")[^"]+(")/gi,
    replacement: '$1[REDACTED]$2',
  },

  // -- OpenAI-style API keys
  { re: /sk-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },

  // -- Google/Supabase service-role JWTs (3 dot-separated b64url segments)
  {
    re: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,
    replacement: '[REDACTED_JWT]',
  },
];

export function redactSecrets(s: string | null | undefined): string {
  if (s == null) return '';
  let out = s;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
