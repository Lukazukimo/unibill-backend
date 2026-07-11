/**
 * _test_utils.ts — shared fixtures and helpers for `*_shared/**.test.ts`.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * STUB: minimal helpers to prove the deno test wiring works. Expand in
 * later tasks as middlewares gain real implementations.
 */

/** Deterministic UUID v4 — useful for snapshot-style assertions. */
export const FIXED_UUID = '00000000-0000-4000-8000-00000000abcd';

/** Builds a minimal `Request` object for handler tests. */
export function makeRequest(
  url = 'https://example.test/fn',
  init?: RequestInit,
): Request {
  return new Request(url, init);
}

/** Asserts that a value is a UUID-shaped string (loose check). */
export function assertIsUuid(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`expected UUID, got: ${String(value)}`);
  }
}

/**
 * Forcibly narrow `T | null | undefined` to `T` for test assertions.
 *
 * Use after `let captured: T | null = null` is mutated inside a closure
 * (emitEvent/fetchFn/etc), where TS's control-flow analysis keeps the
 * declared union and `assert(captured !== null)` cannot narrow because the
 * closure mutation is opaque to TS. A plain `as NonNullable<typeof v>` cast
 * also fails — at the cast site TS uses the narrowed-to-null type and
 * `NonNullable<null>` collapses to `never`.
 *
 * The function signature `(v: T | null | undefined) => T` forces TS to drop
 * the null/undefined branches regardless of narrowing state.
 *
 * Throws at runtime if the value is null/undefined.
 */
export function nonNull<T>(v: T | null | undefined, msg = 'expected non-null'): T {
  if (v === null || v === undefined) {
    throw new Error(msg);
  }
  return v;
}

export type FakeRateLimitRow = {
  resource_type: string;
  resource_key: string;
  window_start: string;
  window_size: string;
  count: number;
};

/**
 * In-memory stand-in for the atomic `app.rate_limit_consume` rpc used by the
 * function fakes: increments the matching bucket by `p_amount` (default 1),
 * creating it when absent, and returns `{ data: newCount }` — mirroring the real
 * INSERT .. ON CONFLICT DO UPDATE count+amount RETURNING count. Buckets are
 * matched on (resource_type, resource_key, window_start); a single test never
 * mixes window sizes, and the peek/select paths key on the same three columns.
 */
export function fakeRateLimitConsume(
  rows: FakeRateLimitRow[],
  args: Record<string, unknown>,
): { data: number; error: null } {
  const amount = (args.p_amount as number | undefined) ?? 1;
  const existing = rows.find(
    (r) =>
      r.resource_type === args.p_resource_type &&
      r.resource_key === args.p_resource_key &&
      r.window_start === args.p_window_start,
  );
  if (existing) {
    existing.count += amount;
    return { data: existing.count, error: null };
  }
  const created: FakeRateLimitRow = {
    resource_type: args.p_resource_type as string,
    resource_key: args.p_resource_key as string,
    window_start: args.p_window_start as string,
    window_size: args.p_window_size as string,
    count: amount,
  };
  rows.push(created);
  return { data: created.count, error: null };
}
