/**
 * layer1_pdfjs.ts — Layer 1 of the extraction pipeline: native PDF text via
 * pdfjs-dist (no OCR, no rendering, no external API).
 *
 * Ref:  T-404, spec §7.2 (Layer 1) + §B (extraction.layer1_*)
 * Date: 2026-06-23
 *
 * The pdfjs boundary is INJECTABLE (`Layer1Deps.adapter`) so the pure metric /
 * assessment logic is unit-testable without loading the ~5MB lib; the real
 * adapter lazily `import()`s pdfjs on first use. This module NEVER throws and
 * NEVER logs — an encrypted/corrupt PDF yields a zeroed `failed` result so the
 * orchestrator (T-418) escalates to Layer 2 OCR. Any caller that logs `text` /
 * `perPageText` MUST route it through redactSecrets first.
 *
 * "sufficient" (= Layer 1 is good enough, skip OCR) iff
 *   charCount >= extraction.layer1_min_chars (300) AND
 *   charDensity >= extraction.layer1_min_density (0.05), where
 *   charDensity = non-whitespace chars / PDF byteLength (spec §B: image-only
 *   PDFs have low density).
 */

import { type ConfigDeps, getGlobalConfig, readNumberConfig } from '../../_shared/config.ts';

export interface Layer1Result {
  /** Full document text, pages joined by '\n'. */
  text: string;
  /** Per-page extracted text (page i = perPageText[i-1]). */
  perPageText: string[];
  /** Pages pdfjs reported (0 if the doc failed to open). */
  pageCount: number;
  /** Total non-whitespace char count across all pages. */
  charCount: number;
  /** charCount / byteLength (0 when byteLength === 0), rounded to 4dp. */
  charDensity: number;
  /** Input PDF size in bytes. */
  byteLength: number;
  /** True when pdfjs threw (encrypted/corrupt) — result is the zeroed fallback. */
  failed: boolean;
}

export interface Layer1Thresholds {
  minChars: number; // extraction.layer1_min_chars   (default 300)
  minDensity: number; // extraction.layer1_min_density (default 0.05)
}

export const DEFAULT_LAYER1_THRESHOLDS: Layer1Thresholds = {
  minChars: 300,
  minDensity: 0.05,
};

export interface Layer1Assessment extends Layer1Result {
  /** charCount >= minChars AND charDensity >= minDensity (false if failed). */
  sufficient: boolean;
  /** Inverse of sufficient — the orchestrator escalates to OCR when true. */
  needsOcr: boolean;
}

/** Injectable pdfjs boundary so unit tests skip the heavy import. */
export interface PdfjsAdapter {
  /** Extract per-page text. MUST resolve (never reject) — errors → failed. */
  extract(pdfBytes: Uint8Array): Promise<PdfjsExtract>;
}

export interface PdfjsExtract {
  pageCount: number;
  perPageText: string[];
  failed: boolean;
}

export interface Layer1Deps {
  /** Defaults to the real lazy-loaded `pdfjsAdapter`. Tests inject a fake. */
  adapter?: PdfjsAdapter;
}

const LAYER1_CONFIG_KEYS = [
  'extraction.layer1_min_chars',
  'extraction.layer1_min_density',
] as const;

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function nonWhitespaceCount(s: string): number {
  return (s.match(/\S/gu) ?? []).length;
}

/** The real pdfjs adapter — lazily dynamic-imports pdfjs-dist on first call. */
export const pdfjsAdapter: PdfjsAdapter = {
  async extract(pdfBytes: Uint8Array): Promise<PdfjsExtract> {
    try {
      // deno-lint-ignore no-explicit-any
      const pdfjs: any = await import('npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({
        data: pdfBytes,
        useSystemFonts: true,
        // No Web Worker / canvas in the Edge runtime — text-only path.
        isEvalSupported: false,
      }).promise;
      const perPageText: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        // deno-lint-ignore no-explicit-any
        perPageText.push(tc.items.map((it: any) => it.str ?? '').join(' '));
      }
      return { pageCount: doc.numPages, perPageText, failed: false };
    } catch {
      // Encrypted / corrupt / unsupported → signal failure; the caller escalates.
      return { pageCount: 0, perPageText: [], failed: true };
    }
  },
};

/**
 * PURE: compute metrics from a PdfjsExtract + the input PDF size.
 * Takes `byteLength` as a number (NOT the Uint8Array) on purpose: pdfjs'
 * getDocument detaches the input buffer, so the caller must capture its length
 * BEFORE running the adapter (see extractTextWithPdfjs).
 */
export function metricsFromExtract(
  extract: PdfjsExtract,
  byteLength: number,
): Layer1Result {
  const text = extract.perPageText.join('\n');
  const charCount = nonWhitespaceCount(text);
  const charDensity = byteLength <= 0 ? 0 : round4(charCount / byteLength);
  return {
    text,
    perPageText: extract.perPageText,
    pageCount: extract.pageCount,
    charCount,
    charDensity,
    byteLength,
    failed: extract.failed,
  };
}

/** PURE: apply thresholds → sufficient / needsOcr. */
export function assessLayer1(
  result: Layer1Result,
  thresholds: Layer1Thresholds = DEFAULT_LAYER1_THRESHOLDS,
): Layer1Assessment {
  const sufficient = !result.failed &&
    result.charCount >= thresholds.minChars &&
    result.charDensity >= thresholds.minDensity;
  return { ...result, sufficient, needsOcr: !sufficient };
}

/** Run the (injected or real) adapter and build metrics. Never throws. */
export async function extractTextWithPdfjs(
  pdfBytes: Uint8Array,
  deps?: Layer1Deps,
): Promise<Layer1Result> {
  // Capture the size BEFORE the adapter runs: pdfjs' getDocument detaches the
  // input ArrayBuffer, leaving pdfBytes.byteLength === 0 afterwards.
  const byteLength = pdfBytes.byteLength;
  const adapter = deps?.adapter ?? pdfjsAdapter;
  let extract: PdfjsExtract;
  try {
    extract = await adapter.extract(pdfBytes);
  } catch {
    extract = { pageCount: 0, perPageText: [], failed: true };
  }
  return metricsFromExtract(extract, byteLength);
}

/** One-shot: extract + assess. Never throws. */
export async function runLayer1(
  pdfBytes: Uint8Array,
  thresholds: Layer1Thresholds = DEFAULT_LAYER1_THRESHOLDS,
  deps?: Layer1Deps,
): Promise<Layer1Assessment> {
  const result = await extractTextWithPdfjs(pdfBytes, deps);
  return assessLayer1(result, thresholds);
}

/** Config loader (DI), mirroring loadConfidenceThresholds. */
export async function loadLayer1Thresholds(
  deps?: ConfigDeps,
): Promise<Layer1Thresholds> {
  const cfg = await getGlobalConfig([...LAYER1_CONFIG_KEYS], deps);
  return {
    minChars: readNumberConfig(
      cfg,
      'extraction.layer1_min_chars',
      DEFAULT_LAYER1_THRESHOLDS.minChars,
    ),
    minDensity: readNumberConfig(
      cfg,
      'extraction.layer1_min_density',
      DEFAULT_LAYER1_THRESHOLDS.minDensity,
    ),
  };
}
