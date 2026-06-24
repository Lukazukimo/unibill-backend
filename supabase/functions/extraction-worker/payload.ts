/**
 * payload.ts — the extracted_payload v1 contract + the invoices persistence
 * mapper (T-428).
 *
 * Ref:  T-428, spec §7.8 (extracted_payload schema v1) + §5.3 (invoices columns)
 * Date: 2026-06-24
 *
 * Three pure, deterministic pieces (no I/O) shared by the orchestrator (T-418)
 * and any reader/admin replay (T-420/421):
 *
 *   - mergeFields()          — collapse the layer3 (regex) + layer4 (AI) field
 *                              shapes into one normalized set that maps 1:1 onto
 *                              invoices columns. AI runs only when regex was
 *                              insufficient, so a present AI value wins; a
 *                              null/empty value never overwrites a present one.
 *   - buildExtractedPayload()— assemble the versioned {version:1, data:{…}} jsonb
 *                              (the §7.8 telemetry envelope) stored in
 *                              invoices.extracted_payload.
 *   - validateExtractedPayload() — defensive structural check for the v1 contract
 *                              (used on reads/replay, never trusts the DB blob).
 *   - buildInvoiceUpdate()   — map an ExtractionOutcome onto the invoices UPDATE
 *                              patch (status + method + confidence + payload + the
 *                              denormalized field columns).
 */

import type { ExtractionStatus } from '../_shared/confidence.ts';
import type { ExtractedFields as Layer3Fields } from './layers/layer3_regex.ts';
import type { AiExtractedFields } from '../_shared/ai/types.ts';

export const EXTRACTED_PAYLOAD_VERSION = 1 as const;

/** public.extraction_method enum labels. */
export const EXTRACTION_METHODS = [
  'pdfjs',
  'ocr_api',
  'regex',
  'ai_fallback',
  'manual',
  'on_device',
] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** First N chars of the source text kept in the payload for debugging/audit. */
export const RAW_EXCERPT_MAX = 2000;

/** Normalized fields that map 1:1 onto invoices columns. */
export interface ExtractedFields {
  amount_cents: number | null;
  due_date: string | null; // ISO yyyy-mm-dd
  barcode: string | null;
  pix_payload: string | null;
  payee_name: string | null;
  payee_document: string | null;
  customer_name: string | null;
  customer_document: string | null;
  reference_period: string | null;
  installation_id: string | null;
  service_address: string | null;
  utility_key: string | null;
}

// Per-layer telemetry (spec §7.8). Optional fields the current layers don't yet
// surface (duration_ms, parser_version, tokens) are intentionally omitted — the
// validator treats the layer blocks as best-effort objects.
export interface Layer1Telemetry {
  chars: number;
  pages: number;
  density: number;
}
export interface Layer2Telemetry {
  applied: boolean;
  pages_ocred: number;
  ocr_confidence: number;
  early_exit: boolean;
}
export interface Layer3Telemetry {
  matched: boolean;
  utility_key: string | null;
  confidence: number;
}
export interface Layer4Telemetry {
  provider: string | null;
  model: string | null;
  confidence: number;
  self_reported: number;
}

export interface ExtractedPayloadData {
  method: ExtractionMethod;
  raw_text_excerpt: string;
  layer1: Layer1Telemetry | null;
  layer2: Layer2Telemetry | null;
  layer3: Layer3Telemetry | null;
  layer4: Layer4Telemetry | null;
  extracted_fields: ExtractedFields;
  confidence_final: number;
}

export interface ExtractedPayloadV1 {
  version: typeof EXTRACTED_PAYLOAD_VERSION;
  data: ExtractedPayloadData;
}

/** The orchestrator's result (T-418) — the input to the invoices writer. */
export interface ExtractionOutcome {
  status: ExtractionStatus;
  method: ExtractionMethod;
  confidence: number;
  fields: ExtractedFields;
  payload: ExtractedPayloadV1;
  needsReviewReason?: string | null;
  extractionError?: string | null;
}

/** First non-null / non-empty value, else null. */
function pick<T>(...vals: Array<T | null | undefined>): T | null {
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * Collapse the layer3 (regex) + layer4 (AI) field shapes into the normalized
 * ExtractedFields. A present layer4 value wins over layer3 (AI only runs when
 * regex fell short); null/empty never overwrites a present value. The layer
 * shapes differ — this is also where their field names are reconciled
 * (AI issuer_name → payee_name, regex reference → reference_period, …).
 */
export function mergeFields(
  layer3: Partial<Layer3Fields> | null,
  layer4: Partial<AiExtractedFields> | null,
  utilityKey: string | null,
): ExtractedFields {
  const l3 = layer3 ?? {};
  const l4 = layer4 ?? {};
  return {
    amount_cents: pick(l4.amount_cents, l3.amount_cents),
    due_date: pick(l4.due_date, l3.due_date),
    barcode: pick(l4.barcode, l3.barcode),
    pix_payload: pick(l4.pix_payload, l3.pix_payload),
    payee_name: pick(l4.issuer_name),
    payee_document: null,
    customer_name: pick(l4.customer_name, l3.customer_name),
    customer_document: pick(l4.customer_document),
    reference_period: pick(l3.reference),
    installation_id: pick(l3.installation),
    service_address: pick(l3.service_address),
    utility_key: pick(utilityKey),
  };
}

export interface BuildPayloadInput {
  method: ExtractionMethod;
  rawText: string;
  fields: ExtractedFields;
  confidenceFinal: number;
  layer1?: Layer1Telemetry | null;
  layer2?: Layer2Telemetry | null;
  layer3?: Layer3Telemetry | null;
  layer4?: Layer4Telemetry | null;
}

/** Assemble the versioned extracted_payload jsonb (spec §7.8). */
export function buildExtractedPayload(input: BuildPayloadInput): ExtractedPayloadV1 {
  return {
    version: EXTRACTED_PAYLOAD_VERSION,
    data: {
      method: input.method,
      raw_text_excerpt: (input.rawText ?? '').slice(0, RAW_EXCERPT_MAX),
      layer1: input.layer1 ?? null,
      layer2: input.layer2 ?? null,
      layer3: input.layer3 ?? null,
      layer4: input.layer4 ?? null,
      extracted_fields: input.fields,
      confidence_final: input.confidenceFinal,
    },
  };
}

export type PayloadValidation =
  | { ok: true; value: ExtractedPayloadV1 }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Defensive structural validation of a stored extracted_payload (never trust the
 * DB blob — readers/replay run this before relying on it). Checks the v1 shape:
 * version===1, a `data` object with a known method, a numeric confidence_final in
 * [0,1], an extracted_fields object, and (if present) object|null layer blocks.
 */
export function validateExtractedPayload(value: unknown): PayloadValidation {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }
  const errors: string[] = [];
  if (value.version !== EXTRACTED_PAYLOAD_VERSION) {
    errors.push(`unsupported version: ${JSON.stringify(value.version)}`);
  }
  if (!isPlainObject(value.data)) {
    errors.push('data must be a JSON object');
    return { ok: false, errors };
  }
  const d = value.data;
  if (typeof d.method !== 'string' || !EXTRACTION_METHODS.includes(d.method as ExtractionMethod)) {
    errors.push(`invalid method: ${JSON.stringify(d.method)}`);
  }
  if (
    typeof d.confidence_final !== 'number' ||
    !Number.isFinite(d.confidence_final) ||
    d.confidence_final < 0 ||
    d.confidence_final > 1
  ) {
    errors.push(
      `confidence_final must be a number in [0,1]: ${JSON.stringify(d.confidence_final)}`,
    );
  }
  if (!isPlainObject(d.extracted_fields)) {
    errors.push('extracted_fields must be a JSON object');
  }
  if (typeof d.raw_text_excerpt !== 'string') {
    errors.push('raw_text_excerpt must be a string');
  }
  for (const layer of ['layer1', 'layer2', 'layer3', 'layer4'] as const) {
    const lv = d[layer];
    if (lv !== null && lv !== undefined && !isPlainObject(lv)) {
      errors.push(`${layer} must be an object or null`);
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as ExtractedPayloadV1 };
}

/**
 * Map an ExtractionOutcome onto the invoices UPDATE patch. `nowIso` is injected
 * (the caller owns the clock) so this stays pure and testable.
 */
export function buildInvoiceUpdate(
  outcome: ExtractionOutcome,
  nowIso: string,
): Record<string, unknown> {
  const f = outcome.fields;
  return {
    status: outcome.status,
    extraction_method: outcome.method,
    extraction_confidence: outcome.confidence,
    extracted_at: nowIso,
    extracted_payload: outcome.payload,
    needs_review_reason: outcome.needsReviewReason ?? null,
    extraction_error: outcome.extractionError ?? null,
    utility_key: f.utility_key,
    amount_cents: f.amount_cents,
    due_date: f.due_date,
    barcode: f.barcode,
    pix_payload: f.pix_payload,
    payee_name: f.payee_name,
    payee_document: f.payee_document,
    customer_name: f.customer_name,
    customer_document: f.customer_document,
    reference_period: f.reference_period,
    installation_id: f.installation_id,
    service_address: f.service_address,
  };
}
