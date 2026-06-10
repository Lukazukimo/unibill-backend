-- ============================================================================
-- Migration: 20260616122000_create_system_admin_grants.sql
-- Date:      2026-06-10
-- Task:      T-216
-- Purpose:   Create `public.system_admin_grants` — append-only audit trail of
--            every promotion (`granted`) and demotion (`revoked`) of the
--            `is_system_admin` JWT claim. Required by spec §9.2 "sec-2 finding"
--            to make every change to the platform-superuser bit forensically
--            traceable (actor, timestamp, reason, correlation id).
--
--            This is a sister table to the JWT claim itself (`raw_app_meta_data
--            ->> 'is_system_admin'` on `auth.users`). The CLAIM is what gates
--            RLS via `app.is_system_admin()` (T-113); this TABLE is the
--            history of who flipped that bit, when, and why.
--
-- Spec refs: §9.2 (JWT claim is_system_admin — audit trail completo de
--                  promoções/revogações; DDL canônica; bootstrap inclui
--                  INSERT audit; policy admin_grants_select_sysadmin)
--            §9.4 (anonymize_user_references — granted_by FK preserved sem
--                  CASCADE; user_id FK preserved sem CASCADE; rows são
--                  evidência permanente e devem sobreviver à exclusão de
--                  qualquer auth.users)
--            BR-028 Sys admin bootstrap (1ª vez): SQL no Studio escreve esta
--                  tabela + domain_event `system_admin.bootstrapped` (T-217)
--
-- Design notes:
--   * `action text CHECK ('granted','revoked')` — NOT enum por simetria com
--     o resto da spec (que usa text + CHECK para enums de valor pequeno e
--     estável). Permite ALTER CHECK no futuro sem o ritual de ALTER TYPE.
--   * `user_id uuid NOT NULL REFERENCES auth.users(id)` — quem teve o bit
--     promovido/revogado. SEM `ON DELETE CASCADE`: a evidência sobrevive a
--     uma exclusão do user. §9.4 `anonymize_user_references` UPDATE-a
--     `user_id` pra um sentinel actor (system_actors row) ANTES do DELETE
--     em `auth.users`, liberando a FK. Esse é o mesmo padrão de
--     `consent_log.user_id` (T-112) e o motivo de NÃO usarmos CASCADE.
--   * `granted_by uuid NULL REFERENCES auth.users(id)` — quem fez a ação.
--     NULL apenas no `reason='bootstrap'` (1ª promoção via SQL direto no
--     Studio, ANTES de existir sys admin). Todo `reason ≠ 'bootstrap'` DEVE
--     ter `granted_by NOT NULL` — invariante checado pela Edge Function
--     `POST /admin/promote-system-admin` (T-217 / pós-MVP), não por CHECK no
--     DB (queremos permitir bootstrap idempotente sem complicar o schema).
--     Também sem CASCADE pela mesma razão acima.
--   * `granted_at timestamptz NOT NULL DEFAULT now()` — instante da promoção
--     / revogação. Imutável (a tabela é append-only; sem UPDATE policy).
--   * `reason text NOT NULL` — texto livre da motivação. Convenção textual
--     da spec §9.2: 'bootstrap' (1ª vez), 'peer_promotion' (admin promove
--     outro), 'peer_revocation' (admin revoga outro), 'auto_revoke_last'
--     (sistema impede ficar com zero admins), 'self_revoke' (admin se
--     remove). Não é enum pra permitir motivos novos sem migration de tipo.
--   * `correlation_id uuid` (nullable) — propaga o correlation id da request
--     que originou a mudança (middleware _shared/correlation T-125). Permite
--     correlacionar essa row com logs estruturados, domain_events
--     (`system_admin.promoted` / `system_admin.revoked`), e qualquer outro
--     side-effect emitido pela Edge Function que escreveu a row.
--   * Index `idx_admin_grants_user_time ON (user_id, granted_at DESC)` — o
--     único lookup esperado é "qual o histórico do usuário X?" (UI Admin /
--     auditoria LGPD / forensics) e "qual a última ação no usuário X?"
--     (decisão de promote idempotente). granted_at DESC permite index scan
--     ordenado sem sort externo.
--   * RLS: Pattern E (sys admin only). SELECT policy
--     `admin_grants_select_sysadmin` USING `app.is_system_admin()`. NO
--     INSERT / UPDATE / DELETE policy — escrita restrita a service_role
--     (que tem BYPASSRLS por design Supabase). Edge Function
--     `POST /admin/promote-system-admin` é o único caminho de escrita
--     legítima em produção; o bootstrap inicial usa SQL direto rodando como
--     superuser no Studio (também bypasses RLS).
--   * service_role bypasses RLS implicitly. Não há policy explícita pra
--     service_role — adicioná-la seria dead code e obscureceria intent.
--   * Idempotente: CREATE TABLE / INDEX com IF NOT EXISTS. RLS enable é
--     no-op se já ativa. Policies usam DROP POLICY IF EXISTS antes de
--     CREATE POLICY (Postgres não tem CREATE POLICY IF NOT EXISTS).
--   * Tabela vive em `public` (igual a `consent_log`, `app_settings`, etc.):
--     dados de negócio ficam em `public`; o schema `app` é reservado pra
--     helpers (funções, metadata).
--
-- Forbidden patterns:
--   * NÃO adicionar ON DELETE CASCADE em user_id ou granted_by — quebraria
--     a evidência LGPD/forensics; §9.4 anonymize handle.
--   * NÃO criar UPDATE/DELETE policy — a tabela é append-only.
--   * NÃO adicionar policy explícita pra service_role.
--   * NÃO referenciar auth.users.email ou outra PII na policy — derivar
--     identidade via auth.uid() e helpers de schema app.
-- ============================================================================


-- ============================================================================
-- 1. system_admin_grants — append-only audit of is_system_admin transitions
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.system_admin_grants (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id), -- AUDIT-FK-OK: subject of admin role assignment (ownership)
  action          text NOT NULL CHECK (action IN ('granted', 'revoked')),
  granted_by      uuid REFERENCES auth.users(id), -- AUDIT-FK-OK: audit of who granted the role; NULL only on bootstrap row   -- NULL only for 'bootstrap'
  granted_at      timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL,
  correlation_id  uuid
);

COMMENT ON TABLE public.system_admin_grants IS
  'Append-only audit trail de promoções/revogações do claim JWT '
  'is_system_admin (spec §9.2 sec-2 finding). Cada flip do bit '
  'raw_app_meta_data->>is_system_admin em auth.users gera UMA row aqui '
  '(action granted|revoked, granted_by, reason, correlation_id). RLS '
  'restringe SELECT a sys admins; INSERT só via service_role (Edge '
  'Function POST /admin/promote-system-admin ou bootstrap SQL no Studio).';

COMMENT ON COLUMN public.system_admin_grants.id IS
  'PK gerado por extensions.gen_random_uuid().';
COMMENT ON COLUMN public.system_admin_grants.user_id IS
  'Usuário cujo bit is_system_admin foi promovido/revogado. FK pra '
  'auth.users(id) PRESERVADA, SEM ON DELETE CASCADE — §9.4 '
  'anonymize_user_references UPDATE-a pra sentinel ANTES do DELETE em '
  'auth.users, preservando evidência forense.';
COMMENT ON COLUMN public.system_admin_grants.action IS
  'granted | revoked. text + CHECK (não enum) pra permitir extensão futura '
  'sem ALTER TYPE.';
COMMENT ON COLUMN public.system_admin_grants.granted_by IS
  'Usuário que executou a ação. NULL apenas quando reason=bootstrap (1ª '
  'promoção via SQL direto no Studio, antes de existir sys admin). '
  'Edge Function /admin/promote-system-admin exige NOT NULL em runtime. '
  'FK PRESERVADA, SEM ON DELETE CASCADE (mesmo motivo de user_id).';
COMMENT ON COLUMN public.system_admin_grants.granted_at IS
  'Instante da ação (default now()). Imutável — tabela append-only, sem '
  'UPDATE policy.';
COMMENT ON COLUMN public.system_admin_grants.reason IS
  'Motivo textual. Valores canônicos (spec §9.2): bootstrap, peer_promotion, '
  'peer_revocation, auto_revoke_last, self_revoke. text (não enum) pra '
  'flexibilidade.';
COMMENT ON COLUMN public.system_admin_grants.correlation_id IS
  'UUID do correlation id da request originadora (middleware _shared/'
  'correlation T-125). Permite cross-reference com logs estruturados, '
  'domain_events (system_admin.promoted | system_admin.revoked | '
  'system_admin.bootstrapped) e side-effects.';


-- ============================================================================
-- 2. Index — histórico por usuário, mais recente primeiro
-- ============================================================================
-- Único lookup esperado: "histórico do user X" (UI Admin, auditoria, decisão
-- idempotente de promote/revoke). granted_at DESC permite scan ordenado sem
-- sort externo.
CREATE INDEX IF NOT EXISTS idx_admin_grants_user_time
  ON public.system_admin_grants (user_id, granted_at DESC);

COMMENT ON INDEX public.idx_admin_grants_user_time IS
  'B-tree composto (user_id, granted_at DESC) — otimiza listagem do '
  'histórico de promoções/revogações de um usuário, mais recente primeiro. '
  'Usado por UI Admin, auditoria LGPD/forensics e checks idempotentes da '
  'Edge Function /admin/promote-system-admin.';


-- ============================================================================
-- 3. Enable Row-Level Security
-- ============================================================================
-- RLS enable é no-op se já ativa. Sem RLS, qualquer authenticated leria a
-- lista inteira de promoções — vazamento de PII (quem é admin do sistema)
-- e de superfície de ataque.
ALTER TABLE public.system_admin_grants ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- 4. Policy — Pattern E (sys admin only) SELECT
-- ============================================================================
-- Apenas sys admin lê. Non sys-admin authenticated -> zero rows (auth.uid()
-- existe, app.is_system_admin() retorna false). anon -> zero rows
-- (app.is_system_admin() trata auth.uid() IS NULL como false).
-- service_role bypasses RLS implicitly.
DROP POLICY IF EXISTS admin_grants_select_sysadmin ON public.system_admin_grants;
CREATE POLICY admin_grants_select_sysadmin ON public.system_admin_grants
  FOR SELECT
  TO authenticated
  USING (app.is_system_admin());

COMMENT ON POLICY admin_grants_select_sysadmin ON public.system_admin_grants IS
  'Pattern E (sys admin only) SELECT. Helper app.is_system_admin() (T-113) '
  'lê o claim JWT is_system_admin. Non sys-admin SELECT retorna empty. '
  'INSERT/UPDATE/DELETE NÃO têm policy — bypass exclusivo via service_role '
  '(Edge Function POST /admin/promote-system-admin ou bootstrap SQL no Studio).';


-- ============================================================================
-- 5. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616122000_create_system_admin_grants',
  'Tabela public.system_admin_grants (append-only) + index '
  'idx_admin_grants_user_time (user_id, granted_at DESC) + RLS policy '
  'admin_grants_select_sysadmin (Pattern E sys-admin-only SELECT). '
  'INSERT/UPDATE/DELETE sem policy — write restrita a service_role. '
  'Spec §9.2 sec-2 finding: audit trail completo de promoções/revogações '
  'do claim is_system_admin. user_id e granted_by sem ON DELETE CASCADE '
  '(§9.4 anonymize handle).'
)
ON CONFLICT (migration_name) DO NOTHING;
