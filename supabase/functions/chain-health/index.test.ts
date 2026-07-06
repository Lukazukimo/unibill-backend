import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { type BreakersLoader, buildHandler } from './index.ts';
import { toBreaker } from './chain.ts';

const ROW = {
  resource_type: 'ocr_provider',
  resource_key: 'ocr_space',
  state: 'open',
  failure_count: 5,
  last_failure_at: '2026-07-06T11:00:00Z',
  opened_at: '2026-07-06T11:00:05Z',
  reason: 'sustained failures',
  probes_sent: 2,
  probes_succeeded: 0,
  updated_at: '2026-07-06T11:05:00Z',
};

const req = (method = 'GET') =>
  new Request('https://x.test/chain-health', {
    method,
    headers: { authorization: 'Bearer jwt' },
  });

const admin = () => Promise.resolve({ id: 'a', email: 'a@x', is_system_admin: true });
const loaderOf = (rows: unknown[]): BreakersLoader => () => Promise.resolve(rows as never);

Deno.test('toBreaker maps a row + coerces numbers', () => {
  const b = toBreaker(ROW);
  assertEquals(b.state, 'open');
  assertEquals(b.failure_count, 5);
  assertEquals(b.resource_key, 'ocr_space');
  assertEquals(b.reason, 'sustained failures');
});

Deno.test('non-GET → 405', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadBreakers: loaderOf([ROW]) })(
    req('POST'),
  );
  assertEquals(res.status, 405);
});

Deno.test('missing/invalid JWT → 401', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve(null),
    loadBreakers: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 401);
});

Deno.test('non-sys-admin → 403', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve({ id: 'u', email: 'u@x', is_system_admin: false }),
    loadBreakers: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 403);
});

Deno.test('sys-admin gets the breakers → 200', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadBreakers: loaderOf([ROW]) })(req());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.breakers.length, 1);
  assertEquals(body.breakers[0].resource_key, 'ocr_space');
  assertEquals(body.breakers[0].state, 'open');
});

Deno.test('no breakers → 200 { breakers: [] }', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadBreakers: loaderOf([]) })(req());
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { breakers: [] });
});

Deno.test('OPTIONS preflight → 204', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadBreakers: loaderOf([ROW]) })(
    new Request('https://x.test/chain-health', { method: 'OPTIONS' }),
  );
  assertEquals(res.status, 204);
  assert(res.headers.get('access-control-allow-methods')?.includes('GET'));
});
