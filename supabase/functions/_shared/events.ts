/**
 * events.ts — domain event emission helper.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * `emitDomainEvent()` writes a row to `domain_events`. When called with a
 * `tx` (Supabase transaction handle), the insert participates in the caller's
 * transaction so state mutation + event publication are atomic. Without
 * `tx`, the helper opens its own connection.
 *
 * STUB: signatures only — full implementation deferred.
 */

// Loose type to avoid pulling in @supabase/supabase-js at stub stage.
export type SupabaseTx = unknown;

export type DomainActorType = 'user' | 'system' | 'worker';

export type DomainEventPayload = {
  /** Event schema version — bump on breaking changes. */
  version: number;
  // deno-lint-ignore no-explicit-any
  data: any;
};

export type DomainEventInput = {
  /** Event type, e.g. 'invoice.extracted', 'household.created'. */
  type: string;
  /** Logical aggregate root, e.g. 'invoice', 'household'. */
  aggregate_type: string;
  /** UUID of the aggregate instance. */
  aggregate_id: string;
  household_id?: string;
  correlation_id?: string;
  actor_type: DomainActorType;
  actor_user_id?: string;
  payload: DomainEventPayload;
};

/**
 * Inserts the event into `domain_events`.
 *
 * @param event Event payload (validated server-side via CHECK constraints).
 * @param tx    Optional active Supabase transaction.
 */
export function emitDomainEvent(
  _event: DomainEventInput,
  _tx?: SupabaseTx,
): Promise<void> {
  // STUB: no-op. Real impl will INSERT INTO domain_events ...
  return Promise.resolve();
}
