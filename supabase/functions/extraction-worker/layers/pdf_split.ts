/**
 * pdf_split.ts — splits a multi-page PDF into per-page single-page PDFs for the
 * OCR layer (Layer 2).
 *
 * Ref:  T-405, spec §7.3 (OCR early-exit + extraction.ocr_max_pages)
 * Date: 2026-06-23
 *
 * PURE (no DB / network) — pdf-lib is the only dependency, used for PDF surgery.
 * The OCR page cap is INJECTED by the caller (never read from config here).
 *
 *   - createPdfSplitter(bytes)      → parse once; extractPage(n) on demand,
 *                                     memoized. The canonical API for the OCR
 *                                     loop's page-by-page early-exit (T-410).
 *   - extractPdfPage(bytes, n)      → the spec's literal one-shot signature
 *                                     (re-parses; convenience).
 *   - splitPdfPages(bytes, {maxPages}) → batch: the first up-to-maxPages pages
 *                                     + a truncation signal (OCR cost guard).
 */

import { PDFDocument } from 'npm:pdf-lib@1.17.1';
import { isPdfMagic } from '../../_shared/pdf.ts';
import { PageNotFoundError } from '../../_shared/errors.ts';

/** Mirrors spec §B + seed extraction.ocr_max_pages. Not read from config here. */
export const DEFAULT_MAX_PAGES = 4;

export interface SplitOptions {
  /** Cap on pages emitted by splitPdfPages. Default 4; floored, min 1. */
  maxPages?: number;
}

export type SplitTruncation = 'complete' | 'truncated';

export interface SplitResult {
  /** One valid single-page PDF per emitted page, in source order. */
  pages: Uint8Array[];
  /** Total pages in the SOURCE PDF (before capping). */
  totalPages: number;
  /** 'truncated' when totalPages > pages.length; else 'complete'. */
  truncation: SplitTruncation;
}

/** A memoized per-page accessor for the OCR early-exit loop. */
export interface PdfPageSplitter {
  /** Total pages in the source document (parsed once). */
  readonly pageCount: number;
  /**
   * Single-page PDF bytes for 1-based `pageNum`. Memoized.
   * @throws PageNotFoundError when pageNum is not an integer in [1, pageCount].
   */
  extractPage(pageNum: number): Promise<Uint8Array>;
}

async function loadSource(pdfBuffer: Uint8Array): Promise<PDFDocument> {
  if (!isPdfMagic(pdfBuffer)) {
    throw new Error('pdf_split: not a PDF (bad %PDF magic)');
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  } catch (err) {
    throw new Error(`pdf_split: failed to parse PDF: ${(err as Error).message}`);
  }
  if (doc.getPageCount() === 0) {
    throw new Error('pdf_split: PDF has no pages');
  }
  return doc;
}

async function buildSinglePage(src: PDFDocument, index0: number): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [index0]);
  out.addPage(copied);
  // Conservative: no object streams → broadly accepted by downstream OCR APIs.
  return await out.save({ useObjectStreams: false });
}

/** Parse `pdfBuffer` ONCE → a memoized per-page splitter. */
export async function createPdfSplitter(
  pdfBuffer: Uint8Array,
): Promise<PdfPageSplitter> {
  const src = await loadSource(pdfBuffer);
  const pageCount = src.getPageCount();
  const cache = new Map<number, Uint8Array>();

  return {
    pageCount,
    async extractPage(pageNum: number): Promise<Uint8Array> {
      if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pageCount) {
        throw new PageNotFoundError(pageNum, pageCount);
      }
      const hit = cache.get(pageNum);
      if (hit) return hit;
      const bytes = await buildSinglePage(src, pageNum - 1);
      cache.set(pageNum, bytes);
      return bytes;
    },
  };
}

/** One-shot single-page extraction (re-parses the source each call). */
export async function extractPdfPage(
  pdfBuffer: Uint8Array,
  pageNum: number,
): Promise<Uint8Array> {
  const splitter = await createPdfSplitter(pdfBuffer);
  return await splitter.extractPage(pageNum);
}

/** Batch: the first up-to-maxPages single-page PDFs + a truncation signal. */
export async function splitPdfPages(
  pdfBuffer: Uint8Array,
  opts?: SplitOptions,
): Promise<SplitResult> {
  const splitter = await createPdfSplitter(pdfBuffer);
  const totalPages = splitter.pageCount;
  const cap = Math.max(1, Math.floor(opts?.maxPages ?? DEFAULT_MAX_PAGES));
  const emit = Math.min(totalPages, cap);
  const pages: Uint8Array[] = [];
  for (let n = 1; n <= emit; n++) {
    pages.push(await splitter.extractPage(n));
  }
  return {
    pages,
    totalPages,
    truncation: totalPages > emit ? 'truncated' : 'complete',
  };
}
