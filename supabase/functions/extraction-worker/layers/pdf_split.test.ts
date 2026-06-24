/**
 * pdf_split.test.ts — T-405. PDFs are generated in-process with pd-lib and the
 * split output is re-parsed with pdfjs to confirm each emitted page is a valid
 * single-page PDF carrying the right text. Run: deno test --allow-all.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { isPdfMagic } from '../../_shared/pdf.ts';
import { PageNotFoundError } from '../../_shared/errors.ts';
import {
  createPdfSplitter,
  DEFAULT_MAX_PAGES,
  extractPdfPage,
  splitPdfPages,
} from './pdf_split.ts';

async function makePdf(pageTexts: string[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('npm:pdf-lib@1.17.1');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pageTexts) {
    const page = doc.addPage([300, 400]);
    page.drawText(t, { x: 20, y: 350, size: 14, font });
  }
  return await doc.save();
}

/** Re-parse a (single-page) PDF and return per-page concatenated text. */
async function pdfjsPageTexts(b: Uint8Array): Promise<string[]> {
  // deno-lint-ignore no-explicit-any
  const pdfjs: any = await import('npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: b, useSystemFonts: true }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    // deno-lint-ignore no-explicit-any
    out.push(tc.items.map((it: any) => it.str).join(' '));
  }
  return out;
}

Deno.test('splitPdfPages: a 3-page PDF → 3 single-page PDFs in order', async () => {
  const pdf = await makePdf(['PAGEA', 'PAGEB', 'PAGEC']);
  const r = await splitPdfPages(pdf);
  assertEquals(r.pages.length, 3);
  assertEquals(r.totalPages, 3);
  assertEquals(r.truncation, 'complete');
  for (const p of r.pages) assert(isPdfMagic(p), 'each page is a valid PDF');
  assertEquals((await pdfjsPageTexts(r.pages[0]))[0], 'PAGEA');
  assertEquals((await pdfjsPageTexts(r.pages[2]))[0], 'PAGEC');
  // each emitted PDF has exactly one page
  assertEquals((await pdfjsPageTexts(r.pages[1])).length, 1);
});

Deno.test('splitPdfPages caps at maxPages and signals truncation', async () => {
  const pdf = await makePdf(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  const r = await splitPdfPages(pdf, { maxPages: 4 });
  assertEquals(r.pages.length, 4);
  assertEquals(r.totalPages, 6);
  assertEquals(r.truncation, 'truncated');
});

Deno.test('splitPdfPages default cap is DEFAULT_MAX_PAGES (4)', async () => {
  const pdf = await makePdf(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  const r = await splitPdfPages(pdf);
  assertEquals(r.pages.length, DEFAULT_MAX_PAGES);
  assertEquals(r.truncation, 'truncated');
});

Deno.test('splitPdfPages: a 1-page PDF → one page, complete', async () => {
  const pdf = await makePdf(['ONLY']);
  const r = await splitPdfPages(pdf);
  assertEquals(r.pages.length, 1);
  assertEquals(r.totalPages, 1);
  assertEquals(r.truncation, 'complete');
  assert(isPdfMagic(r.pages[0]));
});

Deno.test('extractPdfPage returns the requested page', async () => {
  const pdf = await makePdf(['X1', 'X2', 'X3']);
  const p2 = await extractPdfPage(pdf, 2);
  assertEquals((await pdfjsPageTexts(p2))[0], 'X2');
});

Deno.test('extractPdfPage throws PageNotFoundError out of range', async () => {
  const pdf = await makePdf(['A', 'B']);
  await assertRejects(() => extractPdfPage(pdf, 3), PageNotFoundError);
  await assertRejects(() => extractPdfPage(pdf, 0), PageNotFoundError);
  await assertRejects(() => extractPdfPage(pdf, 1.5), PageNotFoundError);
});

Deno.test('createPdfSplitter memoizes (same bytes returned per page)', async () => {
  const s = await createPdfSplitter(await makePdf(['A', 'B']));
  assertEquals(s.pageCount, 2);
  const a1 = await s.extractPage(1);
  const a2 = await s.extractPage(1);
  assert(a1 === a2, 'memoized: identical reference on the second call');
});

Deno.test('createPdfSplitter throws on a non-PDF (bad magic)', async () => {
  await assertRejects(
    () => createPdfSplitter(new TextEncoder().encode('hello not a pdf')),
    Error,
    'bad %PDF magic',
  );
});

Deno.test('createPdfSplitter throws on a corrupt PDF (magic ok, body garbage)', async () => {
  const corrupt = new TextEncoder().encode('%PDF-1.4\n%garbage that pdf-lib cannot parse %%EOF');
  await assertRejects(() => createPdfSplitter(corrupt), Error);
});
