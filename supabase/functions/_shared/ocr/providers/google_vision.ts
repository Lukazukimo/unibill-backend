/**
 * ocr/providers/google_vision.ts — OcrProvider for Google Cloud Vision.
 *
 * Ref:  T-408, spec §7.3 (Google Vision fallback) + §B (extraction.google_vision.*)
 * Date: 2026-06-24
 *
 * Fallback OCR provider (free tier ~30/day) — used after OCR.space in the chain.
 * PURE-ish/DI: endpoint config + decrypted api key + fetch injected; no DB/vault/
 * network in unit tests. The api key is sent via the `X-goog-api-key` header
 * (never in the URL / logged).
 *
 * CAVEAT (deploy-smoke T-419): `images:annotate` expects image bytes. For a true
 * PDF page, real Vision needs `files:annotate` (mimeType application/pdf) or a
 * PDF→image rasterization step. We send the page bytes base64 as `image.content`
 * (the seeded endpoint's shape) and parse `fullTextAnnotation`; the request/parse
 * logic is unit-tested with a DI-fake, but the real-Vision PDF path must be
 * verified by the deploy smoke test. OCR.space (the primary provider) accepts PDF
 * directly, so the chain still functions if this provider 4xx's on real PDFs.
 */

import { encodeBase64 } from 'jsr:@std/encoding@^1.0.0/base64';
import type { CallContext, OcrProvider, OcrResult } from '../types.ts';
import { OcrHttpError, OcrInvalidResponseError } from '../classify_error.ts';
import { redactSecrets } from '../../redact.ts';

export const GOOGLE_VISION_NAME = 'google_vision' as const;

export interface GoogleVisionConfig {
  endpoint: string;
  languageHints: string[];
  feature: string; // e.g. 'DOCUMENT_TEXT_DETECTION'
  timeoutMs: number;
}

export interface GoogleVisionDeps {
  fetch: typeof fetch;
  apiKey: string;
}

function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Build the images:annotate request body for a single page. */
export function buildGoogleVisionRequest(
  pdfPage: Uint8Array,
  cfg: GoogleVisionConfig,
): Record<string, unknown> {
  return {
    requests: [
      {
        image: { content: encodeBase64(pdfPage) },
        features: [{ type: cfg.feature, model: 'builtin/latest' }],
        imageContext: { languageHints: cfg.languageHints },
      },
    ],
  };
}

/** Average block confidence across the annotation → [0,1]; 0 when absent. */
export function googleVisionConfidence(json: unknown): number {
  // deno-lint-ignore no-explicit-any
  const fta = (json as any)?.responses?.[0]?.fullTextAnnotation;
  const pages = fta?.pages;
  if (!Array.isArray(pages)) return 0;
  const confs: number[] = [];
  for (const p of pages) {
    const c = Number(p?.confidence);
    if (Number.isFinite(c) && c > 0) confs.push(c);
  }
  if (confs.length === 0) return 0;
  const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
  return avg < 0 ? 0 : avg > 1 ? 1 : avg;
}

/** Parse a Vision 2xx body → OcrResult, or throw (classified downstream). */
export function parseGoogleVisionResponse(json: unknown): OcrResult {
  // deno-lint-ignore no-explicit-any
  const resp = (json as any)?.responses?.[0];
  if (!resp) {
    throw new OcrInvalidResponseError('Google Vision: missing responses[0]');
  }
  // Vision reports per-request errors with HTTP 200 + responses[0].error.
  if (resp.error) {
    const m = redactSecrets(truncate(String(resp.error?.message ?? 'Vision request error')));
    throw new Error(`Google Vision error: ${m}`);
  }
  const text: string = resp.fullTextAnnotation?.text ?? '';
  return { text: text.trim(), confidence: googleVisionConfidence(json), raw: json };
}

export function createGoogleVisionProvider(
  cfg: GoogleVisionConfig,
  deps: GoogleVisionDeps,
): OcrProvider {
  return {
    name: GOOGLE_VISION_NAME,
    async ocrPdfPage(pdfPage: Uint8Array, _ctx: CallContext): Promise<OcrResult> {
      const body = buildGoogleVisionRequest(pdfPage, cfg);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const res = await deps.fetch(cfg.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': deps.apiKey,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          let snippet = '';
          try {
            snippet = redactSecrets(truncate(await res.text()));
          } catch { /* ignore */ }
          throw new OcrHttpError(res.status, `Google Vision HTTP ${res.status}`, snippet);
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new OcrInvalidResponseError('Google Vision: response was not valid JSON');
        }
        return parseGoogleVisionResponse(json);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
