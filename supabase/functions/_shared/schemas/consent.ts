// =============================================================================
// _shared/schemas/consent.ts
// -----------------------------------------------------------------------------
// Zod schemas + enums for the consent domain (accept + revoke) — single source
// of truth for request validation (runtime), TS types (`z.infer`) and, later,
// OpenAPI generation. Adopted incrementally per issue #265 / ADR-0006. Messages
// mirror the hand-written validateAcceptBody / validateRevokeBody so the 422
// `details` payload is unchanged for every scalar/object body. (Array bodies —
// invalid input — are rejected as non-objects, the documented divergence.)
//
// OpenAPI note for the follow-up slice: string fields normalize via `.transform`
// before validating, so generate request schemas from OUTPUT-mode
// `z.toJSONSchema(schema)`; `io:'input'` erases the constraints.
// =============================================================================

import { z } from 'zod';

export type ConsentPurpose = 'terms' | 'privacy' | 'telemetry' | 'marketing';
export type LegalBasis =
  | 'consent'
  | 'legitimate_interest'
  | 'legal_obligation'
  | 'contract';

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  'terms',
  'privacy',
  'telemetry',
  'marketing',
] as const;

export const LEGAL_BASES: readonly LegalBasis[] = [
  'consent',
  'legitimate_interest',
  'legal_obligation',
  'contract',
] as const;

export const VERSION_MAX_LENGTH = 64;
export const REASON_MAX_LENGTH = 256;
export const REASON_DEFAULT = 'user_request';

/**
 * A required string constrained to a fixed set, reproducing the hand-written
 * validators' two distinct messages: a non-string yields "must be a string",
 * while a string outside the set yields "must be one of: …". The output type
 * narrows to the member union.
 */
function enumField<T extends string>(values: readonly T[]) {
  return z
    .string({ message: 'must be a string' })
    .refine((v): v is T => (values as readonly string[]).includes(v), {
      message: `must be one of: ${values.join(', ')}`,
    })
    .transform((v) => v as T);
}

// version: trim, then non-empty → max-length (mutually exclusive → one error).
const versionField = z
  .string({ message: 'must be a string' })
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, { message: 'must not be empty' })
      .max(VERSION_MAX_LENGTH, { message: `max ${VERSION_MAX_LENGTH} chars` }),
  );

// revoked_reason: optional. Undefined OR empty-after-trim fall back to the
// default (both are non-errors); an oversized trimmed value is the only failure.
const revokedReasonField = z
  .string({ message: 'must be a string if provided' })
  .transform((s) => s.trim())
  .pipe(z.string().max(REASON_MAX_LENGTH, { message: `max ${REASON_MAX_LENGTH} chars` }))
  .transform((s) => (s.length === 0 ? REASON_DEFAULT : s));

/** Body for `POST /consent/accept`. */
export const acceptConsentBodySchema = z.object({
  purpose: enumField(CONSENT_PURPOSES),
  version: versionField,
  legal_basis: enumField(LEGAL_BASES),
  revoke_existing: z.boolean({ message: 'must be a boolean if provided' }).default(false),
}, { message: 'body must be a JSON object' });

/** Body for `POST /consent/revoke`. */
export const revokeConsentBodySchema = z.object({
  purpose: enumField(CONSENT_PURPOSES),
  revoked_reason: revokedReasonField.default(REASON_DEFAULT),
}, { message: 'body must be a JSON object' });

export type AcceptConsentBody = z.infer<typeof acceptConsentBodySchema>;
export type RevokeConsentBody = z.infer<typeof revokeConsentBodySchema>;
