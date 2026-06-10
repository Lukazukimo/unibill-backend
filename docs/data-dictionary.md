<!--
  docs/data-dictionary.md
  ------------------------------------------------------------------
  Initial (P0-P1) data dictionary for the Unibill backend.
  Task:      T-126
  Spec refs: §5 (data model), §5.1, §5.5, §5.9, §5.10, §5.12, §G
  Date:      2026-06-10

  CONTRACT
    This file is HUMAN-AUTHORED for the P0-P1 baseline but is
    regenerated *in place* by `scripts/gen_data_dictionary.ts` when
    pointed at a database that has the P0-P1 migrations applied.
    Edit text inside the generated section only by editing the SQL
    `COMMENT ON COLUMN` text and re-running the generator —
    otherwise the next regeneration will overwrite your changes.

    The generator preserves the static prologue below (everything
    before the BEGIN-GENERATED marker) and the static epilogue
    (everything after the END-GENERATED marker). Only the body
    between the two markers is regenerated.

  AUDIT
    A CI check (T-126 follow-up, wired by main loop) runs
    `deno run --allow-all scripts/gen_data_dictionary.ts --check`
    against `docs/data-dictionary.md`; non-zero diff fails the
    build. Until that wiring lands the docs are still hand-kept
    against `20260615121100_add_business_comments_p0.sql`.

  SCOPE
    P0-P1 tables only (8). The remaining tables (`connected_emails`,
    `connected_email_households`, `invoices`, `invoice_categories`,
    `utility_parsers`, observability suite, capacity suite,
    resilience suite) get their own sections appended by later
    phases — each phase will add its own `### <table>` block
    inside the generated body.
-->

# Data Dictionary — Unibill backend

> **Scope:** every column of every P0-P1 table, mirroring the canonical `COMMENT ON COLUMN` text from migration `20260615121100_add_business_comments_p0.sql` (spec **§G**). For the ERD see [`./erd-p0.md`](./erd-p0.md). For RLS policy summaries see spec **§5.11**. For audit-FK rules see spec **§5.10**.

> **How to regenerate:** `deno run --allow-net --allow-read --allow-write scripts/gen_data_dictionary.ts --conn "$DATABASE_URL"` (defaults to `postgres://postgres:postgres@127.0.0.1:54322/postgres`). Pass `--check` to fail on any diff (used in CI).

## Conventions

- **Nullable** is taken from `information_schema.columns.is_nullable` — a column with `NOT NULL` is rendered as `no`.
- **Default** is the raw `column_default` (e.g. `extensions.gen_random_uuid()`, `now()`, `'global'::public.setting_scope`). `—` means no default.
- **Type** uses the Postgres-displayed name (`uuid`, `text`, `timestamp with time zone`, `public.member_role`, `bigserial`, etc.).
- **Description** is the column's `COMMENT ON COLUMN` text loaded via `pg_description`. Empty means the column has not yet received a canonical comment — file a ticket; commenting is required by §G.

<!-- BEGIN-GENERATED:p0-p1 -->

### `public.system_actors` (spec §5.10)

**Purpose:** Sentinel actors — UUIDs estáveis usados como ponteiros "fora-de-`auth.users`" em colunas de audit (`created_by`, `updated_by`, `paid_by`, `invited_by`, `actor_user_id`, `changed_by`, `granted_by`, `used_by`). Permite anonimização LGPD sem violar FK e exibe rótulos amigáveis ("Usuário removido", "Sistema") via `app.user_display_name(uuid)`.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | no | — | UUID determinístico (`00000000-0000-0000-0000-00000000000{1,2,3}`). NÃO usar `gen_random_uuid` — os ids são referenciados literalmente em `app.anonymize_user_references` (§9.4) e em código de aplicação que resolve rótulos via `app.user_display_name(uuid)`. |
| `kind` | `text` | no | — | Categoria do actor (enum textual fechado): `deleted_user` (usuário anonimizado por LGPD §9.4); `system_worker` (jobs pg_cron / Edge Functions que escrevem audit columns sem JWT de user); `system_admin_bootstrap` (admin inicial criado antes do primeiro promote via claim `is_system_admin` — ver §9.2 e `scripts/bootstrap_sys_admin.sh`). |
| `display_name` | `text` | no | — | Rótulo humano exibido na UI quando o actor é resolvido via `app.user_display_name(uuid)`. pt-BR por default (ex: "Usuário removido", "Sistema", "Admin (bootstrap)"). |
| `created_at` | `timestamp with time zone` | no | `now()` | Timestamp de criação da row. Imutável; re-runs idempotentes preservam o valor original via `ON CONFLICT (id) DO NOTHING`. |

---

### `public.households` (spec §5.1)

**Purpose:** Agregado multi-tenant raiz. Cada household agrupa membros, emails conectados, faturas e settings próprios. Soft-delete via `deleted_at`. `created_by` é uuid puro sem FK (§5.10 Approach A — pode apontar para `auth.users(id)` ou `system_actors(id)` após anonymize).

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | no | `extensions.gen_random_uuid()` | PK gerado por `extensions.gen_random_uuid()`. Referenciado por `members`, `invoices`, `connected_email_households`, `app_settings` (scope=household), etc. |
| `name` | `text` | no | — | Nome amigável escolhido pelo criador (ex: "Casa do Centro", "República 42"). text livre; UI sanitiza/trunca; sem unicidade global (cada user pode ter seu próprio "Casa"). |
| `created_at` | `timestamp with time zone` | no | `now()` | Timestamp de criação (imutável). |
| `updated_at` | `timestamp with time zone` | no | `now()` | Atualizado automaticamente pelo trigger `trg_households_set_updated_at` (BEFORE UPDATE, executa `app.set_updated_at`). |
| `created_by` | `uuid` | no | — | UUID do criador. **SEM FK constraint** — pode referenciar `auth.users(id)` durante uso normal OU `public.system_actors(id)` após anonymize (§5.10 Approach A). Display via `app.user_display_name(uuid)`. |
| `deleted_at` | `timestamp with time zone` | yes | — | Soft-delete marker. NULL = household ativo; NOT NULL = removido. RLS (T-114) oculta rows soft-deletadas em queries normais; hard-delete só acontece via fluxo LGPD §9.4. |

---

### `public.members` (spec §5.1)

**Purpose:** Junção `households ↔ auth.users` com role e soft-delete. Partial unique index em `(household_id, user_id) WHERE deleted_at IS NULL` permite re-add após soft-delete. Trigger `enforce_min_one_admin` garante que nenhum household fique sem admin.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | no | `extensions.gen_random_uuid()` | PK gerado por `extensions.gen_random_uuid()`. |
| `household_id` | `uuid` | no | — | FK para `public.households(id)`. Ownership real — mantém FK (§5.10). |
| `user_id` | `uuid` | no | — | FK para `auth.users(id)`. Ownership real — mantém FK (§5.10: colunas `user_id` são ownership, audit columns como `invited_by` não têm FK). |
| `role` | `public.member_role` | no | `'member'` | `admin` ou `member`. Trigger `enforce_min_one_admin` bloqueia rebaixamento/remoção do último admin. Mudanças passam por `app.is_household_admin()`. |
| `invited_by` | `uuid` | yes | — | UUID do convidador. **SEM FK** — pode ser `auth.users(id)` ou `system_actors(id)` após anonymize (§5.10 Approach A — audit column). |
| `joined_at` | `timestamp with time zone` | no | `now()` | Quando o user aceitou o convite e foi inserido em `members`. |
| `created_at` | `timestamp with time zone` | no | `now()` | Imutável; `joined_at` e `created_at` coincidem na inserção normal. |
| `updated_at` | `timestamp with time zone` | no | `now()` | Mantido por `trg_members_set_updated_at`. |
| `deleted_at` | `timestamp with time zone` | yes | — | Soft-delete. Partial unique index permite reativar o mesmo user no household criando uma nova row. |

---

### `public.household_invitations` (spec §5.1)

**Purpose:** Convites por código (8 chars alfanuméricos maiúsculos) para adicionar membros a um household. TTL default 7 dias. `invited_email` opcional trava o convite ao email de `auth.users` (validado em `/invitations/redeem`). `used_at`/`used_by` preenchidos atomicamente no consumo.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | no | `extensions.gen_random_uuid()` | PK gerado por `extensions.gen_random_uuid()`. |
| `household_id` | `uuid` | no | — | FK para `public.households(id)` — o household para o qual o convite dá acesso. |
| `code` | `text` | no | — | 8 chars alfanuméricos maiúsculos (`A-Z0-9`), globalmente único (UNIQUE). Gerado pelo Edge Function `/invitations/create`. |
| `role` | `public.member_role` | no | `'member'` | Role que o redeemer assumirá ao aceitar. Default `member`; admin pode emitir convites de admin. |
| `invited_email` | `text` | yes | — | Opcional: trava o convite ao email do `auth.users` (matching case-insensitive). Quando NULL, qualquer usuário autenticado com o `code` pode aceitar. |
| `created_by` | `uuid` | no | — | UUID do emissor (audit, SEM FK). Em uso normal aponta para `auth.users(id)`; após anonymize aponta para `system_actors(id)`. |
| `created_at` | `timestamp with time zone` | no | `now()` | Quando o convite foi emitido (imutável). |
| `expires_at` | `timestamp with time zone` | no | `now() + interval '7 days'` | Após este timestamp o convite é inválido mesmo se ainda não usado. |
| `used_at` | `timestamp with time zone` | yes | — | Quando o redeemer aceitou. Convites são single-use; `used_at IS NOT NULL` impede reuso. |
| `used_by` | `uuid` | yes | — | UUID de quem aceitou (audit, SEM FK). Pode virar `system_actors.deleted_user` após anonymize. |

---

### `public.user_profiles` (spec §5.12)

**Purpose:** Dados display-friendly do usuário (`display_name`, avatar, locale, theme) — espelha o que `auth.users.raw_user_meta_data` não deveria carregar (mutável pelo cliente, sem RLS). Criado automaticamente no signup pelo trigger `trg_create_user_profile` em `auth.users`.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `user_id` | `uuid` | no | — | PK + FK para `auth.users(id) ON DELETE CASCADE` — quando o GoTrue deleta o user, o profile vai junto (sem necessidade de cleanup separado). |
| `display_name` | `text` | no | — | Nome exibido em UI. Default no trigger: `raw_user_meta_data->>'display_name'` ou `split_part(email, '@', 1)`. |
| `avatar_url` | `text` | yes | — | URL pública (Supabase Storage signed URL ou external). Sem validação de scheme — UI escolhe `<img>` vs fallback. |
| `locale` | `text` | no | `'pt-BR'` | CHECK constraint `IN ('pt-BR', 'en-US')`. Drives templates de email, formatação de datas/moeda e textos de UI (spec §8.4). |
| `theme` | `text` | no | `'system'` | CHECK `IN ('system', 'light', 'dark')`. Quando `system`, o cliente segue a preferência do OS. |
| `created_at` | `timestamp with time zone` | no | `now()` | Criado pelo trigger `trg_create_user_profile` (AFTER INSERT em `auth.users`). |
| `updated_at` | `timestamp with time zone` | no | `now()` | Mantido por `trg_user_profiles_set_updated_at`. |

---

### `public.app_settings` (spec §5.5)

**Purpose:** Configurações runtime do Unibill (feature flags, sync params, thresholds, circuit breakers, capacity — catálogo completo em spec §B). Escopo cascade `user → household → global → default no código`; helper `getConfig(key, default, scope?)` cache TTL 30s.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | no | `extensions.gen_random_uuid()` | Surrogate PK (Postgres não permite NULL em colunas de PK, então usamos id + 2 partial unique indexes em vez de PK composta). |
| `key` | `text` | no | — | Chave canônica do setting (ex: `sync.poll_interval_seconds`, `ai.chain.gemini.enabled`). Listada em spec §B. |
| `scope` | `public.setting_scope` | no | `'global'` | `global` = uma row por key (`scope_id=NULL`); `household` = uma row por (key, `scope_id`=household_id); `user` = uma row por (key, `scope_id`=user_id). Resolução: user > household > global > default no código. |
| `scope_id` | `uuid` | yes | — | NULL quando `scope='global'`; senão referencia `households(id)` ou `auth.users(id)`. CHECK `(scope='global' AND scope_id IS NULL) OR (scope<>'global' AND scope_id IS NOT NULL)`. |
| `value` | `jsonb` | no | — | Valor canônico. Schema versionado (`{version, data}`) para settings complexos. Tipo runtime validado pelo helper antes de retornar. |
| `category` | `text` | no | — | Agrupamento livre para UI (ex: `sync`, `ai`, `capacity`). Drives a tela `/sys-admin/settings`. |
| `description` | `text` | yes | — | Texto curto exibido na UI ao lado do setting. Default vem do catálogo em spec §B. |
| `requires_restart` | `boolean` | no | `false` | Se TRUE, mudança exige invalidação manual do cache de 30s. Sinaliza para UI mostrar warning. |
| `updated_at` | `timestamp with time zone` | no | `now()` | Bumped por trigger `trg_app_settings_audit` antes de gravar history. |
| `updated_by` | `uuid` | yes | — | Quem fez a última mudança. **Mantém FK leve para `auth.users(id)`** (settings UI é sempre human-driven; sys-admins logam JWT). Audit completa em `app_settings_history`. |

---

### `public.app_settings_history` (spec §5.5)

**Purpose:** Audit log append-only de mudanças em `app_settings`. Cada INSERT/UPDATE no parent grava uma linha aqui via trigger `trg_app_settings_audit`. RLS replica o predicate do parent.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `bigserial` | no | (sequence) | PK incremental — facilita ordenação cronológica e paginação. |
| `key` | `text` | no | — | Mesma key do parent na hora da mudança. |
| `scope` | `public.setting_scope` | no | — | Snapshot do scope no momento da mudança. |
| `scope_id` | `uuid` | yes | — | Snapshot do scope_id (NULL se global). |
| `old_value` | `jsonb` | yes | — | Valor anterior (NULL na primeira inserção). |
| `new_value` | `jsonb` | no | — | Valor novo aplicado. |
| `changed_at` | `timestamp with time zone` | no | `now()` | Quando a mudança foi gravada (imutável). |
| `changed_by` | `uuid` | yes | — | Quem fez a mudança (audit, SEM FK pesado). Pode virar `system_actors.deleted_user` após anonymize. |

---

### `public.consent_log` (spec §5.9)

**Purpose:** LGPD art. 8 §5 — evidência granular de consentimento por finalidade (`purpose`) com versioning (`version`) e revogação (`revoked_at`). Append-only por finalidade; unique partial index garante 1 consent ativo por (user, purpose). `anonymize_user_references` redireciona `user_id` para `system_actors.deleted_user` e zera `ip_address`/`user_agent`.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `uuid` | no | `extensions.gen_random_uuid()` | PK gerado por `extensions.gen_random_uuid()`. |
| `user_id` | `uuid` | no | — | FK para `auth.users(id)` enquanto ativo; após anonymize aponta para `system_actors(id)` sentinel `deleted_user`. Mantemos a row porque LGPD obriga retenção da evidência de consentimento. |
| `purpose` | `public.consent_purpose` | no | — | `terms`, `privacy`, `telemetry` ou `marketing`. `terms`+`privacy` obrigatórios para usar o app; `telemetry` opt-in; `marketing` reservado para roadmap. |
| `version` | `text` | no | — | Versão do documento aceito (ex: `terms-v1.2-2026-06`). Drives re-consent automático quando `app_settings.legal.terms_version` muda. |
| `legal_basis` | `text` | no | — | `consent`, `legitimate_interest`, `legal_obligation` ou `contract`. Texto livre para flexibilidade jurídica futura; UI/JOIN comparam contra constantes conhecidas. |
| `accepted_at` | `timestamp with time zone` | no | `now()` | Quando o consent foi aceito (imutável). |
| `revoked_at` | `timestamp with time zone` | yes | — | NULL = consent ativo; preenchido na revogação. Index parcial `WHERE revoked_at IS NULL` garante 1 consent ativo por (user, purpose). |
| `revoked_reason` | `text` | yes | — | Texto livre (ex: `user_request`, `terms_version_bump`). |
| `ip_address` | `inet` | yes | — | IP do client no momento do consent. Zerado durante anonymize. `inet` > `text` para storage eficiente e validação automática. |
| `user_agent` | `text` | yes | — | User-Agent header completo. Zerado durante anonymize. |

<!-- END-GENERATED:p0-p1 -->

## Future tables (placeholder)

The following tables will be appended to the generated body by subsequent phases. Until each phase's `add_business_comments_<scope>.sql` migration lands, the corresponding section here will appear with empty `Description` cells — flagging missing coverage.

- §5.2 — `connected_emails`, `connected_email_households`
- §5.3 — `invoices`
- §5.4 — `invoice_categories`, `utility_parsers`
- §5.6 — `sync_runs`, `extraction_runs`, `ai_calls`, `domain_events`
- §5.7 — capacity (`capacity_snapshots`, `eviction_runs`, `pdf_archive_log`)
- §5.8 — resilience (`circuit_breakers`, `rate_limit_buckets`)
- §5.13 — Storage layout (described, no SQL tables)

## Regeneration script

The dictionary above is rendered by `scripts/gen_data_dictionary.ts`. The script:

1. Connects to a Postgres database (`--conn` flag or `DATABASE_URL`).
2. Lists every base table in schemas `public` (and, in future, `app` for helper-internal state).
3. For each table, joins `information_schema.columns` with `pg_description` (via `pg_class.oid` / `objsubid` for column comments) to produce a stable, alphabetised-by-table-but-spec-ordered list.
4. Renders the markdown body between the `<!-- BEGIN-GENERATED:p0-p1 -->` / `<!-- END-GENERATED:p0-p1 -->` markers.
5. With `--check`, refuses to write and exits non-zero if the rendered body differs from the existing file — that's what CI runs.

The script accepts `--scope p0-p1` (default) to restrict the table list to the P0-P1 set. Later phases will pass `--scope p2-p3`, etc., each owning its own marker pair.
