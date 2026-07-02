// Tests for _shared/schemas/invitations.ts — the single-source Zod schema for
// the invitations domain. Mirrors the behaviour the hand-written
// `validateRedeemBody` guaranteed (normalize → validate). Ref: #265 / ADR-0006.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { redeemBodySchema } from './invitations.ts';
import { zodIssuesToErrors } from '../zodError.ts';

Deno.test('redeemBodySchema accepts and normalizes a valid code', () => {
  for (const input of ['ABCD2345', 'abcd2345', '  abcd2345  ']) {
    const r = redeemBodySchema.safeParse({ code: input });
    assert(r.success, `expected ${input} to pass`);
    if (r.success) assertEquals(r.data.code, 'ABCD2345');
  }
});

Deno.test('redeemBodySchema rejects short / confusable / non-string codes', () => {
  for (const input of ['ABC', 'ABCDIJK2', 'ABCD2340', 'ABCD2341']) {
    assert(!redeemBodySchema.safeParse({ code: input }).success, `expected ${input} to fail`);
  }
  assert(!redeemBodySchema.safeParse({ code: 12345678 }).success);
});

Deno.test('redeemBodySchema rejects a non-object body with the whole-body message', () => {
  const r = redeemBodySchema.safeParse(null);
  assert(!r.success);
  if (!r.success) {
    const errors = zodIssuesToErrors(r.error);
    assertEquals(errors[0], { field: '', message: 'body must be a JSON object' });
  }
});

// Contract regression: the hand-written validator's `else if` returned EXACTLY
// ONE error — length OR alphabet, never both. Pin the whole errors array (not
// just `!success`) so a wrong-length code can't silently start emitting two
// entries in the 422 `details` payload again.
Deno.test('redeemBodySchema returns a single length error for a wrong-length code', () => {
  const r = redeemBodySchema.safeParse({ code: 'ABC' });
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error), [
      { field: 'code', message: 'must be exactly 8 chars' },
    ]);
  }
});

Deno.test('redeemBodySchema returns only the base32 error for a length-8 bad-alphabet code', () => {
  const r = redeemBodySchema.safeParse({ code: 'ABCDIJK2' }); // 8 chars, contains I
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error), [
      { field: 'code', message: 'must match base32 alphabet [A-HJ-NP-Z2-9] (no I, L, O, 0, 1)' },
    ]);
  }
});

// Deliberate, more-correct divergence from the hand-written validator: an array
// body (invalid input — `typeof [] === 'object'` let it slip through the old
// `!value || typeof value !== 'object'` guard and surface as "code must be a
// string") is now rejected as a non-object. Pinned so the intent is explicit.
Deno.test('redeemBodySchema rejects an array body with the whole-body message', () => {
  const r = redeemBodySchema.safeParse(['x']);
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error), [
      { field: '', message: 'body must be a JSON object' },
    ]);
  }
});
