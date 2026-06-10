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
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`expected UUID, got: ${String(value)}`);
  }
}
