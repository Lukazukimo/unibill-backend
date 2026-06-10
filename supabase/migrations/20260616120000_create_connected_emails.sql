-- ============================================================================
-- Migration: 20260616120000_create_connected_emails.sql
-- Date:      2026-06-10
-- Task:      T-206
-- Purpose:   Implementa o modelo de "emails conectados" descrito em §5.2 do
--            spec — split em duas tabelas (a CREDENCIAL e o VÍNCULO):
--
--              public.connected_emails             — 1 row por endereço de
--                                                    email (UNIQUE global em
--                                                    email_address). Guarda
--                                                    credencial Vault, cursor
--                                                    IMAP, status e métricas
--                                                    de erro.
--
--              public.connected_email_households   — N rows por (email, household).
--                                                    Permite o mesmo Gmail ser
--                                                    consumido por múltiplos
--                                                    households sem duplicar
--                                                    credencial nem cursor IMAP.
--
--            Cria também os enums public.email_status e public.email_provider
--            usados por essas tabelas (e futuramente por queue + dashboards).
--
-- Spec refs: §5.2  (definição das tabelas, defaults, índices únicos parciais)
--            §5.10 (Approach A: NO FK do owner_user_id pra auth.users — fica
--                   como uuid puro pra permitir hard-delete do auth.users
--                   sem quebrar a credencial; valida via app + display via
--                   user_display_name())  -- ATENÇÃO: o spec §5.2 lista
--                   `REFERENCES auth.users(id)` literal; mantemos a FK aqui
--                   porque connected_emails é OWNERSHIP (não audit) — quando
--                   o user é anonimizado, suas connected_emails devem ir
--                   junto (CASCADE-equivalente via app.anonymize_user, T-228).
--            §6.4  (IMAP worker lê last_processed_uid + consecutive_errors,
--                   atualiza last_sync_at / last_error_at).
--            §9.3.1 (app_password_secret é uuid Vault — wrapper em T-208).
--
-- Design notes:
--   * `uq_email_household_active` é PARTIAL UNIQUE WHERE deleted_at IS NULL —
--     permite re-binding após soft-delete: o user pode remover um email de
--     um household e re-adicionar mais tarde sem violar o índice. O par
--     histórico (soft-deletado) permanece queryable pra auditoria.
--   * `idx_default_per_email` garante NO MÁXIMO um is_default=true por
--     connected_email_id entre vínculos ativos. Zero defaults é OK (o app
--     escolhe o primeiro household quando não há default explícito).
--   * Triggers `app.set_updated_at` (T-107) anexados às duas tabelas.
--   * `app_password_secret` é uuid sem FK pra vault.secrets — Vault é
--     gerenciado por extensão e a FK não é confiável (também por design o
--     wrapper SECURITY DEFINER em T-208 é a única forma de tocar Vault).
--   * Idempotente: CREATE TABLE/INDEX usam IF NOT EXISTS; enums envelopados
--     em DO blocks com EXISTS check (CREATE TYPE não tem IF NOT EXISTS).
--
-- Rollback:
--   * `DROP TABLE IF EXISTS public.connected_email_households CASCADE;`
--   * `DROP TABLE IF EXISTS public.connected_emails CASCADE;`
--   * `DROP TYPE IF EXISTS public.email_status;`
--   * `DROP TYPE IF EXISTS public.email_provider;`
--   * (rodar nessa ordem — primeiro vínculo, depois credencial, depois enums)
-- ============================================================================


-- ============================================================================
-- 1. Enums: email_status, email_provider
-- ============================================================================
-- email_status — ciclo de vida operacional do email conectado:
--   * active    — IMAP worker processa normalmente.
--   * paused    — usuário pausou manualmente (não há erro, só hold).
--   * error     — IMAP falhou consecutive_errors >= threshold (§5.8).
--                  worker pula até remediação / admin reset.
--   * revoked   — usuário desconectou (soft-delete equivalente);
--                  credencial Vault é destruída via app.anonymize_user.
--
-- email_provider — apenas 'gmail' no MVP; enum permite expansão sem ALTER
-- TABLE quebrado (basta ALTER TYPE ... ADD VALUE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'email_status' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.email_status AS ENUM ('active', 'paused', 'error', 'revoked');
  END IF;
END
$$;

COMMENT ON TYPE public.email_status IS
  'Ciclo de vida operacional de um connected_email. active=worker processa; '
  'paused=hold manual; error=consecutive_errors estouraram threshold (§5.8); '
  'revoked=user desconectou (credencial Vault será destruída). Spec §5.2.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'email_provider' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.email_provider AS ENUM ('gmail');
  END IF;
END
$$;

COMMENT ON TYPE public.email_provider IS
  'Provedor IMAP. MVP suporta apenas gmail (imap.gmail.com:993 + app password). '
  'Enum permite expansão futura (outlook, fastmail, etc.) via ALTER TYPE ADD VALUE. '
  'Spec §5.2.';


-- ============================================================================
-- 2. public.connected_emails — credencial + cursor IMAP (UNIQUE global)
-- ============================================================================
-- Cada row é uma conta de email externa que o Unibill pode consumir via IMAP.
-- UNIQUE em email_address garante que dois usuários não criem credenciais
-- conflitantes pro mesmo Gmail (o segundo recebe erro de duplicate na connect
-- flow — Edge Function POST /emails/connect em T-212 trata e retorna 409).
--
-- owner_user_id mantém FK ON DELETE NO ACTION (default) — o fluxo de hard
-- delete passa por app.anonymize_user (T-228), que primeiro destrói o
-- Vault secret + apaga connected_emails e só depois apaga auth.users.
CREATE TABLE IF NOT EXISTS public.connected_emails (
  id                   uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  email_address        text NOT NULL UNIQUE,
  provider             public.email_provider NOT NULL DEFAULT 'gmail',
  owner_user_id        uuid NOT NULL REFERENCES auth.users(id), -- AUDIT-FK-OK: ownership (Gmail account belongs to the user who connected it)
  app_password_secret  uuid NOT NULL,
  imap_host            text NOT NULL DEFAULT 'imap.gmail.com',
  imap_port            int  NOT NULL DEFAULT 993,
  imap_use_tls         boolean NOT NULL DEFAULT true,
  status               public.email_status NOT NULL DEFAULT 'active',
  last_processed_uid   bigint,
  last_sync_at         timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  consecutive_errors   int  NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

COMMENT ON TABLE public.connected_emails IS
  'Credencial IMAP + cursor de sincronização. UNIQUE global em email_address '
  '(o mesmo Gmail nunca duplica credencial; vínculo a múltiplos households '
  'via connected_email_households). owner_user_id define quem pode revogar '
  'a credencial. Soft-delete via deleted_at (status=revoked é o sinal '
  'semântico; deleted_at é o marcador de tombstone). Spec §5.2.';

COMMENT ON COLUMN public.connected_emails.id IS
  'PK uuid gerado por gen_random_uuid().';
COMMENT ON COLUMN public.connected_emails.email_address IS
  'Endereço de email completo (ex: fulano@gmail.com). UNIQUE global — '
  'erro 409 retornado pelo Edge Function se um segundo user tentar connect.';
COMMENT ON COLUMN public.connected_emails.provider IS
  'Enum email_provider. MVP: apenas ''gmail''.';
COMMENT ON COLUMN public.connected_emails.owner_user_id IS
  'auth.users(id) do usuário que conectou o email. Único autorizado a '
  'revogar a credencial / adicionar bindings em households próprios. '
  'FK mantida (ownership, não audit — ver §5.10 contexto).';
COMMENT ON COLUMN public.connected_emails.app_password_secret IS
  'UUID de referência em vault.secrets (Supabase Vault). Sem FK — Vault é '
  'gerenciado por extensão e seu schema não é versionado pela app. Acesso '
  'somente via wrappers SECURITY DEFINER em schema app (T-208).';
COMMENT ON COLUMN public.connected_emails.imap_host IS
  'Host IMAP. Default imap.gmail.com pro provider gmail.';
COMMENT ON COLUMN public.connected_emails.imap_port IS
  'Porta IMAP. Default 993 (IMAPS — TLS implícito).';
COMMENT ON COLUMN public.connected_emails.imap_use_tls IS
  'Sempre true em produção. Coluna existe pra permitir mock IMAP local em '
  'integration tests (uma única flag, sem branch de produção).';
COMMENT ON COLUMN public.connected_emails.status IS
  'Estado operacional. Ver enum public.email_status.';
COMMENT ON COLUMN public.connected_emails.last_processed_uid IS
  'UID IMAP do último email processado com sucesso. Worker faz UID FETCH > '
  'last_processed_uid pra cursor incremental (§6.4).';
COMMENT ON COLUMN public.connected_emails.last_sync_at IS
  'Timestamp da última execução bem-sucedida do IMAP worker.';
COMMENT ON COLUMN public.connected_emails.last_error IS
  'Mensagem do último erro IMAP (truncada a 500 chars pelo worker antes do '
  'UPDATE). NULL quando consecutive_errors=0.';
COMMENT ON COLUMN public.connected_emails.last_error_at IS
  'Timestamp do último erro registrado.';
COMMENT ON COLUMN public.connected_emails.consecutive_errors IS
  'Contador de falhas IMAP consecutivas. Reseta pra 0 em cada sync bem-sucedido. '
  'Threshold de circuit-breaker definido em app_settings (§5.8).';
COMMENT ON COLUMN public.connected_emails.created_at IS
  'Timestamp de criação (imutável).';
COMMENT ON COLUMN public.connected_emails.updated_at IS
  'Atualizado via trigger app.set_updated_at().';
COMMENT ON COLUMN public.connected_emails.deleted_at IS
  'Soft-delete marker. NULL = ativo. Quando NOT NULL, o vínculo permanece '
  'queryable pra auditoria mas o worker ignora (combine com status=''revoked''). '
  'Vault secret é destruído por app.anonymize_user (T-228).';


-- ============================================================================
-- 3. Trigger: bump updated_at em UPDATE de connected_emails
-- ============================================================================
DROP TRIGGER IF EXISTS trg_connected_emails_set_updated_at
  ON public.connected_emails;
CREATE TRIGGER trg_connected_emails_set_updated_at
  BEFORE UPDATE ON public.connected_emails
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 4. public.connected_email_households — vínculo many-to-many
-- ============================================================================
-- N rows por (connected_email_id, household_id). Um mesmo Gmail pode alimentar
-- múltiplos households (ex: o usuário tem casa + república + casa dos pais
-- todos coletando faturas que chegam no mesmo email pessoal).
--
-- is_default sinaliza o household padrão pra qual uma fatura ambígua é
-- atribuída quando o classificador não consegue inferir (raro — geralmente
-- o parser tem dicas suficientes do conteúdo + email_address do remetente).
CREATE TABLE IF NOT EXISTS public.connected_email_households (
  id                  uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  connected_email_id  uuid NOT NULL REFERENCES public.connected_emails(id),
  household_id        uuid NOT NULL REFERENCES public.households(id),
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

COMMENT ON TABLE public.connected_email_households IS
  'Junction many-to-many entre connected_emails e households. Permite o mesmo '
  'Gmail consumir faturas pra múltiplos households (sem duplicar credencial/cursor). '
  'Soft-delete via deleted_at permite re-binding histórico — par (email, household) '
  'pode ser removido e re-adicionado sem violar uq_email_household_active. Spec §5.2.';

COMMENT ON COLUMN public.connected_email_households.id IS
  'PK uuid gerado por gen_random_uuid().';
COMMENT ON COLUMN public.connected_email_households.connected_email_id IS
  'FK public.connected_emails(id). Ownership compartilhada — vários households '
  'podem apontar pra mesma credencial.';
COMMENT ON COLUMN public.connected_email_households.household_id IS
  'FK public.households(id).';
COMMENT ON COLUMN public.connected_email_households.is_default IS
  'Quando true, este household é o destino padrão pra faturas ambíguas '
  'recebidas por este email. Máximo 1 default por email entre vínculos '
  'ativos (enforced por idx_default_per_email).';
COMMENT ON COLUMN public.connected_email_households.created_at IS
  'Timestamp de criação (imutável).';
COMMENT ON COLUMN public.connected_email_households.updated_at IS
  'Atualizado via trigger app.set_updated_at().';
COMMENT ON COLUMN public.connected_email_households.deleted_at IS
  'Soft-delete marker. NULL = vínculo ativo. RLS oculta soft-deleted; worker '
  'também ignora. Combinado com uq_email_household_active partial permite '
  're-binding histórico.';


-- ============================================================================
-- 5. Trigger: bump updated_at em UPDATE de connected_email_households
-- ============================================================================
DROP TRIGGER IF EXISTS trg_connected_email_households_set_updated_at
  ON public.connected_email_households;
CREATE TRIGGER trg_connected_email_households_set_updated_at
  BEFORE UPDATE ON public.connected_email_households
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 6. Índices únicos parciais (respeitam soft-delete)
-- ============================================================================
-- uq_email_household_active: NO MÁXIMO um vínculo ativo por par
--   (connected_email_id, household_id). Soft-deletes não contam — permite
--   o user remover e re-adicionar o mesmo binding ao longo do tempo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_household_active
  ON public.connected_email_households (connected_email_id, household_id)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.uq_email_household_active IS
  'Partial unique: garante 1 vínculo ATIVO por (email, household). Permite '
  're-bind após soft-delete (deleted_at!=NULL não entra no índice). Spec §5.2.';

-- idx_default_per_email: NO MÁXIMO um is_default=true por connected_email_id
-- entre vínculos ativos. Zero defaults é permitido (o app trata).
CREATE UNIQUE INDEX IF NOT EXISTS idx_default_per_email
  ON public.connected_email_households (connected_email_id)
  WHERE is_default = true AND deleted_at IS NULL;

COMMENT ON INDEX public.idx_default_per_email IS
  'Partial unique: NO MÁXIMO 1 household marcado is_default=true por '
  'connected_email_id entre vínculos ativos. Zero defaults permitido. Spec §5.2.';


-- ============================================================================
-- 7. Índices auxiliares (perf — não-únicos)
-- ============================================================================
-- Lookup por owner_user_id (usado em RLS + endpoints de listagem do user).
CREATE INDEX IF NOT EXISTS idx_connected_emails_owner_user
  ON public.connected_emails (owner_user_id)
  WHERE deleted_at IS NULL;

-- Lookup do worker IMAP: "quais credenciais devo processar agora?"
-- (status=active + deleted_at IS NULL ordenado por last_sync_at).
CREATE INDEX IF NOT EXISTS idx_connected_emails_worker_eligible
  ON public.connected_emails (status, last_sync_at)
  WHERE deleted_at IS NULL AND status = 'active';

-- Reverse lookup: dado um household, quais emails alimentam ele?
CREATE INDEX IF NOT EXISTS idx_connected_email_households_household
  ON public.connected_email_households (household_id)
  WHERE deleted_at IS NULL;


-- ============================================================================
-- 8. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616120000_create_connected_emails',
  'Enums email_status + email_provider; tabelas connected_emails (UNIQUE global '
  'em email_address) e connected_email_households (junction many-to-many com '
  'partial unique uq_email_household_active e idx_default_per_email respeitando '
  'soft-delete); triggers set_updated_at; índices auxiliares de owner + worker.'
)
ON CONFLICT (migration_name) DO NOTHING;
