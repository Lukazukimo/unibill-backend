-- ============================================================================
-- Migration: 20260615120500_create_app_settings.sql
-- Date:      2026-06-10
-- Task:      T-111
-- Purpose:   Create runtime configuration store (`public.app_settings`) +
--            change-audit ledger (`public.app_settings_history`) +
--            `public.audit_app_settings()` trigger fired AFTER INSERT OR UPDATE
--            on `app_settings`. Settings live in three scopes (global /
--            household / user) with a documented cascade resolution
--            (user -> household -> global -> code default) consumed by the
--            `getConfig(key, default, scope?)` helper layer (TTL 30s cache,
--            implemented in Edge Functions — out of scope here).
--
-- Spec refs: §5.5 (app_settings + app_settings_history schemas, cascade
--                  resolution, audit-via-trigger pattern)
--            §5.11 tech-3 (CRITICAL FIX: Postgres does NOT permit NULL in
--                          PRIMARY KEY columns, so the inline composite PK
--                          `(key, scope, scope_id)` from earlier drafts is
--                          replaced with a surrogate `id uuid` PK + two
--                          partial unique indexes that together express the
--                          intent "one row per (key) for global; one row per
--                          (key, scope, scope_id) for non-global scopes".)
--            §5.11 tech-5 (helpers in schema `app`, not `auth` — applies to
--                          the audit trigger function below)
--            §B           (catálogo de chaves canônicas seeded by T-118)
--
-- Design notes:
--   * `setting_scope` enum = (global, household, user) — matches §5.5 verbatim.
--     Created via DO block so re-runs are idempotent (CREATE TYPE has no
--     IF NOT EXISTS equivalent until PG16 in some forks).
--   * `app_settings.id` is a surrogate uuid PK (gen_random_uuid()) — the
--     "natural" key `(key, scope, scope_id)` cannot be a PK because
--     `scope_id IS NULL` for the global scope and Postgres rejects NULL in
--     PK columns. Two partial unique indexes preserve the intended
--     uniqueness contract:
--       - `idx_settings_global_unique`  ON (key)                WHERE scope = 'global'
--       - `idx_settings_scoped_unique`  ON (key, scope, scope_id) WHERE scope <> 'global'
--     These give us the same guarantees as a composite PK without violating
--     SQL semantics, and they support the `ON CONFLICT` upsert path the
--     seed migration (T-118) and Edge Function setters will rely on.
--   * `chk_scope_id` CHECK encodes the invariant: global rows MUST have
--     scope_id NULL; non-global rows MUST have scope_id NOT NULL. Anything
--     else is a bug — fail loud at write time.
--   * `value jsonb NOT NULL` — values are wrapped as `{"v": <typed>}` in the
--     seed (T-118 / spec §B) so callers can do `value->'v'` without type
--     casts. The NOT NULL is on the column itself; "value=null" is allowed
--     via the JSONB null literal if a setting needs to express "unset".
--   * `requires_restart boolean DEFAULT false` — surfaces to admin UI when
--     a setting change cannot be hot-applied (used by §5.5 docs).
--   * `updated_by uuid REFERENCES auth.users(id)` — this is one of the
--     handful of audit columns that DOES keep an FK to auth.users: settings
--     audit lives forever (history table), but we still want referential
--     integrity in the "who changed this last" pointer so the field can be
--     joined to user_profiles. On user delete the FK action is implicit
--     NO ACTION — settings updates persist via the history row which
--     captures changed_by as a uuid SNAPSHOT (NOT an FK, see below).
--   * Indexes (all 3 from §5.5 verbatim):
--       - `idx_settings_category` (category, scope) — admin UI groups settings
--         by category and shows global vs scoped tabs.
--       - `idx_settings_lookup` (key, scope, scope_id) — hot path for the
--         cascade resolution in `getConfig`.
--       - `idx_settings_history_key` (key, changed_at DESC) — audit log UI.
--   * `app_settings_history` uses `bigserial` PK (history is append-only and
--     volume can grow — bigint avoids the 2.1B ceiling). `changed_by` here
--     is a `uuid REFERENCES auth.users(id)` (snapshot of who triggered the
--     change at the moment it happened). NOTE: this FK matches the spec
--     §5.5 verbatim; if Approach-A anonymize becomes a concern for history
--     we can drop the FK in a future migration (§5.10 §9.4).
--   * Trigger function `app.audit_app_settings()` lives in schema `app`
--     (per §5.11 tech-5: helpers MUST NOT pollute `auth.*` or `public.*`).
--     SECURITY DEFINER so the trigger can INSERT into history regardless of
--     the caller's grants (RLS will be added by T-114; service_role and
--     admins will be the only writers). `search_path` is pinned to
--     `app, public, pg_temp` to defeat search_path hijacking.
--   * Trigger fires AFTER INSERT OR UPDATE — INSERT logs the creation with
--     old_value = NULL, UPDATE logs old_value = OLD.value, new_value = NEW.value.
--     The spec text ("Trigger AFTER INSERT/UPDATE em app_settings grava em
--     history") explicitly lists both events; the T-123 test suite asserts
--     both paths.
--   * Idempotent throughout: CREATE TYPE in DO/EXCEPTION block;
--     CREATE TABLE/INDEX IF NOT EXISTS; CREATE OR REPLACE FUNCTION;
--     DROP TRIGGER IF EXISTS + CREATE TRIGGER; CHECK adds wrapped in DO.
--   * RLS is enabled and policy-bound in T-114 (separate migration).
-- ============================================================================


-- ============================================================================
-- 1. setting_scope enum
-- ============================================================================
-- Postgres lacks `CREATE TYPE ... IF NOT EXISTS`, so we wrap in a DO block
-- that swallows the `duplicate_object` exception on re-run.
DO $$
BEGIN
  CREATE TYPE public.setting_scope AS ENUM ('global', 'household', 'user');
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END
$$;

COMMENT ON TYPE public.setting_scope IS
  'Escopo de uma config runtime. Cascade resolution no helper getConfig: '
  'user -> household -> global -> default no código (spec §5.5).';


-- ============================================================================
-- 2. app_settings — runtime config store
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.app_settings (
  id               uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  key              text NOT NULL,
  scope            public.setting_scope NOT NULL DEFAULT 'global',
  scope_id         uuid,                                       -- NULL pra global
  value            jsonb NOT NULL,
  category         text NOT NULL,
  description      text,
  requires_restart boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES auth.users(id)
);

COMMENT ON TABLE public.app_settings IS
  'Configurações runtime do Unibill (features flags, sync params, thresholds, '
  'circuit breakers, capacity etc — catálogo completo no spec §B). Escopo '
  'cascade: user -> household -> global -> default no código (helper '
  'getConfig, TTL 30s, implementado em Edge Functions). PK é surrogate uuid '
  'porque Postgres não permite NULL em PRIMARY KEY (scope_id IS NULL pra '
  'global) — uniqueness lógica é garantida pelos 2 partial unique indexes '
  '(idx_settings_global_unique e idx_settings_scoped_unique). RLS em T-114.';

COMMENT ON COLUMN public.app_settings.id IS
  'Surrogate PK (uuid). Não tem significado de negócio — é só pra contornar '
  'a restrição "no NULLs in PK" do Postgres (spec §5.11 tech-3).';
COMMENT ON COLUMN public.app_settings.key IS
  'Chave canônica da config (ex: features.email_sync, sync.poll_interval_min). '
  'Catálogo completo no spec §B; seed em T-118.';
COMMENT ON COLUMN public.app_settings.scope IS
  'Escopo da config: global | household | user. Default global.';
COMMENT ON COLUMN public.app_settings.scope_id IS
  'NULL para scope=global; uuid do household/user para os outros escopos. '
  'Invariante enforced via CHECK chk_scope_id.';
COMMENT ON COLUMN public.app_settings.value IS
  'Valor JSONB. Convenção (spec §B / seed T-118): wrap como {"v": <typed>} '
  'pra facilitar acesso sem cast (value->>"v" ou value->"v" conforme tipo).';
COMMENT ON COLUMN public.app_settings.category IS
  'Categoria da config (features, sync, extraction, ai, capacity, retention, '
  'security, notifications, legal — ver spec §B). Indexada para o admin UI.';
COMMENT ON COLUMN public.app_settings.description IS
  'Descrição humana da config — copiada do spec §B no seed T-118.';
COMMENT ON COLUMN public.app_settings.requires_restart IS
  'TRUE se a mudança da config não pode ser hot-applied — UI sinaliza '
  'necessidade de reiniciar workers/edge functions.';
COMMENT ON COLUMN public.app_settings.updated_at IS
  'Timestamp da última modificação (default now()). Atualizado pelo trigger '
  'app.set_updated_at em UPDATEs.';
COMMENT ON COLUMN public.app_settings.updated_by IS
  'uuid do último user a modificar (FK -> auth.users.id, NO ACTION). Snapshot '
  'permanente do histórico vai pra app_settings_history.changed_by.';


-- ============================================================================
-- 3. CHECK constraint chk_scope_id — scope vs scope_id consistency
-- ============================================================================
-- Idempotente: drop+add dentro de DO block (CHECK não tem IF NOT EXISTS na
-- forma ALTER TABLE ADD CONSTRAINT). Usamos pg_constraint pra detectar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.app_settings'::regclass
      AND conname  = 'chk_scope_id'
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT chk_scope_id CHECK (
        (scope = 'global'  AND scope_id IS NULL) OR
        (scope <> 'global' AND scope_id IS NOT NULL)
      );
  END IF;
END
$$;


-- ============================================================================
-- 4. Partial unique indexes (replace illegal composite PK with NULL)
-- ============================================================================
-- 4a. Um único registro por `key` quando scope = 'global'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_global_unique
  ON public.app_settings(key)
  WHERE scope = 'global';

COMMENT ON INDEX public.idx_settings_global_unique IS
  'Garante uniqueness lógica de (key) quando scope=global. Substitui a parte '
  'global do composite PK que o Postgres não aceita (NULL em PK).';

-- 4b. Um único registro por (key, scope, scope_id) quando scope <> 'global'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_scoped_unique
  ON public.app_settings(key, scope, scope_id)
  WHERE scope <> 'global';

COMMENT ON INDEX public.idx_settings_scoped_unique IS
  'Garante uniqueness lógica de (key, scope, scope_id) para scopes household/user. '
  'Junto com idx_settings_global_unique e o CHECK chk_scope_id, expressa o '
  'invariante "uma config por chave por escopo" sem usar PK composta com NULL.';


-- ============================================================================
-- 5. Supporting indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_settings_category
  ON public.app_settings(category, scope);

COMMENT ON INDEX public.idx_settings_category IS
  'Index para o admin UI agrupar configs por categoria e separar global/escopos.';

CREATE INDEX IF NOT EXISTS idx_settings_lookup
  ON public.app_settings(key, scope, scope_id);

COMMENT ON INDEX public.idx_settings_lookup IS
  'Hot path do getConfig: lookup por (key, scope, scope_id) na cascade '
  'user -> household -> global.';


-- ============================================================================
-- 6. Trigger BEFORE UPDATE -> bump updated_at (reusa helper genérico T-107)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_app_settings_set_updated_at ON public.app_settings;
CREATE TRIGGER trg_app_settings_set_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION app.set_updated_at();


-- ============================================================================
-- 7. app_settings_history — audit ledger (append-only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.app_settings_history (
  id         bigserial PRIMARY KEY,
  key        text NOT NULL,
  scope      public.setting_scope NOT NULL,
  scope_id   uuid,
  old_value  jsonb,
  new_value  jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES auth.users(id)
);

COMMENT ON TABLE public.app_settings_history IS
  'Audit log append-only de mudanças em app_settings. Cada INSERT/UPDATE em '
  'app_settings dispara uma row aqui via trigger app.audit_app_settings. '
  'bigserial PK porque volume pode crescer no longo prazo (admin UI, '
  'seed reruns, capacity tuning). RLS em T-114 (service_role write, admin '
  'read via sys-admin claim).';

COMMENT ON COLUMN public.app_settings_history.id IS
  'PK bigserial — append-only ledger, ordem de inserção define ordem temporal.';
COMMENT ON COLUMN public.app_settings_history.key IS
  'Snapshot da key no momento da mudança (não é FK pra app_settings — a '
  'history sobrevive ao DELETE da row original).';
COMMENT ON COLUMN public.app_settings_history.scope IS
  'Snapshot do scope no momento da mudança.';
COMMENT ON COLUMN public.app_settings_history.scope_id IS
  'Snapshot do scope_id no momento da mudança (NULL pra global).';
COMMENT ON COLUMN public.app_settings_history.old_value IS
  'Valor JSONB anterior. NULL no caso de INSERT (criação inicial da config).';
COMMENT ON COLUMN public.app_settings_history.new_value IS
  'Valor JSONB novo (após a mudança). NOT NULL.';
COMMENT ON COLUMN public.app_settings_history.changed_at IS
  'Timestamp da mudança (default now()).';
COMMENT ON COLUMN public.app_settings_history.changed_by IS
  'uuid do user que disparou a mudança (FK -> auth.users.id). Pode ser NULL '
  'quando a mudança vem de service_role / pg_cron sem session JWT.';

CREATE INDEX IF NOT EXISTS idx_settings_history_key
  ON public.app_settings_history(key, changed_at DESC);

COMMENT ON INDEX public.idx_settings_history_key IS
  'Hot path para o UI de audit log: histórico de uma key ordenado por tempo decrescente.';


-- ============================================================================
-- 8. app.audit_app_settings() — trigger function (SECURITY DEFINER)
-- ============================================================================
-- Fires AFTER INSERT OR UPDATE on public.app_settings. Insere uma linha em
-- public.app_settings_history snapshotando (key, scope, scope_id) e os
-- valores old/new. INSERT -> old_value = NULL; UPDATE -> old_value = OLD.value.
--
-- SECURITY DEFINER: o trigger precisa escrever em history mesmo quando o
-- caller (Edge Function rodando como authenticated, ou um admin via UI) não
-- tem grant direto na history. RLS de T-114 vai bloquear writes diretos.
-- search_path pinned (app, public, pg_temp) — defesa contra hijack.
--
-- changed_by: tenta resolver via NEW.updated_by; cai pra auth.uid() (JWT
-- claim) se houver session ativa; aceita NULL para writes de service_role
-- / pg_cron jobs (esperado).
CREATE OR REPLACE FUNCTION app.audit_app_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public, pg_temp
AS $$
DECLARE
  v_old_value jsonb;
  v_changed_by uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_value := OLD.value;
  ELSE  -- INSERT
    v_old_value := NULL;
  END IF;

  -- Prefer NEW.updated_by (set explicitly by the writer); fall back to JWT.
  v_changed_by := NEW.updated_by;
  IF v_changed_by IS NULL THEN
    BEGIN
      v_changed_by := auth.uid();
    EXCEPTION
      WHEN OTHERS THEN
        v_changed_by := NULL;
    END;
  END IF;

  INSERT INTO public.app_settings_history (
    key, scope, scope_id, old_value, new_value, changed_at, changed_by
  )
  VALUES (
    NEW.key, NEW.scope, NEW.scope_id, v_old_value, NEW.value, now(), v_changed_by
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.audit_app_settings() IS
  'Trigger AFTER INSERT OR UPDATE em public.app_settings. Insere snapshot '
  '(key, scope, scope_id, old_value, new_value, changed_by) em '
  'public.app_settings_history. SECURITY DEFINER + search_path pinned '
  '(app, public, pg_temp). changed_by resolve via NEW.updated_by -> auth.uid() '
  '-> NULL. Ver §5.5 (audit-via-trigger).';


-- ============================================================================
-- 9. trg_audit_app_settings — AFTER INSERT OR UPDATE em app_settings
-- ============================================================================
-- DROP+CREATE pra idempotência (CREATE TRIGGER IF NOT EXISTS não existe).
DROP TRIGGER IF EXISTS trg_audit_app_settings ON public.app_settings;
CREATE TRIGGER trg_audit_app_settings
  AFTER INSERT OR UPDATE ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION app.audit_app_settings();


-- ============================================================================
-- 10. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615120500_create_app_settings',
  'Tabela public.app_settings (surrogate uuid PK + 2 partial unique indexes '
  'idx_settings_global_unique/idx_settings_scoped_unique substituindo PK '
  'composta com NULL — spec §5.11 tech-3) + CHECK chk_scope_id + indexes '
  'idx_settings_category, idx_settings_lookup. Tabela '
  'public.app_settings_history (bigserial PK) + idx_settings_history_key. '
  'Função app.audit_app_settings() SECURITY DEFINER + trigger '
  'trg_audit_app_settings AFTER INSERT OR UPDATE.'
)
ON CONFLICT (migration_name) DO NOTHING;
