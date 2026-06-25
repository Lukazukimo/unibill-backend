/**
 * redact.ts — defensive secret redaction for log lines.
 *
 * Ref: T-125 (initial set) + T-230 (Gmail app password + IMAP LOGIN patterns)
 *      + T-315 (Brazilian CPF/CNPJ tax IDs + wrapRedaction helper)
 * Spec: §6.5 "Vault decrypt — redação obrigatória de secrets em logs"
 * Date: 2026-06-10
 *
 * Scrubs OAuth tokens, JWTs, API keys, bearer headers, Gmail app passwords
 * (16 lowercase chars, optionally formatted with spaces), raw IMAP LOGIN
 * command echoes, and Brazilian tax IDs (CPF/CNPJ, PII) from strings before
 * they reach stdout / DB error columns.
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

  // -- LLM / OCR provider API keys (T-403, spec §6.5 + §7.3). Scrubbed from logs
  //    and ai_calls.error_summary. Specific shapes FIRST so the generic sk-
  //    pattern below doesn't shadow the OpenRouter sk-or- form.
  // Gemini + Google Vision (Google API key: "AIza" + 35 chars).
  { re: /AIza[0-9A-Za-z_\-]{35}/g, replacement: '[REDACTED_GOOGLE_API_KEY]' },
  // Groq ("gsk_" + token).
  { re: /\bgsk_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_GROQ_KEY]' },
  // OpenRouter ("sk-or-…") — BEFORE the generic OpenAI sk- below.
  { re: /sk-or-[A-Za-z0-9\-]{20,}/g, replacement: '[REDACTED_OPENROUTER_KEY]' },
  // OCR.space (free/pro keys: "K" + 14+ alphanumerics).
  { re: /\bK[A-Za-z0-9]{14,}\b/g, replacement: '[REDACTED_OCRSPACE_KEY]' },

  // -- OpenAI-style API keys
  { re: /sk-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },

  // -- Google/Supabase service-role JWTs (3 dot-separated b64url segments)
  {
    re: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,
    replacement: '[REDACTED_JWT]',
  },

  // -- Brazilian tax IDs (PII — spec §6.5). CNPJ (14 digits) FIRST so the
  //    longer id is consumed before the 11-digit CPF pattern. `\b` on both ends
  //    so a longer digit run — e.g. a 44/47-digit boleto barcode (invoices
  //    "linha digitável") — is NOT partially eaten (no word boundary mid-digit).
  //    Punctuation optional: catches both 11.222.333/0001-81 and bare
  //    11222333000181 (and 529.982.247-25 / 52998224725 for CPF).
  { re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, replacement: '[REDACTED_CNPJ]' },
  { re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, replacement: '[REDACTED_CPF]' },
];

export function redactSecrets(s: string | null | undefined): string {
  if (s == null) return '';
  let out = s;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Safely stringifies an unknown thrown value and redacts secrets from it.
 * Use at catch sites instead of hand-writing
 * `redactSecrets(e instanceof Error ? e.message : String(e))`.
 *
 * Never throws: for non-Error values it falls back to `String(err)`, and if even
 * that throws (e.g. an object with a poisoned `toString`) it returns a constant.
 * Uses `err.message` (not `err.stack`) for Errors, matching every call site.
 */
export function wrapRedaction(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else {
    try {
      raw = String(err);
    } catch {
      raw = '[unstringifiable error]';
    }
  }
  return redactSecrets(raw);
}

/**
 * Recursively redacts every STRING value inside a structure (objects, arrays),
 * leaving non-strings (numbers, booleans, null) untouched. Use this for
 * structured sinks — log `meta` and `domain_events.payload` — instead of
 * redacting a serialized JSON blob, which can corrupt fields (a secret pattern
 * matching across JSON delimiters) or miss secrets hidden by JSON escaping.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
