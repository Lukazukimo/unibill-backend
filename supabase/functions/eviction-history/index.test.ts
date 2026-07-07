import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type RunsLoader } from './index.ts';
import { parseLimit, toRun } from './eviction.ts';

const ROW = {
  id: 'run-1',
  resource_type: 'storage',
  trigger_reason: 'orange_threshold',
  trigger_pct: 88.5,
  target_pct: 70,
  final_pct: 69.2,
  total_freed_bytes: 1048576,
  status: 'completed',
  started_at: '2026-07-06T12:00:00Z',
  finished_at: '2026-07-06T12:00:05Z',
  duration_ms: 5000,
  steps: [{ tier: 'pdf_archive', freed: 1048576 }],
  error_summary: null,
};

const admin = () => Promise.resolve({ id: 'a', email: 'a@x', is_system_admin: true });
const loaderOf = (rows: unknown[]): RunsLoader => () => Promise.resolve(rows as never);
const req = (qs = '', method = 'GET') =>
  new Request(`https://x.test/eviction-history${qs}`, {
    method,
    headers: { authorization: 'Bearer jwt' },
  });

Deno.test('parseLimit: default + clamp', () => {
  assertEquals(parseLimit(new URLSearchParams('')), 50);
  assertEquals(parseLimit(new URLSearchParams('limit=999')), 200);
  assertEquals(parseLimit(new URLSearchParams('limit=0')), 50);
  assertEquals(parseLimit(new URLSearchParams('limit=10')), 10);
});

Deno.test('toRun coerces numbers + nullable fields', () => {
  const r = toRun(ROW);
  assertEquals(r.trigger_pct, 88.5);
  assertEquals(r.final_pct, 69.2);
  assertEquals(r.total_freed_bytes, 1048576);
  assertEquals(r.error_summary, null);
  const running = toRun({ ...ROW, final_pct: null, finished_at: null, duration_ms: null });
  assertEquals(running.final_pct, null);
  assertEquals(running.finished_at, null);
});

Deno.test('non-GET → 405', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadRuns: loaderOf([ROW]) })(
    req('', 'POST'),
  );
  assertEquals(res.status, 405);
});

Deno.test('missing JWT → 401', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve(null),
    loadRuns: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 401);
});

Deno.test('non-sys-admin → 403', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve({ id: 'u', email: 'u@x', is_system_admin: false }),
    loadRuns: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 403);
});

Deno.test('sys-admin gets the runs → 200', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadRuns: loaderOf([ROW]) })(req());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.runs.length, 1);
  assertEquals(body.runs[0].resource_type, 'storage');
  assertEquals(body.runs[0].status, 'completed');
});

Deno.test('no runs → 200 { runs: [] }', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadRuns: loaderOf([]) })(req());
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { runs: [] });
});

Deno.test('the parsed limit is forwarded to the loader', async () => {
  let seen = 0;
  await buildHandler({
    getCallerUser: admin,
    loadRuns: (limit) => {
      seen = limit;
      return Promise.resolve([]);
    },
  })(req('?limit=25'));
  assertEquals(seen, 25);
});

Deno.test('OPTIONS → 204', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadRuns: loaderOf([ROW]) })(
    req('', 'OPTIONS'),
  );
  assertEquals(res.status, 204);
  assert(res.headers.get('access-control-allow-methods')?.includes('GET'));
});
