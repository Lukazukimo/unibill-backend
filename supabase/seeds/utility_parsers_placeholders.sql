-- ============================================================================
-- Seed:      utility_parsers_placeholders.sql
-- Date:      2026-06-20
-- Task:      T-314
-- Purpose:   Placeholders inativos para sabesp / comgas / vivo. Reservam o
--            utility_key e tornam visível no admin o que falta popular. Como
--            active=false, o worker (que filtra active=true) NUNCA os casa.
--            Conteúdo real (regex) será populado após coletar amostras reais.
-- Spec refs: §5.4 ("demais parsers seguem mesma estrutura — populados depois")
--
-- Idempotência: ON CONFLICT (utility_key, version) DO NOTHING.
-- sender_patterns é NOT NULL → um padrão claramente-bogus; demais regex NULL.
-- ============================================================================

INSERT INTO public.utility_parsers (
  utility_key, display_name, default_category, version, active, notes,
  sender_patterns
) VALUES
  ('sabesp', 'Sabesp', 'Água', 1, false,
   'Placeholder — populate from real fixtures before activating',
   ARRAY['__placeholder_inactive__']),
  ('comgas', 'Comgás', 'Gás', 1, false,
   'Placeholder — populate from real fixtures before activating',
   ARRAY['__placeholder_inactive__']),
  ('vivo', 'Vivo', 'Telefonia', 1, false,
   'Placeholder — populate from real fixtures before activating',
   ARRAY['__placeholder_inactive__'])
ON CONFLICT (utility_key, version) DO NOTHING;
