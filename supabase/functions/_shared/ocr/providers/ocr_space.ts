/**
 * ocr/providers/ocr_space.ts — OcrProvider for the OCR.space hosted API.
 *
 * Ref:  T-407, spec §7.3 (OCR.space, free tier) + §B (extraction.ocr_space.*)
 * Date: 2026-06-24
 *
 * PURE-ish: no DB, no config read, no vault read. The endpoint config + the
 * decrypted api key + fetch are INJECTED at construction (DI), so unit tests use
 * a fake fetch and never touch the network. The api key is sent in the `apikey`
 * HEADER (never form/body/URL) and never logged.
 */

import type { CallContext, OcrProvider, OcrResult } from '../types.ts';
import { OcrHttpError, OcrInvalidResponseError } from '../classify_error.ts';
import { redactSecrets } from '../../redact.ts';

export const OCR_SPACE_NAME = 'ocr_space' as const;

export interface OcrSpaceConfig {
  endpoint: string;
  language: string;
  engine: number;
  timeoutMs: number;
}

export interface OcrSpaceDeps {
  fetch: typeof fetch;
  apiKey: string;
}

function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Build the multipart form for an OCR.space request (key goes in the header). */
export function buildOcrSpaceForm(pdfPage: Uint8Array, cfg: OcrSpaceConfig): FormData {
  const form = new FormData();
  form.set('file', new Blob([pdfPage as BlobPart], { type: 'application/pdf' }), 'page.pdf');
  form.set('filetype', 'PDF');
  form.set('language', cfg.language);
  form.set('OCREngine', String(cfg.engine));
  form.set('isCreateSearchablePdf', 'false');
  form.set('scale', 'true');
  form.set('isOverlayRequired', 'true'); // needed for per-word confidence
  return form;
}

/** Average WordConfidence across the overlay → [0,1]; 0 when no overlay. */
export function ocrSpaceConfidence(json: unknown): number {
  // deno-lint-ignore no-explicit-any
  const results = (json as any)?.ParsedResults;
  if (!Array.isArray(results)) return 0;
  const confidences: number[] = [];
  for (const r of results) {
    const lines = r?.TextOverlay?.Lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      const words = line?.Words;
      if (!Array.isArray(words)) continue;
      for (const w of words) {
        const c = Number(w?.WordConfidence);
        if (Number.isFinite(c)) confidences.push(c);
      }
    }
  }
  if (confidences.length === 0) return 0;
  const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const norm = avg / 100;
  return norm < 0 ? 0 : norm > 1 ? 1 : norm;
}

/** Parse an OCR.space 2xx body → OcrResult, or throw (classified downstream). */
export function parseOcrSpaceResponse(json: unknown): OcrResult {
  // deno-lint-ignore no-explicit-any
  const j = json as any;
  if (j?.IsErroredOnProcessing === true) {
    const detail = Array.isArray(j?.ErrorMessage) ? j.ErrorMessage.join('; ') : j?.ErrorMessage;
    // A processing error reported by the API → 'error' (plain Error).
    throw new Error(
      redactSecrets(truncate(String(detail ?? j?.ErrorDetails ?? 'OCR.space processing error'))),
    );
  }
  const results = j?.ParsedResults;
  if (!Array.isArray(results) || results.length === 0) {
    // Unexpected shape → 'invalid_response'.
    throw new OcrInvalidResponseError('OCR.space: missing/empty ParsedResults');
  }
  const text = results
    .map((r: { ParsedText?: string }) => r?.ParsedText ?? '')
    .join('\n')
    .trim();
  return { text, confidence: ocrSpaceConfidence(json), raw: json };
}

export function createOcrSpaceProvider(
  cfg: OcrSpaceConfig,
  deps: OcrSpaceDeps,
): OcrProvider {
  return {
    name: OCR_SPACE_NAME,
    async ocrPdfPage(pdfPage: Uint8Array, _ctx: CallContext): Promise<OcrResult> {
      const form = buildOcrSpaceForm(pdfPage, cfg);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const res = await deps.fetch(cfg.endpoint, {
          method: 'POST',
          headers: { apikey: deps.apiKey },
          body: form,
          signal: ctrl.signal,
        });
        if (!res.ok) {
          let body = '';
          try {
            body = redactSecrets(truncate(await res.text()));
          } catch { /* ignore */ }
          throw new OcrHttpError(res.status, `OCR.space HTTP ${res.status}`, body);
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new OcrInvalidResponseError('OCR.space: response was not valid JSON');
        }
        return parseOcrSpaceResponse(json);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
