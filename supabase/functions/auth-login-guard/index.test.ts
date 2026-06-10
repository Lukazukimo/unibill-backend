/**
 * auth-login-guard tests — lockout math + window roll-over.
 *
 * Ref: T-204, spec §9.1 Lockout
 * Date: 2026-06-10
 *
 * These tests exercise the pure helpers from `_shared/lockout.ts` against a
 * mock `SupabaseClient`. The full handler in `index.ts` is integration-tested
 * once the Supabase test harness is wired (deferred — see plan T-226).
 *
 * Run via `deno task test` from repo root.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  BLOCK_WINDOW_MINUTES,
  checkLockout,
  clearLockout,
  FAIL_THRESHOLD,
  FAIL_WINDOW_MINUTES,
  floorToWindow,
  isWithinWindow,
  lockoutKey,
  recordFailure,
} from '../_shared/lockout.ts';

// ---------------------------------------------------------------------------
// In-memory mock of the `rate_limit_buckets` table.
// ---------------------------------------------------------------------------

type Row = {
  resource_type: string;
  resource_key: string;
  window_start: string;
  window_size: string;
  count: number;
};

class FakeRateLimitTable {
  rows: Row[] = [];

  reset() {
    this.rows = [];
  }

  upsert(row: Row) {
    const idx = this.rows.findIndex(
      (r) =>
        r.resource_type === row.resource_type &&
        r.resource_key === row.resource_key &&
        r.window_start === row.window_start &&
        r.window_size === row.window_size,
    );
    if (idx >= 0) this.rows[idx] = row;
    else this.rows.push(row);
  }

  deleteByKeys(resource_type: string, keys: string[]) {
    this.rows = this.rows.filter(
      (r) => !(r.resource_type === resource_type && keys.includes(r.resource_key)),
    );
  }
}

/**
 * Builds a minimal stand-in for SupabaseClient.from('rate_limit_buckets') that
 * supports the exact chain shapes used by `lockout.ts`. The handcrafted
 * builder is duck-typed against the real client API surface.
 */
// deno-lint-ignore no-explicit-any
function makeFakeClient(table: FakeRateLimitTable): any {
  return {
    from(_tableName: string) {
      // chain accumulators
      const filters: Array<(r: Row) => boolean> = [];
      let mode: 'select' | 'delete' | null = null;
      let pendingUpsert: Row | null = null;

      const builder = {
        select(_cols: string) {
          mode = 'select';
          return builder;
        },
        eq(col: keyof Row, val: unknown) {
          filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === val);
          return builder;
        },
        gte(col: keyof Row, val: unknown) {
          filters.push((r) =>
            String((r as unknown as Record<string, unknown>)[col as string]) >= String(val)
          );
          return builder;
        },
        in(col: keyof Row, vals: unknown[]) {
          filters.push((r) =>
            vals.includes((r as unknown as Record<string, unknown>)[col as string])
          );
          return builder;
        },
        // PromiseLike: terminal — resolve based on accumulated state
        maybeSingle() {
          const matches = table.rows.filter((r) => filters.every((f) => f(r)));
          if (matches.length === 0) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({ data: matches[0], error: null });
        },
        upsert(row: Row, _opts: unknown) {
          pendingUpsert = row;
          return {
            then: (resolve: (v: { data: null; error: null }) => unknown) => {
              if (pendingUpsert) table.upsert(pendingUpsert);
              return resolve({ data: null, error: null });
            },
          };
        },
        delete() {
          mode = 'delete';
          return builder;
        },
        then(resolve: (v: { data: null; error: null }) => unknown) {
          if (mode === 'delete') {
            const resourceTypeFilter = filters.find((_f) => true);
            void resourceTypeFilter;
            // execute delete-by-filter: collect resource_type from rows still matching
            const survivors = table.rows.filter((r) => !filters.every((f) => f(r)));
            const removed = table.rows.length - survivors.length;
            table.rows = survivors;
            void removed;
          }
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test('lockoutKey lowercases + trims the email', () => {
  assertEquals(lockoutKey('  Foo@Bar.COM ', 'fail'), 'fail:foo@bar.com');
  assertEquals(lockoutKey('a@b.io', 'block'), 'block:a@b.io');
});

Deno.test('floorToWindow truncates to the bucket boundary', () => {
  const t = new Date('2026-06-10T12:47:33.000Z');
  const floored30 = floorToWindow(t, 30);
  // 12:47 → previous 30-min boundary is 12:30
  assertEquals(floored30.toISOString(), '2026-06-10T12:30:00.000Z');

  const floored60 = floorToWindow(t, 60);
  assertEquals(floored60.toISOString(), '2026-06-10T12:00:00.000Z');
});

Deno.test('isWithinWindow respects the boundary', () => {
  const now = new Date('2026-06-10T13:00:00.000Z');
  const t29 = new Date(now.getTime() - 29 * 60_000);
  const t31 = new Date(now.getTime() - 31 * 60_000);

  assert(isWithinWindow(now, t29, FAIL_WINDOW_MINUTES), '29min ago must be inside 30-min window');
  assert(!isWithinWindow(now, t31, FAIL_WINDOW_MINUTES), '31min ago must be outside 30-min window');
});

Deno.test('threshold constant is 10 per spec §9.1', () => {
  assertEquals(FAIL_THRESHOLD, 10);
  assertEquals(FAIL_WINDOW_MINUTES, 30);
  assertEquals(BLOCK_WINDOW_MINUTES, 60);
});

// ---------------------------------------------------------------------------
// Stateful flow — uses the fake table
// ---------------------------------------------------------------------------

Deno.test('recordFailure: 9 attempts do not trip; the 10th does', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const now = new Date('2026-06-10T10:00:00.000Z');
  const email = 'victim@example.com';

  for (let i = 1; i <= 9; i++) {
    const r = await recordFailure(email, now, client);
    assertEquals(r.fail_count, i, `attempt #${i} count`);
    assertEquals(r.threshold_crossed, false, `attempt #${i} should not trip`);
  }

  const tenth = await recordFailure(email, now, client);
  assertEquals(tenth.fail_count, 10);
  assertEquals(tenth.threshold_crossed, true);

  // a block bucket must now exist
  const hasBlockRow = table.rows.some(
    (r) => r.resource_key === lockoutKey(email, 'block'),
  );
  assert(hasBlockRow, 'block bucket must be created on threshold crossing');
});

Deno.test('checkLockout: returns blocked after threshold crossed', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const now = new Date('2026-06-10T10:00:00.000Z');
  const email = 'victim@example.com';

  for (let i = 0; i < FAIL_THRESHOLD; i++) {
    await recordFailure(email, now, client);
  }

  const status = await checkLockout(email, now, client);
  assertEquals(status.kind, 'blocked');
  if (status.kind === 'blocked') {
    // block window is 60min — retry_after must be > 0 and <= 60min
    assert(status.retry_after_seconds > 0);
    assert(status.retry_after_seconds <= 60 * 60);
  }
});

Deno.test('window roll-over: a 31-min-later attempt starts a fresh counter', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const t0 = new Date('2026-06-10T10:00:00.000Z');
  const email = 'victim@example.com';

  // 9 failures in the first 30-min window (does not trip)
  for (let i = 0; i < 9; i++) await recordFailure(email, t0, client);

  // jump 31 minutes — past the 30-min window boundary
  const t31 = new Date(t0.getTime() + 31 * 60_000);

  // From the new window's perspective the counter must be zero, so the
  // first failure here returns fail_count=1, not 10.
  const first = await recordFailure(email, t31, client);
  assertEquals(first.fail_count, 1);
  assertEquals(first.threshold_crossed, false);
});

Deno.test('window roll-over: a 29-min-later attempt stays in the same bucket', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);

  // Align t0 on a 30-min boundary so t0+29min stays inside the same bucket.
  const t0 = new Date('2026-06-10T10:00:00.000Z');
  const email = 'victim@example.com';

  for (let i = 0; i < 9; i++) await recordFailure(email, t0, client);

  const t29 = new Date(t0.getTime() + 29 * 60_000);
  const next = await recordFailure(email, t29, client);

  // Same window → counter must reach 10 and trip the block
  assertEquals(next.fail_count, 10);
  assertEquals(next.threshold_crossed, true);
});

Deno.test('clearLockout removes both fail and block buckets', async () => {
  const table = new FakeRateLimitTable();
  const client = makeFakeClient(table);
  const now = new Date('2026-06-10T10:00:00.000Z');
  const email = 'victim@example.com';

  for (let i = 0; i < FAIL_THRESHOLD; i++) await recordFailure(email, now, client);
  assert(table.rows.length >= 2, 'should have fail + block rows');

  await clearLockout(email, client);

  const stillHasLockoutRows = table.rows.some(
    (r) =>
      r.resource_key === lockoutKey(email, 'fail') ||
      r.resource_key === lockoutKey(email, 'block'),
  );
  assert(!stillHasLockoutRows, 'clearLockout must delete both buckets');
});
