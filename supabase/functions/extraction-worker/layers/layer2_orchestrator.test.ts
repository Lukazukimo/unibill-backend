/**
 * layer2_orchestrator.test.ts — T-410. Fake OcrClient + fake splitter + the real
 * enel-sp parser regexes; asserts per-page early-exit.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { UtilityParser } from './layer3_regex.ts';
import type { PdfPageSplitter } from './pdf_split.ts';
import type { OcrClient } from '../../_shared/ocr/ocr_client.ts';
import type { CallContext, OcrResult } from '../../_shared/ocr/types.ts';
import { runLayer2 } from './layer2_orchestrator.ts';

const ENEL: UtilityParser = {
  utility_key: 'enel-sp',
  default_category: 'Luz',
  sender_patterns: ['enel\\.com'],
  subject_patterns: null,
  body_must_contain: ['Enel Distribuição São Paulo'],
  amount_regex: 'Valor a pagar[:\\s]+R\\$\\s*([0-9.,]+)',
  due_date_regex: 'Vencimento[:\\s]+(\\d{2}/\\d{2}/\\d{4})',
  due_date_format: 'DD/MM/YYYY',
  barcode_regex: '(\\d{5}\\.?\\d{5}\\s?\\d{5}\\.?\\d{6}\\s?\\d{5}\\.?\\d{6}\\s?\\d\\s?\\d{14})',
  pix_regex: '(00020126[0-9A-Za-z+/=]{50,})',
  reference_regex: null,
  installation_regex: null,
  customer_name_regex: null,
  service_address_regex: null,
};

const CTX: Omit<CallContext, 'page'> = {
  correlation_id: 'c1',
  invoice_id: 'i1',
  household_id: 'h1',
};

/** Fake splitter with a fixed page count. */
function fakeSplitter(pageCount: number): PdfPageSplitter {
  return {
    pageCount,
    extractPage: (n: number) => Promise.resolve(new Uint8Array([n])),
  };
}

/** Fake OcrClient that returns canned text per page and records which pages ran. */
function fakeOcrClient(
  pageTexts: string[],
  confidences: number[],
  ocrdPages: number[],
): OcrClient {
  return {
    chain: ['fake'],
    ocrPage: (_bytes: Uint8Array, ctx: CallContext): Promise<OcrResult> => {
      ocrdPages.push(ctx.page);
      return Promise.resolve({
        text: pageTexts[ctx.page - 1] ?? '',
        confidence: confidences[ctx.page - 1] ?? 0,
      });
    },
  };
}

Deno.test('early-exit: stops after the page that completes the required fields', async () => {
  const pages = [
    'Enel Distribuição São Paulo\nCliente: MARIA',
    'Vencimento: 15/06/2026\nValor a pagar: R$ 234,56\n' +
    'Linha digitável: 03399.12345 67890.123456 78901.234567 8 99990000023456',
    "PAGE 3 — should never be OCR'd",
  ];
  const ocrd: number[] = [];
  const r = await runLayer2(new Uint8Array([0]), CTX, {
    ocrClient: fakeOcrClient(pages, [0.8, 0.9, 0.5], ocrd),
    parsers: [ENEL],
    matchContext: { senderEmail: 'fatura@enel.com' },
    maxPages: 4,
    createSplitter: () => Promise.resolve(fakeSplitter(3)),
  });

  assertEquals(ocrd, [1, 2]); // page 3 never OCR'd
  assertEquals(r.pagesProcessed, 2);
  assert(r.earlyExit);
  assertEquals(r.layer3?.fields.amount_cents, 23456);
  assertEquals(r.layer3?.fields.due_date, '2026-06-15');
  assertEquals(r.layer3?.layer3Confidence, 1);
  assertEquals(r.ocrConfidence, 0.85); // (0.8+0.9)/2
  assertEquals(r.totalPages, 3);
});

Deno.test('no matching parser → OCRs all pages up to the cap, no early-exit', async () => {
  const pages = ['p1', 'p2', 'p3'];
  const ocrd: number[] = [];
  const r = await runLayer2(new Uint8Array([0]), CTX, {
    ocrClient: fakeOcrClient(pages, [0.5, 0.6, 0.7], ocrd),
    parsers: [ENEL],
    matchContext: { senderEmail: 'billing@vivo.com.br' }, // not an enel sender
    maxPages: 4,
    createSplitter: () => Promise.resolve(fakeSplitter(3)),
  });
  assertEquals(ocrd, [1, 2, 3]);
  assertEquals(r.pagesProcessed, 3);
  assert(!r.earlyExit);
  assertEquals(r.layer3, null);
  assertEquals(r.ocrConfidence, 0.6); // (0.5+0.6+0.7)/3
});

Deno.test('caps OCR at maxPages even without a match', async () => {
  const pages = ['a', 'b', 'c', 'd', 'e', 'f'];
  const ocrd: number[] = [];
  const r = await runLayer2(new Uint8Array([0]), CTX, {
    ocrClient: fakeOcrClient(pages, [1, 1, 1, 1, 1, 1], ocrd),
    parsers: [ENEL],
    matchContext: { senderEmail: 'x@vivo.com' },
    maxPages: 4,
    createSplitter: () => Promise.resolve(fakeSplitter(6)),
  });
  assertEquals(ocrd, [1, 2, 3, 4]); // capped
  assertEquals(r.pagesProcessed, 4);
  assertEquals(r.totalPages, 6);
});
