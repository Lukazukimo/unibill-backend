/**
 * privacy-delete handler tests — method/auth/body gates, the confirmation
 * mismatch (400), the sole-admin block (422 + household list), the happy path
 * (200 { deletion_initiated }), and a fatal orchestrator error (500).
 *
 * The checks and the orchestrator are injected; their own logic is covered in
 * checks.test.ts / orchestrator.test.ts.
 *
 * Ref: T-609 (#119), spec §9.4 / §E, BR-021.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type HandlerDeps } from './index.ts';

const UID = '11111111-1111-4111-8111-111111111111';

// deno-lint-ignore no-explicit-any
const fakeClient = {} as any;

function baseDeps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    getCallerUser: () => Promise.resolve({ id: UID, email: 'me@x.co' }),
    client: fakeClient,
    findSoleAdmins: () => Promise.resolve([]),
    run: () => Promise.resolve({ deleted_at: '2026-06-25T10:00:00.000Z' }),
    ...over,
  };
}

function req(method = 'DELETE', body: unknown = { confirmation_email: 'me@x.co' }): Request {
  return new Request('https://x.test/privacy-delete', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test('non-DELETE method returns 405', async () => {
  const res = await buildHandler(baseDeps())(req('POST'));
  assertEquals(res.status, 405);
});

Deno.test('missing/invalid JWT returns 401', async () => {
  const res = await buildHandler(baseDeps({ getCallerUser: () => Promise.resolve(null) }))(req());
  assertEquals(res.status, 401);
});

Deno.test('invalid JSON body returns 400', async () => {
  const r = new Request('https://x.test/privacy-delete', { method: 'DELETE', body: 'not-json{' });
  const res = await buildHandler(baseDeps())(r);
  assertEquals(res.status, 400);
});

Deno.test('confirmation_email mismatch returns 400', async () => {
  const res = await buildHandler(baseDeps())(req('DELETE', { confirmation_email: 'typo@x.co' }));
  assertEquals(res.status, 400);
});

Deno.test('sole-admin caller is blocked with 422 + the household list', async () => {
  const res = await buildHandler(baseDeps({
    findSoleAdmins: () => Promise.resolve(['h1', 'h2']),
  }))(req());
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.households, ['h1', 'h2']);
});

Deno.test('happy path returns 200 { deletion_initiated: true } and runs the orchestrator', async () => {
  let ran = '';
  const res = await buildHandler(baseDeps({
    run: (caller) => {
      ran = caller.id;
      return Promise.resolve({ deleted_at: '2026-06-25T10:00:00.000Z' });
    },
  }))(req());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.deletion_initiated, true);
  assertEquals(ran, UID);
});

Deno.test('a fatal orchestrator error returns 500', async () => {
  const res = await buildHandler(baseDeps({
    run: () => Promise.reject(new Error('deleteUser failed')),
  }))(req());
  assertEquals(res.status, 500);
});
