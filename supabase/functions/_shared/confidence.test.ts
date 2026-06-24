/**
 * confidence.test.ts — unit coverage for the confidence formula + status mapper.
 *
 * Ref: T-417. Spec §7.7 + §B. Date: 2026-06-23.
 *
 * The core is pure (thresholds injected) so most tests need no DB; the loader
 * test injects a fake SupabaseClient mirroring config.test.ts.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import {
  computeConfidence,
  type ConfidenceThresholds,
  DEFAULT_THRESHOLDS,
  type ExtractionSignals,
  loadConfidenceThresholds,
} from './confidence.ts';

/** Build signals with safe defaults (layer3 only, no AI, no OCR). */
function sig(o: Partial<ExtractionSignals> = {}): ExtractionSignals {
  return { layer3Confidence: 0, layer4Ran: false, layer2Ran: false, ...o };
}

// -- Thresholds → status (default thresholds) ---------------------------------

Deno.test('extracted at the confidence threshold (>= is inclusive)', () => {
  const r = computeConfidence(sig({ layer3Confidence: 0.85 }));
  assertEquals(r.confidence, 0.85);
  assertEquals(r.status, 'extracted');
  assertEquals(r.needsReviewReason, undefined);
  assertEquals(r.extractionError, undefined);
});

Deno.test('needs_review just below the confidence threshold', () => {
  const r = computeConfidence(sig({ layer3Confidence: 0.84 }));
  assertEquals(r.confidence, 0.84);
  assertEquals(r.status, 'needs_review');
  assertEquals(r.needsReviewReason, 'low_confidence');
  assertEquals(r.extractionError, undefined);
});

Deno.test('needs_review exactly at the review threshold (>= inclusive)', () => {
  const r = computeConfidence(sig({ layer3Confidence: 0.50 }));
  assertEquals(r.confidence, 0.50);
  assertEquals(r.status, 'needs_review');
});

Deno.test('failed just below the review threshold', () => {
  const r = computeConfidence(sig({ layer3Confidence: 0.49 }));
  assertEquals(r.confidence, 0.49);
  assertEquals(r.status, 'failed');
  assertEquals(r.extractionError, 'confidence_below_review_threshold');
  assertEquals(r.needsReviewReason, undefined);
});

Deno.test('failed at zero / all-missing signals', () => {
  const r = computeConfidence(sig());
  assertEquals(r.confidence, 0);
  assertEquals(r.status, 'failed');
});

// -- Formula steps ------------------------------------------------------------

Deno.test('step 1: takes max(layer3, layer4) when AI ran', () => {
  const r = computeConfidence(
    sig({ layer3Confidence: 0.6, layer4Ran: true, layer4Confidence: 0.9, layer4SelfReported: 1.0 }),
  );
  assertEquals(r.confidence, 0.9);
  assertEquals(r.status, 'extracted');
});

Deno.test('step 2: penalizes via min with the over-confident self-reported score', () => {
  const r = computeConfidence(
    sig({ layer3Confidence: 0.9, layer4Ran: true, layer4Confidence: 0.9, layer4SelfReported: 0.6 }),
  );
  assertEquals(r.confidence, 0.60);
  assertEquals(r.status, 'needs_review');
});

Deno.test('step 3: OCR weighting (0.7/0.3) — boundary lands at threshold', () => {
  const r = computeConfidence(
    sig({ layer3Confidence: 1.0, layer2Ran: true, ocrConfidence: 0.5 }),
  );
  assertEquals(r.confidence, 0.85); // 1.0*0.7 + 0.5*0.3
  assertEquals(r.status, 'extracted');
});

Deno.test('step 3: a poor OCR source drags a perfect extraction below threshold', () => {
  const r = computeConfidence(
    sig({ layer3Confidence: 1.0, layer2Ran: true, ocrConfidence: 0.0 }),
  );
  assertEquals(r.confidence, 0.70); // 1.0*0.7 + 0*0.3
  assertEquals(r.status, 'needs_review');
});

Deno.test('self-reported is ignored when layer 4 did not run', () => {
  const r = computeConfidence(
    sig({ layer3Confidence: 0.95, layer4Ran: false, layer4SelfReported: 0.1 }),
  );
  assertEquals(r.confidence, 0.95);
  assertEquals(r.status, 'extracted');
});

Deno.test('ocrConfidence is ignored when layer 2 did not run', () => {
  const r = computeConfidence(
    sig({ layer3Confidence: 0.9, layer2Ran: false, ocrConfidence: 0.0 }),
  );
  assertEquals(r.confidence, 0.9);
});

Deno.test('missing layer-4 fields are treated as 0 when AI ran', () => {
  const r = computeConfidence(sig({ layer3Confidence: 0.9, layer4Ran: true }));
  // step1 max(0.9, 0) = 0.9; step2 min(0.9, 0) = 0 → failed.
  assertEquals(r.confidence, 0);
  assertEquals(r.status, 'failed');
});

Deno.test('out-of-range / NaN inputs are clamped to [0,1]', () => {
  const r = computeConfidence(
    sig({ layer3Confidence: 1.5, layer2Ran: true, ocrConfidence: -0.2 }),
  );
  assert(r.confidence >= 0 && r.confidence <= 1);
  // l3 clamps to 1.0, ocr clamps to 0 → 1*0.7 + 0*0.3 = 0.70
  assertEquals(r.confidence, 0.70);
  const nan = computeConfidence(sig({ layer3Confidence: Number.NaN }));
  assertEquals(nan.confidence, 0);
});

Deno.test('rounds to 2dp before deciding status (stored value === decided value)', () => {
  const hi = computeConfidence(sig({ layer3Confidence: 0.846 }));
  assertEquals(hi.confidence, 0.85);
  assertEquals(hi.status, 'extracted');
  const lo = computeConfidence(sig({ layer3Confidence: 0.844 }));
  assertEquals(lo.confidence, 0.84);
  assertEquals(lo.status, 'needs_review');
  // round-trips into numeric(3,2)
  assertEquals(Number(hi.confidence.toFixed(2)), hi.confidence);
});

Deno.test('thresholds are config-driven (injected), not hardcoded', () => {
  const strict: ConfidenceThresholds = {
    confidenceThreshold: 0.95,
    needsReviewThreshold: 0.40,
    extractionWeight: 0.7,
    ocrWeight: 0.3,
  };
  const r = computeConfidence(sig({ layer3Confidence: 0.90 }), strict);
  assertEquals(r.confidence, 0.90);
  assertEquals(r.status, 'needs_review'); // 0.90 < 0.95 now
});

Deno.test('DEFAULT_THRESHOLDS satisfy the §B inter-key invariants', () => {
  assert(DEFAULT_THRESHOLDS.needsReviewThreshold < DEFAULT_THRESHOLDS.confidenceThreshold);
  assertEquals(DEFAULT_THRESHOLDS.extractionWeight + DEFAULT_THRESHOLDS.ocrWeight, 1.0);
});

// -- loadConfidenceThresholds (config loader) ---------------------------------

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
  return {
    from() {
      return { select: () => chain };
    },
  } as unknown as SupabaseClient;
}

Deno.test('loadConfidenceThresholds reads the extraction.* keys from config', async () => {
  const client = fakeClient([
    { key: 'extraction.confidence_threshold', value: { v: 0.9 } },
    { key: 'extraction.needs_review_threshold', value: { v: 0.6 } },
    { key: 'extraction.confidence_extraction_weight', value: { v: 0.8 } },
    { key: 'extraction.confidence_ocr_weight', value: { v: 0.2 } },
  ]);
  const t = await loadConfidenceThresholds({ client });
  assertEquals(t, {
    confidenceThreshold: 0.9,
    needsReviewThreshold: 0.6,
    extractionWeight: 0.8,
    ocrWeight: 0.2,
  });
});

Deno.test('loadConfidenceThresholds falls back to DEFAULT_THRESHOLDS when keys are absent', async () => {
  const t = await loadConfidenceThresholds({ client: fakeClient([]) });
  assertEquals(t, DEFAULT_THRESHOLDS);
});
