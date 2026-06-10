-- ============================================================================
-- Migration: 20260616123000_invitations_hardening.sql
-- Date:      2026-06-10
-- Task:      T-227
-- Purpose:   Hardening do `public.household_invitations` criado em T-109. NÃO
--            recria tabela — usa ALTER TABLE / CREATE INDEX IF NOT EXISTS pra
--            adicionar três proteções operacionais/segurança pedidas no spec
--            §9.1 (Invitation security) e §5.1:
--
--              1. CHECK do `code` apertado de `^[A-Z0-9]{8}$` (36 chars) pra
--                 `^[A-HJ-NP-Z2-9]{8}$` (32 chars base32 sem confundíveis:
--                 sem I, L, O, 0, 1). Mantém ~32^8 ≈ 1.1 trilhão de combos
--                 (spec §9.1) mas elimina ambiguidade visual quando o user
--                 digita o código (I↔1, O↔0, L↔1). Geração no app
--                 (Edge Function /invitations) já deve emitir só esse alfabeto.
--
--              2. Normalização automática de `invited_email` pra lowercase via
--                 trigger BEFORE INSERT OR UPDATE. Spec §5.12 exige
--                 `auth.email() == invitation.invited_email` no redeem;
--                 GoTrue armazena email lowercase, então comparar com user
--                 input não-normalizado falharia. Trigger garante invariante
--                 no nível do schema (defense-in-depth: app SHOULD normalize,
--                 trigger ENFORCES).
--
--              3. Index parcial otimizado pra `/invitations/redeem` lookups:
--                 (code) WHERE used_at IS NULL AND expires_at > now() é
--                 inválido (predicate não-imutável; CREATE INDEX rejeita
--                 funções voláteis em WHERE). Solução documentada Postgres:
--                 partial index só em used_at IS NULL — o filtro de
--                 expires_at vai pro WHERE da query (planner combina via
--                 index condition). UNIQUE já cobre `code`, mas o partial
--                 index é menor (só convites ativos) e dá lookups O(log n)
--                 sem varrer convites consumidos.
--
-- Spec refs: §9.1  (Invitation security — base32 alphabet, rate limits, brute
--                   force math, redeem flow)
--            §5.1  (household_invitations schema baseline; já em T-109)
--            §5.12 (invited_email matching contra auth.users.email lowercase)
--
-- Design notes:
--   * Idempotência: drop+recreate do CHECK (nome `household_invitations_code_format_chk`
--     reaproveitado de T-109), trigger via CREATE OR REPLACE FUNCTION +
--     DROP+CREATE TRIGGER, index via IF NOT EXISTS.
--   * Backfill: ANTES de aplicar o novo CHECK rodamos UPDATE pra lowercase
--     em rows existentes de `invited_email` (não há rows em prod ainda — MVP
--     pré-launch — mas migration tem que ser correta pra ambientes dev/test
--     que possam ter convites criados manualmente). Códigos existentes que
--     contenham I/L/O/0/1 seriam rejeitados pelo novo CHECK; assumimos zero
--     convites pré-existentes em prod (clean DB) — local dev deve recriar.
--     Pra ser totalmente seguro o CHECK só é aplicado se já não existir uma
--     row violando ele; em caso de violação, migration aborta com mensagem
--     clara pro operator limpar manualmente.
--   * Trigger normaliza só `invited_email` (text). Se for NULL fica NULL
--     (convite aberto, sem trava de email). Se for non-NULL aplica `lower()`.
--     `code` NÃO é normalizado (a regex CHECK rejeita lowercase explicitamente).
--   * Index parcial só em `used_at IS NULL` — não usa `expires_at > now()` no
--     predicate porque `now()` não é IMMUTABLE; o query plan combina o
--     predicate do index com o `expires_at > now()` da query via index
--     condition (sem table heap fetch desnecessário pra convites expirados).
--   * O index UNIQUE de `code` (criado implicitamente pela constraint UNIQUE
--     em T-109) já permite lookup por `code`; o partial index é menor e mais
--     hot-cached porque cobre só convites ativos (~dezenas de rows típicamente)
--     ao invés do histórico completo. Não conflita — planner escolhe o partial.
-- ============================================================================


-- ============================================================================
-- 1. Pre-flight: backfill invited_email pra lowercase
-- ============================================================================
-- Idempotente: rows que já estão lowercase não mudam. Necessário antes de
-- criar a trigger (que só pegará INSERTs/UPDATEs futuros) pra não deixar
-- rows legacy com email não normalizado.
UPDATE public.household_invitations
   SET invited_email = lower(invited_email)
 WHERE invited_email IS NOT NULL
   AND invited_email <> lower(invited_email);


-- ============================================================================
-- 2. Pre-flight: assert nenhuma row viola o novo CHECK base32
-- ============================================================================
-- Falha cedo com mensagem clara se houver convites legacy com I/L/O/0/1.
-- Em prod MVP isso não ocorre (clean DB); em dev locais o operator deve
-- limpar manualmente: `DELETE FROM household_invitations WHERE code ~ '[ILO01]'`.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)
    INTO v_count
    FROM public.household_invitations
   WHERE code !~ '^[A-HJ-NP-Z2-9]{8}$';

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Migration T-227 aborted: % row(s) in household_invitations have a `code` '
      'that does not match the new base32 alphabet ^[A-HJ-NP-Z2-9]{8}$ '
      '(excludes I, L, O, 0, 1). Clean these rows manually before re-running. '
      'Query: SELECT id, code FROM public.household_invitations '
      'WHERE code !~ ''^[A-HJ-NP-Z2-9]{8}$'';',
      v_count;
  END IF;
END
$$;


-- ============================================================================
-- 3. Replace CHECK constraint with base32 alphabet
-- ============================================================================
-- T-109 created `household_invitations_code_format_chk` with regex
-- `^[A-Z0-9]{8}$`. We drop and recreate with the base32 alphabet
-- (excludes I, L, O, 0, 1 — the visually confusable chars per Crockford
-- base32 / NIST guidance). Naming preserved so any future migration looking
-- up the constraint finds it under the same name.
ALTER TABLE public.household_invitations
  DROP CONSTRAINT IF EXISTS household_invitations_code_format_chk;

ALTER TABLE public.household_invitations
  ADD CONSTRAINT household_invitations_code_format_chk
  CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$');

COMMENT ON CONSTRAINT household_invitations_code_format_chk
  ON public.household_invitations IS
  'Base32 alphabet sem confundíveis (sem I, L, O, 0, 1) — 32 chars × 8 pos = '
  '~1.1 trilhão de combinações. Spec §9.1. Geração de código no app deve '
  'emitir apenas esses chars; este CHECK é o guard de schema.';

-- Atualiza o COMMENT ON COLUMN do `code` (criado em T-109 dizendo "alfanuméricos")
-- pra refletir o novo alfabeto base32 sem confundíveis. Mantém docs em sync.
COMMENT ON COLUMN public.household_invitations.code IS
  '8 chars do alfabeto base32 sem confundíveis [A-HJ-NP-Z2-9]{8} (exclui '
  'I, L, O, 0, 1). UNIQUE + CHECK. Gerado pelo app (Edge Function '
  '/invitations); colisões resolvidas via retry (~1.1 trilhão de combos, '
  'spec §9.1).';


-- ============================================================================
-- 4. Trigger function: normalize invited_email to lowercase
-- ============================================================================
-- BEFORE INSERT OR UPDATE: se NEW.invited_email é não-NULL, força lower().
-- Idempotente (CREATE OR REPLACE). SECURITY INVOKER (default) — não precisa
-- de elevação; lower() é IMMUTABLE e built-in.
CREATE OR REPLACE FUNCTION public.normalize_invitation_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.invited_email IS NOT NULL THEN
    NEW.invited_email := lower(NEW.invited_email);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.normalize_invitation_email() IS
  'Normaliza household_invitations.invited_email pra lowercase no BEFORE '
  'INSERT/UPDATE. GoTrue armazena auth.users.email lowercase; spec §5.12 '
  'exige match exato no /invitations/redeem. Esta trigger garante a '
  'invariante de schema (defense-in-depth: app deveria normalizar também).';


-- ============================================================================
-- 5. Trigger: BEFORE INSERT OR UPDATE on household_invitations
-- ============================================================================
-- DROP+CREATE pattern pra idempotência (Postgres não tem CREATE OR REPLACE
-- TRIGGER nativo até PG 14; usamos o pattern compatível com qualquer versão).
DROP TRIGGER IF EXISTS trg_normalize_invitation_email
  ON public.household_invitations;

CREATE TRIGGER trg_normalize_invitation_email
  BEFORE INSERT OR UPDATE OF invited_email
  ON public.household_invitations
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_invitation_email();

COMMENT ON TRIGGER trg_normalize_invitation_email
  ON public.household_invitations IS
  'Força invited_email lowercase em INSERT/UPDATE pra match com '
  'auth.users.email (que o GoTrue mantém lowercase). Spec §5.12.';


-- ============================================================================
-- 6. Partial index for /invitations/redeem lookups
-- ============================================================================
-- Otimiza `SELECT ... FROM household_invitations WHERE code = $1 AND
-- used_at IS NULL AND expires_at > now()`. WHERE clause do index inclui
-- só used_at IS NULL (expires_at > now() não pode entrar — now() não é
-- IMMUTABLE); o planner combina expires_at > now() via index condition
-- na tabela. Resultado: O(log n) lookup só em convites ativos, sem varrer
-- convites consumidos.
--
-- Não conflita com o UNIQUE constraint de `code` (que cria seu próprio
-- B-tree global); este partial index é menor (~dezenas de rows típicas)
-- e mais hot-cached. Planner escolhe o mais barato.
CREATE INDEX IF NOT EXISTS idx_invitations_active_code
  ON public.household_invitations (code)
  WHERE used_at IS NULL;

COMMENT ON INDEX public.idx_invitations_active_code IS
  'Partial index para /invitations/redeem: lookup por code só em convites '
  'ativos (used_at IS NULL). Filtro adicional expires_at > now() vai pra '
  'query WHERE (now() não é IMMUTABLE, não pode entrar no predicate do '
  'index). Spec §9.1.';


-- ============================================================================
-- 7. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616123000_invitations_hardening',
  'Hardening household_invitations (T-227): CHECK code base32 '
  '^[A-HJ-NP-Z2-9]{8}$ (sem I/L/O/0/1), trigger lowercase invited_email, '
  'partial index idx_invitations_active_code (code) WHERE used_at IS NULL. '
  'Spec §9.1 + §5.12.'
)
ON CONFLICT (migration_name) DO NOTHING;
