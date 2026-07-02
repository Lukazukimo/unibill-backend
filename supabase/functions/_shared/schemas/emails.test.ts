// Tests for _shared/schemas/emails.ts — single-source Zod schema for the emails
// domain (the richest so far: multi-field accumulation, per-element UUID array
// with dedup, field renames). Pins the exact 422 `details` arrays. Ref: #265.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { connectEmailBodySchema } from './emails.ts';
import { zodIssuesToErrors } from '../zodError.ts';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

Deno.test('connectEmailBodySchema accepts and normalizes a valid body', () => {
  const r = connectEmailBodySchema.safeParse({
    email_address: '  Foo.Bar@Example.com  ',
    app_password: 'ABCD EFGH IJKL MNOP',
    household_ids: [UUID_A.toUpperCase()],
  });
  assert(r.success);
  if (r.success) {
    assertEquals(r.data.email_address, 'foo.bar@example.com');
    assertEquals(r.data.app_password, 'abcdefghijklmnop');
    assertEquals(r.data.household_ids, [UUID_A]);
  }
});

Deno.test('connectEmailBodySchema — email field single-error contract', () => {
  const cases: Array<[unknown, { field: string; message: string }]> = [
    [123, { field: 'email_address', message: 'must be a string' }],
    ['   ', { field: 'email_address', message: 'must not be empty' }],
    ['a'.repeat(255) + '@b.co', { field: 'email_address', message: 'max 254 chars' }],
    ['not-an-email', { field: 'email_address', message: 'invalid email format' }],
  ];
  for (const [email, expected] of cases) {
    const r = connectEmailBodySchema.safeParse({
      email_address: email,
      app_password: 'abcdefghijklmnop',
      household_ids: [UUID_A],
    });
    assert(!r.success);
    if (!r.success) assertEquals(zodIssuesToErrors(r.error), [expected]);
  }
});

Deno.test('connectEmailBodySchema — app_password field single-error contract', () => {
  const cases: Array<[unknown, string]> = [
    [123, 'must be a string'],
    ['short', 'must be exactly 16 lowercase letters (Google app password)'],
    ['12', 'must be exactly 16 lowercase letters (Google app password)'], // wrong length wins
    ['abcd1234efgh5678', 'must contain only lowercase letters [a-z]'], // len 16, has digits
  ];
  for (const [pw, message] of cases) {
    const r = connectEmailBodySchema.safeParse({
      email_address: 'a@b.co',
      app_password: pw,
      household_ids: [UUID_A],
    });
    assert(!r.success);
    if (!r.success) assertEquals(zodIssuesToErrors(r.error), [{ field: 'app_password', message }]);
  }
});

Deno.test('connectEmailBodySchema — household_ids contract (array/empty/uuid/dedup)', () => {
  const base = { email_address: 'a@b.co', app_password: 'abcdefghijklmnop' };

  const notArray = connectEmailBodySchema.safeParse({ ...base, household_ids: 'x' });
  assert(!notArray.success);
  if (!notArray.success) {
    assertEquals(zodIssuesToErrors(notArray.error), [
      { field: 'household_ids', message: 'must be an array of UUID strings' },
    ]);
  }

  const empty = connectEmailBodySchema.safeParse({ ...base, household_ids: [] });
  assert(!empty.success);
  if (!empty.success) {
    assertEquals(zodIssuesToErrors(empty.error), [
      { field: 'household_ids', message: 'must contain at least one household_id' },
    ]);
  }

  const bad = connectEmailBodySchema.safeParse({ ...base, household_ids: ['nope', 42] });
  assert(!bad.success);
  if (!bad.success) {
    assertEquals(zodIssuesToErrors(bad.error), [
      { field: 'household_ids[0]', message: 'must be a UUID' },
      { field: 'household_ids[1]', message: 'must be a UUID' },
    ]);
  }

  const dup = connectEmailBodySchema.safeParse({ ...base, household_ids: [UUID_A, UUID_A] });
  assert(!dup.success);
  if (!dup.success) {
    assertEquals(zodIssuesToErrors(dup.error), [
      { field: 'household_ids[1]', message: 'duplicate household_id' },
    ]);
  }
});

Deno.test('connectEmailBodySchema accumulates errors across all fields in order', () => {
  const r = connectEmailBodySchema.safeParse({
    email_address: 'bad',
    app_password: 'short',
    household_ids: [],
  });
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error).map((e) => e.field), [
      'email_address',
      'app_password',
      'household_ids',
    ]);
  }
});

Deno.test('connectEmailBodySchema rejects a non-object body', () => {
  const r = connectEmailBodySchema.safeParse(null);
  assert(!r.success);
  if (!r.success) {
    assertEquals(zodIssuesToErrors(r.error)[0], {
      field: '',
      message: 'body must be a JSON object',
    });
  }
});

// second household kept only to exercise a valid multi-id body
Deno.test('connectEmailBodySchema accepts multiple distinct household_ids', () => {
  const r = connectEmailBodySchema.safeParse({
    email_address: 'a@b.co',
    app_password: 'abcdefghijklmnop',
    household_ids: [UUID_A, UUID_B],
  });
  assert(r.success);
  if (r.success) assertEquals(r.data.household_ids, [UUID_A, UUID_B]);
});
