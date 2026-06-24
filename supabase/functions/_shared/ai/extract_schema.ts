/**
 * ai/extract_schema.ts — the JSON contract Layer 4 asks the model for, plus a
 * safe parser shared by all AI providers.
 *
 * Ref:  T-412, spec §7.5 (structured output) + §7.7 (layer4.self_reported)
 * Date: 2026-06-24
 *
 * Every provider returns a JSON string in the same shape; parseAiExtraction
 * validates + coerces it into an AiExtractResult. A non-JSON / wrong-shape body
 * throws OcrInvalidResponseError (the shared §7.5.1 classifier maps it to
 * 'invalid_response', which counts on the chain but not the per-provider breaker).
 */

import { OcrInvalidResponseError } from '../ocr/classify_error.ts';
import type { AiExtractedFields, AiExtractResult } from './types.ts';

/**
 * The response schema (OpenAPI subset) for Gemini's responseSchema /
 * OpenAI-style json_schema. All fields optional except confidence so the model
 * can omit what it cannot read rather than hallucinate.
 */
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    amount_cents: { type: 'integer' },
    due_date: { type: 'string' },
    barcode: { type: 'string' },
    pix_payload: { type: 'string' },
    issuer_name: { type: 'string' },
    customer_name: { type: 'string' },
    customer_document: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['confidence'],
} as const;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function intCents(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d-]/g, ''));
    if (Number.isFinite(n)) return Math.round(n);
  }
  return undefined;
}

/** Parse + coerce a model's JSON output. Throws OcrInvalidResponseError on bad JSON. */
export function parseAiExtraction(jsonText: string): AiExtractResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    throw new OcrInvalidResponseError('AI provider: response was not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OcrInvalidResponseError('AI provider: response JSON was not an object');
  }

  const fields: AiExtractedFields = {};
  const amount = intCents(parsed.amount_cents);
  if (amount !== undefined) fields.amount_cents = amount;
  const due = str(parsed.due_date);
  if (due) fields.due_date = due;
  const barcode = str(parsed.barcode);
  if (barcode) fields.barcode = barcode;
  const pix = str(parsed.pix_payload);
  if (pix) fields.pix_payload = pix;
  const issuer = str(parsed.issuer_name);
  if (issuer) fields.issuer_name = issuer;
  const customer = str(parsed.customer_name);
  if (customer) fields.customer_name = customer;
  const doc = str(parsed.customer_document);
  if (doc) fields.customer_document = doc;

  return { fields, selfReported: clamp01(Number(parsed.confidence)), raw: parsed };
}
