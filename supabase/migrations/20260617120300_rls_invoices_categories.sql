-- ============================================================================
-- Migration: 20260617120300_rls_invoices_categories.sql
-- Date:      2026-06-14
-- Task:      T-309 (subset: invoices + invoice_categories)
-- Purpose:   Habilita RLS e cria o conjunto de policies para public.invoices e
--            public.invoice_categories conforme §5.11:
--
--              invoices            — SELECT member-of household (+ sys admin);
--                                    INSERT/UPDATE/DELETE = member-of household.
--                                    (Faturas são MEMBER-writable: qualquer
--                                    membro pode criar/editar/marcar paga.)
--              invoice_categories  — SELECT member-of household (+ sys admin);
--                                    write = admin-of household (Pattern B).
--
--            ⚠️ Esta é a fatia invoices+categories do T-309. As demais tabelas
--            do T-309 original (utility_parsers, domain_events, sync_runs,
--            extraction_runs) ainda não existem (P4/P5 não construídos) e terão
--            sua RLS quando criadas.
--
-- Spec refs: §5.11 (matriz de policies — linhas "invoices" e "invoice_categories";
--                   Pattern A member-of SELECT, Pattern B admin-of write;
--                   precedente do sys-admin SELECT escape hatch, igual a
--                   connected_emails/households/members).
--            §5.3/§5.4 (definição das tabelas; deleted_at é app-level — RLS NÃO
--                   filtra deleted_at, para workers/audit verem tombstones).
--
-- Design notes:
--   * Usa os helpers de T-113: app.households_of_user() (SETOF uuid) e
--     app.is_household_admin(uuid). SELECT ... IN (SELECT app.households_of_user())
--     é o template member-of.
--   * invoices: write = member-of (NÃO admin). Distinção deliberada de
--     invoice_categories (admin-of write). Policies de write separadas
--     (insert/update/delete) com WITH CHECK espelhado no UPDATE para impedir
--     re-targeting de household_id para um household do qual o caller não é
--     membro (privilege escalation).
--   * invoice_categories: SELECT member-of via policy própria + write admin-of
--     via FOR ALL. São policies PERMISSIVAS (OR): um membro não-admin enxerga
--     via a policy _select mesmo sem casar a _admin_write. Mesmo padrão de
--     connected_email_households (T-210).
--   * sys-admin SELECT override (`OR app.is_system_admin()`) só em SELECT —
--     auditoria via UI sys-admin. SEM escalonamento de WRITE para sys admin
--     (consistente com o precedente; escrita destrutiva passa por service_role).
--   * service_role tem BYPASSRLS — NÃO criamos policies para ele (seriam dead
--     code). Workers/Edge Functions rodam com service_role.
--   * anon: toda policy é TO authenticated. Caller anônimo (auth.uid() IS NULL)
--     casa zero rows por construção.
--   * Idempotência: DROP POLICY IF EXISTS antes de cada CREATE POLICY (Postgres
--     não tem CREATE POLICY IF NOT EXISTS). ENABLE RLS é no-op se já habilitado.
--
-- Rollback:
--   * ALTER TABLE public.invoices DISABLE ROW LEVEL SECURITY;
--   * ALTER TABLE public.invoice_categories DISABLE ROW LEVEL SECURITY;
--   * DROP POLICY IF EXISTS ... para cada policy abaixo.
-- ============================================================================


-- ============================================================================
-- FORBIDDEN PATTERNS (enforced by convention + review)
-- ============================================================================
--   * DO NOT add explicit policies for service_role — BYPASSRLS por padrão.
--   * DO NOT grant anon any policy nessas tabelas.
--   * DO NOT use `USING (true)` em policy de write — todo write é scoped por
--     member-of (invoices) ou admin-of (invoice_categories).
--   * DO NOT grant sys admin WRITE via policy — só SELECT override.
--   * DO NOT filtrar deleted_at na RLS — o filtro de tombstone é app-level
--     (WHERE deleted_at IS NULL nas queries de listagem).
-- ============================================================================


-- ============================================================================
-- 1. invoices — SELECT member-of (+ sys admin); write = member-of household
-- ============================================================================
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- SELECT: membro do household OU sys admin (auditoria).
DROP POLICY IF EXISTS invoices_select ON public.invoices;
CREATE POLICY invoices_select ON public.invoices
  FOR SELECT
  TO authenticated
  USING (
    household_id IN (SELECT app.households_of_user())
    OR app.is_system_admin()
  );

-- INSERT: o household da nova fatura deve ser um do qual o caller é membro.
DROP POLICY IF EXISTS invoices_insert ON public.invoices;
CREATE POLICY invoices_insert ON public.invoices
  FOR INSERT
  TO authenticated
  WITH CHECK (
    household_id IN (SELECT app.households_of_user())
  );

-- UPDATE: membro do household. WITH CHECK espelhado impede mover a fatura para
-- um household do qual o caller NÃO é membro (privilege escalation via
-- re-targeting de household_id).
DROP POLICY IF EXISTS invoices_update ON public.invoices;
CREATE POLICY invoices_update ON public.invoices
  FOR UPDATE
  TO authenticated
  USING (
    household_id IN (SELECT app.households_of_user())
  )
  WITH CHECK (
    household_id IN (SELECT app.households_of_user())
  );

-- DELETE: membro do household. (Na prática o app usa soft-delete via UPDATE
-- deleted_at; hard DELETE existe para completude/admin via service_role.)
DROP POLICY IF EXISTS invoices_delete ON public.invoices;
CREATE POLICY invoices_delete ON public.invoices
  FOR DELETE
  TO authenticated
  USING (
    household_id IN (SELECT app.households_of_user())
  );


-- ============================================================================
-- 2. invoice_categories — SELECT member-of (+ sys admin); write = admin-of
-- ============================================================================
ALTER TABLE public.invoice_categories ENABLE ROW LEVEL SECURITY;

-- SELECT: qualquer membro do household OU sys admin.
DROP POLICY IF EXISTS invoice_categories_select ON public.invoice_categories;
CREATE POLICY invoice_categories_select ON public.invoice_categories
  FOR SELECT
  TO authenticated
  USING (
    household_id IN (SELECT app.households_of_user())
    OR app.is_system_admin()
  );

-- WRITE (INSERT/UPDATE/DELETE): apenas admin do household (Pattern B). WITH
-- CHECK espelhado impede re-targeting para household que o caller não administra.
DROP POLICY IF EXISTS invoice_categories_admin_write ON public.invoice_categories;
CREATE POLICY invoice_categories_admin_write ON public.invoice_categories
  FOR ALL
  TO authenticated
  USING (app.is_household_admin(household_id))
  WITH CHECK (app.is_household_admin(household_id));


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260617120300_rls_invoices_categories',
  'RLS habilitada + policies para public.invoices (SELECT member-of + sys admin; '
  'INSERT/UPDATE/DELETE member-of household, UPDATE com WITH CHECK espelhado) e '
  'public.invoice_categories (SELECT member-of + sys admin; write admin-of via '
  'FOR ALL). Subset invoices+categories do T-309. Usa helpers de T-113. Spec §5.11.'
)
ON CONFLICT (migration_name) DO NOTHING;
