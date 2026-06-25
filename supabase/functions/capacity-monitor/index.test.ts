/**
 * index.test.ts — T-602 capacity-monitor handler. fakeClient (app_settings
 * config + update, capacity_snapshots insert, queue_send rpc, domain_events) +
 * injected measure/sendAdminEmail. Limits are 1000 so pct == bytes/10.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler } from './index.ts';
import type { CapacityMetrics } from './measure.ts';

type Scn = { ingestion?: boolean; adminEmail?: string };

function cfgRows(scn: Scn) {
  return [
    { key: 'capacity.db_limit_bytes', value: { v: 1000 } },
    { key: 'capacity.storage_limit_bytes', value: { v: 1000 } },
    { key: 'capacity.yellow_threshold_pct', value: { v: 70 } },
    { key: 'capacity.orange_threshold_pct', value: { v: 80 } },
    { key: 'capacity.red_threshold_pct', value: { v: 90 } },
    { key: 'capacity.target_pct', value: { v: 60 } },
    { key: 'features.ingestion_enabled', value: { v: scn.ingestion ?? true } },
    { key: 'notifications.admin_email', value: { v: scn.adminEmail ?? 'admin@x.com' } },
  ];
}

function fakeClient(scn: Scn) {
  const cap = {
    snapshots: [] as Record<string, unknown>[],
    sends: [] as Record<string, unknown>[],
    settingUpdates: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
  };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'queue_send') {
        cap.sends.push(args);
        return Promise.resolve(settled(cap.sends.length));
      }
      return Promise.resolve(settled(null));
    },
    from(table: string) {
      if (table === 'app_settings') {
        return {
          select: () => {
            const c: Record<string, unknown> = {
              eq: () => c,
              is: () => c,
              in: () => Promise.resolve(settled(cfgRows(scn))),
            };
            return c;
          },
          update: (patch: Record<string, unknown>) => {
            cap.settingUpdates.push(patch);
            const chain: Record<string, unknown> = {
              eq: () => chain,
              then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
                Promise.resolve(settled(null)).then(f, r),
            };
            return chain;
          },
        };
      }
      if (table === 'capacity_snapshots') {
        return {
          insert: (row: Record<string, unknown>) => {
            cap.snapshots.push(row);
            return Promise.resolve(settled(null));
          },
        };
      }
      if (table === 'domain_events') {
        return {
          insert: (row: Record<string, unknown>) => {
            cap.events.push(row);
            return Promise.resolve(settled(null));
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, cap };
}

const metrics = (db: number, storage: number): CapacityMetrics => ({
  db_bytes: db,
  db_per_table: {},
  storage_bytes: storage,
  storage_per_bucket: {},
  queue_depths: {},
});

function mk(scn: Scn, db: number, storage: number) {
  const f = fakeClient(scn);
  const emails: Array<{ to: string; subject: string }> = [];
  const handler = buildHandler({
    client: f.client,
    requireAuth: () => true,
    now: () => Date.parse('2026-06-25T12:00:00.000Z'),
    measure: () => Promise.resolve(metrics(db, storage)),
    sendAdminEmail: (to, subject) => {
      emails.push({ to, subject });
      return Promise.resolve();
    },
  });
  return { handler, cap: f.cap, emails };
}

const post = () => new Request('https://x/capacity-monitor', { method: 'POST' });
const evt = (cap: { events: Record<string, unknown>[] }, type: string) =>
  cap.events.find((e) => e.event_type === type);

Deno.test('green → snapshot written, no enqueue, no event, ingestion untouched', async () => {
  const { handler, cap } = mk({ ingestion: true }, 500, 400); // 50% / 40%
  const res = await handler(post());
  const body = await res.json();
  assertEquals(body.overall, 'green');
  assertEquals(cap.snapshots.length, 1);
  assertEquals(cap.snapshots[0].db_status, 'green');
  assertEquals(cap.sends.length, 0);
  assertEquals(cap.events.length, 0);
  assertEquals(cap.settingUpdates.length, 0);
});

Deno.test('orange (db 82%) → enqueues a db eviction, but does NOT pause ingestion', async () => {
  const { handler, cap } = mk({ ingestion: true }, 820, 400);
  const body = await (await handler(post())).json();
  assertEquals(body.db_status, 'orange');
  assertEquals(body.enqueued, 1);
  assertEquals(
    cap.sends[0].p_msg && (cap.sends[0].p_msg as Record<string, unknown>).resource_type,
    'db',
  );
  assertEquals(cap.events.length, 0); // not red
  assertEquals(body.ingestion_enabled, true);
});

Deno.test('cross to red (95%) → pause ingestion + threshold_crossed event + email + enqueue', async () => {
  const { handler, cap, emails } = mk({ ingestion: true, adminEmail: 'ops@x.com' }, 950, 400);
  const body = await (await handler(post())).json();
  assertEquals(body.overall, 'red');
  assertEquals(body.ingestion_enabled, false);
  // ingestion set false
  assertEquals((cap.settingUpdates[0].value as { v: boolean }).v, false);
  // event + email + enqueue
  assert(evt(cap, 'capacity.threshold_crossed'));
  assertEquals(emails.length, 1);
  assertEquals(emails[0].to, 'ops@x.com');
  assertEquals(cap.sends.length, 1);
});

Deno.test('recovered (80%) after red → resume ingestion + ingestion.resumed event, no email', async () => {
  const { handler, cap, emails } = mk({ ingestion: false }, 800, 400); // already paused, now 80%
  const body = await (await handler(post())).json();
  assertEquals(body.ingestion_enabled, true);
  assertEquals((cap.settingUpdates[0].value as { v: boolean }).v, true);
  assert(evt(cap, 'capacity.ingestion.resumed'));
  assertEquals(emails.length, 0);
});

Deno.test('red while ALREADY paused → idempotent: no re-event/re-email, still enqueues', async () => {
  const { handler, cap, emails } = mk({ ingestion: false }, 950, 400); // red, already paused
  const body = await (await handler(post())).json();
  assertEquals(body.ingestion_enabled, false);
  assertEquals(cap.events.length, 0); // no threshold_crossed (already paused), no resume (95% > 85%)
  assertEquals(emails.length, 0);
  assertEquals(cap.settingUpdates.length, 0);
  assertEquals(cap.sends.length, 1); // eviction still enqueued
});

Deno.test('auth: non-POST → 405; missing service role → 401', async () => {
  const { handler } = mk({}, 500, 400);
  assertEquals(
    (await handler(new Request('https://x/capacity-monitor', { method: 'GET' }))).status,
    405,
  );
  const f = fakeClient({});
  const denied = buildHandler({
    client: f.client,
    requireAuth: () => false,
    measure: () => Promise.resolve(metrics(500, 400)),
  });
  assertEquals((await denied(post())).status, 401);
});
