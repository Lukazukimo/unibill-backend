import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { deriveReason, parseRequest } from './admins.ts';

const CALLER = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

function value(raw: unknown) {
  const r = parseRequest(raw);
  assert('value' in r, `expected a valid parse, got ${JSON.stringify(r)}`);
  return r.value;
}

function rejects(raw: unknown): string {
  const r = parseRequest(raw);
  assert('error' in r, `expected a rejection, got ${JSON.stringify(r)}`);
  return r.error;
}

Deno.test('parseRequest: promote by user_id', () => {
  const v = value({ action: 'promote', user_id: TARGET });
  assertEquals(v.action, 'promote');
  assertEquals(v.userId, TARGET);
  assertEquals(v.email, undefined);
});

Deno.test('parseRequest: revoke by email is lowercased', () => {
  const v = value({ action: 'revoke', email: 'Admin@Example.COM' });
  assertEquals(v.action, 'revoke');
  assertEquals(v.email, 'admin@example.com');
  assertEquals(v.userId, undefined);
});

Deno.test('parseRequest: an optional note within 500 chars is kept', () => {
  const v = value({ action: 'promote', user_id: TARGET, note: 'onboarding a peer' });
  assertEquals(v.note, 'onboarding a peer');
});

Deno.test('parseRequest rejects a bad action', () => {
  rejects({ action: 'delete', user_id: TARGET });
  rejects({ user_id: TARGET });
});

Deno.test('parseRequest rejects both identifiers', () => {
  rejects({ action: 'promote', user_id: TARGET, email: 'a@b.com' });
});

Deno.test('parseRequest rejects neither identifier', () => {
  rejects({ action: 'promote' });
});

Deno.test('parseRequest rejects a malformed uuid', () => {
  rejects({ action: 'promote', user_id: 'not-a-uuid' });
});

Deno.test('parseRequest rejects a malformed email', () => {
  rejects({ action: 'revoke', email: 'no-at-sign' });
});

Deno.test('parseRequest rejects a non-object / note over 500', () => {
  rejects(null);
  rejects('nope');
  rejects({ action: 'promote', user_id: TARGET, note: 'x'.repeat(501) });
});

Deno.test('deriveReason maps the action + self/peer', () => {
  assertEquals(deriveReason('promote', TARGET, CALLER), 'peer_promotion');
  assertEquals(deriveReason('revoke', TARGET, CALLER), 'peer_revocation');
  assertEquals(deriveReason('revoke', CALLER, CALLER), 'self_revoke');
});
