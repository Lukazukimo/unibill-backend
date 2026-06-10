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
