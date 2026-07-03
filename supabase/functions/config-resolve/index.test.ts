// Handler tests for config-resolve (issue #278) — auth, key parsing, cascade
// wiring and response codes, with the caller resolver and settings loader faked.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type SettingsLoader } from './index.ts';
import type { SettingRow } from './resolve.ts';

const GET = (key?: string) =>
  new Request(`https://x.test/config-resolve${key === undefined ? '' : `?key=${key}`}`, {
    method: 'GET',
    headers: { authorization: 'Bearer jwt' },
  });

const okUser = () => Promise.resolve({ id: 'me' });
const loaderOf =
  (rows: SettingRow[], currentHousehold: string | null = null): SettingsLoader => () =>
    Promise.resolve({ rows, currentHousehold });

Deno.test('non-GET → 405', async () => {
  const res = await buildHandler({ getCallerUser: okUser, loadSettings: loaderOf([]) })(
    new Request('https://x.test/config-resolve?key=k', { method: 'POST' }),
  );
  assertEquals(res.status, 405);
});

Deno.test('missing/invalid JWT → 401', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve(null),
    loadSettings: loaderOf([]),
  })(GET('k'));
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, 'unauthorized');
});

Deno.test('missing key → 400', async () => {
  for (const req of [GET(), GET('')]) {
    const res = await buildHandler({ getCallerUser: okUser, loadSettings: loaderOf([]) })(req);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, 'invalid_request');
  }
});

Deno.test('resolves the user-scoped value, unwrapped → 200', async () => {
  // stored wrapped as {"v": ...}; the caller's id ('me') matches the row scope_id.
  const rows: SettingRow[] = [
    { value: { v: 'g' }, scope: 'global', scope_id: null },
    { value: { v: 'mine' }, scope: 'user', scope_id: 'me' },
  ];
  const res = await buildHandler({ getCallerUser: okUser, loadSettings: loaderOf(rows) })(GET('k'));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { value: 'mine', scope_resolved_from: 'user' });
});

Deno.test('resolves the household value for the current household, unwrapped → 200', async () => {
  const rows: SettingRow[] = [
    { value: { v: 1 }, scope: 'global', scope_id: null },
    { value: { v: 2 }, scope: 'household', scope_id: 'hh-1' },
  ];
  const res = await buildHandler({
    getCallerUser: okUser,
    loadSettings: loaderOf(rows, 'hh-1'),
  })(GET('k'));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { value: 2, scope_resolved_from: 'household' });
});

Deno.test('nothing resolves → 404 key_not_found', async () => {
  const res = await buildHandler({ getCallerUser: okUser, loadSettings: loaderOf([]) })(GET('k'));
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, 'key_not_found');
});

Deno.test('loadSettings failure → 500 (not masked as 404)', async () => {
  const res = await buildHandler({
    getCallerUser: okUser,
    loadSettings: () => Promise.reject(new Error('db down')),
  })(GET('k'));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, 'internal_error');
});

Deno.test('OPTIONS preflight → 204 with CORS', async () => {
  const res = await buildHandler({ getCallerUser: okUser, loadSettings: loaderOf([]) })(
    new Request('https://x.test/config-resolve', { method: 'OPTIONS' }),
  );
  assertEquals(res.status, 204);
  assert(res.headers.get('access-control-allow-methods')?.includes('GET'));
});
