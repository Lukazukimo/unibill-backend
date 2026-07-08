import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type TelemetryLoader } from './index.ts';
import { decodeCursor, encodeCursor, parseQuery, toTelemetry } from './query.ts';

const TEL_ID = '11111111-1111-1111-1111-111111111111';
const ROW = {
  id: TEL_ID,
  occurred_at: '2026-07-06T12:00:00Z',
  event_type: 'app.crash',
  severity: 'error',
  app_version: '0.2.0',
  release_channel: 'beta',
  session_id: '22222222-2222-2222-2222-222222222222',
  payload: { message: 'boom' },
  device_info: { os: 'android' },
};

const admin = () => Promise.resolve({ id: 'a', email: 'a@x', is_system_admin: true });
const loaderOf = (rows: unknown[]): TelemetryLoader => () => Promise.resolve(rows as never);
const req = (qs = '', method = 'GET') =>
  new Request(`https://x.test/telemetry-history${qs}`, {
    method,
    headers: { authorization: 'Bearer jwt' },
  });

Deno.test('parseQuery: defaults + severity/event filters', () => {
  assertEquals(parseQuery(new URLSearchParams('')).limit, 50);
  assertEquals(parseQuery(new URLSearchParams('limit=500')).limit, 100);
  const f = parseQuery(new URLSearchParams('severity=error&event_type=app.crash'));
  assertEquals(f.severity, 'error');
  assertEquals(f.eventType, 'app.crash');
});

Deno.test('cursor roundtrips; non-uuid / injection chars rejected', () => {
  assertEquals(decodeCursor(encodeCursor('2026-07-06T12:00:00Z', TEL_ID)), {
    occurredAt: '2026-07-06T12:00:00Z',
    id: TEL_ID,
  });
  assertEquals(decodeCursor(encodeCursor('2026-01-01', 'not-a-uuid')), null);
  assertEquals(decodeCursor(encodeCursor('x,or(id.gt.0)', TEL_ID)), null);
});

Deno.test('toTelemetry shapes + omits user/household ids', () => {
  const t = toTelemetry(ROW);
  assertEquals(t.event_type, 'app.crash');
  assertEquals(t.severity, 'error');
  assertEquals((t as Record<string, unknown>).user_id, undefined);
  assertEquals((t as Record<string, unknown>).household_id, undefined);
});

Deno.test('non-GET → 405', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadTelemetry: loaderOf([ROW]) })(
    req('', 'POST'),
  );
  assertEquals(res.status, 405);
});

Deno.test('missing JWT → 401', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve(null),
    loadTelemetry: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 401);
});

Deno.test('non-sys-admin → 403', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve({ id: 'u', email: 'u@x', is_system_admin: false }),
    loadTelemetry: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 403);
});

Deno.test('a malformed timestamp filter → 422', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadTelemetry: loaderOf([]) })(
    req('?from=garbage'),
  );
  assertEquals(res.status, 422);
});

Deno.test('sys-admin gets telemetry + next_cursor on a full page', async () => {
  const res = await buildHandler({
    getCallerUser: admin,
    loadTelemetry: loaderOf([ROW, ROW]),
  })(req('?limit=2'));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.telemetry.length, 2);
  assertEquals(body.telemetry[0].event_type, 'app.crash');
  assert(body.next_cursor !== null);
});

Deno.test('a partial page has no next_cursor', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadTelemetry: loaderOf([ROW]) })(
    req('?limit=50'),
  );
  assertEquals((await res.json()).next_cursor, null);
});

Deno.test('the parsed filter is forwarded to the loader', async () => {
  let seen: unknown = null;
  await buildHandler({
    getCallerUser: admin,
    loadTelemetry: (f) => {
      seen = f;
      return Promise.resolve([]);
    },
  })(req('?severity=error'));
  assertEquals((seen as { severity: string }).severity, 'error');
});

Deno.test('OPTIONS → 204', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadTelemetry: loaderOf([ROW]) })(
    req('', 'OPTIONS'),
  );
  assertEquals(res.status, 204);
  assert(res.headers.get('access-control-allow-methods')?.includes('GET'));
});
