/**
 * events.ts — domain event emission helper.
 *
 * Ref: T-320, spec §5.6 (domain_events) / §4.2.1
 * Date: 2026-06-21 (replaces the T-125 stub)
 *
 * `emitDomainEvent()` appends a row to `public.domain_events` (lightweight
 * event sourcing). It maps the ergonomic `DomainEventInput` onto the table
 * columns and copies `payload.version` into the queryable `event_version`
 * column.
 *
 * Transactionality note: the Supabase JS client cannot run a multi-statement
 * transaction, so the *transactional outbox* path (INSERT invoice + pgmq.send
 * + INSERT domain_event atomically — spec §6.4) lives in an `app.*` SQL
 * function called via RPC (sync-worker, T-326). This helper is for the
 * single-INSERT, standalone events (e.g. `email.sync.auto_paused`,
 * `email.sync.dead_lettered`), which are atomic on their own.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { redactDeep } from './redact.ts';

export type DomainActorType = 'user' | 'system' | 'worker';

export type DomainEventPayload = {
  /** Event schema version — bump on breaking changes. Mirrored to `event_version`. */
  version: number;
  // deno-lint-ignore no-explicit-any
  data: any;
};

export type DomainEventInput = {
  /** Event type, e.g. 'invoice.created', 'email.sync.auto_paused'. */
  type: string;
  /** Logical aggregate root, e.g. 'invoice', 'connected_email'. */
  aggregate_type: string;
  /** UUID of the aggregate instance. */
  aggregate_id: string;
  /** Owning household; NULL for system-wide events. */
  household_id?: string;
  /** Trace id linking logs / runs / events for one request. */
  correlation_id?: string;
  /** The event id that caused this one (causation chain), if any. */
  causation_id?: string;
  actor_type: DomainActorType;
  /** uuid, no FK — may be a system_actors sentinel after anonymization. */
  actor_user_id?: string;
  payload: DomainEventPayload;
};

export type EmitDomainEventDeps = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
};

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Inserts `event` into `public.domain_events`. Throws on validation failure or
 * if the DB rejects the insert (callers decide whether to swallow at warn level
 * vs. unwind — see spec §4.2.1: event-emit failure never unwinds business
 * success, but the worker DOES surface a failed run row).
 */
export async function emitDomainEvent(
  event: DomainEventInput,
  deps?: EmitDomainEventDeps,
): Promise<void> {
  if (!Number.isInteger(event.payload?.version) || event.payload.version < 1) {
    throw new Error('emitDomainEvent: payload must be { version: positive integer, data }');
  }
  const client = deps?.client ?? buildServiceClient();
  // Redact string values in the payload before persisting — worker events
  // (dead-letter / auto-paused) embed upstream error strings in payload.data,
  // and `domain_events.payload` is a declared redactSecrets sink (§6.5).
  const safePayload = redactDeep(event.payload);
  const { error } = await client.from('domain_events').insert({
    event_type: event.type,
    event_version: event.payload.version,
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    household_id: event.household_id ?? null,
    correlation_id: event.correlation_id ?? null,
    causation_id: event.causation_id ?? null,
    payload: safePayload,
    actor_type: event.actor_type,
    actor_user_id: event.actor_user_id ?? null,
  });
  if (error) {
    throw new Error(`emitDomainEvent: insert failed: ${error.message}`);
  }
}
