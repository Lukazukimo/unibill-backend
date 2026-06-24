/**
 * extract_schema.test.ts — T-412. Pure JSON parse/coerce; no network.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { classifyOcrError } from '../ocr/classify_error.ts';
import { parseAiExtraction } from './extract_schema.ts';

Deno.test('parses a full, well-formed extraction', () => {
  const r = parseAiExtraction(JSON.stringify({
    amount_cents: 23456,
    due_date: '2026-06-15',
    barcode: '03399000000023456',
    pix_payload: '00020126abc',
    issuer_name: 'Enel SP',
    customer_name: 'Maria',
    customer_document: '529.982.247-25',
    confidence: 0.9,
  }));
  assertEquals(r.fields.amount_cents, 23456);
  assertEquals(r.fields.due_date, '2026-06-15');
  assertEquals(r.fields.issuer_name, 'Enel SP');
  assertEquals(r.selfReported, 0.9);
});

Deno.test('coerces a string amount and omits empty/missing fields', () => {
  const r = parseAiExtraction(JSON.stringify({
    amount_cents: 'R$ 12.345',
    due_date: '',
    barcode: null,
    confidence: 1.5, // clamped
  }));
  assertEquals(r.fields.amount_cents, 12345);
  assertEquals(r.fields.due_date, undefined);
  assertEquals(r.fields.barcode, undefined);
  assertEquals(r.selfReported, 1); // clamped to [0,1]
});

Deno.test('missing confidence → 0', () => {
  const r = parseAiExtraction(JSON.stringify({ amount_cents: 100 }));
  assertEquals(r.selfReported, 0);
});

Deno.test('non-JSON body → OcrInvalidResponseError (classified invalid_response)', () => {
  let err: unknown;
  try {
    parseAiExtraction('not json at all');
  } catch (e) {
    err = e;
  }
  assertEquals(classifyOcrError(err).status, 'invalid_response');
});

Deno.test('a JSON array (not object) → invalid_response', () => {
  let err: unknown;
  try {
    parseAiExtraction('[1,2,3]');
  } catch (e) {
    err = e;
  }
  assertEquals(classifyOcrError(err).status, 'invalid_response');
});
