// =============================================================================
// _shared/schemas/invitations.ts
// -----------------------------------------------------------------------------
// Zod schemas for the invitations domain — the single source of truth for
// request validation (runtime), TS types (`z.infer`) and, in a later slice,
// OpenAPI generation (`z.toJSONSchema`). Adopted incrementally per issue #265 /
// ADR-0006. Messages mirror the previous hand-written `validateRedeemBody`, so
// the 422 `details` payload is unchanged for every scalar/object body. (One
// deliberate, more-correct divergence: an array body — invalid input — is now
// rejected as a non-object instead of surfacing "code must be a string".)
//
// OpenAPI note for the follow-up slice: normalization (`.transform`) runs
// BEFORE the length/alphabet checks, so the constraints live on the OUTPUT
// side of the pipe. Generate the request schema from OUTPUT-mode
// `z.toJSONSchema(schema)` (keeps minLength/maxLength/pattern); `io:'input'`
// erases them.
// =============================================================================

import { z } from 'zod';

/** Code length — fixed by spec §9.1 (mirrors invitations-redeem constants). */
export const CODE_LENGTH = 8;

/**
 * Base32 without confusables (no I, L, O, 0, 1). Matches the CHECK constraint
 * `household_invitations_code_format_chk` (migration T-227).
 */
export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

/**
 * Body for `POST /invitations/redeem`: `{ code }`. The code is normalized
 * (trim + uppercase) before the length/alphabet checks, so a lowercase client
 * value still validates and the parsed output is the canonical uppercase form.
 */
export const redeemBodySchema = z.object({
  code: z
    .string({ message: 'must be a string' })
    .transform((s) => s.trim().toUpperCase())
    .pipe(
      z
        .string()
        // `abort: true` stops validation here on a length mismatch so the
        // alphabet check does not also fire — reproducing the hand-written
        // validator's `else if` (a wrong-length code yields exactly ONE error).
        .length(CODE_LENGTH, { message: `must be exactly ${CODE_LENGTH} chars`, abort: true })
        .regex(CODE_RE, {
          message: 'must match base32 alphabet [A-HJ-NP-Z2-9] (no I, L, O, 0, 1)',
        }),
    ),
}, { message: 'body must be a JSON object' });

export type RedeemBody = z.infer<typeof redeemBodySchema>;
