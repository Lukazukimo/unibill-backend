/**
 * ocr/types.ts — shared contract for the Layer 2 OCR providers.
 *
 * Ref:  T-406, spec §7.3 (OCR layer) + §7.5.1 (call status vocabulary)
 * Date: 2026-06-24
 *
 * No runtime logic except OCR_PROVIDER_NAMES, so this imports cleanly into pure
 * code. Providers are built by a factory (create*Provider(cfg, deps)) that bakes
 * in the endpoint config + the decrypted api key + an injected fetch; the
 * resulting OcrProvider just OCRs single-page PDF bytes. Per-call logging to
 * ai_calls, the circuit breaker, rate limiting and the chain live in T-409.
 */

export type OcrProviderName = 'ocr_space' | 'google_vision';

export const OCR_PROVIDER_NAMES: readonly OcrProviderName[] = [
  'ocr_space',
  'google_vision',
] as const;

/**
 * The full ai_calls.status domain (DB CHECK chk_ai_calls_status). Shared by the
 * provider classifier (T-406) and the OcrClient logger (T-409). 'success' is the
 * non-throwing path; the rest are failure classifications.
 */
export type OcrCallStatus =
  | 'success'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'timeout'
  | 'error'
  | 'invalid_response'
  | 'circuit_open';

/** Per-call routing/logging context. `page` is 1-based. */
export interface CallContext {
  correlation_id: string;
  invoice_id: string | null;
  household_id: string | null;
  page: number;
}

/** One provider OCR call result. `confidence` is in [0,1] and REQUIRED (§7.3). */
export interface OcrResult {
  text: string;
  confidence: number;
  /** Raw provider JSON, for debugging only — redactDeep before ANY log. */
  raw?: unknown;
}

/** The contract both concrete providers (T-407/T-408) implement. */
export interface OcrProvider {
  readonly name: OcrProviderName;
  /**
   * OCR a single-page PDF. Resolves with the text + confidence, or THROWS a
   * value that classifyOcrError() maps to an OcrCallStatus. Never reads vault /
   * config (its key + fetch were injected at construction).
   */
  ocrPdfPage(pdfPage: Uint8Array, ctx: CallContext): Promise<OcrResult>;
}
