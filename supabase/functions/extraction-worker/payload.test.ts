/**
 * payload.test.ts — T-428. Pure contract: mergeFields, buildExtractedPayload,
 * validateExtractedPayload, buildInvoiceUpdate.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  buildExtractedPayload,
  buildInvoiceUpdate,
  EXTRACTED_PAYLOAD_VERSION,
  type ExtractedFields,
  type ExtractionOutcome,
  mergeFields,
  RAW_EXCERPT_MAX,
  validateExtractedPayload,
} from './payload.ts';

const EMPTY: ExtractedFields = {
  amount_cents: null,
  due_date: null,
  barcode: null,
  pix_payload: null,
  payee_name: null,
  payee_document: null,
  customer_name: null,
  customer_document: null,
  reference_period: null,
  installation_id: null,
  service_address: null,
  utility_key: null,
};

// --- mergeFields ----------------------------------------------------------

Deno.test('mergeFields: regex-only result maps onto normalized columns', () => {
  const f = mergeFields(
    {
      amount_cents: 12345,
      due_date: '2026-07-10',
      barcode: '8466000...',
      reference: '06/2026',
      installation: 'INST-1',
      service_address: 'Rua X, 100',
      customer_name: 'Fulano',
    },
    null,
    'enel-sp',
  );
  assertEquals(f.amount_cents, 12345);
  assertEquals(f.reference_period, '06/2026');
  assertEquals(f.installation_id, 'INST-1');
  assertEquals(f.service_address, 'Rua X, 100');
  assertEquals(f.customer_name, 'Fulano');
  assertEquals(f.utility_key, 'enel-sp');
  assertEquals(f.payee_name, null); // only AI supplies issuer_name
});

Deno.test('mergeFields: present AI value wins over regex; AI-only fields land', () => {
  const f = mergeFields(
    { amount_cents: 100, due_date: '2026-01-01', customer_name: 'Regex Name' },
    {
      amount_cents: 999,
      issuer_name: 'Enel SP',
      customer_document: '123.456.789-00',
      customer_name: 'AI Name',
    },
    'enel-sp',
  );
  assertEquals(f.amount_cents, 999); // AI wins
  assertEquals(f.due_date, '2026-01-01'); // AI absent → regex stands
  assertEquals(f.payee_name, 'Enel SP'); // issuer_name → payee_name
  assertEquals(f.customer_document, '123.456.789-00');
  assertEquals(f.customer_name, 'AI Name');
});

Deno.test('mergeFields: null/empty AI value never overwrites a present regex value', () => {
  const f = mergeFields(
    { amount_cents: 500, barcode: '111' },
    { amount_cents: undefined, barcode: '' },
    null,
  );
  assertEquals(f.amount_cents, 500);
  assertEquals(f.barcode, '111');
});

// --- buildExtractedPayload ------------------------------------------------

Deno.test('buildExtractedPayload: versioned envelope, layer defaults, excerpt clamp', () => {
  const longText = 'x'.repeat(RAW_EXCERPT_MAX + 500);
  const p = buildExtractedPayload({
    method: 'regex',
    rawText: longText,
    fields: { ...EMPTY, amount_cents: 1 },
    confidenceFinal: 0.91,
    layer1: { chars: 1200, pages: 1, density: 0.2 },
    layer3: { matched: true, utility_key: 'enel-sp', confidence: 1 },
  });
  assertEquals(p.version, EXTRACTED_PAYLOAD_VERSION);
  assertEquals(p.data.method, 'regex');
  assertEquals(p.data.raw_text_excerpt.length, RAW_EXCERPT_MAX);
  assertEquals(p.data.layer2, null); // unspecified → null
  assertEquals(p.data.layer4, null);
  assertEquals(p.data.layer1?.chars, 1200);
  assertEquals(p.data.confidence_final, 0.91);
});

// --- validateExtractedPayload ---------------------------------------------

Deno.test('validateExtractedPayload: a freshly built payload validates', () => {
  const p = buildExtractedPayload({
    method: 'ai_fallback',
    rawText: 'abc',
    fields: EMPTY,
    confidenceFinal: 0.5,
    layer4: { provider: 'gemini', model: 'g', confidence: 0.5, self_reported: 0.6 },
  });
  const r = validateExtractedPayload(p);
  assert(r.ok);
});

Deno.test('validateExtractedPayload: rejects non-object, array, bad version/method/confidence', () => {
  assert(!validateExtractedPayload(null).ok);
  assert(!validateExtractedPayload([]).ok);
  assert(!validateExtractedPayload('x').ok);
  const base = buildExtractedPayload({
    method: 'regex',
    rawText: '',
    fields: EMPTY,
    confidenceFinal: 0.9,
  });

  const badVersion = validateExtractedPayload({ ...base, version: 2 });
  assert(!badVersion.ok && badVersion.errors.some((e) => e.includes('version')));

  const badMethod = validateExtractedPayload({
    version: 1,
    data: { ...base.data, method: 'nope' },
  });
  assert(!badMethod.ok && badMethod.errors.some((e) => e.includes('method')));

  const badConf = validateExtractedPayload({
    version: 1,
    data: { ...base.data, confidence_final: 1.5 },
  });
  assert(!badConf.ok && badConf.errors.some((e) => e.includes('confidence_final')));

  const badLayer = validateExtractedPayload({ version: 1, data: { ...base.data, layer1: 7 } });
  assert(!badLayer.ok && badLayer.errors.some((e) => e.includes('layer1')));
});

Deno.test('validateExtractedPayload: missing data object fails fast', () => {
  const r = validateExtractedPayload({ version: 1 });
  assert(!r.ok && r.errors.some((e) => e.includes('data')));
});

// --- buildInvoiceUpdate ---------------------------------------------------

Deno.test('buildInvoiceUpdate: maps outcome → invoices columns incl. clock + payload', () => {
  const payload = buildExtractedPayload({
    method: 'regex',
    rawText: 't',
    fields: EMPTY,
    confidenceFinal: 0.88,
  });
  const outcome: ExtractionOutcome = {
    status: 'extracted',
    method: 'regex',
    confidence: 0.88,
    fields: { ...EMPTY, amount_cents: 4200, due_date: '2026-07-01', utility_key: 'enel-sp' },
    payload,
  };
  const u = buildInvoiceUpdate(outcome, '2026-06-24T12:00:00.000Z');
  assertEquals(u.status, 'extracted');
  assertEquals(u.extraction_method, 'regex');
  assertEquals(u.extraction_confidence, 0.88);
  assertEquals(u.extracted_at, '2026-06-24T12:00:00.000Z');
  assertEquals(u.amount_cents, 4200);
  assertEquals(u.due_date, '2026-07-01');
  assertEquals(u.utility_key, 'enel-sp');
  assertEquals(u.extracted_payload, payload);
  assertEquals(u.needs_review_reason, null); // default
  assertEquals(u.extraction_error, null);
});

Deno.test('buildInvoiceUpdate: carries needs_review_reason / extraction_error when set', () => {
  const payload = buildExtractedPayload({
    method: 'ai_fallback',
    rawText: '',
    fields: EMPTY,
    confidenceFinal: 0.6,
  });
  const u = buildInvoiceUpdate(
    {
      status: 'needs_review',
      method: 'ai_fallback',
      confidence: 0.6,
      fields: EMPTY,
      payload,
      needsReviewReason: 'low_confidence',
    },
    '2026-06-24T12:00:00.000Z',
  );
  assertEquals(u.status, 'needs_review');
  assertEquals(u.needs_review_reason, 'low_confidence');
  assertEquals(u.extraction_error, null);
});
