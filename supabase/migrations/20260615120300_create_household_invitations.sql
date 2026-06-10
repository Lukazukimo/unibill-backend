-- ============================================================================
-- Migration: 20260615120300_create_household_invitations.sql
-- Date:      2026-06-10
-- Task:      T-109
-- Purpose:   Create `public.household_invitations` table — convites por código
--            de 8 chars alfanuméricos pra adicionar novos membros a um
--            household. Convites têm TTL de 7 dias por default e podem ser
--            opcionalmente travados a um email específico (matched contra
--            auth.users.email no momento do redeem). RLS é adicionada em T-114.
-- Spec refs: §5.1  (household_invitations schema)
--            §5.12 (invited_email matching contra auth.users.email)
--
-- Design notes:
--   * `code` é UNIQUE + CHECK `^[A-Z0-9]{8}$` — 8 chars maiúsculos/digits.
--     Geração do código fica a cargo do app (Edge Function `/invitations`),
--     que retentará em colisão (probabilidade ~5e-13 com 36^8 espaço amostral).
--   * `role` reutiliza o ENUM `public.member_role` criado em T-108 (members).
--   * `invited_email` opcional: NULL = convite "aberto" (qualquer user logado
--     pode resgatar via código); NOT NULL = convite travado àquele email
--     (Edge Function valida `auth.email() == invited_email` em §5.12).
--   * `expires_at` default `now() + interval '7 days'` (TTL padrão dos convites).
--   * `used_at`/`used_by` NULL enquanto não resgatado; ambos preenchidos
--     atomicamente quando convite é consumido.
--   * Audit columns (`created_by`, `used_by`) são uuid puro SEM FK pra
--     auth.users (spec §5.10 Approach A — sobrevivem ao anonymize do user).
--   * Index parcial `idx_invitations_household_active` (household_id, used_at)
--     WHERE used_at IS NULL — otimiza listagem de convites ativos sem
--     varrer convites já consumidos.
--   * RLS habilitada em T-114 (separate policy migration).
--   * Idempotente: CREATE TABLE/INDEX IF NOT EXISTS; CHECK constraints
--     adicionadas via DO block pra serem re-runnable.
-- ============================================================================


-- ============================================================================
-- 1. household_invitations — convites por código com TTL
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.household_invitations (
  id            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES public.households(id),
  code          text NOT NULL UNIQUE,
  role          public.member_role NOT NULL DEFAULT 'member',
  invited_email text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  used_at       timestamptz,
  used_by       uuid
);

COMMENT ON TABLE public.household_invitations IS
  'Convites por código (8 chars alfanuméricos maiúsculos) pra adicionar '
  'membros a um household. TTL default 7 dias. invited_email opcional '
  'trava o convite ao email de auth.users (validado em /invitations/redeem). '
  'used_at/used_by preenchidos atomicamente no consumo. RLS em T-114.';

COMMENT ON COLUMN public.household_invitations.id IS
  'PK gerado por gen_random_uuid().';
COMMENT ON COLUMN public.household_invitations.household_id IS
  'Household alvo do convite (FK para public.households).';
COMMENT ON COLUMN public.household_invitations.code IS
  '8 chars alfanuméricos maiúsculos [A-Z0-9]{8}. UNIQUE + CHECK. Gerado pelo '
  'app (Edge Function /invitations); colisões resolvidas via retry.';
COMMENT ON COLUMN public.household_invitations.role IS
  'Role com que o invitee entrará no household ao resgatar (admin | member). '
  'Default member; admin só pode ser concedido por outro admin (RLS T-114).';
COMMENT ON COLUMN public.household_invitations.invited_email IS
  'Opcional. NULL = convite aberto (qualquer user resgata via código). '
  'NOT NULL = trava ao email de auth.users — Edge Function /invitations/redeem '
  'valida auth.email() == invited_email (spec §5.12).';
COMMENT ON COLUMN public.household_invitations.created_by IS
  'UUID do criador. SEM FK constraint (spec §5.10 Approach A — pode apontar '
  'pra auth.users(id) durante uso normal OU system_actors(id) após anonymize).';
COMMENT ON COLUMN public.household_invitations.created_at IS
  'Timestamp de criação (imutável).';
COMMENT ON COLUMN public.household_invitations.expires_at IS
  'Convite expira em now() + 7 dias por default. Após expires_at o redeem '
  'falha com erro 410 Gone.';
COMMENT ON COLUMN public.household_invitations.used_at IS
  'Timestamp do consumo. NULL = ainda ativo. Setado atomicamente com used_by '
  'pela Edge Function /invitations/redeem.';
COMMENT ON COLUMN public.household_invitations.used_by IS
  'UUID do user que resgatou. SEM FK constraint (spec §5.10 Approach A).';


-- ============================================================================
-- 2. CHECK constraint — code matches ^[A-Z0-9]{8}$
-- ============================================================================
-- Adicionada via DO block pra ser idempotente (CREATE TABLE IF NOT EXISTS
-- não recria constraints em re-runs). Usa regex POSIX `~` (case-sensitive)
-- pra garantir só maiúsculos e dígitos, exatamente 8 chars.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'household_invitations_code_format_chk'
       AND conrelid = 'public.household_invitations'::regclass
  ) THEN
    ALTER TABLE public.household_invitations
      ADD CONSTRAINT household_invitations_code_format_chk
      CHECK (code ~ '^[A-Z0-9]{8}$');
  END IF;
END
$$;


-- ============================================================================
-- 3. Partial index — convites ativos por household
-- ============================================================================
-- Otimiza listagem de convites pendentes (`SELECT ... WHERE household_id = $1
-- AND used_at IS NULL`) sem varrer convites já consumidos. used_at é incluído
-- pra suportar futuro ORDER BY/filtering por data sem index-only-scan miss.
CREATE INDEX IF NOT EXISTS idx_invitations_household_active
  ON public.household_invitations (household_id, used_at)
  WHERE used_at IS NULL;

COMMENT ON INDEX public.idx_invitations_household_active IS
  'Partial index para listagem de convites ativos (used_at IS NULL) por '
  'household_id. Evita scan de convites já consumidos.';


-- ============================================================================
-- 4. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120300_create_household_invitations',
  'Tabela public.household_invitations + CHECK ^[A-Z0-9]{8}$ no code + '
  'partial index idx_invitations_household_active (household_id, used_at) '
  'WHERE used_at IS NULL. RLS em T-114.'
)
ON CONFLICT (migration_name) DO NOTHING;
