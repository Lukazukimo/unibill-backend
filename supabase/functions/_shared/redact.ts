/**
 * redact.ts — defensive secret redaction for log lines.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * Scrubs OAuth tokens, JWTs, API keys and bearer headers from strings before
 * they reach stdout. Pattern-based — meant as a safety net, NOT a substitute
 * for never logging the field in the first place.
 *
 * STUB: first-pass regex set; expand in later tasks as new providers join.
 */

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // `Authorization: Bearer xxx`
  { re: /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-]+/gi, replacement: '$1[REDACTED]' },
  // JSON-style "access_token": "..." / "refresh_token": "..."
  {
    re: /("(?:access|refresh|id)_token"\s*:\s*")[^"]+(")/gi,
    replacement: '$1[REDACTED]$2',
  },
  // OpenAI-style API keys
  { re: /sk-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },
  // Google/Supabase service-role JWTs (3 dot-separated b64url segments)
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
