// Tests for _shared/schemas/consent.ts — single-source Zod schemas for the
// consent domain (accept + revoke). Enum fields with the two-message contract
// (non-string vs not-in-set), optional boolean/string with defaults. Pins the
// exact 422 `details` arrays. Ref: #265.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  acceptConsentBodySchema,
  CONSENT_PURPOSES,
  LEGAL_BASES,
  REASON_MAX_LENGTH,
  revokeConsentBodySchema,
  VERSION_MAX_LENGTH,
} from './consent.ts';
import { zodIssuesToErrors } from '../zodError.ts';

const PURPOSE_MSG = `must be one of: ${CONSENT_PURPOSES.join(', ')}`;
const BASIS_MSG = `must be one of: ${LEGAL_BASES.join(', ')}`;

// --- accept -----------------------------------------------------------------

Deno.test('acceptConsentBodySchema accepts a valid body and defaults revoke_existing', () => {
  const r = acceptConsentBodySchema.safeParse({
    purpose: 'terms',
    version: '  v1.2  ',
    legal_basis: 'consent',
  });
  assert(r.success);
  if (r.success) {
    assertEquals(r.data, {
      purpose: 'terms',
      version: 'v1.2',
      legal_basis: 'consent',
      revoke_existing: false,
    });
  }
});

Deno.test('acceptConsentBodySchema honours revoke_existing when boolean', () => {
  const r = acceptConsentBodySchema.safeParse({
    purpose: 'privacy',
    version: 'v1',
    legal_basis: 'consent',
    revoke_existing: true,
  });
  assert(r.success);
  if (r.success) assertEquals(r.data.revoke_existing, true);
});

Deno.test('acceptConsentBodySchema — per-field error contract', () => {
  const base = { purpose: 'terms', version: 'v1', legal_basis: 'consent' };
  const cases: Array<[Record<string, unknown>, { field: string; message: string }]> = [
    [{ ...base, purpose: 5 }, { field: 'purpose', message: 'must be a string' }],
    [{ ...base, purpose: 'nope' }, { field: 'purpose', message: PURPOSE_MSG }],
    [{ ...base, version: '   ' }, { field: 'version', message: 'must not be empty' }],
    [
      { ...base, version: 'x'.repeat(VERSION_MAX_LENGTH + 1) },
      { field: 'version', message: `max ${VERSION_MAX_LENGTH} chars` },
    ],
    [{ ...base, legal_basis: 'maybe' }, { field: 'legal_basis', message: BASIS_MSG }],
    [
      { ...base, revoke_existing: 'yes' },
      { field: 'revoke_existing', message: 'must be a boolean if provided' },
    ],
  ];
  for (const [body, expected] of cases) {
    const r = acceptConsentBodySchema.safeParse(body);
    assert(!r.success, `expected ${JSON.stringify(body)} to fail`);
    if (!r.success) assertEquals(zodIssuesToErrors(r.error), [expected]);
  }
});

Deno.test('acceptConsentBodySchema flags purpose+version+legal_basis on an empty body', () => {
  const r = acceptConsentBodySchema.safeParse({});
  assert(!r.success);
  if (!r.success) {
    const fields = zodIssuesToErrors(r.error).map((e) => e.field).sort();
    assertEquals(fields, ['legal_basis', 'purpose', 'version']);
  }
});

Deno.test('acceptConsentBodySchema rejects a non-object body', () => {
  const r = acceptConsentBodySchema.safeParse('not an object');
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error)[0], {
      field: '',
      message: 'body must be a JSON object',
    });
  }
});

// --- revoke -----------------------------------------------------------------

Deno.test('revokeConsentBodySchema defaults revoked_reason to user_request', () => {
  const r = revokeConsentBodySchema.safeParse({ purpose: 'telemetry' });
  assert(r.success);
  if (r.success) assertEquals(r.data, { purpose: 'telemetry', revoked_reason: 'user_request' });
});

Deno.test('revokeConsentBodySchema trims reason and treats empty as the default', () => {
  const r = revokeConsentBodySchema.safeParse({ purpose: 'terms', revoked_reason: '   ' });
  assert(r.success);
  if (r.success) assertEquals(r.data.revoked_reason, 'user_request');
});

Deno.test('revokeConsentBodySchema keeps a trimmed non-empty reason', () => {
  const r = revokeConsentBodySchema.safeParse({
    purpose: 'terms',
    revoked_reason: '  changed my mind  ',
  });
  assert(r.success);
  if (r.success) assertEquals(r.data.revoked_reason, 'changed my mind');
});

Deno.test('revokeConsentBodySchema — per-field error contract', () => {
  const cases: Array<[Record<string, unknown>, { field: string; message: string }]> = [
    [{ purpose: 'spam' }, { field: 'purpose', message: PURPOSE_MSG }],
    [{ purpose: 5 }, { field: 'purpose', message: 'must be a string' }],
    [
      { purpose: 'terms', revoked_reason: 42 },
      { field: 'revoked_reason', message: 'must be a string if provided' },
    ],
    [
      { purpose: 'terms', revoked_reason: 'x'.repeat(REASON_MAX_LENGTH + 1) },
      { field: 'revoked_reason', message: `max ${REASON_MAX_LENGTH} chars` },
    ],
  ];
  for (const [body, expected] of cases) {
    const r = revokeConsentBodySchema.safeParse(body);
    assert(!r.success, `expected ${JSON.stringify(body)} to fail`);
    if (!r.success) assertEquals(zodIssuesToErrors(r.error), [expected]);
  }
});

Deno.test('revokeConsentBodySchema rejects a non-object body', () => {
  const r = revokeConsentBodySchema.safeParse('nope');
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error)[0], {
      field: '',
      message: 'body must be a JSON object',
    });
  }
});
