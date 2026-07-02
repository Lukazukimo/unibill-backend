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
 * Renders a Zod issue path into the repo's `field` convention: object keys are
 * dot-joined and array indices use bracket notation, so `['household_ids', 0]`
 * becomes `household_ids[0]` (matching the hand-written validators) and an empty
 * path (a top-level/object error) becomes `''`.
 */
function renderPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/** Flattens a `ZodError` into the repo's `{ field, message }[]` shape. */
export function zodIssuesToErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: renderPath(issue.path),
    message: issue.message,
  }));
}
