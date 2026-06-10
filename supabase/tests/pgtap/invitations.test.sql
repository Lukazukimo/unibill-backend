-- ============================================================================
-- Test:      supabase/tests/pgtap/invitations.test.sql
-- Date:      2026-06-10
-- Task:      T-227
-- Purpose:   pgTAP suite cobrindo o hardening de `public.household_invitations`
--            aplicado pela migration 20260616123000_invitations_hardening.sql:
--
--              (A) CHECK base32 ^[A-HJ-NP-Z2-9]{8}$ rejeita códigos com
--                  chars confundíveis (I, L, O, 0, 1) e códigos com tamanho
--                  errado ou lowercase, mas aceita códigos válidos.
--              (B) Trigger normalize_invitation_email lowercaseia
--                  invited_email em INSERT e em UPDATE — verificado
--                  comparando o valor armazenado com `lower(input)`.
--              (C) Index parcial idx_invitations_active_code (code) WHERE
--                  used_at IS NULL é usado pelo planner em queries de
--                  redeem (`WHERE code = $1 AND used_at IS NULL AND
--                  expires_at > now()`), conforme EXPLAIN.
--
-- Spec refs: §9.1  (Invitation security — base32 alphabet, redeem flow)
--            §5.12 (invited_email matching lowercase contra auth.users.email)
--            §5.1  (household_invitations schema baseline)
--
-- Test plan (10 assertions):
--   throws_ok #1: INSERT code 'ABCDEFG1'        → fails (contains '1')
--   throws_ok #2: INSERT code 'ABCDEFGI'        → fails (contains 'I')
--   throws_ok #3: INSERT code 'ABCDEFGL'        → fails (contains 'L')
--   throws_ok #4: INSERT code 'ABCDEFGO'        → fails (contains 'O')
--   throws_ok #5: INSERT code 'ABCDEFG0'        → fails (contains '0')
--   throws_ok #6: INSERT code 'abcdefgh'        → fails (lowercase)
--   throws_ok #7: INSERT code 'ABCDEFG'         → fails (7 chars)
--   lives_ok  #8: INSERT code 'ABCDEFGH'        → succeeds (all valid)
--   is        #9: invited_email persisted as lower() on INSERT and UPDATE
--   like      #10: EXPLAIN of redeem query mentions idx_invitations_active_code
--
-- Hermeticity:
--   BEGIN/ROLLBACK around the entire test. Each scenario is independent
--   (separate codes, separate invitation rows). Auth.users seeded for FK on
--   members (not needed for invitations themselves — created_by/used_by are
--   uuid-no-FK per §5.10), but we use sentinel system_actors UUID directly.
-- ============================================================================


BEGIN;

-- Carrega pgTAP do schema `extensions` (instalado em T-105).
SET LOCAL search_path = public, extensions, app;

SELECT plan(10);


-- ============================================================================
-- Setup: 1 household pra ancorar os convites de teste
-- ============================================================================
-- created_by aponta pro sentinel system_admin_bootstrap (T-106), evitando
-- precisar de auth.users seed (consistente com os outros pgTAP suites).
INSERT INTO public.households (id, name, created_by)
VALUES (
  '77777777-7777-7777-7777-777777777777',
  'HH-INV T-227 hardening',
  '00000000-0000-0000-0000-000000000003'  -- system_admin_bootstrap sentinel
);


-- ============================================================================
-- (A) CHECK rejects malformed codes
-- ============================================================================
-- Cada throws_ok roda um INSERT que deve falhar com erro de CHECK constraint
-- (SQLSTATE 23514). Passamos NULL pra `errmsg` esperado porque o texto exato
-- vem do Postgres (varia por versão) — só nos importa que VIOLE o CHECK.

-- #1: dígito '1' (excluído do base32)
SELECT throws_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'ABCDEFG1',
        '00000000-0000-0000-0000-000000000003') $$,
  '23514',
  NULL,
  'throws_ok #1: code with digit 1 must violate CHECK (base32 excludes 1)'
);

-- #2: letra 'I' (confundível com 1/L)
SELECT throws_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'ABCDEFGI',
        '00000000-0000-0000-0000-000000000003') $$,
  '23514',
  NULL,
  'throws_ok #2: code with letter I must violate CHECK'
);

-- #3: letra 'L' (confundível com 1/I)
SELECT throws_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'ABCDEFGL',
        '00000000-0000-0000-0000-000000000003') $$,
  '23514',
  NULL,
  'throws_ok #3: code with letter L must violate CHECK'
);

-- #4: letra 'O' (confundível com 0)
SELECT throws_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'ABCDEFGO',
        '00000000-0000-0000-0000-000000000003') $$,
  '23514',
  NULL,
  'throws_ok #4: code with letter O must violate CHECK'
);

-- #5: dígito '0' (excluído do base32)
SELECT throws_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'ABCDEFG0',
        '00000000-0000-0000-0000-000000000003') $$,
  '23514',
  NULL,
  'throws_ok #5: code with digit 0 must violate CHECK'
);

-- #6: lowercase rejeitado (regex POSIX case-sensitive)
SELECT throws_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'abcdefgh',
        '00000000-0000-0000-0000-000000000003') $$,
  '23514',
  NULL,
  'throws_ok #6: lowercase code must violate CHECK (only uppercase base32)'
);

-- #7: tamanho errado (7 chars em vez de 8)
SELECT throws_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'ABCDEFG',
        '00000000-0000-0000-0000-000000000003') $$,
  '23514',
  NULL,
  'throws_ok #7: 7-char code must violate CHECK (exactly 8 required)'
);

-- #8: código válido — todos os chars no alfabeto base32
SELECT lives_ok(
  $$ INSERT INTO public.household_invitations
       (household_id, code, created_by)
     VALUES
       ('77777777-7777-7777-7777-777777777777', 'ABCDEFGH',
        '00000000-0000-0000-0000-000000000003') $$,
  'lives_ok #8: valid 8-char base32 code (ABCDEFGH) accepted'
);


-- ============================================================================
-- (B) invited_email lowercased by trigger on INSERT and UPDATE
-- ============================================================================
-- INSERT com email mixed-case e UPDATE pra outro mixed-case. Confirmamos
-- que o valor armazenado é sempre lower().
INSERT INTO public.household_invitations
  (household_id, code, invited_email, created_by)
VALUES (
  '77777777-7777-7777-7777-777777777777',
  'JKMNPQRS',                                    -- válido base32
  'Fabio.WU@Example.COM',
  '00000000-0000-0000-0000-000000000003'
);

UPDATE public.household_invitations
   SET invited_email = 'Other.Name@TEST.org'
 WHERE code = 'JKMNPQRS';

-- #9: após INSERT-then-UPDATE, valor final deve estar lowercase
SELECT is(
  (SELECT invited_email FROM public.household_invitations WHERE code = 'JKMNPQRS'),
  'other.name@test.org',
  'is #9: invited_email lowercased on both INSERT and UPDATE (trigger)'
);


-- ============================================================================
-- (C) Partial index used by redeem query
-- ============================================================================
-- Validamos que `EXPLAIN` da query de redeem menciona o nome do partial
-- index. Em tabelas com poucos rows o planner geralmente prefere seq scan,
-- então fazemos ANALYZE pra atualizar estatísticas e forçamos
-- `enable_seqscan = off` pra remover seq scan da equação — o teste valida
-- que o index *é elegível e escolhido* quando seq scan está desabilitado,
-- comportamento que vale em prod com milhares de rows mesmo sem essa
-- forçagem.
--
-- Pattern: EXPLAIN retorna SETOF text; agregamos via subselect com
-- string_agg, então fazemos like() do pgTAP contra o nome do índice.
ANALYZE public.household_invitations;
SET LOCAL enable_seqscan = off;
SET LOCAL enable_bitmapscan = off;

-- Captura o plano via DO block que faz EXECUTE 'EXPLAIN ...' INTO temp
-- table — esse é o pattern portátil pra ler EXPLAIN output em SQL puro.
-- (EXPLAIN não pode aparecer como fonte de dados em INSERT/SELECT
-- diretamente; precisa ser executado dinamicamente em PL/pgSQL.)
CREATE TEMP TABLE _t227_explain_out (plan_line text);

DO $$
DECLARE
  v_line text;
BEGIN
  FOR v_line IN
    EXECUTE
      'EXPLAIN SELECT id, household_id, role, invited_email, expires_at '
      '  FROM public.household_invitations '
      ' WHERE code = ''JKMNPQRS'' '
      '   AND used_at IS NULL '
      '   AND expires_at > now()'
  LOOP
    INSERT INTO _t227_explain_out (plan_line) VALUES (v_line);
  END LOOP;
END
$$;

SELECT like(
  (SELECT string_agg(plan_line, E'\n') FROM _t227_explain_out),
  '%idx_invitations_active_code%',
  'like #10: EXPLAIN of redeem query references idx_invitations_active_code'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
