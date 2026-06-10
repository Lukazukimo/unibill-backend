<!--
  docs/erd-p0.md
  ------------------------------------------------------------------
  Entity-Relationship Diagram for the P0-P1 schema slice of Unibill.
  Task:      T-126
  Spec refs: §5 (data model), §5.1, §5.5, §5.9, §5.10, §5.11, §5.12
             §G (column comment strategy)
  Date:      2026-06-10

  Tables covered (8): households, members, household_invitations,
  user_profiles, system_actors, app_settings, app_settings_history,
  consent_log.

  Out-of-scope (covered by sibling ERDs in later phases):
    - connected_emails / connected_email_households  (§5.2 — P2-P3)
    - invoices / invoice_categories / utility_parsers (§5.3-§5.4 — P4+)
    - sync_runs / extraction_runs / ai_calls / domain_events (§5.6 — P4+)
    - capacity / resilience / observability tables (§5.7-§5.8 — P5+)

  Conventions used in the diagram below:
    - PK markers on every primary-key column.
    - FK markers ONLY on columns that carry an actual SQL FOREIGN KEY
      (i.e. ownership columns per §5.10 Approach A). Audit columns
      such as `created_by`, `updated_by`, `invited_by`, `used_by`,
      `changed_by` are uuid-only (no FK) and are annotated as
      `uuid (audit, no FK)` in the column listing.
    - Soft-deleted rows are excluded from partial unique indexes —
      the diagram notes those constraints in a dedicated section
      below the diagram (Mermaid does not model partial indexes).

  How to view: GitHub renders Mermaid natively in markdown previews.
  For local preview run `npx @mermaid-js/mermaid-cli -i docs/erd-p0.md -o /tmp/erd-p0.svg`
  or paste the diagram block into https://mermaid.live.
-->

# ERD — P0-P1 schema (households, identity, settings, consent)

> Scope: 8 tables that ship in the P0-P1 phase. See [`../../docs/superpowers/specs/2026-06-08-unibill-mvp-design.md`](../../docs/superpowers/specs/2026-06-08-unibill-mvp-design.md) sections **§5.1** (households/members/invitations), **§5.5** (app_settings + history), **§5.9** (consent_log), **§5.10** (system_actors), **§5.11** (RLS recap) and **§5.12** (user_profiles). Column-level business semantics live in spec **§G** and migration `20260615121100_add_business_comments_p0.sql`.

> Tables added in later phases (`connected_emails`, `invoices`, `sync_runs`, `ai_calls`, `domain_events`, …) are intentionally **not** drawn here — each phase ships its own ERD focused on the slice it owns. The data dictionary [`./data-dictionary.md`](./data-dictionary.md) follows the same scope.

---

## 1. Diagram

```mermaid
erDiagram
    AUTH_USERS ||--o{ MEMBERS                : "user_id (ownership FK)"
    AUTH_USERS ||--|| USER_PROFILES          : "user_id (ownership FK, ON DELETE CASCADE)"
    AUTH_USERS ||--o{ CONSENT_LOG            : "user_id (ownership FK)"

    HOUSEHOLDS ||--o{ MEMBERS                : "household_id"
    HOUSEHOLDS ||--o{ HOUSEHOLD_INVITATIONS  : "household_id"

    SYSTEM_ACTORS }o..o{ HOUSEHOLDS             : "created_by (audit, no FK)"
    SYSTEM_ACTORS }o..o{ MEMBERS                : "invited_by (audit, no FK)"
    SYSTEM_ACTORS }o..o{ HOUSEHOLD_INVITATIONS  : "created_by / used_by (audit, no FK)"
    SYSTEM_ACTORS }o..o{ APP_SETTINGS           : "updated_by (audit, no FK)"
    SYSTEM_ACTORS }o..o{ APP_SETTINGS_HISTORY   : "changed_by (audit, no FK)"
    SYSTEM_ACTORS }o..o{ CONSENT_LOG            : "user_id (after LGPD anonymize)"

    APP_SETTINGS ||--o{ APP_SETTINGS_HISTORY : "audit (key, scope, scope_id)"

    AUTH_USERS {
        uuid id PK
        text email "managed by GoTrue"
        jsonb raw_user_meta_data
    }

    SYSTEM_ACTORS {
        uuid id PK "00000000-0000-0000-0000-00000000000{1,2,3}"
        text kind UK "deleted_user | system_worker | system_admin_bootstrap"
        text display_name
        timestamptz created_at
    }

    HOUSEHOLDS {
        uuid id PK
        text name
        timestamptz created_at
        timestamptz updated_at
        uuid created_by "uuid (audit, no FK)"
        timestamptz deleted_at "soft-delete"
    }

    MEMBERS {
        uuid id PK
        uuid household_id FK "REFERENCES households(id)"
        uuid user_id FK "REFERENCES auth.users(id)"
        member_role role "admin | member"
        uuid invited_by "uuid (audit, no FK)"
        timestamptz joined_at
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at "soft-delete"
    }

    HOUSEHOLD_INVITATIONS {
        uuid id PK
        uuid household_id FK "REFERENCES households(id)"
        text code UK "8 chars alfanuméricos"
        member_role role "admin | member"
        text invited_email "opcional — trava ao email"
        uuid created_by "uuid (audit, no FK)"
        timestamptz created_at
        timestamptz expires_at "default now() + 7d"
        timestamptz used_at
        uuid used_by "uuid (audit, no FK)"
    }

    USER_PROFILES {
        uuid user_id PK_FK "REFERENCES auth.users(id) ON DELETE CASCADE"
        text display_name
        text avatar_url
        text locale "pt-BR | en-US"
        text theme "system | light | dark"
        timestamptz created_at
        timestamptz updated_at
    }

    APP_SETTINGS {
        uuid id PK "surrogate"
        text key
        setting_scope scope "global | household | user"
        uuid scope_id "NULL when scope=global"
        jsonb value
        text category
        text description
        boolean requires_restart
        timestamptz updated_at
        uuid updated_by "uuid (audit, no FK)"
    }

    APP_SETTINGS_HISTORY {
        bigserial id PK
        text key
        setting_scope scope
        uuid scope_id
        jsonb old_value
        jsonb new_value
        timestamptz changed_at
        uuid changed_by "uuid (audit, no FK)"
    }

    CONSENT_LOG {
        uuid id PK
        uuid user_id FK "REFERENCES auth.users(id)"
        consent_purpose purpose "terms | privacy | telemetry | marketing"
        text version "ex: terms-v1.2-2026-06"
        text legal_basis "consent | legitimate_interest | legal_obligation | contract"
        timestamptz accepted_at
        timestamptz revoked_at "NULL = ativo"
        text revoked_reason
        inet ip_address
        text user_agent
    }
```

> Notation reminder:
> - `||--o{`  one-to-many with real SQL FK.
> - `||--||`  one-to-one with real SQL FK.
> - `}o..o{`  many-to-many *logical* link with **no** FK constraint (audit columns per §5.10 Approach A — uuid puro pointing at either `auth.users(id)` or `system_actors(id)`).
> - Dashed lines reinforce "validated in app/RLS, not in DDL".

---

## 2. Enums used above

| Enum | Values | Defined in |
|---|---|---|
| `public.member_role` | `admin`, `member` | `20260615120200_create_members.sql` (§5.1) |
| `public.setting_scope` | `global`, `household`, `user` | `20260615120500_create_app_settings.sql` (§5.5) |
| `public.consent_purpose` | `terms`, `privacy`, `telemetry`, `marketing` | `20260615120600_create_consent_log.sql` (§5.9) |

---

## 3. Partial unique indexes (NOT modelled by Mermaid)

Mermaid `erDiagram` cannot represent partial indexes. The following constraints are essential for correctness of the P0-P1 model and are documented here for reviewers:

| Table | Index name | Definition | Purpose |
|---|---|---|---|
| `members` | `uq_members_household_user_active` | `UNIQUE (household_id, user_id) WHERE deleted_at IS NULL` | Allow re-adding a member after soft-delete (§5.1). |
| `household_invitations` | (PK on `id`) + `UNIQUE (code)` | Inline `UNIQUE` on `code` | Invite codes globally unique; no soft-delete here (invites are short-lived). |
| `app_settings` | `idx_settings_global_unique` | `UNIQUE (key) WHERE scope = 'global'` | Exactly one global row per key. |
| `app_settings` | `idx_settings_scoped_unique` | `UNIQUE (key, scope, scope_id) WHERE scope <> 'global'` | Exactly one row per (key, scope, scope_id) for household/user scopes. |
| `consent_log` | `uq_consent_active_per_purpose` | `UNIQUE (user_id, purpose) WHERE revoked_at IS NULL` | At most one active consent per (user, purpose) — supports granular revocation per §5.9. |

`app_settings` also carries a CHECK: `(scope = 'global' AND scope_id IS NULL) OR (scope <> 'global' AND scope_id IS NOT NULL)` — see migration header for rationale (Postgres forbids `NULL` in PK columns, so we use a surrogate PK + two partial indexes that express the real uniqueness intent).

---

## 4. RLS policy summary (spec §5.11)

Helpers live in schema `app` (never `auth` — Supabase manages `auth.*`). The functions used by the policies below are defined in `20260615120700_create_app_helpers.sql`:

- `app.households_of_user()` — set-returning function listing the household ids of the calling JWT user (active members only).
- `app.is_household_admin(uuid)` — boolean check that the caller is an `admin` member of the household.
- `app.is_system_admin()` — reads `auth.jwt() -> 'app_metadata' ->> 'is_system_admin'` defensively (empty / missing → `false`).

| Table | SELECT predicate | Write predicate (INSERT/UPDATE/DELETE) |
|---|---|---|
| `households` | `id IN (SELECT app.households_of_user())` (member-of) | `app.is_household_admin(id)` |
| `members` | `household_id IN (SELECT app.households_of_user())` | `app.is_household_admin(household_id)` |
| `household_invitations` | `app.is_household_admin(household_id)` | `app.is_household_admin(household_id)` |
| `user_profiles` | `user_id = auth.uid()` OR any household-mate (so member lists can show `display_name`) | `user_id = auth.uid()` |
| `system_actors` | `authenticated` read (needed to render "Usuário removido") | `service_role` only |
| `app_settings` (global) | all authenticated may read | `app.is_system_admin()` |
| `app_settings` (household) | `scope_id IN (SELECT app.households_of_user())` | `app.is_household_admin(scope_id)` |
| `app_settings` (user) | `scope_id = auth.uid()` | `scope_id = auth.uid()` |
| `app_settings_history` | replicates the parent predicate (`scope='global' AND app.is_system_admin()` OR `scope='household' AND scope_id IN app.households_of_user()` OR `scope='user' AND scope_id = auth.uid()`) | `service_role` only (history is append-only via trigger) |
| `consent_log` | `user_id = auth.uid()` OR `app.is_system_admin()` (audit) | `user_id = auth.uid()` (INSERT on signup; UPDATE only allowed for `revoked_at`/`revoked_reason`) |

Cross-tenant leakage is exercised by the pgTAP suite under `supabase/tests/rls/` — two users in different households, plus a sys-admin happy-path. Every policy listed above must have at least one positive and one negative test (T-115 / T-116 / T-122 / T-123).

---

## 5. Trigger / helper recap

| Trigger | Table | Defined in | Purpose |
|---|---|---|---|
| `trg_households_set_updated_at` | `households` | `20260615120100_*` | Bumps `updated_at` on every UPDATE via `app.set_updated_at()`. |
| `trg_members_set_updated_at` | `members` | `20260615120200_*` | Same as above. |
| `trg_min_one_admin` | `members` | `20260615120200_*` | BEFORE UPDATE / DELETE — refuses to remove / soft-delete / demote the last admin of a household (§5.1). |
| `trg_create_user_profile` | `auth.users` (AFTER INSERT) | `20260615120400_*` | Auto-creates a `user_profiles` row on signup with `display_name` defaulted from `raw_user_meta_data` or the email local-part (§5.12). |
| `trg_user_profiles_set_updated_at` | `user_profiles` | `20260615120400_*` | Bumps `updated_at`. |
| `trg_app_settings_audit` | `app_settings` (AFTER INSERT/UPDATE) | `20260615120500_*` | Writes diffs to `app_settings_history` (§5.5). |

---

## 6. Cross-references

- Column-level COMMENTs: spec **§G** and migration `20260615121100_add_business_comments_p0.sql`. Re-generated documentation lives in [`./data-dictionary.md`](./data-dictionary.md).
- LGPD anonymization (uses every audit column above): spec **§5.10**, **§9.4**, and (forthcoming) `app.anonymize_user_references(uuid)`.
- Sys-admin bootstrap (where `system_actors.kind = 'system_admin_bootstrap'` is consumed): spec **§9.2**, script `scripts/bootstrap_sys_admin.sh`.
