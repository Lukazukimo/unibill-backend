-- ============================================================================
-- Migration: 20260615120000_create_system_actors.sql
-- Date:      2026-06-10
-- Task:      T-106
-- Purpose:   Create `public.system_actors` table with three deterministic
--            sentinel UUIDs that act as audit-field stand-ins for entries
--            outside of `auth.users` (e.g. deleted users, system workers,
--            bootstrap admin). Enable RLS so authenticated users can SELECT
--            (needed by `user_display_name(uuid)` helper, see spec §5.10)
--            while keeping writes restricted to service_role.
-- Spec refs: §5.10 (Sentinel actors — não pollute `auth.users`),
--            §5.11 (RLS policy summary: `system_actors` is authenticated-read,
--            service_role-write).
--
-- Design notes:
--   * Three deterministic UUIDs (00000000-0000-0000-0000-00000000000{1,2,3})
--     are seeded inside this migration so they are guaranteed present after
--     the migration succeeds. `ON CONFLICT (id) DO NOTHING` keeps the migration
--     idempotent across re-runs.
--   * `kind` is constrained to the canonical set: 'deleted_user',
--     'system_worker', 'system_admin_bootstrap'. Adding new kinds requires a
--     follow-up migration that bumps the CHECK constraint.
--   * RLS is enabled with a permissive SELECT policy for the `authenticated`
--     role only. `anon` cannot read (no policy granted, and RLS denies by
--     default). Writes go through `service_role`, which bypasses RLS.
--   * No FK constraint is added towards `system_actors.id` from audit columns
--     — per spec §5.10 (Abordagem A) we keep audit columns as plain `uuid`
--     so they can hold either an `auth.users.id` or a sentinel id without
--     a divergent FK structure.
-- ============================================================================


-- ============================================================================
-- 1. Table definition
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.system_actors (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL UNIQUE
                 CHECK (kind IN ('deleted_user', 'system_worker', 'system_admin_bootstrap')),
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.system_actors IS
  'Sentinel actors — UUIDs estáveis usados como ponteiros "fora-de-auth.users" '
  'em colunas de audit (created_by, updated_by, paid_by, invited_by, '
  'actor_user_id, changed_by, granted_by, used_by). Permite anonimização LGPD '
  'sem violar FK e exibe rótulos amigáveis ("Usuário removido", "Sistema") via '
  'app.user_display_name(uuid). Ver spec §5.10.';

COMMENT ON COLUMN public.system_actors.id IS
  'UUID determinístico (00000000-0000-0000-0000-00000000000{1,2,3}). '
  'NÃO usar gen_random_uuid — os ids são referenciados literalmente em '
  'anonymize_user_references e em código de aplicação.';
COMMENT ON COLUMN public.system_actors.kind IS
  'Categoria do actor: deleted_user (anonimização LGPD), system_worker '
  '(jobs pg_cron / Edge Functions), system_admin_bootstrap (admin inicial '
  'antes do primeiro promote via is_system_admin claim).';
COMMENT ON COLUMN public.system_actors.display_name IS
  'Rótulo humano exibido na UI quando o actor é resolvido via '
  'app.user_display_name(uuid).';
COMMENT ON COLUMN public.system_actors.created_at IS
  'Timestamp de criação da row (não muda em re-runs idempotentes).';


-- ============================================================================
-- 2. Seeds — três sentinels determinísticos (idempotente)
-- ============================================================================
INSERT INTO public.system_actors (id, kind, display_name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'deleted_user',           'Usuário removido'),
  ('00000000-0000-0000-0000-000000000002', 'system_worker',          'Sistema'),
  ('00000000-0000-0000-0000-000000000003', 'system_admin_bootstrap', 'Admin (bootstrap)')
ON CONFLICT (id) DO NOTHING;


-- ============================================================================
-- 3. Row-Level Security
-- ============================================================================
-- RLS deny-by-default; SELECT é liberado para `authenticated` (necessário
-- para que o helper `app.user_display_name(uuid)` consiga resolver rótulos
-- "Usuário removido" / "Sistema" em listings da UI). Writes ficam fora de
-- qualquer policy → só `service_role` (que ignora RLS) pode INSERT/UPDATE/DELETE.
ALTER TABLE public.system_actors ENABLE ROW LEVEL SECURITY;

-- Drop-then-create para manter o migration idempotente em ambientes onde a
-- policy já tenha sido aplicada (re-run defensivo; Postgres não tem
-- CREATE POLICY IF NOT EXISTS antes do 15).
DROP POLICY IF EXISTS system_actors_select ON public.system_actors;
CREATE POLICY system_actors_select ON public.system_actors
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON POLICY system_actors_select ON public.system_actors IS
  'SELECT liberado a `authenticated` (ver spec §5.11 — necessário para '
  'app.user_display_name resolver rótulos "Usuário removido" na UI). '
  'anon não tem policy → negado por default. Writes ficam restritos a '
  'service_role (bypass RLS).';


-- ============================================================================
-- 4. Table-level privileges (defesa em profundidade)
-- ============================================================================
-- RLS é o gate primário; grants explícitos garantem que mesmo sem RLS
-- ativa (ex.: rollback acidental) os papéis errados não recebem privilégios.
GRANT SELECT ON public.system_actors TO authenticated;
GRANT ALL    ON public.system_actors TO service_role;
-- anon recebe nada por design (deny by default + sem grant).


-- ============================================================================
-- 5. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120000_create_system_actors',
  'Cria public.system_actors com 3 seeds determinísticos (deleted_user, '
  'system_worker, system_admin_bootstrap), habilita RLS com SELECT para '
  'authenticated e ALL para service_role.'
)
ON CONFLICT (migration_name) DO NOTHING;
