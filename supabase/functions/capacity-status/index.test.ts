import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type SnapshotLoader } from './index.ts';
import { toStatus } from './status.ts';

const SNAPSHOT = {
  checked_at: '2026-07-06T12:00:00Z',
  db_pct: 42.5,
  db_status: 'green',
  storage_pct: 18,
  storage_status: 'green',
  queue_depths: { extraction: 3, sync: 0 },
  thresholds_snapshot: { yellow: 70, orange: 85, red: 95 },
};

const adminReq = (method = 'GET') =>
  new Request('https://x.test/capacity-status', {
    method,
    headers: { authorization: 'Bearer jwt' },
  });

const admin = () => Promise.resolve({ id: 'a', email: 'a@x', is_system_admin: true });
const loaderOf = (row: unknown): SnapshotLoader => () => Promise.resolve(row as never);

Deno.test('toStatus maps a row into db/storage gauges + queues', () => {
  const s = toStatus(SNAPSHOT);
  assertEquals(s.db, { pct: 42.5, status: 'green' });
  assertEquals(s.storage, { pct: 18, status: 'green' });
  assertEquals(s.queue_depths, { extraction: 3, sync: 0 });
  assertEquals(s.checked_at, '2026-07-06T12:00:00Z');
});

Deno.test('non-GET → 405', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadSnapshot: loaderOf(SNAPSHOT) })(
    adminReq('POST'),
  );
  assertEquals(res.status, 405);
});

Deno.test('missing/invalid JWT → 401', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve(null),
    loadSnapshot: loaderOf(SNAPSHOT),
  })(adminReq());
  assertEquals(res.status, 401);
});

Deno.test('a non-sys-admin caller → 403', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve({ id: 'u', email: 'u@x', is_system_admin: false }),
    loadSnapshot: loaderOf(SNAPSHOT),
  })(adminReq());
  assertEquals(res.status, 403);
});

Deno.test('a sys-admin gets the latest snapshot → 200', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadSnapshot: loaderOf(SNAPSHOT) })(
    adminReq(),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.db, { pct: 42.5, status: 'green' });
});

Deno.test('no snapshot yet → 200 { snapshot: null }', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadSnapshot: loaderOf(null) })(
    adminReq(),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { snapshot: null });
});

Deno.test('OPTIONS preflight → 204', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadSnapshot: loaderOf(SNAPSHOT) })(
    new Request('https://x.test/capacity-status', { method: 'OPTIONS' }),
  );
  assertEquals(res.status, 204);
  assert(res.headers.get('access-control-allow-methods')?.includes('GET'));
});
