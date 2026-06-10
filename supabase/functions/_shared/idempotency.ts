/**
 * idempotency.ts — deterministic-key idempotency guard.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * `withIdempotency()` consults a per-feature idempotency table (e.g.
 * `gmail_message_seen`, `invoice_dedup`) using `(keyField = keyValue)` and
 * skips the body if a row already exists. Otherwise it inserts the key and
 * runs the body. Implementations MUST use an upsert/ON CONFLICT pattern so
 * concurrent calls are racy-safe.
 *
 * STUB: signatures only — full implementation deferred.
 */

export type IdempotencyResult = {
  /** true if the body was skipped because the key was already present. */
  skipped: boolean;
  /** Optional human-readable reason (e.g. 'duplicate gmail message_id'). */
  reason?: string;
};

/**
 * @param table       Table name holding the dedup row (e.g. 'gmail_message_seen').
 * @param keyField    Column to match against `keyValue`.
 * @param keyValue    Caller-supplied deterministic key (hash of stable inputs).
 * @param body        Work to execute if the key is fresh.
 */
export function withIdempotency(
  _table: string,
  _keyField: string,
  _keyValue: string,
  _body: () => Promise<void>,
): Promise<IdempotencyResult> {
  return Promise.resolve({
    skipped: false,
    reason: 'stub: idempotency check not implemented',
  });
}
