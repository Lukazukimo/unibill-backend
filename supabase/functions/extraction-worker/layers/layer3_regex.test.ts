/**
 * layer3_regex.test.ts — T-411. Uses the REAL enel-sp parser regexes (from the
 * seed supabase/seeds/utility_parsers_enel_sp.sql, the same ones pgtap/
 * enel_sp_parser.test.sql exercises) against realistic synthetic invoice text.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  applyParser,
  parseBrlToCents,
  parseDate,
  selectParser,
  type UtilityParser,
} from './layer3_regex.ts';

// The seeded enel-sp parser (regex strings copied verbatim from the seed).
const ENEL: UtilityParser = {
  utility_key: 'enel-sp',
  default_category: 'Luz',
  sender_patterns: ['enel\\.com', 'no-?reply.*enel', 'eletropaulo'],
  subject_patterns: ['fatura.*enel', 'sua conta de energia'],
  body_must_contain: ['Enel Distribuição São Paulo'],
  amount_regex: 'Valor a pagar[:\\s]+R\\$\\s*([0-9.,]+)',
  due_date_regex: 'Vencimento[:\\s]+(\\d{2}/\\d{2}/\\d{4})',
  due_date_format: 'DD/MM/YYYY',
  barcode_regex: '(\\d{5}\\.?\\d{5}\\s?\\d{5}\\.?\\d{6}\\s?\\d{5}\\.?\\d{6}\\s?\\d\\s?\\d{14})',
  pix_regex: '(00020126[0-9A-Za-z+/=]{50,})',
  reference_regex: 'Referência[:\\s]+([0-9]{2}/[0-9]{4}|[A-Za-zçãé]+/[0-9]{4})',
  installation_regex: 'Unidade Consumidora[:\\s]+(\\d{6,12})',
  customer_name_regex: 'Cliente[:\\s]+([A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ\\s\\.]+?)(?:\\n|$)',
  service_address_regex: 'Local de Instalação[:\\s]+(.+?)(?:\\n|$)',
};

const PIX = '00020126' + 'aBcD1234EfGh5678IjKl9012MnOp3456QrSt7890UvWx1234YZ520400005303986';

const FULL_INVOICE = [
  'Enel Distribuição São Paulo',
  'Cliente: MARIA DA SILVA SOUZA',
  'Unidade Consumidora: 123456789',
  'Referência: 05/2026',
  'Vencimento: 15/06/2026',
  'Valor a pagar: R$ 234,56',
  'Linha digitável: 03399.12345 67890.123456 78901.234567 8 99990000023456',
  `PIX copia e cola: ${PIX}`,
  'Local de Instalação: AV PAULISTA, 1578 - SAO PAULO/SP',
].join('\n');

// -- parseBrlToCents ----------------------------------------------------------

Deno.test('parseBrlToCents handles thousands + decimal Brazilian format', () => {
  assertEquals(parseBrlToCents('234,56'), 23456);
  assertEquals(parseBrlToCents('1.234,56'), 123456);
  assertEquals(parseBrlToCents('1.234.567,89'), 123456789);
  assertEquals(parseBrlToCents('R$ 99,00'), 9900);
  assertEquals(parseBrlToCents(undefined), undefined);
  assertEquals(parseBrlToCents('abc'), undefined);
});

// -- parseDate ----------------------------------------------------------------

Deno.test('parseDate converts DD/MM/YYYY → ISO', () => {
  assertEquals(parseDate('15/06/2026', 'DD/MM/YYYY'), '2026-06-15');
  assertEquals(parseDate('15/06/2026', null), '2026-06-15'); // default format
  assertEquals(parseDate('2026-06-15', 'DD/MM/YYYY'), undefined); // wrong shape
  assertEquals(parseDate(undefined, 'DD/MM/YYYY'), undefined);
});

// -- selectParser -------------------------------------------------------------

Deno.test('selectParser matches an enel sender', () => {
  const p = selectParser([ENEL], { senderEmail: 'no-reply@enel.com.br' });
  assertEquals(p?.utility_key, 'enel-sp');
});

Deno.test('selectParser returns null for a non-matching sender', () => {
  assertEquals(selectParser([ENEL], { senderEmail: 'billing@vivo.com.br' }), null);
});

Deno.test('selectParser enforces body_must_contain when present', () => {
  // sender matches but body lacks the required marker → no match.
  assertEquals(
    selectParser([ENEL], { senderEmail: 'fatura@enel.com', bodyText: 'unrelated body' }),
    null,
  );
  assertEquals(
    selectParser([ENEL], {
      senderEmail: 'fatura@enel.com',
      bodyText: 'Enel Distribuição São Paulo — sua fatura',
    })?.utility_key,
    'enel-sp',
  );
});

Deno.test('selectParser returns the first matching parser (priority order)', () => {
  const other: UtilityParser = { ...ENEL, utility_key: 'enel-2', default_category: 'X' };
  const picked = selectParser([ENEL, other], { senderEmail: 'x@enel.com' });
  assertEquals(picked?.utility_key, 'enel-sp');
});

// -- applyParser --------------------------------------------------------------

Deno.test('applyParser extracts every field from a full invoice → confidence 1.0', () => {
  const r = applyParser(ENEL, FULL_INVOICE);
  assertEquals(r.parserKey, 'enel-sp');
  assertEquals(r.fields.amount_cents, 23456);
  assertEquals(r.fields.due_date, '2026-06-15');
  assertEquals(r.fields.barcode, '03399.12345 67890.123456 78901.234567 8 99990000023456');
  assertEquals(r.fields.pix_payload, PIX);
  assertEquals(r.fields.customer_name, 'MARIA DA SILVA SOUZA');
  assertEquals(r.fields.service_address, 'AV PAULISTA, 1578 - SAO PAULO/SP');
  assertEquals(r.fields.default_category, 'Luz');
  assertEquals(r.layer3Confidence, 1); // amount + due + (barcode|pix) all present
});

Deno.test('applyParser: barcode OR pix satisfies the required field', () => {
  const noBarcode = [
    'Vencimento: 10/07/2026',
    'Valor a pagar: R$ 50,00',
    `PIX copia e cola: ${PIX}`,
  ].join('\n');
  const r = applyParser(ENEL, noBarcode);
  assertEquals(r.fields.amount_cents, 5000);
  assertEquals(r.fields.due_date, '2026-07-10');
  assertEquals(r.fields.barcode, undefined);
  assertEquals(r.fields.pix_payload, PIX);
  assertEquals(r.layer3Confidence, 1); // pix counts for barcode_or_pix
});

Deno.test('applyParser: partial extraction lowers confidence', () => {
  const r = applyParser(ENEL, 'Valor a pagar: R$ 12,34\n(no due date, no barcode, no pix)');
  assertEquals(r.fields.amount_cents, 1234);
  assertEquals(r.fields.due_date, undefined);
  // 1 of 3 required (only amount) → 1/3
  assertEquals(Number(r.layer3Confidence.toFixed(4)), Number((1 / 3).toFixed(4)));
});

Deno.test('applyParser on empty text → no fields, confidence 0', () => {
  const r = applyParser(ENEL, 'totally unrelated text');
  assertEquals(r.fields.amount_cents, undefined);
  assertEquals(r.layer3Confidence, 0);
});
