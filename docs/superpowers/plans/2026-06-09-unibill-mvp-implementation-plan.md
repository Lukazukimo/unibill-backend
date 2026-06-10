# Unibill — MVP Implementation Plan

| Campo | Valor |
|---|---|
| **Status** | Draft (aguardando revisão do usuário) |
| **Data** | 2026-06-09 |
| **Origem** | Workflow `unibill-implementation-plan` (6 agents × 6 fases) |
| **Spec** | [/docs/superpowers/specs/2026-06-08-unibill-mvp-design.md](../specs/2026-06-08-unibill-mvp-design.md) |
| **Total de tasks** | 182 |
| **Esforço estimado** | ~960h ≈ 120 dias-pessoa (solo, sem paralelismo) |

---

## Resumo executivo

**182 tasks** organizadas em **6 fases** (6 agents geraram em paralelo). Cada task = 1 PR (max ~8h de trabalho).

### Distribuição por tamanho

| Size | Count | Horas |
|---|---|---|
| XS (~0.5h) | 7 | 4h |
| S (~2h) | 57 | 114h |
| M (~5h) | 82 | 410h |
| L (~12h) | 36 | 432h |
| XL (~32h) | 0 | 0h |
| **Total** | **182** | **960h** |

### Distribuição por categoria

| Categoria | Count |
|---|---|
| `edge_function` | 48 |
| `migration` | 38 |
| `mobile_feature` | 36 |
| `test` | 18 |
| `ci` | 10 |
| `doc` | 9 |
| `config` | 7 |
| `ops` | 5 |
| `seed` | 5 |
| `infra` | 3 |
| `mobile_widget` | 3 |

**Profundidade máxima da árvore de dependências:** 16 níveis. Caminho crítico determina cronograma mínimo se trabalho for sequencial.

---

## Como usar este plano

- **Cada task tem ID único** (`T-XYZ` onde X é o agent number). Reference em PRs e commits: `feat: implement T-105 — create app schema`.
- **Dependencies** (`depends_on`) são explícitas. Pode usar pra agendar paralelizando entre devs/agents.
- **Spec refs** linkam pra seção(ões) do design doc que justificam a task.
- **Acceptance** são checkpoints verificáveis — usar em PR description ou test plan.
- **Categorias**: `migration`, `edge_function`, `mobile_feature`, `mobile_widget`, `test`, `config`, `seed`, `infra`, `ci`, `ops`, `doc`.
- **Sizes**: XS<1h, S=1-3h, M=3-8h, L=1-2d, XL=3-5d.
- Medium/low findings do self-review (94 items) estão **absorvidos** em tasks específicas (campo `medium_low_absorbed` quando aplicável).

### Ordenação recomendada

Trabalhe respeitando `depends_on`. Topological sort sugerido: começar por **depth=0** (tasks sem dependências) → ir aumentando.

**Caminho crítico** (longest path): identificável pela coluna `Depth` no detalhe de cada task abaixo.

---

## Índice de tasks

| ID | Title | Cat | Size | Depth | Depends |
|---|---|---|---|---|---|
| `T-101` | Create three GitHub repos with Apache-2.0 license and baseline structure | `infra` | `S` | 0 | — |
| `T-102` | Provision Supabase dev and prod projects | `infra` | `S` | 1 | `T-101` |
| `T-103` | Initialize Supabase CLI workspace in unibill-backend | `config` | `S` | 2 | `T-101`, `T-102` |
| `T-104` | Set up GitHub Actions secrets and base CI workflow scaffolding for unibill-backe | `ci` | `M` | 3 | `T-103` |
| `T-105` | Create app schema and bootstrap migration | `migration` | `S` | 3 | `T-103` |
| `T-106` | Migrate system_actors table with sentinel seeds | `migration` | `S` | 4 | `T-105` |
| `T-107` | Migrate households table | `migration` | `S` | 5 | `T-106` |
| `T-108` | Migrate members table with enforce_min_one_admin trigger and partial unique inde | `migration` | `M` | 6 | `T-107` |
| `T-109` | Migrate household_invitations table | `migration` | `S` | 7 | `T-108` |
| `T-110` | Migrate user_profiles table with auto-create-on-signup trigger | `migration` | `M` | 8 | `T-109` |
| `T-111` | Migrate app_settings + app_settings_history with audit trigger | `migration` | `M` | 9 | `T-110` |
| `T-112` | Migrate consent_log table with active-consent partial unique index | `migration` | `S` | 9 | `T-110` |
| `T-113` | Create RLS helper functions in app schema | `migration` | `S` | 7 | `T-108` |
| `T-114` | Enable RLS and create policies for P0-P1 tables | `migration` | `L` | 10 | `T-111`, `T-112`, `T-113` |
| `T-115` | pgTAP test suite for enforce_min_one_admin trigger | `test` | `M` | 7 | `T-108` |
| `T-116` | pgTAP cross-tenant RLS isolation tests for P0-P1 tables | `test` | `L` | 11 | `T-114` |
| `T-117` | Seed system_actors and bootstrap sys_admin promotion procedure | `ops` | `S` | 8 | `T-106`, `T-113` |
| `T-118` | Seed app_settings_defaults.sql with ~120 canonical keys from Appendix B | `seed` | `L` | 10 | `T-111` |
| `T-119` | Seed invoice_categories template (system defaults) | `seed` | `S` | 6 | `T-107` |
| `T-120` | CI script: check_config_docs_sync.py for app_settings drift | `ci` | `M` | 11 | `T-104`, `T-118` |
| `T-121` | Migration: add business COMMENT ON COLUMN for P0-P1 tables (Appendix G subset) | `migration` | `S` | 11 | `T-114` |
| `T-122` | pgTAP test suite for create_user_profile trigger | `test` | `S` | 9 | `T-110` |
| `T-123` | pgTAP test suite for app_settings history trigger and scope CHECK | `test` | `M` | 10 | `T-111` |
| `T-124` | Migration lint: structural invariants enforcement script | `ci` | `M` | 4 | `T-104` |
| `T-125` | Deno test scaffolding for _shared/ middlewares and helpers | `config` | `M` | 3 | `T-103` |
| `T-126` | Document P0-P1 schema in ERD + data dictionary skeleton | `doc` | `M` | 12 | `T-121` |
| `T-201` | Configure Supabase Auth (pt-BR, HIBP, session, password policy) | `config` | `M` | 1 | `T-101` |
| `T-202` | Customize Supabase Auth email templates (pt-BR) | `config` | `S` | 2 | `T-201` |
| `T-203` | Configure redirect URLs and Site URL for deep links | `config` | `XS` | 2 | `T-201` |
| `T-204` | Implement login lockout middleware (10 fails / 30min → 1h block + unlock link) | `edge_function` | `M` | 4 | `T-201`, `T-104` |
| `T-205` | Integrate hCaptcha on signup and password reset | `edge_function` | `M` | 5 | `T-201`, `T-204` |
| `T-206` | Migration: connected_emails + connected_email_households schema | `migration` | `M` | 2 | `T-102` |
| `T-207` | Migration: connected_emails COMMENT ON COLUMN metadata | `migration` | `S` | 3 | `T-206` |
| `T-208` | Migration: app.create_vault_secret + app.decrypt_app_password wrappers | `migration` | `S` | 2 | `T-102` |
| `T-209` | Migration: vault GRANT/REVOKE matrix | `migration` | `XS` | 3 | `T-208` |
| `T-210` | Migration: RLS policies for connected_emails + connected_email_households | `migration` | `M` | 3 | `T-206`, `T-103` |
| `T-211` | pgTAP RLS tests for connected_emails (cross-tenant + cross-binding) | `test` | `M` | 4 | `T-210` |
| `T-212` | Edge Function POST /emails/connect (IMAP validation + Vault) | `edge_function` | `L` | 5 | `T-206`, `T-208`, `T-210` +1 |
| `T-213` | Edge Function PATCH /emails/:id/rotate-password | `edge_function` | `M` | 6 | `T-212` |
| `T-214` | Edge Function DELETE /emails/:id (soft delete + revoke vault) | `edge_function` | `M` | 6 | `T-212` |
| `T-215` | Edge Function POST /invitations/redeem (rate limit + lockout + email match) | `edge_function` | `L` | 4 | `T-103`, `T-104` |
| `T-216` | Migration: system_admin_grants audit table + RLS | `migration` | `S` | 3 | `T-103` |
| `T-217` | Bootstrap script + audit row for first system admin | `ops` | `S` | 4 | `T-216` |
| `T-218` | Flutter auth feature module (welcome, signup, login, recovery, verify-callback) | `mobile_feature` | `L` | 6 | `T-204`, `T-205`, `T-219` |
| `T-219` | Configure AndroidManifest intent filter + custom URL scheme | `mobile_feature` | `S` | 3 | `T-203` |
| `T-220` | Flutter onboarding: create household OR redeem invite | `mobile_feature` | `M` | 7 | `T-215`, `T-218` |
| `T-221` | Flutter household feature module (members + invitations) | `mobile_feature` | `L` | 8 | `T-220` |
| `T-222` | Flutter emails feature module (connect, list, edit, rotate) | `mobile_feature` | `L` | 7 | `T-212`, `T-213`, `T-214` |
| `T-223` | Migration: user_profiles table + auto-create trigger + RLS | `migration` | `M` | 2 | `T-102` |
| `T-224` | Migration: consent_log table + indices + RLS | `migration` | `M` | 2 | `T-102` |
| `T-225` | Flutter LGPD consent screen at signup | `mobile_feature` | `M` | 7 | `T-218`, `T-224`, `T-228` |
| `T-226` | HIBP integration verification test (CI) | `test` | `S` | 2 | `T-201` |
| `T-227` | Migration: invited_email normalization + base32 code CHECK + redeem index | `migration` | `S` | 3 | `T-103` |
| `T-228` | Edge Functions POST /consent/accept and /consent/revoke | `edge_function` | `M` | 3 | `T-224` |
| `T-229` | Re-consent gate on login (status endpoint + client redirect) | `edge_function` | `M` | 8 | `T-225`, `T-228` |
| `T-230` | Shared edge-function helpers: imap, captcha, rateLimit, auth context | `edge_function` | `M` | 4 | `T-104` |
| `T-301` | Migration: invoices table with PIX/customer/service fields + partial unique inde | `migration` | `M` | 1 | `T-101` |
| `T-302` | Migration: invoice_categories table | `migration` | `XS` | 1 | `T-101` |
| `T-303` | Migration: link invoices.category_id FK to invoice_categories | `migration` | `XS` | 2 | `T-301`, `T-302` |
| `T-304` | Migration: utility_parsers table + active partial index | `migration` | `S` | 1 | `T-101` |
| `T-305` | Migration: domain_events table + indexes | `migration` | `S` | 1 | `T-101` |
| `T-306` | Migration: sync_runs + extraction_runs observability tables | `migration` | `S` | 2 | `T-101`, `T-301` |
| `T-307` | Migration: circuit_breakers + rate_limit_buckets resilience tables | `migration` | `S` | 1 | `T-101` |
| `T-308` | Migration: pgmq queues for email_sync + invoice (with DLQs) | `migration` | `S` | 1 | `T-101` |
| `T-309` | Migration: RLS policies for invoices, invoice_categories, utility_parsers, domai | `migration` | `M` | 3 | `T-301`, `T-302`, `T-304` +4 |
| `T-310` | Migration: pg_cron + pg_net wrapper private.invoke_edge_function | `migration` | `M` | 1 | `T-101` |
| `T-311` | Migration: register cron schedules for sync-dispatcher / sync-worker / cleanup | `migration` | `S` | 2 | `T-310` |
| `T-312` | Migration: business COMMENT ON COLUMN for invoices, utility_parsers, connected_e | `migration` | `S` | 2 | `T-301`, `T-304`, `T-201` |
| `T-313` | Seed: utility_parsers row for enel-sp (full regex set) | `seed` | `S` | 2 | `T-304` |
| `T-314` | Seed: placeholder rows for sabesp / comgas / vivo parsers | `seed` | `XS` | 2 | `T-304` |
| `T-315` | _shared/ helper: redactSecrets middleware (with all patterns) | `edge_function` | `S` | 0 | — |
| `T-316` | _shared/ helper: withCorrelation + logging | `edge_function` | `S` | 1 | `T-315` |
| `T-317` | _shared/ helper: withIdempotency | `edge_function` | `S` | 2 | `T-316` |
| `T-318` | _shared/ helper: withCircuitBreaker (atomic RETURNING update) | `edge_function` | `M` | 2 | `T-307`, `T-316` |
| `T-319` | _shared/ helper: withRateLimit (token-bucket via rate_limit_buckets) | `edge_function` | `S` | 3 | `T-307`, `T-318` |
| `T-320` | _shared/ helper: emitDomainEvent (tx-aware) | `edge_function` | `S` | 2 | `T-305`, `T-316` |
| `T-321` | _shared/ helper: withRunRow (sync_runs/extraction_runs lifecycle) | `edge_function` | `S` | 3 | `T-306`, `T-315`, `T-316` |
| `T-322` | _shared/ helper: resolveTargetHousehold (binding resolution) | `edge_function` | `S` | 3 | `T-203` |
| `T-323` | _shared/ helper: findPdfParts + magic byte validation + sha256 | `edge_function` | `S` | 0 | — |
| `T-324` | Edge Function: sync-dispatcher (gates + batch select + enqueue) | `edge_function` | `M` | 3 | `T-203`, `T-308`, `T-318` +1 |
| `T-325` | Edge Function: sync-worker — outer loop + composition + DLQ | `edge_function` | `L` | 5 | `T-308`, `T-316`, `T-317` +5 |
| `T-326` | Edge Function: sync-worker — doImapFetch (imapflow + dedupe + transactional inse | `edge_function` | `L` | 4 | `T-203`, `T-308`, `T-301` +7 |
| `T-327` | Edge Function: sync-worker — auto-pause on consecutive errors | `edge_function` | `S` | 6 | `T-325`, `T-320`, `T-315` |
| `T-328` | pgTAP: invoices RLS cross-tenant tests | `test` | `M` | 4 | `T-309` |
| `T-329` | pgTAP: dedupe constraints (file_hash + message_id) | `test` | `M` | 2 | `T-301` |
| `T-330` | pgTAP: utility_parsers RLS (anon denied; authenticated allowed) | `test` | `S` | 4 | `T-309`, `T-313` |
| `T-331` | Test: secret redaction never persisted in sync_runs/connected_emails/domain_even | `test` | `S` | 6 | `T-315`, `T-321`, `T-325` |
| `T-332` | pgTAP: enel-sp regex fixtures | `test` | `M` | 3 | `T-313` |
| `T-333` | Deno test: sync-worker happy + dedupe + DLQ + auto-pause integration | `test` | `L` | 7 | `T-325`, `T-326`, `T-327` |
| `T-334` | pgTAP: cron jobs registered (sync-dispatcher / sync-worker / cleanup) | `test` | `XS` | 3 | `T-311` |
| `T-335` | Doc: ingestion runbook section (auto-pause recovery + circuit reset + DLQ replay | `doc` | `XS` | 7 | `T-327`, `T-325` |
| `T-401` | Migration: extend ai_calls columns for OCR + chain state tracking | `migration` | `S` | 4 | `T-105` |
| `T-402` | Seed app_settings for extraction config (layer thresholds, OCR + AI chains, brea | `seed` | `M` | 5 | `T-105`, `T-401` |
| `T-403` | Vault setup for OCR + AI API keys with redaction helper | `infra` | `M` | 6 | `T-402` |
| `T-404` | Layer 1 implementation: pdfjs-dist native text extraction | `edge_function` | `M` | 6 | `T-402` |
| `T-405` | PDF page splitter for OCR layer (per-page bytes via pdfjs) | `edge_function` | `M` | 7 | `T-404` |
| `T-406` | OcrProvider interface + adapter scaffolding + classifyError | `edge_function` | `S` | 7 | `T-403` |
| `T-407` | OcrSpaceProvider implementation | `edge_function` | `M` | 8 | `T-406` |
| `T-408` | GoogleVisionProvider implementation | `edge_function` | `M` | 8 | `T-406` |
| `T-409` | OcrClient: chain + per-provider breaker + rate limit + ai_calls logging | `edge_function` | `M` | 9 | `T-407`, `T-408`, `T-105` +1 |
| `T-410` | Layer 2 orchestrator with per-page early-exit | `edge_function` | `M` | 10 | `T-405`, `T-409`, `T-411` |
| `T-411` | Layer 3 implementation: regex per-utility (sender + body match → field regexes) | `edge_function` | `M` | 6 | `T-402` |
| `T-412` | AiProvider interface + GeminiProvider with structured output (responseSchema) | `edge_function` | `M` | 7 | `T-403` |
| `T-413` | GroqProvider implementation | `edge_function` | `M` | 8 | `T-412` |
| `T-414` | OpenRouterProvider (disabled by default) + prompt template registry with hot-swa | `edge_function` | `M` | 9 | `T-413` |
| `T-415` | AiClient + OcrClient chain-level breaker: state machine with hysteresis, backoff | `edge_function` | `L` | 6 | `T-105`, `T-205` |
| `T-416` | AiClient: chain orchestration + ai_calls logging with chain_state_at_call | `edge_function` | `M` | 10 | `T-412`, `T-413`, `T-414` +1 |
| `T-417` | Confidence formula + status mapper (deterministic single source of truth) | `edge_function` | `S` | 6 | `T-402` |
| `T-418` | extraction-worker main: pgmq consumer + 4-layer orchestration + status writeback | `edge_function` | `L` | 11 | `T-404`, `T-410`, `T-411` +3 |
| `T-419` | Deploy-time AI provider smoke test (1-token call, abort on 404) | `ci` | `M` | 11 | `T-416` |
| `T-420` | Re-extract admin endpoint POST /admin/invoices/:id/reextract | `edge_function` | `S` | 12 | `T-418` |
| `T-421` | Chain-close replay: ai.chain.replay_available event + admin endpoint POST /admin | `edge_function` | `M` | 13 | `T-415`, `T-418`, `T-420` |
| `T-422` | Mobile feature: 'Re-tentar N faturas' admin banner + replay action | `mobile_widget` | `M` | 14 | `T-421` |
| `T-423` | pgTAP: circuit_breakers state machine transitions (closed↔open↔half_open + backo | `test` | `M` | 7 | `T-415` |
| `T-424` | Integration test: end-to-end extraction-worker with mocked OCR + AI providers | `test` | `L` | 12 | `T-418` |
| `T-425` | Wire extraction-worker into pg_cron + pg_net schedule | `migration` | `S` | 12 | `T-418` |
| `T-426` | Failure→status mapping (classifyError table) consolidated unit tests | `test` | `S` | 12 | `T-416`, `T-418` |
| `T-427` | Admin UI: 'Force chain breaker' control + needs_review banner | `mobile_feature` | `M` | 15 | `T-415`, `T-422` |
| `T-428` | extracted_payload v1 schema validation + writer | `edge_function` | `S` | 12 | `T-418` |
| `T-429` | Docs: Extraction pipeline runbook + chain breaker operations | `doc` | `S` | 16 | `T-419`, `T-420`, `T-421` +1 |
| `T-501` | Scaffold unibill-mobile Flutter app via Very Good CLI | `config` | `S` | 0 | — |
| `T-502` | Implement bootstrap.dart, app.dart, env config and core DI container | `mobile_feature` | `M` | 1 | `T-501` |
| `T-503` | Define FeatureModule abstraction + FeatureScopeShell widget | `mobile_feature` | `M` | 2 | `T-502` |
| `T-504` | Build custom_lint plugin: no_cross_feature_imports rule | `config` | `M` | 1 | `T-501` |
| `T-505` | Set up i18n (l10n.yaml, app_pt.arb template, app_en.arb) + locale resolution | `mobile_feature` | `S` | 2 | `T-502` |
| `T-506` | Material 3 theme (light + dark) with ThemeExtension tokens | `mobile_feature` | `M` | 3 | `T-505` |
| `T-507` | Drift local DB schema + SecureStorage wrapper | `mobile_feature` | `L` | 2 | `T-502` |
| `T-508` | Supabase + Edge Function HTTP clients (network layer) | `mobile_feature` | `M` | 2 | `T-502` |
| `T-509` | UndoSnack widget + reusable undo orchestration | `mobile_widget` | `S` | 4 | `T-506` |
| `T-510` | FeatureGate widget + FeatureFlags client with 30s TTL cache | `mobile_feature` | `M` | 3 | `T-508`, `T-507` |
| `T-511` | Edge Function /config/resolve — backend pair | `edge_function` | `M` | 4 | `T-510` |
| `T-512` | Telemetry client with consent gate, PII scrubbing, offline queue | `mobile_feature` | `L` | 3 | `T-507`, `T-508` |
| `T-513` | Edge Function /telemetry/ingest — backend pair | `edge_function` | `M` | 4 | `T-512` |
| `T-514` | go_router setup with global auth guard + ShellRoute composition | `mobile_feature` | `M` | 3 | `T-503`, `T-505` |
| `T-515` | auth_module: welcome/signup/login/recovery/magic-link + deep-link callback | `mobile_feature` | `L` | 5 | `T-514`, `T-509` |
| `T-516` | auth_module: onboarding (create or join household via invite) | `mobile_feature` | `M` | 6 | `T-515`, `T-508` |
| `T-517` | invoices_module: list page with month grouping, totals, needs_review banner | `mobile_feature` | `L` | 4 | `T-514`, `T-507`, `T-508` |
| `T-518` | invoices_module: detail page with QR PIX, barcode, mark paid/unpaid | `mobile_feature` | `L` | 5 | `T-517`, `T-509` |
| `T-519` | invoices_module: PDF viewer + edit page with low-confidence indicators | `mobile_feature` | `L` | 6 | `T-518` |
| `T-520` | invoices_module: needs-review screen with filter + bulk actions | `mobile_feature` | `M` | 5 | `T-517` |
| `T-521` | emails_module: connect/list/rotate-password/delete Gmail accounts | `mobile_feature` | `L` | 5 | `T-508`, `T-509` |
| `T-522` | categories_module: CRUD with undo delete | `mobile_feature` | `M` | 5 | `T-508`, `T-509` |
| `T-523` | household_module: members list, invite, leave/transfer | `mobile_feature` | `L` | 5 | `T-508`, `T-509` |
| `T-524` | settings_module: preferences, privacy, locale, theme, telemetry opt-in | `mobile_feature` | `L` | 4 | `T-508`, `T-512`, `T-506` |
| `T-525` | notifications_module: local notifs scheduling, prefs, snooze, dedupe | `mobile_feature` | `L` | 4 | `T-508`, `T-507`, `T-510` |
| `T-526` | Realtime subscription for new invoices (notifications.realtime_subscribe flag) | `mobile_feature` | `M` | 5 | `T-525`, `T-510` |
| `T-527` | sys_admin_module: dashboard with capacity gauges + queue depths + AI chain statu | `mobile_feature` | `L` | 4 | `T-510`, `T-514` |
| `T-528` | sys_admin_module: ai_chain_health + ocr_chain_health pages with force buttons | `mobile_feature` | `L` | 5 | `T-527` |
| `T-529` | sys_admin_module: domain_events browser, eviction history, telemetry browser | `mobile_feature` | `L` | 5 | `T-527` |
| `T-530` | sys_admin_module: global settings editor + admins management | `mobile_feature` | `L` | 5 | `T-527` |
| `T-531` | household_scope widget + multi-household switcher | `mobile_widget` | `M` | 7 | `T-503`, `T-516`, `T-526` |
| `T-532` | Integration test: golden flow login → list → detail → mark paid | `test` | `L` | 6 | `T-515`, `T-517`, `T-518` |
| `T-533` | CI: Flutter build + analyze + test + coverage thresholds + custom_lint | `ci` | `M` | 2 | `T-501`, `T-504` |
| `T-601` | Migration: capacity + health + telemetry tables | `migration` | `M` | 2 | `T-101`, `T-102` |
| `T-602` | Edge Function: capacity-monitor (measure + classify + enqueue) | `edge_function` | `L` | 4 | `T-601`, `T-103`, `T-105` |
| `T-603` | Edge Function: capacity-evictor (tier escalation + archive) | `edge_function` | `L` | 5 | `T-601`, `T-602` |
| `T-604` | Cron schedules: capacity, retention, cleanup-rate-buckets, health, archive-event | `migration` | `M` | 10 | `T-602`, `T-603`, `T-605` |
| `T-605` | Edge Function: archive-domain-events (jsonl.gz to Storage) | `edge_function` | `M` | 9 | `T-601`, `T-110` |
| `T-606` | Migration: consent_log + sentinel actors + anonymize function | `migration` | `M` | 1 | `T-101` |
| `T-607` | pgTAP test: anonymize_user_references + CI coverage guard | `test` | `M` | 2 | `T-606` |
| `T-608` | Edge Function: POST /privacy/export-my-data | `edge_function` | `L` | 9 | `T-606`, `T-105`, `T-110` |
| `T-609` | Edge Function: DELETE /privacy/my-account | `edge_function` | `L` | 3 | `T-606`, `T-607` |
| `T-610` | Cron: consent_log IP mask + UA hash retention jobs | `migration` | `S` | 11 | `T-606`, `T-604` |
| `T-611` | Mobile: Consent flow (signup gate + Settings toggle + telemetry gate) | `mobile_feature` | `L` | 8 | `T-606`, `T-405`, `T-411` |
| `T-612` | Mobile: Privacy screens (Export my data + Delete my account) | `mobile_feature` | `M` | 10 | `T-608`, `T-609`, `T-611` |
| `T-613` | Edge Function: GET /health (public + authenticated) | `edge_function` | `M` | 3 | `T-601` |
| `T-614` | GitHub Action: health-monitor (15min cron + email on failure) | `ci` | `S` | 4 | `T-613` |
| `T-615` | GitHub Actions: branch-strategy workflows (feature/fix/docs/main) | `ci` | `L` | 1 | `T-101` |
| `T-616` | release-please config + tag release workflow | `ci` | `M` | 2 | `T-615` |
| `T-617` | GitHub Actions: backend pipeline (lint + pgTAP + deno test + migration lint) | `ci` | `M` | 3 | `T-615`, `T-607` |
| `T-618` | GitHub Actions: mobile pipeline (analyze + test + build) | `ci` | `M` | 2 | `T-615` |
| `T-619` | Branch protection rules + secrets config doc | `doc` | `S` | 3 | `T-615`, `T-616` |
| `T-620` | Weekly backup cron to Backblaze B2 + retention policy | `ops` | `M` | 2 | `T-615` |
| `T-621` | RUNBOOK.md skeleton (8 sections per spec) | `doc` | `S` | 0 | — |
| `T-622` | Test restore drill execution + report (DR validation) | `ops` | `M` | 3 | `T-620`, `T-621` |
| `T-623` | LICENSE (Apache 2.0) + CONTRIBUTING.md + Code of Conduct | `doc` | `S` | 0 | — |
| `T-624` | Auto-gen docs: data-dictionary, configuration, events (CI publish) | `doc` | `M` | 4 | `T-617` |
| `T-625` | OpenAPI gen from Zod + DBML diagram + dartdoc publish | `doc` | `M` | 5 | `T-624` |
| `T-626` | ADRs 0001-0005 (key architectural decisions) | `doc` | `S` | 0 | — |
| `T-627` | Mobile i18n: EN ARB fill + golden coverage (light/dark/pt/en) | `mobile_feature` | `M` | 7 | `T-411` |
| `T-628` | Mobile bootstrap health check + crash-resistant startup | `mobile_feature` | `M` | 7 | `T-613`, `T-411` |
| `T-629` | Initial deploy checklist execution (24 steps from §11.5) | `ops` | `L` | 11 | `T-602`, `T-603`, `T-604` +7 |

---

## Phase P0-P1 — Foundation, Repos, Core Schema, Auth Tables, RLS Helpers, Seeds

**Tasks:** 26

Bootstrap all three repos with CI scaffolding, provision Supabase dev+prod projects, and create the core Postgres schema for tenancy (households, members, invitations), identity (user_profiles, system_actors, consent_log), and runtime configuration (app_settings + history). Includes RLS helper functions in schema `app`, base policies, business COMMENTs, seeds for ~120 app_settings keys, system_actors sentinels, and pgTAP test coverage for triggers and cross-tenant isolation.

**Phase done when:** Phase done when (1) three GitHub repos exist with Apache-2.0, README, CODEOWNERS, baseline CI; (2) `supabase db reset` on dev project applies all P0-P1 migrations green; (3) `supabase test db` runs all pgTAP suites with 100% pass; (4) seeds populate ~120 app_settings rows + 3 system_actor sentinels + 4 default invoice_categories template; (5) `app.households_of_user`, `app.is_household_admin`, `app.is_system_admin` deployed and unit-tested; (6) cross-tenant RLS isolation verified by pgTAP for every table in this phase; (7) CI workflows run migration lint + pgTAP + deno test scaffolding on PRs; (8) config drift CI script (`check_config_docs_sync.py`) passes against §B; (9) `enforce_min_one_admin` trigger covered by 3-scenario test (UPDATE-demote, UPDATE-soft-delete, DELETE).

---

### `T-101` — Create three GitHub repos with Apache-2.0 license and baseline structure

**Category:** `infra` | **Size:** `S` (~2h) | **Depth:** 0
**Blocks:** `T-102`, `T-103`, `T-201`, `T-301`, `T-302`, `T-304`, `T-305`, `T-306`, `T-307`, `T-308`, `T-310`, `T-601`, `T-606`, `T-615`
**Spec refs:** §3.4, §2.3

Create private repos `unibill-backend`, `unibill-mobile`, `unibill-web-future` under the user's GitHub org (or personal account, decision at exec time). Each repo gets: LICENSE (Apache 2.0), README.md (project description + link to spec), .gitignore appropriate to stack (Deno/Node for backend, Flutter for mobile, Vite/Node for web), CODEOWNERS, .editorconfig, CONTRIBUTING.md skeleton, and SECURITY.md skeleton. Push initial commits via gh CLI. Repos start as private; flip to public when MVP stabilizes (out of scope for this task).

**Files:**
- `unibill-backend/LICENSE`
- `unibill-backend/README.md`
- `unibill-backend/.gitignore`
- `unibill-backend/CODEOWNERS`
- `unibill-backend/.editorconfig`
- `unibill-backend/CONTRIBUTING.md`
- `unibill-backend/SECURITY.md`
- `unibill-mobile/LICENSE`
- `unibill-mobile/README.md`
- `unibill-mobile/.gitignore`
- `unibill-mobile/CODEOWNERS`
- `unibill-web-future/LICENSE`
- `unibill-web-future/README.md`
- `unibill-web-future/.gitignore`

**Acceptance:**
- Three private repos exist on GitHub; `gh repo view` succeeds for each
- Each repo has Apache-2.0 LICENSE at root with correct copyright header
- Each README links back to the spec at /docs/superpowers/specs/2026-06-08-unibill-mvp-design.md (or a path-equivalent published location)
- .gitignore matches the repo's stack (no secrets, no build artifacts, no IDE detritus)
- Initial commit pushed to default branch `main` on each repo

---

### `T-102` — Provision Supabase dev and prod projects

**Category:** `infra` | **Size:** `S` (~2h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-103`, `T-206`, `T-208`, `T-223`, `T-224`, `T-601`
**Spec refs:** §3.1, §3.3, §9.1

Create two Supabase Cloud projects: `unibill-dev` and `unibill-prod`. Capture project refs, anon keys, service_role keys, JWT secret, and DB connection strings. Enable extensions required by the spec: `pgsodium` (Vault), `pgmq`, `pg_cron`, `pg_net`, `pgcrypto`, `pgtap` (for tests). Store secrets in a password manager (do NOT commit). Document project URLs and ref IDs in `unibill-backend/docs/ENVIRONMENTS.md`. Configure project-level settings: auth providers (email + password only for MVP), email templates (Brazilian Portuguese baseline), SMTP (Supabase default for now), JWT expiry (1h access, 30d refresh).

**Files:**
- `unibill-backend/docs/ENVIRONMENTS.md`

**Acceptance:**
- Two Supabase projects exist; project refs documented in ENVIRONMENTS.md
- Extensions pgsodium, pgmq, pg_cron, pg_net, pgcrypto, pgtap all show ENABLED via `select * from pg_extension`
- Email/password auth provider enabled; magic link enabled; other providers disabled
- JWT settings: access 3600s, refresh 2592000s
- Service role and anon keys stored securely (not in repo); only refs/URLs in markdown

---

### `T-103` — Initialize Supabase CLI workspace in unibill-backend

**Category:** `config` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-101`, `T-102`
**Blocks:** `T-104`, `T-105`, `T-125`, `T-210`, `T-215`, `T-216`, `T-227`, `T-602`
**Spec refs:** §3.1, §3.4

Run `supabase init` in `unibill-backend`, commit generated `supabase/config.toml`. Configure two environments via `supabase link --project-ref <dev>` and document the same for prod. Add `supabase/migrations/`, `supabase/functions/`, `supabase/seeds/`, `supabase/tests/` directory layout per spec §3.1. Add `Makefile` with targets: `make db-reset`, `make db-push-dev`, `make db-push-prod`, `make test-db`, `make functions-serve`. Pin Supabase CLI version in `.tool-versions` (asdf) and `package.json` engines section.

**Files:**
- `unibill-backend/supabase/config.toml`
- `unibill-backend/supabase/.gitignore`
- `unibill-backend/Makefile`
- `unibill-backend/.tool-versions`
- `unibill-backend/package.json`

**Acceptance:**
- `supabase --version` matches pinned version; `supabase status` runs locally
- Directory tree exists: migrations/, functions/, seeds/, tests/
- `make db-reset` runs `supabase db reset` against local stack with zero migrations OK
- config.toml committed with `api.enabled = true`, `db.major_version = 15`
- supabase/.gitignore excludes `.env`, `.branches`, `.temp`

---

### `T-104` — Set up GitHub Actions secrets and base CI workflow scaffolding for unibill-backend

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-103`
**Blocks:** `T-120`, `T-124`, `T-204`, `T-215`, `T-230`
**Spec refs:** §11.1, §12.4

Configure GitHub repo secrets for `unibill-backend`: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD_DEV`, `SUPABASE_DB_PASSWORD_PROD`, `SUPABASE_PROJECT_REF_DEV`, `SUPABASE_PROJECT_REF_PROD`, `DENO_KV_ACCESS_TOKEN` (placeholder), `BACKBLAZE_B2_KEY_ID`, `BACKBLAZE_B2_APP_KEY`. Create `.github/workflows/ci.yml` with jobs: (a) `lint` (deno fmt + lint), (b) `test-deno` (deno test placeholder), (c) `test-db` (spins up local postgres via service container, applies migrations, runs pgTAP), (d) `migration-lint` (custom script verifying timestamp prefix + filename convention). PRs require CI green.

**Files:**
- `unibill-backend/.github/workflows/ci.yml`
- `unibill-backend/.github/workflows/deploy-dev.yml`
- `unibill-backend/scripts/lint_migrations.sh`
- `unibill-backend/README.md`

**Acceptance:**
- All listed GitHub secrets exist (verify via `gh secret list`)
- CI runs on PR + push to main with 4 named jobs
- `scripts/lint_migrations.sh` rejects filenames that don't match `^[0-9]{14}_[a-z0-9_]+\.sql$`
- Local `act` or live PR run succeeds against an empty migrations directory
- Branch protection on `main` requires CI status checks to pass

---

### `T-105` — Create app schema and bootstrap migration

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-103`
**Blocks:** `T-106`, `T-401`, `T-402`, `T-409`, `T-415`, `T-602`, `T-608`
**Spec refs:** §5.11

First migration `00000000000001_create_app_schema.sql` creates schema `app`, grants USAGE to authenticated + service_role, sets default search_path on schema, enables required extensions inside the migration (idempotent CREATE EXTENSION IF NOT EXISTS for pgcrypto, pgmq, pg_cron, pg_net, pgsodium, pgtap — pgtap only in dev/test). Also creates a `app.migration_metadata` table to track structural invariants. Include comment-only block listing forbidden patterns (`auth.` for helpers — must use `app.`).

**Files:**
- `unibill-backend/supabase/migrations/00000000000001_create_app_schema.sql`

**Acceptance:**
- `supabase db reset` applies cleanly
- `select nspname from pg_namespace where nspname='app'` returns 1 row
- Extensions pgcrypto, pgmq, pg_cron, pg_net, pgsodium present (verified via pg_extension)
- GRANT USAGE on schema app shown via `\dn+ app`
- Migration is idempotent (running twice does not error)

---

### `T-125` — Deno test scaffolding for _shared/ middlewares and helpers

**Category:** `config` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-103`
**Spec refs:** §4.2, §4.2.1

Set up `supabase/functions/_shared/` directory with placeholder TypeScript files matching the contracts from §4.2.1: correlation.ts, idempotency.ts, circuit.ts, rate_limit.ts, events.ts, logging.ts, runs.ts, redact.ts, errors.ts. Each exports only signatures/types/stub implementations. Create `supabase/functions/_shared/_test_utils.ts` for test fixtures. Add `deno.jsonc` at repo root with tasks `test`, `fmt`, `lint`. Create one example test `correlation.test.ts` that runs green to prove the deno test wiring works. Full implementations are deferred to other agents' phases.

**Files:**
- `unibill-backend/supabase/functions/_shared/correlation.ts`
- `unibill-backend/supabase/functions/_shared/idempotency.ts`
- `unibill-backend/supabase/functions/_shared/circuit.ts`
- `unibill-backend/supabase/functions/_shared/rate_limit.ts`
- `unibill-backend/supabase/functions/_shared/events.ts`
- `unibill-backend/supabase/functions/_shared/logging.ts`
- `unibill-backend/supabase/functions/_shared/runs.ts`
- `unibill-backend/supabase/functions/_shared/redact.ts`
- `unibill-backend/supabase/functions/_shared/errors.ts`
- `unibill-backend/supabase/functions/_shared/_test_utils.ts`
- `unibill-backend/supabase/functions/_shared/correlation.test.ts`
- `unibill-backend/deno.jsonc`

**Acceptance:**
- `deno task test` runs and at least one test passes
- All 9 stub files compile with `deno check`
- Type signatures match §4.2.1 exactly (verified by hand against spec)
- deno.jsonc lock file generated and committed
- CI job `test-deno` invokes `deno task test`

---

### `T-106` — Migrate system_actors table with sentinel seeds

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 4
**Depends on:** `T-105`
**Blocks:** `T-107`, `T-117`
**Spec refs:** §5.10, §5.11

Create `system_actors` table per §5.10 with `id uuid PK`, `kind text UNIQUE CHECK kind IN ('deleted_user','system_worker','system_admin_bootstrap')`, `display_name text NOT NULL`, `created_at timestamptz`. Add seed inserts for the 3 deterministic UUIDs (00000001/02/03). Enable RLS with `system_actors_select` policy granting SELECT to authenticated (needed for `user_display_name` lookups). Add COMMENT ON TABLE explaining sentinel pattern. Migration filename: `20260615120000_create_system_actors.sql`. Seed lives in same migration (idempotent via ON CONFLICT DO NOTHING).

**Files:**
- `unibill-backend/supabase/migrations/20260615120000_create_system_actors.sql`

**Acceptance:**
- Table exists with correct CHECK constraint on kind
- Three sentinel rows present with UUIDs 0...01/02/03 after migration
- ALTER TABLE ... ENABLE ROW LEVEL SECURITY applied
- Authenticated role can SELECT, service_role can ALL; anon denied (verified pgTAP)
- Migration is idempotent: rerunning seeds via ON CONFLICT (id) DO NOTHING

---

### `T-124` — Migration lint: structural invariants enforcement script

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-104`
**Spec refs:** §5.10, §11.1

Extend `scripts/lint_migrations.sh` (or convert to `scripts/lint_migrations.ts`) to assert structural invariants: (a) every migration starts with a header comment block listing purpose + author; (b) no migration references `auth.` schema for new objects (helpers belong in `app.`); (c) every CREATE TABLE has at least one COMMENT ON TABLE or a TODO marker; (d) every new FK pointing at auth.users(id) generates a warning and requires explicit annotation `-- AUDIT-FK-OK: <reason>`; (e) filenames sorted lexicographically must not have gaps in timestamp prefix duplicates.

**Files:**
- `unibill-backend/scripts/lint_migrations.ts`
- `unibill-backend/.github/workflows/ci.yml`

**Acceptance:**
- Lint fails on a migration missing the header comment
- Lint warns on `REFERENCES auth.users` without `-- AUDIT-FK-OK:` annotation
- Lint detects two migrations with same timestamp prefix and errors
- Wired into CI as job `migration-lint`
- Existing P0-P1 migrations from T-105..T-121 all pass lint after authoring

---

### `T-107` — Migrate households table

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 5
**Depends on:** `T-106`
**Blocks:** `T-108`, `T-119`
**Spec refs:** §5.1, §5.10

Create `households` table per §5.1: `id uuid PK`, `name text NOT NULL`, `created_at/updated_at timestamptz`, `created_by uuid` (no FK to auth.users per Approach A in §5.10), `deleted_at timestamptz`. Add `updated_at` trigger via shared helper (create `app.set_updated_at()` function as part of this migration). Add COMMENT ON TABLE. Filename `20260615120100_create_households.sql`.

**Files:**
- `unibill-backend/supabase/migrations/20260615120100_create_households.sql`

**Acceptance:**
- Table created with all columns matching spec types
- No FK constraint to auth.users on created_by (per Approach A)
- `app.set_updated_at()` trigger function created and attached as BEFORE UPDATE
- Updating a row bumps updated_at automatically (pgTAP test)
- COMMENT ON TABLE households exists

---

### `T-108` — Migrate members table with enforce_min_one_admin trigger and partial unique index

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 6
**Depends on:** `T-107`
**Blocks:** `T-109`, `T-113`, `T-115`
**Spec refs:** §5.1

Create `member_role` enum and `members` table per §5.1. Add partial unique index `uq_members_household_user_active` ON (household_id, user_id) WHERE deleted_at IS NULL (per spec — permits re-add after soft-delete). Create `enforce_min_one_admin()` function exactly as specified (handling UPDATE-demote, UPDATE-soft-delete, DELETE; returning OLD vs NEW correctly per TG_OP). Attach BEFORE UPDATE OR DELETE trigger. Add `set_updated_at` trigger. Filename `20260615120200_create_members.sql`.

**Files:**
- `unibill-backend/supabase/migrations/20260615120200_create_members.sql`

**Acceptance:**
- Table and enum `member_role` ('admin','member') created
- Partial unique index applies only when deleted_at IS NULL (verified by inserting two rows with same (household_id,user_id) where first is soft-deleted)
- Trigger function returns OLD on DELETE branch, NEW on UPDATE branch
- Attempt to demote/soft-delete/hard-delete the last admin raises EXCEPTION with message 'Cannot remove the last admin of household ...'
- All three operation scenarios covered by pgTAP test (see T-115)

---

### `T-119` — Seed invoice_categories template (system defaults)

**Category:** `seed` | **Size:** `S` (~2h) | **Depth:** 6
**Depends on:** `T-107`
**Spec refs:** §5.4

Create `supabase/seeds/invoice_categories_template.sql` defining the system-default category set that gets cloned per-household at household creation: Luz (electricity), Água (water), Gás (gas), Internet, Telefone, Streaming, Outros. Each with is_system=true, sort_order, color hex, icon name (matching Material/Cupertino set the mobile app will use). Insertion happens via a function `app.seed_household_categories(household_id uuid)` callable from a trigger on `households AFTER INSERT` (or from Edge Function on household-create flow — to be decided in P2). For now, ship the template data + the function; trigger wiring deferred.

**Files:**
- `unibill-backend/supabase/seeds/invoice_categories_template.sql`
- `unibill-backend/supabase/migrations/20260615121000_create_seed_household_categories.sql`

**Acceptance:**
- Function `app.seed_household_categories(uuid)` exists and inserts 7 default categories for the given household
- Categories have stable color + icon values matching Material design tokens
- Function is idempotent (ON CONFLICT (household_id, name) WHERE deleted_at IS NULL DO NOTHING)
- Re-running the function for same household creates 0 new rows
- pgTAP smoke test calls the function and asserts 7 rows present

---

### `T-109` — Migrate household_invitations table

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 7
**Depends on:** `T-108`
**Blocks:** `T-110`
**Spec refs:** §5.1, §5.12

Create `household_invitations` per §5.1: code text UNIQUE (8 alphanumeric), invited_email optional, expires_at default now()+7d, used_at/used_by nullable. Add CHECK constraint on `code` to enforce 8 alphanumeric chars (`^[A-Z0-9]{8}$`). Add index on `(household_id, used_at) WHERE used_at IS NULL` for listing active invites. RLS will be added in T-114. Filename `20260615120300_create_household_invitations.sql`.

**Files:**
- `unibill-backend/supabase/migrations/20260615120300_create_household_invitations.sql`

**Acceptance:**
- Table created with all columns
- CHECK constraint rejects invitation codes that don't match `^[A-Z0-9]{8}$`
- Default `expires_at` is now() + interval '7 days'
- Index `idx_invitations_household_active` exists for the partial condition
- Migration is idempotent

---

### `T-113` — Create RLS helper functions in app schema

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 7
**Depends on:** `T-108`
**Blocks:** `T-114`, `T-117`
**Spec refs:** §5.11

Migration `20260615120700_create_app_helpers.sql` creates the three SECURITY DEFINER helper functions specified in §5.11: `app.households_of_user()` returning SETOF uuid (queries public.members where user_id=auth.uid() AND deleted_at IS NULL), `app.is_household_admin(uuid)` returning boolean, `app.is_system_admin()` reading from JWT app_metadata with defensive NULLIF/coalesce. Grant EXECUTE to authenticated. Lock down search_path to `public, pg_temp` on the SECURITY DEFINER functions.

**Files:**
- `unibill-backend/supabase/migrations/20260615120700_create_app_helpers.sql`

**Acceptance:**
- Three functions exist in schema `app` (verified via `pg_proc`)
- All three are STABLE; first two are SECURITY DEFINER with locked search_path
- `app.is_system_admin()` returns false when JWT claim missing or empty string (not NULL/error)
- GRANT EXECUTE ... TO authenticated present on all three
- pgTAP test verifies each function under different `set local request.jwt.claims` settings

---

### `T-115` — pgTAP test suite for enforce_min_one_admin trigger

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-108`
**Spec refs:** §5.1

Create `supabase/tests/triggers/enforce_min_one_admin.test.sql`. Three scenarios per §5.1 spec: (1) UPDATE that demotes role admin→member of last admin must RAISE; (2) UPDATE that sets deleted_at on last admin must RAISE; (3) DELETE of last admin must RAISE. Each scenario also covers the happy path: removing one of two admins succeeds. Use pgTAP `throws_ok` and `lives_ok`. Include setup that creates a household + 1 user + member rows in a BEGIN/ROLLBACK transaction.

**Files:**
- `unibill-backend/supabase/tests/triggers/enforce_min_one_admin.test.sql`

**Acceptance:**
- Test file uses pgTAP plan + finish + ROLLBACK pattern
- At least 6 assertions: 3 throws_ok (last-admin removal) + 3 lives_ok (non-last admin removal)
- `supabase test db` runs the file with all green
- Test is hermetic — no state leaks (BEGIN/ROLLBACK wrap)
- CI job `test-db` includes this file

---

### `T-110` — Migrate user_profiles table with auto-create-on-signup trigger

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 8
**Depends on:** `T-109`
**Blocks:** `T-111`, `T-112`, `T-122`, `T-605`, `T-608`
**Spec refs:** §5.12

Create `user_profiles` table per §5.12 with PK referencing `auth.users(id) ON DELETE CASCADE`, display_name, avatar_url, locale CHECK pt-BR|en-US, theme CHECK system|light|dark. Add `create_user_profile()` SECURITY DEFINER function and trigger `trg_create_user_profile` AFTER INSERT ON auth.users. Add `set_updated_at` trigger. Filename `20260615120400_create_user_profiles.sql`. Note: this migration installs a trigger on `auth.users` — verify Supabase Cloud allows it (typically yes for `AFTER INSERT` triggers from service_role-applied migrations).

**Files:**
- `unibill-backend/supabase/migrations/20260615120400_create_user_profiles.sql`

**Acceptance:**
- Table created with FK to auth.users(id) ON DELETE CASCADE
- Locale and theme CHECK constraints reject invalid values
- Trigger function uses SECURITY DEFINER + `SET search_path = public`
- After inserting a row into auth.users, a matching user_profiles row is auto-created with display_name = raw_user_meta_data->>'display_name' OR split_part(email,'@',1)
- pgTAP test covers signup auto-create path

---

### `T-117` — Seed system_actors and bootstrap sys_admin promotion procedure

**Category:** `ops` | **Size:** `S` (~2h) | **Depth:** 8
**Depends on:** `T-106`, `T-113`
**Spec refs:** §5.10, §9.2, §11.5

The system_actors seed lives in T-106 migration. This task adds a Bash/Deno script `scripts/bootstrap_sys_admin.sh` that takes an email arg, looks up the user in auth.users, and updates `app_metadata.is_system_admin=true` via the Supabase admin API. Documented runbook in `docs/runbooks/bootstrap-sys-admin.md`. Also adds a SQL function `app.assert_sys_admin_exists()` that RAISES if zero sys admins exist (used by post-deploy verification).

**Files:**
- `unibill-backend/scripts/bootstrap_sys_admin.sh`
- `unibill-backend/docs/runbooks/bootstrap-sys-admin.md`
- `unibill-backend/supabase/migrations/20260615120900_create_sys_admin_helpers.sql`

**Acceptance:**
- Script accepts `--email <addr>` and writes is_system_admin=true via `gotrue-admin` HTTP API using service_role key
- Runbook describes when/how to use, including risk of leaving zero sys admins
- `app.assert_sys_admin_exists()` raises EXCEPTION if no user has the claim
- Script is safe to re-run (idempotent)
- Script tested against unibill-dev project end-to-end

---

### `T-111` — Migrate app_settings + app_settings_history with audit trigger

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 9
**Depends on:** `T-110`
**Blocks:** `T-114`, `T-118`, `T-123`
**Spec refs:** §5.5

Create `setting_scope` enum and `app_settings` table per §5.5. Implement surrogate-PK + two partial unique indexes (`idx_settings_global_unique`, `idx_settings_scoped_unique`) instead of an inline composite PK with NULL. Add CHECK on scope/scope_id consistency. Create `app_settings_history` (bigserial PK) and `audit_app_settings()` trigger function AFTER INSERT OR UPDATE that inserts old/new values into history. Include indexes `idx_settings_category`, `idx_settings_lookup`, `idx_settings_history_key`. Filename `20260615120500_create_app_settings.sql`.

**Files:**
- `unibill-backend/supabase/migrations/20260615120500_create_app_settings.sql`

**Acceptance:**
- Both tables created with correct types/constraints
- Attempting to INSERT two rows with same key and scope='global' fails (partial unique)
- Attempting INSERT with scope='global' AND scope_id IS NOT NULL fails (CHECK)
- Update of an app_settings row triggers an INSERT into app_settings_history with old/new value
- All 3 indexes present (verified via `pg_indexes`)

---

### `T-112` — Migrate consent_log table with active-consent partial unique index

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 9
**Depends on:** `T-110`
**Blocks:** `T-114`
**Spec refs:** §5.9

Create `consent_purpose` enum and `consent_log` table per §5.9 with `version text NOT NULL`, `legal_basis text`, `accepted_at`, `revoked_at`, `revoked_reason`, `ip_address inet`, `user_agent text`. Add partial unique index `uq_consent_active_per_purpose` ON (user_id, purpose) WHERE revoked_at IS NULL. Add index `idx_consent_user_purpose`. Filename `20260615120600_create_consent_log.sql`. Note: user_id FK to auth.users is preserved (ownership, not audit).

**Files:**
- `unibill-backend/supabase/migrations/20260615120600_create_consent_log.sql`

**Acceptance:**
- Enum `consent_purpose` has values terms, privacy, telemetry, marketing
- Cannot insert second active consent for same (user_id, purpose) — partial unique enforced
- Inserting revoked consent (revoked_at NOT NULL) for same (user, purpose) allowed in parallel with active one
- ip_address column is `inet` type (not text)
- FK on user_id references auth.users(id)

---

### `T-122` — pgTAP test suite for create_user_profile trigger

**Category:** `test` | **Size:** `S` (~2h) | **Depth:** 9
**Depends on:** `T-110`
**Spec refs:** §5.12

Create `supabase/tests/triggers/create_user_profile.test.sql`. Scenarios: (1) INSERT into auth.users with raw_user_meta_data.display_name='Foo Bar' creates user_profiles row with display_name='Foo Bar'; (2) INSERT without display_name uses split_part(email,'@',1); (3) Trigger handles duplicate insert (ON CONFLICT in trigger or upstream — assert behavior matches spec); (4) DELETE of auth.users cascades and removes user_profiles. All wrapped in BEGIN/ROLLBACK.

**Files:**
- `unibill-backend/supabase/tests/triggers/create_user_profile.test.sql`

**Acceptance:**
- Four scenarios covered, each with a pgTAP assertion
- Test directly INSERTs into auth.users (acceptable in test context with service_role)
- Display name fallback logic verified
- ON DELETE CASCADE confirmed by row count after auth.users delete
- Test runs green under `supabase test db`

---

### `T-114` — Enable RLS and create policies for P0-P1 tables

**Category:** `migration` | **Size:** `L` (~12h) | **Depth:** 10
**Depends on:** `T-111`, `T-112`, `T-113`
**Blocks:** `T-116`, `T-121`
**Spec refs:** §5.11, §5.12, §5.9

Single migration `20260615120800_rls_p0_tables.sql` enables RLS and creates policies for: households (member-of SELECT, admin-of writes), members (member-of SELECT, admin-of writes), household_invitations (admin-of all), user_profiles (cross-household SELECT for display, self UPDATE only), app_settings (scope-aware per §5.11 Pattern F), app_settings_history (replicates parent predicate; service_role for writes), consent_log (own SELECT/INSERT, own UPDATE limited to setting revoked_at; sys admin sees all). Use the DDL patterns A-F documented in §5.11.

**Files:**
- `unibill-backend/supabase/migrations/20260615120800_rls_p0_tables.sql`

**Acceptance:**
- All 7 tables have RLS enabled (verified via `pg_tables.rowsecurity = true`)
- Each table has at least one SELECT policy and at least one write policy (or explicit service_role-only)
- anon role cannot SELECT from any of the 7 tables (test via `set role anon`)
- User from household A cannot SELECT rows from household B (cross-tenant pgTAP)
- consent_log UPDATE policy only allows changing revoked_at/revoked_reason (other column updates blocked via WITH CHECK or column-level)
- Sys admin (JWT app_metadata.is_system_admin=true) sees all app_settings global rows

---

### `T-118` — Seed app_settings_defaults.sql with ~120 canonical keys from Appendix B

**Category:** `seed` | **Size:** `L` (~12h) | **Depth:** 10
**Depends on:** `T-111`
**Blocks:** `T-120`
**Spec refs:** §B, §5.5

Create `supabase/seeds/app_settings_defaults.sql` populating every key listed in Appendix B (§B) of the spec, organized by category: features, sync, extraction, extraction.ocr_space, extraction.google_vision, ai, ai.chain, ocr.chain, capacity, retention, security, notifications, legal. Each row scope='global', scope_id=NULL, with value as JSONB ({"v": ...}), category set, description copied from spec table. Use ON CONFLICT (key) WHERE scope='global' DO UPDATE for idempotency. Total target: ~120 rows. Vault secret_id values stay as placeholder NULL or a deterministic UUID to be overwritten post-deploy.

**Files:**
- `unibill-backend/supabase/seeds/app_settings_defaults.sql`

**Acceptance:**
- Running the seed inserts ~120 rows (exact count: target 118-125 based on §B)
- All keys from Appendix B present (verified by T-120 drift check)
- Re-running the seed is a no-op (ON CONFLICT DO UPDATE preserves values when unchanged)
- JSONB values use shape `{"v": ...}` for typed access
- All inserted rows have category set; description populated from spec text

---

### `T-123` — pgTAP test suite for app_settings history trigger and scope CHECK

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 10
**Depends on:** `T-111`
**Spec refs:** §5.5

Create `supabase/tests/triggers/app_settings_audit.test.sql`. Scenarios: (1) UPDATE on app_settings row inserts a history row with old/new values + changed_by; (2) INSERT does not insert history (per spec, only changes — verify spec wording; if spec wants INSERT too, adapt); (3) scope='global' with scope_id NOT NULL fails CHECK; (4) scope='household' with scope_id NULL fails CHECK; (5) two global rows with same key fail partial unique; (6) one global + one household-scoped for same key both succeed (different scopes).

**Files:**
- `unibill-backend/supabase/tests/triggers/app_settings_audit.test.sql`

**Acceptance:**
- Six scenarios all asserted
- History row contains correct old_value/new_value/changed_by
- CHECK constraint failures surface as `throws_ok` matching expected SQLSTATE
- Partial unique index uniqueness verified
- Test runs under `supabase test db`

---

### `T-116` — pgTAP cross-tenant RLS isolation tests for P0-P1 tables

**Category:** `test` | **Size:** `L` (~12h) | **Depth:** 11
**Depends on:** `T-114`
**Spec refs:** §5.11, §5.12

Create `supabase/tests/rls/p0_cross_tenant.test.sql` covering: households, members, household_invitations, user_profiles, app_settings (all 3 scopes), consent_log. Setup creates 2 users in 2 households. For each table: assert user A cannot SELECT/UPDATE/DELETE user B's rows; user A can see/write own rows; sys admin (via `set local request.jwt.claims`) can see across households where spec allows. Use pgTAP helpers `set_eq`, `is_empty`, `throws_ok` (RLS violations surface as 0 rows affected, not exceptions — assert via row counts).

**Files:**
- `unibill-backend/supabase/tests/rls/p0_cross_tenant.test.sql`
- `unibill-backend/supabase/tests/helpers/jwt_claims.sql`

**Acceptance:**
- Test covers all 7 tables (households, members, invitations, profiles, app_settings, app_settings_history, consent_log)
- Helper `set_jwt_claims(user_id, household_id, is_sys_admin)` reused across assertions
- At least 20 distinct assertions across all tables
- Confirms anon cannot read any P0 table
- Confirms sys admin overrides where spec allows (app_settings global, consent_log audit)
- All assertions pass under `supabase test db`

---

### `T-120` — CI script: check_config_docs_sync.py for app_settings drift

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 11
**Depends on:** `T-104`, `T-118`
**Spec refs:** §B

Implement `scripts/check_config_docs_sync.py` (Python or Deno script — choose Deno for stack consistency, name `scripts/check_config_docs_sync.ts`). Parses three sources: (a) §B markdown table in the spec, (b) `seeds/app_settings_defaults.sql`, (c) every `getConfig('foo.bar', ...)` invocation across `supabase/functions/`. Asserts the three sets are equal (modulo callouts for runtime-only or seed-only keys). Fails CI with a diff if drift found. Wire into `.github/workflows/ci.yml` as a job step.

**Files:**
- `unibill-backend/scripts/check_config_docs_sync.ts`
- `unibill-backend/.github/workflows/ci.yml`
- `unibill-backend/scripts/lib/parse_appendix_b.ts`

**Acceptance:**
- Script outputs a clear diff when sources drift (keys only in spec, only in seed, only in code)
- Script exits 0 when sets match; exits 1 with diff body otherwise
- CI job `config-drift` runs the script on every PR
- Script handles `getConfig` calls split across lines (multi-line regex/AST)
- Documentation in script header explains how to fix common drift scenarios

---

### `T-121` — Migration: add business COMMENT ON COLUMN for P0-P1 tables (Appendix G subset)

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 11
**Depends on:** `T-114`
**Blocks:** `T-126`
**Spec refs:** §G

Final P0-P1 migration `20260615121100_add_business_comments_p0.sql` applies COMMENT ON COLUMN for the P0-P1 tables only (households, members, household_invitations, user_profiles, app_settings, app_settings_history, consent_log, system_actors). Use the patterns from Appendix G. Comments include: scope semantics on app_settings.scope, requires_restart explanation, consent_log.legal_basis enumeration, members.role meaning, system_actors.kind enumeration, etc. Invoices/connected_emails/utility_parsers comments are in agent 2's scope.

**Files:**
- `unibill-backend/supabase/migrations/20260615121100_add_business_comments_p0.sql`

**Acceptance:**
- All non-trivial columns on the 8 P0-P1 tables have COMMENT ON COLUMN
- Trigger functions also have COMMENT ON FUNCTION explaining their behavior
- Comments retrieved via `\d+ <table>` or `pg_description` are human-readable
- Migration is reversible (COMMENT '' to clear) — note added in commit message
- No regression in other tests after applying

---

### `T-126` — Document P0-P1 schema in ERD + data dictionary skeleton

**Category:** `doc` | **Size:** `M` (~5h) | **Depth:** 12
**Depends on:** `T-121`
**Spec refs:** §5, §G

Generate an ERD (Mermaid or PlantUML) covering all P0-P1 tables (households, members, household_invitations, user_profiles, system_actors, app_settings, app_settings_history, consent_log) showing relationships, partial unique indexes (noted), and RLS policy summary. Commit as `docs/erd-p0.md`. Also create `docs/data-dictionary.md` with one section per table listing all columns (name, type, nullable, description from COMMENT). Auto-generation script `scripts/gen_data_dictionary.ts` queries `pg_description` and outputs the markdown — wire as optional CI artifact, not blocking.

**Files:**
- `unibill-backend/docs/erd-p0.md`
- `unibill-backend/docs/data-dictionary.md`
- `unibill-backend/scripts/gen_data_dictionary.ts`

**Acceptance:**
- ERD renders correctly in GitHub markdown preview (Mermaid)
- Data dictionary has one section per P0-P1 table with all columns + COMMENT text
- `scripts/gen_data_dictionary.ts` regenerates the file deterministically given a DB connection
- Both docs cross-link to relevant spec sections
- Diff between generated and committed file is zero after running the script

---

## Phase P2-P3 — Auth Flow & Connected Emails (Vault)

**Tasks:** 30

Stand up Supabase Auth with pt-BR templates, HIBP, lockout and captcha; wire deep links for the Android Flutter app; ship the full onboarding + household + invitation flow; deliver the connected_emails / connected_email_households schema with Vault-backed credentials and the /emails/* Edge Functions that create, rotate and revoke them. Includes RLS, pgTAP coverage, COMMENT ON COLUMN, and the system_admin_grants audit + bootstrap trail from §9.

**Phase done when:** A user can sign up (pt-BR, HIBP, captcha, lockout enforced), confirm via deep-link callback, accept LGPD consent, create or join (via invite code) a household, connect a Gmail with IMAP+Vault validation, rotate / soft-delete the credential, and have all RLS, audit and pgTAP tests green in CI. Bootstrap of the first system admin produces a row in system_admin_grants and a domain_event. All connected_emails / connected_email_households columns are documented via COMMENT ON COLUMN.

---

### `T-201` — Configure Supabase Auth (pt-BR, HIBP, session, password policy)

**Category:** `config` | **Size:** `M` (~5h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-202`, `T-203`, `T-204`, `T-205`, `T-226`, `T-309`, `T-312`
**Spec refs:** §9.1

Capture Supabase Auth settings in supabase/config.toml (and an apply script): email+password with mandatory confirmation, magic link, 1h password reset, 1-week sessions with refresh-token rotation, password requirements (>=10 chars + lower + upper + digit + special), GOTRUE_PASSWORD_HIBP_ENABLED=true, additional rate limits (5 signups/h/IP, 10 resets/h/IP, 5 OTP/h/email). Document every setting in supabase/auth/README.md and provide a smoke script that signs up with a known-pwned password and asserts rejection.

**Files:**
- `supabase/config.toml`
- `supabase/auth/README.md`
- `scripts/auth/verify-hibp.ts`

**Acceptance:**
- supabase/config.toml committed with all auth settings
- Smoke script rejects 'Password123!' with HIBP error
- Magic link + recovery flows enabled in config
- Session length = 7d with refresh rotation

---

### `T-202` — Customize Supabase Auth email templates (pt-BR)

**Category:** `config` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-201`
**Spec refs:** §9.1, §9.1 edge cases

Author and apply pt-BR templates for confirmation, recovery, magic_link, invite, email_change. Include an HTML fallback page used when the user clicks the link on a desktop ("abra no celular com o Unibill" + QR Code rendering the unibill:// deep link) and a 'Download APK' link to GitHub Releases. Templates committed under supabase/auth/templates/*.html and applied via Supabase CLI in CI.

**Files:**
- `supabase/auth/templates/confirmation.html`
- `supabase/auth/templates/recovery.html`
- `supabase/auth/templates/magic_link.html`
- `supabase/auth/templates/invite.html`
- `supabase/auth/templates/email_change.html`
- `supabase/auth/templates/fallback.html`
- `scripts/auth/apply-templates.sh`

**Acceptance:**
- 5 templates committed in pt-BR
- Templates include desktop fallback with QR + APK link
- Templates applied to project via CLI in CI workflow

---

### `T-203` — Configure redirect URLs and Site URL for deep links

**Category:** `config` | **Size:** `XS` (~0.5h) | **Depth:** 2
**Depends on:** `T-201`
**Blocks:** `T-219`, `T-322`, `T-324`, `T-326`
**Spec refs:** §9.1 Deep links

Set Site URL=unibill:// and Redirect URLs (unibill://auth/callback, unibill://auth/recovery, unibill://auth/magic-link). Commit the values in supabase/config.toml and add an integration smoke test that posts a recovery and asserts the link in the generated email uses the unibill:// scheme. Future https://app.unibill.dev/auth/callback documented as TODO.

**Files:**
- `supabase/config.toml`
- `scripts/auth/verify-redirect.ts`

**Acceptance:**
- Redirect URLs whitelisted in config.toml
- Recovery email link starts with unibill://auth/recovery
- Future https URL documented as TODO in README

---

### `T-206` — Migration: connected_emails + connected_email_households schema

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-102`
**Blocks:** `T-207`, `T-210`, `T-212`
**Spec refs:** §5.2

Create enums email_status and email_provider, plus both tables with columns/defaults per §5.2 (imap_host default imap.gmail.com, imap_port 993, imap_use_tls true, app_password_secret uuid Vault ref, consecutive_errors, last_processed_uid bigint, last_sync_at, etc.). Add partial unique indexes uq_email_household_active (connected_email_id, household_id) WHERE deleted_at IS NULL and idx_default_per_email WHERE is_default=true AND deleted_at IS NULL, plus updated_at triggers and rollback comments.

**Files:**
- `supabase/migrations/20260610_connected_emails.sql`

**Acceptance:**
- Migration applies cleanly on a fresh DB
- uq_email_household_active enforced (insert duplicate fails; soft-delete + reinsert succeeds)
- idx_default_per_email allows exactly one default per active email
- updated_at trigger fires on UPDATE

---

### `T-208` — Migration: app.create_vault_secret + app.decrypt_app_password wrappers

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-102`
**Blocks:** `T-209`, `T-212`
**Spec refs:** §9.3.1

Implement both SECURITY DEFINER wrappers in schema app per §9.3.1, with SET search_path = '' and explicit GRANT EXECUTE only to service_role and REVOKE from PUBLIC. decrypt_app_password raises P0002 'Vault secret not found' when missing. Add a pgTAP unit test that asserts authenticated role cannot EXECUTE either function and that decrypt round-trip works for a created secret.

**Files:**
- `supabase/migrations/20260612_app_vault_helpers.sql`
- `supabase/tests/pgtap/app_vault_helpers.test.sql`

**Acceptance:**
- Both functions exist with prosecdef=true
- REVOKE from PUBLIC and GRANT to service_role asserted in pgTAP
- decrypt raises P0002 when secret missing

---

### `T-223` — Migration: user_profiles table + auto-create trigger + RLS

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-102`
**Spec refs:** §5.12

Create user_profiles (user_id PK FK auth.users ON DELETE CASCADE, display_name NOT NULL, avatar_url, locale CHECK ('pt-BR','en-US') DEFAULT 'pt-BR', theme CHECK ('system','light','dark') DEFAULT 'system', created_at, updated_at) per §5.12. AFTER INSERT trigger on auth.users that calls create_user_profile() — uses raw_user_meta_data->>'display_name' or split_part(email,'@',1). RLS: SELECT for any user sharing a household, UPDATE only own row. Update user_display_name() helper to consult user_profiles first.

**Files:**
- `supabase/migrations/20260618_user_profiles.sql`
- `supabase/tests/rls/user_profiles.test.sql`

**Acceptance:**
- Trigger fires on signup and inserts a profile row
- SELECT visible to household co-members
- UPDATE forbidden to non-owners
- user_display_name() prefers user_profiles over auth.users
- pgTAP RLS test green

---

### `T-224` — Migration: consent_log table + indices + RLS

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-102`
**Blocks:** `T-225`, `T-228`
**Spec refs:** §5.9, §5.11

Implement §5.9 consent_log: enum consent_purpose, table with version/legal_basis/accepted_at/revoked_at/ip_address inet/user_agent, unique index uq_consent_active_per_purpose WHERE revoked_at IS NULL, idx_consent_user_purpose, RLS: own + sys-admin SELECT, own INSERT, UPDATE limited to revoked_at and revoked_reason via column-level trigger.

**Files:**
- `supabase/migrations/20260619_consent_log.sql`
- `supabase/tests/rls/consent_log.test.sql`

**Acceptance:**
- Schema applied with enum + table + indices
- Unique active-per-purpose index enforced
- UPDATE restricted to revocation fields
- pgTAP covers SELECT/INSERT/UPDATE/DELETE policy paths

---

### `T-226` — HIBP integration verification test (CI)

**Category:** `test` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-201`
**Spec refs:** §9.1 HIBP

Add an integration test (scripts/auth/verify-hibp.ts) executed in CI nightly and on auth-config PRs that calls supabase.auth.signUp with a list of well-known pwned passwords (Password123!, Admin@2024, qwerty12345, etc.) and asserts rejection with the weak_password / pwned_password error. Also asserts that a strong unique password succeeds. Fails the build if any pwned password is accepted.

**Files:**
- `scripts/auth/verify-hibp.ts`
- `.github/workflows/auth-hibp.yml`

**Acceptance:**
- All known-pwned passwords rejected
- Strong unique password accepted
- CI workflow runs the script nightly and on auth-config changes

---

### `T-207` — Migration: connected_emails COMMENT ON COLUMN metadata

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-206`
**Spec refs:** §G COMMENT strategy, §5.2

Add COMMENT ON COLUMN for every business-meaningful column on connected_emails and connected_email_households: email_address normalization rule, app_password_secret as Vault uuid pointer, last_processed_uid IMAP cursor semantics, consecutive_errors threshold reference (sync.consecutive_error_threshold), is_default uniqueness invariant, deleted_at soft-delete semantics. Integrates with the data-dictionary CI check.

**Files:**
- `supabase/migrations/20260611_connected_emails_comments.sql`

**Acceptance:**
- pg_catalog query returns non-NULL description for every documented column
- Data-dictionary CI check passes

---

### `T-209` — Migration: vault GRANT/REVOKE matrix

**Category:** `migration` | **Size:** `XS` (~0.5h) | **Depth:** 3
**Depends on:** `T-208`
**Spec refs:** §9.3.1 GRANT/REVOKE matrix

REVOKE ALL on vault.* tables and functions from anon/authenticated; GRANT USAGE on schema vault to service_role. Add a pgTAP test confirming an authenticated session cannot SELECT vault.decrypted_secrets nor EXECUTE vault.create_secret directly, while service_role retains access. Defense in depth on top of the SECURITY DEFINER wrappers.

**Files:**
- `supabase/migrations/20260613_vault_grants.sql`
- `supabase/tests/pgtap/vault_grants.test.sql`

**Acceptance:**
- authenticated SELECT vault.decrypted_secrets fails with insufficient_privilege
- authenticated EXECUTE vault.create_secret fails
- service_role retains access

---

### `T-210` — Migration: RLS policies for connected_emails + connected_email_households

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-206`, `T-103`
**Blocks:** `T-211`, `T-212`
**Spec refs:** §5.11

Enable RLS and create policies per §5.11 row in the table: on connected_emails SELECT/INSERT/UPDATE/DELETE allowed for owner_user_id = auth.uid() OR app.is_household_admin via EXISTS join on connected_email_households; on connected_email_households SELECT for member-of (app.households_of_user()), write for admin-of (app.is_household_admin). Include WITH CHECK clauses mirroring USING.

**Files:**
- `supabase/migrations/20260614_rls_connected_emails.sql`

**Acceptance:**
- RLS enabled on both tables
- Owner can read/write own connected_email row
- Admin of bound household can read/write same row
- Non-member SELECT denied
- WITH CHECK prevents privilege escalation on UPDATE

---

### `T-216` — Migration: system_admin_grants audit table + RLS

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-103`
**Blocks:** `T-217`
**Spec refs:** §9.2

Create table per §9.2 (id, user_id REFERENCES auth.users, action CHECK action IN ('granted','revoked'), granted_by nullable for bootstrap, granted_at, reason text NOT NULL, correlation_id). Add idx_admin_grants_user_time on (user_id, granted_at DESC). Enable RLS with admin_grants_select_sysadmin policy using app.is_system_admin(). No INSERT policy — service_role only.

**Files:**
- `supabase/migrations/20260617_system_admin_grants.sql`

**Acceptance:**
- Table + index + RLS applied
- Non sys-admin SELECT returns empty
- service_role INSERT succeeds

---

### `T-219` — Configure AndroidManifest intent filter + custom URL scheme

**Category:** `mobile_feature` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-203`
**Blocks:** `T-218`
**Spec refs:** §9.1 AndroidManifest

Edit android/app/src/main/AndroidManifest.xml to set MainActivity launchMode=singleTask with the intent-filter from §9.1 (action VIEW, categories DEFAULT/BROWSABLE, data scheme='unibill' host='auth', autoVerify=true). Add a Flutter-side deep_link_handler util that listens via app_links package and forwards to go_router /auth/callback. Document the future https assetlinks.json path as TODO.

**Files:**
- `unibill-mobile/android/app/src/main/AndroidManifest.xml`
- `unibill-mobile/lib/core/deep_links/deep_link_handler.dart`
- `unibill-mobile/integration_test/deep_link_test.dart`

**Acceptance:**
- Manifest committed with intent filter
- app_links + go_router round-trip verified via integration_test using adb am start
- README documents future App Links activation with assetlinks.json

---

### `T-227` — Migration: invited_email normalization + base32 code CHECK + redeem index

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-103`
**Spec refs:** §9.1 Invitation security, §5.1

Normalize household_invitations.invited_email to lowercase via BEFORE INSERT/UPDATE trigger. Add CHECK that code matches ^[A-Z2-9]{8}$ (base32, no I/L/O/0/1) per §9.1 (32^8 ≈ 1.1 trillion). Add a partial index on (code) WHERE used_at IS NULL AND expires_at > now() so /invitations/redeem lookups are O(log n). pgTAP asserts malformed codes rejected and EXPLAIN shows index hit.

**Files:**
- `supabase/migrations/20260620_invitations_hardening.sql`
- `supabase/tests/pgtap/invitations.test.sql`

**Acceptance:**
- CHECK rejects malformed codes
- EXPLAIN shows partial index hit for redeem query
- invited_email always lower-cased on insert

---

### `T-228` — Edge Functions POST /consent/accept and /consent/revoke

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-224`
**Blocks:** `T-225`, `T-229`
**Spec refs:** §9.4, §5.9

Create endpoints that INSERT a new consent_log row on accept (purpose, version, legal_basis='consent', ip_address inet from header, user_agent from header) and UPDATE revoked_at/revoked_reason on revoke. On telemetry revoke also DELETE FROM client_telemetry WHERE user_id=me per §9.4. JWT user-scoped. Returns active versions per purpose. Used by T-225 and the Settings UI.

**Files:**
- `supabase/functions/consent-accept/index.ts`
- `supabase/functions/consent-revoke/index.ts`
- `supabase/functions/consent-accept/index.test.ts`
- `supabase/functions/consent-revoke/index.test.ts`

**Acceptance:**
- Accept inserts row respecting unique active-per-purpose
- Revoke marks active row revoked_at and (telemetry) purges client_telemetry
- Returns 409 if active consent for same purpose+version already exists
- Deno tests cover accept/revoke happy + duplicate

---

### `T-204` — Implement login lockout middleware (10 fails / 30min → 1h block + unlock link)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-201`, `T-104`
**Blocks:** `T-205`, `T-218`
**Spec refs:** §9.1 Lockout

Build an Edge Function proxy /auth/login-guard that consults rate_limit_buckets keyed by email_address, blocks for 1h after 10 failed attempts in 30min, and emits an unlock email containing a one-shot reset link. On block, return HTTP 423 Locked with a retry_after field. Wire the Flutter client to call this guard before supabase.auth.signInWithPassword. Includes Deno tests for window roll-over and threshold math, and emits domain_event auth.lockout.triggered.

**Files:**
- `supabase/functions/auth-login-guard/index.ts`
- `supabase/functions/_shared/lockout.ts`
- `supabase/functions/auth-login-guard/index.test.ts`

**Acceptance:**
- 10 failed attempts trigger HTTP 423 + unlock email
- After 1h elapsed OR unlock link clicked, attempts counter resets
- Deno test covers window roll-over (29min vs 31min)
- domain_event auth.lockout.triggered emitted

---

### `T-211` — pgTAP RLS tests for connected_emails (cross-tenant + cross-binding)

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-210`
**Spec refs:** §5.11

Author pgTAP suite per §5.11 'Cobertura via pgTAP obrigatória': two users in different households (cross-tenant), same connected_email bound to two households (cross-binding leakage), sys admin sees all, owner-not-admin write permitted, admin-of-bound-household write permitted, non-member SELECT denied, soft-deleted binding stops admin access. Wire into CI via supabase test command.

**Files:**
- `supabase/tests/rls/connected_emails.test.sql`
- `supabase/tests/rls/connected_email_households.test.sql`

**Acceptance:**
- Suite covers >=8 scenarios including cross-binding
- All assertions green on local DB
- CI workflow runs the suite on every PR

---

### `T-215` — Edge Function POST /invitations/redeem (rate limit + lockout + email match)

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 4
**Depends on:** `T-103`, `T-104`
**Blocks:** `T-220`
**Spec refs:** §9.1 Invitation security, §E POST /invitations/redeem, BR-026, BR-027

Implement supabase/functions/invitations-redeem/index.ts per §9.1 invitation security: Zod body { code: 8 chars }, JWT auth, double rate limit invite_redeem:ip (10/h) and invite_redeem:user_id (5/h), validate code exists + not expired + not used. If invitation.invited_email IS NOT NULL must match auth.email() (403). After 5 failed attempts on the same code, invalidate the code permanently regardless of expiry. Emit invitation.redeem_failed on each failure. On success INSERT members row + UPDATE invitation used_at/used_by + emit invitation.redeemed. Returns { household_id, role }.

**Files:**
- `supabase/functions/invitations-redeem/index.ts`
- `supabase/functions/invitations-redeem/index.test.ts`

**Acceptance:**
- 404 on missing/expired/used code
- 403 on invited_email mismatch
- 429 on rate-limit
- Code permanently invalidated after 5 failures
- invitation.redeem_failed event emitted per failure
- Happy path INSERTs members row + UPDATEs invitation
- Deno tests cover all branches

---

### `T-217` — Bootstrap script + audit row for first system admin

**Category:** `ops` | **Size:** `S` (~2h) | **Depth:** 4
**Depends on:** `T-216`
**Spec refs:** §9.2 Bootstrap, BR-028

Provide scripts/admin/bootstrap-sys-admin.sql containing the DO block from §9.2: UPDATEs auth.users.raw_app_meta_data with is_system_admin=true, INSERTs system_admin_grants(reason='bootstrap', granted_by=NULL), INSERTs domain_event system_admin.bootstrapped. Script is idempotent (skips if already admin). Document the procedure in docs/ops/bootstrap-sys-admin.md and add a pgTAP guard that a successful bootstrap creates both rows.

**Files:**
- `scripts/admin/bootstrap-sys-admin.sql`
- `docs/ops/bootstrap-sys-admin.md`
- `supabase/tests/pgtap/bootstrap.test.sql`

**Acceptance:**
- Script idempotent: re-running is safe
- After run system_admin_grants has reason='bootstrap', granted_by NULL
- domain_events has system_admin.bootstrapped event
- README documents one-time invocation in Studio

---

### `T-230` — Shared edge-function helpers: imap, captcha, rateLimit, auth context

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-104`
**Blocks:** `T-212`
**Spec refs:** §6.4, §6.5, §4.2.1, §9.1

Build supabase/functions/_shared/imap.ts implementing validateImapCredentials(email, password, host, port, useTls) using imapflow with logger:false + emitLogs:false; returns ok | invalid_credentials | network_error and ensures redactSecrets() wraps any thrown error before re-raise. Co-locate getCallerUser(req) (returns { id, email }), withRateLimit(bucketName, key, limit, window) backed by rate_limit_buckets, and verifyCaptcha(token, ip). All consumed by T-204, T-205, T-212-T-215. Unit-tested with stubs.

**Files:**
- `supabase/functions/_shared/imap.ts`
- `supabase/functions/_shared/imap.test.ts`
- `supabase/functions/_shared/auth.ts`
- `supabase/functions/_shared/rateLimit.ts`
- `supabase/functions/_shared/captcha.ts`

**Acceptance:**
- validateImapCredentials returns correct enum for each scenario
- redactSecrets applied to any error message containing the password
- withRateLimit honours per-key window and threshold
- getCallerUser raises 401 if JWT missing/invalid
- Module covered by Deno unit tests with stubs

---

### `T-205` — Integrate hCaptcha on signup and password reset

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 5
**Depends on:** `T-201`, `T-204`
**Blocks:** `T-218`, `T-409`, `T-415`, `T-418`
**Spec refs:** §9.1 captcha

Add hCaptcha (free tier) site key + secret in env. Require captcha token whenever the per-IP rate limit (5 signups/h, 10 resets/h) is exceeded. Server-side verify the token via the hCaptcha API; on failure return HTTP 429 with code 'captcha_required' so the mobile UI prompts for the widget. Provide /auth/signup-guard and /auth/reset-guard Edge Functions wrapping the Supabase auth endpoints.

**Files:**
- `supabase/functions/_shared/captcha.ts`
- `supabase/functions/auth-signup-guard/index.ts`
- `supabase/functions/auth-reset-guard/index.ts`
- `supabase/functions/auth-signup-guard/index.test.ts`

**Acceptance:**
- captcha_required surfaces only after rate-limit threshold reached
- hCaptcha verify call gated by env flag (disabled in tests)
- Deno test stubs hCaptcha verify endpoint

---

### `T-212` — Edge Function POST /emails/connect (IMAP validation + Vault)

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-206`, `T-208`, `T-210`, `T-230`
**Blocks:** `T-213`, `T-214`, `T-222`
**Spec refs:** §9.3.1 Create, §E POST /emails/connect, §6.4 IMAP

Implement supabase/functions/emails-connect/index.ts: Zod body { email_address, app_password (16 chars lowercase regex), household_ids[] }, JWT auth, assert caller is admin of each household_id (app.is_household_admin), attempt IMAP login via imapflow against imap.gmail.com:993 using the provided credentials with redactSecrets()-wrapped errors, on success call app.create_vault_secret(secret_value, name, description) then INSERT connected_emails + connected_email_households rows in a single transaction. Errors: 422 validation, 401 IMAP, 409 email already owned. Emit domain_event email.connected.

**Files:**
- `supabase/functions/emails-connect/index.ts`
- `supabase/functions/emails-connect/index.test.ts`

**Acceptance:**
- Happy path returns 200 with connected_email_id + household_bindings
- 401 returned on IMAP auth failure
- 409 returned when email already owned by another user
- Vault secret created and referenced by FK uuid
- redactSecrets applied to any error logs
- Deno tests cover happy + 3 error branches with imapflow stub

---

### `T-213` — Edge Function PATCH /emails/:id/rotate-password

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 6
**Depends on:** `T-212`
**Blocks:** `T-222`
**Spec refs:** §9.3.1 Rotação, §E PATCH /emails/:id/rotate-password

Implement supabase/functions/emails-rotate/index.ts: JWT auth must equal owner_user_id, Zod body { new_app_password (16 chars) }, re-verify IMAP login with new password against the stored imap_host/port/use_tls. On success call vault.update_secret(id, new_value, new_name, new_description) via a SECURITY DEFINER wrapper so connected_emails.app_password_secret uuid is preserved (workers in-flight keep buffered password, next decrypt picks the new one). Return { rotated_at }. Emit domain_event email.password_rotated.

**Files:**
- `supabase/functions/emails-rotate/index.ts`
- `supabase/functions/emails-rotate/index.test.ts`
- `supabase/migrations/20260615_app_update_vault_secret.sql`

**Acceptance:**
- Vault secret uuid unchanged after rotation
- IMAP re-validated before vault swap
- 401 returned on auth failure with new password
- Non-owner caller receives 403
- Deno test stubs IMAP + vault.update_secret

---

### `T-214` — Edge Function DELETE /emails/:id (soft delete + revoke vault)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 6
**Depends on:** `T-212`
**Blocks:** `T-222`
**Spec refs:** §9.3.1 End user / system admin, §E DELETE /emails/:id

Implement supabase/functions/emails-delete/index.ts: owner OR sys admin auth, soft-delete connected_emails row (deleted_at=now(), status='revoked'), soft-delete every connected_email_households binding, DELETE the corresponding vault secret via SECURITY DEFINER wrapper app.delete_vault_secret. Emit domain_event email.revoked. Return { soft_deleted: true }.

**Files:**
- `supabase/functions/emails-delete/index.ts`
- `supabase/functions/emails-delete/index.test.ts`
- `supabase/migrations/20260616_app_delete_vault_secret.sql`

**Acceptance:**
- After call status='revoked' and deleted_at populated
- All bindings soft-deleted
- vault.secrets row hard-deleted
- Non-owner non-admin receives 403
- Deno test covers both auth paths

---

### `T-218` — Flutter auth feature module (welcome, signup, login, recovery, verify-callback)

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 6
**Depends on:** `T-204`, `T-205`, `T-219`
**Blocks:** `T-220`, `T-225`
**Spec refs:** §8.5, §9.1

Scaffold lib/features/auth per §8.5 with FeatureModule pattern: pages welcome, signup, login, recovery, verify-callback; AuthBloc states (initial/loading/authenticated/unauthenticated/lockedOut/captchaRequired/needsReconsent); SupabaseAuthDataSource that proxies through /auth/login-guard, /auth/signup-guard, /auth/reset-guard; GoRoute entries; deep link handler at /auth/callback per §9.1 (supabase.auth.getSessionFromUrl). UI surfaces lockout (countdown), HIBP rejection and captcha prompts in pt-BR.

**Files:**
- `unibill-mobile/lib/features/auth/auth_module.dart`
- `unibill-mobile/lib/features/auth/presentation/pages/welcome_page.dart`
- `unibill-mobile/lib/features/auth/presentation/pages/login_page.dart`
- `unibill-mobile/lib/features/auth/presentation/pages/signup_page.dart`
- `unibill-mobile/lib/features/auth/presentation/pages/recovery_page.dart`
- `unibill-mobile/lib/features/auth/presentation/pages/verify_callback_page.dart`
- `unibill-mobile/lib/features/auth/presentation/bloc/auth_bloc.dart`
- `unibill-mobile/lib/features/auth/data/datasources/auth_remote_datasource.dart`
- `unibill-mobile/test/features/auth/auth_bloc_test.dart`

**Acceptance:**
- All 5 screens render and route via go_router
- Login surfaces 423 lockout with countdown
- Signup surfaces captcha widget after rate-limit
- Deep link opens app and lands user on / when session valid
- Widget tests cover happy path + error states

---

### `T-220` — Flutter onboarding: create household OR redeem invite

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-215`, `T-218`
**Blocks:** `T-221`
**Spec refs:** §8.5, §9.1

Build lib/features/auth/presentation/pages/onboarding_page.dart at route /auth/onboarding: two CTA cards 'Criar família' (POSTs to households endpoint from agent 1) and 'Tenho um código de convite' (8-char input → POST /invitations/redeem). After success, get_it scope swap and navigate to /. Map server errors: 404→'Código inválido', 403→'Convite endereçado a outro email', 429→'Muitas tentativas, tente em 1h'. Widget tests cover both branches and all 3 error codes.

**Files:**
- `unibill-mobile/lib/features/auth/presentation/pages/onboarding_page.dart`
- `unibill-mobile/lib/features/auth/presentation/bloc/onboarding_bloc.dart`
- `unibill-mobile/test/features/auth/onboarding_test.dart`

**Acceptance:**
- User can create household and lands on /
- User can redeem valid code and lands on /
- UI shows distinct pt-BR copy for 403 vs 404 vs 429
- Widget tests cover all 3 error codes

---

### `T-222` — Flutter emails feature module (connect, list, edit, rotate)

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 7
**Depends on:** `T-212`, `T-213`, `T-214`
**Spec refs:** §8.5, §9.3.1

Build lib/features/emails per §8.5 with EmailsBloc, list of connected_emails (status pill, last_sync_at, error badge based on consecutive_errors), ConnectEmailPage form (email + 16-char app password + multi-select household bindings) calling POST /emails/connect, EmailDetailPage with RotatePasswordSheet (PATCH /emails/:id/rotate-password), and Delete confirmation (DELETE /emails/:id). Surfaces 401/409 errors with pt-BR copy and includes a 'Como gerar uma App Password no Gmail' help link.

**Files:**
- `unibill-mobile/lib/features/emails/emails_module.dart`
- `unibill-mobile/lib/features/emails/presentation/pages/emails_list_page.dart`
- `unibill-mobile/lib/features/emails/presentation/pages/connect_email_page.dart`
- `unibill-mobile/lib/features/emails/presentation/pages/email_detail_page.dart`
- `unibill-mobile/lib/features/emails/presentation/widgets/rotate_password_sheet.dart`
- `unibill-mobile/lib/features/emails/presentation/bloc/emails_bloc.dart`
- `unibill-mobile/lib/features/emails/data/datasources/emails_remote_datasource.dart`
- `unibill-mobile/test/features/emails/emails_bloc_test.dart`

**Acceptance:**
- User can connect a Gmail and see it appear in list
- User can rotate password; UI shows updated rotated_at
- User can revoke email; status='revoked' reflected in UI
- 401 (IMAP failed) and 409 (already owned) surfaced with help link
- Widget tests cover happy path + the 2 main error branches

---

### `T-225` — Flutter LGPD consent screen at signup

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-218`, `T-224`, `T-228`
**Blocks:** `T-229`
**Spec refs:** §9.4, §5.9

Build lib/features/auth/presentation/pages/consent_page.dart per §9.4: shown right after email confirmation, before /auth/onboarding. Lists what we collect (text from app_settings legal.privacy_notice_pt), checkbox 'Li e aceito os Termos e Política de Privacidade', POSTs to /consent/accept (purposes terms + privacy, version from legal.terms_version). Blocks navigation forward until accepted.

**Files:**
- `unibill-mobile/lib/features/auth/presentation/pages/consent_page.dart`
- `unibill-mobile/lib/features/auth/presentation/bloc/consent_bloc.dart`
- `unibill-mobile/test/features/auth/consent_test.dart`

**Acceptance:**
- Screen renders pt-BR privacy notice from app_settings
- Cannot proceed without checking box
- Accept call writes consent_log rows visible in DB
- Widget test covers blocked + unblocked states

---

### `T-221` — Flutter household feature module (members + invitations)

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 8
**Depends on:** `T-220`
**Spec refs:** §8.5, §5.1

Build lib/features/household with HouseholdBloc, members list (display_name from user_profiles), role badges (admin/member), leave button (calls DELETE on members; surfaces server error from trg_min_one_admin), 'Convidar' button opens InviteCreateSheet that calls into the invitations creation endpoint, copy-to-clipboard + share_intent for the 8-char code. Admin-only actions hidden via FeatureGate using app.is_household_admin response. Route /household per §8.5.

**Files:**
- `unibill-mobile/lib/features/household/household_module.dart`
- `unibill-mobile/lib/features/household/presentation/pages/household_page.dart`
- `unibill-mobile/lib/features/household/presentation/widgets/invite_create_sheet.dart`
- `unibill-mobile/lib/features/household/presentation/bloc/household_bloc.dart`
- `unibill-mobile/test/features/household/household_bloc_test.dart`

**Acceptance:**
- Members listed with role badges and display_name
- Admin can create invite, copy and share the code
- Non-admin members see read-only list
- Leaving as last admin surfaces server error in snackbar
- Widget tests cover admin and member POVs

---

### `T-229` — Re-consent gate on login (status endpoint + client redirect)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 8
**Depends on:** `T-225`, `T-228`
**Spec refs:** §5.9, BR-017

Implement §5.9 re-consent logic. Add /auth/consent-status that compares the user's latest active consent_log.version for purpose='terms' against app_settings.legal.terms_version and returns { needs_reconsent: bool, latest_version }. AuthBloc calls this after successful login; if needs_reconsent, GoRouter redirects to /auth/consent and blocks /. Integration test bumps legal.terms_version and verifies the next login enforces re-consent.

**Files:**
- `supabase/functions/auth-consent-status/index.ts`
- `unibill-mobile/lib/features/auth/presentation/bloc/auth_bloc.dart`
- `unibill-mobile/test/features/auth/reconsent_test.dart`

**Acceptance:**
- needs_reconsent true after bumping app_settings.legal.terms_version
- Client redirects to consent page and blocks /
- After re-accept navigation unblocked
- Integration test exercises the full loop

---

## Phase P4 — Ingestion Pipeline (Sync + IMAP)

**Tasks:** 35

Build the end-to-end IMAP-based email-to-invoice ingestion pipeline: invoices/categories/parsers schema with the cross-table FK migration, observability tables (sync_runs, extraction_runs, domain_events), resilience tables (circuit_breakers, rate_limit_buckets), pgmq queues (email_sync_queue + DLQ, invoice_queue + DLQ), the pg_cron + pg_net wrapper for orchestration, the sync-dispatcher and sync-worker Edge Functions with imapflow + PDF magic-byte validation + secret redaction + transactional insert/enqueue/event emission, all _shared/ helper middlewares, household resolution via binding, auto-pause on consecutive errors, parser seeds (enel-sp full + sabesp/comgas/vivo placeholders), business comments, and pgTAP + Deno tests covering RLS, dedupe, redaction and mock IMAP paths. Phase done when a real Gmail-style mailbox can be polled, PDFs ingested into Storage, invoices inserted, invoice_queue populated and domain_events emitted — all under RLS, with auto-pause, circuit breaking and rate limiting verified by tests.

**Phase done when:** All P4 migrations apply cleanly in the documented order (invoices → invoice_categories → link FK → utility_parsers → domain_events → runs → resilience → queues → RLS → pg_cron wrapper → cron schedules → COMMENTS); pgTAP RLS, dedupe, parser, redaction and cron tests pass; sync-dispatcher and sync-worker Edge Functions deploy and pass Deno integration tests with mocked imapflow/Supabase/Storage; cron schedules registered idempotently; enel-sp parser seed verified against synthetic fixtures; manual end-to-end run against a sandbox mailbox produces invoices.queued rows + invoice_queue messages + 'invoice.created' domain events transactionally and increments sync_runs counters; auto-pause + circuit-breaker recovery documented in the runbook.

---

### `T-315` — _shared/ helper: redactSecrets middleware (with all patterns)

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 0
**Blocks:** `T-316`, `T-321`, `T-326`, `T-327`, `T-331`
**Spec refs:** §6.5

Implement supabase/functions/_shared/redact.ts per §6.5: export const SECRET_PATTERNS with Gmail app-password (16 lowercase chars formatted-or-not), Authorization Bearer/Basic, IMAP LOGIN command echo, CPF (\d{3}\.?\d{3}\.?\d{3}-?\d{2}), CNPJ. Export function redactSecrets(s: string|null|undefined): string applying all patterns. Also export wrapRedaction(err: unknown): string for safe error stringification.

**Files:**
- `supabase/functions/_shared/redact.ts`
- `supabase/functions/_shared/redact.test.ts`

**Acceptance:**
- Unit tests cover every pattern with at least one positive sample (formatted app password xxxx-xxxx-xxxx-xxxx, IMAP LOGIN echo, CPF, CNPJ, Authorization header)
- redactSecrets(null) returns ''
- redactSecrets does not throw on non-string input

---

### `T-323` — _shared/ helper: findPdfParts + magic byte validation + sha256

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 0
**Blocks:** `T-326`
**Spec refs:** §6.4

Implement supabase/functions/_shared/pdf.ts with findPdfParts(bodyStructure, {min_size_bytes, max_size_bytes}) iterating recursively the imapflow bodyStructure for type='application' && subtype='pdf' (case-insensitive), filtering by size range. Also export isPdfMagic(buf: Uint8Array): boolean (first 4 bytes == [0x25,0x50,0x44,0x46]) and streamToBuffer(stream), sha256(buf): string (hex lowercase).

**Files:**
- `supabase/functions/_shared/pdf.ts`
- `supabase/functions/_shared/pdf.test.ts`

**Acceptance:**
- Returns multiple PDF parts when nested in multipart/mixed and multipart/alternative
- Skips parts outside size range
- isPdfMagic false for non-PDF buffer, true for %PDF header
- Unit tests cover nested bodyStructure fixtures, size filters, and magic-byte check

---

### `T-301` — Migration: invoices table with PIX/customer/service fields + partial unique indexes

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-303`, `T-306`, `T-309`, `T-312`, `T-326`, `T-329`
**Spec refs:** §5.3, §5.10

Create migration 20260615120000_create_invoices.sql implementing the full §5.3 invoices DDL: enums (invoice_status, extraction_method, payment_confirmation_source), invoices table with ALL fields (source_sender, source_subject, source_uid, source_received_at, customer_name, customer_document, service_address, installation_id, pix_payload/pix_key/pix_txid, payment_methods text[], extracted_payload jsonb {version,data}, payment_confirmation_source/confidence, pdf_archived_at, audit fields, deleted_at). Add CHECK chk_file_hash_format ('^[a-f0-9]{64}$'). Create partial unique indexes uq_invoices_household_filehash_active and uq_invoices_email_messageid_active (both WHERE deleted_at IS NULL; the message_id one also WHERE source_message_id IS NOT NULL). Create supporting indexes idx_invoices_household_status, idx_invoices_household_due (paid_at IS NULL), idx_invoices_household_utility, idx_invoices_needs_review. DROP audit FK constraints (paid_by_fkey, created_by_fkey, updated_by_fkey) per §5.10 Approach A. category_id stays uuid with NO FK yet (added in T-303).

**Files:**
- `supabase/migrations/20260615120000_create_invoices.sql`

**Acceptance:**
- Migration file lives at supabase/migrations/20260615120000_create_invoices.sql
- supabase db reset applies migration without error
- Inserting file_hash with uppercase or non-hex fails the CHECK
- Soft-deleted row does not block re-insert of same (household_id,file_hash)
- All listed indexes present in pg_indexes after apply
- No FK to auth.users on paid_by/created_by/updated_by

---

### `T-302` — Migration: invoice_categories table

**Category:** `migration` | **Size:** `XS` (~0.5h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-303`, `T-309`
**Spec refs:** §5.4

Create migration 20260615120100_create_invoice_categories.sql per §5.4: invoice_categories(id, household_id FK households, name, color, icon, is_system, sort_order, created_at, updated_at, deleted_at). Add partial unique index idx_cat_name_household ON (household_id, name) WHERE deleted_at IS NULL.

**Files:**
- `supabase/migrations/20260615120100_create_invoice_categories.sql`

**Acceptance:**
- Migration applies after invoices migration
- Duplicate (household_id, name) for active rows is blocked
- Soft-deleted name can be reused

---

### `T-304` — Migration: utility_parsers table + active partial index

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-309`, `T-312`, `T-313`, `T-314`
**Spec refs:** §5.4

Create migration 20260615120300_create_utility_parsers.sql per §5.4: utility_parsers(id, utility_key, display_name, default_category, sender_patterns text[] NOT NULL, subject_patterns text[], body_must_contain text[], amount_regex, due_date_regex, due_date_format, barcode_regex, pix_regex, reference_regex, installation_regex, customer_name_regex, service_address_regex, consumption_extractor jsonb NULL, version int, active boolean, notes, created_at, updated_at, UNIQUE(utility_key, version)). Create partial index idx_parsers_active ON utility_parsers(utility_key) WHERE active=true. Document in COMMENT that consumption_extractor is reserved for roadmap (worker MUST ignore in MVP).

**Files:**
- `supabase/migrations/20260615120300_create_utility_parsers.sql`

**Acceptance:**
- Migration applies; constraint UNIQUE(utility_key, version) enforced
- Partial index supports fast active-parser lookup
- Migration includes COMMENT noting MVP behavior for consumption_extractor

---

### `T-305` — Migration: domain_events table + indexes

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-309`, `T-320`, `T-326`
**Spec refs:** §5.6

Create migration 20260615120400_create_domain_events.sql per §5.6 domain_events DDL with all four indexes: idx_events_aggregate, idx_events_household (WHERE household_id IS NOT NULL), idx_events_correlation (WHERE correlation_id IS NOT NULL), idx_events_type_time. payload jsonb NOT NULL with {version,data} convention. Document that household_id NULL is allowed for system-wide events.

**Files:**
- `supabase/migrations/20260615120400_create_domain_events.sql`

**Acceptance:**
- Migration applies cleanly
- INSERT with household_id NULL succeeds
- All 4 indexes appear in pg_indexes for domain_events

---

### `T-307` — Migration: circuit_breakers + rate_limit_buckets resilience tables

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-309`, `T-318`, `T-319`
**Spec refs:** §5.8

Create migration 20260615120600_create_resilience_tables.sql per §5.8. circuit_breakers PK (resource_type, resource_key) with circuit_state enum and all counters/timestamps; rate_limit_buckets PK (resource_type, resource_key, window_start, window_size) with idx_buckets_expiry on window_start. RLS NOT enabled (service_role only).

**Files:**
- `supabase/migrations/20260615120600_create_resilience_tables.sql`

**Acceptance:**
- circuit_state enum + circuit_breakers table created
- rate_limit_buckets PK and expiry index present
- RLS not enabled on either table (verified via SELECT relrowsecurity FROM pg_class)

---

### `T-308` — Migration: pgmq queues for email_sync + invoice (with DLQs)

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-324`, `T-325`, `T-326`
**Spec refs:** §4.3

Create migration 20260615120700_create_pgmq_queues.sql that ensures pgmq extension is enabled and creates queues: email_sync_queue, email_sync_dlq, invoice_queue, invoice_dlq. Use pgmq.create() for each. Document VT defaults from §4.3 in COMMENTS. Grant USAGE on pgmq schema and EXECUTE on pgmq.send/read/delete to service_role only. Idempotent via IF NOT EXISTS pattern (or pgmq.queue_exists check).

**Files:**
- `supabase/migrations/20260615120700_create_pgmq_queues.sql`

**Acceptance:**
- Re-running migration is a no-op
- Selecting pgmq.list_queues() shows all 4 queues
- service_role can call pgmq.send/read/delete; authenticated cannot

---

### `T-310` — Migration: pg_cron + pg_net wrapper private.invoke_edge_function

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-311`
**Spec refs:** §6.6

Create migration 20260615120900_pgcron_pgnet_wrapper.sql enabling pg_cron and pg_net extensions, creating schema private, and setting GUCs (ALTER DATABASE postgres SET app.service_role_key=...placeholder..., ALTER DATABASE postgres SET app.edge_function_base=...) with a COMMENT noting values are populated out-of-band. Create private.invoke_edge_function(fn_name text, body jsonb DEFAULT '{}') SECURITY DEFINER SET search_path='' per §6.6, returning bigint (pg_net request_id). REVOKE EXECUTE FROM PUBLIC; GRANT EXECUTE TO postgres only. Include COMMENT describing rotation procedure.

**Files:**
- `supabase/migrations/20260615120900_pgcron_pgnet_wrapper.sql`

**Acceptance:**
- Migration enables extensions idempotently
- Wrapper function created with SECURITY DEFINER and search_path=''
- authenticated/anon CANNOT execute the wrapper
- Calling wrapper returns a bigint request_id when GUCs are populated

---

### `T-316` — _shared/ helper: withCorrelation + logging

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 1
**Depends on:** `T-315`
**Blocks:** `T-317`, `T-318`, `T-320`, `T-321`, `T-324`, `T-325`
**Spec refs:** §4.2.1, §6.5

Implement supabase/functions/_shared/correlation.ts exposing withCorrelation<T>(handler: (ctx: CorrelationContext)=>Promise<T>) per §4.2.1, reading x-correlation-id header or generating a uuid. Implement supabase/functions/_shared/logging.ts with log = {debug,info,warn,error} that automatically includes correlation_id and runs string meta through redactSecrets.

**Files:**
- `supabase/functions/_shared/correlation.ts`
- `supabase/functions/_shared/logging.ts`
- `supabase/functions/_shared/correlation.test.ts`

**Acceptance:**
- withCorrelation passes correlation_id into ctx and out as response header
- log.error stringifies meta through redactSecrets
- Unit tests cover header passthrough and uuid generation when header missing

---

### `T-303` — Migration: link invoices.category_id FK to invoice_categories

**Category:** `migration` | **Size:** `XS` (~0.5h) | **Depth:** 2
**Depends on:** `T-301`, `T-302`
**Spec refs:** §5.3

Create migration 20260615120200_link_invoices_category.sql adding ALTER TABLE invoices ADD CONSTRAINT fk_invoices_category FOREIGN KEY (category_id) REFERENCES invoice_categories(id) ON DELETE SET NULL per §5.3 note. Idempotent (wrap in DO block that checks pg_constraint first).

**Files:**
- `supabase/migrations/20260615120200_link_invoices_category.sql`

**Acceptance:**
- Migration applies cleanly after the two parent tables
- Deleting an invoice_categories row sets dependent invoices.category_id to NULL
- Re-running migration is a no-op (idempotency check)

---

### `T-306` — Migration: sync_runs + extraction_runs observability tables

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-101`, `T-301`
**Blocks:** `T-309`, `T-321`
**Spec refs:** §5.6

Create migration 20260615120500_create_runs_tables.sql with sync_runs and extraction_runs per §5.6. sync_runs includes correlation_id, connected_email_id FK, idempotency_key (NOT NULL), trigger_source, status, counters, error_summary, config_snapshot jsonb, imap_uid_from/to. extraction_runs includes correlation_id, invoice_id FK, ai_calls_made, confidence numeric(3,2), method extraction_method. Add indexes idx_sync_runs_email_time, idx_sync_runs_corr, idx_extraction_runs_invoice. Add partial unique index uq_sync_runs_idempotency ON sync_runs(connected_email_id, idempotency_key) for idempotency support.

**Files:**
- `supabase/migrations/20260615120500_create_runs_tables.sql`

**Acceptance:**
- Both tables created with FKs
- Idempotency uniqueness enforced per connected_email_id
- All listed indexes present

---

### `T-311` — Migration: register cron schedules for sync-dispatcher / sync-worker / cleanup

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-310`
**Blocks:** `T-334`
**Spec refs:** §4.4, §6.6

Create migration 20260615121000_cron_schedules.sql that idempotently registers the cron jobs from §4.4 + §6.6 relevant to P4: unibill-sync-dispatcher (1min), unibill-sync-worker (1min), and cleanup-pg-net-responses (daily 05:00). Use DO block to DELETE FROM cron.job WHERE jobname IN (...) then SELECT cron.schedule(...). Keep extraction-worker / capacity-* schedules out (owned by other phases) but document the slots in a comment.

**Files:**
- `supabase/migrations/20260615121000_cron_schedules.sql`

**Acceptance:**
- Re-running migration replaces existing jobs without duplicate rows
- cron.job contains exactly 3 expected job names after migration
- Migration comment lists future cron slots

---

### `T-312` — Migration: business COMMENT ON COLUMN for invoices, utility_parsers, connected_emails

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-301`, `T-304`, `T-201`
**Spec refs:** Appendix G, §5.4

Create migration 20260615121100_business_comments_ingestion.sql applying COMMENT ON COLUMN per Appendix G for: invoices.reference_period, amount_cents, barcode, pix_payload, pix_key, pix_txid, installation_id, source_message_id, idempotency_key, extracted_payload, payment_confirmation_source, pdf_archived_at; utility_parsers.version, body_must_contain and consumption_extractor (with MVP-NULL/roadmap note); connected_emails.last_processed_uid and consecutive_errors.

**Files:**
- `supabase/migrations/20260615121100_business_comments_ingestion.sql`

**Acceptance:**
- pg_description rows present for every listed column after apply
- Re-running migration produces same comments (idempotent)

---

### `T-313` — Seed: utility_parsers row for enel-sp (full regex set)

**Category:** `seed` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-304`
**Blocks:** `T-330`, `T-332`
**Spec refs:** §5.4

Create supabase/seeds/utility_parsers_enel_sp.sql inserting the enel-sp parser per §5.4 verbatim (sender_patterns, subject_patterns, body_must_contain, amount_regex, due_date_regex, due_date_format DD/MM/YYYY, barcode_regex 47-digit, pix_regex starting 00020126, reference_regex, installation_regex, customer_name_regex, service_address_regex). ON CONFLICT (utility_key, version) DO NOTHING. active=true.

**Files:**
- `supabase/seeds/utility_parsers_enel_sp.sql`

**Acceptance:**
- Seed inserts exactly one row when run on empty DB
- Re-running is a no-op
- Row visible to authenticated users via SELECT through RLS

---

### `T-314` — Seed: placeholder rows for sabesp / comgas / vivo parsers

**Category:** `seed` | **Size:** `XS` (~0.5h) | **Depth:** 2
**Depends on:** `T-304`
**Spec refs:** §5.4

Create supabase/seeds/utility_parsers_placeholders.sql inserting three placeholder rows (utility_key in {sabesp, comgas, vivo}, version=1, active=false, sender_patterns set to one clearly-bogus pattern, all regex columns NULL, notes='Placeholder — populate from real fixtures before activating'). active=false ensures the worker won't match. ON CONFLICT (utility_key, version) DO NOTHING.

**Files:**
- `supabase/seeds/utility_parsers_placeholders.sql`

**Acceptance:**
- Three rows present with active=false after seed
- Worker query (active=true) returns 0 of these

---

### `T-317` — _shared/ helper: withIdempotency

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-316`
**Blocks:** `T-325`
**Spec refs:** §4.2.1

Implement supabase/functions/_shared/idempotency.ts exposing withIdempotency(table, keyField, keyValue, body): Promise<{skipped, reason?}> per §4.2.1. Strategy: SELECT 1 FROM <table> WHERE <keyField>=<keyValue> LIMIT 1; if exists return {skipped:true, reason:'duplicate'}; otherwise run body() (caller is responsible for INSERTing the row with the key). Document that callers (sync-worker) typically pair this with INSERT INTO sync_runs(...idempotency_key...).

**Files:**
- `supabase/functions/_shared/idempotency.ts`
- `supabase/functions/_shared/idempotency.test.ts`

**Acceptance:**
- Returns skipped=true when a row with the key already exists
- Returns skipped=false and runs body() when no row exists
- Unit test using mock supabase client passes

---

### `T-318` — _shared/ helper: withCircuitBreaker (atomic RETURNING update)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-307`, `T-316`
**Blocks:** `T-319`, `T-324`, `T-325`, `T-326`
**Spec refs:** §4.2.1, §5.8

Implement supabase/functions/_shared/circuit.ts per §4.2.1 with getCircuitState and withCircuitBreaker<T>(resource_type, resource_key, fn). State transitions per spec: closed → open on failure threshold (delegated to caller config), open → half_open via atomic UPDATE circuit_breakers SET state='half_open' WHERE state='open' AND next_probe_at <= now() RETURNING * (atomicity per §4.2.1 last paragraph). Throws CircuitOpenError (defined in _shared/errors.ts) when open. On success in half_open: increment probes_succeeded; close after configurable threshold (hardcode 2 with TODO to switch to app_settings).

**Files:**
- `supabase/functions/_shared/circuit.ts`
- `supabase/functions/_shared/errors.ts`
- `supabase/functions/_shared/circuit.test.ts`

**Acceptance:**
- Open circuit blocks fn() and throws CircuitOpenError
- Atomic transition uses RETURNING to avoid concurrent probe races
- Unit tests cover closed→open, open→half_open, half_open→closed, half_open→open paths

---

### `T-320` — _shared/ helper: emitDomainEvent (tx-aware)

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-305`, `T-316`
**Blocks:** `T-325`, `T-326`, `T-327`
**Spec refs:** §4.2.1, §5.6, §6.7

Implement supabase/functions/_shared/events.ts per §4.2.1: emitDomainEvent(e: DomainEventInput, tx?) that inserts into domain_events with event_version = e.payload.version ?? 1, payload validated as {version, data}. If tx is provided, run within that transaction so sync-worker can do INSERT invoice + pgmq.send + emit in one TX. Centralize constants for P4 event_type strings (invoice.created, email.sync.auto_paused, email.sync.dead_lettered).

**Files:**
- `supabase/functions/_shared/events.ts`
- `supabase/functions/_shared/events.test.ts`

**Acceptance:**
- emitDomainEvent inserts row with correct event_type, aggregate_type, aggregate_id, correlation_id
- actor_type defaults respected: 'worker' allowed
- Unit test covers transactional and standalone modes via mock client

---

### `T-329` — pgTAP: dedupe constraints (file_hash + message_id)

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-301`
**Spec refs:** §5.3

Create supabase/tests/invoices_dedupe.test.sql verifying: (a) two INSERTs with same (household_id, file_hash) where deleted_at IS NULL: second fails with unique violation; (b) first INSERT then soft-delete (UPDATE deleted_at=now()), then INSERT same row succeeds; (c) same exercise for (connected_email_id, source_message_id) with source_message_id NOT NULL; (d) source_message_id IS NULL on multiple rows does NOT violate uniqueness; (e) file_hash format CHECK rejects uppercase / non-hex / wrong length.

**Files:**
- `supabase/tests/invoices_dedupe.test.sql`

**Acceptance:**
- All five scenarios pass under pgTAP
- Test file uses BEGIN; SELECT plan(N); ... ROLLBACK; idiom

---

### `T-309` — Migration: RLS policies for invoices, invoice_categories, utility_parsers, domain_events, sync_runs/extraction_runs

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-301`, `T-302`, `T-304`, `T-305`, `T-306`, `T-307`, `T-201`
**Blocks:** `T-328`, `T-330`
**Spec refs:** §5.11

Create migration 20260615120800_rls_ingestion.sql enabling RLS and policies per §5.11: invoices SELECT/INSERT/UPDATE/DELETE = member-of household; invoice_categories SELECT = member-of, write = admin-of; utility_parsers SELECT = authenticated only (NOT anon) + service_role write; domain_events SELECT = (household_id IN auth.households_of_user()) OR is_system_admin(), service_role-only write; sync_runs SELECT uses Pattern D cross-binding EXISTS join via connected_email_households; extraction_runs SELECT joins via invoice → household; service_role writes everywhere. circuit_breakers and rate_limit_buckets: RLS NOT enabled.

**Files:**
- `supabase/migrations/20260615120800_rls_ingestion.sql`

**Acceptance:**
- All listed RLS policies created using app.households_of_user / app.is_household_admin / app.is_system_admin helpers
- anon role cannot SELECT utility_parsers (pgTAP test covers this)
- Cross-tenant invoice SELECT blocked by RLS
- Cross-binding sync_runs SELECT works when user is in any bound household

---

### `T-319` — _shared/ helper: withRateLimit (token-bucket via rate_limit_buckets)

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-307`, `T-318`
**Blocks:** `T-325`, `T-326`
**Spec refs:** §4.2.1, §5.8

Implement supabase/functions/_shared/rate_limit.ts per §4.2.1: withRateLimit(resource_type, resource_key, limit, window) using rate_limit_buckets table. Window enum '1minute'|'1hour'|'1day'. Compute window_start floor; INSERT ... ON CONFLICT DO UPDATE SET count=count+1 RETURNING count; throw RateLimitError if count > limit. Old buckets are cleaned by 'unibill-rate-limit-cleanup' cron (§4.4) — not P4's responsibility.

**Files:**
- `supabase/functions/_shared/rate_limit.ts`
- `supabase/functions/_shared/rate_limit.test.ts`

**Acceptance:**
- Within-limit calls return without throw and increment count
- Call exceeding limit throws RateLimitError with limit/key fields populated
- Unit tests cover '1minute' and '1hour' window rollover

---

### `T-321` — _shared/ helper: withRunRow (sync_runs/extraction_runs lifecycle)

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-306`, `T-315`, `T-316`
**Blocks:** `T-325`, `T-331`
**Spec refs:** §4.2.1, §5.6, §6.5

Implement supabase/functions/_shared/runs.ts per §4.2.1: withRunRow<T>(table: 'sync_runs'|'extraction_runs'|'eviction_runs', initial: object, fn: (run_id)=>Promise<T>). Behavior: INSERT initial with status='running', started_at=now(); call fn(run_id); on success UPDATE status='success', finished_at=now(), duration_ms; on throw UPDATE status='failed' with error_summary=redactSecrets(err.message). Returns whatever fn returns.

**Files:**
- `supabase/functions/_shared/runs.ts`
- `supabase/functions/_shared/runs.test.ts`

**Acceptance:**
- INSERT happens before fn() runs and UPDATE happens after
- error_summary always goes through redactSecrets
- Unit tests cover success and failure paths via mock client

---

### `T-322` — _shared/ helper: resolveTargetHousehold (binding resolution)

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-203`
**Blocks:** `T-326`
**Spec refs:** §6.3

Implement supabase/functions/_shared/households.ts exporting resolveTargetHousehold(emailId): Promise<string> per §6.3. SELECT household_id, is_default FROM connected_email_households WHERE connected_email_id=$1 AND deleted_at IS NULL. Throws BindingNotFoundError if none. Returns the single binding's household. If multiple, returns is_default=true; throws AmbiguousBindingError if multiple and no default. Document roadmap routing rules hook.

**Files:**
- `supabase/functions/_shared/households.ts`
- `supabase/functions/_shared/households.test.ts`

**Acceptance:**
- Single binding returns that household_id
- Two bindings with default returns default
- Two bindings without default throws AmbiguousBindingError
- No bindings throws BindingNotFoundError
- Unit tests cover all 4 paths

---

### `T-324` — Edge Function: sync-dispatcher (gates + batch select + enqueue)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-203`, `T-308`, `T-318`, `T-316`
**Spec refs:** §6.1, §6.2

Implement supabase/functions/sync-dispatcher/index.ts per §6.1 step 1-3. Validate Authorization: Bearer service_role (defense-in-depth per §6.6). Compose with withCorrelation. Steps: (1) snapshot relevant app_settings; (2) gate on features.ingestion_enabled — if false, return 200 {skipped:'ingestion_disabled'}; (3) SELECT id, email_address FROM connected_emails WHERE status='active' AND deleted_at IS NULL AND (last_sync_at IS NULL OR last_sync_at < now() - (sync.interval_minutes||' minutes')::interval) ORDER BY last_sync_at NULLS FIRST LIMIT sync.batch_size; (4) filter out those with circuit_breakers row open for (resource_type='imap', resource_key=email_address); (5) for each, pgmq.send('email_sync_queue', {connected_email_id, idempotency_key: connected_email_id||':'||now_minute_floor, correlation_id}). Return {enqueued:int}.

**Files:**
- `supabase/functions/sync-dispatcher/index.ts`
- `supabase/functions/sync-dispatcher/sync-dispatcher.test.ts`

**Acceptance:**
- Function rejects request without Bearer service_role with 401
- Returns {skipped:'ingestion_disabled'} when feature flag false
- Enqueues at most batch_size messages per invocation
- Open-circuit emails excluded
- Deno test with mock supabase client passes

---

### `T-332` — pgTAP: enel-sp regex fixtures

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-313`
**Spec refs:** §5.4

Create supabase/tests/parsers/enel_sp.test.sql with pre-extracted text fixtures (NOT binary PDFs — LGPD per §5.4) embedded as text literals representing typical Enel SP invoice text. For each fixture, run amount_regex/due_date_regex/barcode_regex/pix_regex/reference_regex/installation_regex/customer_name_regex/service_address_regex via SELECT regexp_match(...) and assert expected captures. Also assert sender_patterns and subject_patterns match sample From/Subject strings (and reject false positives).

**Files:**
- `supabase/tests/parsers/enel_sp.test.sql`

**Acceptance:**
- At least 3 distinct fixture texts covered
- Every regex column tested with at least one positive and one negative case
- No real customer data — synthetic / sanitized text only

---

### `T-334` — pgTAP: cron jobs registered (sync-dispatcher / sync-worker / cleanup)

**Category:** `test` | **Size:** `XS` (~0.5h) | **Depth:** 3
**Depends on:** `T-311`
**Spec refs:** §6.6

Create supabase/tests/cron_jobs.test.sql asserting the 3 expected cron jobs (unibill-sync-dispatcher, unibill-sync-worker, cleanup-pg-net-responses) exist in cron.job with the expected schedule strings ('* * * * *' for the workers, '0 5 * * *' for cleanup). Verifies that T-311 migration ran and that no duplicate rows exist per jobname.

**Files:**
- `supabase/tests/cron_jobs.test.sql`

**Acceptance:**
- pgTAP test asserts exactly 1 row per jobname in cron.job
- Schedule strings match expectations
- Test green in CI

---

### `T-326` — Edge Function: sync-worker — doImapFetch (imapflow + dedupe + transactional insert)

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 4
**Depends on:** `T-203`, `T-308`, `T-301`, `T-305`, `T-315`, `T-318`, `T-319`, `T-320`, `T-322`, `T-323`
**Blocks:** `T-325`, `T-333`
**Spec refs:** §6.3, §6.4, §6.5

Implement supabase/functions/sync-worker/imap.ts exporting doImapFetch({connected_email_id, correlation_id, run_id}) per §6.4. Steps: resolve household via T-322; vault.decrypt app_password into local variable; connect ImapFlow with logger:false, emitLogs:false, rejectUnauthorized:true; lock INBOX; compute since UID (last_processed_uid or earliestUidInLookback covering sync.first_sync_lookback_days if last_processed_uid is NULL, else sync.lookback_days); search uids; iterate respecting sync.fetch_max_runtime_ms; for each uid: fetchOne envelope+bodyStructure+internalDate+headers; dedupe by source_message_id (SELECT 1 FROM invoices); for each pdf part via findPdfParts (limit by sync.attachment_max_per_message): download, validate magic bytes, sha256; dedupe by file_hash within household; storage.upload to household-{uuid}/{YYYY-MM}/{uuid}.pdf; BEGIN TX → INSERT invoices (status='queued', all fields including source_sender/source_subject/source_received_at/source_uid, idempotency_key=sha256(connected_email_id+':'+message_id+':'+file_hash)), pgmq.send('invoice_queue', {invoice_id, household_id, correlation_id, attempt:1}), emitDomainEvent({type:'invoice.created', aggregate_type:'invoice', aggregate_id:invoice_id, household_id, correlation_id, actor_type:'worker', payload:{version:1,data:{sender,subject,file_size_bytes}}}); commit; UPDATE connected_emails.last_processed_uid=uid (incremental, not batch). finally: password=null; client.logout(). Return counters {messages_seen, invoices_created, duplicates_skipped, errors_count}.

**Files:**
- `supabase/functions/sync-worker/imap.ts`
- `supabase/functions/sync-worker/imap.test.ts`

**Acceptance:**
- imapflow constructed with logger:false + emitLogs:false
- Magic-byte check rejects non-%PDF buffers
- Dedupe by source_message_id and by (household,file_hash) prevents duplicate invoices
- INSERT/pgmq.send/domain_event happen in the SAME transaction (assert via mock)
- last_processed_uid updated incrementally per uid
- client.logout() called in finally even on error path
- password reference nulled in finally
- Counters returned in result
- Deno tests with mocked imapflow + mocked Storage + mocked Supabase client cover happy path, dedupe-by-message-id, dedupe-by-file-hash, magic-byte rejection, runtime-cap exit

---

### `T-328` — pgTAP: invoices RLS cross-tenant tests

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-309`
**Spec refs:** §5.11, §12.2

Create supabase/tests/rls/invoices.test.sql per §5.11/§12.2. Setup: two households H1, H2; users U1∈H1, U2∈H2; create one invoice in H1 owned by U1. Assertions: SELECT as U1 sees 1 row; SELECT as U2 sees 0; INSERT as U2 into H1 fails; UPDATE as U2 on H1 invoice fails; DELETE as U2 fails; sys admin sees both (via JWT claim app_metadata.is_system_admin=true). Also assert soft-deleted invoice excluded for U1 by default queries. Use pgTAP plan() with expected counts.

**Files:**
- `supabase/tests/rls/invoices.test.sql`

**Acceptance:**
- pgTAP file exists at supabase/tests/rls/invoices.test.sql
- All planned assertions pass when run via supabase test
- Cross-tenant violation cases each have their own assertion

---

### `T-330` — pgTAP: utility_parsers RLS (anon denied; authenticated allowed)

**Category:** `test` | **Size:** `S` (~2h) | **Depth:** 4
**Depends on:** `T-309`, `T-313`
**Spec refs:** §5.11

Create supabase/tests/rls/utility_parsers.test.sql asserting per §5.11: SET ROLE anon → SELECT denied (or returns 0 rows); SET ROLE authenticated with valid JWT → SELECT returns seeded rows; INSERT/UPDATE/DELETE as authenticated denied; service_role can write.

**Files:**
- `supabase/tests/rls/utility_parsers.test.sql`

**Acceptance:**
- anon receives 0 rows or permission denied
- authenticated can SELECT but cannot mutate
- Test runs cleanly in supabase test

---

### `T-325` — Edge Function: sync-worker — outer loop + composition + DLQ

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-308`, `T-316`, `T-317`, `T-318`, `T-319`, `T-321`, `T-320`, `T-326`
**Blocks:** `T-327`, `T-331`, `T-333`, `T-335`
**Spec refs:** §6.1, §6.4, §6.7

Implement supabase/functions/sync-worker/index.ts skeleton per §6.1: validate service_role bearer; withCorrelation; loop pgmq.read('email_sync_queue', vt=sync.visibility_timeout_s, count up to a small batch). For each message, processOne(msg) wraps: withIdempotency('sync_runs','idempotency_key', msg.idempotency_key, body=()=> withRunRow('sync_runs', {...}, run_id => withCircuitBreaker('imap', email_address, () => withRateLimit('imap_fetch', email_address, 60, '1minute', () => doImapFetch(...))))). On RateLimitError/CircuitOpenError: pgmq.set_vt with exponential backoff (sync.retry_base_s * 2^attempt, cap sync.retry_cap_s); after sync.max_retries → pgmq.send('email_sync_dlq', msg) + emit domain event 'email.sync.dead_lettered'. On generic error: same backoff path. On success: pgmq.delete(msg).

**Files:**
- `supabase/functions/sync-worker/index.ts`
- `supabase/functions/sync-worker/sync-worker.test.ts`

**Acceptance:**
- Auth rejected if not service_role bearer
- Idempotent: re-enqueuing same idempotency_key results in skipped run
- Backoff applied via pgmq.set_vt
- After max_retries the message reaches email_sync_dlq + domain event emitted
- Deno test covers the orchestration with mocked doImapFetch

---

### `T-327` — Edge Function: sync-worker — auto-pause on consecutive errors

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 6
**Depends on:** `T-325`, `T-320`, `T-315`
**Blocks:** `T-333`, `T-335`
**Spec refs:** §6.1, §6.7

In sync-worker's error handler (T-325), after a failed processOne attempt, atomically UPDATE connected_emails SET consecutive_errors=consecutive_errors+1, last_error=redactSecrets(err.message), last_error_at=now() WHERE id=...; SELECT the new value back; if >= sync.consecutive_error_threshold (default 5) UPDATE status='error', last_error='Auto-paused after consecutive failures' and emitDomainEvent({type:'email.sync.auto_paused', aggregate_type:'connected_email', aggregate_id, household_id (best-effort from binding), correlation_id, actor_type:'worker', payload:{version:1,data:{consecutive_errors}}}). On full successful processOne: UPDATE connected_emails SET consecutive_errors=0, last_sync_at=now(), last_error=null, last_error_at=null AND reset circuit_breaker row to closed (per §6.1 step j).

**Files:**
- `supabase/functions/sync-worker/auto_pause.ts`
- `supabase/functions/sync-worker/auto_pause.test.ts`

**Acceptance:**
- consecutive_errors increments on each failure
- Reaching threshold flips status='error' and emits 'email.sync.auto_paused' domain event exactly once
- Successful run resets consecutive_errors and circuit
- All persisted error strings go through redactSecrets
- Unit test covers transition at the threshold boundary

---

### `T-331` — Test: secret redaction never persisted in sync_runs/connected_emails/domain_events

**Category:** `test` | **Size:** `S` (~2h) | **Depth:** 6
**Depends on:** `T-315`, `T-321`, `T-325`
**Spec refs:** §6.5

Create supabase/functions/sync-worker/redact_integration.test.ts (Deno) per §6.5 last paragraph. Simulate a sync-worker failure path whose error message contains the actual seeded secrets (Gmail app password, IMAP LOGIN echo with password, Authorization Bearer, CPF and CNPJ). Capture the rows written to sync_runs (error_summary), connected_emails (last_error), and any domain_events payload. Assert NONE of the seeded secret strings appear in any captured value. Document in a header comment that this complements the application-side redaction defined in T-315.

**Files:**
- `supabase/functions/sync-worker/redact_integration.test.ts`

**Acceptance:**
- A failing path produces a sync_runs row whose error_summary does NOT contain any of the seeded secret patterns (CPF, CNPJ, app password, Bearer token, LOGIN echo)
- connected_emails.last_error also redacted
- Test included in CI

---

### `T-333` — Deno test: sync-worker happy + dedupe + DLQ + auto-pause integration

**Category:** `test` | **Size:** `L` (~12h) | **Depth:** 7
**Depends on:** `T-325`, `T-326`, `T-327`
**Spec refs:** §6.1, §6.4, §6.7

Create supabase/functions/sync-worker/integration.test.ts mocking ImapFlow, Supabase client, Storage, and pgmq.send. Scenarios: (1) happy path inserts 1 invoice + 1 pgmq message + 1 domain_event in a single TX; (2) message-id dedupe path skips insert; (3) file-hash dedupe within household skips insert; (4) processOne throws → backoff via pgmq.set_vt and consecutive_errors increments; (5) after threshold flips status='error' and emits 'email.sync.auto_paused'; (6) after sync.max_retries → message reaches email_sync_dlq + domain_event 'email.sync.dead_lettered'.

**Files:**
- `supabase/functions/sync-worker/integration.test.ts`
- `supabase/functions/sync-worker/test_utils.ts`

**Acceptance:**
- deno test passes all 6 scenarios
- Mocks assert transactional ordering (INSERT before pgmq.send before emit)
- No real network calls

---

### `T-335` — Doc: ingestion runbook section (auto-pause recovery + circuit reset + DLQ replay)

**Category:** `doc` | **Size:** `XS` (~0.5h) | **Depth:** 7
**Depends on:** `T-327`, `T-325`
**Spec refs:** §6.7, §11.3 runbook

Add a section to docs/runbook.md (or create it if absent) titled 'Sync auto-pause recovery' covering: how to inspect connected_emails.status='error', read last_error, reset consecutive_errors=0 and status='active' via SQL or admin UI; how to manually reset a circuit_breakers row (UPDATE state='closed', failure_count=0); and how to drain email_sync_dlq via pgmq.read + pgmq.send back to email_sync_queue. Cross-link to §6.7 and the runbook fragment inside §11.3.

**Files:**
- `docs/runbook.md`

**Acceptance:**
- docs/runbook.md contains the new section with executable SQL snippets
- Snippets reference real table/column names verified against migrations

---

## Phase P5 — Extraction Pipeline (4-layer, AI/OCR chains, breakers)

**Tasks:** 29

Phase P5 — Extraction Pipeline: build the extraction-worker Edge Function with the full 4-layer extraction chain (pdfjs → OCR API chain → regex per-utility → AI chain), adapter patterns for OCR and AI providers with per-provider and chain-level circuit breakers, deterministic confidence formula, needs_review/failed status transitions, manual re-extract endpoint and replay UI, Vault-stored API keys, deploy-time provider smoke tests, and full Deno + pgTAP test coverage.

**Phase done when:** extraction-worker processes invoice_queue messages end-to-end through all 4 layers; ai_calls + extraction_runs rows accurately capture every attempt; circuit_breakers for ai_provider/ocr_provider/ai_chain/ocr_chain transition correctly (closed↔open↔half_open) with hysteresis, exponential backoff, probe rotation, and quota_exceeded immediate-trip; invoices land in extracted/needs_review/failed per the §7.7 confidence formula; admin force re-extract and post-chain-close replay both work paced at 10/min; Deno unit tests cover each layer + classifyError + confidence formula and pgTAP covers circuit_breakers transitions; deploy aborts if any configured AI provider model returns 404 in smoke test; all secrets (OCR/AI API keys) live in Vault, never logged.

---

### `T-401` — Migration: extend ai_calls columns for OCR + chain state tracking

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 4
**Depends on:** `T-105`
**Blocks:** `T-402`
**Spec refs:** §5.6, §7.3, §7.5.1

Add columns to ai_calls so OCR providers and chain breaker observability work in the same table: `pages_processed int`, `chain_state_at_call text`, `is_probe boolean NOT NULL DEFAULT false`, `synthetic boolean NOT NULL DEFAULT false`. Update CHECK on `purpose` to include 'ocr' alongside 'extraction','categorization','chat'. Update CHECK on `status` to include 'invalid_response' and 'quota_exceeded' alongside existing values. Update indexes if needed (idx on (provider, called_at DESC) already covers OCR queries).

**Files:**
- `unibill-backend/supabase/migrations/2026XXXXXXXXXX_ai_calls_extend_for_ocr_and_chain.sql`

**Acceptance:**
- Migration file under supabase/migrations/ with timestamp prefix
- ai_calls.pages_processed exists (nullable int)
- ai_calls.chain_state_at_call, is_probe, synthetic columns exist
- purpose CHECK accepts 'ocr'; status CHECK accepts 'invalid_response' and 'quota_exceeded'
- Migration is idempotent (IF NOT EXISTS / DO blocks) so re-running on a partially-applied env is safe

---

### `T-402` — Seed app_settings for extraction config (layer thresholds, OCR + AI chains, breaker knobs)

**Category:** `seed` | **Size:** `M` (~5h) | **Depth:** 5
**Depends on:** `T-105`, `T-401`
**Blocks:** `T-403`, `T-404`, `T-411`, `T-417`
**Spec refs:** §7.2, §7.3, §7.5, §7.6, §7.7

Insert/upsert all extraction-related runtime configs from §7 into app_settings scope='global': extraction.layer1_min_chars=300, layer1_min_density=0.05; required_fields_minimum/_complete arrays; minimum_capture_min_pages=2; ocr_max_pages=4; ocr_timeout_ms=30000; ocr_chain=['ocr_space','google_vision']; ocr_space.* and google_vision.* (endpoint, language, daily_limit, engine/feature); ai.providers.extraction.chain=['gemini','groq']; ai.gemini.model, ai.groq.model (TBD-marker placeholder requiring deploy override), ai.openrouter.enabled=false, ai.timeout_ms=30000; per-provider daily_limit; ai.chain.* (auto_disable_enabled, window_sec, min_samples, failure_ratio, confirm_sec, quota_exceeded_immediate, invalid_response_counts, cooldown_sec, cooldown_max_sec, probe_max_total, probe_success_required, replay_batch_rate_per_minute, notify_on_open, notify_on_recovered, scope_lock); mirrored ocr.chain.* keys; extraction.confidence_threshold=0.85, needs_review_threshold=0.50, confidence_extraction_weight=0.7, confidence_ocr_weight=0.3. Vault api_key_secret_id fields stored as null and populated by T-403.

**Files:**
- `unibill-backend/supabase/migrations/2026XXXXXXXXXX_seed_extraction_app_settings.sql`
- `unibill-backend/supabase/functions/_shared/config.ts`

**Acceptance:**
- All ~35 config keys present in app_settings after migration run
- Seed is upsert-style (ON CONFLICT DO UPDATE) so re-running does not break manual overrides set after first run — uses DO NOTHING for keys that already exist
- ai.groq.model value is a clearly marked sentinel ('TBD_SET_AT_DEPLOY') so deploy smoke test (T-419) fails loudly if not overridden
- Helper config-reader util getConfig<T>(key, default) reads from app_settings with in-memory ~30s cache

---

### `T-403` — Vault setup for OCR + AI API keys with redaction helper

**Category:** `infra` | **Size:** `M` (~5h) | **Depth:** 6
**Depends on:** `T-402`
**Blocks:** `T-406`, `T-412`
**Spec refs:** §7.3 (Vault), §9.3, §6.5

Create vault entries for ocr_space_api_key, google_vision_api_key, gemini_api_key, groq_api_key, openrouter_api_key (latter inserted but referenced only when enabled). Wire app_settings.*.api_key_secret_id columns to the vault uuids via a single migration that does `INSERT INTO vault.secrets ... RETURNING id` then `UPDATE app_settings`. Extend `_shared/redact.ts` with patterns matching each provider's key shape (Gemini AIza..., Groq gsk_..., OpenRouter sk-or-..., OCR.space K..., Google Vision generic) so they are scrubbed from log output and ai_calls.error_summary. Provide a `getVaultSecret(secret_id)` helper used by all providers.

**Files:**
- `unibill-backend/supabase/migrations/2026XXXXXXXXXX_vault_setup_extraction_keys.sql`
- `unibill-backend/supabase/functions/_shared/vault.ts`
- `unibill-backend/supabase/functions/_shared/redact.ts`
- `unibill-backend/supabase/functions/_shared/redact.test.ts`

**Acceptance:**
- Vault entries created via migration (idempotent, only if not exists)
- app_settings entries reference real vault uuids after migration
- redactSecrets() unit-tested against fixture strings for each provider key shape
- getVaultSecret returns plaintext only in-process and caches with TTL <=60s
- Logging any string containing a provider key in tests results in redacted output

---

### `T-404` — Layer 1 implementation: pdfjs-dist native text extraction

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 6
**Depends on:** `T-402`
**Blocks:** `T-405`, `T-418`
**Spec refs:** §7.2

Implement `extractTextWithPdfjs(pdfBytes: Uint8Array): Promise<{ chars: number; pages: number; density: number; text: string }>` using `npm:pdfjs-dist` from Deno. Pages iterated, text concatenated, chars = total non-whitespace chars, density = chars / (pages * average_page_area_proxy). Honors extraction.layer1_min_chars / layer1_min_density to decide `needsOcr`. Returns deterministic output even on encrypted PDFs (catches errors, returns empty result so downstream Layer 2 runs).

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/layers/layer1_pdfjs.ts`
- `unibill-backend/supabase/functions/extraction-worker/layers/layer1_pdfjs.test.ts`
- `unibill-backend/supabase/functions/extraction-worker/fixtures/text_rich.pdf`
- `unibill-backend/supabase/functions/extraction-worker/fixtures/scanned_only.pdf`

**Acceptance:**
- Function works in Deno runtime against fixture PDFs in supabase/functions/extraction-worker/fixtures/
- Encrypted PDF returns chars=0 without throwing
- Multi-page PDF returns sum of all page chars
- Unit test covers: text-rich PDF (>=min_chars), scanned-image PDF (<min_chars), encrypted PDF, corrupt PDF

---

### `T-411` — Layer 3 implementation: regex per-utility (sender + body match → field regexes)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 6
**Depends on:** `T-402`
**Blocks:** `T-410`, `T-418`, `T-611`, `T-627`, `T-628`
**Spec refs:** §7.4, §5.4

Implement `runLayer3(text: string, sender: string|null, subject: string|null): Promise<{ matched: boolean; utility_key?: string; parser_version?: number; extracted: ExtractedFields; confidence: number }>`. Loads `utility_parsers WHERE active=true` (cached 60s). Match logic: parser matches when ANY `sender_patterns` regex matches sender OR ALL `body_must_contain` substrings appear in text (per §7.4 example). On match: applies amount_regex (parseAmount handles BR format '1.234,56' → cents bigint), due_date_regex + due_date_format (parseDate per format string), barcode_regex, pix_regex, reference_regex, installation_regex, customer_name_regex, service_address_regex. Computes confidence: complete=4/4 of (amount, due, barcode, pix) → 1.0; minimum=3/3 of required_fields_minimum → 0.85; below → confidence proportional to required_fields_minimum captured (and caller falls through to Layer 4).

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/layers/layer3_regex.ts`
- `unibill-backend/supabase/functions/extraction-worker/layers/layer3_regex.test.ts`
- `unibill-backend/supabase/functions/_shared/parse/amount.ts`
- `unibill-backend/supabase/functions/_shared/parse/date.ts`

**Acceptance:**
- Unit test seeds enel-sp parser fixture + sample text yielding all 4 fields → confidence 1.0
- Sample text missing pix_payload → confidence 0.85
- Sample text missing 2 fields → confidence < 0.85, returns matched=true with partial extracted
- parseAmount('R$ 1.234,56') === 123456n cents
- parseDate('15/06/2026','DD/MM/YYYY') === '2026-06-15'
- Worker IGNORES consumption_extractor column (MVP carve-out per §5.4)

---

### `T-415` — AiClient + OcrClient chain-level breaker: state machine with hysteresis, backoff, probe rotation

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 6
**Depends on:** `T-105`, `T-205`
**Blocks:** `T-416`, `T-421`, `T-423`, `T-427`
**Spec refs:** §7.6, §7.3 (ocr chain breaker), §4.2.1

Implement shared chain-breaker helper `withChainBreaker(chain_name: 'ai_chain'|'ocr_chain', resource_key: string, fn: (probeMode: boolean) => Promise<T>)`. Reads breaker row from circuit_breakers (resource_type=chain_name). State machine per §7.6: CLOSED → OPEN on Trigger A (window=ai.chain.window_sec, min_samples=ai.chain.min_samples, failure_ratio=ai.chain.failure_ratio, debounce=ai.chain.confirm_sec) OR Trigger B (any quota_exceeded immediate if ai.chain.quota_exceeded_immediate=true). OPEN → HALF_OPEN when now() >= next_probe_at. HALF_OPEN: dispatches 1 probe (is_probe=true on ai_calls), rotates provider chain (different provider each probe up to ai.chain.probe_max_total), success counter — needs ai.chain.probe_success_required consecutive successes to close. Re-open backoff doubles cooldown_sec each reopen_count, capped at cooldown_max_sec. invalid_response counted toward chain breaker when ai.chain.invalid_response_counts=true. Atomic UPDATE...RETURNING to avoid probe races (per §4.2.1).

**Files:**
- `unibill-backend/supabase/functions/_shared/chain_breaker.ts`
- `unibill-backend/supabase/functions/_shared/chain_breaker.test.ts`

**Acceptance:**
- Deno test simulates 6 consecutive failures within window → state=open, opened_at set, next_probe_at = now+cooldown_sec, reason captured
- Test for Trigger B: single quota_exceeded → state=open immediately when quota_exceeded_immediate=true
- Test HALF_OPEN: 1 probe sent (atomic CAS so concurrent invocations get exactly 1 probe per slot), probe_success_required successes → closed
- Probe rotation: probe N uses providers[N % chain.length]
- Re-open: reopen_count increments, cooldown_sec doubles (cap cooldown_max_sec)
- invalid_response counted in chain when invalid_response_counts=true but NOT in per-provider breaker (§7.5.1)
- Concurrent worker test: 5 parallel calls during HALF_OPEN → exactly 1 probe dispatched (UPDATE RETURNING guarantees)

---

### `T-417` — Confidence formula + status mapper (deterministic single source of truth)

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 6
**Depends on:** `T-402`
**Blocks:** `T-418`
**Spec refs:** §7.7

Implement `computeConfidenceAndStatus(input: { layer3, layer4?, ocr? }): { confidence_final: number; status: 'extracted'|'needs_review'|'failed'; needs_review_reason?: string; extraction_error?: string }` exactly per §7.7 pseudocode: layer_confidence = max(layer3.conf, layer4.conf) when layer4 ran else layer3.conf; extraction_confidence = min(layer_confidence, layer4.self_reported) when layer4 ran else layer_confidence; if ocr ran, confidence_final = extraction_confidence * extraction.confidence_extraction_weight + ocr.confidence * extraction.confidence_ocr_weight; apply thresholds extraction.confidence_threshold / extraction.needs_review_threshold for status, set needs_review_reason='low_confidence' or extraction_error='confidence_below_review_threshold'. Threshold values read from app_settings each call (deterministic but config-driven).

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/confidence.ts`
- `unibill-backend/supabase/functions/extraction-worker/confidence.test.ts`

**Acceptance:**
- Exhaustive table-driven Deno test covers each branch (layer3 only / layer3+layer4 / layer3+layer4+ocr / boundary at 0.85 / boundary at 0.50 / 0.49 → failed)
- Over-confident AI (self_reported=0.95 but layer4.conf=0.6) yields extraction_confidence=0.6 (min wins) — verified in test
- OCR weighting: with extraction_confidence=0.9, ocr=0.3 → 0.9*0.7+0.3*0.3 = 0.72 → needs_review
- Function is pure (no side effects) — easy to unit-test

---

### `T-405` — PDF page splitter for OCR layer (per-page bytes via pdfjs)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-404`
**Blocks:** `T-410`, `T-611`
**Spec refs:** §7.3 (early-exit, ocr_max_pages)

Implement `extractPdfPage(pdfBuffer: Uint8Array, pageNum: number): Promise<Uint8Array>` that yields a single-page PDF (or rasterized image bytes acceptable to OCR providers) so Layer 2 can iterate page-by-page with early exit. Use pdfjs-dist + pdf-lib (or native pdfjs page rendering) to build a 1-page PDF; if rasterization needed, render @150dpi to PNG inline (small enough for OCR APIs). Memoize the parsed source document across pages so we parse once.

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/layers/pdf_split.ts`
- `unibill-backend/supabase/functions/extraction-worker/layers/pdf_split.test.ts`

**Acceptance:**
- Returns valid per-page bytes accepted by both OcrSpaceProvider and GoogleVisionProvider in integration tests
- Throws clear PageNotFoundError when pageNum > pdf page count
- Memoization reduces wall time for 4-page PDF vs naive re-parse (benchmark in test)

---

### `T-406` — OcrProvider interface + adapter scaffolding + classifyError

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 7
**Depends on:** `T-403`
**Blocks:** `T-407`, `T-408`
**Spec refs:** §7.3, §7.5.1

Define `OcrProvider` interface (`name: string`, `ocrPdfPage(pdfPage: Uint8Array, ctx: CallContext): Promise<{ text: string; confidence: number; raw?: any }>`) and a shared `classifyOcrError(err): { status: string; tripsChain: boolean; tripsProvider: boolean }` mapping HTTP/network/timeout/parse errors per §7.5.1 (adapted for OCR — same categories: success, rate_limited, quota_exceeded (immediate chain trip), timeout, error, invalid_response). Include `CallContext = { correlation_id; invoice_id; household_id; page: number; }`.

**Files:**
- `unibill-backend/supabase/functions/_shared/ocr/types.ts`
- `unibill-backend/supabase/functions/_shared/ocr/classify_error.ts`
- `unibill-backend/supabase/functions/_shared/ocr/classify_error.test.ts`

**Acceptance:**
- Interface compiled and consumed by both OcrSpaceProvider and GoogleVisionProvider (T-407/T-408)
- classifyOcrError unit-tested with fixtures: 200+invalid JSON, 429, 402, 500, ETIMEDOUT, fetch reject, schema mismatch
- Returned object drives both per-provider and chain breaker counters correctly per spec table

---

### `T-412` — AiProvider interface + GeminiProvider with structured output (responseSchema)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-403`
**Blocks:** `T-413`, `T-416`
**Spec refs:** §7.5

Define `AiProvider` interface (`name`, `extractStructured(text, schema, ctx): Promise<{ data: any; self_reported_confidence: number; tokens: {prompt, completion}; raw_response: string }>`). Implement `GeminiProvider` calling `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `generationConfig.responseMimeType='application/json'`, `responseSchema` (Zod-to-JSON-Schema conversion of provided schema). Reads `ai.gemini.model` from app_settings (versioned id, hot-swappable). API key from vault. Honors `ai.timeout_ms` via AbortController. Surfaces tokens from `usageMetadata`.

**Files:**
- `unibill-backend/supabase/functions/_shared/ai/types.ts`
- `unibill-backend/supabase/functions/_shared/ai/providers/gemini.ts`
- `unibill-backend/supabase/functions/_shared/ai/providers/gemini.test.ts`
- `unibill-backend/supabase/functions/_shared/ai/zod_to_json_schema.ts`

**Acceptance:**
- Mocked-fetch test extracts {amount_cents, due_date, barcode, pix_payload, confidence} from a sample model response
- responseSchema includes 'confidence' field so model returns self_reported_confidence
- Zod validation on returned data; schema mismatch → throws InvalidResponseError (mapped to 'invalid_response' per §7.5.1)
- Model id read from app_settings, not hardcoded
- 404 from API surfaces error (used by deploy smoke test T-419)

---

### `T-423` — pgTAP: circuit_breakers state machine transitions (closed↔open↔half_open + backoff)

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-415`
**Spec refs:** §7.6, §5.8

pgTAP test suite covering circuit_breakers semantics enforced by T-415 helper, using the helper's SQL paths (or a stub SQL function that mirrors them). Cases: 1) initial closed; 2) record 6 failures in window → open with opened_at + next_probe_at; 3) next_probe_at past → transition to half_open via atomic UPDATE…RETURNING is single-row; 4) probe success counter increments; probe_success_required reached → closed, opened_at NULL, reopen_count preserved; 5) re-open after recovery → reopen_count++, cooldown_sec doubles capped at cooldown_max_sec; 6) Trigger B: single quota_exceeded → immediate open when quota_exceeded_immediate=true.

**Files:**
- `unibill-backend/supabase/tests/circuit_breakers.test.sql`

**Acceptance:**
- All 6 transitions assert with plan() — green run in supabase db tests
- Concurrent UPDATE test (LOCK + 2 parallel sessions) shows only 1 row returns from the half_open atomic update — race-free
- Backoff cap test: 8 reopens land at cooldown_max_sec
- pgTAP runs in CI via supabase test db

---

### `T-407` — OcrSpaceProvider implementation

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 8
**Depends on:** `T-406`
**Blocks:** `T-409`
**Spec refs:** §7.3

Implement `OcrSpaceProvider` calling `extraction.ocr_space.endpoint` with multipart form (file=pdfPage, language='por', OCREngine=2, isCreateSearchablePdf=false, scale=true). Reads api key via `getVaultSecret(extraction.ocr_space.api_key_secret_id)`. Returns {text, confidence}; confidence derived from OCR.space TextOverlay.Lines[*].Words[*].WordConfidence average (when overlay enabled — request with isOverlayRequired=true to get it). Honors AbortController with extraction.ocr_timeout_ms.

**Files:**
- `unibill-backend/supabase/functions/_shared/ocr/providers/ocr_space.ts`
- `unibill-backend/supabase/functions/_shared/ocr/providers/ocr_space.test.ts`

**Acceptance:**
- Live-fixture HTTP mock test (mock fetch) returns expected text + confidence
- Timeout aborts cleanly and surfaces 'timeout' via classifyOcrError
- 402/429 mapped correctly; api_key never appears in error_summary or logs (assert via redactSecrets)
- When OCR.space returns IsErroredOnProcessing=true, mapped to status='error' with message preserved (truncated)

---

### `T-408` — GoogleVisionProvider implementation

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 8
**Depends on:** `T-406`
**Blocks:** `T-409`
**Spec refs:** §7.3

Implement `GoogleVisionProvider` calling `extraction.google_vision.endpoint` with `images:annotate` body `{ requests: [{ image: {content: base64(pdfPage)}, features: [{type:'DOCUMENT_TEXT_DETECTION'}], imageContext: { languageHints: ['pt-BR'] } }] }`. Returns {text: fullTextAnnotation.text, confidence: avg of pages[*].confidence}. Honors timeout, vault api key.

**Files:**
- `unibill-backend/supabase/functions/_shared/ocr/providers/google_vision.ts`
- `unibill-backend/supabase/functions/_shared/ocr/providers/google_vision.test.ts`

**Acceptance:**
- Fixture HTTP mock test extracts text + confidence
- 402/429 mapped correctly
- Empty `responses[0].fullTextAnnotation` returns text='' with confidence=0 (not crash)
- api_key in URL query is redacted in logs

---

### `T-413` — GroqProvider implementation

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 8
**Depends on:** `T-412`
**Blocks:** `T-414`, `T-416`
**Spec refs:** §7.5

Implement `GroqProvider` calling `api.groq.com/openai/v1/chat/completions` with `response_format: { type: 'json_object' }` (Groq supports JSON mode). Reads `ai.groq.model` from app_settings — fails loudly with clear error if value is the 'TBD_SET_AT_DEPLOY' sentinel (forcing deploy-time configuration). Sends prompt template (T-414) with text + 'respond as JSON matching this schema: ...'. Parses message.content via Zod (same schema as Gemini). API key from vault.

**Files:**
- `unibill-backend/supabase/functions/_shared/ai/providers/groq.ts`
- `unibill-backend/supabase/functions/_shared/ai/providers/groq.test.ts`

**Acceptance:**
- Mocked-fetch test extracts expected structured output
- Throws GroqModelNotConfiguredError if model still set to sentinel
- 404 surfaces as error (consumed by smoke test T-419)
- Zod fail → InvalidResponseError
- api key never appears in logs or error_summary

---

### `T-409` — OcrClient: chain + per-provider breaker + rate limit + ai_calls logging

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 9
**Depends on:** `T-407`, `T-408`, `T-105`, `T-205`
**Blocks:** `T-410`
**Spec refs:** §7.3, §4.2.1

Implement `OcrClient.ocrPdfPage(pdfPage, ctx)` that iterates `extraction.ocr_chain` config, wraps each call in `withCircuitBreaker('ocr_provider', providerName, …)` and `withRateLimit('ocr_call', providerName, daily_limit, '1day')`. On success: logAiCall({purpose:'ocr', provider, status:'success', pages_processed:1, latency_ms, ...ctx}); on err: logAiCall with classified status + error_summary. After all providers fail, throws `NoOcrProviderAvailableError(chain, lastError)`. Honors `ocr.chain.*` breaker state via separate chain-level check (delegated to T-415).

**Files:**
- `unibill-backend/supabase/functions/_shared/ocr/client.ts`
- `unibill-backend/supabase/functions/_shared/ocr/client.test.ts`

**Acceptance:**
- Chain order respected (ocr_space tried before google_vision by default)
- If ocr_space provider breaker is OPEN, skipped without HTTP call; google_vision tried
- Each attempt produces an ai_calls row with provider/status/latency/correlation/invoice_id/pages_processed=1
- Tests with mocked providers cover: success-on-first, success-on-second-after-first-fails, all-fail-throws

---

### `T-414` — OpenRouterProvider (disabled by default) + prompt template registry with hot-swap

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 9
**Depends on:** `T-413`
**Blocks:** `T-416`
**Spec refs:** §7.5

Implement `OpenRouterProvider` (POST chat/completions OpenAI-compatible). Skipped if `ai.openrouter.enabled=false`. Create prompt template registry: prompts stored in `app_settings` under key `ai.prompts.extraction` (text), loaded by `AiClient` per call (cache TTL ~30s). Template variables: `{{utility_hint}}`, `{{text}}`, `{{schema_summary}}`. Default prompt seeded by migration. Add `ai.prompts.extraction_version` integer so changes are auditable in extraction_runs.config_snapshot. classifyAiError for OpenRouter mirrors per §7.5.1.

**Files:**
- `unibill-backend/supabase/functions/_shared/ai/providers/openrouter.ts`
- `unibill-backend/supabase/functions/_shared/ai/prompts.ts`
- `unibill-backend/supabase/functions/_shared/ai/prompts.test.ts`
- `unibill-backend/supabase/migrations/2026XXXXXXXXXX_seed_extraction_prompt.sql`

**Acceptance:**
- OpenRouterProvider not invoked when ai.openrouter.enabled=false (validated by test that asserts no fetch happens)
- Prompt template registry returns interpolated string; updating app_settings causes next call (after cache expiry) to use new text
- Migration seeds default extraction prompt + version=1
- config_snapshot stored in extraction_runs includes ai.prompts.extraction_version

---

### `T-410` — Layer 2 orchestrator with per-page early-exit

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 10
**Depends on:** `T-405`, `T-409`, `T-411`
**Blocks:** `T-418`
**Spec refs:** §7.3 (early-exit)

Implement `runLayer2(pdfBuffer, ctx): Promise<{ text: string; ocrConfidence: number; pages_ocred: number; early_exit_reason: string }>`. For page in 1..min(pdf.pages, ocr_max_pages): split page (T-405), call ocrClient.ocrPdfPage, accumulate text, run Layer 3 extract on accumulated text, check `required_fields_complete` (early-exit 'all_complete') or `required_fields_minimum && page >= minimum_capture_min_pages` (early-exit 'minimum_after_2_pages'). After loop, return 'max_pages_reached'. ocrConfidence = avg of returned per-page confidences.

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/layers/layer2_ocr.ts`
- `unibill-backend/supabase/functions/extraction-worker/layers/layer2_ocr.test.ts`

**Acceptance:**
- Early-exit 'all_complete' fires when all 4 required_fields_complete found after page 1
- Early-exit 'minimum_after_2_pages' fires when only minimum fields found and page>=2
- max_pages_reached fires on PDF with 6 pages and incomplete fields
- Test counts ai_calls inserted = pages_ocred
- ocrConfidence computed as arithmetic mean of per-page confidences

---

### `T-416` — AiClient: chain orchestration + ai_calls logging with chain_state_at_call

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 10
**Depends on:** `T-412`, `T-413`, `T-414`, `T-415`
**Blocks:** `T-418`, `T-419`, `T-426`
**Spec refs:** §7.5, §7.5.1, §7.6

Implement `AiClient.extractStructured(text, schema, ctx)`: 1) check chain breaker via T-415 wrapper, skip Layer 4 (throw ChainOpenError) if open and not probing; 2) iterate `ai.providers.extraction.chain` (omitting openrouter if disabled), each call wrapped in withCircuitBreaker('ai_provider', name) + withRateLimit('ai_call', name, daily_limit, '1day'); 3) log every attempt to ai_calls with chain_state_at_call=current chain breaker state, is_probe=propagated from chain_breaker, synthetic=false; 4) on all-fail throw NoProviderAvailableError. Includes classifyAiError per §7.5.1 table (success / rate_limited / quota_exceeded / error / timeout / invalid_response / circuit_open), respects per-provider vs chain differentiation.

**Files:**
- `unibill-backend/supabase/functions/_shared/ai/client.ts`
- `unibill-backend/supabase/functions/_shared/ai/client.test.ts`
- `unibill-backend/supabase/functions/_shared/ai/classify_error.ts`
- `unibill-backend/supabase/functions/_shared/ai/classify_error.test.ts`

**Acceptance:**
- Test: chain CLOSED + gemini success → 1 ai_calls row, no groq call
- Test: gemini 429 → groq success → 2 ai_calls rows, gemini status=rate_limited, groq status=success
- Test: gemini 402 (quota_exceeded) + chain.quota_exceeded_immediate=true → chain trips OPEN, throws ChainOpenError, only 1 ai_calls row
- Test: gemini invalid JSON → per-provider breaker NOT incremented, but chain failure counter incremented
- Test: chain OPEN at entry → throws ChainOpenError without provider calls; ai_calls row inserted with status='circuit_open', provider='__chain__'

---

### `T-418` — extraction-worker main: pgmq consumer + 4-layer orchestration + status writeback

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 11
**Depends on:** `T-404`, `T-410`, `T-411`, `T-416`, `T-417`, `T-205`
**Blocks:** `T-420`, `T-421`, `T-424`, `T-425`, `T-426`, `T-428`
**Spec refs:** §7.1, §7.8, §7.9, §4.3, §4.4

Implement `supabase/functions/extraction-worker/index.ts`: HTTP handler triggered by pg_cron (per §4.4). On each invocation: pgmq.read('invoice_queue', vt=90, qty=10); for each msg, withCorrelation + withRunRow('extraction_runs', {invoice_id}, …) { load invoice; load PDF bytes from Storage; run Layer1; if needsOcr → Layer2; runLayer3(text, sender, subject); if layer3.confidence < some threshold (e.g., < 0.85) and Layer4 not chain-open → Layer4 via AiClient; computeConfidenceAndStatus; UPDATE invoices SET status, extraction_method (pdfjs|ocr_api|regex|ai_fallback), extraction_confidence, extracted_at, extracted_payload (versioned per §7.8), utility_key, amount_cents, due_date, barcode, pix_payload, payee_name, etc.; emit domain_event invoice.extracted or invoice.needs_review or invoice.failed; pgmq.delete(msg) on success or non-retryable-fail, pgmq.archive after max_retries (msg goes to invoice_dlq). Honors `force=true` in msg payload (skip idempotency / replay even if invoice already extracted).

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/index.ts`
- `unibill-backend/supabase/functions/extraction-worker/orchestrator.ts`
- `unibill-backend/supabase/functions/extraction-worker/payload.ts`
- `unibill-backend/supabase/functions/extraction-worker/index.test.ts`

**Acceptance:**
- Integration test with seeded invoice (text-rich PDF, enel-sp parser): status='extracted', extraction_method='regex', confidence>=0.85, payload includes layer1/layer3 sections, layer2/layer4 absent
- Integration test scanned PDF: extraction_method='ocr_api' or 'ai_fallback', layer2 section present in payload
- Integration test ai_chain_open: invoice gets status='needs_review', needs_review_reason='ai_chain_open', msg ACKed (deleted from queue)
- Integration test force=true on already-extracted invoice: re-extracts, updates row
- Worker honors VT=90s by completing within budget or relinquishing
- extraction_runs row written with started_at/finished_at/duration_ms/status/method/ai_calls_made/confidence/config_snapshot
- domain_event emitted with matching aggregate_id and correlation_id

---

### `T-419` — Deploy-time AI provider smoke test (1-token call, abort on 404)

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 11
**Depends on:** `T-416`
**Blocks:** `T-429`
**Spec refs:** §7.5 (smoke test deploy), §11.5

Add CI/deploy script `scripts/smoke_test_ai_providers.ts` that reads `ai.providers.extraction.chain` from production app_settings (via service-role client), iterates configured providers, calls each with a 1-token prompt ('ping'), expects 200. On any non-200 (especially 404 for deprecated models), exits non-zero with descriptive error including provider name + model id. Records each call in ai_calls with synthetic=true so cost is attributable and excluded from quality metrics. Wired into CI deploy pipeline as gate before promoting Edge Functions to production.

**Files:**
- `unibill-backend/scripts/smoke_test_ai_providers.ts`
- `unibill-backend/.github/workflows/deploy.yml`

**Acceptance:**
- Script runs locally with prod-like env and validates real Gemini + Groq models
- Returns exit code 1 on any 404 with clear message: 'Provider X model Y not available (HTTP 404). Update ai.X.model in app_settings.'
- Inserts ai_calls rows with synthetic=true
- CI workflow (.github/workflows/deploy.yml) calls this script before `supabase functions deploy`
- Script honors ai.groq.model sentinel 'TBD_SET_AT_DEPLOY' as immediate fail

---

### `T-420` — Re-extract admin endpoint POST /admin/invoices/:id/reextract

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 12
**Depends on:** `T-418`
**Blocks:** `T-421`, `T-429`
**Spec refs:** §7.9

Implement Edge Function `admin-invoice-reextract` exposed at `/admin/invoices/:id/reextract` requiring `app.is_system_admin()=true` via JWT claim. Body `{ force?: boolean = true }`. Enqueues `{ invoice_id, force }` onto `invoice_queue` via pgmq.send. Returns `{ queued: true, msg_id }`. Emits domain_event `invoice.reextract_requested` with actor_user_id. Rate-limited (admin-side) 30/hour per user.

**Files:**
- `unibill-backend/supabase/functions/admin-invoice-reextract/index.ts`
- `unibill-backend/supabase/functions/admin-invoice-reextract/index.test.ts`

**Acceptance:**
- Non-admin call → 403
- Admin call → 200 with msg_id; subsequent extraction-worker run consumes msg
- force=true causes worker to skip idempotency (re-runs even when invoice.status='extracted')
- domain_event row inserted; reextract_requested event in domain_events
- Rate limit 30/hour returns 429 after exhausted

---

### `T-424` — Integration test: end-to-end extraction-worker with mocked OCR + AI providers

**Category:** `test` | **Size:** `L` (~12h) | **Depth:** 12
**Depends on:** `T-418`
**Spec refs:** §7

Spin up Deno test that boots extraction-worker against a local Supabase test instance with seeded utility_parsers, mocked HTTP servers for OCR.space + Google Vision + Gemini + Groq endpoints. Enqueue 5 invoices on invoice_queue (one per scenario: text-rich PDF → regex success, scanned PDF → OCR success + regex success, scanned PDF → OCR success + AI fallback, all-fail → status=failed, chain-open scenario → needs_review). Assert final invoice.status, extraction_method, ai_calls rows count and statuses, extraction_runs row, domain_events emitted, pgmq queue drained.

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/integration.test.ts`
- `unibill-backend/supabase/functions/extraction-worker/test_helpers/mock_providers.ts`
- `unibill-backend/supabase/functions/extraction-worker/test_helpers/seed_data.ts`

**Acceptance:**
- Test green in CI under 2 minutes
- Each of 5 scenarios verified with assertions on invoice row + ai_calls + extraction_runs + domain_events
- Mocks reset between scenarios (no state leakage)
- Covers idempotency: enqueuing same msg twice → second is no-op (force=false)
- Covers force=true path: invoice re-extracted overwrites prior values

---

### `T-425` — Wire extraction-worker into pg_cron + pg_net schedule

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 12
**Depends on:** `T-418`
**Spec refs:** §4.4, §6.6, §6.7

Migration adding `cron.schedule('unibill-extraction-worker', '* * * * *', $$ SELECT net.http_post(url := ..., headers := ..., body := '{}') $$)` per §4.4 / §6.6 wrapper pattern. Uses `app_settings.runtime.extraction_worker_url` to allow env switch. Honors auto-pause helper (§6.7) if extraction worker has 5+ consecutive failures: pause cron job and emit alert event. Includes admin-only SQL function `extraction_worker_resume()` to unpause.

**Files:**
- `unibill-backend/supabase/migrations/2026XXXXXXXXXX_schedule_extraction_worker.sql`
- `unibill-backend/supabase/tests/auto_pause.test.sql`

**Acceptance:**
- Migration creates cron job (idempotent — uses cron.unschedule before re-creating)
- Manual invocation of extraction_worker_resume() unschedules+reschedules
- Auto-pause path tested by injecting 5 consecutive failures in sync_runs/extraction_runs and verifying cron.unschedule called
- Wrapper logs to extraction_runs.config_snapshot what URL was called

---

### `T-426` — Failure→status mapping (classifyError table) consolidated unit tests

**Category:** `test` | **Size:** `S` (~2h) | **Depth:** 12
**Depends on:** `T-416`, `T-418`
**Spec refs:** §7.5.1

Create a single canonical Deno test file that drives `classifyAiError` and `classifyOcrError` through every row of the §7.5.1 table, asserts (ai_calls.status, tripsPerProviderBreaker, tripsChainBreaker) triple. Also tests the end-to-end behavior in extraction-worker: a synthetic 402 from gemini results in invoices.status='needs_review' with needs_review_reason='ai_chain_open' and chain breaker row state='open'. Acts as living documentation of the spec table.

**Files:**
- `unibill-backend/supabase/functions/_shared/ai/classify_error_spec_table.test.ts`
- `unibill-backend/supabase/functions/_shared/ocr/classify_error_spec_table.test.ts`

**Acceptance:**
- Every spec table row covered with a labeled test case
- Tests fail (with clear message) if classifyAiError mapping drifts from spec
- Adds JSDoc comment block in classify_error.ts pointing to §7.5.1 for traceability

---

### `T-428` — extracted_payload v1 schema validation + writer

**Category:** `edge_function` | **Size:** `S` (~2h) | **Depth:** 12
**Depends on:** `T-418`
**Spec refs:** §7.8

Implement TypeScript types + Zod schema for `extracted_payload` v1 per §7.8 ({version:1, data:{ method, raw_text_excerpt (first 500 chars), layer1:{chars,pages,density}, layer2?:{applied,duration_ms,pages_ocred,early_exit_reason}, layer3:{matched,utility_key,parser_version,confidence}, layer4?:{provider,model,confidence,tokens,self_reported_confidence}, extracted_fields:{...}, confidence_final}}). Writer in T-418 builds this object and validates with Zod before UPDATE. Migration adds JSON Schema validation CHECK constraint on invoices.extracted_payload (use jsonb_typeof checks for top-level shape; full validation in code).

**Files:**
- `unibill-backend/supabase/functions/extraction-worker/extracted_payload_schema.ts`
- `unibill-backend/supabase/functions/extraction-worker/extracted_payload_schema.test.ts`
- `unibill-backend/supabase/migrations/2026XXXXXXXXXX_invoices_payload_check.sql`

**Acceptance:**
- Zod schema accepts/rejects fixture payloads matching/violating spec
- Writer never produces payload missing `version` or `data.confidence_final`
- Unit test feeding all 4 layer outputs produces a valid payload that round-trips through DB
- DB CHECK constraint enforces version IN (1) and data IS NOT NULL

---

### `T-421` — Chain-close replay: ai.chain.replay_available event + admin endpoint POST /admin/replay-chain

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 13
**Depends on:** `T-415`, `T-418`, `T-420`
**Blocks:** `T-422`, `T-429`
**Spec refs:** §7.6 (replay), §7.3 (ocr chain replay)

When chain breaker transitions OPEN→CLOSED (in T-415), emit domain_event `ai.chain.replay_available` with payload `{ chain_name, eligible_count }` computed from `SELECT count(*) FROM invoices WHERE needs_review_reason IN ('ai_chain_open','ocr_chain_open') AND deleted_at IS NULL`. Implement Edge Function `admin-replay-chain` (POST /admin/replay-chain, body `{ chain_name }`) that finds those invoices and enqueues them onto invoice_queue paced at `ai.chain.replay_batch_rate_per_minute` (default 10/min) by spacing send timestamps OR using a `replay_pending` table consumed by a small pg_cron tick. Updates invoice.needs_review_reason→NULL when re-queued. Admin-only.

**Files:**
- `unibill-backend/supabase/functions/admin-replay-chain/index.ts`
- `unibill-backend/supabase/functions/admin-replay-chain/index.test.ts`
- `unibill-backend/supabase/migrations/2026XXXXXXXXXX_replay_pending_table.sql`

**Acceptance:**
- Closing the chain breaker after open emits exactly one ai.chain.replay_available event with accurate eligible_count
- POST /admin/replay-chain returns {queued_count, estimated_minutes}
- Replay rate observed at 10/min over a test with 30 invoices (takes ~3 minutes)
- Non-admin → 403
- Replay also covers ocr_chain_open invoices when chain_name='ocr_chain'

---

### `T-422` — Mobile feature: 'Re-tentar N faturas' admin banner + replay action

**Category:** `mobile_widget` | **Size:** `M` (~5h) | **Depth:** 14
**Depends on:** `T-421`
**Blocks:** `T-427`
**Spec refs:** §7.6 (admin UI)

In the Flutter app, add an admin-only banner in the Home/Invoices screen that subscribes (via Realtime) to ai.chain.replay_available events. Banner shows 'AI chain reaberta. N faturas aguardando re-tentativa' with action button 'Re-tentar N invoices'. Tap → calls POST /admin/replay-chain via Edge Function client, shows snackbar 'Iniciando replay de N faturas (~M minutos)'. Visible only when JWT claim is_system_admin=true. Includes 'Dismiss' action that hides banner locally for 24h.

**Files:**
- `unibill-mobile/lib/features/admin/presentation/widgets/chain_replay_banner.dart`
- `unibill-mobile/lib/features/admin/data/admin_replay_repository.dart`
- `unibill-mobile/test/features/admin/chain_replay_banner_test.dart`

**Acceptance:**
- Widget test: banner hidden when is_system_admin=false
- Widget test: banner appears when replay_available event arrives via Realtime mock
- Tap on 'Re-tentar' calls EdgeFunctionClient.post('/admin/replay-chain') once
- Snackbar shows estimated minutes returned from API
- Dismiss persists hide flag in SharedPreferences for 24h

---

### `T-427` — Admin UI: 'Force chain breaker' control + needs_review banner

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 15
**Depends on:** `T-415`, `T-422`
**Blocks:** `T-429`
**Spec refs:** §7.6, Runbooks §2

In the Flutter admin section, add a SystemHealth screen with: (a) current state of each chain breaker (ai_chain, ocr_chain) read from /admin/chain-status Edge Function; (b) button 'Forçar abrir' (with confirm dialog, runbook §2 link) calling /admin/chain-force endpoint to set state='open' with reason='manual_force'; (c) button 'Forçar fechar' to reset state='closed'; (d) per-invoice needs_review_reason filter on Invoices list ('ai_chain_open', 'ocr_chain_open', 'low_confidence'). Admin-only.

**Files:**
- `unibill-mobile/lib/features/admin/presentation/system_health_screen.dart`
- `unibill-mobile/lib/features/admin/data/chain_admin_repository.dart`
- `unibill-mobile/lib/features/invoices/presentation/widgets/needs_review_filter.dart`
- `unibill-backend/supabase/functions/admin-chain-status/index.ts`
- `unibill-backend/supabase/functions/admin-chain-force/index.ts`
- `unibill-mobile/test/features/admin/system_health_screen_test.dart`

**Acceptance:**
- Force-open updates breaker row + emits domain_event 'ai.chain.manual_force'
- Force-close requires confirm and adds reason='manual_close' to circuit_breakers.reason
- Invoices list filter chip 'needs_review: ai_chain_open' shows only matching invoices
- Non-admin user does not see SystemHealth screen route
- Widget tests for both buttons covering confirm flow

---

### `T-429` — Docs: Extraction pipeline runbook + chain breaker operations

**Category:** `doc` | **Size:** `S` (~2h) | **Depth:** 16
**Depends on:** `T-419`, `T-420`, `T-421`, `T-427`
**Spec refs:** §7, Runbooks §2

Write operational runbook in `docs/runbooks/extraction-pipeline.md` covering: (1) how to manually re-extract an invoice (admin endpoint + mobile button); (2) how to force-open/close a chain breaker (with example SQL fallback if mobile is down); (3) post-chain-recovery replay procedure with expected timings; (4) provider model deprecation playbook (Groq/Gemini): how to update ai.X.model in app_settings, run smoke test locally before changing prod, rollback procedure; (5) how to read ai_calls + extraction_runs for diagnosing low-confidence batches; (6) escalation thresholds for capacity-management cross-reference. Markdown only; references spec §7.x sections inline.

**Files:**
- `unibill-backend/docs/runbooks/extraction-pipeline.md`

**Acceptance:**
- Runbook covers all 6 procedures with exact SQL/CLI commands
- Cross-links to spec sections by anchor
- Includes worked example for each procedure with copy-paste-ready snippets
- Reviewed by user-as-operator (PR review check)

---

## Phase P6-P8 — Mobile App (Flutter) — Bootstrap, Feature Modules, Sys Admin, Infra

**Tasks:** 33

Build the Unibill Flutter mobile app following the VGV layered architecture with FeatureModule pattern (get_it scopes), go_router shell routes, drift offline cache, Bloc + freezed, custom_lint cross-feature enforcement, i18n (pt-BR + en), Material 3 light/dark theming with golden tests, full feature suite (auth, invoices, emails, categories, household, settings, sys_admin, notifications), opt-in telemetry with PII scrubbing, local notifications with snooze/dedupe, FeatureGate runtime flags, Realtime invoice subscription, and the matching backend pair endpoints `/telemetry/ingest` and `/config/resolve`.

**Phase done when:** Phase done when: (a) `flutter run` boots the app against Supabase Cloud, user can sign up, confirm email via custom-scheme deep link, create/join a household, list invoices, view detail with QR PIX + barcode + PDF, mark paid with undo, manage emails/categories/household/settings; (b) sys admin user (JWT claim) sees full /sys-admin/* surface with capacity/AI-chain/OCR-chain/events/eviction/admins/settings/telemetry screens; (c) telemetry is OFF by default, only POSTs after consent, PII scrubbed client + server; (d) local notifications fire D-3/D-1/D and dedupe across reinstall via Drift; (e) Realtime channel `household:<id>` delivers new invoices when flag on, with workmanager fallback; (f) `custom_lint` blocks cross-feature imports; (g) coverage thresholds met (auth 95, invoices/domain 95, bloc 90, lib 85); (h) golden tests cover core pages × (light, dark) × (pt, en); (i) `/telemetry/ingest` and `/config/resolve` Edge Functions deployed and CI green.

---

### `T-501` — Scaffold unibill-mobile Flutter app via Very Good CLI

**Category:** `config` | **Size:** `S` (~2h) | **Depth:** 0
**Blocks:** `T-502`, `T-504`, `T-533`
**Spec refs:** §3.2, §3.4, §8.1

Create the `unibill-mobile` repo using `very_good create flutter_app` template inside /home/fwh/Documents/workbench/unibill/. Pin Flutter SDK `>=3.27.0 <4.0.0`, Dart `>=3.5.0 <4.0.0`. Configure flavors `development`, `staging`, `production` with separate `main_*.dart` entrypoints. Add `applicationId` namespacing (`dev.unibill.app.{dev,stg,prod}`). Set up `.gitignore`, MIT/Apache-2.0 LICENSE, README, CODEOWNERS. Configure `analysis_options.yaml` with `very_good_analysis` baseline. Verify `flutter analyze` clean and default counter app boots with `flutter run --flavor development`.

**Files:**
- `unibill-mobile/pubspec.yaml`
- `unibill-mobile/analysis_options.yaml`
- `unibill-mobile/lib/main_development.dart`
- `unibill-mobile/lib/main_staging.dart`
- `unibill-mobile/lib/main_production.dart`
- `unibill-mobile/android/app/build.gradle.kts`
- `unibill-mobile/README.md`
- `unibill-mobile/LICENSE`

**Acceptance:**
- Repo created at /home/fwh/Documents/workbench/unibill/unibill-mobile/ with VGV layered structure
- pubspec.yaml pins Flutter >=3.27.0 <4.0.0 and Dart >=3.5.0 <4.0.0
- Three flavors run via `flutter run --flavor {development|staging|production}`
- very_good_analysis lint passes with 0 warnings
- LICENSE = Apache-2.0; README explains build/run/test

---

### `T-502` — Implement bootstrap.dart, app.dart, env config and core DI container

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 1
**Depends on:** `T-501`
**Blocks:** `T-503`, `T-505`, `T-507`, `T-508`
**Spec refs:** §3.2, §8.1, §8.3

Create `lib/bootstrap.dart` (handles runZonedGuarded, FlutterError.onError, PlatformDispatcher.onError piped into Telemetry; sets up Bloc.observer; calls `await Supabase.initialize()` with per-flavor URL/anon key from `--dart-define`). Create `lib/app.dart` with `MaterialApp.router`, theme delegates, locale resolution callback. Create `lib/core/config/env.dart` reading `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BUILD_FLAVOR` via `String.fromEnvironment`. Set up `lib/core/di/injector.dart` exposing global `GetIt sl` and `configureDependencies()` (injectable code-gen). Add `build_runner` deps. Document bootstrap order: env → Drift → SecureStorage → Supabase → Telemetry → FeatureModules → Router.

**Files:**
- `unibill-mobile/lib/bootstrap.dart`
- `unibill-mobile/lib/app.dart`
- `unibill-mobile/lib/core/config/env.dart`
- `unibill-mobile/lib/core/config/build_flavor.dart`
- `unibill-mobile/lib/core/di/injector.dart`
- `unibill-mobile/lib/core/di/injector.config.dart`
- `unibill-mobile/build.yaml`

**Acceptance:**
- bootstrap.dart wraps app in runZonedGuarded and pipes both error sinks through Telemetry
- env.dart values asserted non-empty at startup (Assertion on cold boot if missing)
- configureDependencies() generated via build_runner runs without errors
- App boots and reaches splash with Supabase initialized (verifiable via getit lookup)

---

### `T-504` — Build custom_lint plugin: no_cross_feature_imports rule

**Category:** `config` | **Size:** `M` (~5h) | **Depth:** 1
**Depends on:** `T-501`
**Blocks:** `T-533`
**Spec refs:** §8.2, §3.2

Create a Dart package `packages/unibill_lints/` exposing a `custom_lint` rule `no_cross_feature_imports` that flags any `import 'package:unibill_mobile/features/<a>/...'` from a file located under `lib/features/<b>/...` where `a != b`. Files in `lib/features/<x>/<x>_module.dart` may import from any feature (entry point allowed). Files under `lib/shared/` / `lib/core/` are exempt. Wire plugin into root `analysis_options.yaml` via `custom_lint`. Include README and unit tests using `lint_test`. Add a failing fixture and an allowed fixture proving the rule.

**Files:**
- `unibill-mobile/packages/unibill_lints/pubspec.yaml`
- `unibill-mobile/packages/unibill_lints/lib/unibill_lints.dart`
- `unibill-mobile/packages/unibill_lints/lib/src/no_cross_feature_imports.dart`
- `unibill-mobile/packages/unibill_lints/test/no_cross_feature_imports_test.dart`
- `unibill-mobile/analysis_options.yaml`

**Acceptance:**
- `flutter analyze` reports `no_cross_feature_imports` on an intentionally bad fixture
- Allowed fixture (within same feature, or from <x>_module.dart) passes
- CI step `flutter analyze --fatal-infos` blocks PRs that violate the rule
- README documents intent and how to suppress with `// ignore:` (forbidden except in <x>_module.dart)

---

### `T-503` — Define FeatureModule abstraction + FeatureScopeShell widget

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-502`
**Blocks:** `T-514`, `T-531`
**Spec refs:** §8.2

Create `lib/core/di/feature_module.dart` defining `abstract class FeatureModule { String get scopeName; void register(GetIt sl); void unregister(GetIt sl) => sl.popScopesTill(scopeName); List<RouteBase> get routes; }`. Create `lib/core/widgets/feature_scope_shell.dart` — a StatefulWidget that takes a `FeatureModule` and on `initState` calls `module.register(sl)`, on `dispose` calls `module.unregister(sl)`. Wires into go_router via `ShellRoute`. Provide `FeatureModuleRegistry` that aggregates all modules and exposes flattened `routes`. Add unit test ensuring register/unregister are symmetric and `pushNewScope` only happens once per mount.

**Files:**
- `unibill-mobile/lib/core/di/feature_module.dart`
- `unibill-mobile/lib/core/di/feature_module_registry.dart`
- `unibill-mobile/lib/core/widgets/feature_scope_shell.dart`
- `unibill-mobile/test/core/di/feature_module_test.dart`

**Acceptance:**
- FeatureModule abstract class matches spec signature exactly
- FeatureScopeShell registers on initState, unregisters on dispose, no leaks across remount
- Unit test verifies scope pop on unmount via `sl.isRegistered<T>()` checks
- Doc comment shows full code example mirroring spec §8.2

---

### `T-505` — Set up i18n (l10n.yaml, app_pt.arb template, app_en.arb) + locale resolution

**Category:** `mobile_feature` | **Size:** `S` (~2h) | **Depth:** 2
**Depends on:** `T-502`
**Blocks:** `T-506`, `T-514`
**Spec refs:** §8.4

Add `flutter_localizations` + `intl` deps. Create `l10n.yaml` pointing at `lib/l10n/arb/`, `template-arb-file: app_pt.arb`, `output-class: AppL10n`. Seed `app_pt.arb` (template, ~30 placeholder keys covering auth/invoices/needs_review/settings) and `app_en.arb` (translations). Wire `MaterialApp.router` with `localizationsDelegates: AppL10n.localizationsDelegates`, `supportedLocales: [Locale('pt'), Locale('en')]`, and `localeResolutionCallback` that prefers user override stored in `app_settings` scope=user key `ui.locale`, then device, then `pt`. Add `BuildContext.l10n` extension. Add golden test loading both locales.

**Files:**
- `unibill-mobile/l10n.yaml`
- `unibill-mobile/lib/l10n/arb/app_pt.arb`
- `unibill-mobile/lib/l10n/arb/app_en.arb`
- `unibill-mobile/lib/core/utils/build_context_extensions.dart`
- `unibill-mobile/lib/app.dart`

**Acceptance:**
- `flutter gen-l10n` produces AppL10n with no errors
- Locale resolution prefers user setting > device > pt fallback
- BuildContext.l10n returns AppL10n in widget tests for both locales
- Switching `ui.locale` from settings rebuilds MaterialApp and updates strings without restart

---

### `T-507` — Drift local DB schema + SecureStorage wrapper

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 2
**Depends on:** `T-502`
**Blocks:** `T-510`, `T-512`, `T-517`, `T-525`
**Spec refs:** §8.3, §3.2

Add `drift` + `drift_flutter` + `drift_dev`. Define `LocalDatabase` in `lib/core/storage/local_db.dart` with tables: `invoice_cache(id PK, household_id, payload_json, updated_at, etag)`, `category_cache`, `household_cache`, `connected_email_cache`, `notification_log(notification_id PK, sent_at, invoice_id, snoozed_until)`, `telemetry_outbox(id PK, payload_json, queued_at, retries)`, `kv_settings(key PK, value_json, scope, scope_id, ttl_expires_at)`. Configure schema versioning + migration test. Wrap `flutter_secure_storage` in `SecureStorageService` (auth tokens, vault metadata). Cache cap 50MB enforced via periodic prune (oldest payload first). Register both as singletons in DI.

**Files:**
- `unibill-mobile/lib/core/storage/local_db.dart`
- `unibill-mobile/lib/core/storage/local_db.g.dart`
- `unibill-mobile/lib/core/storage/secure_storage_service.dart`
- `unibill-mobile/lib/core/storage/cache_pruner.dart`
- `unibill-mobile/test/core/storage/local_db_test.dart`

**Acceptance:**
- `build_runner` generates LocalDatabase with no errors
- Schema migration test (v1 → v2 dummy) passes
- Prune job runs when total payload size > 50MB and keeps PDFs out (no PDFs cached per spec)
- SecureStorageService methods read/write/delete tested with mocktail

---

### `T-508` — Supabase + Edge Function HTTP clients (network layer)

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-502`
**Blocks:** `T-510`, `T-512`, `T-516`, `T-517`, `T-521`, `T-522`, `T-523`, `T-524`, `T-525`
**Spec refs:** §8.3, Appendix E

Create `lib/core/network/supabase_client.dart` exposing the typed `SupabaseClient` (DI). Create `EdgeFunctionClient` wrapper that: attaches Authorization header from current session, injects `x-correlation-id` (uuid v4 if absent), injects `x-client-version` from pubspec, supports timeout, parses standardized error envelopes (`{ error: { code, message, details? } }`) into typed `EdgeFunctionFailure`. Add automatic refresh-on-401 once. Add interceptor that on connectivity loss returns `OfflineFailure` immediately (via `connectivity_plus`). Unit tests with mock HTTP client cover success, 401 refresh, network failure, malformed body.

**Files:**
- `unibill-mobile/lib/core/network/supabase_client.dart`
- `unibill-mobile/lib/core/network/edge_function_client.dart`
- `unibill-mobile/lib/core/network/connectivity_service.dart`
- `unibill-mobile/lib/core/error/failures.dart`
- `unibill-mobile/test/core/network/edge_function_client_test.dart`

**Acceptance:**
- EdgeFunctionClient injects x-correlation-id when caller omits and propagates when present
- 401 triggers exactly one refresh attempt; second 401 surfaces AuthFailure
- Offline state short-circuits without HTTP attempt (>5 unit tests cover variants)
- Error envelope mapped to typed Failure hierarchy (EdgeFunctionFailure subclasses)

---

### `T-533` — CI: Flutter build + analyze + test + coverage thresholds + custom_lint

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-501`, `T-504`
**Spec refs:** §12.4, §3.2, §11.1

Add `.github/workflows/mobile.yml`: matrix on Flutter 3.27.x (stable). Steps: setup-flutter, `flutter pub get`, `dart run build_runner build --delete-conflicting-outputs`, `flutter analyze --fatal-infos`, `custom_lint`, `flutter test --coverage`, enforce per-file thresholds from `lib/features/auth/**: 95`, `lib/features/invoices/domain/**: 95`, `lib/features/**/presentation/bloc/**: 90`, `lib/**: 85` (use `test_cov_console` or `very_good test --coverage --min-coverage`). Exclude `**/*.g.dart`, `**/*.freezed.dart`, `lib/**/dto.dart`. Build APK release for `development` flavor as artifact. Cache pub deps. Upload coverage to Codecov optional.

**Files:**
- `unibill-mobile/.github/workflows/mobile.yml`
- `unibill-mobile/coverage_helper.dart`
- `unibill-mobile/test/coverage_thresholds.yaml`

**Acceptance:**
- CI fails when any per-file threshold not met
- Custom lint job fails on cross-feature import
- Release APK artifact uploaded on each push to main
- Build runs < 8 min on standard runner with deps cached

---

### `T-506` — Material 3 theme (light + dark) with ThemeExtension tokens

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-505`
**Blocks:** `T-509`, `T-524`
**Spec refs:** §8.8, §12.3

Create `lib/core/theme/app_theme.dart` exposing `ThemeData light()` and `ThemeData dark()` using Material 3 ColorScheme.fromSeed (Unibill brand color), TextTheme via Google Fonts (Inter), shape tokens, density. Add ThemeExtension `UnibillSpacing` (xs/s/m/l/xl) and `UnibillSemanticColors` (success/warning/danger/info — overdue/paid/needsReview). Theme mode persisted in `app_settings` scope=user `ui.theme` and read via `ThemeCubit` from get_it. Defaults to `ThemeMode.system`. Add golden test scaffolding for `home_page`, `invoice_detail_page`, `settings_page` × {light, dark} × {pt, en} using `golden_toolkit`.

**Files:**
- `unibill-mobile/lib/core/theme/app_theme.dart`
- `unibill-mobile/lib/core/theme/unibill_spacing.dart`
- `unibill-mobile/lib/core/theme/unibill_semantic_colors.dart`
- `unibill-mobile/lib/core/theme/theme_cubit.dart`
- `unibill-mobile/test/core/theme/app_theme_golden_test.dart`

**Acceptance:**
- light() and dark() return ThemeData with useMaterial3=true and full ColorScheme
- ThemeCubit emits new ThemeMode on settings change; MaterialApp.themeMode wired
- Golden test infrastructure runs `flutter test --update-goldens` cleanly
- Semantic color tokens used by `StatusChip` widget (not raw Colors.red)

---

### `T-510` — FeatureGate widget + FeatureFlags client with 30s TTL cache

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-508`, `T-507`
**Blocks:** `T-511`, `T-525`, `T-526`, `T-527`
**Spec refs:** §8.7, Appendix E /config/resolve

Implement `lib/core/feature_flags/feature_flags.dart` exposing `Future<T> get<T>(String key, T defaultValue)` that hits `GET /config/resolve?key=...` via EdgeFunctionClient, caches result in-memory + Drift `kv_settings` with TTL 30s, falls back to default on error/offline. Build `FeatureGate(flag: String, child: Widget, fallback: Widget = SizedBox.shrink())` widget that uses FutureBuilder + cached value; rebuilds when invalidate broadcast. Add `FeatureFlags.invalidate(key)` and global `invalidateAll()`. Unit tests cover cache hit, cache expiry, offline default, type coercion (bool/int/string).

**Files:**
- `unibill-mobile/lib/core/feature_flags/feature_flags.dart`
- `unibill-mobile/lib/core/widgets/feature_gate.dart`
- `unibill-mobile/test/core/feature_flags/feature_flags_test.dart`

**Acceptance:**
- Get returns default for unknown keys without throwing
- Cache evicts after 30s and refetches
- FeatureGate renders fallback while loading and child once flag known
- FeatureFlags.invalidate(key) triggers refetch on next access; broadcast updates mounted FeatureGates

---

### `T-512` — Telemetry client with consent gate, PII scrubbing, offline queue

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 3
**Depends on:** `T-507`, `T-508`
**Blocks:** `T-513`, `T-524`
**Spec refs:** §8.9, BR-018

Implement `lib/core/telemetry/telemetry.dart` per spec §8.9: `Telemetry.error(err, st, {screen})`, `Telemetry.event(name, props)`. Gate on `consentService.hasActive('telemetry')` — if false, drop silently (no log). Scrub PII via `_scrubPII` regex set: email, CPF, CNPJ, /Users/x, /home/x, 16+ digit numbers, and stack frames with file paths. Truncate payload to 8KB, mark `_truncated: true`. Enqueue in Drift `telemetry_outbox`. Flush on connectivity online via batch POST `/telemetry/ingest` (max 50 events). Backoff on 429. Implement `UnibillBlocObserver extends BlocObserver` that pipes onError → Telemetry.error. Tests cover gate-off drop, scrub correctness for each regex, truncation, queue+flush, retry on 429.

**Files:**
- `unibill-mobile/lib/core/telemetry/telemetry.dart`
- `unibill-mobile/lib/core/telemetry/pii_scrubber.dart`
- `unibill-mobile/lib/core/telemetry/unibill_bloc_observer.dart`
- `unibill-mobile/lib/core/telemetry/consent_service.dart`
- `unibill-mobile/test/core/telemetry/pii_scrubber_test.dart`
- `unibill-mobile/test/core/telemetry/telemetry_queue_test.dart`

**Acceptance:**
- When consent OFF, queue length stays 0 across 100 simulated errors
- PII scrubbing test verifies all 6 patterns (email/CPF/CNPJ/Users/home/long-number)
- Payloads > 8KB truncated and flagged with `_truncated:true`
- On reconnect, queue flushes in batches <= 50, respects 429 backoff
- BlocObserver hookup pipes uncaught errors automatically

---

### `T-514` — go_router setup with global auth guard + ShellRoute composition

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-503`, `T-505`
**Blocks:** `T-515`, `T-517`, `T-527`
**Spec refs:** §8.3, §8.5, §9.2

Create `lib/core/router/app_router.dart` building `GoRouter` with: global `redirect` checking Supabase session — unauthenticated users go to `/auth/welcome` (except whitelisted auth routes); authenticated users with no household membership go to `/auth/onboarding`. Root `ShellRoute` wraps app-shell (bottom nav for Invoices/Needs Review/Settings on mobile sizes). Sys-admin routes nested under a `ShellRoute` that registers `SysAdminModule` only when JWT claim `is_system_admin=true`. Compose feature routes from `FeatureModuleRegistry.routes`. Add `errorBuilder` showing localized 404 page. Listen to Supabase auth changes via `refreshListenable`. Unit tests cover redirect matrix (signed-out, signed-in-no-household, signed-in-with-household, sys-admin).

**Files:**
- `unibill-mobile/lib/core/router/app_router.dart`
- `unibill-mobile/lib/core/router/redirects.dart`
- `unibill-mobile/lib/core/widgets/app_shell.dart`
- `unibill-mobile/test/core/router/app_router_test.dart`

**Acceptance:**
- Redirect matrix: each combination produces correct destination (tested)
- Deep link unibill://auth/callback resolves to AuthCallbackRedirect logic
- Sys-admin routes only accessible when JWT claim true; otherwise 403 page
- FeatureModuleRegistry.routes are composed dynamically (no hardcoded list)

---

### `T-509` — UndoSnack widget + reusable undo orchestration

**Category:** `mobile_widget` | **Size:** `S` (~2h) | **Depth:** 4
**Depends on:** `T-506`
**Blocks:** `T-515`, `T-518`, `T-521`, `T-522`, `T-523`
**Spec refs:** §8.6

Implement `lib/core/widgets/undo_snack.dart` exposing `UndoSnack.show({context, message, action, undo, duration: Duration(seconds: 10)})`. Optimistic: invokes `action()` immediately (synchronous bloc.add), shows a SnackBar with 'Desfazer'/'Undo' label for 10s, on tap invokes `undo()`. Dismiss must cancel any pending follow-up animation. Track via `ScaffoldMessenger.maybeOf` safely. Accessibility: announce via SemanticsService.announce. Widget test covers happy path (no undo fires action), undo path (undo fires, action reverted), and dismiss-while-snackbar pattern. Reuse from invoices (mark paid/unpaid, delete) and categories (delete).

**Files:**
- `unibill-mobile/lib/core/widgets/undo_snack.dart`
- `unibill-mobile/test/core/widgets/undo_snack_test.dart`

**Acceptance:**
- Signature matches spec example exactly
- Action fires immediately; undo only fires on user tap within 10s
- Accessibility announcement happens once
- Widget tests cover all three paths and pass golden

---

### `T-511` — Edge Function /config/resolve — backend pair

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-510`
**Spec refs:** §5.5, Appendix E /config/resolve, Appendix B

Implement `supabase/functions/config-resolve/index.ts`: GET endpoint, JWT auth required. Query param `key`. Resolves cascade user > household > global > default via SQL function `app.resolve_setting(user_id, key, current_household_id)` reading `app_settings`. Returns `{ value: jsonb, scope_resolved_from: 'user'|'household'|'global'|'default' }`. 404 if key not in canonical list. Reads current household from `app_settings` scope=user `ui.current_household_id` (or first membership if unset). Add deno test with mocked supabase client. Add migration creating the SQL helper if missing.

**Files:**
- `unibill-backend/supabase/functions/config-resolve/index.ts`
- `unibill-backend/supabase/functions/config-resolve/index.test.ts`
- `unibill-backend/supabase/migrations/xxx_create_resolve_setting_fn.sql`

**Acceptance:**
- GET /config/resolve?key=ui.theme returns user override when present
- Returns scope_resolved_from = 'default' when no row exists at any scope but key is canonical
- 404 with code='unknown_key' for keys not in canonical list
- Deno test covers all 4 scope levels + 401 + 404

---

### `T-513` — Edge Function /telemetry/ingest — backend pair

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-512`
**Spec refs:** §8.9, Appendix E /telemetry/ingest, BR-018

Implement `supabase/functions/telemetry-ingest/index.ts`: POST endpoint, JWT auth. Zod body `{ events: { event_type: string, severity: 'debug'|'info'|'warn'|'error', payload: jsonb, screen?: string, occurred_at: timestamptz }[] }`. Constraints: max 50 events, each <= 8KB (reject 413). Verify active consent via SELECT from `consent_log` (must have row with `granted=true` and no later revoke for purpose='telemetry') — if missing, return 403 `consent_required`. Apply backend `redactSecrets(payload)` per §6.5 helper. INSERT rows into `client_telemetry` with `actor_user_id = auth.uid()`. Rate limit per-user via `rate_limit_buckets`: 100 events/minute → 429. Return `{ ingested: N }`. Deno test covers all paths.

**Files:**
- `unibill-backend/supabase/functions/telemetry-ingest/index.ts`
- `unibill-backend/supabase/functions/telemetry-ingest/index.test.ts`

**Acceptance:**
- POST 50 events with consent → 200 { ingested: 50 } and rows persisted
- Without consent → 403 consent_required, no rows inserted
- Event > 8KB → 413; > 50 events → 422
- Rate limit triggers 429 after 100 events/min for same user
- redactSecrets applied to nested payload values (test with secret string)

---

### `T-517` — invoices_module: list page with month grouping, totals, needs_review banner

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 4
**Depends on:** `T-514`, `T-507`, `T-508`
**Blocks:** `T-518`, `T-520`, `T-532`
**Spec refs:** §8.5, §5.3, §8.3

Build `features/invoices/`: data (InvoiceRemoteDataSource → supabase table `invoices`, InvoiceLocalDataSource → drift `invoice_cache`), domain (Invoice freezed entity, ListInvoices usecase with month filter), presentation (`InvoiceListPage`). Display invoices grouped by reference month, show monthly total + paid subset + remaining; sticky `NeedsReviewBanner` when any invoice in current household has `status='needs_review'` (tap → `/needs-review`). Implement stale-while-revalidate: render from drift instantly, kick remote fetch, update on success. Pull-to-refresh. Pagination by month chunks. Bloc tests, widget tests with mock data, golden for both populated and empty states.

**Files:**
- `unibill-mobile/lib/features/invoices/invoices_module.dart`
- `unibill-mobile/lib/features/invoices/data/invoice_remote_data_source.dart`
- `unibill-mobile/lib/features/invoices/data/invoice_local_data_source.dart`
- `unibill-mobile/lib/features/invoices/data/invoice_repository_impl.dart`
- `unibill-mobile/lib/features/invoices/domain/entities/invoice.dart`
- `unibill-mobile/lib/features/invoices/domain/usecases/list_invoices_usecase.dart`
- `unibill-mobile/lib/features/invoices/presentation/invoice_list_page.dart`
- `unibill-mobile/lib/features/invoices/presentation/bloc/invoice_list_bloc.dart`
- `unibill-mobile/lib/features/invoices/presentation/widgets/needs_review_banner.dart`
- `unibill-mobile/test/features/invoices/**`

**Acceptance:**
- Initial render < 50ms via cache; remote refresh updates list when newer
- Month grouping handles invoices crossing months by `reference_period` text rendering
- NeedsReviewBanner appears only when count > 0, tap navigates to /needs-review
- Pull-to-refresh debounced; respects offline (shows last sync time)
- Golden tests pass for empty, populated, light+dark, pt+en

---

### `T-524` — settings_module: preferences, privacy, locale, theme, telemetry opt-in

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 4
**Depends on:** `T-508`, `T-512`, `T-506`
**Spec refs:** §8.5, §8.8, §8.9, Appendix E /privacy/*

Build `features/settings/`. `/settings` shows: Conta (display_name, email, sign out, 'Apagar conta' → calls `DELETE /privacy/my-account` with email confirmation modal), Aparência (theme toggle system/light/dark; locale dropdown pt/en), Notificações (delegates to notifications_module pref editor), Privacidade ('Permitir telemetria' switch default OFF wired to consentService; 'Ver últimos eventos enviados' opens local list of last 50 from Drift telemetry_outbox; 'Revogar e apagar' revokes + DELETE remote; 'Exportar meus dados' → `POST /privacy/export-my-data` with rate-limit feedback). Persist user settings in `app_settings` scope=user. Bloc + widget tests cover toggles and irreversible actions confirmations.

**Files:**
- `unibill-mobile/lib/features/settings/settings_module.dart`
- `unibill-mobile/lib/features/settings/**`
- `unibill-mobile/test/features/settings/**`

**Acceptance:**
- Theme toggle persists in app_settings and reflects immediately
- Locale change updates strings without app restart
- Telemetry switch default OFF; toggle ON triggers consent_log entry; toggle OFF revokes + purges queue
- Account deletion requires email confirmation matching session email; rate limit feedback shown
- Export button respects 1/day rate limit and shows expires_at when issued

---

### `T-525` — notifications_module: local notifs scheduling, prefs, snooze, dedupe

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 4
**Depends on:** `T-508`, `T-507`, `T-510`
**Blocks:** `T-526`
**Spec refs:** §8.10, §8.10.1

Build `features/notifications/` using `flutter_local_notifications` + `flutter_workmanager`. Init plugin with Android notification channels (due_soon, new_invoice, needs_review). Scheduler service: on login/foreground, query open invoices and schedule notifs at D-3/D-1/D using deterministic IDs `invoice_due_<id>_<days_before>`. Cancel on mark-paid. Dedupe via Drift `notification_log` (TTL 90d). Snooze action ('Lembrar amanhã') inserts row with `snoozed_until=now()+1d` and skips future schedules within window. Preferences UI bound to `notifications.preferences` app_setting (per spec JSON shape). Workmanager fallback polls 2x/day when realtime flag off. Bloc + integration test cover schedule/cancel/snooze. Idempotent re-runs do not duplicate.

**Files:**
- `unibill-mobile/lib/features/notifications/notifications_module.dart`
- `unibill-mobile/lib/features/notifications/data/notification_scheduler.dart`
- `unibill-mobile/lib/features/notifications/data/notification_log_dao.dart`
- `unibill-mobile/lib/features/notifications/presentation/notification_prefs_page.dart`
- `unibill-mobile/lib/features/notifications/presentation/bloc/notification_prefs_bloc.dart`
- `unibill-mobile/android/app/src/main/AndroidManifest.xml`
- `unibill-mobile/test/features/notifications/**`

**Acceptance:**
- Schedule run twice in a row results in same notification IDs and no duplicates
- Mark paid cancels all D-3/D-1/D notifs for that invoice
- Snooze hides next notif and persists across app restart
- Pref toggle for due_soon.enabled=false cancels all related notifs
- Workmanager registered and runs polling job when realtime flag is off

---

### `T-527` — sys_admin_module: dashboard with capacity gauges + queue depths + AI chain status

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 4
**Depends on:** `T-510`, `T-514`
**Blocks:** `T-528`, `T-529`, `T-530`
**Spec refs:** §8.5, §5.6, §5.7, Appendix C

Build `features/sys_admin/` gated by JWT `is_system_admin=true`. `/sys-admin/dashboard` shows: capacity gauge (current %, color per state green/yellow/orange/red) backed by `capacity_snapshots` latest row; queue depth chart for `email_sync_queue`, `invoice_queue` (read counts via SECURITY DEFINER fn); AI chain tri-state pill (CLOSED/HALF_OPEN/OPEN) + last transition + reopen_count; OCR chain same; last sync-run age; health endpoint `GET /health` result. Each card uses FeatureGate per per-flag (`features.sys_admin.capacity_dashboard` etc). Refresh every 30s. Bloc + widget tests with mocked data.

**Files:**
- `unibill-mobile/lib/features/sys_admin/sys_admin_module.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/dashboard_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/widgets/capacity_gauge.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/widgets/chain_status_pill.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/bloc/dashboard_bloc.dart`
- `unibill-mobile/test/features/sys_admin/dashboard_bloc_test.dart`

**Acceptance:**
- Non-admin user redirected away with 403 page (router enforced)
- Capacity gauge color matches state per thresholds (tested with mocked snapshots)
- Chain pills show state + tooltip with last transition reason
- Cards hidden behind FeatureGate when corresponding flag is false

---

### `T-515` — auth_module: welcome/signup/login/recovery/magic-link + deep-link callback

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-514`, `T-509`
**Blocks:** `T-516`, `T-532`
**Spec refs:** §9.1, §8.5

Build `features/auth/` per VGV layered: `data/` (AuthRemoteDataSource via supabase_flutter Auth), `domain/` (entities: AuthUser, AuthSession; usecases: SignUp, SignIn, SignOut, SendMagicLink, RequestPasswordReset, HandleDeepLinkCallback), `presentation/` (Bloc per screen + pages). Screens: `/auth/welcome`, `/auth/signup`, `/auth/login`, `/auth/recover`, `/auth/verify-callback` (handles `unibill://auth/callback?token=...&type=...` via `supabase.auth.getSessionFromUrl`). Validate password requirements client-side (10+ chars, mixed case, digit, special). Show `hCaptcha` widget when rate-limit-triggered. Configure `AndroidManifest.xml` intent-filter for custom scheme. Bloc tests for each, widget tests for forms, golden for welcome page.

**Files:**
- `unibill-mobile/lib/features/auth/auth_module.dart`
- `unibill-mobile/lib/features/auth/data/auth_remote_data_source.dart`
- `unibill-mobile/lib/features/auth/data/auth_repository_impl.dart`
- `unibill-mobile/lib/features/auth/domain/usecases/*.dart`
- `unibill-mobile/lib/features/auth/presentation/welcome_page.dart`
- `unibill-mobile/lib/features/auth/presentation/login_page.dart`
- `unibill-mobile/lib/features/auth/presentation/signup_page.dart`
- `unibill-mobile/lib/features/auth/presentation/recovery_page.dart`
- `unibill-mobile/lib/features/auth/presentation/verify_callback_page.dart`
- `unibill-mobile/android/app/src/main/AndroidManifest.xml`
- `unibill-mobile/test/features/auth/**`

**Acceptance:**
- User can sign up with email+password, receive confirmation, complete via deep link
- Password rules enforced client-side with localized error messages
- Deep link unibill://auth/callback resolves session and routes to / or /auth/login on failure
- Bloc tests cover success + auth failure + network failure for each flow
- AndroidManifest intent-filter present with autoVerify

---

### `T-518` — invoices_module: detail page with QR PIX, barcode, mark paid/unpaid

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-517`, `T-509`
**Blocks:** `T-519`, `T-532`
**Spec refs:** §8.5, §8.6, §5.3, Appendix E /admin/invoices/:id/reextract

Build `InvoiceDetailPage` showing fields: utility name, amount (formatted via `money_formatter`), due_date, status chip, reference_period, installation_id, payment_confirmation_source. Render PIX via `qr_flutter` from `pix_payload` when present; render boleto via `barcode_widget` (Code-128 style banking line) from `barcode` when present. Tap QR/barcode → copy payload + UndoSnack 'Copiado'. Action bar: 'Marcar paga' / 'Desmarcar' / 'Editar' / 'Ver PDF' / 'Re-extrair'. Mark paid uses UndoSnack (§8.6 spec example verbatim). 'Re-extrair' calls `POST /admin/invoices/:id/reextract` (member or sys admin per Appendix E). Bloc tests cover state transitions; widget tests cover render of QR + barcode + missing fields.

**Files:**
- `unibill-mobile/lib/features/invoices/presentation/invoice_detail_page.dart`
- `unibill-mobile/lib/features/invoices/presentation/bloc/invoice_detail_bloc.dart`
- `unibill-mobile/lib/features/invoices/presentation/widgets/qr_pix_view.dart`
- `unibill-mobile/lib/features/invoices/presentation/widgets/barcode_view.dart`
- `unibill-mobile/lib/core/utils/money_formatter.dart`
- `unibill-mobile/lib/core/utils/pix_decoder.dart`
- `unibill-mobile/test/features/invoices/invoice_detail_bloc_test.dart`

**Acceptance:**
- QR code renders only when pix_payload non-null and valid EMV (starts with 00020126)
- Barcode renders only when `barcode` non-null and is 47-digit linha digitável
- Mark paid → optimistic update + UndoSnack; undo reverts within 10s window
- Re-extract action posts idempotency_key and shows pending toast
- Field tap-to-copy works for amount, barcode, pix_payload

---

### `T-520` — invoices_module: needs-review screen with filter + bulk actions

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 5
**Depends on:** `T-517`
**Spec refs:** §8.5, BR-002, BR-004, BR-005

Implement `/needs-review` page filtering invoices `status='needs_review'`. Show reason chip per invoice (low_confidence / ai_chain_open / ocr_chain_open). Tap → detail/edit. Optional bulk select for sys admin to trigger 're-extrair selecionadas' calling `POST /admin/invoices/:id/reextract` per id. Empty state with friendly illustration. Pagination 50/page. Bloc + widget tests.

**Files:**
- `unibill-mobile/lib/features/invoices/presentation/needs_review_page.dart`
- `unibill-mobile/lib/features/invoices/presentation/bloc/needs_review_bloc.dart`
- `unibill-mobile/test/features/invoices/needs_review_bloc_test.dart`

**Acceptance:**
- Filter shows only needs_review for current household
- Reason chip color-coded per reason
- Bulk re-extract only visible when is_system_admin claim true
- Empty state rendered when zero items

---

### `T-521` — emails_module: connect/list/rotate-password/delete Gmail accounts

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-508`, `T-509`
**Spec refs:** §8.5, Appendix E emails/*

Build `features/emails/` per layered. Data calls Edge Functions `POST /emails/connect`, `PATCH /emails/:id/rotate-password`, `DELETE /emails/:id`. Pages: `/emails` list showing each connected email + status (active/error/paused) + last_synced_at; `/emails/connect` form (email_address + 16-char Gmail app password masked field; helper link 'Como gerar app password'); per-row actions: rotate, delete (UndoSnack), unbind from household. Validate Zod-equivalent client-side. Handle 401 (IMAP auth failed) and 409 (already registered) with localized messages. Bloc + widget tests; mock all Edge Function calls.

**Files:**
- `unibill-mobile/lib/features/emails/emails_module.dart`
- `unibill-mobile/lib/features/emails/data/email_remote_data_source.dart`
- `unibill-mobile/lib/features/emails/domain/**`
- `unibill-mobile/lib/features/emails/presentation/emails_list_page.dart`
- `unibill-mobile/lib/features/emails/presentation/email_connect_page.dart`
- `unibill-mobile/lib/features/emails/presentation/bloc/**`
- `unibill-mobile/test/features/emails/**`

**Acceptance:**
- Connect form validates app password format (16 lowercase, optional spaces) before POST
- Rotate prompts for new password; success persists rotated_at and shows toast
- Delete uses UndoSnack and only soft-deletes (returns to list after 10s window)
- Status chip updates from Realtime/refresh when consecutive_errors crosses threshold

---

### `T-522` — categories_module: CRUD with undo delete

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 5
**Depends on:** `T-508`, `T-509`
**Spec refs:** §8.5, §5.4, BR-022

Build `features/categories/` per layered. Data via Supabase `categories` table (RLS scoped to household). Pages: `/categories` list + create + edit dialog. Fields: name, color (palette), icon (Material icon picker). Delete uses UndoSnack and soft-delete via `deleted_at`. Reassignment policy: if delete, invoices keep their category id but UI shows '(removida)'. Bloc + widget tests.

**Files:**
- `unibill-mobile/lib/features/categories/categories_module.dart`
- `unibill-mobile/lib/features/categories/**`
- `unibill-mobile/test/features/categories/**`

**Acceptance:**
- Create persists row with household_id and is visible across reload
- Edit updates row and propagates to invoice list via cache invalidation
- Delete sets deleted_at; UndoSnack restores within 10s
- Bloc tests cover create/edit/delete + validation error

---

### `T-523` — household_module: members list, invite, leave/transfer

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-508`, `T-509`
**Spec refs:** §8.5, §5.1, BR-014

Build `features/household/`. `/household` shows current household name, member list (display_name + role + joined_at), pending invitations with code + expires_at + invited_email, settings (display_name edit, member display_name override scope=user). Actions: 'Convidar' (creates invitation, displays 8-char code + share intent), 'Promover/Rebaixar' admin (RLS-checked; UI hides for non-admins), 'Remover membro' (admin only with UndoSnack), 'Sair do household' (with confirmation; blocks if last admin per BR-014). Bloc + widget tests covering admin gating.

**Files:**
- `unibill-mobile/lib/features/household/household_module.dart`
- `unibill-mobile/lib/features/household/**`
- `unibill-mobile/test/features/household/**`

**Acceptance:**
- Members list filters out soft-deleted; roles displayed correctly
- Invite creates row with TTL and shows code; share intent works on Android
- Promote/demote/remove buttons hidden for non-admins (verified via widget test with mock role)
- Leave attempt as last admin shows specific error (BR-014)
- Bloc tests cover all actions + permission gating

---

### `T-526` — Realtime subscription for new invoices (notifications.realtime_subscribe flag)

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 5
**Depends on:** `T-525`, `T-510`
**Blocks:** `T-531`
**Spec refs:** §8.10.1

Implement `RealtimeInvoiceSubscriber` service: when feature flag `notifications.realtime_subscribe=true`, subscribes to Supabase Realtime channel `household:<household_id>` listening for INSERT on `public.invoices` filtered to the user's households. On insert: invalidate invoice cache, emit `Stream<InvoiceChange>` consumed by InvoiceListBloc, trigger `new_invoice` notification if pref enabled. Manage lifecycle: subscribe on app foreground or when ui.current_household_id changes; unsubscribe on logout/background. Handle reconnection with exponential backoff. When flag is false, fall back to workmanager polling from T-525. Tests with a fake RealtimeChannel.

**Files:**
- `unibill-mobile/lib/features/notifications/data/realtime_invoice_subscriber.dart`
- `unibill-mobile/test/features/notifications/realtime_invoice_subscriber_test.dart`

**Acceptance:**
- Subscription opens only when flag true and user authenticated with current household
- Insert event invalidates cache and emits to bloc within 100ms (test)
- Reconnect after socket drop within 5s (with backoff)
- Unsubscribes cleanly on logout (no leaked listeners)

---

### `T-528` — sys_admin_module: ai_chain_health + ocr_chain_health pages with force buttons

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-527`
**Spec refs:** §8.5, §7.6, §7.3, Appendix C, Runbook §11.3 #2

Build `/sys-admin/ai-chain` and `/sys-admin/ocr-chain` pages. Show: tri-state pill, last 50 chain transitions (from domain_events `ai.chain.*` / `ocr.chain.*`), per-provider sub-status (closed/open/half_open with timestamps), config snapshot. Buttons (gated by `features.sys_admin.ai_chain_force_trip` analogues, all writing via Edge Function admin endpoints): 'Force OPEN' (with reason), 'Force CLOSED', 'Simular falha' (synthetic probe). Confirmations + UndoSnack are NOT used here (irreversible-ish admin ops require explicit confirm dialog). Bloc + widget tests.

**Files:**
- `unibill-mobile/lib/features/sys_admin/presentation/ai_chain_health_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/ocr_chain_health_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/bloc/chain_health_bloc.dart`
- `unibill-mobile/test/features/sys_admin/chain_health_bloc_test.dart`

**Acceptance:**
- Tri-state pill matches latest state from chain_circuit_breaker_state table
- Force OPEN/CLOSED only enabled when claim is_system_admin true and per-feature flag
- Confirmation dialog before posting force action; failure shows error envelope
- Transitions list paginates correctly and renders pt/en

---

### `T-529` — sys_admin_module: domain_events browser, eviction history, telemetry browser

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-527`
**Spec refs:** §8.5, §5.6, §5.7, §8.9

Build three sys-admin browsers: `/sys-admin/events` (paginated list of `domain_events` filtered by event_type, aggregate, time range, actor); `/sys-admin/eviction` (`eviction_runs` history with tier, deleted counts, before/after %); `/sys-admin/telemetry` (`client_telemetry` browser with severity/screen filter, scrubbing-already-applied notice). All read-only with row tap → JSON detail bottom sheet. Each gated by respective `features.sys_admin.*` flag. Server side pagination via Supabase RPC (keyset). Bloc + widget tests.

**Files:**
- `unibill-mobile/lib/features/sys_admin/presentation/events_browser_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/eviction_history_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/telemetry_browser_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/bloc/**`
- `unibill-mobile/test/features/sys_admin/browsers_test.dart`

**Acceptance:**
- Keyset pagination loads next 100 in < 500ms for any of the 3 lists (mocked)
- Filter combinations work (event_type + date range; severity + screen)
- JSON bottom sheet pretty-prints payload with copy button
- All 3 hidden when corresponding feature flag false

---

### `T-530` — sys_admin_module: global settings editor + admins management

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-527`
**Spec refs:** §8.5, Appendix B, §9.2, Appendix E /admin/promote-system-admin

Build `/sys-admin/settings` — table editor for `app_settings` scope=global. Lists ~120 canonical keys with current value, default, type, range. Edit with type-aware input (bool toggle, int slider with min/max, text area for prompts, JSON editor for arrays/objects). Validates against range client-side; server-side validation re-checked. Highlight `requires_restart=true` keys with warning. Build `/sys-admin/admins` — list users with `is_system_admin=true` from `system_admin_grants`. Buttons 'Promover' (with reason; calls `POST /admin/promote-system-admin {grant:true}`), 'Revogar' (blocks last admin per BR-014 analog, message 'Não é possível revogar o último admin'). Audit trail shows last 50 grants. Bloc + widget tests + per-key edit golden.

**Files:**
- `unibill-mobile/lib/features/sys_admin/presentation/global_settings_editor_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/admins_management_page.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/widgets/setting_editor.dart`
- `unibill-mobile/lib/features/sys_admin/presentation/bloc/**`
- `unibill-mobile/test/features/sys_admin/settings_editor_test.dart`

**Acceptance:**
- Edit a bool/int/array key persists and reflects via /config/resolve
- Out-of-range value blocked client-side with localized error
- Promote/revoke posts with reason; server 422 last-admin propagates to UI
- Audit trail lists grants with action, actor, reason, timestamp

---

### `T-516` — auth_module: onboarding (create or join household via invite)

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 6
**Depends on:** `T-515`, `T-508`
**Blocks:** `T-531`
**Spec refs:** §8.5, §9.1 invitation security, Appendix E /invitations/redeem

Add `/auth/onboarding` flow: 2 choices — 'Criar household' (asks display_name, creates via Edge Function or RLS-allowed insert into `households` + `household_members`) or 'Entrar com convite' (input 8-char base32 code, calls `POST /invitations/redeem`). Persist resulting household_id into `app_settings` scope=user `ui.current_household_id`. Display friendly errors for 404/403/429 from redeem. On success route to `/`. Bloc tests + widget tests for both branches. Implements first run of OnboardingShown analytics event (gated by consent).

**Files:**
- `unibill-mobile/lib/features/auth/presentation/onboarding_page.dart`
- `unibill-mobile/lib/features/auth/presentation/bloc/onboarding_bloc.dart`
- `unibill-mobile/test/features/auth/onboarding_bloc_test.dart`

**Acceptance:**
- Create-household path persists household and member-admin row visible via RLS
- Redeem path handles 404 (invalid), 403 (email mismatch), 429 (rate limit) with localized messages
- On success, ui.current_household_id set in app_settings (verifiable)
- User cannot bypass onboarding while membership list is empty (router redirect enforced)

---

### `T-519` — invoices_module: PDF viewer + edit page with low-confidence indicators

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 6
**Depends on:** `T-518`
**Spec refs:** §8.5, §5.3, §10.4, §7.8

Build `/invoice/:id/pdf` using `pdfx` package — fetches signed URL from Supabase Storage via repository, renders multi-page PDF with pinch-to-zoom. Show 'PDF arquivado' placeholder when `pdf_archived_at IS NOT NULL` (per §10.4). Build `/invoice/:id/edit` showing form fields backed by InvoiceEditBloc. Each field reads its confidence from `extracted_payload.data.field_confidences[field]`; fields with confidence < 0.85 get a small warning icon + tooltip ('Confiança baixa: verifique'). Save persists via update with `paid_by` / `updated_by` audit. Validate amount_cents (positive int), due_date (parseable). Bloc tests + widget tests.

**Files:**
- `unibill-mobile/lib/features/invoices/presentation/invoice_pdf_page.dart`
- `unibill-mobile/lib/features/invoices/presentation/invoice_edit_page.dart`
- `unibill-mobile/lib/features/invoices/presentation/bloc/invoice_edit_bloc.dart`
- `unibill-mobile/lib/features/invoices/presentation/widgets/low_confidence_field.dart`
- `unibill-mobile/test/features/invoices/invoice_edit_bloc_test.dart`

**Acceptance:**
- PDF renders for valid signed URL; shows graceful error on 404 + 'arquivado' for archived
- Edit form validates amount_cents and due_date; save updates DB and refreshes cache
- Low-confidence indicator appears only for fields below 0.85 threshold
- Bloc test verifies edit-then-save round-trip and validation failures

---

### `T-532` — Integration test: golden flow login → list → detail → mark paid

**Category:** `test` | **Size:** `L` (~12h) | **Depth:** 6
**Depends on:** `T-515`, `T-517`, `T-518`
**Spec refs:** §12.3

Add `integration_test/app_test.dart` covering: cold boot → onboarding (assume seeded household via test fixtures) → login with test user → invoice list rendered → tap first invoice → detail page renders QR + barcode → tap 'Marcar paga' → UndoSnack shown → wait 11s → status updated → return to list shows paid badge. Run against local Supabase stack (CI uses `supabase start` + seed). Uses `patrol` or `integration_test` standard runner. Tags: `@smoke`.

**Files:**
- `unibill-mobile/integration_test/app_test.dart`
- `unibill-mobile/integration_test/fixtures/seed.sql`
- `unibill-mobile/.github/workflows/integration.yml`

**Acceptance:**
- `flutter test integration_test/app_test.dart` passes against local supabase
- Test recorded as smoke and runnable in CI matrix
- Failure produces screenshot + log artifact for debugging

---

### `T-531` — household_scope widget + multi-household switcher

**Category:** `mobile_widget` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-503`, `T-516`, `T-526`
**Spec refs:** §8.1, §5.1

Create `lib/core/widgets/household_scope.dart` — InheritedWidget exposing current `household_id`, `role`, `displayName`. Wrap app shell after auth. Provide `HouseholdSwitcher` widget (app bar dropdown) listing memberships; selecting persists `ui.current_household_id` in `app_settings` scope=user and broadcasts to invalidate caches + re-subscribe Realtime. Updates router state to refresh routes that depend on household. Unit tests for InheritedWidget propagation + switcher state.

**Files:**
- `unibill-mobile/lib/core/widgets/household_scope.dart`
- `unibill-mobile/lib/core/widgets/household_switcher.dart`
- `unibill-mobile/test/core/widgets/household_scope_test.dart`

**Acceptance:**
- HouseholdScope.of(context).householdId returns current value across the tree
- Switcher persists choice and re-subscribes Realtime to new channel within 1s
- Cache invalidation clears invoice_cache filter and refetches per new household
- Hidden when user has only one household (single-tap automatic)

---

## Phase P7-P9-P10-P11 — Capacity, LGPD, Operations, CI/CD, Polish

**Tasks:** 29

Phase P7-P9-P10-P11 covers Capacity Management (monitor, evictor, archive, PDF archive, cron schedules), LGPD compliance (consent flow, export, account deletion with anonymize, retention with PII masking), Operations (CI/CD pipelines, release-please, backup to B2, health check, monitoring), and Polish (i18n, goldens, docs auto-gen, ADRs, initial deploy checklist execution). The phase delivers the production-readiness layer that makes the MVP truly deployable, observable, compliant, and maintainable as an open-source project.

**Phase done when:** Phase done when: (1) capacity-monitor + capacity-evictor are deployed, cron-scheduled, and shown to converge a synthetic 95%-full DB back to <=60% in staging; (2) LGPD endpoints export-my-data and delete-my-account are implemented with full anonymize_user_references pgTAP coverage and ip_mask/ua_hash retention jobs running daily; (3) all GitHub Actions workflows green on a sample PR cycle (feature → main → tag), release-please bot produces a release PR, APK + manifest attached to a GitHub Release; (4) Backblaze B2 backup cron runs successfully weekly and a documented test-restore was performed once; (5) /health endpoint returns correct 200/503 codes per spec, 15min health check action emails admin on synthetic outage; (6) RUNBOOK.md, CONTRIBUTING.md, LICENSE (Apache 2.0), ADR-0001..0005, OpenAPI, DBML, dartdoc all generated and published in CI; (7) deploy checklist §11.5 fully executed once against a fresh Supabase project and the result documented.

---

### `T-621` — RUNBOOK.md skeleton (8 sections per spec)

**Category:** `doc` | **Size:** `S` (~2h) | **Depth:** 0
**Blocks:** `T-622`, `T-629`
**Spec refs:** §11.3

Create unibill-backend/docs/RUNBOOK.md with the exact 8-section skeleton from spec §11.3: (1) Backup restore DR, (2) Force chain breaker AI/OCR, (3) Re-extract invoice batch, (4) Rotate service_role key, (5) Capacity emergency, (6) User reports missing invoice, (7) Suspeita de vazamento de credencial, (8) Test restore (a cada 6 meses). Each section pre-populated with Quando + Como + commands as in spec. Add Index at top + cross-links. Add front-matter with last_updated, version.

**Files:**
- `unibill-backend/docs/RUNBOOK.md`

**Acceptance:**
- All 8 sections present with content from spec verbatim (or improved)
- Markdown lint passes
- Linked from README.md and CONTRIBUTING.md

---

### `T-623` — LICENSE (Apache 2.0) + CONTRIBUTING.md + Code of Conduct

**Category:** `doc` | **Size:** `S` (~2h) | **Depth:** 0
**Spec refs:** §2.1 open source, §11

Create LICENSE file (Apache 2.0 verbatim with current year + 'Unibill Contributors') in BOTH unibill-backend and unibill-mobile (and root unibill/ if shared). CONTRIBUTING.md per repo covering: dev setup, Conventional Commits, branch naming, testing requirements (links to §12 thresholds), PR template, security disclosure (security@... or GitHub Security Advisories), how to run pgTAP / deno test / flutter test, how to add migrations, how to add edge functions. CODE_OF_CONDUCT.md using Contributor Covenant 2.1. Add SECURITY.md for vulnerability disclosure.

**Files:**
- `unibill-backend/LICENSE`
- `unibill-backend/CONTRIBUTING.md`
- `unibill-backend/CODE_OF_CONDUCT.md`
- `unibill-backend/SECURITY.md`
- `unibill-mobile/LICENSE`
- `unibill-mobile/CONTRIBUTING.md`
- `unibill-mobile/CODE_OF_CONDUCT.md`
- `unibill-mobile/SECURITY.md`

**Acceptance:**
- Apache 2.0 LICENSE text matches official template exactly
- CONTRIBUTING.md contains test commands, branch naming, commit format sections
- SECURITY.md describes responsible disclosure with reporting email + 90d timeline
- GitHub UI shows LICENSE badge correctly

---

### `T-626` — ADRs 0001-0005 (key architectural decisions)

**Category:** `doc` | **Size:** `S` (~2h) | **Depth:** 0
**Spec refs:** §2, §3, §4.3, §5.10

Create docs/adr/ folder with template (Madr/Nygard style) and 5 initial ADRs capturing key decisions: ADR-0001 'Supabase Cloud over self-hosted' (constraints firmados); ADR-0002 'Flutter over React Native for mobile' (§3.2); ADR-0003 'pgmq + pg_cron over external queue' (§4.3); ADR-0004 'Sentinel actors in own table over auth.users pollution' (§5.10); ADR-0005 'Apache 2.0 over MIT/AGPL' (open source vs SaaS-protection trade-off). Each ADR: Status, Context, Decision, Consequences, Alternatives considered.

**Files:**
- `unibill-backend/docs/adr/0000-template.md`
- `unibill-backend/docs/adr/0001-supabase-cloud-over-self-hosted.md`
- `unibill-backend/docs/adr/0002-flutter-over-react-native.md`
- `unibill-backend/docs/adr/0003-pgmq-over-external-queue.md`
- `unibill-backend/docs/adr/0004-sentinel-actors-table.md`
- `unibill-backend/docs/adr/0005-apache-2-license.md`
- `unibill-backend/docs/adr/README.md`

**Acceptance:**
- 5 ADRs created with all 5 sections each
- ADR index README lists status + title + date
- Markdown lint passes
- ADR template references DACI or Nygard structure explicitly

---

### `T-606` — Migration: consent_log + sentinel actors + anonymize function

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-607`, `T-608`, `T-609`, `T-610`, `T-611`
**Spec refs:** §5.9, §5.10, §9.4

Migration creating consent_purpose enum + consent_log table with unique partial index per spec §5.9. Create system_actors table with seeded UUIDs per §5.10. Implement anonymize_user_references(target_user_id) function exactly per §5.10 (audit refs → sentinel; consent_log scrub PII + sentinel; HARD-DELETE soft-deleted connected_emails/members owned by user; DELETE client_telemetry). Apply ALTER TABLE … DROP CONSTRAINT for all audit-FK columns enumerated in §5.10. Add COMMENT ON COLUMN per §G for consent_log.purpose, legal_basis, ip_address.

**Files:**
- `unibill-backend/supabase/migrations/20260617000000_consent_sentinel_anonymize.sql`

**Acceptance:**
- Three sentinel system_actors rows present after migration with fixed UUIDs
- anonymize_user_references function exists and is SECURITY DEFINER
- All audit FK constraints listed in §5.10 are dropped (verified by pg_constraint query in test)
- Unique partial index uq_consent_active_per_purpose enforced (insert two active for same purpose → conflict)

---

### `T-615` — GitHub Actions: branch-strategy workflows (feature/fix/docs/main)

**Category:** `ci` | **Size:** `L` (~12h) | **Depth:** 1
**Depends on:** `T-101`
**Blocks:** `T-616`, `T-617`, `T-618`, `T-619`, `T-620`
**Spec refs:** §11.1, §12.4

Create per-branch workflows per §11.1 in unibill-backend AND unibill-mobile: (a) ci-feature.yml triggers on feature/**, fix/**, hotfix/**: lint + test + dry-run migrations (supabase db lint + ephemeral DB push); (b) ci-docs.yml: only markdown lint; (c) ci-chore.yml: lint + test no integration; (d) pr-main.yml triggers on PR to main: full check + coverage thresholds per §12.4 + breaking change check (db diff vs main); (e) main-deploy.yml triggers on push main: full + deploy to dev (supabase functions deploy + db push to dev project). All workflows use GITHUB_TOKEN; staging secrets scoped per env.

**Files:**
- `unibill-backend/.github/workflows/ci-feature.yml`
- `unibill-backend/.github/workflows/ci-docs.yml`
- `unibill-backend/.github/workflows/ci-chore.yml`
- `unibill-backend/.github/workflows/pr-main.yml`
- `unibill-backend/.github/workflows/main-deploy.yml`
- `unibill-mobile/.github/workflows/ci-feature.yml`
- `unibill-mobile/.github/workflows/pr-main.yml`
- `unibill-mobile/.github/workflows/main-deploy.yml`

**Acceptance:**
- Sample feature branch PR runs only lint+test, no deploys
- PR to main triggers coverage check; fails if backend <90% or mobile <85% per §12.4
- Push to main deploys backend functions + migrations to dev Supabase project
- Mobile push to main builds debug AAB and uploads to Internal Test track via fastlane action

---

### `T-601` — Migration: capacity + health + telemetry tables

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-101`, `T-102`
**Blocks:** `T-602`, `T-603`, `T-605`, `T-613`
**Spec refs:** §5.6, §5.7, §10.5, §10.6, §G

Create migration covering capacity_status enum, capacity_snapshots, eviction_runs, pdf_archive_log, health_snapshots, health_snapshots_hourly tables exactly per spec §5.7, plus client_telemetry per §5.6 (including indexes). Add COMMENT ON COLUMN per spec §G for capacity-relevant columns (pdf_archived_at). Include a deterministic seed of capacity.* and retention.* keys in app_settings via separate migration referenced as depends_on for agent 1.

**Files:**
- `unibill-backend/supabase/migrations/20260615000000_capacity_health_telemetry.sql`
- `unibill-backend/supabase/seeds/app_settings_capacity_retention.sql`

**Acceptance:**
- supabase db push applies cleanly on fresh DB
- pgTAP test verifies capacity_status enum values exactly green/yellow/orange/red
- All 6 tables created with indexes matching spec exactly
- All retention.* and capacity.* keys from §10.5/§10.6 seeded as rows in app_settings scope=global

---

### `T-607` — pgTAP test: anonymize_user_references + CI coverage guard

**Category:** `test` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-606`
**Blocks:** `T-609`, `T-617`
**Spec refs:** §5.10 Test obrigatório, §5.10 Auditoria contínua via CI

Implement supabase/tests/anonymize_user_references.test.sql per §5.10: setup populates a user across every table that references auth.users (households, members, household_invitations, invoices, app_settings, app_settings_history, domain_events, consent_log, connected_emails, members, client_telemetry); act SELECTs anonymize_user_references(uid); asserts: (1) DELETE FROM auth.users WHERE id=uid succeeds without FK violation, (2) every audit field now points to sentinel UUID 0...01, (3) client_telemetry empty for uid, (4) consent_log.ip_address IS NULL and user_agent IS NULL. Additionally implement anonymize_coverage.sql guard: query pg_constraint for FK to auth.users; compare against canonical whitelist; CI fails if any new unlisted FK appears.

**Files:**
- `unibill-backend/supabase/tests/anonymize_user_references.test.sql`
- `unibill-backend/supabase/tests/anonymize_coverage.sql`
- `unibill-backend/.github/scripts/check_anonymize_coverage.sh`

**Acceptance:**
- pg_prove ./supabase/tests passes all assertions
- Coverage guard script fails CI when a new auth.users FK is added without updating whitelist
- Test runs as part of backend CI pipeline

---

### `T-616` — release-please config + tag release workflow

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-615`
**Blocks:** `T-619`, `T-629`
**Spec refs:** §11.1, §11.2

Configure release-please-action in both repos. release-please-config.json: Conventional Commits, bump packages on feat/fix; releaseType node for backend, simple+manifest for mobile. .release-please-manifest.json with current versions. workflow release-please.yml runs on push main → opens release PR. On merge → tag v*.*.* created. Separate tag-release.yml triggered by tag v*.*.* in unibill-mobile: builds APK + AAB (flutter build), generates SHA256 + signed update manifest JSON (per spec direct distribution), attaches APK + manifest + CHANGELOG.md slice to GitHub Release. In unibill-backend: tag triggers deploy to prod with manual approval (environment: production).

**Files:**
- `unibill-backend/release-please-config.json`
- `unibill-backend/.release-please-manifest.json`
- `unibill-backend/.github/workflows/release-please.yml`
- `unibill-backend/.github/workflows/tag-deploy-prod.yml`
- `unibill-mobile/release-please-config.json`
- `unibill-mobile/.release-please-manifest.json`
- `unibill-mobile/.github/workflows/release-please.yml`
- `unibill-mobile/.github/workflows/tag-release-apk.yml`

**Acceptance:**
- release-please bot opens PR after 1st conventional commit on main
- Merging release PR creates git tag matching pkg version
- Tag in mobile repo produces GitHub Release with: signed APK, manifest.json (with sha256 + version + url), CHANGELOG slice
- Tag in backend repo blocks on environment=production approval before deploying

---

### `T-618` — GitHub Actions: mobile pipeline (analyze + test + build)

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-615`
**Spec refs:** §11.1, §12.3, §12.4

Reusable workflow .github/workflows/mobile-checks.yml in unibill-mobile: (1) flutter pub get + dart format --set-exit-if-changed; (2) flutter analyze --fatal-infos --fatal-warnings; (3) flutter test --coverage with thresholds per §12.4 (95% domain, 90% bloc, 85% lib/**); (4) golden test job (pages × light/dark × pt/en); (5) PR build: flutter build apk --debug uploaded as artifact; (6) main build: flutter build appbundle --release + upload to Play Internal Track via r0adkll/upload-google-play-action; (7) build_runner check (freezed/injectable). Called by ci-feature.yml + pr-main.yml + main-deploy.yml.

**Files:**
- `unibill-mobile/.github/workflows/mobile-checks.yml`
- `unibill-mobile/fastlane/Fastfile`
- `unibill-mobile/android/Gemfile`

**Acceptance:**
- All jobs run green on baseline app
- Golden test failure produces diff PNG artifact
- Internal Track upload tested in dry-run mode
- Build artifacts: debug APK on PRs; signed AAB on main

---

### `T-620` — Weekly backup cron to Backblaze B2 + retention policy

**Category:** `ops` | **Size:** `M` (~5h) | **Depth:** 2
**Depends on:** `T-615`
**Blocks:** `T-622`, `T-629`
**Spec refs:** §11.3

Create .github/workflows/backup-weekly.yml in unibill-backend: schedule '0 5 * * 0' (Sun 05:00 UTC). Job uses postgresql-client to run pg_dump --format=custom --no-owner --no-acl -d $SUPABASE_DB_URL > unibill-$(date +%Y%m%d).dump. Configure aws CLI with B2 endpoint (s3.us-west-002.backblazeb2.com) using B2_KEY_ID + B2_APPLICATION_KEY. Upload via aws s3 cp ... s3://$B2_BUCKET/. Document B2 bucket lifecycle policy (4 weekly + 6 monthly retention) in docs/backup.md as one-time bucket config. Also include a storage_metadata snapshot job (monthly): SELECT path, sha256 FROM storage.objects → ndjson → upload to B2 archives/storage_metadata/YYYY-MM.ndjson.gz. Workflow can be triggered manually for ad-hoc backups.

**Files:**
- `unibill-backend/.github/workflows/backup-weekly.yml`
- `unibill-backend/.github/workflows/backup-storage-metadata.yml`
- `unibill-backend/docs/backup.md`

**Acceptance:**
- Manual trigger uploads a real dump to B2 staging bucket and verifies via aws s3 ls
- Dump size logged to GitHub Actions summary
- B2 lifecycle policy documented with exact JSON; can be applied via b2 CLI snippet in docs/backup.md
- Workflow alerts admin email on failure

---

### `T-609` — Edge Function: DELETE /privacy/my-account

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 3
**Depends on:** `T-606`, `T-607`
**Blocks:** `T-612`, `T-629`
**Spec refs:** §9.4, §E (privacy/my-account), BR-021

Implement supabase/functions/privacy-delete/index.ts per §9.4 + §E: validate confirmation_email matches auth.email; check user is NOT last admin of any household (return 422 with household list else); soft-delete membership across all households; soft-delete connected_emails owned + DELETE vault secrets; call anonymize_user_references(uid); DELETE client_telemetry + scrub PII in domain_events (already covered); emit user.deleted domain event; finally call supabase.auth.admin.deleteUser(uid). Wrap orchestration in a single transaction where possible; for steps outside Postgres (vault, auth admin), use compensating actions on failure. Idempotent via deleting same uid twice returns 200 if already deleted.

**Files:**
- `unibill-backend/supabase/functions/privacy-delete/index.ts`
- `unibill-backend/supabase/functions/privacy-delete/checks.ts`
- `unibill-backend/supabase/functions/privacy-delete/orchestrator.ts`
- `unibill-backend/supabase/functions/privacy-delete/__tests__/last_admin_block.test.ts`
- `unibill-backend/supabase/functions/privacy-delete/__tests__/full_flow.test.ts`

**Acceptance:**
- Test: last admin blocked with 422 + body listing household_ids that need handover
- Test: full flow deletes user, invoices remain in household with paid_by=sentinel
- Test: confirmation_email mismatch returns 400
- Vault secrets DELETEd for all owned connected_emails
- user.deleted domain event emitted with payload {userId, deleted_at}
- auth.users row removed at end

---

### `T-613` — Edge Function: GET /health (public + authenticated)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-601`
**Blocks:** `T-614`, `T-628`, `T-629`
**Spec refs:** §11.4, §E (GET /health)

Implement supabase/functions/health/index.ts per §11.4 + §E. Public response: { status:'ok'|'degraded'|'down', timestamp }. With Bearer service_role: adds db_ok, queue_depths (invoice/email/dlq), ai_chain_state, capacity_status (latest capacity_snapshot), last_sync_run_minutes_ago. status='ok' (200) when ALL: db reachable, last sync_run <90min, capacity in green/yellow, ai_chain NOT open >1h. status='degraded' (200) when any single soft check fails. status='down' (503) when db unreachable OR capacity=red OR ai_chain open >1h. CORS: allow GET. No auth required for public.

**Files:**
- `unibill-backend/supabase/functions/health/index.ts`
- `unibill-backend/supabase/functions/health/checks.ts`
- `unibill-backend/supabase/functions/health/__tests__/checks.test.ts`

**Acceptance:**
- deno test covers status matrix: all-ok → 200/ok; capacity=red → 503/down; ai_chain open 30min → 200/ok; ai_chain open 2h → 503/down
- Authenticated probe returns extended payload with all 5 detail fields
- Response time <500ms p95 in local stack benchmark
- Public response excludes any internal metric fields

---

### `T-617` — GitHub Actions: backend pipeline (lint + pgTAP + deno test + migration lint)

**Category:** `ci` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-615`, `T-607`
**Blocks:** `T-624`
**Spec refs:** §11.1, §12.2, §12.4

Reusable workflow .github/workflows/backend-checks.yml composed of jobs: (1) eslint + prettier check; (2) supabase db lint --linked --schema public; (3) supabase db start ephemeral + supabase db push --include-seed + pg_prove ./supabase/tests; (4) deno test --coverage supabase/functions with coverage > 90% per §12.4; (5) anonymize coverage guard from T-607; (6) deno fmt --check + deno lint; (7) zod-to-openapi gen verification (no diff). Called by ci-feature.yml + pr-main.yml + main-deploy.yml.

**Files:**
- `unibill-backend/.github/workflows/backend-checks.yml`
- `unibill-backend/deno.json`
- `unibill-backend/.eslintrc.json`

**Acceptance:**
- All 7 jobs run green on a no-op commit
- Adding a migration with lint error fails the pipeline
- Removing an anonymize coverage row fails CI (guard)
- Coverage report uploaded as artifact

---

### `T-619` — Branch protection rules + secrets config doc

**Category:** `doc` | **Size:** `S` (~2h) | **Depth:** 3
**Depends on:** `T-615`, `T-616`
**Spec refs:** §11.1, §9.6 secret rotation runbook

Document branch protection rules to enforce manually in GitHub (cannot fully script without org token): main requires PR + 1 review + status checks pr-main + backend-checks + mobile-checks all green; no force push; no delete. release/* same rules. Create docs/secrets.md listing all required secrets per repo (SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF_DEV, _PROD, SUPABASE_DB_URL, SMTP_*, ADMIN_EMAIL, B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, PLAY_SERVICE_ACCOUNT_JSON, ANDROID_KEYSTORE_BASE64, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD, GEMINI_API_KEY, GROQ_API_KEY, etc.) + how to rotate each. Also provide gh CLI helper script .github/scripts/setup_branch_protection.sh.

**Files:**
- `unibill-backend/docs/secrets.md`
- `unibill-mobile/docs/secrets.md`
- `unibill-backend/.github/scripts/setup_branch_protection.sh`

**Acceptance:**
- docs/secrets.md enumerates every secret used in workflows with purpose + rotation procedure
- setup_branch_protection.sh runs against repo and applies rules via gh api
- Markdown lint passes

---

### `T-622` — Test restore drill execution + report (DR validation)

**Category:** `ops` | **Size:** `M` (~5h) | **Depth:** 3
**Depends on:** `T-620`, `T-621`
**Spec refs:** §11.3 §8 Test restore

Execute the test-restore procedure from RUNBOOK §8 against a fresh free-tier Supabase project. Document: backup timestamp restored, restore duration, smoke-query results (count(households), count(invoices status=extracted), max(checked_at) capacity_snapshots), any errors hit + fixes. UPDATE app_settings key='ops.last_backup_test_at' on prod with date. Append entry to RUNBOOK §8 'Histórico de drills' table.

**Files:**
- `unibill-backend/docs/RUNBOOK.md`

**Acceptance:**
- Drill executed successfully end-to-end on a temp project
- Smoke queries pass within expected ranges
- RUNBOOK §8 has table row with date, dump_size, duration_min, restore_status, notes
- app_settings.ops.last_backup_test_at updated on prod (or staging if prod not live)

---

### `T-602` — Edge Function: capacity-monitor (measure + classify + enqueue)

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 4
**Depends on:** `T-601`, `T-103`, `T-105`
**Blocks:** `T-603`, `T-604`, `T-629`
**Spec refs:** §4.4, §10.2, §10.6, §D, BR-010, BR-011, BR-012

Implement supabase/functions/capacity-monitor that (a) measures DB bytes via pg_database_size, per-table via pg_total_relation_size aggregated into db_per_table jsonb; (b) measures Storage bucket sizes via storage.objects sum; (c) reads pgmq queue depths; (d) loads thresholds from app_settings; (e) classifies into green/yellow/orange/red per BR-010/BR-011; (f) INSERTs capacity_snapshot row; (g) if status >= orange, enqueues message into capacity_eviction_queue (pgmq.send) with resource_type + trigger_reason + trigger_pct + target_pct; (h) if status crosses to red, sets features.ingestion_enabled=false in app_settings and emits capacity.threshold_crossed domain event + sends email via notifications.admin_email; (i) if status drops <=85% after red, resets ingestion_enabled=true and emits capacity.ingestion.resumed. Use withCorrelation + withStructuredLog from _shared. Idempotent by timestamp.

**Files:**
- `unibill-backend/supabase/functions/capacity-monitor/index.ts`
- `unibill-backend/supabase/functions/capacity-monitor/measure.ts`
- `unibill-backend/supabase/functions/capacity-monitor/classify.ts`
- `unibill-backend/supabase/functions/capacity-monitor/__tests__/classify.test.ts`

**Acceptance:**
- deno test passes for classify pure function across all 4 thresholds
- Integration test (local stack) shows snapshot row written every invocation
- Mock 95% utilization → emits capacity.threshold_crossed AND sets features.ingestion_enabled=false AND enqueues eviction message
- Mock recovery to 80% after red → emits capacity.ingestion.resumed AND sets features.ingestion_enabled=true
- Email sent on red threshold (mock SMTP capture)

---

### `T-614` — GitHub Action: health-monitor (15min cron + email on failure)

**Category:** `ci` | **Size:** `S` (~2h) | **Depth:** 4
**Depends on:** `T-613`
**Blocks:** `T-629`
**Spec refs:** §11.4

Create .github/workflows/health-monitor.yml in unibill-backend: schedule cron '*/15 * * * *'; job hits HEALTH_URL secret with curl; if status != 200 OR JSON.status='down', sends email via SendGrid/SMTP action to ${{ secrets.ADMIN_EMAIL }} with body containing url + http_code + response excerpt + last 5 entries from capacity_snapshots and ai_calls (fetched via service_role). Also a monthly cron (1st of month) that emails 30-day capacity summary (avg pct, peaks, eviction count).

**Files:**
- `unibill-backend/.github/workflows/health-monitor.yml`
- `unibill-backend/.github/workflows/capacity-monthly-report.yml`
- `unibill-backend/.github/scripts/format_health_alert.sh`

**Acceptance:**
- workflow_dispatch run against staging /health returns success path
- Synthetic 503 from staging triggers email (verified via test SMTP capture)
- Required secrets HEALTH_URL, ADMIN_EMAIL, SMTP_* documented in workflow comments and in docs/secrets.md

---

### `T-624` — Auto-gen docs: data-dictionary, configuration, events (CI publish)

**Category:** `doc` | **Size:** `M` (~5h) | **Depth:** 4
**Depends on:** `T-617`
**Blocks:** `T-625`
**Spec refs:** §G, §B, §F

Create scripts to auto-generate three reference docs from source-of-truth: (a) docs/data-dictionary.md from information_schema + pg_description via psql → MD table per table (column, type, comment); (b) docs/configuration.md from app_settings + app_settings_history defaults SQL seed → MD table grouped by namespace; (c) docs/events.md from grep of emitDomainEvent calls in functions/ + spec §F BR-* table → MD list. Script run in backend-checks CI; commits updates via github-actions[bot] in PRs if drift found. Publish to GitHub Pages /docs subdomain.

**Files:**
- `unibill-backend/scripts/gen_data_dictionary.sh`
- `unibill-backend/scripts/gen_configuration_doc.sh`
- `unibill-backend/scripts/gen_events_doc.sh`
- `unibill-backend/.github/workflows/docs-publish.yml`
- `unibill-backend/docs/data-dictionary.md`
- `unibill-backend/docs/configuration.md`
- `unibill-backend/docs/events.md`

**Acceptance:**
- Each script idempotent: running twice produces identical output
- CI fails (or opens auto PR) when generated files differ from committed
- GitHub Pages site renders the three docs under /docs
- Data dictionary captures every table COMMENT from §G migration

---

### `T-603` — Edge Function: capacity-evictor (tier escalation + archive)

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 5
**Depends on:** `T-601`, `T-602`
**Blocks:** `T-604`, `T-629`
**Spec refs:** §10.3, §10.4, §10.6, §D, BR-013, BR-016

Implement supabase/functions/capacity-evictor as pgmq consumer of capacity_eviction_queue. Uses withRunRow('eviction_runs'). Implements tier-escalation per §10.3: Tier 1 applies adaptive_floor_days from app_settings; Tier 2 floor /= 2; Tier 3 floor /= 4 (min 1); Tier 4 evicts invoices > 1095 days in batches of 100 emitting per-batch event; Tier 5 emits capacity.critical and sets features.ingestion_enabled=false. Each tier re-measures via capacity-monitor's measure() helper between escalations until pct <= target_pct=60 OR max_runtime exceeded (capacity.eviction_max_runtime_ms=45000). For PDF archive (BR-016): when resource_type='storage' and pct>=90%, select invoices with pdf_path NOT NULL AND created_at < now()-365d, DELETE Storage object, UPDATE invoices.pdf_archived_at=now(), INSERT pdf_archive_log row, emit pdf.archived event. Each step appended to eviction_runs.steps jsonb. Retry 3 with exponential backoff. ACK pgmq on success; route to capacity_eviction_dlq after 3 fails.

**Files:**
- `unibill-backend/supabase/functions/capacity-evictor/index.ts`
- `unibill-backend/supabase/functions/capacity-evictor/tier.ts`
- `unibill-backend/supabase/functions/capacity-evictor/archive_pdf.ts`
- `unibill-backend/supabase/functions/capacity-evictor/__tests__/tier.test.ts`
- `unibill-backend/supabase/functions/capacity-evictor/__tests__/archive_pdf.test.ts`

**Acceptance:**
- deno test covers tier escalation logic with synthetic DB sizes
- Integration test: synthetic 95%-full DB converges to <=60% via tier escalation in one run
- PDF archive path verified: Storage object DELETEd, pdf_archived_at set, pdf_archive_log row inserted, domain event emitted
- DLQ routing verified after 3 failures
- eviction_runs.steps jsonb captures one entry per tier executed

---

### `T-625` — OpenAPI gen from Zod + DBML diagram + dartdoc publish

**Category:** `doc` | **Size:** `M` (~5h) | **Depth:** 5
**Depends on:** `T-624`
**Spec refs:** §E

(a) zod-to-openapi: convert all Edge Function request/response Zod schemas (from §E) into openapi.yaml; CI script + publish to docs site; (b) dbml-cli: convert supabase migrations to DBML diagram (dbdiagram.io-style) via supabase db dump → pg-to-dbml → docs/schema.dbml + auto-generated docs/schema.svg; (c) dartdoc: workflow doc-mobile.yml runs dartdoc → publishes to gh-pages branch under /api. All three integrated into existing docs site landing page docs/index.md.

**Files:**
- `unibill-backend/scripts/gen_openapi.ts`
- `unibill-backend/docs/openapi.yaml`
- `unibill-backend/scripts/gen_dbml.sh`
- `unibill-backend/docs/schema.dbml`
- `unibill-backend/docs/schema.svg`
- `unibill-mobile/.github/workflows/doc-mobile.yml`
- `unibill-mobile/dartdoc_options.yaml`

**Acceptance:**
- openapi.yaml validates with @redocly/cli lint
- Every Edge Function listed in §E is documented in openapi.yaml
- DBML diagram renders without errors; updated when migrations change (CI guard)
- dartdoc site accessible at gh-pages /api/ with full public API coverage

---

### `T-627` — Mobile i18n: EN ARB fill + golden coverage (light/dark/pt/en)

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-411`
**Spec refs:** §8.4, §12.3 Golden tests

Fill in lib/l10n/app_en.arb with full EN translations matching every key in app_pt.arb (assumed authored by agent 4). Verify no missing keys via flutter gen-l10n. Update ALL existing golden tests (from agents 4/5) to add the 4-variant matrix: (light,pt) (light,en) (dark,pt) (dark,en). Centralize via golden_toolkit's multipleVariants helper. Add CI step that fails if any screen lacks all 4 goldens.

**Files:**
- `unibill-mobile/lib/l10n/app_en.arb`
- `unibill-mobile/test/helpers/golden_helper.dart`
- `unibill-mobile/test/golden_coverage_check.dart`
- `unibill-mobile/.github/workflows/mobile-checks.yml`

**Acceptance:**
- app_en.arb has 100% key parity with app_pt.arb
- flutter gen-l10n produces no warnings
- Every page-level widget test has exactly 4 golden files
- CI step golden_coverage_check fails on missing variant

---

### `T-628` — Mobile bootstrap health check + crash-resistant startup

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 7
**Depends on:** `T-613`, `T-411`
**Spec refs:** §11.4, §8.5

Implement lib/core/bootstrap/health_check.dart that runs on app launch (before first route): pings /health public endpoint; if down → shows OfflineModeScreen with retry + last-known-good cached data from drift; if degraded → shows non-blocking banner; if ok → proceeds. Also: try/catch around get_it init that on failure shows SafeBootScreen with 'Reset local cache' + 'Re-login' options. Bloc + tests + goldens.

**Files:**
- `unibill-mobile/lib/core/bootstrap/bootstrap.dart`
- `unibill-mobile/lib/core/bootstrap/health_check.dart`
- `unibill-mobile/lib/core/bootstrap/safe_boot_screen.dart`
- `unibill-mobile/lib/core/bootstrap/offline_mode_screen.dart`
- `unibill-mobile/test/core/bootstrap/health_check_test.dart`
- `unibill-mobile/test/core/bootstrap/golden/offline_mode_light_pt_test.dart`

**Acceptance:**
- Test: mock /health=503 → app shows OfflineModeScreen and does not crash
- Test: get_it.allReady() throws → SafeBootScreen appears with cache reset action
- Goldens for OfflineModeScreen × 4 variants
- Healthy startup unaffected (perf budget: < +150ms on launch)

---

### `T-611` — Mobile: Consent flow (signup gate + Settings toggle + telemetry gate)

**Category:** `mobile_feature` | **Size:** `L` (~12h) | **Depth:** 8
**Depends on:** `T-606`, `T-405`, `T-411`
**Blocks:** `T-612`
**Spec refs:** §5.9, §8.5, §8.9, BR-017, BR-018

Flutter implementation per §5.9 + §8.5: (a) Signup screen mandatory consent checkboxes for terms + privacy (versions read from /config/resolve legal.terms_version/legal.privacy_version), POSTs to /consent/accept on submit; (b) Settings → Privacidade screen with toggle 'Permitir coleta de telemetria de erros' that calls /consent/accept or /consent/revoke for purpose='telemetry'; (c) ConsentService.hasActiveConsent(purpose) cached locally via drift, refreshed on auth; (d) TelemetryClient.error/event gates on hasActiveConsent('telemetry') before POST; (e) On app open, check terms_version vs active consent.version → if mismatch, push ReConsentScreen blocking nav. Bloc + tests included.

**Files:**
- `unibill-mobile/lib/features/consent/data/consent_repository.dart`
- `unibill-mobile/lib/features/consent/domain/consent_service.dart`
- `unibill-mobile/lib/features/consent/presentation/signup_consent_screen.dart`
- `unibill-mobile/lib/features/consent/presentation/reconsent_screen.dart`
- `unibill-mobile/lib/features/settings/presentation/privacy_settings_screen.dart`
- `unibill-mobile/lib/core/telemetry/telemetry_client.dart`
- `unibill-mobile/test/features/consent/consent_service_test.dart`
- `unibill-mobile/test/features/settings/privacy_settings_bloc_test.dart`

**Acceptance:**
- bloc_test: telemetry toggle off → TelemetryClient.error returns early without POST
- Widget test: signup without terms checked disables submit button
- Widget test: terms_version bump → next app open shows ReConsentScreen
- Integration: revoking telemetry consent triggers DELETE on backend telemetry rows (via /consent/revoke side effect)

---

### `T-605` — Edge Function: archive-domain-events (jsonl.gz to Storage)

**Category:** `edge_function` | **Size:** `M` (~5h) | **Depth:** 9
**Depends on:** `T-601`, `T-110`
**Blocks:** `T-604`
**Spec refs:** §10.5 (retention.domain_events_*), §D, §5.13

Implement supabase/functions/archive-domain-events: SELECT domain_events WHERE occurred_at < now() - retention.domain_events_hot.max_age_days (default 90d) AND occurred_at >= now() - 7d (week slice). Stream as JSONL (one event per line), gzip, upload to 'archives' Storage bucket at path archives/domain_events/YYYY/MM/week-WW.jsonl.gz (deterministic for idempotency). After successful upload, DELETE the archived rows. Use withCorrelation + withStructuredLog. Idempotent via path: re-uploading same week overwrites.

**Files:**
- `unibill-backend/supabase/functions/archive-domain-events/index.ts`
- `unibill-backend/supabase/functions/archive-domain-events/__tests__/archive.test.ts`

**Acceptance:**
- Local stack test: 1000 synthetic events → uploaded jsonl.gz contains exactly 1000 lines
- Re-running same week is idempotent (overwrites file, deletes only newly archived rows)
- After successful upload, rows are DELETEd from domain_events
- archives bucket configured private (RLS: only service_role)

---

### `T-608` — Edge Function: POST /privacy/export-my-data

**Category:** `edge_function` | **Size:** `L` (~12h) | **Depth:** 9
**Depends on:** `T-606`, `T-105`, `T-110`
**Blocks:** `T-612`, `T-629`
**Spec refs:** §9.4, §E (export-my-data), BR-019, BR-020

Implement supabase/functions/privacy-export/index.ts per §9.4 + §E: rate limit 1/day/user via withRateLimit('export_my_data', userId, 1, '1day'); build scoped JSON per §9.4 table (profile, households metadata sem outros membros, members minha row, connected_emails owned sem app_password, invoices touched (paid_by=me OR created_by=me OR updated_by=me), consent_log mine, domain_events actor=me 90d, client_telemetry mine 30d); fetch only PDFs from owned connected_emails; create zip with all JSONs + PDFs + README.md ('contém apenas SEUS dados...'); upload to 'private-exports' bucket at exports/{userId}/{timestamp}.zip; create 24h signed URL; cap zip at 500MB. Return { download_url, expires_at }. Emit domain event privacy.export.completed.

**Files:**
- `unibill-backend/supabase/functions/privacy-export/index.ts`
- `unibill-backend/supabase/functions/privacy-export/scoped_queries.ts`
- `unibill-backend/supabase/functions/privacy-export/zip_builder.ts`
- `unibill-backend/supabase/functions/privacy-export/__tests__/scoped_queries.test.ts`

**Acceptance:**
- Integration test: user with multi-household membership exports zip; assert NO PII from other users in profile.json/households.json/members.json/invoices.json
- Rate limit returns 429 on 2nd call within 24h
- Zip > 500MB returns 413
- Signed URL works for 24h then 403
- connected_emails.json contains NO app_password field
- domain_events privacy.export.completed emitted

---

### `T-604` — Cron schedules: capacity, retention, cleanup-rate-buckets, health, archive-events

**Category:** `migration` | **Size:** `M` (~5h) | **Depth:** 10
**Depends on:** `T-602`, `T-603`, `T-605`
**Blocks:** `T-610`, `T-629`
**Spec refs:** §4.4, §6.6, §10.5, §D, BR-025

Migration that registers pg_cron jobs invoking edge functions via pg_net per §4.4 + §D: capacity-monitor every 5min, capacity-evictor every 1min, retention-hard-ceiling daily 03:00 UTC (inline SQL DELETE per §10.5 retention.<table>.max_age_days for each table), cleanup-rate-buckets every 10min (DELETE rate_limit_buckets WHERE window_start < now() - 7d), health-snapshots-aggregator daily 04:30 (aggregates last 24h into health_snapshots_hourly then DELETE detail rows >7d), archive-domain-events weekly Sunday 02:00. Wrapper uses pg_cron + pg_net pattern from §6.6. Each job logged via app_settings.history.

**Files:**
- `unibill-backend/supabase/migrations/20260616000000_cron_schedules_capacity_retention.sql`

**Acceptance:**
- SELECT * FROM cron.job shows all 6 scheduled jobs after migration
- pgTAP test asserts presence of each job by name with correct schedule string
- retention-hard-ceiling SQL is idempotent (re-run does not error, just no-ops)
- cleanup-rate-buckets deletes only window_start < now()-7d rows (test with mixed-age data)

---

### `T-612` — Mobile: Privacy screens (Export my data + Delete my account)

**Category:** `mobile_feature` | **Size:** `M` (~5h) | **Depth:** 10
**Depends on:** `T-608`, `T-609`, `T-611`
**Spec refs:** §9.4, §8.5, §E

Flutter screens calling /privacy/export-my-data and /privacy/my-account. Export screen: button + 1/day rate limit display + progress + download link (open in browser). Delete screen: confirmation_email input + reason textarea + scary warning + last-admin block with household handover instructions. Use Bloc, freezed states (Idle/Loading/Success/RateLimited/LastAdminBlocked/Error). All strings in EN + PT ARB.

**Files:**
- `unibill-mobile/lib/features/privacy/presentation/export_data_screen.dart`
- `unibill-mobile/lib/features/privacy/presentation/delete_account_screen.dart`
- `unibill-mobile/lib/features/privacy/presentation/bloc/privacy_bloc.dart`
- `unibill-mobile/test/features/privacy/privacy_bloc_test.dart`
- `unibill-mobile/test/features/privacy/golden/export_screen_light_pt_test.dart`
- `unibill-mobile/test/features/privacy/golden/delete_screen_dark_en_test.dart`

**Acceptance:**
- bloc_test covers all 6 states with happy + error paths
- Golden tests for export+delete screens × (light,dark) × (pt,en) = 8 goldens
- Last-admin block displays household names and admin-handover CTA
- Confirmation email field validates against current auth email

---

### `T-610` — Cron: consent_log IP mask + UA hash retention jobs

**Category:** `migration` | **Size:** `S` (~2h) | **Depth:** 11
**Depends on:** `T-606`, `T-604`
**Spec refs:** §10.5 retention.consent_log.*

Migration registering daily pg_cron jobs (04:00) that enforce retention.consent_log.ip_mask_after_days=90 (UPDATE consent_log SET ip_address = network(set_masklen(ip_address, CASE WHEN family(ip_address)=4 THEN 24 ELSE 64 END)) WHERE accepted_at < now()-90d AND ip_address IS NOT NULL AND host(ip_address) != network(...)) and retention.consent_log.user_agent_hash_after_days=30 (UPDATE consent_log SET user_agent = encode(digest(user_agent,'sha256'),'hex') WHERE accepted_at < now()-30d AND length(user_agent) != 64). Both idempotent (check before update). Plus job for retention.consent_log.max_age_days=1825 hard ceiling.

**Files:**
- `unibill-backend/supabase/migrations/20260618000000_consent_log_retention_jobs.sql`
- `unibill-backend/supabase/tests/consent_log_retention.test.sql`

**Acceptance:**
- pgTAP test: row >90d old → IP becomes /24 (IPv4) or /64 (IPv6) after job
- pgTAP test: row >30d old → user_agent becomes 64-char hex hash
- Jobs are idempotent (re-running does not double-hash or re-mask)
- Hard ceiling DELETE for rows >1825d works

---

### `T-629` — Initial deploy checklist execution (24 steps from §11.5)

**Category:** `ops` | **Size:** `L` (~12h) | **Depth:** 11
**Depends on:** `T-602`, `T-603`, `T-604`, `T-608`, `T-609`, `T-613`, `T-614`, `T-616`, `T-620`, `T-621`
**Spec refs:** §11.5

Execute the 24-step deploy checklist from spec §11.5 against the first real Supabase prod project. Document each step's completion with timestamp, commands executed, evidence (screenshot or output), in docs/initial-deploy-record.md. Include step 23a (RUNBOOK.md) and 23b (password manager docs). Surface and resolve any gaps discovered (file bugs as follow-up issues with id format gap-XXX). End state: dev + prod projects fully configured, first-user signup tested, first sync verified.

**Files:**
- `unibill-backend/docs/initial-deploy-record.md`

**Acceptance:**
- All 24 steps marked complete with evidence in docs/initial-deploy-record.md
- First sys admin promoted and verified
- First end-to-end invoice sync + extraction verified in prod
- Backup cron + health check cron enabled and running
- Any gaps logged as GitHub issues with gap-XXX label
- First APK released via GitHub Release flow tested

---

---

## Cross-cutting concerns

Tópicos transversais que aparecem em múltiplas tasks:

- **Correlation IDs**: propagar via header `x-correlation-id` em toda Edge Function. Gerado se ausente. Logged em domain_events, ai_calls, sync_runs, etc.
- **Idempotency keys**: toda msg pgmq carrega chave determinística; worker checa antes de processar.
- **Domain events**: emit em mudanças de estado importantes. INSERT na mesma transação do estado.
- **Redaction**: helper `redactSecrets()` aplicado em todo log/error_summary/payload antes de persistir.
- **Circuit breakers**: per-resource (provider, IMAP, etc.) + chain-level. Hysteresis + backoff exponencial.
- **Rate limits**: per-user, per-resource. `rate_limit_buckets` table.
- **Conventional Commits**: usar em PRs (release-please depende disso).
- **PR template**: incluir referência ao task ID + acceptance criteria checked.
- **pgTAP RLS tests**: toda policy nova tem teste cross-tenant. CI quebra se faltar.
- **COMMENT ON COLUMN**: campos business-meaningful comentados (Appendix G do spec).
- **Migrations roll-forward**: nunca editar migration mergeada; criar nova.

---

## Próximos passos

1. **Você revisa este plano** — flag tasks que parecem mal-escopadas, faltando, ou desnecessárias.
2. **Ajustes iterativos** — eu refino baseado no seu feedback.
3. **Bootstrap**: começar por T-101 (criar repos) — task de menor depth = entry point.
4. **Tracking**: criar issue por task no GitHub (script `gh issue create` em batch). Cada task vira issue; depends_on vira link.
5. **Branch strategy**: 1 task = 1 branch = 1 PR. Conventional Commits no merge.

Pronto para implementação quando estiver alinhado.
