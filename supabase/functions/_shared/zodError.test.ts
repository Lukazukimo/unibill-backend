// Tests for _shared/zodError.ts — mapping a Zod issue set to the repo's
// existing field-level error shape (`{ field, message }[]`), so migrated
// validators keep the same 422 `details` contract. Ref: #265 / ADR-0006.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { z } from 'zod';
import { zodIssuesToErrors } from './zodError.ts';

Deno.test('zodIssuesToErrors maps a field issue to { field, message }', () => {
  const r = z.object({ code: z.string() }).safeParse({ code: 1 });
  assert(!r.success);
  const errors = zodIssuesToErrors(r.error);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].field, 'code');
  assert(typeof errors[0].message === 'string' && errors[0].message.length > 0);
});

Deno.test('zodIssuesToErrors maps a top-level (empty path) issue to field ""', () => {
  const r = z.object({ code: z.string() }).safeParse(null);
  assert(!r.success);
  const errors = zodIssuesToErrors(r.error);
  assertEquals(errors[0].field, '');
});

Deno.test('zodIssuesToErrors joins a nested path with dots', () => {
  const r = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
  assert(!r.success);
  const errors = zodIssuesToErrors(r.error);
  assertEquals(errors[0].field, 'a.b');
});
