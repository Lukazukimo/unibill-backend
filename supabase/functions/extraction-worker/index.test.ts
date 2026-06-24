/**
 * index.test.ts — T-418 worker loop. fakeClient (queue RPCs + chainable from())
 * mirrors sync-worker's harness; runExtraction/loadParsers/downloadPdf injected.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler, type ExtractionJob, type InvoiceRow } from './index.ts';
import { buildExtractedPayload, type ExtractionOutcome } from './payload.ts';
import type { OrchestrateInput } from './orchestrate.ts';

const NOW = Date.parse('2026-06-24T14:00:00.000Z');

type Scn = {
  messages?: Array<{ msg_id: number; read_ct: number; message: ExtractionJob }>;
  invoice?: InvoiceRow | null;
  claimRows?: Array<{ id: string }>;
  config?: Array<{ key: string; value: unknown }>;
};

function fakeClient(scn: Scn) {
  const cap = {
    deletes: [] as number[],
    setVts: [] as Record<string, unknown>[],
    toDlqs: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    invoiceUpdates: [] as Record<string, unknown>[],
    runInserts: [] as Record<string, unknown>[],
    runUpdates: [] as Record<string, unknown>[],
  };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      switch (name) {
        case 'queue_read':
          return Promise.resolve(settled(
            (scn.messages ?? []).map((m) => ({
              msg_id: m.msg_id,
              read_ct: m.read_ct,
              enqueued_at: 't',
              vt: 't',
              message: m.message,
            })),
          ));
        case 'queue_delete':
          cap.deletes.push(args.p_msg_id as number);
          return Promise.resolve(settled(true));
        case 'queue_set_vt':
          cap.setVts.push(args);
          return Promise.resolve(settled(null));
        case 'queue_to_dlq':
          cap.toDlqs.push(args);
          return Promise.resolve(settled(1));
        default:
          return Promise.resolve(settled(null));
      }
    },
    from(table: string) {
      if (table === 'app_settings') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () => c,
          in: () => Promise.resolve(settled(scn.config ?? [])),
        };
        return { select: () => c };
      }
      if (table === 'invoices') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve(settled(scn.invoice ?? null)) }),
          }),
          update: (patch: Record<string, unknown>) => {
            cap.invoiceUpdates.push(patch);
            const chain: Record<string, unknown> = {
              eq: () => chain,
              in: () => chain,
              select: () => Promise.resolve(settled(scn.claimRows ?? [{ id: 'inv1' }])),
              then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
                Promise.resolve(settled(null)).then(f, r),
            };
            return chain;
          },
        };
      }
      if (table === 'extraction_runs') {
        return {
          insert: (row: Record<string, unknown>) => {
            cap.runInserts.push(row);
            return { select: () => ({ single: () => Promise.resolve(settled({ id: 'run-1' })) }) };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              cap.runUpdates.push(patch);
              return Promise.resolve(settled(null));
            },
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

const INVOICE: InvoiceRow = {
  id: 'inv1',
  status: 'queued',
  storage_bucket: 'invoices',
  storage_path: 'h1/inv1.pdf',
  household_id: 'h1',
  source_sender: 'fatura@enel.com.br',
  source_subject: 'Sua fatura',
};

function outcome(over: Partial<ExtractionOutcome> = {}): ExtractionOutcome {
  const fields = {
    amount_cents: 12345,
    due_date: '2026-07-10',
    barcode: '8466',
    pix_payload: null,
    payee_name: null,
    payee_document: null,
    customer_name: null,
    customer_document: null,
    reference_period: null,
    installation_id: null,
    service_address: null,
    utility_key: 'enel-sp',
  };
  return {
    status: 'extracted',
    method: 'regex',
    confidence: 0.92,
    fields,
    payload: buildExtractedPayload({
      method: 'regex',
      rawText: 't',
      fields,
      confidenceFinal: 0.92,
    }),
    needsReviewReason: null,
    extractionError: null,
    ...over,
  };
}

function req() {
  return new Request('https://x/extraction-worker', { method: 'POST' });
}

function deps(scn: Scn, over: Record<string, unknown> = {}) {
  const f = fakeClient(scn);
  const captured = { runInputs: [] as OrchestrateInput[], downloads: [] as string[] };
  const base = {
    client: f.client,
    requireAuth: () => true,
    now: () => NOW,
    loadParsers: () => Promise.resolve([{ utility_key: 'enel-sp' }] as never),
    downloadPdf: (_c: unknown, bucket: string, path: string) => {
      captured.downloads.push(`${bucket}/${path}`);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
    runExtraction: (input: OrchestrateInput) => {
      captured.runInputs.push(input);
      return Promise.resolve(outcome());
    },
    ...over,
  };
  return { handler: buildHandler(base as never), cap: f.cap, captured };
}

const MSG = (over: Partial<ExtractionJob> = {}, read_ct = 1) => ({
  msg_id: 7,
  read_ct,
  message: { invoice_id: 'inv1', correlation_id: 'corr1', ...over },
});

Deno.test('queued invoice → extracted: persists, emits, ACKs, writes the run row', async () => {
  const { handler, cap, captured } = deps({ invoice: INVOICE, messages: [MSG()] });
  const res = await handler(req());
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { processed: 1, done: 1, dlq: 0, skipped: 0, retried: 0 });

  assertEquals(captured.downloads, ['invoices/h1/inv1.pdf']);
  assertEquals(captured.runInputs[0].matchContext.senderEmail, 'fatura@enel.com.br');
  // persist patch present (the one carrying extracted_payload)
  const persist = cap.invoiceUpdates.find((u) => 'extracted_payload' in u);
  assert(persist);
  assertEquals(persist!.status, 'extracted');
  assertEquals(persist!.amount_cents, 12345);
  // domain event + run row + ACK
  assertEquals((cap.events[0] as { event_type: string }).event_type, 'invoice.extracted');
  assertEquals(cap.runInserts.length, 1);
  const fin = cap.runUpdates.find((u) => u.method === 'regex');
  assertEquals(fin!.status, 'success');
  assertEquals(cap.deletes, [7]);
});

Deno.test('terminal invoice + !force → ACK + skip (no extraction)', async () => {
  const { handler, cap, captured } = deps({
    invoice: { ...INVOICE, status: 'extracted' },
    messages: [MSG()],
  });
  const res = await handler(req());
  assertEquals((await res.json()).skipped, 1);
  assertEquals(captured.runInputs.length, 0);
  assertEquals(cap.deletes, [7]);
});

Deno.test('force=true on a terminal invoice → re-extracts', async () => {
  const { handler, cap, captured } = deps({
    invoice: { ...INVOICE, status: 'extracted' },
    messages: [MSG({ force: true })],
  });
  const res = await handler(req());
  assertEquals((await res.json()).done, 1);
  assertEquals(captured.runInputs.length, 1);
  assertEquals(cap.deletes, [7]);
});

Deno.test('orphan message (invoice gone) → ACK + skip', async () => {
  const { handler, cap, captured } = deps({ invoice: null, messages: [MSG()] });
  const res = await handler(req());
  assertEquals((await res.json()).skipped, 1);
  assertEquals(captured.runInputs.length, 0);
  assertEquals(cap.deletes, [7]);
});

Deno.test('read_ct past the retry cap → DLQ + invoice failed + event', async () => {
  const { handler, cap } = deps({ invoice: INVOICE, messages: [MSG({}, 4)] });
  const res = await handler(req());
  assertEquals((await res.json()).dlq, 1);
  assertEquals(cap.toDlqs.length, 1);
  const failed = cap.invoiceUpdates.find((u) => u.extraction_error === 'max_retries_exceeded');
  assertEquals(failed!.status, 'failed');
  assertEquals((cap.events[0] as { event_type: string }).event_type, 'invoice.failed');
  assertEquals(cap.deletes.length, 0); // moved to DLQ, not plain-deleted
});

Deno.test('infra failure in the attempt → backoff (set_vt) + retry, no ACK', async () => {
  const { handler, cap } = deps({ invoice: INVOICE, messages: [MSG()] }, {
    runExtraction: () => Promise.reject(new Error('OCR exhausted')),
  });
  const res = await handler(req());
  assertEquals((await res.json()).retried, 1);
  assertEquals(cap.setVts.length, 1);
  assertEquals(cap.deletes.length, 0);
  // withRunRow recorded the failure
  assert(cap.runUpdates.some((u) => u.status === 'failed'));
});

Deno.test('needs_review outcome → ACK + invoice.needs_review event, run partial', async () => {
  const { handler, cap } = deps({ invoice: INVOICE, messages: [MSG()] }, {
    runExtraction: () =>
      Promise.resolve(outcome({ status: 'needs_review', needsReviewReason: 'ai_chain_open' })),
  });
  const res = await handler(req());
  assertEquals((await res.json()).done, 1);
  assertEquals((cap.events[0] as { event_type: string }).event_type, 'invoice.needs_review');
  const fin = cap.runUpdates.find((u) => u.method === 'regex');
  assertEquals(fin!.status, 'partial');
  assertEquals(cap.deletes, [7]);
});

Deno.test('claim loses the race (0 rows) & !force → ACK + skip', async () => {
  const { handler, cap, captured } = deps({
    invoice: INVOICE,
    claimRows: [],
    messages: [MSG()],
  });
  const res = await handler(req());
  assertEquals((await res.json()).skipped, 1);
  assertEquals(captured.runInputs.length, 0);
  assertEquals(cap.deletes, [7]);
});

Deno.test('auth: non-POST → 405, missing service role → 401', async () => {
  const { handler } = deps({ messages: [] });
  const get = await handler(new Request('https://x/extraction-worker', { method: 'GET' }));
  assertEquals(get.status, 405);

  const f = fakeClient({ messages: [] });
  const denied = buildHandler({ client: f.client, requireAuth: () => false, now: () => NOW });
  const res = await denied(req());
  assertEquals(res.status, 401);
});
