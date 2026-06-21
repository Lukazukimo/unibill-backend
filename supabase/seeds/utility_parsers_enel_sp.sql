-- ============================================================================
-- Seed:      utility_parsers_enel_sp.sql
-- Date:      2026-06-20
-- Task:      T-313
-- Purpose:   Parser MVP da Enel São Paulo (Layer 3) — conjunto completo de
--            regex verificado contra emails reais 2024-2026. Uma row
--            active=true, version=1. É o primeiro parser real do sistema.
-- Spec refs: §5.4 (seed enel-sp verbatim)
--
-- Idempotência: ON CONFLICT (utility_key, version) DO NOTHING.
-- consumption_extractor fica NULL (MVP).
-- ============================================================================

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
