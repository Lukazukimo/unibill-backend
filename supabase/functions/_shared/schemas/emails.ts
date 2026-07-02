// =============================================================================
// _shared/schemas/emails.ts
// -----------------------------------------------------------------------------
// Zod schemas for the emails domain — single source of truth for request
// validation (runtime), TS types (`z.infer`) and, in a later slice, OpenAPI
// generation (`z.toJSONSchema`). Adopted incrementally per issue #265 /
// ADR-0006. Messages/fields mirror the previous hand-written `validateConnectBody`
// so the 422 `details` payload is unchanged for every scalar/object body. (The
// one deliberate, documented divergence shared with the pilot: an array *body*
// is rejected as a non-object.)
//
// OpenAPI note for the follow-up slice: the string fields normalize via
// `.transform` before validating, so generate the request schema from
// OUTPUT-mode `z.toJSONSchema(schema)` (keeps the constraints); `io:'input'`
// erases them.
// =============================================================================

import { z } from 'zod';

export const EMAIL_MAX_LENGTH = 254;
export const APP_PASSWORD_LENGTH = 16;
/** Deliberately loose "has an @ and a dot" check — matches the spec §E contract. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalizes an app password as Google displays it ("abcd efgh ijkl mnop"):
 * strips whitespace and lower-cases.
 */
export function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, '').toLowerCase();
}

// email_address: trim + lowercase, then non-empty → max-length → format. `abort`
// makes each check short-circuit so exactly one error fires per bad email
// (reproducing the hand-written validator's `else if`).
const emailField = z
  .string({ message: 'must be a string' })
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, { message: 'must not be empty', abort: true })
      .max(EMAIL_MAX_LENGTH, { message: `max ${EMAIL_MAX_LENGTH} chars`, abort: true })
      .regex(EMAIL_RE, { message: 'invalid email format' }),
  );

// app_password: strip whitespace + lowercase, then exact-length → [a-z] only.
const appPasswordField = z
  .string({ message: 'must be a string' })
  .transform(normalizeAppPassword)
  .pipe(
    z
      .string()
      .length(APP_PASSWORD_LENGTH, {
        message: `must be exactly ${APP_PASSWORD_LENGTH} lowercase letters (Google app password)`,
        abort: true,
      })
      .regex(/^[a-z]+$/, { message: 'must contain only lowercase letters [a-z]' }),
  );

// household_ids: a non-empty array of UUIDs with no duplicates. The per-element
// check + dedup is inherently imperative, so a single superRefine mirrors the
// hand-written loop exactly (invalid element → "must be a UUID"; a repeat of an
// already-seen UUID → "duplicate household_id"; both keyed `household_ids[i]`).
// On success the array is lower-cased for output.
const householdIdsField = z
  .array(z.unknown(), { message: 'must be an array of UUID strings' })
  .min(1, { message: 'must contain at least one household_id' })
  .superRefine((arr, ctx) => {
    const seen = new Set<string>();
    arr.forEach((h, i) => {
      if (typeof h !== 'string' || !UUID_RE.test(h)) {
        ctx.addIssue({ code: 'custom', path: [i], message: 'must be a UUID' });
        return;
      }
      const lower = h.toLowerCase();
      if (seen.has(lower)) {
        ctx.addIssue({ code: 'custom', path: [i], message: 'duplicate household_id' });
        return;
      }
      seen.add(lower);
    });
  })
  .transform((arr) => (arr as string[]).map((h) => h.toLowerCase()));

/**
 * Body for `POST /emails/connect`. Field order (email_address → app_password →
 * household_ids) matches the hand-written validator, so accumulated errors come
 * out in the same order.
 */
export const connectEmailBodySchema = z.object({
  email_address: emailField,
  app_password: appPasswordField,
  household_ids: householdIdsField,
}, { message: 'body must be a JSON object' });

export type ConnectEmailBody = z.infer<typeof connectEmailBodySchema>;

/**
 * Body for `PATCH /emails/{id}/rotate-password`: `{ new_app_password }`. Reuses
 * the exact same `appPasswordField` rule as connect — one app-password contract
 * serving two endpoints (the single-source payoff of #265 / ADR-0006).
 */
export const rotateEmailBodySchema = z.object({
  new_app_password: appPasswordField,
}, { message: 'body must be a JSON object' });

export type RotateEmailBody = z.infer<typeof rotateEmailBodySchema>;
