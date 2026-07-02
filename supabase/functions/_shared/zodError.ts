// =============================================================================
// _shared/zodError.ts
// -----------------------------------------------------------------------------
// Adapter from a Zod issue set to the repo's pre-existing field-level error
// shape (`{ field, message }[]`). Migrated validators (issue #265 / ADR-0006)
// keep returning this shape, so the 422 `details` payload contract is unchanged
// while the validation logic moves to a single-source Zod schema.
// =============================================================================

import type { ZodError } from 'zod';

/** The field-level error shape used across the Edge Functions' 422 responses. */
export type FieldError = { field: string; message: string };

/**
 * Flattens a `ZodError` into `{ field, message }[]`. The `field` is the issue
 * path joined with `.` (an empty path — a top-level/object error — maps to `''`,
 * matching the hand-written validators' convention for whole-body failures).
 */
export function zodIssuesToErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
