// =============================================================================
// _shared/schemas/households.ts
// -----------------------------------------------------------------------------
// Zod schemas for the households domain — single source of truth for request
// validation (runtime), TS types (`z.infer`) and, in a later slice, OpenAPI
// generation (`z.toJSONSchema`). Adopted incrementally per issue #265 /
// ADR-0006. Messages mirror the previous hand-written `validateCreateBody`, so
// the 422 `details` payload is unchanged for every scalar/object body. (One
// deliberate, more-correct divergence, shared with the pilot: an array body —
// invalid input — is rejected as a non-object instead of "name must be a
// string".)
//
// OpenAPI note for the follow-up slice: normalization (`.transform` trim) runs
// BEFORE the length checks, so the constraints live on the OUTPUT side of the
// pipe. Generate the request schema from OUTPUT-mode `z.toJSONSchema(schema)`
// (keeps minLength/maxLength); `io:'input'` erases them.
// =============================================================================

import { z } from 'zod';

/** Max household name length after trimming (mirrors households-create). */
export const NAME_MAX = 80;

/**
 * Body for `POST /households`: `{ name }`. The name is trimmed, then must be
 * non-empty and at most `NAME_MAX` chars. `min` and `max` are mutually
 * exclusive for any single string, so at most one issue ever fires — matching
 * the hand-written validator's single-error output.
 */
export const createHouseholdBodySchema = z.object({
  name: z
    .string({ message: 'must be a string' })
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, { message: 'must not be empty' })
        .max(NAME_MAX, { message: `must be at most ${NAME_MAX} chars` }),
    ),
}, { message: 'body must be a JSON object' });

export type CreateHouseholdBody = z.infer<typeof createHouseholdBodySchema>;
