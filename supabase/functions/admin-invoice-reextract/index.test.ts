/**
 * admin-invoice-reextract/index.test.ts — T-420. Fake client (rate_limit_consume
 * + queue_send rpc, invoices select, domain_events insert) + stubbed identity.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import type { CallerUser } from '../_shared/auth.ts';
import { buildHandler, extractInvoiceId, parseBody } from './index.ts';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ADMIN: CallerUser = { id: 'u-admin', email: 'a@x.com', is_system_admin: true };
const USER: CallerUser = { id: 'u-1', email: 'u@x.com', is_system_admin: false };

type Scn = {
  invoice?: { id: string; household_id: string | null } | null;
  rateCount?: number;
  msgId?: number;
};

function fakeClient(scn: Scn) {
  const cap = { sends: [] as Record<string, unknown>[], events: [] as Record<string, unknown>[] };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      switch (name) {
        case 'rate_limit_consume':
          return Promise.resolve(settled(scn.rateCount ?? 1));
        case 'queue_send':
          cap.sends.push(args);
          return Promise.resolve(settled(scn.msgId ?? 42));
        default:
          return Promise.resolve(settled(null));
      }
    },
    from(table: string) {
      if (table === 'invoices') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve(
                  settled(scn.invoice === undefined ? { id: ID, household_id: 'h1' } : scn.invoice),
                ),
            }),
          }),
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

function post(body?: unknown, path = `/admin/invoices/${ID}/reextract`) {
  return new Request(`https://x${path}`, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function mk(scn: Scn, caller: CallerUser | null = ADMIN) {
  const f = fakeClient(scn);
  const handler = buildHandler({
    client: f.client,
    getCallerUser: () => Promise.resolve(caller),
    emitEvent: (e) => {
      f.cap.events.push(e as unknown as Record<string, unknown>);
      return Promise.resolve();
    },
  });
  return { handler, cap: f.cap };
}

// --- pure helpers ---------------------------------------------------------

Deno.test('extractInvoiceId: path, function-prefix and ?id forms; rejects junk', () => {
  assertEquals(extractInvoiceId(new URL(`https://x/admin/invoices/${ID}/reextract`)), ID);
  assertEquals(
    extractInvoiceId(new URL(`https://x/functions/v1/admin-invoice-reextract/${ID}`)),
    ID,
  );
  assertEquals(extractInvoiceId(new URL(`https://x/admin-invoice-reextract?id=${ID}`)), ID);
  assertEquals(extractInvoiceId(new URL('https://x/admin/invoices/not-a-uuid/reextract')), null);
});

Deno.test('parseBody: defaults force=true, accepts boolean, rejects non-boolean', () => {
  assertEquals(parseBody(undefined), { ok: true, force: true });
  assertEquals(parseBody({}), { ok: true, force: true });
  assertEquals(parseBody({ force: false }), { ok: true, force: false });
  assertEquals(parseBody({ force: 'yes' }), { ok: false });
});

// --- handler --------------------------------------------------------------

Deno.test('admin happy path → 200, enqueues {invoice_id, force:true}, emits event', async () => {
  const { handler, cap } = mk({});
  const res = await handler(post());
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { queued: true, msg_id: 42 });
  assertEquals(cap.sends.length, 1);
  const msg = cap.sends[0].p_msg as Record<string, unknown>;
  assertEquals(msg.invoice_id, ID);
  assertEquals(msg.force, true);
  const ev = cap.events.find((e) => e.type === 'invoice.reextract_requested')!;
  assertEquals(ev.actor_user_id, 'u-admin');
});

Deno.test('force=false body is forwarded to the queue', async () => {
  const { handler, cap } = mk({});
  await handler(post({ force: false }));
  assertEquals((cap.sends[0].p_msg as Record<string, unknown>).force, false);
});

Deno.test('non-admin caller → 403, no enqueue', async () => {
  const { handler, cap } = mk({}, USER);
  const res = await handler(post());
  assertEquals(res.status, 403);
  assertEquals(cap.sends.length, 0);
});

Deno.test('missing JWT → 401', async () => {
  const { handler } = mk({}, null);
  assertEquals((await handler(post())).status, 401);
});

Deno.test('invoice not found → 404, no enqueue', async () => {
  const { handler, cap } = mk({ invoice: null });
  assertEquals((await handler(post())).status, 404);
  assertEquals(cap.sends.length, 0);
});

Deno.test('bad path → 404; non-POST → 405', async () => {
  const { handler } = mk({});
  assertEquals((await handler(post(undefined, '/admin/invoices/nope/reextract'))).status, 404);
  const get = await handler(
    new Request(`https://x/admin/invoices/${ID}/reextract`, { method: 'GET' }),
  );
  assertEquals(get.status, 405);
});

Deno.test('rate limit exhausted (count > 30) → 429, no enqueue', async () => {
  const { handler, cap } = mk({ rateCount: 31 });
  const res = await handler(post());
  assertEquals(res.status, 429);
  assertEquals(cap.sends.length, 0);
});

Deno.test('malformed JSON body → 400', async () => {
  const { handler } = mk({});
  const res = await handler(
    new Request(`https://x/admin/invoices/${ID}/reextract`, { method: 'POST', body: '{not json' }),
  );
  assertEquals(res.status, 400);
});

Deno.test('non-boolean force → 422', async () => {
  const { handler } = mk({});
  const res = await handler(post({ force: 'yes' }));
  assertEquals(res.status, 422);
});
