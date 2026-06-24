/**
 * layer2_orchestrator.ts — Layer 2 (OCR) orchestration with per-page early-exit.
 *
 * Ref:  T-410, spec §7.3 (OCR early-exit, ocr_max_pages)
 * Date: 2026-06-24
 *
 * Splits the PDF (capped at ocr_max_pages), OCRs pages one at a time through the
 * OcrClient chain, and AFTER each page runs Layer 3 over the accumulated text —
 * stopping as soon as the required fields are captured (layer3Confidence === 1)
 * so we don't pay for OCR on later pages. All collaborators are injected.
 */

import { createPdfSplitter, DEFAULT_MAX_PAGES, type PdfPageSplitter } from './pdf_split.ts';
import {
  applyParser,
  type Layer3Result,
  selectParser,
  type UtilityParser,
} from './layer3_regex.ts';
import type { OcrClient } from '../../_shared/ocr/ocr_client.ts';
import type { CallContext } from '../../_shared/ocr/types.ts';

export interface Layer2Result {
  /** All OCR'd pages joined by '\n'. */
  ocrText: string;
  perPageText: string[];
  /** Mean per-page OCR confidence over the processed pages, 2dp ∈ [0,1]. */
  ocrConfidence: number;
  /** Pages actually OCR'd (≤ cap; fewer when early-exit fires). */
  pagesProcessed: number;
  totalPages: number;
  /** Best Layer-3 match found (set once a parser matches; null if none). */
  layer3: Layer3Result | null;
  /** True when a parser captured all required fields → OCR stopped early. */
  earlyExit: boolean;
}

export interface Layer2Deps {
  ocrClient: OcrClient;
  /** Candidate parsers, in priority order (utility_parsers rows). */
  parsers: UtilityParser[];
  /** Email signals for selectParser (sender is the primary match key). */
  matchContext?: { senderEmail?: string; subject?: string };
  /** OCR page cap (extraction.ocr_max_pages). Defaults to 4. */
  maxPages?: number;
  /** Splitter factory override (default createPdfSplitter from pdf_split.ts). */
  createSplitter?: (bytes: Uint8Array) => Promise<PdfPageSplitter>;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export async function runLayer2(
  pdfBytes: Uint8Array,
  ctx: Omit<CallContext, 'page'>,
  deps: Layer2Deps,
): Promise<Layer2Result> {
  const splitter = await (deps.createSplitter ?? createPdfSplitter)(pdfBytes);
  const cap = Math.min(
    splitter.pageCount,
    Math.max(1, Math.floor(deps.maxPages ?? DEFAULT_MAX_PAGES)),
  );
  const match = deps.matchContext ?? {};

  const perPageText: string[] = [];
  const confidences: number[] = [];
  let layer3: Layer3Result | null = null;
  let earlyExit = false;

  for (let page = 1; page <= cap; page++) {
    const pageBytes = await splitter.extractPage(page);
    // Propagates NoProviderAvailableError if the whole chain is down for a page.
    const result = await deps.ocrClient.ocrPage(pageBytes, { ...ctx, page });
    perPageText.push(result.text);
    confidences.push(result.confidence);

    // Early-exit: run Layer 3 on the accumulated OCR text after each page.
    const accumulated = perPageText.join('\n');
    const parser = selectParser(deps.parsers, { ...match, bodyText: accumulated });
    if (parser) {
      const l3 = applyParser(parser, accumulated);
      layer3 = l3; // keep the best-so-far even if still incomplete
      if (l3.layer3Confidence >= 1) {
        earlyExit = true;
        break;
      }
    }
  }

  const ocrConfidence = confidences.length === 0
    ? 0
    : round2(confidences.reduce((a, b) => a + b, 0) / confidences.length);

  return {
    ocrText: perPageText.join('\n'),
    perPageText,
    ocrConfidence,
    pagesProcessed: perPageText.length,
    totalPages: splitter.pageCount,
    layer3,
    earlyExit,
  };
}
