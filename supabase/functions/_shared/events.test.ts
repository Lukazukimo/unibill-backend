import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { nonNull } from './_test_utils.ts';
import { type DomainEventInput, emitDomainEvent } from './events.ts';

function fakeClient(insertError: { message: string } | null = null) {
  const captured: { table: string | null; row: Record<string, unknown> | null } = {
    table: null,
    row: null,
  };
  const client = {
    from(table: string) {
      captured.table = table;
      return {
        insert(row: Record<string, unknown>) {
          captured.row = row;
          return Promise.resolve({ data: null, error: insertError });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, captured };
}

const baseEvent: DomainEventInput = {
  type: 'invoice.created',
  aggregate_type: 'invoice',
  aggregate_id: '11111111-1111-4111-8111-111111111111',
  correlation_id: '22222222-2222-4222-8222-222222222222',
  actor_type: 'worker',
  payload: { version: 3, data: { sender: 'enel' } },
};

Deno.test('emitDomainEvent inserts a mapped row into domain_events', async () => {
  const { client, captured } = fakeClient();
  await emitDomainEvent(baseEvent, { client });
  assertEquals(captured.table, 'domain_events');
  const row = nonNull(captured.row);
  assertEquals(row.event_type, 'invoice.created');
  assertEquals(row.event_version, 3); // mapped from payload.version (not a hardcoded 1)
  assertEquals(row.aggregate_type, 'invoice');
  assertEquals(row.aggregate_id, baseEvent.aggregate_id);
  assertEquals(row.actor_type, 'worker');
  assertEquals(row.payload, { version: 3, data: { sender: 'enel' } });
});

Deno.test('emitDomainEvent passes through causation_id, household_id, actor_user_id', async () => {
  const { client, captured } = fakeClient();
  await emitDomainEvent({
    ...baseEvent,
    household_id: '99999999-9999-4999-8999-999999999999',
    causation_id: '88888888-8888-4888-8888-888888888888',
    actor_user_id: '77777777-7777-4777-8777-777777777777',
  }, { client });
  const row = nonNull(captured.row);
  assertEquals(row.household_id, '99999999-9999-4999-8999-999999999999');
  assertEquals(row.causation_id, '88888888-8888-4888-8888-888888888888');
  assertEquals(row.actor_user_id, '77777777-7777-4777-8777-777777777777');
});

Deno.test('emitDomainEvent redacts secrets embedded in payload.data', async () => {
  const { client, captured } = fakeClient();
  await emitDomainEvent({
    ...baseEvent,
    type: 'email.sync.dead_lettered',
    payload: { version: 1, data: { error: 'imap auth failed pwqprsltuvwxabcd' } },
  }, { client });
  const row = nonNull(captured.row);
  const payload = row.payload as { data: { error: string } };
  assert(payload.data.error.includes('[REDACTED_APP_PASSWORD]'));
  assert(!payload.data.error.includes('pwqprsltuvwxabcd'));
});

Deno.test('emitDomainEvent rejects a non-positive-integer payload.version', async () => {
  const { client } = fakeClient();
  for (const bad of [0, 1.5, -1]) {
    let threw = false;
    try {
      await emitDomainEvent({ ...baseEvent, payload: { version: bad, data: {} } }, { client });
    } catch {
      threw = true;
    }
    assert(threw, `version ${bad} should be rejected`);
  }
});

Deno.test('emitDomainEvent maps absent optional fields to null', async () => {
  const { client, captured } = fakeClient();
  await emitDomainEvent({
    type: 'email.sync.auto_paused',
    aggregate_type: 'connected_email',
    aggregate_id: '33333333-3333-4333-8333-333333333333',
    actor_type: 'system',
    payload: { version: 1, data: {} },
  }, { client });
  const row = nonNull(captured.row);
  assertEquals(row.household_id, null);
  assertEquals(row.correlation_id, null);
  assertEquals(row.causation_id, null);
  assertEquals(row.actor_user_id, null);
});

Deno.test('emitDomainEvent throws when payload.version is not a number', async () => {
  const { client } = fakeClient();
  const bad = { ...baseEvent, payload: { data: {} } } as unknown as DomainEventInput;
  let threw = false;
  try {
    await emitDomainEvent(bad, { client });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test('emitDomainEvent throws when the insert returns an error', async () => {
  const { client } = fakeClient({ message: 'boom' });
  let threw = false;
  try {
    await emitDomainEvent(baseEvent, { client });
  } catch (e) {
    threw = e instanceof Error;
  }
  assert(threw);
});
