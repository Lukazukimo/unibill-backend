/**
 * integration.test.ts — T-424 (#72). End-to-end extraction-worker.
 *
 * Drives buildHandler with the REAL cascade (orchestrate → real pdfjs Layer 1 +
 * real regex Layer 3 + real confidence + real persist/queue/event handling). The
 * only fakes are the OCR + AI provider clients (no keys/network) and the DB
 * client (a captured in-memory double). PDFs are generated in-process with
 * pdf-lib — no committed .pdf fixtures. Covers the spec §7 / T-424 scenarios:
 * text-rich→regex/extracted, scanned→ocr_api, ai_chain_open→needs_review (ACK),
 * AI fallback, force re-extract, infra failure→backoff, and the run row + event.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler, type ExtractionJob, type InvoiceRow } from './index.ts';
import { orchestrate, type OrchestrateInput } from './orchestrate.ts';
import type { UtilityParser } from './layers/layer3_regex.ts';
import type { AiCallContext, AiExtractResult } from '../_shared/ai/types.ts';
import type { CallContext, OcrResult } from '../_shared/ocr/types.ts';
import type { OcrClient } from '../_shared/ocr/ocr_client.ts';
import { ChainOpenError, NoProviderAvailableError } from '../_shared/errors.ts';
import type { ExtractedPayloadV1 } from './payload.ts';

const NOW = Date.parse('2026-06-24T15:00:00.000Z');

// --- a real enel-sp parser whose regexes match the generated invoice text ---
const ENEL_PARSER = {
  utility_key: 'enel-sp',
  default_category: 'electricity',
  sender_patterns: ['enel'],
  subject_patterns: null,
  body_must_contain: null,
  amount_regex: 'Valor a pagar ([0-9.,]+)',
  due_date_regex: 'Vencimento ([0-9]{2}/[0-9]{2}/[0-9]{4})',
  due_date_format: 'DD/MM/YYYY',
  barcode_regex: 'Cod barras ([0-9]+)',
  pix_regex: null,
  reference_regex: null,
  installation_regex: null,
  customer_name_regex: null,
  service_address_regex: null,
} as unknown as UtilityParser;

const ENEL_LINE =
  'Enel Distribuicao SP Vencimento 15/06/2026 Valor a pagar 234,56 Cod barras 34191790010104351004791020';

/** Generate a real PDF with pdf-lib; each entry is one page's text. */
async function makePdf(pageTexts: string[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('npm:pdf-lib@1.17.1');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pageTexts) {
    const page = doc.addPage([600, 800]);
    let y = 760;
    for (const line of t.split('\n')) {
      page.drawText(line, { x: 20, y, size: 10, font });
      y -= 14;
    }
  }
  return await doc.save();
}

const textRichPdf = () => makePdf([Array(10).fill(ENEL_LINE).join('\n')]);
const scannedPdf = () => makePdf(['.']); // near-empty → needsOcr

function fakeOcr(text: string, confidence = 0.9): OcrClient {
  return {
    chain: ['ocr_space'],
    ocrPage: (_b: Uint8Array, _c: CallContext): Promise<OcrResult> =>
      Promise.resolve({ text, confidence }),
  } as unknown as OcrClient;
}

function fakeAi(impl: (t: string, c: AiCallContext) => Promise<AiExtractResult>) {
  const state = { calls: 0 };
  return {
    state,
    client: {
      extractStructured: (t: string, c: AiCallContext) => {
        state.calls++;
        return impl(t, c);
      },
    },
  };
}

const AI_NEVER = fakeAi(() => Promise.reject(new Error('AI should not be called')));
const OCR_NEVER = fakeOcr('OCR should not be called', 0);

type Scn = {
  invoice: InvoiceRow;
  pdf: Uint8Array;
  ocr?: OcrClient;
  ai?: { extractStructured: (t: string, c: AiCallContext) => Promise<AiExtractResult> };
  job?: Partial<ExtractionJob>;
  read_ct?: number;
};

function fakeClient(invoice: InvoiceRow | null, job: ExtractionJob) {
  const cap = {
    deletes: [] as number[],
    setVts: [] as Record<string, unknown>[],
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
          return Promise.resolve(settled([{
            msg_id: 1,
            read_ct: 1,
            enqueued_at: 't',
            vt: 't',
            message: job,
          }]));
        case 'queue_delete':
          cap.deletes.push(args.p_msg_id as number);
          return Promise.resolve(settled(true));
        case 'queue_set_vt':
          cap.setVts.push(args);
          return Promise.resolve(settled(null));
        default:
          return Promise.resolve(settled(null));
      }
    },
    from(table: string) {
      if (table === 'app_settings') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () => c,
          in: () => Promise.resolve(settled([])),
        };
        return { select: () => c };
      }
      if (table === 'invoices') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(settled(invoice)) }) }),
          update: (patch: Record<string, unknown>) => {
            cap.invoiceUpdates.push(patch);
            const chain: Record<string, unknown> = {
              eq: () => chain,
              in: () => chain,
              select: () => Promise.resolve(settled([{ id: invoice?.id ?? 'inv1' }])),
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
  source_subject: 'Sua fatura Enel',
};

async function runWorker(scn: Scn) {
  const job: ExtractionJob = { invoice_id: 'inv1', correlation_id: 'corr1', ...scn.job };
  const f = fakeClient(scn.invoice, job);
  const ocr = scn.ocr ?? OCR_NEVER;
  const ai = scn.ai ?? AI_NEVER.client;
  const handler = buildHandler({
    client: f.client,
    requireAuth: () => true,
    now: () => NOW,
    loadParsers: () => Promise.resolve([ENEL_PARSER]),
    downloadPdf: () => Promise.resolve(scn.pdf),
    // REAL cascade — only the OCR/AI provider clients are fakes.
    runExtraction: (input: OrchestrateInput) =>
      orchestrate(input, { ocrClient: ocr, aiClient: ai }),
  });
  const res = await handler(new Request('https://x/extraction-worker', { method: 'POST' }));
  return { res, cap: f.cap, body: await res.json() };
}

function persisted(cap: { invoiceUpdates: Record<string, unknown>[] }) {
  return cap.invoiceUpdates.find((u) => 'extracted_payload' in u)!;
}

Deno.test('e2e: text-rich PDF + enel parser → extracted/regex (no OCR, no AI)', async () => {
  const { cap, body } = await runWorker({ invoice: INVOICE, pdf: await textRichPdf() });
  assertEquals(body.done, 1);
  const u = persisted(cap);
  assertEquals(u.status, 'extracted');
  assertEquals(u.extraction_method, 'regex');
  assert((u.extraction_confidence as number) >= 0.85, `conf=${u.extraction_confidence}`);
  assertEquals(u.amount_cents, 23456);
  assertEquals(u.due_date, '2026-06-15');
  assertEquals(u.utility_key, 'enel-sp');
  // payload: layer1 + layer3 present, no layer2/layer4
  const pl = u.extracted_payload as ExtractedPayloadV1;
  assert(pl.data.layer1 && pl.data.layer3?.matched);
  assertEquals(pl.data.layer2, null);
  assertEquals(pl.data.layer4, null);
  // run row + event + ACK
  assertEquals(cap.runInserts.length, 1);
  assertEquals(cap.runUpdates.find((r) => r.method === 'regex')!.status, 'success');
  assertEquals((cap.events[0] as { event_type: string }).event_type, 'invoice.extracted');
  assertEquals(cap.deletes, [1]);
});

Deno.test('e2e: scanned PDF → OCR runs, regex on OCR text → ocr_api/extracted', async () => {
  const { cap, body } = await runWorker({
    invoice: INVOICE,
    pdf: await scannedPdf(),
    ocr: fakeOcr(ENEL_LINE, 0.9),
  });
  assertEquals(body.done, 1);
  const u = persisted(cap);
  assertEquals(u.extraction_method, 'ocr_api');
  assertEquals(u.status, 'extracted'); // 1.0*0.7 + 0.9*0.3 = 0.97
  const pl = u.extracted_payload as ExtractedPayloadV1;
  assert(pl.data.layer2?.applied);
  assertEquals(pl.data.layer4, null);
  assertEquals(cap.deletes, [1]);
});

Deno.test('e2e: ai_chain_open → needs_review (reason ai_chain_open) + ACK', async () => {
  const ai = fakeAi(() => Promise.reject(new ChainOpenError('extraction_default')));
  const { cap, body } = await runWorker({
    invoice: { ...INVOICE, source_sender: 'billing@unknown-utility.com' }, // no parser match
    pdf: await textRichPdf(),
    ai: ai.client,
  });
  assertEquals(body.done, 1);
  const u = persisted(cap);
  assertEquals(u.status, 'needs_review');
  assertEquals(u.needs_review_reason, 'ai_chain_open');
  assertEquals((cap.events[0] as { event_type: string }).event_type, 'invoice.needs_review');
  assertEquals(cap.deletes, [1]); // ACKed (recoverable, not retried)
  assertEquals(ai.state.calls, 1);
});

Deno.test('e2e: regex misses → AI fallback succeeds → ai_fallback/extracted', async () => {
  const ai = fakeAi(() =>
    Promise.resolve({
      fields: { amount_cents: 9900, due_date: '2026-08-01', barcode: '123' },
      selfReported: 0.9,
    })
  );
  const { cap, body } = await runWorker({
    invoice: { ...INVOICE, source_sender: 'billing@unknown-utility.com' },
    pdf: await textRichPdf(),
    ai: ai.client,
  });
  assertEquals(body.done, 1);
  const u = persisted(cap);
  assertEquals(u.extraction_method, 'ai_fallback');
  assertEquals(u.amount_cents, 9900);
  assert((u.extraction_confidence as number) >= 0.85);
  assertEquals(ai.state.calls, 1);
});

Deno.test('e2e: force=true re-extracts an already-extracted invoice', async () => {
  const { cap, body } = await runWorker({
    invoice: { ...INVOICE, status: 'extracted' },
    pdf: await textRichPdf(),
    job: { force: true },
  });
  assertEquals(body.done, 1);
  assertEquals(persisted(cap).status, 'extracted');
  assertEquals(cap.deletes, [1]);
});

Deno.test('e2e: infra failure (AI all-providers-fail) → backoff (set_vt), no ACK', async () => {
  const ai = fakeAi(() =>
    Promise.reject(new NoProviderAvailableError(['gemini', 'groq'], new Error('down')))
  );
  const { cap, body } = await runWorker({
    invoice: { ...INVOICE, source_sender: 'billing@unknown-utility.com' },
    pdf: await textRichPdf(),
    ai: ai.client,
  });
  assertEquals(body.retried, 1);
  assertEquals(cap.setVts.length, 1);
  assertEquals(cap.deletes.length, 0);
  assert(cap.runUpdates.some((r) => r.status === 'failed'));
});
