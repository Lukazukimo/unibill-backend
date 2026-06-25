/**
 * health/checks tests — the pure status matrix (§11.4) plus the small pure
 * transforms the handler feeds with DB rows. No I/O.
 *
 * Ref: T-613 (#124), spec §11.4 / §E (GET /health).
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  AI_CHAIN_DOWN_MINUTES,
  classifyHealth,
  type HealthSignals,
  minutesSince,
  reduceAiChain,
  summarizeQueueDepths,
  SYNC_STALE_MINUTES,
  worstCapacity,
} from './checks.ts';

const NOW = Date.UTC(2026, 5, 25, 12, 0, 0);
const minsAgoIso = (m: number) => new Date(NOW - m * 60_000).toISOString();

function signals(over: Partial<HealthSignals> = {}): HealthSignals {
  return {
    dbOk: true,
    lastSyncMinutesAgo: 5,
    capacityStatus: 'green',
    aiChainState: 'closed',
    aiChainOpenMinutes: null,
    ...over,
  };
}

// --- classifyHealth: the status matrix -------------------------------------

Deno.test('all checks healthy → ok / 200', () => {
  assertEquals(classifyHealth(signals()), { status: 'ok', code: 200 });
});

Deno.test('db unreachable → down / 503', () => {
  assertEquals(classifyHealth(signals({ dbOk: false })), { status: 'down', code: 503 });
});

Deno.test('capacity red → down / 503', () => {
  assertEquals(classifyHealth(signals({ capacityStatus: 'red' })), { status: 'down', code: 503 });
});

Deno.test('ai_chain open 30min (< 1h) → ok / 200', () => {
  assertEquals(
    classifyHealth(signals({ aiChainState: 'open', aiChainOpenMinutes: 30 })),
    { status: 'ok', code: 200 },
  );
});

Deno.test('ai_chain open 2h (> 1h) → down / 503', () => {
  assertEquals(
    classifyHealth(signals({ aiChainState: 'open', aiChainOpenMinutes: 120 })),
    { status: 'down', code: 503 },
  );
});

Deno.test('capacity orange → degraded / 200', () => {
  assertEquals(
    classifyHealth(signals({ capacityStatus: 'orange' })),
    { status: 'degraded', code: 200 },
  );
});

Deno.test('last sync older than 90min → degraded / 200', () => {
  assertEquals(
    classifyHealth(signals({ lastSyncMinutesAgo: 120 })),
    { status: 'degraded', code: 200 },
  );
});

Deno.test('down dominates degraded (red capacity AND stale sync) → down / 503', () => {
  assertEquals(
    classifyHealth(signals({ capacityStatus: 'red', lastSyncMinutesAgo: 200 })),
    { status: 'down', code: 503 },
  );
});

Deno.test('no data (null sync / null capacity) does not alarm → ok / 200', () => {
  assertEquals(
    classifyHealth(signals({ lastSyncMinutesAgo: null, capacityStatus: null })),
    { status: 'ok', code: 200 },
  );
});

Deno.test('threshold constants are 90min sync / 60min ai-chain', () => {
  assertEquals([SYNC_STALE_MINUTES, AI_CHAIN_DOWN_MINUTES], [90, 60]);
});

// --- worstCapacity ----------------------------------------------------------

Deno.test('worstCapacity picks the more severe of two statuses', () => {
  assertEquals(worstCapacity('green', 'orange'), 'orange');
  assertEquals(worstCapacity('red', 'yellow'), 'red');
  assertEquals(worstCapacity('yellow', 'green'), 'yellow');
});

// --- minutesSince -----------------------------------------------------------

Deno.test('minutesSince returns whole minutes since an ISO timestamp', () => {
  assertEquals(minutesSince(minsAgoIso(90), NOW), 90);
});

Deno.test('minutesSince returns null for null input', () => {
  assertEquals(minutesSince(null, NOW), null);
});

// --- summarizeQueueDepths ---------------------------------------------------

Deno.test('summarizeQueueDepths maps pgmq depths to invoice/email/dlq (dlq summed)', () => {
  const map = {
    invoice_queue: 3,
    email_sync_queue: 1,
    invoice_dlq: 2,
    email_sync_dlq: 4,
  };
  assertEquals(summarizeQueueDepths(map), { invoice: 3, email: 1, dlq: 6 });
});

Deno.test('summarizeQueueDepths defaults missing queues to 0', () => {
  assertEquals(summarizeQueueDepths({}), { invoice: 0, email: 0, dlq: 0 });
});

// --- reduceAiChain ----------------------------------------------------------

Deno.test('reduceAiChain with no breaker rows → closed, null open', () => {
  assertEquals(reduceAiChain([], NOW), { state: 'closed', openMinutes: null });
});

Deno.test('reduceAiChain with an open row → open + minutes since opened_at', () => {
  assertEquals(
    reduceAiChain([{ state: 'open', opened_at: minsAgoIso(75) }], NOW),
    { state: 'open', openMinutes: 75 },
  );
});

Deno.test('reduceAiChain takes the longest-open among multiple open rows', () => {
  assertEquals(
    reduceAiChain([
      { state: 'open', opened_at: minsAgoIso(20) },
      { state: 'open', opened_at: minsAgoIso(90) },
    ], NOW),
    { state: 'open', openMinutes: 90 },
  );
});

Deno.test('reduceAiChain reports half_open when none are open', () => {
  assertEquals(
    reduceAiChain([{ state: 'half_open', opened_at: null }], NOW),
    { state: 'half_open', openMinutes: null },
  );
});
