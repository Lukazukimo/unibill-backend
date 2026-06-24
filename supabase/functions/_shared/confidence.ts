/**
 * confidence.ts — the single source of truth that maps an extraction result to
 * a confidence score [0..1] and a terminal invoice status.
 *
 * Ref:  T-417 — confidence formula + status mapper
 * Spec: §7.7 (confidence formula) + §B (extraction.* thresholds/weights)
 * Date: 2026-06-23
 *
 * The core `computeConfidence` is PURE and deterministic — no I/O. Thresholds
 * are INJECTED (use DEFAULT_THRESHOLDS or loadConfidenceThresholds()), so the
 * formula is total even if config load fails, and every caller agrees on the
 * exact same mapping. The final confidence is rounded to 2dp BEFORE the status
 * decision, so the value stored in invoices.extraction_confidence (numeric(3,2))
 * and the chosen status can never disagree at a threshold boundary.
 */

/** Terminal extraction outcome — a subset of the invoice status enum. */
export type ExtractionStatus = 'extracted' | 'needs_review' | 'failed';

/** Per-layer signals fed into the canonical confidence formula (spec §7.7). */
export interface ExtractionSignals {
  /** Layer 3 (regex) confidence [0..1] = captured_fields / required_fields. */
  layer3Confidence: number;
  /** Did Layer 4 (AI) run? Gates the layer4 terms. */
  layer4Ran: boolean;
  /** Layer 4 computed confidence [0..1]. Ignored if !layer4Ran. */
  layer4Confidence?: number;
  /** Layer 4 self-reported confidence [0..1] from the model JSON. Ignored if !layer4Ran. */
  layer4SelfReported?: number;
  /** Did Layer 2 (OCR) run? Gates the OCR weighting. */
  layer2Ran: boolean;
  /** Avg OCR confidence [0..1] across OCR calls. Ignored if !layer2Ran. */
  ocrConfidence?: number;
}

/** Thresholds + weights — sourced from extraction.* app_settings (T-402). */
export interface ConfidenceThresholds {
  confidenceThreshold: number; // extraction.confidence_threshold        (0.85)
  needsReviewThreshold: number; // extraction.needs_review_threshold      (0.50)
  extractionWeight: number; // extraction.confidence_extraction_weight (0.7)
  ocrWeight: number; // extraction.confidence_ocr_weight        (0.3)
}

export interface ConfidenceResult {
  /** Final confidence, rounded to 2dp + clamped [0,1] — fits numeric(3,2). */
  confidence: number;
  status: ExtractionStatus;
  /** Set only when status==='needs_review' → invoices.needs_review_reason. */
  needsReviewReason?: 'low_confidence';
  /** Set only when status==='failed' → invoices.extraction_error. */
  extractionError?: 'confidence_below_review_threshold';
}

/** Code defaults — mirror spec §B so the formula is total even if config fails. */
export const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  confidenceThreshold: 0.85,
  needsReviewThreshold: 0.50,
  extractionWeight: 0.7,
  ocrWeight: 0.3,
};

function clamp01(n: number | undefined): number {
  const x = n ?? 0;
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Round to 2 decimals (numeric(3,2)). Half-up: 0.845 → 0.85. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Canonical deterministic confidence + status mapper (spec §7.7). PURE — no I/O.
 *
 * Steps:
 *   1. best layer that ran: max(layer3, layer4) when AI ran, else layer3.
 *   2. AI penalty: min with the model's self-reported confidence (models are
 *      over-confident) — only when AI ran.
 *   3. OCR weighting: when OCR ran, blend extraction*W_extraction + ocr*W_ocr
 *      (a confident extraction over a poor OCR source is itself suspect).
 *   4. round to 2dp, then map against thresholds (>= is inclusive).
 */
export function computeConfidence(
  signals: ExtractionSignals,
  thresholds: ConfidenceThresholds = DEFAULT_THRESHOLDS,
): ConfidenceResult {
  const l3 = clamp01(signals.layer3Confidence);

  // Step 1: best layer that ran.
  const layerConfidence = signals.layer4Ran ? Math.max(l3, clamp01(signals.layer4Confidence)) : l3;

  // Step 2: AI penalty via min with self-reported.
  const extractionConfidence = signals.layer4Ran
    ? Math.min(layerConfidence, clamp01(signals.layer4SelfReported))
    : layerConfidence;

  // Step 3: OCR weighting when Layer 2 ran.
  const blended = signals.layer2Ran
    ? extractionConfidence * thresholds.extractionWeight +
      clamp01(signals.ocrConfidence) * thresholds.ocrWeight
    : extractionConfidence;

  const confidence = round2(clamp01(blended));

  // Step 4: thresholds → status (compare the ROUNDED value).
  if (confidence >= thresholds.confidenceThreshold) {
    return { confidence, status: 'extracted' };
  }
  if (confidence >= thresholds.needsReviewThreshold) {
    return { confidence, status: 'needs_review', needsReviewReason: 'low_confidence' };
  }
  return {
    confidence,
    status: 'failed',
    extractionError: 'confidence_below_review_threshold',
  };
}

// ---------------------------------------------------------------------------
// Thin config loader — keeps computeConfidence pure while letting callers pull
// the thresholds from app_settings (extraction.*). Falls back to the code
// defaults per key, so a missing/failed config never throws.
// ---------------------------------------------------------------------------

import { type ConfigDeps, getGlobalConfig, readNumberConfig } from './config.ts';

const CONFIDENCE_CONFIG_KEYS = [
  'extraction.confidence_threshold',
  'extraction.needs_review_threshold',
  'extraction.confidence_extraction_weight',
  'extraction.confidence_ocr_weight',
] as const;

export async function loadConfidenceThresholds(
  deps?: ConfigDeps,
): Promise<ConfidenceThresholds> {
  const cfg = await getGlobalConfig([...CONFIDENCE_CONFIG_KEYS], deps);
  return {
    confidenceThreshold: readNumberConfig(
      cfg,
      'extraction.confidence_threshold',
      DEFAULT_THRESHOLDS.confidenceThreshold,
    ),
    needsReviewThreshold: readNumberConfig(
      cfg,
      'extraction.needs_review_threshold',
      DEFAULT_THRESHOLDS.needsReviewThreshold,
    ),
    extractionWeight: readNumberConfig(
      cfg,
      'extraction.confidence_extraction_weight',
      DEFAULT_THRESHOLDS.extractionWeight,
    ),
    ocrWeight: readNumberConfig(
      cfg,
      'extraction.confidence_ocr_weight',
      DEFAULT_THRESHOLDS.ocrWeight,
    ),
  };
}
