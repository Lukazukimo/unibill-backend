/**
 * orchestrate.ts — the 4-layer extraction cascade (T-418, part 1).
 *
 * Ref:  T-418, spec §7.1 (pipeline) + §7.2–7.7 (per-layer + confidence)
 * Date: 2026-06-24
 *
 * The deterministic brain of the extraction-worker, decoupled from the queue /
 * Storage / DB I/O (that is the worker shell, E3). Given a PDF + match context +
 * the utility parsers, it runs the cascade and returns an ExtractionOutcome
 * (the §7.8 contract from payload.ts) ready to persist:
 *
 *   Layer 1 (pdfjs)  → native text. If insufficient (needsOcr) →
 *   Layer 2 (OCR)    → OCR text (which already runs per-page regex w/ early-exit).
 *   Layer 3 (regex)  → utility parser fields + a coverage confidence.
 *   Layer 4 (AI)     → fallback, ONLY when regex confidence < threshold AND the
 *                      AI chain breaker is closed. A ChainOpenError is a SYSTEMIC
 *                      (recoverable) miss → needs_review w/ reason 'ai_chain_open'
 *                      (the worker ACKs it). Other AI/OCR failures bubble so the
 *                      worker can retry / DLQ them.
 *
 * Every collaborator is injected (defaults wire to the real layer modules) so the
 * branching logic is unit-tested with fakes — no real PDFs, OCR or AI calls.
 */

import {
  buildExtractedPayload,
  type ExtractionMethod,
  type ExtractionOutcome,
  mergeFields,
} from './payload.ts';
import {
  computeConfidence,
  type ConfidenceThresholds,
  DEFAULT_THRESHOLDS,
} from '../_shared/confidence.ts';
import { type Layer1Assessment, type Layer1Thresholds, runLayer1 } from './layers/layer1_pdfjs.ts';
import { type Layer2Result, runLayer2 } from './layers/layer2_orchestrator.ts';
import {
  applyParser,
  type Layer3Result,
  type MatchContext,
  selectParser,
  type UtilityParser,
} from './layers/layer3_regex.ts';
import type { AiCallContext, AiExtractResult } from '../_shared/ai/types.ts';
import type { OcrClient } from '../_shared/ocr/ocr_client.ts';
import { ChainOpenError } from '../_shared/errors.ts';

/** Minimal AI surface the orchestrator needs (AiClient satisfies it). */
export interface AiExtractor {
  extractStructured(text: string, ctx: AiCallContext): Promise<AiExtractResult>;
}

export interface OrchestrateInput {
  pdfBytes: Uint8Array;
  ctx: AiCallContext; // { correlation_id, invoice_id, household_id }
  matchContext: MatchContext; // { senderEmail?, subject?, bodyText? } — parser selection
  parsers: UtilityParser[];
}

export interface OrchestrateDeps {
  ocrClient: OcrClient;
  aiClient: AiExtractor;
  // Layer entrypoints — defaults wire to the real modules; overridden in tests.
  runLayer1?: (pdf: Uint8Array, thresholds?: Layer1Thresholds) => Promise<Layer1Assessment>;
  runLayer2?: (
    pdf: Uint8Array,
    ctx: AiCallContext,
    deps: {
      ocrClient: OcrClient;
      parsers: UtilityParser[];
      matchContext?: { senderEmail?: string; subject?: string };
      maxPages?: number;
    },
  ) => Promise<Layer2Result>;
  selectParser?: (parsers: UtilityParser[], ctx: MatchContext) => UtilityParser | null;
  applyParser?: (parser: UtilityParser, text: string) => Layer3Result;
  computeConfidenceFn?: typeof computeConfidence;
  layer1Thresholds?: Layer1Thresholds;
  confidenceThresholds?: ConfidenceThresholds;
  maxOcrPages?: number;
}

/**
 * Structural confidence for a field set = covered required slots / 3, where the
 * required slots are [amount_cents, due_date, (barcode OR pix_payload)] — the
 * same contract Layer 3 uses, so layer3 and layer4 confidences are comparable.
 */
function coverageConfidence(
  f: {
    amount_cents?: number | null;
    due_date?: string | null;
    barcode?: string | null;
    pix_payload?: string | null;
  },
): number {
  let n = 0;
  if (f.amount_cents !== undefined && f.amount_cents !== null) n++;
  if (f.due_date) n++;
  if (f.barcode || f.pix_payload) n++;
  return n / 3;
}

/** Which layer produced the persisted data → invoices.extraction_method. */
function pickMethod(
  s: { layer4Ran: boolean; layer2Ran: boolean; layer3Matched: boolean },
): ExtractionMethod {
  if (s.layer4Ran) return 'ai_fallback';
  if (s.layer2Ran) return 'ocr_api';
  if (s.layer3Matched) return 'regex';
  return 'pdfjs';
}

export async function orchestrate(
  input: OrchestrateInput,
  deps: OrchestrateDeps,
): Promise<ExtractionOutcome> {
  const doLayer1 = deps.runLayer1 ?? runLayer1;
  const doLayer2 = deps.runLayer2 ?? runLayer2;
  const doSelectParser = deps.selectParser ?? selectParser;
  const doApplyParser = deps.applyParser ?? applyParser;
  const confidence = deps.computeConfidenceFn ?? computeConfidence;
  const thresholds = deps.confidenceThresholds ?? DEFAULT_THRESHOLDS;

  // --- Layer 1: native pdfjs text -----------------------------------------
  const l1 = await doLayer1(input.pdfBytes, deps.layer1Thresholds);

  // --- Layer 2: OCR when the native text is insufficient ------------------
  let layer2Ran = false;
  let l2: Layer2Result | null = null;
  let text = l1.text;
  if (l1.needsOcr) {
    l2 = await doLayer2(input.pdfBytes, input.ctx, {
      ocrClient: deps.ocrClient,
      parsers: input.parsers,
      matchContext: {
        senderEmail: input.matchContext.senderEmail,
        subject: input.matchContext.subject,
      },
      maxPages: deps.maxOcrPages,
    });
    layer2Ran = true;
    text = l2.ocrText;
  }

  // --- Layer 3: regex per-utility -----------------------------------------
  // When OCR ran, Layer 2 already selected + applied the parser per page (with
  // early-exit), so reuse its result; otherwise run regex on the native text.
  let l3: Layer3Result | null;
  if (layer2Ran && l2) {
    l3 = l2.layer3;
  } else {
    const parser = doSelectParser(input.parsers, input.matchContext);
    l3 = parser ? doApplyParser(parser, text) : null;
  }
  const layer3Confidence = l3?.layer3Confidence ?? 0;

  // --- Layer 4: AI fallback when regex is insufficient --------------------
  let l4: AiExtractResult | null = null;
  let layer4Ran = false;
  let chainOpen = false;
  if (layer3Confidence < thresholds.confidenceThreshold) {
    try {
      l4 = await deps.aiClient.extractStructured(text, input.ctx);
      layer4Ran = true;
    } catch (err) {
      if (err instanceof ChainOpenError) {
        // Systemic, recoverable — don't burn a retry; mark needs_review below.
        chainOpen = true;
      } else {
        throw err; // transient (all providers failed, OCR exhausted) → retryable
      }
    }
  }
  const layer4Confidence = layer4Ran && l4 ? coverageConfidence(l4.fields) : 0;

  // --- Confidence + status (spec §7.7) ------------------------------------
  const conf = confidence({
    layer3Confidence,
    layer4Ran,
    layer4Confidence,
    layer4SelfReported: l4?.selfReported,
    layer2Ran,
    ocrConfidence: l2?.ocrConfidence,
  }, thresholds);

  let status = conf.status;
  let needsReviewReason: string | null = conf.needsReviewReason ?? null;
  let extractionError: string | null = conf.extractionError ?? null;

  if (chainOpen) {
    status = 'needs_review';
    needsReviewReason = 'ai_chain_open';
    extractionError = null;
  }

  // --- Method + fields + payload ------------------------------------------
  const method = pickMethod({ layer4Ran, layer2Ran, layer3Matched: l3 !== null });
  const utilityKey = l3?.parserKey ?? null;
  const fields = mergeFields(l3?.fields ?? null, l4?.fields ?? null, utilityKey);

  const payload = buildExtractedPayload({
    method,
    rawText: text,
    fields,
    confidenceFinal: conf.confidence,
    layer1: { chars: l1.charCount, pages: l1.pageCount, density: l1.charDensity },
    layer2: layer2Ran && l2
      ? {
        applied: true,
        pages_ocred: l2.pagesProcessed,
        ocr_confidence: l2.ocrConfidence,
        early_exit: l2.earlyExit,
      }
      : null,
    layer3: l3
      ? { matched: true, utility_key: l3.parserKey, confidence: l3.layer3Confidence }
      : { matched: false, utility_key: null, confidence: 0 },
    layer4: layer4Ran && l4
      ? {
        provider: null,
        model: null,
        confidence: layer4Confidence,
        self_reported: l4.selfReported,
      }
      : null,
  });

  return {
    status,
    method,
    confidence: conf.confidence,
    fields,
    payload,
    needsReviewReason,
    extractionError,
  };
}
