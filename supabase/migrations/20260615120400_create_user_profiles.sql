-- ============================================================================
-- Migration: 20260615120400_create_user_profiles.sql
-- Date:      2026-06-10
-- Task:      T-110
-- Purpose:   Create `public.user_profiles` table (display-friendly user data
--            decoupled from `auth.users.raw_user_meta_data`, which is mutable
--            by the user via the JS SDK and explicitly NOT recommended by
--            Supabase for trustworthy display fields). Adds:
--              1. `create_user_profile()` SECURITY DEFINER trigger function;
--              2. trigger `trg_create_user_profile` AFTER INSERT ON auth.users
--                 that auto-creates the matching profile row on signup; and
--              3. trigger `trg_user_profiles_set_updated_at` BEFORE UPDATE
--                 that bumps `updated_at` via `app.set_updated_at()`.
-- Spec refs: §5.12 (user_profiles table + create_user_profile trigger)
--            §5.10 (user_display_name helper consults user_profiles first)
--
-- Design notes:
--   * `user_id` is the PK *and* the FK back to `auth.users(id)` —
--     ON DELETE CASCADE guarantees that wiping a user (LGPD hard-delete in
--     §9.4) auto-removes the profile row. This is the single column in the
--     schema where an FK to `auth.users` is allowed (spec §5.10): rows here
--     mirror live `auth.users` exclusively; once the user is gone we want the
--     profile gone too. All *other* user-referencing columns (created_by,
--     updated_by, paid_by, invited_by, …) intentionally OMIT the FK so they
--     can re-target a `system_actors(id)` post-anonymize (Approach A §5.10).
--   * `display_name` is NOT NULL — every profile must render *something*.
--     The trigger guarantees a value at signup: prefer `raw_user_meta_data
--     ->>'display_name'` (set by sign-up payload), fall back to
--     `split_part(email, '@', 1)` (local-part of email, never NULL for
--     email-auth signups in the MVP).
--   * `locale`/`theme` use plain text + CHECK rather than enums — values
--     are small, expected to stabilize, and CHECKs are cheaper to evolve
--     than enums (no `ALTER TYPE ... ADD VALUE` rituals). pt-BR is default
--     locale (primary market); 'system' is default theme (matches OS).
--   * `create_user_profile()` is SECURITY DEFINER + `SET search_path = public`
--     — required because the trigger fires under arbitrary callers (incl.
--     the Supabase GoTrue service role during signup) and would otherwise be
--     vulnerable to search_path hijacking. SECURITY DEFINER also lets it
--     write into `public.user_profiles` even when the inserter (anon role
--     during signup) has no direct INSERT grant — this is the explicit
--     pattern recommended by Supabase for `on_auth_user_created` triggers.
--   * The trigger uses `INSERT … ON CONFLICT (user_id) DO NOTHING` so a
--     re-fire (e.g. if the migration is replayed in dev, or auth.users is
--     re-inserted with the same id in a pgTAP test) is a no-op rather than
--     a hard failure that would crash signup.
--   * Trigger lives on `auth.users` (managed schema). Supabase Cloud allows
--     `AFTER INSERT` triggers from service_role-applied migrations — this
--     is the documented pattern (see Supabase docs: "Managing User Data /
--     Sync user data to public schema"). If the migration is ever blocked
--     by future policy changes, the fallback is an Edge Function on the
--     `user.signed_up` auth webhook (T-110 follow-up — not needed for MVP).
--   * Indexes: PK on user_id is enough. We deliberately do NOT add a
--     `display_name` index — searches are scoped per household via a join,
--     and adding one would invite tempting-but-wrong global lookups.
--   * RLS is enabled and policy-bound in T-114 (separate migration).
--   * Idempotent: CREATE TABLE IF NOT EXISTS; CREATE OR REPLACE FUNCTION;
--     DROP TRIGGER IF EXISTS + CREATE TRIGGER; CHECK adds inside DO blocks.
-- ============================================================================


-- ============================================================================
-- 1. user_profiles — display-friendly user data
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, -- AUDIT-FK-OK: 1:1 ownership (user_profile is per-user, cascade on user delete)
  display_name text NOT NULL,
  avatar_url   text,
  locale       text NOT NULL DEFAULT 'pt-BR'
               CHECK (locale IN ('pt-BR', 'en-US')),
  theme        text NOT NULL DEFAULT 'system'
               CHECK (theme IN ('system', 'light', 'dark')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_profiles IS
  'Display-friendly user data (display_name, avatar, locale, theme) '
  'decoupled de auth.users.raw_user_meta_data (que é mutável pelo user via '
  'JS e NÃO confiável). user_id é PK + FK pra auth.users(id) ON DELETE '
  'CASCADE — única tabela do schema que mantém FK pra auth.users (spec '
  '§5.10: demais colunas user-referencing omitem FK pra suportar Approach A). '
  'Auto-criada no signup via trigger trg_create_user_profile. RLS em T-114.';

COMMENT ON COLUMN public.user_profiles.user_id IS
  'PK + FK pra auth.users(id) ON DELETE CASCADE. Profile vive enquanto o '
  'user vive; anonymize/hard-delete remove o profile atomicamente.';
COMMENT ON COLUMN public.user_profiles.display_name IS
  'Nome para exibição (NOT NULL). Preenchido no signup pelo trigger: '
  'coalesce(raw_user_meta_data->>display_name, split_part(email,@,1)).';
COMMENT ON COLUMN public.user_profiles.avatar_url IS
  'URL do avatar (opcional). MVP não hospeda upload — só aceita URL externa.';
COMMENT ON COLUMN public.user_profiles.locale IS
  'BCP-47 locale code restrito a pt-BR | en-US via CHECK. Default pt-BR '
  '(primary market). Adicionar valores requer ALTER TABLE … CHECK em '
  'nova migration.';
COMMENT ON COLUMN public.user_profiles.theme IS
  'Preferência de tema da UI: system | light | dark. Default system.';
COMMENT ON COLUMN public.user_profiles.created_at IS
  'Timestamp de criação (imutável). Setado pelo trigger no signup.';
COMMENT ON COLUMN public.user_profiles.updated_at IS
  'Atualizado automaticamente via trigger app.set_updated_at() em UPDATEs.';


-- ============================================================================
-- 2. create_user_profile() — trigger function (SECURITY DEFINER)
-- ============================================================================
-- Disparada AFTER INSERT em auth.users. Cria a row correspondente em
-- public.user_profiles com display_name resolvido pela cascata:
--   1. NEW.raw_user_meta_data->>'display_name' (se fornecido no signup);
--   2. split_part(NEW.email, '@', 1)            (fallback local-part email).
--
-- SECURITY DEFINER: necessário pra que o trigger possa INSERT em
-- public.user_profiles mesmo quando o caller (GoTrue / anon role) não tem
-- grant direto. SET search_path = public, pg_temp evita hijack (pattern
-- documentado Supabase).
--
-- ON CONFLICT (user_id) DO NOTHING: torna o trigger tolerante a re-fires —
-- útil em testes que reusam o mesmo UUID, e em casos extremamente raros de
-- replay de evento. Nunca queremos derrubar o fluxo de signup.
CREATE OR REPLACE FUNCTION public.create_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, display_name)
  VALUES (
    NEW.id,
    coalesce(
      NULLIF(NEW.raw_user_meta_data->>'display_name', ''),
      split_part(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.create_user_profile() IS
  'Trigger AFTER INSERT em auth.users. Cria public.user_profiles com '
  'display_name = coalesce(raw_user_meta_data->>display_name, '
  'split_part(email,@,1)). SECURITY DEFINER + search_path pinned. '
  'ON CONFLICT DO NOTHING garante idempotência em re-fires. Ver §5.12.';


-- ============================================================================
-- 3. trg_create_user_profile — AFTER INSERT em auth.users
-- ============================================================================
-- DROP+CREATE pra idempotência (CREATE TRIGGER IF NOT EXISTS não existe).
-- Trigger vive em schema gerenciado (auth) — Supabase Cloud permite isso
-- quando a migration é aplicada via service_role (pattern oficial).
DROP TRIGGER IF EXISTS trg_create_user_profile ON auth.users;
CREATE TRIGGER trg_create_user_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.create_user_profile();


-- ============================================================================
-- 4. trg_user_profiles_set_updated_at — BEFORE UPDATE
-- ============================================================================
-- Reusa o helper genérico `app.set_updated_at()` criado em T-107.
DROP TRIGGER IF EXISTS trg_user_profiles_set_updated_at ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_set_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 5. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120400_create_user_profiles',
  'Tabela public.user_profiles (PK + FK pra auth.users ON DELETE CASCADE, '
  'CHECKs locale/theme) + public.create_user_profile() SECURITY DEFINER + '
  'trigger trg_create_user_profile AFTER INSERT em auth.users + '
  'trg_user_profiles_set_updated_at BEFORE UPDATE.'
)
ON CONFLICT (migration_name) DO NOTHING;
