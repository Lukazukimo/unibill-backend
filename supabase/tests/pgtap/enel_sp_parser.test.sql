-- ============================================================================
-- Test:      supabase/tests/pgtap/enel_sp_parser.test.sql
-- Date:      2026-06-23
-- Task:      T-332 (#43) — pgTAP regex fixtures for the enel-sp parser
-- Purpose:   Verify the SEEDED enel-sp parser regex set (Layer 3, §5.4) actually
--            extracts the correct values from realistic — and fully synthetic /
--            sanitized (LGPD: NO real customer data, NO binary PDFs) — Enel SP
--            invoice TEXT. The test is SELF-FIXTURING: it loads the real seed row
--            (supabase/seeds/utility_parsers_enel_sp.sql — a plain idempotent
--            `ON CONFLICT (utility_key, version) DO NOTHING` INSERT) inside the
--            BEGIN/ROLLBACK, then pulls every regex BACK OUT OF THE SEEDED ROW
--            and applies it. Pulling the pattern from the row (instead of
--            re-typing it) means this test pins the parser's *actual stored*
--            behaviour, not a hand-copy — if a future migration edits a regex
--            column, the matching assertion moves with it.
--
--            Columns covered (all of utility_parsers' regex set per §5.4):
--              amount_regex, due_date_regex, barcode_regex, pix_regex,
--              reference_regex, installation_regex, customer_name_regex,
--              service_address_regex
--            plus the array match columns sender_patterns / subject_patterns.
--
--            Every regex column gets at least one POSITIVE and one NEGATIVE
--            assertion (issue #43 acceptance), spread over THREE distinct
--            synthetic fixture texts:
--              Fixture A — full invoice (R$ 234,56 / 15/06/2026 / linha digitável
--                          / EMV PIX copia-e-cola / numeric "05/2026" reference /
--                          9-digit UC / customer / service address).
--              Fixture B — second household invoice with DIFFERENT values
--                          (thousands separator "1.234,99", 03/12/2025, ANA ...).
--              Fixture C — third invoice exercising the named-month reference
--                          branch ("Maio/2026") and a short 6-digit UC.
--
--            Sender/Subject classification: enel.com + eletropaulo From addresses
--            and "fatura...enel" / "sua conta de energia" Subjects MATCH; an
--            unrelated telecom From/Subject is REJECTED (no false positive).
--
-- Spec refs: §5.4 (enel-sp parser seed — verbatim regex set; pre-extracted text
--                  fixtures only, LGPD: no binary PDFs / no real customer data).
--
-- Plan total: 28 assertions.
--
-- Hermeticity:
--   * Whole file wrapped in BEGIN / ROLLBACK; leaves no writes.
--   * search_path locked to public, extensions, app.
--   * Runs as the migration owner (postgres) — owner-bypasses RLS, which is
--     correct here: we test PARSER DATA (regex extraction), not RLS policies, so
--     NO jwt_claims helper is loaded (same pattern as invoices_dedupe.test.sql).
--   * The PIX "copia e cola" payloads are synthetic EMV-shaped alphanumeric
--     strings (the seed's pix_regex `(00020126[0-9A-Za-z+/=]{50,})` accepts only
--     base64-ish chars after the 00020126 prefix — dots/hyphens are NOT in the
--     class, so the fixtures keep the payload continuous & alphanumeric).
--   * customer_name_regex / service_address_regex use a non-greedy `.+?` then
--     `(?:\n|$)`; in Postgres POSIX regex `.` matches newline, so the capture is
--     only clean when the matched label is the final populated line of the
--     fixture string — fixtures place those fields with a trailing `\n` and no
--     content after, so captures are exact.
--
-- Notes on assertion forms:
--   * regexp_match(text, pattern) returns text[]; [1] is the first capture group.
--   * Array (sender/subject) match uses EXISTS over unnest(...) so an unknown
--     literal is typed text before `~` / `~*` (avoids `unknown ~ text[]`).
--     Subject uses `~*` (case-insensitive: subjects vary in case).
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

-- Inline the enel-sp parser row, copied VERBATIM from the real seed
-- supabase/seeds/utility_parsers_enel_sp.sql (T-313), which is the source of
-- truth for these regexes. We inline rather than `\ir ../../seeds/...` because
-- `supabase test db` only exposes the supabase/tests/ tree to pg_prove, so a
-- relative include reaching outside it (../../seeds/) does not resolve. Keep
-- this INSERT in sync with the seed if its regexes change.
INSERT INTO public.utility_parsers (
  utility_key, display_name, default_category, version, active, notes,
  sender_patterns, subject_patterns, body_must_contain,
  amount_regex, due_date_regex, due_date_format,
  barcode_regex, pix_regex, reference_regex, installation_regex,
  customer_name_regex, service_address_regex
) VALUES (
  'enel-sp', 'Enel São Paulo', 'Luz', 1, true,
  'Parser MVP para faturas Enel SP; padrões verificados contra emails de 2024-2026.',

  ARRAY[
    'enel\.com',
    'no-?reply.*enel',
    'eletropaulo'
  ],
  ARRAY[
    'fatura.*enel',
    'sua conta de energia'
  ],
  ARRAY[
    'Enel Distribuição São Paulo'
  ],

  -- amount: "Valor a pagar: R$ 234,56" ou "Total da fatura R$ 234,56"
  'Valor a pagar[:\s]+R\$\s*([0-9.,]+)',
  -- due_date: "Vencimento: 15/06/2026"
  'Vencimento[:\s]+(\d{2}/\d{2}/\d{4})',
  'DD/MM/YYYY',
  -- barcode: linha digitável 47 dígitos (com pontos/espaços opcionais)
  '(\d{5}\.?\d{5}\s?\d{5}\.?\d{6}\s?\d{5}\.?\d{6}\s?\d\s?\d{14})',
  -- pix_payload: BR code EMV (começa 00020126...)
  '(00020126[0-9A-Za-z+/=]{50,})',
  -- reference: "05/2026" ou "Maio/2026"
  'Referência[:\s]+([0-9]{2}/[0-9]{4}|[A-Za-zçãé]+/[0-9]{4})',
  -- installation/UC: "Unidade Consumidora: 123456789"
  'Unidade Consumidora[:\s]+(\d{6,12})',
  -- customer_name: aparece após "Cliente:" ou no header
  'Cliente[:\s]+([A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ\s\.]+?)(?:\n|$)',
  -- service_address: aparece após "Endereço:" ou "Local de Instalação:"
  'Local de Instalação[:\s]+(.+?)(?:\n|$)'
)
ON CONFLICT (utility_key, version) DO NOTHING;

SELECT plan(28);


-- ============================================================================
-- SETUP — fixtures. Three DISTINCT synthetic invoice texts (A/B/C) + From/Subject
-- samples. All names/addresses/UCs/values are fabricated (LGPD compliant).
-- ============================================================================
-- Fixture A: complete invoice.
\set fxA E'Enel Distribuição São Paulo\nCliente: MARIA DA SILVA SOUZA\nUnidade Consumidora: 123456789\nReferência: 05/2026\nVencimento: 15/06/2026\nValor a pagar: R$ 234,56\nLinha digitável: 03399.12345 67890.123456 78901.234567 8 99990000023456\nPIX copia e cola: 00020126aBcD1234EfGh5678IjKl9012MnOp3456QrSt7890UvWx1234YZ52040000530398654052340\nLocal de Instalação: AV PAULISTA, 1578 - SAO PAULO/SP\n'

-- Fixture B: a second household, DIFFERENT values incl. thousands separator.
\set fxB_amount E'Valor a pagar: R$ 1.234,99'
\set fxB_due    E'Vencimento: 03/12/2025'
\set fxB_cust   E'Cliente: ANA BEATRIZ COSTA\n'

-- Fixture C: named-month reference + short 6-digit UC.
\set fxC_ref    E'Referência: Maio/2026'
\set fxC_inst   E'Unidade Consumidora: 654321'

-- Negative-case strings (no field / malformed field present).
\set negAmount  E'Conta paga, nada a cobrar este mês.'
\set negDue     E'Vencimento: 5/6/26'
\set negBarcode E'Codigo de referencia: 12345 67890'
\set negPix     E'PIX nao disponivel: 12345abc'
\set negRef     E'Periodo de consumo: 2026'
\set negInst    E'Unidade Consumidora: 123'
\set negCust    E'Cliente: 12345\n'
\set negAddr    E'Endereco nao rotulado nesta linha\n'


-- ============================================================================
-- 1. The seed produced exactly one ACTIVE enel-sp parser row (version 1).
-- ============================================================================
SELECT is(
  (SELECT count(*)::int FROM public.utility_parsers
     WHERE utility_key = 'enel-sp' AND active),
  1,
  '#1 seed: exactly one active enel-sp parser row is present'
);


-- ============================================================================
-- FIXTURE A — positive extraction for every regex column (8 assertions)
-- Each assertion pulls the pattern FROM the seeded row, then applies it to A.
-- ============================================================================
SELECT is(
  (regexp_match(:'fxA',
     (SELECT amount_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '234,56',
  '#2 amount_regex: extracts "234,56" from "Valor a pagar: R$ 234,56"'
);

SELECT is(
  (regexp_match(:'fxA',
     (SELECT due_date_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '15/06/2026',
  '#3 due_date_regex: extracts "15/06/2026" from "Vencimento: 15/06/2026"'
);

SELECT is(
  (regexp_match(:'fxA',
     (SELECT barcode_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '03399.12345 67890.123456 78901.234567 8 99990000023456',
  '#4 barcode_regex: extracts the 47-field linha digitável'
);

-- PIX: assert the captured EMV payload begins with the BR Code prefix 00020126.
SELECT matches(
  (regexp_match(:'fxA',
     (SELECT pix_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '^00020126',
  '#5 pix_regex: captures an EMV BR Code payload starting with "00020126"'
);

SELECT is(
  (regexp_match(:'fxA',
     (SELECT reference_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '05/2026',
  '#6 reference_regex: extracts numeric reference "05/2026"'
);

SELECT is(
  (regexp_match(:'fxA',
     (SELECT installation_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '123456789',
  '#7 installation_regex: extracts the 9-digit Unidade Consumidora'
);

SELECT is(
  (regexp_match(:'fxA',
     (SELECT customer_name_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  'MARIA DA SILVA SOUZA',
  '#8 customer_name_regex: extracts "MARIA DA SILVA SOUZA"'
);

SELECT is(
  (regexp_match(:'fxA',
     (SELECT service_address_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  'AV PAULISTA, 1578 - SAO PAULO/SP',
  '#9 service_address_regex: extracts the Local de Instalação line'
);


-- ============================================================================
-- FIXTURE B — distinct values prove the regexes generalise (3 assertions)
-- ============================================================================
SELECT is(
  (regexp_match(:'fxB_amount',
     (SELECT amount_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '1.234,99',
  '#10 amount_regex (fixture B): keeps thousands separator "1.234,99"'
);

SELECT is(
  (regexp_match(:'fxB_due',
     (SELECT due_date_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '03/12/2025',
  '#11 due_date_regex (fixture B): extracts "03/12/2025"'
);

SELECT is(
  (regexp_match(:'fxB_cust',
     (SELECT customer_name_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  'ANA BEATRIZ COSTA',
  '#12 customer_name_regex (fixture B): extracts "ANA BEATRIZ COSTA"'
);


-- ============================================================================
-- FIXTURE C — named-month reference branch + short UC (2 assertions)
-- ============================================================================
SELECT is(
  (regexp_match(:'fxC_ref',
     (SELECT reference_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  'Maio/2026',
  '#13 reference_regex (fixture C): matches named-month "Maio/2026" branch'
);

SELECT is(
  (regexp_match(:'fxC_inst',
     (SELECT installation_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1)))[1],
  '654321',
  '#14 installation_regex (fixture C): extracts a short 6-digit UC'
);


-- ============================================================================
-- SENDER / SUBJECT classification — positives (4 assertions)
-- ============================================================================
SELECT ok(
  EXISTS (SELECT 1 FROM public.utility_parsers up, unnest(up.sender_patterns) pat
            WHERE up.utility_key='enel-sp' AND up.version=1
              AND 'no-reply@enel.com.br' ~ pat),
  '#15 sender_patterns: matches a From of "no-reply@enel.com.br"'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.utility_parsers up, unnest(up.sender_patterns) pat
            WHERE up.utility_key='enel-sp' AND up.version=1
              AND 'cobranca@eletropaulo.com.br' ~ pat),
  '#16 sender_patterns: matches a legacy "eletropaulo" From'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.utility_parsers up, unnest(up.subject_patterns) pat
            WHERE up.utility_key='enel-sp' AND up.version=1
              AND 'Sua fatura Enel chegou' ~* pat),
  '#17 subject_patterns: matches Subject "Sua fatura Enel chegou"'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.utility_parsers up, unnest(up.subject_patterns) pat
            WHERE up.utility_key='enel-sp' AND up.version=1
              AND 'Sua conta de energia esta disponivel' ~* pat),
  '#18 subject_patterns: matches Subject "Sua conta de energia..."'
);


-- ============================================================================
-- NEGATIVE cases — every regex column rejects non-matching input (10 assertions)
-- ============================================================================
SELECT ok(
  (regexp_match(:'negAmount',
     (SELECT amount_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#19 amount_regex NEGATIVE: no "Valor a pagar" → no match'
);

-- Short/loose date "5/6/26" must not satisfy the \d{2}/\d{2}/\d{4} pattern.
SELECT ok(
  (regexp_match(:'negDue',
     (SELECT due_date_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#20 due_date_regex NEGATIVE: malformed "5/6/26" → no match'
);

SELECT ok(
  (regexp_match(:'negBarcode',
     (SELECT barcode_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#21 barcode_regex NEGATIVE: short numeric string → no match'
);

SELECT ok(
  (regexp_match(:'negPix',
     (SELECT pix_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#22 pix_regex NEGATIVE: too short / wrong prefix → no match'
);

SELECT ok(
  (regexp_match(:'negRef',
     (SELECT reference_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#23 reference_regex NEGATIVE: no "Referência:" label → no match'
);

SELECT ok(
  (regexp_match(:'negInst',
     (SELECT installation_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#24 installation_regex NEGATIVE: 3-digit UC (< 6) → no match'
);

SELECT ok(
  (regexp_match(:'negCust',
     (SELECT customer_name_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#25 customer_name_regex NEGATIVE: numeric name (no uppercase letter start) → no match'
);

SELECT ok(
  (regexp_match(:'negAddr',
     (SELECT service_address_regex FROM public.utility_parsers WHERE utility_key='enel-sp' AND version=1))) IS NULL,
  '#26 service_address_regex NEGATIVE: no "Local de Instalação:" label → no match'
);

SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.utility_parsers up, unnest(up.sender_patterns) pat
                WHERE up.utility_key='enel-sp' AND up.version=1
                  AND 'billing@vivo.com.br' ~ pat),
  '#27 sender_patterns NEGATIVE: an unrelated telecom From is rejected'
);

SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.utility_parsers up, unnest(up.subject_patterns) pat
                WHERE up.utility_key='enel-sp' AND up.version=1
                  AND 'Boleto da internet banda larga' ~* pat),
  '#28 subject_patterns NEGATIVE: an unrelated telecom Subject is rejected'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
