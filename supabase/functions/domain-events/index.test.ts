import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type EventsLoader } from './index.ts';
import { decodeCursor, encodeCursor, nextCursor, parseQuery, toEvent } from './query.ts';

const EVT_ID = '11111111-1111-1111-1111-111111111111';
const ROW = {
  id: EVT_ID,
  event_type: 'circuit.admin_controlled',
  aggregate_type: 'circuit_breaker',
  aggregate_id: '00000000-0000-0000-0000-000000000000',
  actor_type: 'user',
  actor_user_id: 'admin-1',
  occurred_at: '2026-07-06T12:00:00Z',
  payload: { version: 1, data: { action: 'force_open' } },
};

const admin = () => Promise.resolve({ id: 'a', email: 'a@x', is_system_admin: true });
const loaderOf = (rows: unknown[]): EventsLoader => () => Promise.resolve(rows as never);
const req = (qs = '', method = 'GET') =>
  new Request(`https://x.test/domain-events${qs}`, {
    method,
    headers: { authorization: 'Bearer jwt' },
  });

Deno.test('parseQuery: defaults + clamps limit', () => {
  assertEquals(parseQuery(new URLSearchParams('')).limit, 50);
  assertEquals(parseQuery(new URLSearchParams('limit=500')).limit, 100);
  assertEquals(parseQuery(new URLSearchParams('limit=0')).limit, 50);
  const f = parseQuery(new URLSearchParams('event_type=x&actor_user_id=u&from=2026-01-01'));
  assertEquals(f.eventType, 'x');
  assertEquals(f.actorUserId, 'u');
  assertEquals(f.from, '2026-01-01');
});

Deno.test('cursor roundtrips; garbage / non-uuid decodes to null', () => {
  const c = encodeCursor('2026-07-06T12:00:00Z', EVT_ID);
  assertEquals(decodeCursor(c), { occurredAt: '2026-07-06T12:00:00Z', id: EVT_ID });
  assertEquals(decodeCursor('!!!not-base64!!!'), null);
  assertEquals(decodeCursor(null), null);
  // Injection guard: non-uuid id / filter chars in the timestamp are rejected.
  assertEquals(decodeCursor(encodeCursor('2026-01-01', 'not-a-uuid')), null);
  assertEquals(decodeCursor(encodeCursor('x,or(id.gt.0)', EVT_ID)), null);
});

Deno.test('nextCursor: full page yields a cursor, partial yields null', () => {
  const e = toEvent(ROW);
  assertEquals(nextCursor([e, e], 2) !== null, true);
  assertEquals(nextCursor([e], 2), null);
  assertEquals(nextCursor([], 2), null);
});

Deno.test('non-GET → 405', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadEvents: loaderOf([ROW]) })(
    req('', 'POST'),
  );
  assertEquals(res.status, 405);
});

Deno.test('missing JWT → 401', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve(null),
    loadEvents: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 401);
});

Deno.test('non-sys-admin → 403', async () => {
  const res = await buildHandler({
    getCallerUser: () => Promise.resolve({ id: 'u', email: 'u@x', is_system_admin: false }),
    loadEvents: loaderOf([ROW]),
  })(req());
  assertEquals(res.status, 403);
});

Deno.test('sys-admin gets a page of events + a next_cursor on a full page', async () => {
  const res = await buildHandler({
    getCallerUser: admin,
    loadEvents: loaderOf([ROW, ROW]),
  })(req('?limit=2'));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.events.length, 2);
  assertEquals(body.events[0].event_type, 'circuit.admin_controlled');
  assert(body.next_cursor !== null); // full page → more available
});

Deno.test('a partial page has no next_cursor', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadEvents: loaderOf([ROW]) })(
    req('?limit=50'),
  );
  const body = await res.json();
  assertEquals(body.next_cursor, null);
});

Deno.test('the parsed filter is forwarded to the loader', async () => {
  let seen: unknown = null;
  const res = await buildHandler({
    getCallerUser: admin,
    loadEvents: (f) => {
      seen = f;
      return Promise.resolve([]);
    },
  })(req('?event_type=circuit.admin_controlled&limit=10'));
  assertEquals(res.status, 200);
  assertEquals((seen as { eventType: string }).eventType, 'circuit.admin_controlled');
  assertEquals((seen as { limit: number }).limit, 10);
});

Deno.test('a malformed uuid / timestamp filter → 422 (not 500)', async () => {
  for (const qs of ['?actor_user_id=notauuid', '?aggregate_id=xyz', '?from=garbage']) {
    const res = await buildHandler({ getCallerUser: admin, loadEvents: loaderOf([]) })(req(qs));
    assertEquals(res.status, 422, qs);
  }
});

Deno.test('a valid uuid filter passes validation → 200', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadEvents: loaderOf([]) })(
    req(`?actor_user_id=${EVT_ID}`),
  );
  assertEquals(res.status, 200);
});

Deno.test('OPTIONS → 204', async () => {
  const res = await buildHandler({ getCallerUser: admin, loadEvents: loaderOf([ROW]) })(
    req('', 'OPTIONS'),
  );
  assertEquals(res.status, 204);
  assert(res.headers.get('access-control-allow-methods')?.includes('GET'));
});
