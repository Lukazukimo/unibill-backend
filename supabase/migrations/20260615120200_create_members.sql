-- ============================================================================
-- Migration: 20260615120200_create_members.sql
-- Date:      2026-06-10
-- Task:      T-108
-- Purpose:   Create the `member_role` enum and the `public.members` table
--            (junction between households and auth users with role + soft-delete),
--            plus a partial UNIQUE index that permits re-adding a user after
--            soft-delete, and the `enforce_min_one_admin()` trigger that
--            guarantees a household never loses its last admin (covers role
--            demotion, soft-delete and hard-delete paths). Attaches the
--            shared `app.set_updated_at()` trigger created in T-107.
-- Spec refs: §5.1  (members table + member_role enum + partial unique index +
--                   enforce_min_one_admin function/trigger),
--            §5.10 (Approach A: audit columns like `invited_by` are plain uuid
--                   with NO FK to auth.users — same shape as households).
--
-- CRITICAL FIX (tech-2, per plan T-108):
--   BEFORE DELETE triggers MUST return OLD (NEW is NULL in DELETE; returning
--   NEW/NULL silently aborts the row operation). BEFORE UPDATE triggers MUST
--   return NEW (so the modified row is what actually gets written). The
--   function explicitly branches on TG_OP to return the correct record.
--
-- Design notes:
--   * `member_role` enum lives in `public` (referenced by both `members` and
--     `household_invitations` in T-109). Created idempotently via DO block —
--     CREATE TYPE has no IF NOT EXISTS shortcut.
--   * `user_id` HAS a FK to `auth.users(id)` — it is ownership (per spec §5.10
--     "Distinção importante" callout: `user_id` columns are real ownership and
--     keep their FK; audit columns like `invited_by` are uuid-only).
--   * `household_id` HAS a FK to `public.households(id)` — also real ownership
--     of a member-of relationship; cascade is intentionally NOT used so a
--     household delete must explicitly cascade through application logic
--     (anonymize / hard-delete flows handle this in §9.4).
--   * `invited_by` is plain `uuid` (NO FK) per §5.10 Approach A.
--   * Partial unique index `uq_members_household_user_active` enforces
--     "one active membership per (household, user)" while WHERE deleted_at
--     IS NULL — allowing the same user to be re-added after a soft-delete
--     without dropping the historical row.
--   * The `enforce_min_one_admin()` trigger is attached BEFORE UPDATE OR DELETE
--     (one trigger handling both — Postgres allows this for FOR EACH ROW
--     triggers). It checks three "admin removal" scenarios: role demotion,
--     soft-delete of an admin row, and hard-delete of an admin row.
--   * Idempotent: CREATE TABLE/INDEX use IF NOT EXISTS; CREATE TYPE wrapped in
--     DO block; trigger function uses CREATE OR REPLACE; trigger uses DROP+
--     CREATE.
-- ============================================================================


-- ============================================================================
-- 1. Enum: public.member_role
-- ============================================================================
-- Two roles only (admin, member). 'admin' can invite/remove members, manage
-- household settings, see all member invoices. 'member' can only see own
-- invoices + household-shared categories. Used by `members.role` and
-- `household_invitations.role` (T-109).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'member_role' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.member_role AS ENUM ('admin', 'member');
  END IF;
END
$$;

COMMENT ON TYPE public.member_role IS
  'Papel de um membro num household. admin: gerencia membros, settings e vê tudo. '
  'member: vê apenas próprias faturas + categorias compartilhadas. Spec §5.1.';


-- ============================================================================
-- 2. members — junction table household ↔ auth user, with role + soft-delete
-- ============================================================================
-- Each row represents an active OR historical membership. RLS (T-114) ensures
-- a user só vê membros dos households a que pertence; admins veem all rows in
-- their households.
--
-- FK shape per spec §5.10:
--   * household_id → public.households(id) [ownership, keep FK]
--   * user_id      → auth.users(id)        [ownership, keep FK]
--   * invited_by   → (uuid, no FK)         [audit, Approach A]
CREATE TABLE IF NOT EXISTS public.members (
  id            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES public.households(id),
  user_id       uuid NOT NULL REFERENCES auth.users(id), -- AUDIT-FK-OK: ownership (member-of-household belongs to user)
  role          public.member_role NOT NULL DEFAULT 'member',
  invited_by    uuid,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

COMMENT ON TABLE public.members IS
  'Junção household ↔ auth.users com role e soft-delete. Partial unique index '
  'em (household_id, user_id) WHERE deleted_at IS NULL permite re-add após '
  'soft-delete. Trigger enforce_min_one_admin garante que nenhum household '
  'fique sem admin. Spec §5.1.';

COMMENT ON COLUMN public.members.id IS
  'PK gerado por gen_random_uuid().';
COMMENT ON COLUMN public.members.household_id IS
  'FK pra public.households(id). Ownership real — mantém FK (§5.10).';
COMMENT ON COLUMN public.members.user_id IS
  'FK pra auth.users(id). Ownership real — mantém FK (§5.10 callout: '
  'colunas user_id são ownership, audit columns como invited_by não têm FK).';
COMMENT ON COLUMN public.members.role IS
  'Papel do membro neste household (admin|member). Default member; '
  'primeiro membro de um household criado pelo trigger de bootstrap será admin.';
COMMENT ON COLUMN public.members.invited_by IS
  'UUID de quem convidou (uuid puro, SEM FK — §5.10 Approach A). NULL para '
  'o criador do household ou para joins via sistema (system_admin_bootstrap).';
COMMENT ON COLUMN public.members.joined_at IS
  'Quando o usuário aceitou o convite (ou foi adicionado). Distinto de created_at '
  'pra casos onde a row é criada antes do aceite (não aplicável no MVP, mas reservado).';
COMMENT ON COLUMN public.members.created_at IS
  'Timestamp de criação da row (imutável).';
COMMENT ON COLUMN public.members.updated_at IS
  'Atualizado automaticamente via trigger app.set_updated_at().';
COMMENT ON COLUMN public.members.deleted_at IS
  'Soft-delete marker. NULL = membro ativo; NOT NULL = removido. Partial unique '
  'index ignora rows com deleted_at NOT NULL, permitindo re-add do mesmo usuário.';


-- ============================================================================
-- 3. Partial UNIQUE index: one active membership per (household, user)
-- ============================================================================
-- Permite que um usuário seja re-adicionado a um household após soft-delete
-- (a row antiga fica histórica com deleted_at preenchido, fora do índice;
-- a nova row entra como única com deleted_at IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_household_user_active
  ON public.members (household_id, user_id)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.uq_members_household_user_active IS
  'Garante no máximo 1 membership ativa por (household_id, user_id). '
  'Partial WHERE deleted_at IS NULL permite re-add após soft-delete. Spec §5.1.';


-- ============================================================================
-- 4. Trigger function: public.enforce_min_one_admin()
-- ============================================================================
-- Bloqueia qualquer operação que removeria o último admin de um household.
-- Três cenários cobertos:
--   (a) UPDATE — rebaixamento: role admin → member
--   (b) UPDATE — soft-delete:  deleted_at NULL → NOT NULL, com role='admin'
--   (c) DELETE — hard-delete de uma row admin ativa
--
-- CRITICAL (tech-2): BEFORE DELETE trigger MUST RETURN OLD; BEFORE UPDATE
-- trigger MUST RETURN NEW. Retornar NULL aborta a operação silenciosamente,
-- retornar OLD num UPDATE descarta as mudanças, retornar NEW num DELETE
-- causa erro (NEW é NULL). Branch explícito em TG_OP garante semântica.
CREATE OR REPLACE FUNCTION public.enforce_min_one_admin() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_admin_removal boolean := false;
  remaining_admins int;
BEGIN
  -- ---- Detecta os 3 cenários de "remoção de admin" ----
  IF TG_OP = 'UPDATE' THEN
    -- (a) Rebaixamento explícito de role
    IF OLD.role = 'admin' AND NEW.role <> 'admin' THEN
      is_admin_removal := true;
    -- (b) Soft-delete de uma row que era admin ativa
    ELSIF OLD.deleted_at IS NULL
      AND NEW.deleted_at IS NOT NULL
      AND OLD.role = 'admin'
    THEN
      is_admin_removal := true;
    END IF;
  ELSIF TG_OP = 'DELETE'
    AND OLD.role = 'admin'
    AND OLD.deleted_at IS NULL
  THEN
    -- (c) Hard-delete de admin ativo (raro, mas cobrir explicitamente)
    is_admin_removal := true;
  END IF;

  -- ---- Se for remoção de admin, conta admins restantes ativos ----
  IF is_admin_removal THEN
    SELECT count(*) INTO remaining_admins
      FROM public.members
     WHERE household_id = OLD.household_id
       AND role         = 'admin'
       AND deleted_at   IS NULL
       AND id           <> OLD.id;

    IF remaining_admins = 0 THEN
      RAISE EXCEPTION 'Cannot remove the last admin of household %', OLD.household_id;
    END IF;
  END IF;

  -- ---- Retorno correto por tipo de operação (tech-2 critical fix) ----
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;   -- BEFORE DELETE: NEW é NULL; devolver OLD permite a operação seguir
  ELSE
    RETURN NEW;   -- BEFORE UPDATE: devolve NEW pra persistir as mudanças
  END IF;
END;
$$;

COMMENT ON FUNCTION public.enforce_min_one_admin() IS
  'Trigger BEFORE UPDATE OR DELETE em public.members. Bloqueia rebaixar/soft-'
  'deletar/hard-deletar o último admin de um household. Retorna OLD em DELETE '
  'e NEW em UPDATE (critical fix tech-2: NEW é NULL em DELETE; retornar NULL '
  'aborta a operação silenciosamente). Spec §5.1.';


-- ============================================================================
-- 5. Triggers on members
-- ============================================================================
-- (a) enforce_min_one_admin — BEFORE UPDATE OR DELETE
DROP TRIGGER IF EXISTS trg_min_one_admin ON public.members;
CREATE TRIGGER trg_min_one_admin
  BEFORE UPDATE OR DELETE ON public.members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_min_one_admin();

-- (b) set_updated_at — BEFORE UPDATE (shared helper from T-107)
DROP TRIGGER IF EXISTS trg_members_set_updated_at ON public.members;
CREATE TRIGGER trg_members_set_updated_at
  BEFORE UPDATE ON public.members
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 6. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120200_create_members',
  'Tabela public.members + enum public.member_role + partial unique index '
  'uq_members_household_user_active + trigger enforce_min_one_admin (OLD/NEW '
  'correto por TG_OP, tech-2 critical fix) + trigger set_updated_at.'
)
ON CONFLICT (migration_name) DO NOTHING;
