/**
 * layer1_pdfjs.test.ts — T-404.
 *
 * Pure metric/assessment + DI-fake adapter tests are fast and deterministic;
 * a handful of integration tests drive the REAL pdfjsAdapter against PDFs
 * generated in-process with pd-lib (no committed .pdf binaries).
 *
 * Run: deno test --allow-all (npm: deps cold-fetch + read on first run).
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import {
  assessLayer1,
  DEFAULT_LAYER1_THRESHOLDS,
  extractTextWithPdfjs,
  loadLayer1Thresholds,
  metricsFromExtract,
  type PdfjsAdapter,
  pdfjsAdapter,
  type PdfjsExtract,
  runLayer1,
} from './layer1_pdfjs.ts';

const bytes = (n: number) => new Uint8Array(n); // a buffer of a given byteLength

function fakeAdapter(extract: PdfjsExtract): PdfjsAdapter {
  return { extract: () => Promise.resolve(extract) };
}

/** Generate a PDF with pd-lib; each entry is one page's (multi-line) text. */
async function makePdf(pageTexts: string[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('npm:pdf-lib@1.17.1');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pageTexts) {
    const page = doc.addPage([400, 600]);
    let y = 560;
    for (const line of t.split('\n')) {
      page.drawText(line, { x: 20, y, size: 11, font });
      y -= 16;
    }
  }
  return await doc.save();
}

// -- Pure: metricsFromExtract --------------------------------------------------

Deno.test('metricsFromExtract counts non-whitespace chars + density chars/byte', () => {
  const r = metricsFromExtract({ pageCount: 1, perPageText: ['ab c'], failed: false }, 100);
  assertEquals(r.charCount, 3); // 'a','b','c' — the space is excluded
  assertEquals(r.charDensity, 0.03);
});

Deno.test('metricsFromExtract on byteLength 0 → density 0 (no NaN/Infinity)', () => {
  const r = metricsFromExtract({ pageCount: 0, perPageText: [], failed: false }, 0);
  assertEquals(r.charDensity, 0);
  assertEquals(r.charCount, 0);
});

Deno.test('metricsFromExtract joins pages with newline + sums chars', () => {
  const r = metricsFromExtract(
    { pageCount: 2, perPageText: ['aa', 'bbb'], failed: false },
    50,
  );
  assertEquals(r.text, 'aa\nbbb');
  assertEquals(r.charCount, 5);
  assertEquals(r.pageCount, 2);
});

// -- Pure: assessLayer1 --------------------------------------------------------

Deno.test('assessLayer1 sufficient exactly at the >= boundary', () => {
  const r = metricsFromExtract(
    { pageCount: 1, perPageText: ['x'.repeat(300)], failed: false },
    6000, // 300/6000 = 0.05 exactly
  );
  const a = assessLayer1(r); // defaults 300 / 0.05
  assertEquals(a.charCount, 300);
  assertEquals(a.charDensity, 0.05);
  assert(a.sufficient);
  assert(!a.needsOcr);
});

Deno.test('assessLayer1 not sufficient when only one threshold clears', () => {
  // enough chars but too sparse (low density)
  const sparse = metricsFromExtract(
    { pageCount: 1, perPageText: ['x'.repeat(300)], failed: false },
    100000,
  );
  assert(!assessLayer1(sparse).sufficient);
  // dense enough but too few chars
  const few = metricsFromExtract(
    { pageCount: 1, perPageText: ['x'.repeat(50)], failed: false },
    100,
  );
  assert(!assessLayer1(few).sufficient);
});

Deno.test('assessLayer1 on a failed result → not sufficient, needsOcr', () => {
  const r = metricsFromExtract({ pageCount: 0, perPageText: [], failed: true }, 9999);
  const a = assessLayer1(r);
  assert(!a.sufficient);
  assert(a.needsOcr);
});

// -- extractTextWithPdfjs (injected adapter) ----------------------------------

Deno.test('extractTextWithPdfjs uses the injected adapter', async () => {
  const r = await extractTextWithPdfjs(bytes(200), {
    adapter: fakeAdapter({ pageCount: 1, perPageText: ['hello world'], failed: false }),
  });
  assertEquals(r.text, 'hello world');
  assertEquals(r.charCount, 10);
  assertEquals(r.failed, false);
});

Deno.test('extractTextWithPdfjs swallows an adapter that rejects → failed zeroed result', async () => {
  const throwing: PdfjsAdapter = { extract: () => Promise.reject(new Error('boom')) };
  const r = await extractTextWithPdfjs(bytes(200), { adapter: throwing });
  assertEquals(r.failed, true);
  assertEquals(r.charCount, 0);
  assertEquals(r.pageCount, 0);
});

// -- loadLayer1Thresholds (config loader) -------------------------------------

function fakeClient(rows: Array<{ key: string; value: unknown }> | null) {
  const chain = {
    eq() {
      return chain;
    },
    is() {
      return chain;
    },
    in() {
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { from: () => ({ select: () => chain }) } as unknown as SupabaseClient;
}

Deno.test('loadLayer1Thresholds reads config, coerces strings, falls back', async () => {
  const t = await loadLayer1Thresholds({
    client: fakeClient([
      { key: 'extraction.layer1_min_chars', value: { v: '400' } }, // string coerced
      // layer1_min_density absent → default
    ]),
  });
  assertEquals(t.minChars, 400);
  assertEquals(t.minDensity, DEFAULT_LAYER1_THRESHOLDS.minDensity);

  const def = await loadLayer1Thresholds({ client: fakeClient([]) });
  assertEquals(def, DEFAULT_LAYER1_THRESHOLDS);
});

// -- Integration: the REAL pdfjs adapter against pd-lib-generated PDFs ---------

Deno.test('integration: a text-rich PDF is sufficient (real pdfjs)', async () => {
  const line = 'Enel Distribuicao Sao Paulo Vencimento 15/06/2026 Valor a pagar 234,56';
  const pdf = await makePdf([Array(8).fill(line).join('\n')]);
  const r = await runLayer1(pdf, DEFAULT_LAYER1_THRESHOLDS, { adapter: pdfjsAdapter });
  assertEquals(r.pageCount, 1);
  assert(r.charCount >= 300, `expected >=300 chars, got ${r.charCount}`);
  assert(r.sufficient, `expected sufficient (density ${r.charDensity})`);
  assert(r.text.includes('234,56'));
});

Deno.test('integration: a near-empty PDF is not sufficient (real pdfjs)', async () => {
  const pdf = await makePdf(['x']);
  const r = await runLayer1(pdf, DEFAULT_LAYER1_THRESHOLDS, { adapter: pdfjsAdapter });
  assert(!r.sufficient);
  assert(r.needsOcr);
});

Deno.test('integration: corrupt bytes → failed result, never throws (real pdfjs)', async () => {
  const corrupt = new TextEncoder().encode('%PDF-1.4\nnot really a pdf at all');
  const r = await extractTextWithPdfjs(corrupt, { adapter: pdfjsAdapter });
  assertEquals(r.failed, true);
  assertEquals(r.charCount, 0);
});

Deno.test('integration: a 2-page PDF reports 2 pages (real pdfjs)', async () => {
  const pdf = await makePdf(['PAGE ONE alpha', 'PAGE TWO beta gamma']);
  const r = await extractTextWithPdfjs(pdf, { adapter: pdfjsAdapter });
  assertEquals(r.pageCount, 2);
  assertEquals(r.perPageText.length, 2);
  assert(r.text.includes('alpha') && r.text.includes('beta'));
});
