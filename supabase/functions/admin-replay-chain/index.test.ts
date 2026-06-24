/**
 * admin-replay-chain/index.test.ts — T-421. Fake client (queue_send rpc,
 * invoices scan + update, app_settings) + stubbed identity.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import type { CallerUser } from '../_shared/auth.ts';
import { buildHandler, parseChainName } from './index.ts';

const ADMIN: CallerUser = { id: 'u-admin', email: 'a@x.com', is_system_admin: true };
const USER: CallerUser = { id: 'u-1', email: 'u@x.com', is_system_admin: false };

type Scn = {
  rows?: Array<{ id: string }>;
  rate?: number; // ai.chain.replay_batch_rate_per_minute config value
};

function fakeClient(scn: Scn) {
  const cap = {
    sends: [] as Array<{ p_msg: Record<string, unknown>; p_delay: number }>,
    updates: [] as Array<Record<string, unknown>>,
    reasonFilter: [] as string[],
  };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'queue_send') {
        cap.sends.push({
          p_msg: args.p_msg as Record<string, unknown>,
          p_delay: args.p_delay as number,
        });
        return Promise.resolve(settled(cap.sends.length));
      }
      return Promise.resolve(settled(null));
    },
    from(table: string) {
      if (table === 'app_settings') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () => c,
          in: () =>
            Promise.resolve(settled(
              scn.rate === undefined
                ? []
                : [{ key: 'ai.chain.replay_batch_rate_per_minute', value: { v: scn.rate } }],
            )),
        };
        return { select: () => c };
      }
      if (table === 'invoices') {
        return {
          select: () => ({
            eq: (_col: string, val: string) => {
              cap.reasonFilter.push(val);
              return { is: () => Promise.resolve(settled(scn.rows ?? [])) };
            },
          }),
          update: (patch: Record<string, unknown>) => {
            cap.updates.push(patch);
            return { eq: () => Promise.resolve(settled(null)) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, cap };
}

function post(body?: unknown) {
  return new Request('https://x/admin/replay-chain', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function mk(scn: Scn, caller: CallerUser | null = ADMIN) {
  const f = fakeClient(scn);
  return {
    handler: buildHandler({ client: f.client, getCallerUser: () => Promise.resolve(caller) }),
    cap: f.cap,
  };
}

Deno.test('parseChainName: accepts ai_chain/ocr_chain, rejects junk', () => {
  assertEquals(parseChainName({ chain_name: 'ai_chain' }), 'ai_chain');
  assertEquals(parseChainName({ chain_name: 'ocr_chain' }), 'ocr_chain');
  assertEquals(parseChainName({ chain_name: 'nope' }), null);
  assertEquals(parseChainName({}), null);
  assertEquals(parseChainName('ai_chain'), null);
});

Deno.test('admin replay: enqueues force:true, clears reason, paces by rate', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `inv${i}` }));
  const { handler, cap } = mk({ rows, rate: 10 });
  const res = await handler(post({ chain_name: 'ai_chain' }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { chain_name: 'ai_chain', replayed: 25, rate_per_minute: 10 });
  // queried the right parked reason
  assertEquals(cap.reasonFilter[0], 'ai_chain_open');
  // all enqueued with force:true, reason cleared for each
  assertEquals(cap.sends.length, 25);
  assertEquals(cap.updates.length, 25);
  assertEquals(cap.sends[0].p_msg.force, true);
  assertEquals(cap.updates[0].needs_review_reason, null);
  // pacing: batches of 10 → delays 0, 60, 120
  assertEquals(cap.sends[0].p_delay, 0);
  assertEquals(cap.sends[9].p_delay, 0);
  assertEquals(cap.sends[10].p_delay, 60);
  assertEquals(cap.sends[20].p_delay, 120);
});

Deno.test('ocr_chain maps to the ocr_chain_open parked reason', async () => {
  const { handler, cap } = mk({ rows: [{ id: 'inv0' }], rate: 10 });
  await handler(post({ chain_name: 'ocr_chain' }));
  assertEquals(cap.reasonFilter[0], 'ocr_chain_open');
});

Deno.test('no eligible invoices → replayed 0, no sends', async () => {
  const { handler, cap } = mk({ rows: [], rate: 10 });
  const res = await handler(post({ chain_name: 'ai_chain' }));
  assertEquals((await res.json()).replayed, 0);
  assertEquals(cap.sends.length, 0);
});

Deno.test('missing config → default rate 10', async () => {
  const { handler } = mk({ rows: [{ id: 'inv0' }] }); // no rate
  const res = await handler(post({ chain_name: 'ai_chain' }));
  assertEquals((await res.json()).rate_per_minute, 10);
});

Deno.test('non-admin → 403, no sends', async () => {
  const { handler, cap } = mk({ rows: [{ id: 'inv0' }] }, USER);
  assertEquals((await handler(post({ chain_name: 'ai_chain' }))).status, 403);
  assertEquals(cap.sends.length, 0);
});

Deno.test('missing JWT → 401; invalid chain_name → 422; non-POST → 405', async () => {
  assertEquals((await mk({}, null).handler(post({ chain_name: 'ai_chain' }))).status, 401);
  assertEquals((await mk({}).handler(post({ chain_name: 'bogus' }))).status, 422);
  assertEquals(
    (await mk({}).handler(new Request('https://x/admin/replay-chain', { method: 'GET' }))).status,
    405,
  );
});
