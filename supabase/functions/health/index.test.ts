/**
 * health handler tests — CORS/method gates, the public vs authenticated payload
 * split, the status→HTTP-code mapping, and the gather-failure (db down) path.
 * The signal gathering is injected; classification logic lives in checks.test.ts.
 *
 * Ref: T-613 (#124), spec §11.4 / §E (GET /health).
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, type ExtendedDetail, type HandlerDeps } from './index.ts';
import type { HealthSignals } from './checks.ts';

const NOW = Date.UTC(2026, 5, 25, 12, 0, 0);

function okSignals(over: Partial<HealthSignals> = {}): HealthSignals {
  return {
    dbOk: true,
    lastSyncMinutesAgo: 5,
    capacityStatus: 'green',
    aiChainState: 'closed',
    aiChainOpenMinutes: null,
    ...over,
  };
}

function detail(over: Partial<ExtendedDetail> = {}): ExtendedDetail {
  return {
    db_ok: true,
    queue_depths: { invoice: 2, email: 1, dlq: 0 },
    ai_chain_state: 'closed',
    capacity_status: 'green',
    last_sync_run_minutes_ago: 5,
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
const fakeClient = {} as any;

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    client: fakeClient,
    gather: () => Promise.resolve({ signals: okSignals(), detail: detail() }),
    isServiceRole: () => false,
    now: () => NOW,
    ...over,
  };
}

function req(method = 'GET'): Request {
  return new Request('https://x.test/health', { method });
}

const DETAIL_KEYS = [
  'db_ok',
  'queue_depths',
  'ai_chain_state',
  'capacity_status',
  'last_sync_run_minutes_ago',
];

// --- gates ------------------------------------------------------------------

Deno.test('OPTIONS preflight → 204 with CORS headers', async () => {
  const res = await buildHandler(deps())(req('OPTIONS'));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
  await res.body?.cancel();
});

Deno.test('non-GET method → 405', async () => {
  const res = await buildHandler(deps())(req('POST'));
  assertEquals(res.status, 405);
});

// --- public payload ---------------------------------------------------------

Deno.test('public probe → 200 { status, timestamp } and NO internal metrics', async () => {
  const res = await buildHandler(deps({ isServiceRole: () => false }))(req());
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assertEquals(body.status, 'ok');
  assertEquals(body.timestamp, new Date(NOW).toISOString());
  for (const k of DETAIL_KEYS) {
    assert(!(k in body), `public payload must not expose '${k}'`);
  }
});

// --- authenticated payload --------------------------------------------------

Deno.test('service_role probe → extended payload with all 5 detail fields', async () => {
  const res = await buildHandler(deps({ isServiceRole: () => true }))(req());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, 'ok');
  for (const k of DETAIL_KEYS) {
    assert(k in body, `authenticated payload must expose '${k}'`);
  }
  assertEquals(body.queue_depths, { invoice: 2, email: 1, dlq: 0 });
  assertEquals(body.capacity_status, 'green');
});

// --- status → code mapping --------------------------------------------------

Deno.test('down signals → 503', async () => {
  const res = await buildHandler(deps({
    gather: () =>
      Promise.resolve({
        signals: okSignals({ capacityStatus: 'red' }),
        detail: detail({ capacity_status: 'red' }),
      }),
  }))(req());
  assertEquals(res.status, 503);
  assertEquals((await res.json()).status, 'down');
});

Deno.test('a gather failure is treated as db-down → 503', async () => {
  const res = await buildHandler(deps({
    gather: () => Promise.reject(new Error('connection refused')),
  }))(req());
  assertEquals(res.status, 503);
  assertEquals((await res.json()).status, 'down');
});
