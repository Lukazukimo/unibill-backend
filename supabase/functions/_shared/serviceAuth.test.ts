import { assert } from 'jsr:@std/assert@^1.0.0';
import { requireServiceRole } from './serviceAuth.ts';

const KEY = 'svc-role-key-xyz-1234567890';

function req(authHeader?: string): Request {
  return new Request(
    'https://x.test/fn',
    authHeader ? { headers: { authorization: authHeader } } : undefined,
  );
}

Deno.test('requireServiceRole accepts a bearer that matches the service-role key', () => {
  assert(requireServiceRole(req(`Bearer ${KEY}`), { serviceRoleKey: KEY }));
});

Deno.test('requireServiceRole rejects a wrong token', () => {
  assert(!requireServiceRole(req('Bearer not-the-key'), { serviceRoleKey: KEY }));
});

Deno.test('requireServiceRole rejects missing / non-bearer headers', () => {
  assert(!requireServiceRole(req(), { serviceRoleKey: KEY }));
  assert(!requireServiceRole(req('Basic abc'), { serviceRoleKey: KEY }));
  assert(!requireServiceRole(req('Bearer '), { serviceRoleKey: KEY }));
});

Deno.test('requireServiceRole rejects when no service-role key is configured', () => {
  assert(!requireServiceRole(req(`Bearer ${KEY}`), { serviceRoleKey: '' }));
});
