// Tests for _shared/schemas/households.ts — single-source Zod schema for the
// households domain. Mirrors the hand-written `validateCreateBody` (trim →
// non-empty → max-length). Pins the exact 422 `details` array (not just
// pass/fail) per the lesson from the invitations-redeem pilot. Ref: #265.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { createHouseholdBodySchema, NAME_MAX } from './households.ts';
import { zodIssuesToErrors } from '../zodError.ts';

Deno.test('createHouseholdBodySchema accepts and trims a normal name', () => {
  const r = createHouseholdBodySchema.safeParse({ name: '  Casa da Praia  ' });
  assert(r.success);
  if (r.success) assertEquals(r.data.name, 'Casa da Praia');
});

Deno.test('createHouseholdBodySchema accepts NAME_MAX chars, rejects NAME_MAX+1', () => {
  assert(createHouseholdBodySchema.safeParse({ name: 'x'.repeat(NAME_MAX) }).success);
  assert(!createHouseholdBodySchema.safeParse({ name: 'x'.repeat(NAME_MAX + 1) }).success);
});

Deno.test('createHouseholdBodySchema returns a single empty-name error (trimmed)', () => {
  for (const name of ['', '   ']) {
    const r = createHouseholdBodySchema.safeParse({ name });
    assert(!r.success, `expected ${JSON.stringify(name)} to fail`);
    if (!r.success) {
      assertEquals(zodIssuesToErrors(r.error), [{ field: 'name', message: 'must not be empty' }]);
    }
  }
});

Deno.test('createHouseholdBodySchema returns a single over-long error', () => {
  const r = createHouseholdBodySchema.safeParse({ name: 'x'.repeat(NAME_MAX + 1) });
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error), [
      { field: 'name', message: `must be at most ${NAME_MAX} chars` },
    ]);
  }
});

Deno.test('createHouseholdBodySchema maps non-string name and non-object body', () => {
  const r1 = createHouseholdBodySchema.safeParse({ name: 123 });
  assert(!r1.success);
  if (!r1.success) {
    assertEquals(zodIssuesToErrors(r1.error), [{ field: 'name', message: 'must be a string' }]);
  }
  const r2 = createHouseholdBodySchema.safeParse(null);
  assert(!r2.success);
  if (!r2.success) {
    assertEquals(zodIssuesToErrors(r2.error)[0], {
      field: '',
      message: 'body must be a JSON object',
    });
  }
});
