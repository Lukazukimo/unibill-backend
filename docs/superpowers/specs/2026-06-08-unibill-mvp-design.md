# Unibill — MVP Design Document

| Campo | Valor |
|---|---|
| **Status** | Draft (aguardando revisão do usuário) |
| **Data** | 2026-06-08 |
| **Autores** | Fabio Wu + Claude (Opus 4.7) |
| **Origem** | Sessão de brainstorming P1-P6 (2026-06-03 a 2026-06-08) |
| **Próximo passo** | Self-review → revisão do usuário → quebra em tarefas implementáveis |

---

## Índice

1. [Visão geral](#1-visão-geral)
2. [Constraints firmados](#2-constraints-firmados)
3. [Stack tecnológica](#3-stack-tecnológica)
4. [Arquitetura](#4-arquitetura)
5. [Modelo de dados](#5-modelo-de-dados)
6. [Pipeline de ingestão](#6-pipeline-de-ingestão)
7. [Pipeline de extração](#7-pipeline-de-extração)
8. [App mobile (Flutter)](#8-app-mobile-flutter)
9. [Auth, segurança e LGPD](#9-auth-segurança-e-lgpd)
10. [Capacity Management](#10-capacity-management)
11. [Operações: CI/CD, backup, monitoring](#11-operações-cicd-backup-monitoring)
12. [Estratégia de testes](#12-estratégia-de-testes)
13. [Roadmap pós-MVP](#13-roadmap-pós-mvp)
14. [Decisões abertas](#14-decisões-abertas)
15. [Apêndices](#15-apêndices)

---

## 1. Visão geral

### 1.1 Problema

Famílias brasileiras recebem múltiplas faturas mensais (luz, água, gás, internet, telefone, streaming) por canais dispersos — principalmente email. Não existe ferramenta open source nacional pra **consolidar essas faturas em um único lugar**, ver vencimentos, marcar pagas e analisar gastos de forma compartilhada entre membros da família.

### 1.2 Solução

**Unibill** é um app mobile (Flutter) com backend Supabase que:
1. Conecta a caixas Gmail dos membros da família via IMAP + app password
2. Detecta faturas anexadas em PDFs nos emails recebidos
3. Extrai dados estruturados (valor, vencimento, código de barras, PIX) usando pipeline em 4 camadas: pdfjs nativo (texto) → OCR API chain (OCR.space → Google Vision) → regex per-utility → AI fallback chain (free tier Gemini → Groq → OpenRouter)
4. Apresenta lista organizada por mês/família/categoria
5. Permite marcar como paga, ver PDF original, gerar QR PIX, copiar código de barras

### 1.3 Escopo MVP

- **Multi-tenancy** por household (família). Até 3 famílias, ~15 usuários totais.
- **Cenário B de compartilhamento**: tudo dentro de uma família é compartilhado; famílias não se enxergam.
- **Cada usuário pode conectar múltiplos Gmails**. O mesmo Gmail pode pertencer a múltiplas famílias (binding many-to-many).
- **Mobile-first Android** (Flutter). iOS na fase 2.
- **Web React+Vite+TanStack** como espelho da Fase 2.
- **Ingestão**: somente email (Gmail). Sync a cada 1h (configurável).
- **Extração**: pipeline determinístico de 4 camadas com AI como safety-net (~80% das faturas processadas sem AI).
- **Open source** — Apache 2.0. Repos privados no início, públicos quando MVP estabilizar.
- **LGPD-friendly**: consentimento explícito, exportação de dados, exclusão de conta.

### 1.4 Não-escopo MVP

- WhatsApp via Baileys (risco de ban)
- Open Finance via agregadores (Pluggy, Belvo — conflita com filosofia open source)
- Pagamento automático via PIX (escopo + risco regulatório)
- Push notifications remotas (FCM/APNs) — só local notifications via `flutter_local_notifications`
- iOS, Google Play distribution, custom domain (tudo roadmap)
- 2FA, OAuth Google

---

## 2. Constraints firmados

### 2.1 Filosóficas

| Constraint | Razão |
|---|---|
| **Open source — Apache 2.0** | Filosofia do projeto; evita dependências proprietárias core (Open Finance fora) |
| **Sem custo recorrente obrigatório no MVP** | App pessoal-familiar; AI free tier; backup Backblaze free tier; Supabase free tier |
| **Design "as if at scale"** | Padrões profissionais (pgmq, circuit breakers, idempotency, domain events) aplicados desde o início mesmo com 15 users — projeto é também laboratório de arquitetura |

### 2.2 Técnicas

| Constraint | Implementação |
|---|---|
| **Auth no Gmail = IMAP + App Password** | Zero setup do mantenedor, trivial pro usuário; senha cifrada com Supabase Vault (pgsodium) |
| **Todo trabalho assíncrono via pgmq** | Email sync, extração, eviction de capacidade — nada de fire-and-forget |
| **Feature flags + config runtime** | Toda feature nova nasce com flag default=false. Tabela `app_settings` com scope global/household/user. Cache TTL 30s |
| **Idempotency keys explícitas** | Toda mensagem de fila carrega `idempotency_key` + check antes de processar |
| **Retry com backoff exponencial + jitter** | Nada de retry linear ou imediato |
| **Circuit breakers para deps externas** | Per-provider (Gemini, Groq, OpenRouter) + chain-level adaptive |
| **Domain events** | Tabela `domain_events` recebe todo evento de mudança de estado importante (audit + futuro webhook) |
| **Outbox via transação Postgres** | pgmq.send + INSERT na mesma transação (sem divergência de estado) |
| **Schema versioning de jsonb** | Todo payload com `{version: 1, data: {...}}` |
| **Tenancy enforcement em múltiplas camadas** | RLS no DB + Edge Functions derivam household_id de auth context ou queue payload |

### 2.3 Operacionais

| Constraint | Detalhe |
|---|---|
| **Retenção em duas camadas** | Hard ceiling diário (5 anos invoices, 1-2 anos logs) + adaptive eviction quando > 80% capacidade |
| **Capacity self-healing** | Tier-escalation provavelmente garante convergência ao alvo 60% sem intervenção humana por décadas |
| **Observabilidade built-in** | `sync_runs`, `extraction_runs`, `ai_calls`, `domain_events`, `capacity_snapshots`, `eviction_runs`, `client_telemetry` desde o dia 1 |
| **Correlation ID end-to-end** | UUID propagado de pg_cron → trigger → worker → AI call |
| **Sentinel user pattern** | User deletado vira referência ao usuário sistema `00000000-...-01` ("Usuário removido"); nunca NULL |

---

## 3. Stack tecnológica

### 3.1 Backend

- **Supabase Cloud (free tier)**: Postgres 15+ + Auth (GoTrue) + Storage + Edge Functions (Deno) + Realtime
- **Postgres extensions** (versões mínimas):
  - `supabase_vault` ≥ 0.2 (extensão pública sobre pgsodium; interface estável)
  - `pgmq` ≥ 1.5 (queue API estabilizou em 1.x; pinar major)
  - `pg_cron` ≥ 1.6
  - `pg_net` ≥ 0.13
  - `pgvector` (futuro, ≥ 0.7)
- **Edge Functions runtime**: Deno (TypeScript)
- **Validation**: Zod nos schemas de Edge Function
- **AI providers (chain)**: Gemini 2.0 Flash → Groq Llama 3.2 90B → OpenRouter (config default só com Gemini+Groq, OpenRouter desligado MVP)
- **PDF parsing (Layer 1, texto nativo)**: `pdfjs-dist` em Deno via `npm:pdfjs-dist` — apenas extração de texto, sem canvas rendering. Bundle ~5MB, compatível com Edge Function runtime.
- **OCR (Layer 2, condicional)**: API hospedada via chain pluggable. MVP default: `OCR.space` (free tier 25k/mês) → fallback `Google Cloud Vision` (free tier 1k/mês). **NÃO** usar `tesseract.js` em Edge Function (CPU/timeout limits + canvas rendering impraticável). Adapter pattern espelha AI chain (§7.5). Self-host via microservice fica em roadmap (§13.1).
- **Email IMAP**: avaliar `deno-imap` (puro Deno, ativo) ou `npm:imapflow` (Node lib via compat layer; mais maduro, bem documentado, suporta IDLE/move/fetch granular). **Recomendação MVP: `imapflow`** via `npm:` import; sintaxe e exemplos em §6.1.

### 3.2 Mobile

- **Flutter SDK constraint**: `>=3.27.0 <4.0.0` (Material 3 estabilizado, Dart 3.6+ disponível)
- **Dart SDK**: `>=3.5.0 <4.0.0`
- **State**: `flutter_bloc` + `equatable`
- **DI**: `get_it` + `injectable` (com scopes via `pushNewScope`/`popScopesTill` pra emular Modular)
- **Roteamento**: `go_router` com shell routes pra lifecycle de features
- **Imutabilidade**: `freezed` + `json_serializable`
- **Cache local**: `drift` (SQLite tipado)
- **Secure storage**: `flutter_secure_storage`
- **PDF viewer**: `pdfx` (open source)
- **QR Code**: `qr_flutter`
- **Barcode display**: `barcode_widget`
- **Notification local**: `flutter_local_notifications`
- **Backend SDK**: `supabase_flutter`
- **Lint**: `very_good_analysis` + `custom_lint` (regra `no_cross_feature_imports`)
- **i18n**: `intl` + `flutter_localizations` + ARB files (pt-BR + en)
- **Tests**: `bloc_test`, `mocktail`, `golden_toolkit`

### 3.3 Infraestrutura

- **Backup**: Backblaze B2 (free tier, ~10GB)
- **CI/CD**: GitHub Actions
- **Release automation**: `release-please` (open source, Google)
- **Distribuição mobile MVP**: APK via GitHub Releases (sem Play Store no MVP)

### 3.4 Estrutura de repos

Repos separados como irmãos em `/home/fwh/Documents/workbench/unibill/`:

```
unibill/
├── unibill-backend/     # Supabase (migrations, edge functions, types)
├── unibill-mobile/      # Flutter
├── unibill-web/         # React + Vite + TanStack (fase 2)
├── .claude/             # agents, skills, hooks compartilhados
└── docs/                # esta spec e futuros designs
```

Repos no GitHub: **privados no início**, public quando MVP estabilizar.

---

## 4. Arquitetura

### 4.1 Diagrama macro

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Mobile App (Flutter)                          │
│  ┌─────────┬─────────┬───────────┬──────────┬──────────┬──────────┐  │
│  │ Invoices│ Needs   │ Connected │ Household│ Settings │Sys Admin │  │
│  │  List   │ Review  │  Emails   │          │          │ (gated)  │  │
│  └─────────┴─────────┴───────────┴──────────┴──────────┴──────────┘  │
│                                  │                                    │
│                       supabase_flutter SDK                            │
└──────────────────────────────────┼───────────────────────────────────┘
                                   │
                            HTTPS + JWT
                                   │
┌──────────────────────────────────┼───────────────────────────────────┐
│                          Supabase Cloud                               │
│                                  │                                    │
│  ┌──────────────────┬────────────┴──────────────┬─────────────────┐  │
│  │   Auth (GoTrue)  │   Edge Functions (Deno)   │ Storage         │  │
│  │                  │                            │                 │  │
│  │ - email/password │ • sync-dispatcher          │ • invoices/     │  │
│  │ - magic link     │ • sync-worker              │   household-X/  │  │
│  │ - password reset │ • extraction-worker        │   YYYY-MM/      │  │
│  │ - JWT + claims   │ • capacity-monitor         │ • archives/     │  │
│  └──────────────────┤ • capacity-evictor         │ • private-exports│ │
│                     │ • admin/*                  │                 │  │
│                     │ • health                   │                 │  │
│                     │ • config/resolve           │                 │  │
│                     │ • privacy/*                │                 │  │
│  ┌──────────────────┴────────────────────────────┴────────────────┐  │
│  │                       Postgres                                  │  │
│  │                                                                  │  │
│  │  Extensions: pgsodium (Vault), pgmq, pg_cron, pg_net            │  │
│  │                                                                  │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  Data tables: households, members, connected_emails,       │ │  │
│  │  │  connected_email_households, invoices, invoice_categories, │ │  │
│  │  │  utility_parsers, household_invitations, consent_log       │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  Config: app_settings, app_settings_history                │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  Queues (pgmq): invoice_queue, invoice_dlq,                │ │  │
│  │  │  email_sync_queue, email_sync_dlq,                          │ │  │
│  │  │  capacity_eviction_queue, capacity_eviction_dlq             │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  Observability: sync_runs, extraction_runs, ai_calls,      │ │  │
│  │  │  domain_events, capacity_snapshots, eviction_runs,         │ │  │
│  │  │  health_snapshots, client_telemetry, pdf_archive_log       │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  Resilience: circuit_breakers, rate_limit_buckets          │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  Vault: vault.secrets (cifrado), vault.decrypted_secrets   │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                              ┌────┴────┐                ┌──────────────┐
                              │ Gmail   │                │ AI Providers │
                              │ IMAP    │                │ (Gemini,     │
                              └─────────┘                │  Groq, OR)   │
                                                          └──────────────┘
```

### 4.2 Princípios cross-cutting

Toda Edge Function implementa middlewares compartilhados (`supabase/functions/_shared/`):

| Middleware | Propósito |
|---|---|
| `withCorrelation()` | Gera/propaga `correlation_id` (UUID) — vai em logs, ai_calls, domain_events, etc. |
| `withIdempotency()` | Calcula chave determinística + check em tabela específica antes de processar |
| `withCircuitBreaker()` | Lê estado de `circuit_breakers` por `resource_type:resource_key`, bloqueia se OPEN |
| `withRateLimit()` | Incrementa contador em `rate_limit_buckets`, throw se excede limite |
| `emitDomainEvent()` | INSERT em `domain_events` (ideal: na mesma transação do estado) |
| `withStructuredLog()` | console.log com tags `{correlation_id, user_id, fn, ...}` |
| `withRunRow()` | INSERT em `sync_runs`/`extraction_runs`/`eviction_runs` no início, UPDATE no fim |

#### 4.2.1 `_shared/` helper contracts (TypeScript signatures)

```typescript
// supabase/functions/_shared/correlation.ts
type CorrelationContext = { correlation_id: string; user_id?: string; household_id?: string; };
declare function withCorrelation<T>(handler: (ctx: CorrelationContext) => Promise<T>): Deno.RequestHandler;

// supabase/functions/_shared/idempotency.ts
declare function withIdempotency(
  table: string, keyField: string, keyValue: string,
  body: () => Promise<void>
): Promise<{ skipped: boolean; reason?: string }>;

// supabase/functions/_shared/circuit.ts
type CircuitState = { state: 'closed'|'open'|'half_open'; opened_at: Date|null; next_probe_at: Date|null; reopen_count: number; reason: string|null; };
declare function getCircuitState(resource_type: string, resource_key: string): Promise<CircuitState>;
declare function withCircuitBreaker<T>(
  resource_type: string, resource_key: string,
  fn: () => Promise<T>
): Promise<T>;   // throws CircuitOpenError se aberto

// supabase/functions/_shared/rate_limit.ts
declare function withRateLimit(
  resource_type: string, resource_key: string,
  limit: number, window: '1minute'|'1hour'|'1day'
): Promise<void>;   // throws RateLimitError se excede

// supabase/functions/_shared/events.ts
type DomainEventInput = {
  type: string; aggregate_type: string; aggregate_id: string;
  household_id?: string; correlation_id?: string; actor_type: 'user'|'system'|'worker';
  actor_user_id?: string; payload: { version: number; data: any; };
};
declare function emitDomainEvent(e: DomainEventInput, tx?: SupabaseTx): Promise<void>;

// supabase/functions/_shared/logging.ts
declare const log: { debug, info, warn, error: (msg: string, meta?: object) => void };

// supabase/functions/_shared/runs.ts
declare function withRunRow<T>(
  table: 'sync_runs'|'extraction_runs'|'eviction_runs',
  initial: object,
  fn: (run_id: string) => Promise<T>
): Promise<T>;   // INSERT no início, UPDATE status/duration_ms/error_summary no fim

// supabase/functions/_shared/redact.ts
declare function redactSecrets(s: string | null | undefined): string;

// supabase/functions/_shared/errors.ts
class CircuitOpenError extends Error { resource_type: string; resource_key: string; }
class RateLimitError extends Error { resource_type: string; resource_key: string; limit: number; }
class NoProviderAvailableError extends Error { chain: string[]; lastError: Error|null; }
class ChainOpenError extends Error { chain_name: string; }
```

**Composição:** middlewares aplicam-se como wrappers em vez de callbacks; ex:
```typescript
serve(withCorrelation(async (ctx) => {
  return await withRunRow('extraction_runs', {invoice_id}, async (run_id) => {
    return await withCircuitBreaker('ai_chain', 'extraction_default', async () => {
      // ...
    });
  });
}));
```

`withCircuitBreaker` atualiza `circuit_breakers` row com `RETURNING` atômico (`UPDATE ... WHERE state='open' AND next_probe_at <= now() RETURNING *`), evitando race de probes paralelos.

### 4.3 Filas

| Fila | Producer | Consumer | VT default | Max retries |
|---|---|---|---|---|
| `email_sync_queue` | `sync-dispatcher` (pg_cron) | `sync-worker` | 120s | 3 |
| `email_sync_dlq` | `sync-worker` (após max retries) | (manual / admin) | — | — |
| `invoice_queue` | `sync-worker` (após capturar PDF) | `extraction-worker` | 90s | 3 |
| `invoice_dlq` | `extraction-worker` | (manual / admin) | — | — |
| `capacity_eviction_queue` | `capacity-monitor` (em orange+) | `capacity-evictor` | 120s | 3 |
| `capacity_eviction_dlq` | `capacity-evictor` | (manual / admin) | — | — |

### 4.4 Workers (pg_cron schedules)

| Cron | Função | Frequência |
|---|---|---|
| `unibill-sync-dispatcher` | `POST /sync-dispatcher` | a cada 1min |
| `unibill-sync-worker` | `POST /sync-worker` | a cada 1min |
| `unibill-extraction-worker` | `POST /extraction-worker` | a cada 1min |
| `unibill-capacity-monitor` | `POST /capacity-monitor` | a cada 5min |
| `unibill-capacity-evictor` | `POST /capacity-evictor` | a cada 1min |
| `unibill-retention-hard-ceiling` | SQL inline (DELETE diário) | diário 03:00 |
| `unibill-rate-limit-cleanup` | SQL inline (DELETE > 7d) | diário 04:00 |
| `unibill-health-snapshots-aggregator` | SQL inline (agrega hourly) | diário 04:30 |
| `unibill-archive-domain-events` | `POST /archive-domain-events` | semanal dom 03:00 |

---

## 5. Modelo de dados

Convenções globais:
- Audit fields universais: `created_at`, `updated_at`, `created_by`, `updated_by` (refs `auth.users`)
- Soft delete via `deleted_at timestamptz` em dados que o usuário pode "apagar"
- Sentinel user `00000000-0000-0000-0000-000000000001` substitui FK pra user deletado
- Valores monetários sempre em centavos (`bigint`)
- jsonb payloads sempre versionados: `{version: int, data: {...}}`

### 5.1 Core: households, members, invitations

```sql
CREATE TABLE households (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES auth.users(id),
  deleted_at   timestamptz
);

CREATE TYPE member_role AS ENUM ('admin', 'member');

CREATE TABLE members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  user_id       uuid NOT NULL REFERENCES auth.users(id),
  role          member_role NOT NULL DEFAULT 'member',
  invited_by    uuid REFERENCES auth.users(id),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- Permite re-adicionar membro após soft-delete:
CREATE UNIQUE INDEX uq_members_household_user_active
  ON members(household_id, user_id) WHERE deleted_at IS NULL;

-- Trigger: bloqueia rebaixar/remover último admin de um household
-- IMPORTANTE: BEFORE DELETE trigger DEVE retornar OLD (não NEW — NEW é NULL em DELETE,
-- e BEFORE trigger retornando NULL aborta silenciosamente a operação).
CREATE FUNCTION enforce_min_one_admin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  is_admin_removal boolean := false;
  remaining_admins int;
BEGIN
  -- Detecta os 3 cenários de "remoção de admin"
  IF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'admin' AND NEW.role <> 'admin' THEN
      is_admin_removal := true;  -- rebaixamento
    ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND OLD.role = 'admin' THEN
      is_admin_removal := true;  -- soft-delete
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.role = 'admin' AND OLD.deleted_at IS NULL THEN
    is_admin_removal := true;     -- hard-delete (raro, mas cobrir)
  END IF;

  IF is_admin_removal THEN
    SELECT count(*) INTO remaining_admins FROM members
     WHERE household_id = OLD.household_id
       AND role = 'admin' AND deleted_at IS NULL
       AND id <> OLD.id;
    IF remaining_admins = 0 THEN
      RAISE EXCEPTION 'Cannot remove the last admin of household %', OLD.household_id;
    END IF;
  END IF;

  -- Retorno correto por tipo de operação:
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;   -- BEFORE DELETE precisa de OLD (NEW é NULL)
  ELSE
    RETURN NEW;   -- BEFORE UPDATE precisa de NEW
  END IF;
END;
$$;

CREATE TRIGGER trg_min_one_admin BEFORE UPDATE OR DELETE ON members
  FOR EACH ROW EXECUTE FUNCTION enforce_min_one_admin();

CREATE TABLE household_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  code          text NOT NULL UNIQUE,         -- 8 chars alfanuméricos
  role          member_role NOT NULL DEFAULT 'member',
  invited_email text,                          -- opcional: trava ao email
  created_by    uuid NOT NULL REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',
  used_at       timestamptz,
  used_by       uuid REFERENCES auth.users(id)
);
```

### 5.2 Connected emails (split em 2 tabelas)

Pra permitir o mesmo Gmail em múltiplos households sem duplicar credencial nem cursor IMAP:

```sql
CREATE TYPE email_status AS ENUM ('active', 'paused', 'error', 'revoked');
CREATE TYPE email_provider AS ENUM ('gmail');   -- expansível futuro

-- A conta (credencial + cursor): UNIQUE global por email_address
CREATE TABLE connected_emails (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address       text NOT NULL UNIQUE,
  provider            email_provider NOT NULL DEFAULT 'gmail',
  owner_user_id       uuid NOT NULL REFERENCES auth.users(id),
  app_password_secret uuid NOT NULL,             -- ref Vault
  imap_host           text NOT NULL DEFAULT 'imap.gmail.com',
  imap_port           int NOT NULL DEFAULT 993,
  imap_use_tls        boolean NOT NULL DEFAULT true,
  status              email_status NOT NULL DEFAULT 'active',
  last_processed_uid  bigint,
  last_sync_at        timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  consecutive_errors  int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

-- O vínculo a households (many-to-many)
CREATE TABLE connected_email_households (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_email_id  uuid NOT NULL REFERENCES connected_emails(id),
  household_id        uuid NOT NULL REFERENCES households(id),
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

-- Partial unique indexes respeitam soft-delete (permite re-binding após delete):
CREATE UNIQUE INDEX uq_email_household_active
  ON connected_email_households(connected_email_id, household_id)
  WHERE deleted_at IS NULL;

-- Exatamente 1 default por email (entre os ativos):
CREATE UNIQUE INDEX idx_default_per_email
  ON connected_email_households(connected_email_id)
  WHERE is_default = true AND deleted_at IS NULL;
```

### 5.3 Invoices

```sql
CREATE TYPE invoice_status AS ENUM (
  'queued', 'extracting', 'extracted', 'needs_review', 'failed', 'duplicate'
);
CREATE TYPE extraction_method AS ENUM (
  'pdfjs',           -- texto nativo via pdfjs-dist
  'ocr_api',         -- OCR.space, Google Vision, ou outro provider da chain
  'regex',           -- regex per-utility (utility_parsers)
  'ai_fallback',     -- AI provider chain (Gemini/Groq/OpenRouter)
  'manual',          -- editado/extraído manualmente pelo usuário
  'on_device'        -- futuro: extração manual on-device no Flutter (roadmap)
);
CREATE TYPE payment_confirmation_source AS ENUM (
  'manual', 'email_inference', 'invoice_inference'
);

CREATE TABLE invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id         uuid NOT NULL REFERENCES households(id),
  connected_email_id   uuid REFERENCES connected_emails(id),
  correlation_id       uuid,
  idempotency_key      text,

  -- origem
  source_message_id    text,
  source_uid           bigint,
  source_received_at   timestamptz,
  source_sender        text,           -- "From" do email (usado por Layer 3 sender_patterns)
  source_subject       text,           -- "Subject" do email (usado por Layer 3 subject_patterns)
  -- corpo do email NÃO é persistido (LGPD: minimização). Apenas PDFs no Storage + texto extraído em extracted_payload

  -- arquivo
  storage_path         text NOT NULL,
  storage_bucket       text NOT NULL DEFAULT 'invoices',
  file_hash            text NOT NULL,    -- sha256 dos bytes do PDF, lowercase hex (64 chars). Validar via CHECK.
  file_size_bytes      bigint,
  mime_type            text,
  pdf_archived_at      timestamptz,    -- preenchido em capacity eviction

  -- extração
  status               invoice_status NOT NULL DEFAULT 'queued',
  extraction_method    extraction_method,
  extraction_confidence numeric(3,2),
  extraction_error     text,
  extracted_at         timestamptz,
  retries              int NOT NULL DEFAULT 0,
  needs_review_reason  text,

  -- dados extraídos
  utility_key          text,
  category_id          uuid,            -- FK adicionada via ALTER TABLE em migration posterior — ver nota abaixo
  amount_cents         bigint,
  currency             text NOT NULL DEFAULT 'BRL',
  due_date             date,
  reference_period     text,

  -- pagamento (boleto + PIX)
  barcode              text,
  pix_payload          text,
  pix_key              text,
  pix_txid             text,
  payment_methods      text[] NOT NULL DEFAULT '{}',

  -- payee + customer + serviço
  payee_name           text,
  payee_document       text,
  customer_document    text,
  customer_name        text,
  installation_id      text,
  service_address      text,
  consumption_data     jsonb,

  -- payload completo
  extracted_payload    jsonb,         -- {version, data}

  -- pagamento manual
  paid_at              timestamptz,
  paid_by              uuid REFERENCES auth.users(id),
  payment_note         text,
  payment_confirmation_source payment_confirmation_source,
  payment_confirmation_confidence numeric(3,2),

  -- audit
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES auth.users(id),
  updated_by           uuid REFERENCES auth.users(id),
  deleted_at           timestamptz
);

-- Validação do file_hash (sha256 hex lowercase):
ALTER TABLE invoices ADD CONSTRAINT chk_file_hash_format
  CHECK (file_hash ~ '^[a-f0-9]{64}$');

-- ⚠️ UNIQUE constraints inline incluem rows soft-deletadas, causando duplicate-key
-- ao re-receber a mesma fatura após delete. Usamos partial unique indexes:
CREATE UNIQUE INDEX uq_invoices_household_filehash_active
  ON invoices(household_id, file_hash) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_invoices_email_messageid_active
  ON invoices(connected_email_id, source_message_id)
  WHERE deleted_at IS NULL AND source_message_id IS NOT NULL;

CREATE INDEX idx_invoices_household_status
  ON invoices(household_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_invoices_household_due
  ON invoices(household_id, due_date) WHERE deleted_at IS NULL AND paid_at IS NULL;
CREATE INDEX idx_invoices_household_utility
  ON invoices(household_id, utility_key) WHERE deleted_at IS NULL;
CREATE INDEX idx_invoices_needs_review
  ON invoices(household_id) WHERE status = 'needs_review' AND deleted_at IS NULL;
```

**⚠️ Ordem de migrations:** `invoice_categories` (§5.4) é criada em migration posterior, então o FK `invoices.category_id → invoice_categories.id` é adicionado via `ALTER TABLE` depois que ambas existem:

```sql
-- Em migration após invoice_categories ser criada:
ALTER TABLE invoices
  ADD CONSTRAINT fk_invoices_category
  FOREIGN KEY (category_id) REFERENCES invoice_categories(id) ON DELETE SET NULL;
```

Convenção de migrations: prefixar com timestamp ISO (`20260615120000_create_invoices.sql`, `20260615120100_create_invoice_categories.sql`, `20260615120200_link_invoices_category.sql`).

### 5.4 Categorias e parsers

```sql
CREATE TABLE invoice_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  name         text NOT NULL,
  color        text,
  icon         text,
  is_system    boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE UNIQUE INDEX idx_cat_name_household
  ON invoice_categories(household_id, name) WHERE deleted_at IS NULL;

CREATE TABLE utility_parsers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_key         text NOT NULL,
  display_name        text NOT NULL,
  default_category    text,

  sender_patterns     text[] NOT NULL,
  subject_patterns    text[],
  body_must_contain   text[],

  amount_regex        text,
  due_date_regex      text,
  due_date_format     text,
  barcode_regex       text,
  pix_regex           text,
  reference_regex     text,
  installation_regex  text,
  customer_name_regex text,
  service_address_regex text,
  consumption_extractor jsonb,    -- ⚠️ MVP: sempre NULL. Schema será definido quando primeira feature
                                   -- de tracking de consumo entrar (roadmap). Worker IGNORA esta coluna no MVP;
                                   -- `invoices.consumption_data` também permanece NULL no MVP.

  version             int NOT NULL DEFAULT 1,
  active              boolean NOT NULL DEFAULT true,
  notes               text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utility_key, version)
);

CREATE INDEX idx_parsers_active ON utility_parsers(utility_key) WHERE active = true;
```

**Exemplo de seed (Enel SP)** — formato esperado pros 4 parsers MVP (enel-sp, sabesp, comgas, vivo):

```sql
INSERT INTO utility_parsers (
  utility_key, display_name, default_category, version, active, notes,
  sender_patterns, subject_patterns, body_must_contain,
  amount_regex, due_date_regex, due_date_format,
  barcode_regex, pix_regex, reference_regex, installation_regex,
  customer_name_regex, service_address_regex
) VALUES (
  'enel-sp', 'Enel São Paulo', 'Luz', 1, true,
  'Parser MVP para faturas Enel SP; padrões verificados contra emails de 2024-2026.',

  ARRAY[
    'enel\.com',
    'no-?reply.*enel',
    'eletropaulo'
  ],
  ARRAY[
    'fatura.*enel',
    'sua conta de energia'
  ],
  ARRAY[
    'Enel Distribuição São Paulo'
  ],

  -- amount: "Valor a pagar: R$ 234,56" ou "Total da fatura R$ 234,56"
  'Valor a pagar[:\s]+R\$\s*([0-9.,]+)',
  -- due_date: "Vencimento: 15/06/2026"
  'Vencimento[:\s]+(\d{2}/\d{2}/\d{4})',
  'DD/MM/YYYY',
  -- barcode: linha digitável 47 dígitos (com pontos/espaços opcionais)
  '(\d{5}\.?\d{5}\s?\d{5}\.?\d{6}\s?\d{5}\.?\d{6}\s?\d\s?\d{14})',
  -- pix_payload: BR code EMV (começa 00020126...)
  '(00020126[0-9A-Za-z+/=]{50,})',
  -- reference: "05/2026" ou "Maio/2026"
  'Referência[:\s]+([0-9]{2}/[0-9]{4}|[A-Za-zçãé]+/[0-9]{4})',
  -- installation/UC: "Unidade Consumidora: 123456789"
  'Unidade Consumidora[:\s]+(\d{6,12})',
  -- customer_name: aparece após "Cliente:" ou no header
  'Cliente[:\s]+([A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ\s\.]+?)(?:\n|$)',
  -- service_address: aparece após "Endereço:" ou "Local de Instalação:"
  'Local de Instalação[:\s]+(.+?)(?:\n|$)'
);
```

**Verificação** dos regex: pgTAP test em `supabase/tests/parsers/enel_sp.test.sql` com fixtures de PDFs reais (texto extraído pré-computado em fixtures, NÃO PDFs binários — evita LGPD nos testes).

Demais parsers (sabesp, comgas, vivo) seguem mesma estrutura — conteúdo concreto será populado durante implementação após coletar amostras de faturas reais.

### 5.5 App settings (config runtime)

```sql
CREATE TYPE setting_scope AS ENUM ('global', 'household', 'user');

CREATE TABLE app_settings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL,
  scope        setting_scope NOT NULL DEFAULT 'global',
  scope_id     uuid,                              -- NULL pra global
  value        jsonb NOT NULL,
  category     text NOT NULL,
  description  text,
  requires_restart boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES auth.users(id)
);

-- Postgres não permite NULL em colunas de PRIMARY KEY, então usamos
-- surrogate id + 2 partial unique indexes que expressam a intenção
-- "uma row por key+scope global" e "uma row por key+scope+scope_id em outros escopos":

CREATE UNIQUE INDEX idx_settings_global_unique
  ON app_settings(key)
  WHERE scope = 'global';

CREATE UNIQUE INDEX idx_settings_scoped_unique
  ON app_settings(key, scope, scope_id)
  WHERE scope <> 'global';

ALTER TABLE app_settings ADD CONSTRAINT chk_scope_id
  CHECK (
    (scope = 'global' AND scope_id IS NULL) OR
    (scope <> 'global' AND scope_id IS NOT NULL)
  );

CREATE INDEX idx_settings_category ON app_settings(category, scope);
CREATE INDEX idx_settings_lookup ON app_settings(key, scope, scope_id);  -- pra getConfig cascata

CREATE TABLE app_settings_history (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL,
  scope       setting_scope NOT NULL,
  scope_id    uuid,
  old_value   jsonb,
  new_value   jsonb NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid REFERENCES auth.users(id)
);

CREATE INDEX idx_settings_history_key ON app_settings_history(key, changed_at DESC);

-- Trigger AFTER INSERT/UPDATE em app_settings grava em history
```

Resolução `user → household → global → default no código`. Helper `getConfig(key, default, scope?)` cache TTL 30s.

### 5.6 Observabilidade

```sql
CREATE TABLE sync_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id      uuid NOT NULL,
  connected_email_id  uuid NOT NULL REFERENCES connected_emails(id),
  idempotency_key     text NOT NULL,
  trigger_source      text NOT NULL,        -- 'scheduled' | 'manual' | 'retry'
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         int,
  status              text NOT NULL,        -- 'running' | 'success' | 'partial' | 'failed'
  messages_seen       int NOT NULL DEFAULT 0,
  invoices_created    int NOT NULL DEFAULT 0,
  duplicates_skipped  int NOT NULL DEFAULT 0,
  errors_count        int NOT NULL DEFAULT 0,
  error_summary       text,
  config_snapshot     jsonb,
  imap_uid_from       bigint,
  imap_uid_to         bigint
);

CREATE INDEX idx_sync_runs_email_time ON sync_runs(connected_email_id, started_at DESC);
CREATE INDEX idx_sync_runs_corr ON sync_runs(correlation_id);

CREATE TABLE extraction_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id      uuid NOT NULL,
  invoice_id          uuid NOT NULL REFERENCES invoices(id),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         int,
  status              text NOT NULL,
  method              extraction_method,
  ai_calls_made       int NOT NULL DEFAULT 0,
  confidence          numeric(3,2),
  error_summary       text,
  config_snapshot     jsonb
);

CREATE INDEX idx_extraction_runs_invoice ON extraction_runs(invoice_id, started_at DESC);

CREATE TABLE ai_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id     uuid,
  provider           text NOT NULL,          -- 'gemini' | 'groq' | 'openrouter' | '__chain__'
  model              text,
  purpose            text NOT NULL,          -- 'extraction' | 'categorization' | 'chat'
  invoice_id         uuid REFERENCES invoices(id),
  household_id       uuid REFERENCES households(id),
  prompt_tokens      int,
  completion_tokens  int,
  latency_ms         int,
  status             text NOT NULL,          -- 'success' | 'rate_limited' | 'circuit_open' | 'timeout' | 'error' | 'invalid_response'
  error_summary      text,
  chain_state_at_call text,                   -- snapshot do chain breaker
  is_probe           boolean NOT NULL DEFAULT false,
  synthetic          boolean NOT NULL DEFAULT false,
  called_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_calls_provider_time ON ai_calls(provider, called_at DESC);
CREATE INDEX idx_ai_calls_household ON ai_calls(household_id, called_at DESC) WHERE household_id IS NOT NULL;

CREATE TABLE domain_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL,
  event_version   int NOT NULL DEFAULT 1,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  household_id    uuid REFERENCES households(id),
  correlation_id  uuid,
  causation_id    uuid,
  payload         jsonb NOT NULL,             -- {version, data}
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid REFERENCES auth.users(id),
  actor_type      text NOT NULL               -- 'user' | 'system' | 'worker'
);

CREATE INDEX idx_events_aggregate ON domain_events(aggregate_type, aggregate_id, occurred_at);
CREATE INDEX idx_events_household ON domain_events(household_id, occurred_at DESC) WHERE household_id IS NOT NULL;
CREATE INDEX idx_events_correlation ON domain_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_events_type_time ON domain_events(event_type, occurred_at DESC);

CREATE TABLE client_telemetry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  user_id         uuid REFERENCES auth.users(id),
  household_id    uuid REFERENCES households(id),
  session_id      uuid,
  correlation_id  uuid,
  event_type      text NOT NULL,          -- 'error' | 'navigation' | 'performance' | 'feature_used'
  severity        text,                   -- 'fatal' | 'error' | 'warn' | 'info'
  payload         jsonb NOT NULL,
  device_info     jsonb,
  app_version     text,
  release_channel text
);

CREATE INDEX idx_telemetry_time ON client_telemetry(occurred_at DESC);
CREATE INDEX idx_telemetry_severity ON client_telemetry(severity, occurred_at DESC)
  WHERE severity IN ('error', 'fatal');
```

### 5.7 Capacity Management

```sql
CREATE TYPE capacity_status AS ENUM ('green', 'yellow', 'orange', 'red');

CREATE TABLE capacity_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at           timestamptz NOT NULL DEFAULT now(),
  db_bytes             bigint NOT NULL,
  db_limit_bytes       bigint NOT NULL,
  db_pct               numeric(5,2) NOT NULL,
  db_status            capacity_status NOT NULL,
  db_per_table         jsonb NOT NULL,
  storage_bytes        bigint NOT NULL,
  storage_limit_bytes  bigint NOT NULL,
  storage_pct          numeric(5,2) NOT NULL,
  storage_status       capacity_status NOT NULL,
  storage_per_bucket   jsonb NOT NULL,
  queue_depths         jsonb NOT NULL,
  thresholds_snapshot  jsonb NOT NULL
);

CREATE INDEX idx_capacity_time ON capacity_snapshots(checked_at DESC);

CREATE TABLE eviction_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id    uuid NOT NULL,
  resource_type     text NOT NULL,
  trigger_reason    text NOT NULL,
  trigger_pct       numeric(5,2) NOT NULL,
  target_pct        numeric(5,2) NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       int,
  final_pct         numeric(5,2),
  total_freed_bytes bigint NOT NULL DEFAULT 0,
  status            text NOT NULL,
  steps             jsonb NOT NULL DEFAULT '[]',
  error_summary     text
);

CREATE INDEX idx_eviction_runs_time ON eviction_runs(started_at DESC);
CREATE INDEX idx_eviction_runs_resource ON eviction_runs(resource_type, started_at DESC);

CREATE TABLE pdf_archive_log (
  invoice_id        uuid PRIMARY KEY REFERENCES invoices(id),
  original_path     text NOT NULL,
  file_hash         text NOT NULL,
  file_size_bytes   bigint NOT NULL,
  archived_at       timestamptz NOT NULL DEFAULT now(),
  archived_by_run   uuid REFERENCES eviction_runs(id),
  archive_reason    text NOT NULL
);

CREATE TABLE health_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at            timestamptz NOT NULL DEFAULT now(),
  db_ok                 boolean NOT NULL,
  email_sync_queue_depth int,
  invoice_queue_depth   int,
  dlq_email_depth       int,
  dlq_invoice_depth     int,
  oldest_unprocessed    timestamptz,
  active_circuits_open  int NOT NULL DEFAULT 0,
  ai_providers_status   jsonb
);

-- agregado horário (após 7 dias detalhado vira hourly por 30 dias)
CREATE TABLE health_snapshots_hourly (
  hour                 timestamptz PRIMARY KEY,
  db_ok_pct            numeric(5,2),
  avg_queue_depth      numeric,
  errors_per_hour      int,
  active_circuits_open_max int
);
```

### 5.8 Resilience

```sql
CREATE TYPE circuit_state AS ENUM ('closed', 'open', 'half_open');

CREATE TABLE circuit_breakers (
  resource_type      text NOT NULL,
  resource_key       text NOT NULL,
  state              circuit_state NOT NULL DEFAULT 'closed',
  failure_count      int NOT NULL DEFAULT 0,
  last_failure_at    timestamptz,
  opened_at          timestamptz,
  closed_at          timestamptz,
  half_open_started_at timestamptz,
  next_probe_at      timestamptz,
  probes_sent        int NOT NULL DEFAULT 0,
  probes_succeeded   int NOT NULL DEFAULT 0,
  reopen_count       int NOT NULL DEFAULT 0,
  reason             text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, resource_key)
);

CREATE TABLE rate_limit_buckets (
  resource_type   text NOT NULL,
  resource_key    text NOT NULL,
  window_start    timestamptz NOT NULL,
  window_size     interval NOT NULL,
  count           int NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_type, resource_key, window_start, window_size)
);

CREATE INDEX idx_buckets_expiry ON rate_limit_buckets(window_start);
```

### 5.9 LGPD: consent_log (com versioning + revogação granular)

LGPD art. 8 §5 garante revogação a qualquer momento. Modelo granular por finalidade:

```sql
CREATE TYPE consent_purpose AS ENUM (
  'terms',         -- Termos de uso (obrigatório pra usar o app)
  'privacy',       -- Política de privacidade (obrigatório)
  'telemetry',     -- Coleta de telemetria de erros (opt-in)
  'marketing'      -- Futuro: newsletters, comunicações comerciais (opt-in)
);

CREATE TABLE consent_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  purpose         consent_purpose NOT NULL,
  version         text NOT NULL,             -- versão do documento aceito (ex: "terms-v1.2-2026-06")
  legal_basis     text NOT NULL,             -- 'consent' | 'legitimate_interest' | 'legal_obligation' | 'contract'
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,               -- NULL = ativo; preenchido na revogação
  revoked_reason  text,
  ip_address      inet,                      -- inet > text pra storage eficiente
  user_agent      text
);

-- Apenas 1 consent ATIVO por (user, purpose):
CREATE UNIQUE INDEX uq_consent_active_per_purpose
  ON consent_log(user_id, purpose)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_consent_user_purpose ON consent_log(user_id, purpose, accepted_at DESC);
```

**Trigger de re-consent automático:** quando `app_settings.key='legal.terms_version'` muda valor, próximo login do user verifica `(SELECT version FROM consent_log WHERE user_id=me AND purpose='terms' AND revoked_at IS NULL) = app_settings.terms_version`. Se não bater → bloqueia entrada até re-aceitar.

**Telemetria gate:**
- Default: `purpose='telemetry'` NÃO tem consent ativo (opt-in explícito necessário)
- Cliente `Telemetry.error/event` verifica consent ANTES de POST:
  ```dart
  if (await consentService.hasActiveConsent('telemetry')) {
    await api.postTelemetry(scrubbed_payload);
  }
  ```
- UI Settings → Privacidade: toggle "Permitir coleta de telemetria de erros"

**Revogação:**
- UI: "Revogar consentimento" por finalidade
- Trigger: `UPDATE consent_log SET revoked_at=now(), revoked_reason='user_request'`
- Telemetria revogada: cliente para de enviar imediatamente; backend purga `client_telemetry WHERE user_id=me` no DELETE/PATCH endpoint
- Termos/privacidade revogados: bloqueia acesso, oferece reaceitar ou deletar conta

### 5.10 Sentinel actors — não pollute `auth.users`

**IMPORTANTE:** Não inserir diretamente em `auth.users` — quebra invariantes do GoTrue (sem hash de senha, sem `auth.identities`, sem `aud`/`role`/`instance_id`). Solução: tabela própria `system_actors` que armazena UUIDs estáveis usados como ponteiros "fora-de-`auth.users`".

```sql
CREATE TABLE system_actors (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL UNIQUE
                 CHECK (kind IN ('deleted_user', 'system_worker', 'system_admin_bootstrap')),
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Seeds determinísticos (UUIDs fixos pra referência cruzada estável)
INSERT INTO system_actors (id, kind, display_name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'deleted_user',           'Usuário removido'),
  ('00000000-0000-0000-0000-000000000002', 'system_worker',          'Sistema'),
  ('00000000-0000-0000-0000-000000000003', 'system_admin_bootstrap', 'Admin (bootstrap)');
```

**Implicação para FKs:** todas as colunas FK que referenciam `auth.users(id)` precisam permitir que o valor seja um id de `system_actors` quando o usuário original foi deletado. **Não** podem ter FK constraint forte pra `auth.users` se o valor pode ser sentinel.

**3 abordagens viáveis (escolher 1):**

| Abordagem | Como | Trade-off |
|---|---|---|
| **A. Remover FK constraints** das colunas de audit; manter apenas `uuid` | Mais simples; cada query de detalhe faz join opcional com `auth.users UNION ALL system_actors` | Sem integridade referencial em audit fields |
| **B. View `actor_users`** = `auth.users UNION ALL system_actors` (com colunas comuns); FKs apontam pra essa view via FK em VIEW (Postgres 14+ suporta) | Integridade preservada via VIEW + constraint trigger | Mais complexo |
| **C. Tabela `actor_users` materializada** + trigger que mantém sincronia | Robustez máxima | Mais infra |

**Decisão MVP:** **Abordagem A** — remover FK constraints das colunas de audit (`created_by`, `updated_by`, `paid_by`, `invited_by`, `actor_user_id`, `changed_by`, `granted_by`, `used_by`). Manter `uuid` puro, validação de integridade fica no app + check constraint opcional:

```sql
-- Exemplo aplicado em invoices (similar em outras tabelas):
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_paid_by_fkey;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_created_by_fkey;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_updated_by_fkey;

-- Helper pra exibir display name em queries:
CREATE OR REPLACE FUNCTION user_display_name(actor_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT raw_user_meta_data ->> 'display_name' FROM auth.users WHERE id = actor_id),
    (SELECT display_name FROM system_actors WHERE id = actor_id),
    'Desconhecido'
  );
$$;
```

**Distinção importante:** colunas `owner_user_id` (em `connected_emails`) e `user_id` (em `members`, `consent_log`, etc.) — essas continuam com FK pra `auth.users` porque representam o **dono real** (não um ponteiro histórico de audit). Quando o user é deletado, essas rows são HARD-deletadas ou tratadas explicitamente (ver §9.4).

### Anonymize function (versão completa)

```sql
CREATE OR REPLACE FUNCTION anonymize_user_references(target_user_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  sentinel uuid := '00000000-0000-0000-0000-000000000001';  -- 'deleted_user' actor
BEGIN
  -- ============================================================
  -- 1. Audit fields → sentinel (deleted_user actor)
  -- ============================================================
  -- households
  UPDATE households SET created_by = sentinel WHERE created_by = target_user_id;

  -- members (invited_by é audit; user_id é ownership e é tratado abaixo)
  UPDATE members SET invited_by = sentinel WHERE invited_by = target_user_id;

  -- household_invitations
  UPDATE household_invitations SET created_by = sentinel WHERE created_by = target_user_id;
  UPDATE household_invitations SET used_by    = sentinel WHERE used_by    = target_user_id;

  -- invoices
  UPDATE invoices SET paid_by    = sentinel WHERE paid_by    = target_user_id;
  UPDATE invoices SET created_by = sentinel WHERE created_by = target_user_id;
  UPDATE invoices SET updated_by = sentinel WHERE updated_by = target_user_id;

  -- app_settings + history
  UPDATE app_settings         SET updated_by = sentinel WHERE updated_by = target_user_id;
  UPDATE app_settings_history SET changed_by = sentinel WHERE changed_by = target_user_id;

  -- domain_events
  UPDATE domain_events SET actor_user_id = sentinel WHERE actor_user_id = target_user_id;

  -- ============================================================
  -- 2. Ownership fields que devem ser tratados específicamente
  -- ============================================================
  -- consent_log: LGPD obriga retenção de evidência de consentimento.
  -- Anonimizamos user_id pra sentinel + scrub PII colaterais.
  UPDATE consent_log
     SET user_id = sentinel, ip_address = NULL, user_agent = NULL
   WHERE user_id = target_user_id;

  -- connected_emails: ownership é do user; soft-deletado em §9.4 step 3.
  -- HARD-DELETE aqui pra liberar FK antes do auth.users DELETE em §9.4 step 8.
  DELETE FROM connected_emails
   WHERE owner_user_id = target_user_id AND deleted_at IS NOT NULL;

  -- members: ownership; HARD-DELETE rows soft-deletadas (idem).
  DELETE FROM members
   WHERE user_id = target_user_id AND deleted_at IS NOT NULL;

  -- client_telemetry: PII; DELETE total (já feito em §9.4 step 6, repetimos por idempotência).
  DELETE FROM client_telemetry WHERE user_id = target_user_id;
END;
$$;
```

**Auditoria contínua via CI:** rodar query abaixo no CI; se aparecer FK nova pra `auth.users` que não está enumerada em `anonymize_user_references`, build falha:

```sql
-- Lista todas FK colunas que apontam pra auth.users:
SELECT
  conrelid::regclass AS table_name,
  conname,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE confrelid = 'auth.users'::regclass
  AND contype = 'f';
```

CI compara saída com lista canônica em `supabase/tests/anonymize_coverage.sql` (pgTAP test).

### Test obrigatório (pgTAP)

```sql
-- supabase/tests/anonymize_user_references.test.sql
BEGIN;
SELECT plan(N);

-- setup: cria user + popula TODAS as FKs (households, members, invoices, settings, consent, etc.)
-- act: SELECT anonymize_user_references(<user_id>);
-- assert: auth.users DELETE succeeds sem FK violation;
-- assert: linhas relevantes apontam pra sentinel;
-- assert: client_telemetry vazia.

SELECT * FROM finish();
ROLLBACK;
```

### 5.11 RLS — resumo de policies

**⚠️ Schema `auth` é gerenciado pelo Supabase (GoTrue) — não instalar objetos próprios lá.** Helpers vão em schema dedicado `app`:

```sql
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app.households_of_user() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT household_id FROM public.members
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION app.households_of_user() TO authenticated;

CREATE OR REPLACE FUNCTION app.is_household_admin(h uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.members
    WHERE household_id = h AND user_id = auth.uid()
      AND role = 'admin' AND deleted_at IS NULL
  );
$$;
GRANT EXECUTE ON FUNCTION app.is_household_admin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app.is_system_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  -- coerção defensiva: empty string ou claim ausente → false
  SELECT coalesce(
    NULLIF(auth.jwt() -> 'app_metadata' ->> 'is_system_admin', '')::boolean,
    false
  );
$$;
GRANT EXECUTE ON FUNCTION app.is_system_admin() TO authenticated;
```

**Todas as references no spec** que mencionam `auth.households_of_user()`, `auth.is_household_admin()`, `auth.is_system_admin()` referem-se a `app.households_of_user()` etc. — schema `app` é a localização oficial.

Policies — síntese:

| Tabela | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `households` | member-of | admin-of |
| `members` | member-of household | admin-of household |
| `connected_emails` | owner OR admin-of-bound-household | owner OR admin-of-bound-household |
| `connected_email_households` | member-of household | admin-of household |
| `invoices` | member-of household | member-of household (write) |
| `invoice_categories` | member-of household | admin-of household |
| `app_settings` (global) | sys admin (or read all) | sys admin only |
| `app_settings` (household) | member-of household | admin-of household |
| `app_settings` (user) | own | own |
| `app_settings_history` | replica predicate completo do parent: `(scope='global' AND auth.is_system_admin()) OR (scope='household' AND scope_id IN auth.households_of_user()) OR (scope='user' AND scope_id = auth.uid())` | service_role only |
| `domain_events` | **`(household_id IS NOT NULL AND household_id IN (SELECT auth.households_of_user())) OR auth.is_system_admin()`** — eventos sys-wide (household_id NULL: `system_admin.*`, `capacity.*`, `ai.chain.*`, `user.deleted`) ficam visíveis a sys admins via UI `/sys-admin/events` | service_role only |
| `sync_runs`/`extraction_runs` | **EXISTS join cross-household via `connected_email_households`/`invoices` cruzando `auth.households_of_user()`** — não basta "via FK" porque `connected_email_id` é many-to-many. Policy template: `EXISTS (SELECT 1 FROM connected_email_households ceh WHERE ceh.connected_email_id = sync_runs.connected_email_id AND ceh.household_id IN (SELECT auth.households_of_user()) AND ceh.deleted_at IS NULL)` | service_role only |
| `ai_calls` | member-of household (via `household_id` quando populado); sys admin sees all (`OR auth.is_system_admin()`) | service_role only |
| `client_telemetry` | own; sys admin sees all (`auth.is_system_admin()`) | own (apenas POST/PATCH dos próprios records) |
| `eviction_runs`/`capacity_snapshots`/`health_snapshots` | sys admin only (`auth.is_system_admin()`) | service_role only |
| `consent_log` | own; sys admin sees all (audit) | own (INSERT no signup; UPDATE só para `revoked_at`) |
| `household_invitations` | admin-of household | admin-of household |
| `pdf_archive_log` | member-of household (via invoice FK: `EXISTS (SELECT 1 FROM invoices i WHERE i.id = pdf_archive_log.invoice_id AND i.household_id IN auth.households_of_user())`) | service_role only |
| `utility_parsers` | **authenticated only** (não anon — evita expor regex/fingerprints internos pra Internet via Supabase URL pública) | service_role only |
| `system_actors` | authenticated read (precisa pra mostrar "Usuário removido" em listings) | service_role only |
| `vault.*` | NO RLS — só service_role acessa via SECURITY DEFINER |
| `circuit_breakers`/`rate_limit_buckets` | NO RLS — só workers via service_role |

**Patterns de policy (referência DDL):**

```sql
-- Pattern A: member-of household (SELECT)
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (household_id IN (SELECT app.households_of_user()));

-- Pattern B: admin-of household (UPDATE/DELETE escrita)
CREATE POLICY invoice_categories_admin_write ON invoice_categories FOR ALL
  USING (app.is_household_admin(household_id))
  WITH CHECK (app.is_household_admin(household_id));

-- Pattern C: owner-of (próprio user)
CREATE POLICY user_profiles_self_update ON user_profiles FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Pattern D: cross-binding via EXISTS join (sync_runs, observability)
CREATE POLICY sync_runs_select ON sync_runs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM connected_email_households ceh
      WHERE ceh.connected_email_id = sync_runs.connected_email_id
        AND ceh.household_id IN (SELECT app.households_of_user())
        AND ceh.deleted_at IS NULL
    )
    OR app.is_system_admin()
  );

-- Pattern E: sys admin only
CREATE POLICY eviction_runs_select ON eviction_runs FOR SELECT
  USING (app.is_system_admin());

-- Pattern F: scope-aware (app_settings)
CREATE POLICY settings_select ON app_settings FOR SELECT
  USING (
    (scope = 'global')
    OR (scope = 'household' AND scope_id IN (SELECT app.households_of_user()))
    OR (scope = 'user' AND scope_id = auth.uid())
  );
CREATE POLICY settings_global_write ON app_settings FOR ALL
  USING (scope = 'global' AND app.is_system_admin())
  WITH CHECK (scope = 'global' AND app.is_system_admin());
CREATE POLICY settings_household_write ON app_settings FOR ALL
  USING (scope = 'household' AND app.is_household_admin(scope_id))
  WITH CHECK (scope = 'household' AND app.is_household_admin(scope_id));
CREATE POLICY settings_user_write ON app_settings FOR ALL
  USING (scope = 'user' AND scope_id = auth.uid())
  WITH CHECK (scope = 'user' AND scope_id = auth.uid());
```

**Cobertura via pgTAP obrigatória (cross-tenant + cross-binding):**
- Cada policy listada acima tem teste em `supabase/tests/rls/<tabela>.test.sql`
- Cenários: 2 users em households diferentes; user com email em 2 households simultâneos (testa sync_runs/extraction_runs leakage); sys admin acessa tudo
- CI quebra se RLS quebrar (mesma regra do data-dictionary CI check)

### 5.12 User profiles

`auth.users.raw_user_meta_data` é mutável pelo próprio user via JS (não controlado) e Supabase recomenda **NÃO** referenciar pra display fields. Solução: tabela própria.

```sql
CREATE TABLE user_profiles (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  avatar_url   text,
  locale       text NOT NULL DEFAULT 'pt-BR' CHECK (locale IN ('pt-BR', 'en-US')),
  theme        text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Trigger: cria profile automaticamente no signup
CREATE OR REPLACE FUNCTION create_user_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO user_profiles (user_id, display_name)
  VALUES (NEW.id, coalesce(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_create_user_profile
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION create_user_profile();
```

**RLS:**
- SELECT: qualquer member de household que compartilha com o user pode ver `display_name`/`avatar_url` (necessário pra listings de membros)
- UPDATE: só o próprio user

**Helper `user_display_name()`** (§5.10) atualiza pra consultar `user_profiles` primeiro:
```sql
CREATE OR REPLACE FUNCTION user_display_name(actor_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT display_name FROM user_profiles WHERE user_id = actor_id),
    (SELECT display_name FROM system_actors WHERE id = actor_id),
    'Desconhecido'
  );
$$;
```

**Invite matching:** `household_invitations.invited_email` é matched contra `auth.users.email` (mantido pelo GoTrue, normalizado lowercase). Quando user aceita convite (`POST /invitations/redeem`), Edge Function valida `auth.email() == invitation.invited_email` (se invited_email não-NULL).

### 5.13 Storage layout

Bucket `invoices` (privado):
```
household-<uuid>/
  YYYY-MM/
    <invoice_uuid>.pdf
```

Bucket `archives` (privado, para domain_events arquivados):
```
domain_events/
  YYYYMM/
    <batch_hash>.jsonl.gz
```

Bucket `private-exports` (privado, TTL 24h para exports LGPD):
```
exports/
  <user_uuid>/
    <yyyymmddhhmmss>.zip
```

---

## 6. Pipeline de ingestão

### 6.1 Fluxo macro

```
┌────────────────────────────────────────────────────┐
│ pg_cron (1min) → POST /sync-dispatcher              │
└────────────────────────────────────────────────────┘
                       │
                       ▼
   ┌────────────────────────────────────────────────────┐
   │ Edge Function: sync-dispatcher                      │
   │  1. Lê app_settings (snapshot)                     │
   │  2. Gate em features.ingestion_enabled              │
   │  3. SELECT emails ativos com sync vencido           │
   │  4. Filtra emails com chain circuit closed/half     │
   │  5. ENFILEIRA em email_sync_queue (idempotency_key) │
   └────────────────────────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────┐
│ pg_cron (1min) → POST /sync-worker                  │
└────────────────────────────────────────────────────┘
                       │
                       ▼
   ┌─────────────────────────────────────────────────────┐
   │ Edge Function: sync-worker                          │
   │  1. pgmq.read('email_sync_queue', vt=120s, count=N) │
   │  Para cada msg:                                      │
   │   a. Idempotency check (sync_runs.idempotency_key)  │
   │   b. Circuit breaker check (imap:email_address)     │
   │   c. Rate limit check (imap_fetch:email_address)    │
   │   d. INSERT sync_runs status='running'              │
   │   e. Conecta IMAP (via Vault.decrypt app password)  │
   │   f. SEARCH UID > last_processed_uid                │
   │   g. Por mensagem:                                  │
   │      - dedupe Message-ID                            │
   │      - dedupe file_hash                             │
   │      - resolve household via binding                │
   │      - upload Storage                               │
   │      BEGIN TX:                                       │
   │        INSERT invoices (status='queued')             │
   │        pgmq.send('invoice_queue', payload)          │
   │        INSERT domain_events 'invoice.created'        │
   │      COMMIT                                          │
   │      UPDATE last_processed_uid (incremental)         │
   │   h. UPDATE sync_runs status='success', counters    │
   │   i. UPDATE connected_emails last_sync_at, etc.     │
   │   j. RESET circuit_breaker on success                │
   │   k. pgmq.delete(msg)                                │
   │  Erro: backoff exponencial via pgmq.set_vt          │
   │        After max_retries → DLQ + emit event         │
   └─────────────────────────────────────────────────────┘
```

### 6.2 Configs principais (defaults)

| Key | Default |
|---|---|
| `features.ingestion_enabled` | true |
| `sync.interval_minutes` | 60 |
| `sync.batch_size` | 3 |
| `sync.lookback_days` | 7 |
| `sync.first_sync_lookback_days` | 90 |
| `sync.fetch_max_runtime_ms` | 50000 |
| `sync.visibility_timeout_s` | 120 |
| `sync.consecutive_error_threshold` | 5 |
| `sync.max_retries` | 3 |
| `sync.retry_base_s` | 60 |
| `sync.retry_cap_s` | 1800 |
| `sync.imap_connect_timeout_ms` | 10000 |
| `sync.imap_fetch_timeout_ms` | 20000 |

### 6.3 Resolução de household via binding

```typescript
async function resolveTargetHousehold(emailId): Promise<string> {
  const bindings = await db.from('connected_email_households')
    .select('household_id, is_default')
    .eq('connected_email_id', emailId)
    .is('deleted_at', null);

  if (!bindings?.length) throw new Error('No household binding');
  if (bindings.length === 1) return bindings[0].household_id;

  const def = bindings.find(b => b.is_default);
  if (!def) throw new Error('Multiple bindings without default');
  return def.household_id;

  // Futuro (roadmap "caminho claro"): connected_email_routing_rules
  // permite roteamento por installation_id, payee_name, etc.
}
```

### 6.4 IMAP fetch detalhado — biblioteca, dedupe, PDF detection

Lib escolhida: **`npm:imapflow`** (compatível com Deno via `npm:` specifier, ativo, suporta IDLE/UID/fetch parts/STARTTLS, Apache 2.0).

```typescript
import { ImapFlow } from 'npm:imapflow';

const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: email_address, pass: decryptedAppPassword },
  logger: false,                    // ⚠️ false — evita logar credenciais
  emitLogs: false,
  tls: { rejectUnauthorized: true }
});

await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
  // UID search (incremental)
  const since = lastProcessedUid ?? Math.max(0, await earliestUidInLookback(client, days=90));
  const uids = await client.search({ uid: `${since + 1}:*` }, { uid: true });
  
  for (const uid of uids) {
    if (Date.now() - startTime > cfg.fetch_max_runtime_ms) {
      break;  // próxima rodada continua do last_processed_uid
    }
    
    // Fetch parcial: headers + bodystructure primeiro (leve)
    const msg = await client.fetchOne(uid, {
      uid: true, envelope: true, bodyStructure: true, internalDate: true,
      headers: ['From', 'To', 'Subject', 'Message-ID', 'Date']
    }, { uid: true });
    
    const messageId = msg.envelope.messageId;
    const sender = msg.envelope.from?.[0]?.address ?? '';
    const subject = msg.envelope.subject ?? '';
    
    // Dedupe nível 1: Message-ID já visto neste connected_email?
    if (await invoiceExists({ connected_email_id, source_message_id: messageId })) {
      await updateCursor(uid);
      continue;
    }
    
    // Itera bodyStructure pra encontrar partes PDF
    const pdfParts = findPdfParts(msg.bodyStructure, {
      max_size_bytes: cfg.pdf_max_size_bytes,   // default 10 MB
      min_size_bytes: cfg.pdf_min_size_bytes    // default 10 KB
    });
    
    for (const part of pdfParts) {
      const { content } = await client.download(uid, part.partID, { uid: true });
      const pdfBuffer = await streamToBuffer(content);
      
      // Validação por magic bytes (não só Content-Type/filename — emails forjam):
      if (!pdfBuffer.slice(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
        continue;  // %PDF magic bytes
      }
      
      const fileHash = sha256(pdfBuffer);
      
      // Dedupe nível 2: file_hash já no household?
      if (await invoiceExists({ household_id, file_hash: fileHash })) {
        continue;
      }
      
      // Storage upload + INSERT invoice + enqueue (TX única)
      const path = `household-${household_id}/${yearMonth()}/${uuid()}.pdf`;
      await storage.upload(path, pdfBuffer);
      
      await db.transaction(async (tx) => {
        const inv = await tx.from('invoices').insert({
          household_id, connected_email_id, source_message_id: messageId,
          source_uid: uid, source_received_at: msg.internalDate,
          source_sender: sender, source_subject: subject,
          storage_path: path, file_hash: fileHash,
          file_size_bytes: pdfBuffer.length, mime_type: 'application/pdf',
          status: 'queued', correlation_id, idempotency_key: `${connected_email_id}:${messageId}:${fileHash}`
        }).select('id').single();
        
        await tx.rpc('pgmq_send', {
          queue_name: 'invoice_queue',
          msg: { invoice_id: inv.id, household_id, correlation_id, attempt: 1 }
        });
        
        await tx.from('domain_events').insert({
          event_type: 'invoice.created', aggregate_type: 'invoice', aggregate_id: inv.id,
          household_id, correlation_id, actor_type: 'worker',
          payload: { version: 1, data: { sender, subject, file_size_bytes: pdfBuffer.length } }
        });
      });
    }
    
    await updateCursor(uid);
  }
} finally {
  lock.release();
  await client.logout();   // ⚠️ sempre, mesmo em erro
}
```

**Configs adicionais:**
```
sync.pdf_min_size_bytes = 10240       # 10 KB (descarta thumbnails/anexos espúrios)
sync.pdf_max_size_bytes = 10485760    # 10 MB (cap; PDFs maiores vão pra DLQ pra análise)
sync.gmail_max_concurrent_connections = 5    # Gmail limita ~15 por conta
sync.attachment_max_per_message = 5   # protege contra emails com 100 PDFs (spam)
```

**`findPdfParts()`** itera recursivamente `bodyStructure` procurando partes com `type='application'` E `subtype='pdf'` (case-insensitive), validando faixa de tamanho.

### 6.5 Vault decrypt — redação obrigatória de secrets em logs

App password decifrada NUNCA pode aparecer em:
- `console.log` / `console.error` / structured logs
- Stack traces de exceções (libs IMAP às vezes ecoam `LOGIN user pass` em erros verbose)
- `sync_runs.error_summary`, `connected_emails.last_error`
- `domain_events.payload`
- Telemetria, logs externos

**Implementação obrigatória:**

```typescript
// supabase/functions/_shared/redact.ts

const SECRET_PATTERNS = [
  // App passwords Gmail: 16 chars lowercase a-z (formatados ou não)
  /\b([a-z]{4}[\s-]?){4}\b/gi,
  // Authorization headers
  /Authorization:\s*Bearer\s+\S+/gi,
  /Authorization:\s*Basic\s+\S+/gi,
  // IMAP LOGIN command echo
  /LOGIN\s+\S+\s+\S+/gi,
  // PIX/PII patterns (números longos, CPF/CNPJ)
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,    // CPF
  /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,  // CNPJ
];

export function redactSecrets(s: string | undefined | null): string {
  if (!s) return '';
  let out = s;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}
```

**Aplicado em:** todo `INSERT/UPDATE` em colunas de erro (`error_summary`, `last_error`, `extraction_error`, `domain_events.payload.data.error`). Middleware `withRedaction()` envolve handlers de erro do worker.

**Variável local:** `const password = await vault.decrypt(secret_id)` deve ser limpa em `finally`:
```typescript
let password: string | null = null;
try {
  password = await vault.decrypt(secret_id);
  await imap.connect({ pass: password, ... });
  // ...
} finally {
  password = null;  // libera referência
  await client?.logout();
}
```

**Test obrigatório (pgTAP + Deno test):** injeta erro IMAP simulado contendo a senha; verifica que nenhum INSERT em `sync_runs`/`connected_emails`/`domain_events` contém o valor original.

### 6.6 pg_cron + pg_net — wrapper completo

`pg_cron` não faz HTTP; precisa de `pg_net.http_post` wrapped em SECURITY DEFINER. Service_role key fica em DB config (não hardcoded).

**Setup (uma vez):**

```sql
-- Guarda service_role key em GUC do DB (não em tabela visível por RLS):
ALTER DATABASE postgres SET app.service_role_key = '<jwt-service-role>';
ALTER DATABASE postgres SET app.edge_function_base = 'https://<project>.supabase.co/functions/v1';
-- (rotate procedure: ALTER DATABASE ... + restart todas connections)

-- Wrapper helper SECURITY DEFINER (evita expor a key em outras schemas):
CREATE OR REPLACE FUNCTION private.invoke_edge_function(fn_name text, body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint   -- pg_net retorna request_id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  request_id bigint;
BEGIN
  SELECT net.http_post(
    url := current_setting('app.edge_function_base') || '/' || fn_name,
    body := body,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json',
      'x-correlation-id', gen_random_uuid()::text
    ),
    timeout_milliseconds := 5000
  ) INTO request_id;
  RETURN request_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.invoke_edge_function FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION private.invoke_edge_function TO postgres;
```

**Cron schedules:**

```sql
SELECT cron.schedule('unibill-sync-dispatcher',    '* * * * *',
  $$SELECT private.invoke_edge_function('sync-dispatcher')$$);
SELECT cron.schedule('unibill-sync-worker',        '* * * * *',
  $$SELECT private.invoke_edge_function('sync-worker')$$);
SELECT cron.schedule('unibill-extraction-worker',  '* * * * *',
  $$SELECT private.invoke_edge_function('extraction-worker')$$);
SELECT cron.schedule('unibill-capacity-monitor',   '*/5 * * * *',
  $$SELECT private.invoke_edge_function('capacity-monitor')$$);
SELECT cron.schedule('unibill-capacity-evictor',   '* * * * *',
  $$SELECT private.invoke_edge_function('capacity-evictor')$$);
```

**`pg_net` é assíncrono** — `net.http_post` retorna `request_id` imediatamente; resposta vai pra `net._http_response`. Não tratamos resposta no cron (workers fazem self-tracking via `sync_runs`/`extraction_runs`). Cleanup de respostas antigas:

```sql
SELECT cron.schedule('cleanup-pg-net-responses', '0 5 * * *',
  $$DELETE FROM net._http_response WHERE created < now() - interval '7 days'$$);
```

**Observações:**
- `service_role` JWT bypassa RLS — qualquer pessoa com essa key tem acesso total. Rotação documentada em runbook.
- Edge Function `/sync-dispatcher` etc. **devem verificar** o `Authorization` header chega como `Bearer <service_role>` antes de processar (defense-in-depth contra invocação externa).

### 6.7 Auto-pause em falhas consecutivas

```typescript
if (newConsecutiveErrors >= cfg.consecutive_error_threshold) {
  await db.from('connected_emails').update({
    status: 'error',
    last_error: 'Auto-paused after consecutive failures'
  }).eq('id', emailId);
  await emitDomainEvent({ type: 'email.sync.auto_paused', ... });
}
```

Reativação manual via UI (sys admin ou owner do email).

---

## 7. Pipeline de extração

### 7.1 4 camadas

```
PDF (Storage) → Layer 1 → Layer 2 → Layer 3 → Layer 4 → invoice extraída
                pdfjs    OCR API    Regex     AI fallback
                native   chain      per-utility chain
                texto    (hosted)               (Gemini→Groq→OR)
```

Layer 2 e 4 são **condicionais** (só rodam se anteriores não bastaram).

**Decisão arquitetural-chave (firmada em 2026-06-09):** Layer 2 NÃO usa Tesseract em Edge Function — usa **chain de OCR API hospedada** (OCR.space → Google Vision). Razões: Edge Function Deno tem CPU limit ~2s no free tier, e Tesseract WASM (~10MB) + canvas rendering pra rasterizar PDF estouram esse limite. APIs hospedadas têm free tier folgado pro volume Unibill (6 OCR ops/mês steady-state) e seguem o mesmo padrão pluggable de chain que já temos pra AI providers. Self-host via microservice (Oracle Always Free / Cloud Run) está em roadmap §13.1 como próxima feature.

### 7.2 Layer 1 — pdfjs native text

```typescript
const l1 = await extractTextWithPdfjs(pdf);
if (l1.chars >= cfg.layer1_min_chars && l1.density >= cfg.layer1_min_density) {
  // texto extraído nativamente
} else {
  needsOcr = true;
}
```

Configs:
- `extraction.layer1_min_chars` = 300
- `extraction.layer1_min_density` = 0.05

### 7.3 Layer 2 — OCR via chain de API hospedada

#### Por que API hospedada (não tesseract.js local)

Edge Function Deno tem CPU ~2s no free tier + canvas rendering pra rasterizar PDF não é prático. APIs hospedadas resolvem em ~2-5s/página, sem CPU local. Quotas free cobrem Unibill por décadas (volume real: ~6 OCR ops/mês steady-state, ~50 no backfill inicial).

#### Adapter chain (mesmo padrão da AI chain §7.5)

```typescript
interface OcrProvider {
  name: string;
  ocrPdfPage(pdfPage: Uint8Array, ctx: CallContext): Promise<{ text: string; confidence: number }>;
}

class OcrSpaceProvider implements OcrProvider { ... }
class GoogleVisionProvider implements OcrProvider { ... }
// roadmap §13.1:
// class SelfHostedMicroserviceProvider implements OcrProvider { ... }

class OcrClient {
  async ocrPdfPage(pdfPage, ctx) {
    const chain = await getConfig('extraction.ocr_chain', ['ocr_space', 'google_vision']);
    let lastError = null;
    for (const providerName of chain) {
      try {
        return await withCircuitBreaker('ocr_provider', providerName, async () => {
          await withRateLimit('ocr_call', providerName, getOcrLimit(providerName), '1day');
          const result = await callProvider(providerName, pdfPage, ctx);
          await logOcrCall({ provider: providerName, status: 'success', ...ctx });
          return result;
        });
      } catch (err) {
        await logOcrCall({ provider: providerName, status: classifyError(err), error: err.message, ...ctx });
        lastError = err;
      }
    }
    throw new NoOcrProviderAvailableError(chain, lastError);
  }
}
```

`OcrClient` herda **circuit breaker per-provider** + **rate limit per-provider** + **logging** — exatamente como AI chain. Reusa `circuit_breakers` table (resource_type='ocr_provider').

#### Early-exit por página (mantido)

```
para cada página (até max_pages=4):
  pdfPageBytes = extractPdfPage(pdfBuffer, página)   # pdfjs no Edge Function divide o PDF
  texto_pagina = await ocrClient.ocrPdfPage(pdfPageBytes, ctx)   # chama API
  texto_acumulado += texto_pagina
  campos = layer3.extract(texto_acumulado)

  se TODOS de required_fields_complete presentes:
    early_exit 'all_complete'
  se TODOS de required_fields_minimum presentes E página >= 2:
    early_exit 'minimum_after_2_pages'

se chegou em max_pages:
  return 'max_pages_reached'
```

Vantagem extra do API: **cada API call já vem com confidence próprio** (OCR.space e Vision retornam scores) — entra como sinal adicional pra `confidence_final`.

#### Configs

```
extraction.ocr_chain = ["ocr_space", "google_vision"]      # ordem de tentativa
extraction.ocr_timeout_ms = 30000
extraction.required_fields_minimum = ["amount_cents", "due_date", "barcode_or_pix"]
extraction.required_fields_complete = ["amount_cents", "due_date", "barcode", "pix_payload"]
extraction.minimum_capture_min_pages = 2
extraction.ocr_max_pages = 4

# OCR.space (primário)
extraction.ocr_space.endpoint = "https://api.ocr.space/parse/image"
extraction.ocr_space.api_key_secret_id = "<vault uuid>"
extraction.ocr_space.language = "por"               # português
extraction.ocr_space.daily_limit = 800              # quota free ~25k/mês = ~830/dia, margem
extraction.ocr_space.engine = 2                     # OCR engine 2 (recomendado pra PT)

# Google Vision (fallback)
extraction.google_vision.endpoint = "https://vision.googleapis.com/v1/images:annotate"
extraction.google_vision.api_key_secret_id = "<vault uuid>"
extraction.google_vision.language_hints = ["pt-BR"]
extraction.google_vision.daily_limit = 30           # quota free 1k/mês = ~33/dia
extraction.google_vision.feature = "DOCUMENT_TEXT_DETECTION"
```

API keys ficam em **Supabase Vault** (mesmo padrão das app passwords de Gmail).

#### Tracking de calls

Pode reusar `ai_calls` table ou criar `ocr_calls` espelhada. **Decisão MVP: reusar `ai_calls`** com `provider IN ('ocr_space','google_vision')` e `purpose='ocr'` — economiza tabela, métricas de custo/quota integradas no mesmo dashboard.

```sql
-- ai_calls.purpose passa a aceitar 'ocr' além de 'extraction','categorization','chat'
-- ai_calls.provider passa a aceitar nomes de OCR providers
-- ai_calls.model fica NULL pra OCR (não tem model id)
-- ai_calls.prompt_tokens/completion_tokens ficam NULL pra OCR
-- pages_processed int adicionado pra OCR usage tracking
ALTER TABLE ai_calls ADD COLUMN pages_processed int;
```

#### OCR chain breaker (auto-disable em falhas sustentadas)

Reusar **mesmo padrão da AI chain breaker (§7.6)** — se TODOS providers OCR falharem por X tempo:
- Marca invoice `status='needs_review'`, `needs_review_reason='ocr_chain_open'`
- Banner em UI sys admin
- Auto-recovery via half-open probes

Configs espelham `ai.chain.*`:
```
ocr.chain.auto_disable_enabled = true
ocr.chain.window_sec = 600
ocr.chain.min_samples = 4
ocr.chain.failure_ratio = 1.0
ocr.chain.cooldown_sec = 900
ocr.chain.probe_success_required = 2
```

#### Ganho prático mantido

~85% das faturas processadas em 1-2 páginas via OCR API. Latência: 2-5s/página vs 5-30s/página com Tesseract local. **Mais rápido** e **sem estourar Edge Function timeout**.

### 7.4 Layer 3 — Regex per-utility

```typescript
const candidates = await db.from('utility_parsers').select('*').eq('active', true);
const match = candidates.find(p =>
  p.sender_patterns.some(rgx => new RegExp(rgx).test(invoice.source_sender ?? '')) ||
  p.body_must_contain.every(s => text.includes(s))
);
if (!match) return { matched: false, confidence: 0 };

const extracted = {
  utility_key: match.utility_key,
  amount_cents: parseAmount(text.match(match.amount_regex)?.[1]),
  due_date: parseDate(text.match(match.due_date_regex)?.[1], match.due_date_format),
  barcode: text.match(match.barcode_regex)?.[1],
  pix_payload: text.match(match.pix_regex)?.[1],
  // ...
};

// confidence:
// - complete (4/4 campos) → 1.0
// - minimum (3/3) → 0.85
// - abaixo → cai pra Layer 4
```

### 7.5 Layer 4 — AI provider chain

Interface `AiProvider` + classes `GeminiProvider`, `GroqProvider`, `OpenRouterProvider`. `AiClient.extractStructured(text, schema, ctx)` tenta cada provider da chain configurada, com:
- circuit breaker per-provider
- rate limit per-provider
- timeout configurável
- logging em `ai_calls` por tentativa

```typescript
class AiClient {
  async extractStructured(text, schema, ctx) {
    // 1. Check chain-level breaker
    const chainState = await getCircuitState('ai_chain', 'extraction_default');
    if (chainState.state === 'open') throw new ChainOpenError();

    // 2. Try chain providers
    const chain = await getConfig('ai.providers.extraction.chain', ['gemini','groq','openrouter']);
    let lastError = null;
    for (const provider of chain) {
      try {
        return await withCircuitBreaker('ai_provider', provider, async () => {
          await withRateLimit('ai_call', provider, getLimit(provider), '1day');
          const result = await callProvider(provider, text, schema, ctx);
          await logAiCall({ provider, status: 'success', ...result.tokens, ...ctx });
          return result;
        });
      } catch (err) {
        await logAiCall({ provider, status: classifyError(err), error_summary: err.message, ...ctx });
        lastError = err;
      }
    }
    throw new NoProviderAvailableError(chain, lastError);
  }
}
```

Configs:

| Key | Default |
|---|---|
| `ai.providers.extraction.chain` | `["gemini","groq"]` (MVP; OpenRouter adicionado quando `ai.openrouter.enabled=true`) |
| `ai.gemini.daily_limit` | 1000 |
| `ai.groq.daily_limit` | 10000 |
| `ai.openrouter.enabled` | false |
| `ai.gemini.model` | `"gemini-2.0-flash-001"` (pinar versão; aliases não-versionados podem ser depreciados) |
| `ai.groq.model` | a definir no deploy — Groq decomissionou `llama-3.2-90b-vision-preview` em 2025; verificar [console.groq.com/docs/models](https://console.groq.com/docs/models) e pinar version atual (provável: `meta-llama/llama-4-scout-17b-16e-instruct` ou sucessor) |

**Smoke test no deploy:** adicionar step ao §11.5 que faz 1 call de teste (1-token prompt) em cada provider configurado. Aborta deploy se 404. Modelos vivem em `app_settings` (hot-swap sem redeploy).
| `ai.timeout_ms` | 30000 |

#### 7.5.1 Classificação de erros (`classifyError` → `ai_calls.status`)

| Condição | `ai_calls.status` | Conta no per-provider breaker? | Conta no chain breaker? |
|---|---|---|---|
| HTTP 200 + JSON válido | `success` | reseta failures | — |
| HTTP 429 (rate limit) | `rate_limited` | sim | sim |
| HTTP 402 / `quota_exceeded` / `insufficient_quota` | `quota_exceeded` | sim | **trip imediato** (`ai.chain.quota_exceeded_immediate=true`) |
| HTTP 5xx | `error` | sim | sim |
| HTTP 4xx (não-429/402) | `error` | sim | sim |
| Timeout (>`ai.timeout_ms`) | `timeout` | sim | sim |
| Network / DNS / connection refused | `error` | sim | sim |
| Resposta 200 mas JSON inválido (parse fail) | `invalid_response` | NÃO (não é problema do provider) | sim (`ai.chain.invalid_response_counts=true`) — captura silent quality degradation |
| Schema mismatch (Zod fail no JSON) | `invalid_response` | NÃO | sim |
| Per-provider breaker já aberto | `circuit_open` | — (já estava) | sim (mantém contagem) |
| Recusa do modelo ("não posso ajudar") gerando JSON inválido | `invalid_response` | NÃO | sim |

**Por que `invalid_response` NÃO conta no per-provider breaker:** se Gemini sempre retorna JSON inválido pra um PDF estranho, abrir o circuit do Gemini é overreaction (modelo está OK, prompt/input é o problema). Mas conta no **chain** porque se TODOS providers falham em produzir output válido em N tentativas, há problema sistêmico (modelos depreciados, prompts quebrados, etc.).

### 7.6 Chain-level circuit breaker (auto-disable)

State machine sobre `circuit_breakers` (resource_type='ai_chain', resource_key='extraction_default'):

```
                  ┌───────────┐
                  │  CLOSED   │ ←──────────────┐
                  └─────┬─────┘                │
                        │ trigger              │
                        ▼                      │
       ┌──────────►┌───────────┐               │
       │          │   OPEN    │                │
       │          └─────┬─────┘                │
       │ probe fail     │ now() >= next_probe_at
       │ (backoff×2)    ▼                      │
       │          ┌───────────┐                │
       └──────────│ HALF_OPEN │────────────────┘
                  │  (probe)   │  N probes succeeded
                  └───────────┘
```

**Trigger A — falha sustentada:** janela 10min, 6+ tentativas com 100% falhas (zero successes), debounce 60s.
**Trigger B — quota explícita:** ANY provider com HTTP 402 / `quota_exceeded` → abre imediatamente (cost protection).

Recovery: probe 1 invoice real do head do queue, rotaciona providers, precisa 2 successes consecutivos pra fechar. Backoff exponencial em re-opens (cap 6h).

Configs:

| Key | Default |
|---|---|
| `ai.chain.auto_disable_enabled` | true |
| `ai.chain.window_sec` | 600 |
| `ai.chain.min_samples` | 6 |
| `ai.chain.failure_ratio` | 1.0 |
| `ai.chain.confirm_sec` | 60 |
| `ai.chain.quota_exceeded_immediate` | true |
| `ai.chain.invalid_response_counts` | true |
| `ai.chain.cooldown_sec` | 900 |
| `ai.chain.cooldown_max_sec` | 21600 |
| `ai.chain.probe_max_total` | 3 |
| `ai.chain.probe_success_required` | 2 |
| `ai.chain.replay_batch_rate_per_minute` | 10 |
| `ai.chain.notify_on_open` | true |
| `ai.chain.notify_on_recovered` | false |
| `ai.chain.scope_lock` | `"global"` |

**Comportamento quando chain OPEN:** worker marca invoice `status='needs_review'`, `needs_review_reason='ai_chain_open'`, ACK msg do queue (fila continua drenando), zero AI cost. Após chain CLOSED, emit `ai.chain.replay_available` com count — admin UI mostra botão "Re-tentar N faturas" (paced 10/min).

### 7.7 Confidence final e status

**Fórmula determinística (única, canônica):**

```
# Inputs:
#   layer3.confidence      → float [0..1] do regex per-utility (campos capturados / required)
#   layer4.confidence      → float [0..1] do AI provider (calculado: extracted_required / total_required)
#   layer4.self_reported   → float [0..1] declarado pelo AI no JSON de resposta (campo "confidence")
#   ocr.confidence         → float [0..1] avg dos OCR API calls (se Layer 2 rodou)

# 1. Confidence da melhor camada de extração que rodou:
if layer4_ran:
    layer_confidence = max(layer3.confidence, layer4.confidence)
else:
    layer_confidence = layer3.confidence

# 2. Se AI rodou, penaliza pelo min com self-reported (modelo pode estar over-confident):
if layer4_ran:
    extraction_confidence = min(layer_confidence, layer4.self_reported)
else:
    extraction_confidence = layer_confidence

# 3. Se OCR rodou, pondera com confidence do OCR:
if layer2_ran:
    confidence_final = extraction_confidence * 0.7 + ocr.confidence * 0.3
else:
    confidence_final = extraction_confidence

# 4. Aplica thresholds (configuráveis):
if confidence_final >= extraction.confidence_threshold (default 0.85):
    status = 'extracted'
elif confidence_final >= extraction.needs_review_threshold (default 0.50):
    status = 'needs_review'
    needs_review_reason = 'low_confidence'
else:
    status = 'failed'
    extraction_error = 'confidence_below_review_threshold'
```

**Por que `min` com self_reported (não `max`):** modelos LLM tendem a ser over-confident. Se AI diz 0.95 mas só capturou 3/5 campos críticos (cálculo nosso = 0.6), o `min(0.95, 0.6) = 0.6` é mais honesto.

**Por que ponderar com OCR confidence:** se OCR teve qualidade baixa (texto truncado/garbled), mesmo regex/AI perfeitos sobre texto ruim são suspeitos. Peso 0.7/0.3 favorece extração mas considera qualidade da fonte.

**Configs:**
```
extraction.confidence_threshold = 0.85
extraction.needs_review_threshold = 0.50
extraction.confidence_extraction_weight = 0.7   # quando OCR rodou
extraction.confidence_ocr_weight = 0.3
```

### 7.8 Schema versioning de `extracted_payload`

```json
{
  "version": 1,
  "data": {
    "method": "ai_fallback",
    "raw_text_excerpt": "primeiros 500 chars do texto extraído",
    "layer1": { "chars": 234, "pages": 1, "density": 0.001 },
    "layer2": { "applied": true, "duration_ms": 4200, "pages_ocred": 2, "early_exit_reason": "minimum_after_2_pages" },
    "layer3": { "matched": true, "utility_key": "enel-sp", "parser_version": 3, "confidence": 0.5 },
    "layer4": { "provider": "gemini", "model": "gemini-2.0-flash", "confidence": 0.95, "tokens": { "prompt": 1200, "completion": 240 }, "self_reported_confidence": 0.92 },
    "extracted_fields": { ... },
    "confidence_final": 0.92
  }
}
```

### 7.9 Re-extração manual

Endpoint `POST /admin/invoices/:id/reextract` (system_admin only) → enfileira no `invoice_queue` com `force=true` na payload. Worker pula idempotency check.

---

## 8. App mobile (Flutter)

### 8.1 Estrutura de pastas

```
unibill-mobile/
├── lib/
│   ├── main.dart
│   ├── app.dart
│   ├── bootstrap.dart
│   ├── core/
│   │   ├── config/                   # env, feature_flags
│   │   ├── di/
│   │   │   ├── injector.dart         # get_it container
│   │   │   └── feature_module.dart   # abstract class pra módulos
│   │   ├── network/                  # supabase_client, edge_function_client
│   │   ├── storage/                  # drift local_db, secure_storage
│   │   ├── error/                    # Failure, exceptions
│   │   ├── theme/                    # light + dark, typography
│   │   ├── widgets/                  # undo_snack, feature_gate, etc.
│   │   ├── telemetry/                # Telemetry client + bloc observer
│   │   └── utils/                    # pix_decoder, money_formatter, etc.
│   ├── features/
│   │   ├── auth/
│   │   │   ├── data/ domain/ presentation/
│   │   │   └── auth_module.dart      # FeatureModule
│   │   ├── invoices/
│   │   │   └── invoices_module.dart
│   │   ├── emails/
│   │   ├── categories/
│   │   ├── household/
│   │   ├── settings/
│   │   ├── sys_admin/
│   │   └── notifications/
│   ├── l10n/
│   │   └── arb/
│   │       ├── app_pt.arb
│   │       └── app_en.arb
│   └── shared/
├── test/
├── integration_test/
└── analysis_options.yaml             # very_good_analysis + custom_lint
```

### 8.2 FeatureModule pattern (Modular-like dentro do VGV stack)

```dart
abstract class FeatureModule {
  String get scopeName;
  void register(GetIt sl);
  void unregister(GetIt sl) => sl.popScopesTill(scopeName);
  List<RouteBase> get routes;
}

class InvoicesModule implements FeatureModule {
  @override
  String get scopeName => 'invoices';

  @override
  void register(GetIt sl) {
    sl.pushNewScope(scopeName: scopeName);
    sl.registerLazySingleton<InvoiceRemoteDataSource>(() => InvoiceRemoteDataSourceImpl(sl()));
    sl.registerLazySingleton<InvoiceLocalDataSource>(() => InvoiceLocalDataSourceImpl(sl()));
    sl.registerLazySingleton<InvoiceRepository>(() => InvoiceRepositoryImpl(sl(), sl()));
    sl.registerFactory<ListInvoicesUseCase>(() => ListInvoicesUseCase(sl()));
  }

  @override
  List<RouteBase> get routes => [
    GoRoute(path: '/invoices', builder: (_, __) => const InvoiceListPage()),
    GoRoute(path: '/invoice/:id', builder: (_, st) => InvoiceDetailPage(id: st.pathParameters['id']!)),
  ];
}
```

Lifecycle via `ShellRoute` + `FeatureScopeShell` widget que registra `initState`, desregistra `dispose`.

Isolamento via `custom_lint` rule `no_cross_feature_imports`.

### 8.3 State, navegação, DI, cache

- **State**: `flutter_bloc`. 1 Bloc por tela ou agregado. Pattern matching Dart 3 (`switch (state)`).
- **Navegação**: `go_router` com type-safe routes, redirect global pra auth check.
- **DI**: `get_it` + `injectable` (code-gen), scopes via FeatureModule.
- **Cache local**: `drift` stale-while-revalidate. PDFs NÃO cacheados (LGPD + storage). Cache cap 50MB configurável.

### 8.4 i18n

ARB files em `lib/l10n/arb/` — `app_pt.arb` (template) + `app_en.arb`. MaterialApp com `localizationsDelegates: AppLocalizations.localizationsDelegates` + `supportedLocales: [pt, en]`. Override do usuário em `app_settings` scope=user `ui.locale`.

### 8.5 Telas principais

- **/auth/welcome → /auth/login | /auth/signup** — fluxo completo de auth
- **/auth/onboarding** — criar OU entrar em household (invite code)
- **/auth/verify-callback** — magic link confirma session
- **/** — Home: lista de faturas por mês, total + pagas, banner needs_review
- **/invoice/:id** — Detalhe: dados, QR PIX, código de barras, link PDF
- **/invoice/:id/pdf** — PDF viewer
- **/invoice/:id/edit** — edição (campos com low-confidence indicator)
- **/needs-review** — lista filtrada de needs_review
- **/emails** — gerenciar Gmails conectados
- **/household** — membros, convites, sair
- **/categories** — gerenciar
- **/settings** — preferences (locale, theme, notification opt-in)
- **/sys-admin/dashboard** — gauges capacity, fila depths, AI chain status (gated)
- **/sys-admin/ai-chain** — tri-state pill, force buttons, simulate-failure (gated)
- **/sys-admin/events** — domain events browser
- **/sys-admin/eviction** — eviction history
- **/sys-admin/settings** — editor de app_settings scope=global
- **/sys-admin/admins** — promote/demote, per-user feature toggles
- **/sys-admin/telemetry** — client_telemetry browser

### 8.6 Undo toast pattern (10s)

```dart
await UndoSnack.show(
  context: context,
  message: 'Fatura marcada como paga',
  action: () => bloc.add(InvoiceMarkPaidRequested(id)),
  undo: () => bloc.add(InvoiceUnmarkPaidRequested(id)),
  duration: const Duration(seconds: 10),
);
```

Aplicado em: marcar/desmarcar paga, apagar fatura, apagar categoria, mover entre households (futuro).

### 8.7 Feature flags client-side

Edge Function `GET /config/resolve?key=...` faz cascata server-side. Client `FeatureFlags.get<T>(key, defaultValue)` com cache TTL 30s. Widget `FeatureGate(flag, child, fallback)` wraps subtrees.

### 8.8 Tema

Material 3 + cores Unibill. **Light + dark** desde o MVP. Tema persistido em `app_settings` scope=user `ui.theme = 'system' | 'light' | 'dark'`. Golden tests cobrem ambos.

### 8.9 Telemetria (com consent gate + PII scrubbing)

**LGPD requer base legal explícita pra coleta de telemetria.** Default = OFF (opt-in).

**Fluxo:**

```
FlutterError.onError / PlatformDispatcher.onError / BlocObserver.onError
                          │
                          ▼
            ┌─────────────────────────────┐
            │ Telemetry.error(err, st)    │
            └────────────┬────────────────┘
                          │
                          ▼
            ┌─────────────────────────────┐
            │ 1. consentService.has(      │
            │    'telemetry') ?            │
            └────────────┬────────────────┘
                  NO     │     YES
              ┌─────────┘└────────────┐
              ▼                        ▼
       Drop silently         ┌─────────────────────────┐
       (no POST, no log)     │ 2. scrubPII(payload)    │
                             └────────────┬────────────┘
                                          │
                                          ▼
                             ┌─────────────────────────┐
                             │ 3. Local queue (Drift)  │
                             │    se offline; flush    │
                             │    on reconnect         │
                             └────────────┬────────────┘
                                          │ online
                                          ▼
                             ┌─────────────────────────┐
                             │ POST /telemetry/ingest  │
                             │ size <= 8KB             │
                             └─────────────────────────┘
```

**PII scrubbing (cliente, antes de queue):**

```dart
class Telemetry {
  Future<void> error(Object err, StackTrace st, {String? screen}) async {
    if (!await consentService.hasActive('telemetry')) return;  // 🚫 Gate
    
    final scrubbed = _scrubPII({
      'message': err.toString(),
      'stack': st.toString(),
      'screen': screen,
      'context': _currentContext,
    });
    
    if (scrubbed.toString().length > 8192) {
      scrubbed['_truncated'] = true;
      // trunca campos longos pra caber em 8KB
    }
    
    await _localQueue.add(scrubbed);
    _flushIfOnline();
  }
  
  Map<String, dynamic> _scrubPII(Map<String, dynamic> payload) {
    final json = jsonEncode(payload);
    // Mesmo padrões do redact backend (sync §6.5)
    final scrubbed = json
      .replaceAll(RegExp(r'[\w._%+-]+@[\w.-]+\.[A-Z]{2,}', caseSensitive: false), '[EMAIL]')
      .replaceAll(RegExp(r'\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b'), '[CPF]')
      .replaceAll(RegExp(r'\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b'), '[CNPJ]')
      .replaceAll(RegExp(r'/Users/[^/\s]+'), '/Users/[USER]')
      .replaceAll(RegExp(r'/home/[^/\s]+'), '/home/[USER]')
      .replaceAll(RegExp(r'\b\d{16,}\b'), '[NUMBER]')  // cartões, etc.
      ;
    return jsonDecode(scrubbed);
  }
}
```

**Endpoint `/telemetry/ingest`:**
- Rejeita payload > 8KB (defesa em profundidade)
- Verifica consent ativo no backend antes de INSERT (re-validation, evita cliente burlado)
- Aplica `redactSecrets()` adicional no `payload` jsonb (mesmo helper do §6.5)
- Rate limit per-user: 100 events/minuto (`rate_limit_buckets`)

**UI Settings → Privacidade:**
- Switch "Permitir coleta de telemetria de erros" (default OFF)
- Texto explicativo: "Quando ativo, erros do app são enviados sem dados pessoais. Ajuda a corrigir bugs."
- Botão "Ver últimos eventos enviados" → lista local (Drift) das últimas 50 entradas pro usuário ver o que foi mandado
- Botão "Revogar e apagar" → revoga consent + DELETE backend

**Retenção:** `retention.client_telemetry.max_age_days = 90` (já em §10.5; reforçando que é o piso pra dados de telemetria por LGPD-minimização).

### 8.10 Notificações

`flutter_local_notifications` no MVP. Cenários:
- Fatura vence em 3/1/hoje
- Fatura nova chegou (após sync)
- Fatura marcada `needs_review`

#### 8.10.1 Mecânica completa de notificações

**Preferências** ficam em `app_settings` scope=user, key `notifications.preferences`:
```json
{
  "due_soon": { "enabled": true, "days_before": [3, 1, 0] },
  "new_invoice": { "enabled": true },
  "needs_review": { "enabled": true },
  "summary_weekly": { "enabled": false }
}
```

**Sincronização do client com o backend:**
- App usa Supabase Realtime (canal `household:<id>`) pra receber INSERT em `invoices` quando feature `notifications.realtime_subscribe = true`
- Fallback: polling 2x/dia via `flutter_workmanager` background task quando Realtime indisponível

**Agendamento local:**
- Ao logar / abrir app: query `invoices WHERE household_id IN myHouseholds AND status='extracted' AND paid_at IS NULL AND due_date IS NOT NULL`
- Pra cada invoice, agenda `flutter_local_notifications` em D-3, D-1, D dia (conforme prefs)
- IDs determinísticos: `invoice_due_<invoice_id>_<days_before>` → re-agendamento idempotente

**Dedupe state (local):**
- Drift table `notification_log(notification_id, sent_at, invoice_id)` impede duplicatas mesmo após reinstall
- TTL local: 90 dias

**Snooze:**
- Botão "Lembrar amanhã" → INSERT em `notification_log` com `snoozed_until=now()+1d`
- Próximo schedule check ignora invoices com snooze ativo

**Cancelamento automático:**
- Quando user marca invoice paga → cancela notifs futuras (`flutter_local_notifications.cancelAll` por padrão de ID)

### 8.10.2 Runtime envelope (Edge Functions) — limites conhecidos

| Recurso | Free tier (Supabase) | Pago (Pro) | Observações |
|---|---|---|---|
| CPU time / invocation | ~2s | ~150s | Tesseract WASM **não cabe no free** (motivo de §7.3 usar API hospedada) |
| Wall-clock / invocation | ~150s | ~400s | Workers internos têm guards (50s) |
| RAM / invocation | ~150MB | ~256MB | pdfjs-dist parsing (~30-50MB) cabe; tesseract (~150MB+) não |
| Invocações simultâneas | limite global por projeto | maior | pgmq read+VT serializa por mensagem |
| Cold start | ~200-500ms | ~100-300ms | pg_cron 1min aceita cold starts |

**Em caso de OOM/timeout:**
- pgmq não recebe ACK; VT expira; msg volta pra fila; próximo worker tenta
- `read_ct` da pgmq incrementa a cada tentativa; max_retries → DLQ
- Workers comparam `read_ct` contra `max_retries` antes de processar

**Validar antes do deploy:**
- Smoke test em Edge Function de `_health/runtime-info` que retorna `Deno.memoryUsage()` + tempo gasto em 1 OCR API call (não local), pra garantir que pipeline cabe no envelope

Push remote (FCM/APNs) entra fase 2.

---

## 9. Auth, segurança e LGPD

### 9.1 Supabase Auth

- Email + password com confirmação obrigatória
- Magic link disponível como alternativa
- Password reset (link 1h)
- Session: 1 semana com refresh token rotation
- Password requirements: min 10 chars, lower+upper+digit+special.
- **HIBP check ativado no MVP**: `GOTRUE_PASSWORD_HIBP_ENABLED=true` na config do Supabase Auth — rejeita senhas presentes em vazamentos conhecidos via HaveIBeenPwned (k-anonimato, primeiros 5 chars do hash são enviados, senha nunca sai do cliente). Cobre `Password123!`, `Admin@2024`, etc. Gratuito.
- Lockout: após 10 tentativas falhadas em 30min pra mesmo email → bloqueio 1h + link de unlock por email. Implementado via `rate_limit_buckets` + middleware no endpoint de login.
- Captcha (hCaptcha free) em signup e password reset quando rate limit é triggered.
- Rate limits adicionais: 5 signups/hora/IP, 10 resets/hora/IP, 5 OTP/hora/email
- Templates de email customizados pt-BR (confirmation, recovery, magic_link, invite, email_change)

**Invitation security (`POST /invitations/redeem`):**

- Rate limit duplo: `invite_redeem:ip` 10/hora + `invite_redeem:user_id` 5/hora (já logado no app)
- Validação obrigatória: se `invitation.invited_email IS NOT NULL`, must match `auth.email()` — falha com 403 caso contrário
- Lockout após 5 tentativas falhadas de mesma `code` → invalida o código permanentemente (mesmo TTL não-expirou ainda)
- Emit `invitation.redeem_failed` em cada falha → sys admin pode ver tentativas de brute force
- Códigos de 8 chars (case-insensitive, base32): ~32^8 ≈ 1.1 trilhão de combinações; brute force inviável sob rate limit

**Deep links + redirect URLs (Android-first MVP):**

App distribuído via APK direto (sem Play Store no MVP), então **Custom URL Scheme** + **Android App Links** trabalhando juntos:

```
Custom scheme:  unibill://auth/callback?token=...&type=...
App Link HTTPS: https://unibill.dev/auth/callback   (futuro, quando domínio existir)
                (MVP usa só custom scheme)
```

**`AndroidManifest.xml`:**
```xml
<activity android:name=".MainActivity" android:launchMode="singleTask">
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="unibill" android:host="auth" />
  </intent-filter>
</activity>
```

**Supabase Dashboard → Auth → URL Configuration:**
```
Site URL:        unibill://
Redirect URLs:   unibill://auth/callback
                 unibill://auth/recovery
                 unibill://auth/magic-link
                 (futuro web)  https://app.unibill.dev/auth/callback
```

**Edge cases tratados:**
- Usuário clica link em **outro device** (PC sem app instalado): templates de email têm fallback HTML page hospedada que mostra "Abra este link no seu celular com o app Unibill instalado" + QR Code do link `unibill://...`.
- App não instalado no clique mobile: Android oferece Play Store (não está lá no MVP) → fallback: página HTML com botão "Download APK" hosted em GitHub Releases.
- Token expirado (>1h): app exibe "Link expirou, peça novo" + botão pra reenvio via `resend()`.

**Go Router config:**
```dart
GoRoute(
  path: '/auth/callback',
  redirect: (ctx, st) async {
    final session = await supabase.auth.getSessionFromUrl(st.uri);
    return session != null ? '/' : '/auth/login?error=invalid_token';
  },
),
```

**Quando ter domínio próprio (roadmap):** ativar Android App Links com `assetlinks.json` hospedado em `unibill.dev/.well-known/` (associa app ID ao domínio, abre direto no app sem prompt "abrir com").

### 9.2 JWT claim `is_system_admin`

```json
{
  "app_metadata": {
    "is_system_admin": false   // ou true
  }
}
```

**Audit trail completo de promoções/revogações** (`system_admin_grants` — append-only):

```sql
CREATE TABLE system_admin_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id),
  action        text NOT NULL CHECK (action IN ('granted','revoked')),
  granted_by    uuid REFERENCES auth.users(id),    -- NULL pra bootstrap (SQL direto)
  granted_at    timestamptz NOT NULL DEFAULT now(),
  reason        text NOT NULL,                     -- 'bootstrap' | 'peer_promotion' | 'auto_revoke_last' etc.
  correlation_id uuid
);

CREATE INDEX idx_admin_grants_user_time ON system_admin_grants(user_id, granted_at DESC);
-- RLS: sys admin only
ALTER TABLE system_admin_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_grants_select_sysadmin ON system_admin_grants FOR SELECT
  USING (app.is_system_admin());
-- INSERT só via service_role (Edge Function /admin/promote-system-admin escreve aqui)
```

**Bootstrap inclui INSERT audit:**

```sql
-- Bootstrap (1ª vez via SQL no Studio):
DO $$
DECLARE bootstrap_user_id uuid;
BEGIN
  SELECT id INTO bootstrap_user_id FROM auth.users WHERE email = '<seu-email>';
  
  UPDATE auth.users
    SET raw_app_meta_data = raw_app_meta_data || '{"is_system_admin": true}'::jsonb
    WHERE id = bootstrap_user_id;
  
  INSERT INTO system_admin_grants (user_id, action, granted_by, reason)
  VALUES (bootstrap_user_id, 'granted', NULL, 'bootstrap');
  
  INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, actor_type, payload)
  VALUES (
    'system_admin.bootstrapped', 'user', bootstrap_user_id, 'system',
    jsonb_build_object('version', 1, 'data', jsonb_build_object('reason', 'bootstrap'))
  );
END $$;
```

Bootstrap original (sem audit):
```sql
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"is_system_admin": true}'::jsonb
WHERE email = '<seu-email-de-login-no-app>';
```

A partir daí, promoção via UI → Edge Function `POST /admin/promote-system-admin` (peer trust, qualquer sys admin promove outro; bloqueia remover último).

Helper SQL `auth.is_system_admin()` lê o claim do JWT.

### 9.3 Supabase Vault para app passwords

**Extensão usada:** `supabase_vault` (pública), construída sobre `pgsodium` internamente. API estável e documentada.

- Tabela `vault.secrets` (cifrada at-rest)
- View `vault.decrypted_secrets` (read-only, descriptografa on-the-fly)
- Acesso: apenas via SECURITY DEFINER functions; end user JS = zero acesso

#### 9.3.1 Operações Vault — contrato completo

**Create (Edge Function `POST /emails/connect`):**

```sql
-- Dentro da Edge Function (chamada via supabase-js admin client com service_role):
SELECT vault.create_secret(
  $1,                                         -- secret_value (app password plaintext)
  format('gmail_app_pwd:%s', $2),             -- name (debug; não usar pra lookup)
  format('App password Gmail user %s', $3)    -- description
) AS secret_id;
```

```typescript
// supabase/functions/emails/connect/index.ts (esboço)
const { secret_id } = await supabaseAdmin.rpc('create_vault_secret', {
  secret_value: appPassword,
  name: `gmail_app_pwd:${email}`,
  description: `User ${ownerUserId}`
});

await supabaseAdmin.from('connected_emails').insert({
  email_address: email,
  owner_user_id: ownerUserId,
  app_password_secret: secret_id,
  // ...
});
```

`create_vault_secret` é um wrapper SECURITY DEFINER (em schema `app`) que chama `vault.create_secret` internamente — evita expor `vault.*` direto pra Edge Functions:

```sql
CREATE OR REPLACE FUNCTION app.create_vault_secret(
  secret_value text, name text DEFAULT NULL, description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE new_id uuid;
BEGIN
  SELECT vault.create_secret(secret_value, name, description) INTO new_id;
  RETURN new_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.create_vault_secret FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.create_vault_secret TO service_role;
```

**Decrypt (worker):**

```sql
SELECT decrypted_secret AS password
FROM vault.decrypted_secrets
WHERE id = $1;
```

Via wrapper:
```sql
CREATE OR REPLACE FUNCTION app.decrypt_app_password(secret_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pw text;
BEGIN
  SELECT decrypted_secret INTO pw FROM vault.decrypted_secrets WHERE id = secret_id;
  IF pw IS NULL THEN
    RAISE EXCEPTION 'Vault secret not found: %', secret_id USING ERRCODE = 'P0002';
  END IF;
  RETURN pw;
END;
$$;
REVOKE EXECUTE ON FUNCTION app.decrypt_app_password FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.decrypt_app_password TO service_role;
```

**Rotação (Edge Function `PATCH /emails/:id/rotate-password`):**

Vault tem `vault.update_secret(id, new_secret, new_name, new_description)` que **atualiza in-place mantendo o uuid** — preferível ao "criar nova + deletar antiga" (que precisaria de transação cuidadosa pra não quebrar workers em-vôo):

```sql
SELECT vault.update_secret(
  $1,                                  -- secret_id existente
  $2,                                  -- novo valor
  format('gmail_app_pwd:%s (rotated %s)', $email, now()::text),
  format('Rotated at %s by user %s', now()::text, $userId)
);
```

`connected_emails.app_password_secret` permanece o mesmo uuid; workers em-vôo terminam com password antigo (já buffered em memória) e próximo decrypt pega o novo.

**GRANT/REVOKE matrix (defesa em profundidade):**

```sql
-- Vault tables: zero acesso direto pra anon/authenticated
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM anon, authenticated;

-- service_role já tem (Supabase default), mas explicito:
GRANT USAGE ON SCHEMA vault TO service_role;
```

**Redação obrigatória em logs:** já documentada em §6.5 (`redactSecrets()`). Variáveis locais com password decifrada zeradas em `finally`.

**End user / system admin via UI:**
- End user pode "trocar senha" (chama rotate endpoint)
- System admin pode "revogar acesso" (DELETE secret + UPDATE `connected_emails.status='revoked'`)
- NENHUM endpoint retorna o valor decifrado pro cliente

### 9.4 LGPD

**Consentimento no signup** — tela dedicada com lista do que coletamos + termo + checkbox. Grava em `consent_log` (versão dos termos + IP + UA + timestamp).

**Tela "O que coletamos"** em Settings → Privacidade. Textos editáveis em `app_settings` (`legal.privacy_notice_pt`, `legal.privacy_notice_en`).

**Exportação de dados** (direito de portabilidade — LGPD art.18 V):

Escopo é estritamente "MEUS dados" — NÃO inclui PII de outros membros da household. Regras precisas:

| Categoria | O que entra | O que NÃO entra |
|---|---|---|
| `profile.json` | meu user_id, email, display_name, app_metadata, datas | nada de outros users |
| `households.json` | metadata das households em que sou membro (nome, meu role, joined_at) | nomes/emails de outros membros |
| `members.json` | só minha row em `members` | rows de outros membros |
| `connected_emails.json` | só emails com `owner_user_id = me` (sem app_password) | emails de outros membros |
| `invoices.json` | **só invoices em que eu interagi** (`paid_by=me` OR `created_by=me` OR `updated_by=me`) + metadata agregada da household (count, total/mês) | invoices que outros membros gerenciam |
| `invoice_pdfs/*.pdf` | só PDFs cuja invoice veio de `connected_emails.owner_user_id = me` | PDFs de invoices de outros |
| `consent_log.json` | minhas rows (todas, ativas e revogadas) | — |
| `domain_events.json` | events com `actor_user_id = me` últimos 90 dias | events de outros membros |
| `client_telemetry.json` | minhas rows últimos 30 dias | — |

```typescript
// POST /privacy/export-my-data
serve(async (req) => {
  const userId = (await getCallerUser(req)).id;
  
  await withRateLimit('export_my_data', userId, limit=1, '1day');
  
  const data = {
    profile: await getOwnProfile(userId),
    households: await getMyHouseholdMetadata(userId),  // sem outros membros
    members: await db.from('members').select('*').eq('user_id', userId),
    connected_emails: await getMyConnectedEmails(userId),  // sem app_password
    invoices: await getInvoicesITouched(userId),  // filtrado
    consent_log: await db.from('consent_log').select('*').eq('user_id', userId),
    domain_events: await db.from('domain_events')
      .select('*').eq('actor_user_id', userId)
      .gte('occurred_at', daysAgo(90)),
    client_telemetry: await db.from('client_telemetry')
      .select('*').eq('user_id', userId)
      .gte('occurred_at', daysAgo(30)),
  };
  
  const pdfs = await getMyOwnedPdfs(userId);   // só de emails que possuo
  
  const zip = await createZipWithPdfs(data, pdfs, {
    max_size_bytes: 500 * 1024 * 1024  // 500MB cap
  });
  
  const path = `exports/${userId}/${yyyymmddhhmmss}.zip`;
  await storage.upload(path, zip, { bucket: 'private-exports' });
  const signedUrl = await storage.createSignedUrl(path, expiresIn: 86400);  // 24h
  
  // Termo do export claro:
  // README.md inside zip: "Esta exportação contém apenas SEUS dados pessoais.
  //  Dados de outros membros da família não estão incluídos, conforme LGPD."
  
  return { download_url: signedUrl, expires_at: ... };
});
```

Limite: 1 export/dia/user via `rate_limit_buckets`. Export expira após 24h (Storage cleanup automático).

**Exclusão de conta** (direito ao esquecimento): `DELETE /privacy/my-account`:
1. Bloqueia se for último admin de algum household
2. Soft-delete membership em todos households
3. Soft-delete connected_emails do user + DELETE vault secrets correspondentes
4. Anonimiza via `anonymize_user_references()` — refs viram sentinel user
5. **INVOICES não deletadas** — política explícita (decisão LGPD):
   - Invoices são propriedade da **household** (controller compartilhado entre membros ativos), não do indivíduo
   - Conteúdo extraído (customer_name, customer_document, service_address) pode incluir dados de **terceiros** (cônjuge, dependentes) ou do próprio titular deletado
   - **Política**: invoices permanecem; apenas FKs de audit (`paid_by`, `created_by`, `updated_by`) viram sentinel
   - **NÃO** tentar match automático de PII (nome/CPF) nos campos extraídos — fragil, fica errado quando nomes batem por coincidência
   - **Termo de consentimento** explicita: "Faturas geradas com base em contas em seu nome permanecem na household após sua saída, pois pertencem à unidade familiar. Você pode solicitar revisão manual de invoices específicas via 'Excluir dados específicos' no Settings."
   - Esse direito de revisão manual é roadmap (item "talvez"): endpoint `POST /privacy/request-invoice-deletion(invoice_id)` que cria ticket pra household admins decidirem (mantém / anonimiza campos PII específicos / soft-delete invoice)
6. DELETE telemetry e PII em domain_events
7. Emit `user.deleted`
8. Supabase Auth deleteUser final

### 9.5 RLS recap

Ver Seção 5.11.

Auditoria: pgTAP tests em `supabase/tests/rls/` rodam no CI, testam cross-tenant isolation pra cada policy.

### 9.6 API Security

- **CORS** configurável via `app_settings.security.cors_allowed_origins`
- **Body validation** com Zod em toda Edge Function
- **Rate limiting per-user** via `rate_limit_buckets` + `withRateLimit` middleware
- **HTTPS** enforced (Supabase Cloud default)
- **Anon key vs service_role**: app mobile usa anon (RLS protege), service_role só workers
- **Secret rotation runbook**: Supabase Dashboard regenera, app re-logado força nova session

---

## 10. Capacity Management

### 10.1 Two-layer retention

**Layer 1 — Hard ceiling diário** (`retention-hard-ceiling` cron 03:00):
- `DELETE FROM <table> WHERE <age_field> < now() - <max_age_days>`
- Aplica em verde também — teto absoluto

**Layer 2 — Adaptive eviction** (apenas em orange+):
- `capacity-monitor` (5min) classifica status: green / yellow / orange / red
- Em orange/red: enfileira mensagem em `capacity_eviction_queue`
- `capacity-evictor` (1min) consome, executa tier-escalation até bater target 60%

### 10.2 State machine de capacity

| Pct | Status | Ação |
|---|---|---|
| 0-69% | 🟢 green | Apenas measurement |
| 70-79% | 🟡 yellow | Retention padrão diária |
| 80-89% | 🟠 orange | Enfileira eviction imediato; banner UI |
| 90%+ | 🔴 red | Eviction agressiva, pausa ingestão (`features.ingestion_enabled=false`), email admin |

Pausa de ingestão evita eviction-vs-ingestion fighting. Retoma automático em <85%.

### 10.3 Tier-escalation (convergência garantida)

```
Tier 1: aplica policy com adaptive_floor_days configurado
Tier 2: floor /= 2 (corta mais)
Tier 3: floor /= 4 (mínimo 1 dia)
Tier 4: evicção de dados (invoices > adaptive_floor=1095d), batches de 100, evento por batch
Tier 5: emit 'capacity.critical', desliga ingestão até intervenção
```

Com hard ceilings adequados (5 anos invoices, 1-2 anos logs), Tier 4 nunca é atingido na prática — base alcança steady state ~280 MB para sempre.

### 10.4 PDF archive (Storage)

Quando Storage > 90%: deleta PDFs > 365 dias, marca `invoices.pdf_archived_at = now()`, registra em `pdf_archive_log`. UI mostra "PDF arquivado em DD/MM". Dados extraídos continuam disponíveis.

### 10.5 Configs de retenção (todas em `app_settings` scope=global, configuráveis runtime)

```
retention.rate_limit_buckets.max_age_days = 7
retention.health_snapshots.max_age_days = 30
retention.health_snapshots_hourly.max_age_days = 365
retention.sync_runs.max_age_days = 365
retention.sync_runs.adaptive_floor_days = 7
retention.sync_runs.slim_after_days = 30
retention.extraction_runs.max_age_days = 365
retention.extraction_runs.adaptive_floor_days = 7
retention.capacity_snapshots.max_age_days = 730
retention.eviction_runs.max_age_days = 1825
retention.ai_calls.max_age_days = 730
retention.domain_events_hot.max_age_days = 90
retention.domain_events_archive.max_age_days = 1825
retention.pdf_archive_log.max_age_days = 1825
retention.app_settings_history.max_age_days = 1825

# consent_log: LGPD evidência de consentimento (Marco Civil = 6 meses logs, mas evidência LGPD vai além)
retention.consent_log.max_age_days = 1825                  # 5 anos (limite prudente)
retention.consent_log.ip_mask_after_days = 90              # após 90d, IP mascarado /24 (IPv4) ou /64 (IPv6)
retention.consent_log.user_agent_hash_after_days = 30      # após 30d, user_agent vira hash sha256

retention.invoices.max_age_days = 1825              # 5 anos (configurável)
retention.invoices.adaptive_floor_days = 1095       # 3 anos piso adaptive
retention.pdfs_storage.max_age_days = 1825
retention.pdfs_storage.adaptive_floor_days = 365
```

### 10.6 Configs de capacity

```
capacity.measurement_interval_min = 5
capacity.db_limit_bytes = 524288000      # 500 MB free tier
capacity.storage_limit_bytes = 1073741824 # 1 GB free tier
capacity.target_pct = 60
capacity.yellow_threshold_pct = 70
capacity.orange_threshold_pct = 80
capacity.red_threshold_pct = 90
capacity.min_retention_days = 30
capacity.pdf_min_retention_days = 365
capacity.eviction_max_runtime_ms = 45000
```

---

## 11. Operações: CI/CD, backup, monitoring

### 11.1 Branch strategy

| Branch | Pipeline | Deploy |
|---|---|---|
| `feature/*` | lint + test + dry-run migrations | nenhum |
| `fix/*` `hotfix/*` | igual + label priority | nenhum |
| `docs/*` | só markdown lint | nenhum |
| `chore/*` `refactor/*` | lint + test (sem integration) | nenhum |
| `dependabot/*` | só lint + test | nenhum |
| PR → `main` | full check + cobertura + breaking changes | nenhum |
| push `main` | full | **dev** (automático) |
| `release/v*` | gera changelog + RC build | nenhum |
| tag `v*.*.*` | RC promovido | **prod** (manual approval) |

### 11.2 release-please

Conventional Commits no histórico → release-please bot abre PR auto bumpando versão + atualizando CHANGELOG. Merge do PR → cria tag → dispara workflow que builda APK/manifesto e cria GitHub Release com artifacts attached.

### 11.3 Backup com Backblaze B2

GitHub Action semanal (dom 05:00 UTC) roda `pg_dump --format=custom` → upload pra B2 bucket via `aws s3 cp` com endpoint B2. Retenção 4 semanais + 6 mensais via lifecycle policy do bucket. **Free tier B2 (10GB) cobre Unibill por 5+ anos.**

Storage backups (PDFs): snapshot mensal de metadata (path + sha256) pro B2. Restauração full = roadmap "talvez".

Test restore: runbook em `unibill-backend/docs/RUNBOOK.md`, executar a cada 6 meses.

**Esqueleto mínimo do `RUNBOOK.md`** (criar no deploy 1; expandir conforme incidentes):

```markdown
# Unibill Runbook

## 1. Backup restore (DR)
### Pré-requisitos
- psql, pg_restore, awscli configurados
- Acesso ao bucket B2 com credenciais válidas
- Supabase project alvo provisionado (dev ou novo)

### Procedimento
1. Listar backups: `aws s3 ls s3://unibill-backups/ --endpoint-url=https://s3.us-west-002.backblazeb2.com`
2. Baixar último: `aws s3 cp s3://unibill-backups/unibill-YYYYMMDD.dump ./`
3. Configurar conn string: `export PGURL='postgres://...@aws-0-us-east-1.pooler.supabase.com:5432/postgres'`
4. Restaurar: `pg_restore --no-owner --no-acl --clean --if-exists -d $PGURL ./unibill-YYYYMMDD.dump`
5. Verificações pós-restore (queries de smoke):
   - `SELECT count(*) FROM households` → > 0
   - `SELECT count(*) FROM invoices WHERE status='extracted'` → comparar com último monitor
   - `SELECT now() - max(checked_at) FROM capacity_snapshots` → < 1h

## 2. Force chain breaker (AI / OCR)
### Quando: provider rotacionando, debugging, false positive
### Como
1. UI: `/sys-admin/ai-chain` → "Force Close" ou "Force Open"
2. SQL direto: `UPDATE circuit_breakers SET state='closed', reopen_count=0 WHERE resource_type='ai_chain'`

## 3. Re-extract invoice batch
### Quando: parser quebrou e foi corrigido; lote em needs_review
### Como
1. Identificar invoices: `SELECT id FROM invoices WHERE status='needs_review' AND utility_key='enel-sp' AND extracted_at < 'YYYY-MM-DD'`
2. Para cada: `POST /admin/invoices/:id/reextract` (com force=true)
3. Acompanhar via `/sys-admin/extraction-runs`

## 4. Rotate service_role key
### Quando: vazamento suspeito, segurança rotineira (anual)
1. Supabase Dashboard → Project Settings → API → "Generate new service_role key"
2. `ALTER DATABASE postgres SET app.service_role_key = '<nova>'` (psql como postgres)
3. Restart connections: `SELECT pg_reload_conf()` (ou aguarda reconexões naturais)
4. Atualizar GitHub Actions secret

## 5. Capacity emergency
### Quando: capacity_snapshot mostra red e auto-eviction não consegue baixar
1. Verificar `eviction_runs` recentes pra entender por que não convergiu
2. Aumentar `capacity.target_pct` temporariamente (ex: 75)
3. Trigger manual: UI `/sys-admin/dashboard` → "Force eviction now"
4. Se ainda não baixar → upgrade pra Pro tier

## 6. User reports missing invoice
1. Identificar via `connected_emails.email_address`
2. Checar `sync_runs` últimas 24h: rodou? viu? processou?
3. Checar `invoices.deleted_at` (foi soft-deletado?)
4. Checar DLQ: `SELECT * FROM pgmq.q_invoice_dlq`

## 7. Suspeita de vazamento de credencial
1. Imediato: revogar app password no Gmail do usuário
2. Verificar audit: `SELECT * FROM domain_events WHERE event_type LIKE 'email.%' ORDER BY occurred_at DESC LIMIT 50`
3. Notificar usuário via email (template "credencial revogada")

## 8. Test restore (executar a cada 6 meses)
1. Provisiona Supabase project temporário (free tier, novo)
2. Roda restore do último backup conforme §1
3. Smoke tests + count comparison com prod
4. Documenta data + resultado em `app_settings` key `ops.last_backup_test_at`
5. Destrói project temporário
```

Adicionar à deploy checklist (§11.5) como step P0 antes de "Configurar backup cron":

```
✅ 23a. Criar `unibill-backend/docs/RUNBOOK.md` com o esqueleto acima
✅ 23b. Documentar credenciais em password manager
```

### 11.4 Health check + monitoring

`/health` Edge Function retorna 200/503 baseado em:
- DB acessível
- Última sync_runs < 90min
- Capacity em green/yellow
- AI chain não em open por > 1h

GitHub Action scheduled (a cada 15min) hits `/health`, alerta via email em falha.

Email de alerta: configurável via `notifications.admin_email` (placeholder até ser definido).

### 11.5 Deploy inicial — checklist

```
✅ 1. Criar Supabase projects: unibill-dev e unibill-prod
✅ 2. Configurar Auth: providers, templates, rate limits, password reqs
✅ 3. Clonar unibill-backend repo (privado)
✅ 4. supabase init + link --project-ref <prod>
✅ 5. Aplicar migrations: supabase db push
✅ 6. Configurar GitHub Actions secrets
✅ 7. Deploy Edge Functions: supabase functions deploy --all
✅ 8. Seed inicial via psql:
    - `system_actors` (deleted_user, system_worker, system_admin_bootstrap) — UUIDs fixos §5.10
    - utility_parsers (enel-sp, sabesp, comgas, vivo) — conteúdo a ser definido em `seeds/utility_parsers.sql`
    - default invoice_categories template — `seeds/categories_template.sql`
    - app_settings (lista canônica em `seeds/app_settings_defaults.sql`)
✅ 9. Cadastrar primeiro user via mobile app (signup)
✅ 10. Promover primeiro sys admin via SQL no Studio
✅ 11. Relogar no app → aba sys admin aparece
✅ 12. Criar primeira household
✅ 13. Gerar invite code, convidar 2º membro (testar fluxo)
✅ 14. Cadastrar primeiro Gmail (app password) → conectar
✅ 15. Aguardar primeiro sync (≤1min)
✅ 16. Verificar sync_runs > 0
✅ 17. Aguardar primeiro extraction_runs
✅ 18. Abrir fatura, verificar dados extraídos
✅ 19. Marcar como paga, verificar undo toast
✅ 20. Smoke test: capacity dashboard, AI chain health
✅ 21. Configurar backup cron (GitHub Action enabled)
✅ 22. Configurar health check cron
✅ 23. Documentar credenciais em password manager
✅ 24. Convidar família/beta testers (distribuir APK via GitHub Release)
```

---

## 12. Estratégia de testes

### 12.1 Pirâmide por criticidade (não uniform)

| Camada | Cobertura alvo |
|---|---|
| Crítico (RLS, money, vault, deleção, capacity, AI gating) | **100% line + 100% branch + mutation ≥ 75%** |
| Business logic (usecases, parsers, extractors) | **95%+ line + 90%+ branch** |
| Adapters (data sources, repos) | **90%+ line** |
| Presentation (bloc + widgets) | **85%+ line** |
| Gerado / trivial | excluído |

Agregado esperado: ~92% backend / ~88% mobile.

### 12.2 Backend

- **Edge Functions**: `deno test` com mocks de Supabase client. Local stack via `supabase start`.
- **DB / RLS**: pgTAP em `supabase/tests/`. Toda policy tem teste cross-tenant.
- **Migrations**: `supabase db lint` + dry-run em DB temp no CI.
- **Mutation testing**: `mutmut` (Python) ou equivalente Deno em paths críticos. Mutation score ≥ 75%.

### 12.3 Mobile

- **Unit**: ~60% — usecases, entities, utils
- **Bloc**: ~25% — `bloc_test` por evento → states
- **Widget**: ~10% — páginas críticas
- **Integration**: ~5% — golden flows (login → list → detail → mark paid)
- **Golden tests**: páginas core × (light, dark) × (pt, en) — quebra regressão visual

### 12.4 CI thresholds

```yaml
coverage:
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - "lib/**/dto.dart"
  per_file_thresholds:
    "lib/features/auth/**": 95
    "lib/features/invoices/domain/**": 95
    "lib/features/**/presentation/bloc/**": 90
    "lib/**": 85
```

---

## 13. Roadmap pós-MVP

### 13.1 Caminho claro (já tem fundação)

- Outlook / Yahoo / IMAP genérico
- Upload manual de PDF (`features.manual_upload=true`)
- Re-extração em massa com parser novo (job admin)
- OpenRouter ativo na chain AI
- **OCR microservice self-hosted (Oracle Always Free ou Cloud Run)** — adiciona `SelfHostedMicroserviceProvider` ao `extraction.ocr_chain`. Roda Tesseract em container 24/7. Oracle = grátis pra sempre (4 ARM cores + 24GB RAM); Cloud Run = scale-to-zero (free tier 2M req/mês). Filosoficamente puro-OSS, sem dependência SaaS. ~2-3 dias de setup (Dockerfile + container + HTTPS endpoint + API key auth via Vault).
- **Extração on-device no Flutter (botão "Re-extrair localmente")** — quando fatura cai em `needs_review` por falha de OCR chain, usuário pode disparar extração no próprio device via `pdfx` + `flutter_tesseract_ocr` (ou `google_mlkit_text_recognition` se priorizar performance). Payload extraído enviado pro backend via Edge Function. Útil também como fallback offline-first futuro.
- Web app React + Vite + TanStack Router (espelho do mobile)
- Notificações push (FCM/APNs)
- Categorização automática por IA
- Chat assistente conversacional
- Detecção de anomalias (batch mensal)
- Pagamento parcial / split entre membros (`invoice_splits`)
- API de traduções remota (i18n_strings)
- 2FA TOTP via Supabase Auth
- GlitchTip self-hosted (~$5/mês VPS)
- Google Play Store distribution ($25 one-time)
- Apple Developer Program + iOS app ($99/ano)
- Custom domain (~$15/ano)
- Abrir repos publicamente

### 13.2 Talvez

- Audit log fino de invoices (`invoices_history`)
- Tags free-form
- Múltiplos anexos por fatura
- Verificação OAuth Google (se >100 users)
- Camada extra de autorização pra promover sys admin
- Detecção automática de pagamento via email de confirmação
- Detecção de pagamento via fatura subsequente
- Campos extras de fatura (payee_address, service_period_*, consumption_breakdown, previous_balance_cents)
- OpenReplay self-hosted (session replay)
- PostHog self-hosted (analytics reais)
- AWS S3 / Cloudflare R2 backup (caso Backblaze mude)

### 13.3 Fora definitivo

- Open Finance via agregadores (Pluggy/Belvo) — viola open source
- WhatsApp via Baileys — risco de ban
- Pagamento automático via PIX pelo app — escopo + risco regulatório

---

## 14. Decisões abertas

### 14.1 Pendentes do design

| Decisão | Status |
|---|---|
| Email de notificação admin (`notifications.admin_email`) | Placeholder; usuário define quando definir o email destino |
| Nome "Unibill" — coexistir com UniBillApp (Índia) ou renomear? | Manter provisoriamente; revisitar antes de release público |
| Repositórios privados vs públicos no GitHub | Privados no início; abrir quando MVP estabilizar |

### 14.2 Próximos passos

1. **Self-review deste documento** — Claude roda checklist + skill `simplify` pra simplificar/reduzir
2. **Revisão do usuário** — Fabio lê documento completo, marca pontos a refinar
3. **Iteração** — ajustes baseados na revisão
4. **Transição pra writing-plans skill** — quebra do design em tarefas implementáveis, ordenadas por dependência

---

## 15. Apêndices

### A. Glossário

| Termo | Significado |
|---|---|
| **Household** | Família (unidade de tenancy). Boundary de RLS. |
| **Member** | Usuário membro de um household (role admin ou member). |
| **System admin** | Usuário com claim JWT `is_system_admin=true`. Gerencia config global, sees telemetry. |
| **Sentinel user** | Usuário especial `00000000-...-01` ("Usuário removido") que substitui FKs após deleção. |
| **Connected email** | Conta Gmail conectada via IMAP + app password. Pode pertencer a múltiplos households via binding. |
| **Utility parser** | Regex configurável per-utility (Enel, Sabesp, etc.) que extrai dados de texto de fatura. |
| **Layer 1/2/3/4** | Camadas do pipeline de extração: pdfjs texto / OCR API chain / regex / AI chain. |
| **OCR chain** | Sequência ordenada de provedores OCR hospedados tentados em fallback: OCR.space → Google Vision. Mesmo padrão da AI chain. |
| **AI chain** | Sequência ordenada de providers tentados em fallback: Gemini → Groq → OpenRouter. |
| **Chain breaker** | Circuit breaker chain-level (acima dos per-provider) que desativa AI fallback após falhas sustentadas. |
| **needs_review** | Status de invoice cuja extração teve confidence < threshold; usuário revisa manualmente. |
| **Capacity status** | Estado de uso de DB/Storage: green / yellow / orange / red. |
| **Adaptive eviction** | Mecanismo que reduz dados antigos quando capacity > 80%, com tier-escalation. |
| **Hard ceiling** | Idade máxima absoluta por tabela, aplicada diariamente regardless de capacidade. |
| **Domain event** | Registro imutável de mudança de estado importante (audit + futuro webhook). |
| **Correlation ID** | UUID propagado fim-a-fim em uma operação (pg_cron → trigger → worker → AI call). |
| **Idempotency key** | Chave determinística que impede dupla execução de uma mensagem de fila. |

### B. Configs default — lista canônica (seeds em `app_settings` scope=global)

Tabela mestre de todas as configurações com tipo, range válido, impacto, e requirement de restart. Esta é a fonte de verdade pra `seeds/app_settings_defaults.sql`.

**Categoria: `features` (feature flags)**

| Key | Tipo | Default | Range | Impacto | Restart |
|---|---|---|---|---|---|
| `features.ingestion_enabled` | bool | `true` | true/false | Master switch do sync IMAP. Desligar pausa todo `sync-worker`. Auto-toggle em capacity red. | não |
| `features.extraction_enabled` | bool | `true` | true/false | Master switch do `extraction-worker`. | não |
| `features.ai_fallback_enabled` | bool | `true` | true/false | Master switch da AI chain (manual kill-switch; ortogonal ao chain breaker). | não |
| `features.manual_upload` | bool | `false` | true/false | Roadmap: permite upload manual de PDF via UI. | não |
| `features.manual_on_device_reextraction` | bool | `false` | true/false | Roadmap: permite botão "extrair localmente" no app. | não |
| `features.sys_admin.capacity_dashboard` | bool | `true` | true/false | Gate UI sys admin: dashboard de capacity. Per-user override scope=user. | não |
| `features.sys_admin.eviction_trigger_manual` | bool | `true` | true/false | Gate UI: forçar eviction manual. | não |
| `features.sys_admin.global_settings_edit` | bool | `true` | true/false | Gate UI: editar app_settings global. | não |
| `features.sys_admin.domain_events_browser` | bool | `true` | true/false | Gate UI: browser de domain_events. | não |
| `features.sys_admin.user_promotion` | bool | `true` | true/false | Gate UI: promover outros sys admins. | não |
| `features.sys_admin.lgpd_data_export` | bool | `true` | true/false | Gate UI: exportar dados de qualquer user (audit/compliance). | não |

**Categoria: `sync` (ingestão IMAP)**

| Key | Tipo | Default | Range | Impacto | Restart |
|---|---|---|---|---|---|
| `sync.interval_minutes` | int | `60` | 5..1440 | Frequência mínima entre syncs do mesmo email. < 5 estressa Gmail; > 1440 = invoices atrasam dias. | não |
| `sync.batch_size` | int | `3` | 1..20 | Quantos emails o dispatcher seleciona por tick. Maior = mais paralelismo mas mais conexões IMAP simultâneas. Gmail limita ~15 por conta. | não |
| `sync.lookback_days` | int | `7` | 1..30 | Janela IMAP SEARCH SINCE em syncs recorrentes. > cursor `last_processed_uid` protege contra reentregas. | não |
| `sync.first_sync_lookback_days` | int | `90` | 7..365 | Janela do primeiro sync de uma caixa (backfill). Maior = mais histórico mas mais OCR ops iniciais. | não |
| `sync.fetch_max_runtime_ms` | int | `50000` | 10000..55000 | Cap interno do `sync-worker` por invocação. Edge Function tem 60s wall; 50s deixa margem. | não |
| `sync.visibility_timeout_s` | int | `120` | 60..600 | pgmq VT em `email_sync_queue`. Tempo que msg fica "in-flight" antes de re-aparecer. | não |
| `sync.consecutive_error_threshold` | int | `5` | 2..20 | Erros consecutivos antes de auto-pause da caixa (status='error'). | não |
| `sync.max_retries` | int | `3` | 1..10 | Tentativas antes de mover msg pra DLQ. | não |
| `sync.retry_base_s` | int | `60` | 30..300 | Base do backoff exponencial. attempt 1=60-120s, attempt 2=120-240s (com jitter). | não |
| `sync.retry_cap_s` | int | `1800` | 300..7200 | Cap do backoff (30min default). | não |
| `sync.imap_connect_timeout_ms` | int | `10000` | 3000..30000 | Timeout TCP+TLS de conexão IMAP. | não |
| `sync.imap_fetch_timeout_ms` | int | `20000` | 5000..45000 | Timeout por fetch IMAP individual. | não |
| `sync.gmail_max_concurrent_connections` | int | `5` | 1..15 | Limite local pra Gmail (que limita 15 por conta no servidor). | não |
| `sync.pdf_min_size_bytes` | int | `10240` | 1024..102400 | Anexos PDF menores que isso são ignorados (provavelmente thumbnails). | não |
| `sync.pdf_max_size_bytes` | int | `10485760` | 1048576..52428800 | Cap em 10MB. Maiores vão pra DLQ pra inspeção. | não |
| `sync.attachment_max_per_message` | int | `5` | 1..50 | Protege contra spam com 100 PDFs anexados. | não |

**Categoria: `extraction` (pipeline 4-layer)**

| Key | Tipo | Default | Range | Impacto | Restart |
|---|---|---|---|---|---|
| `extraction.batch_size` | int | `5` | 1..50 | pgmq read count do `extraction-worker`. | não |
| `extraction.visibility_timeout_s` | int | `90` | 30..300 | pgmq VT em `invoice_queue`. | não |
| `extraction.max_runtime_ms` | int | `50000` | 10000..55000 | Guard interno. | não |
| `extraction.max_retries` | int | `3` | 1..10 | Pra DLQ após N tentativas. | não |
| `extraction.retry_base_s` | int | `60` | 30..300 | Backoff base. | não |
| `extraction.retry_cap_s` | int | `1800` | 300..7200 | Backoff cap. | não |
| `extraction.layer1_min_chars` | int | `300` | 50..2000 | Threshold pra "PDF tem texto suficiente". Abaixo → ativa Layer 2 OCR. | não |
| `extraction.layer1_min_density` | float | `0.05` | 0.001..1.0 | chars/byte; PDFs imagem têm density baixa. | não |
| `extraction.ocr_chain` | array<string> | `["ocr_space","google_vision"]` | providers válidos | Ordem da chain. Adicionar `"self_hosted"` quando microservice estiver online. | não |
| `extraction.ocr_max_pages` | int | `4` | 1..10 | Cap de páginas OCR-eadas. Faturas geralmente 1-2pg. | não |
| `extraction.ocr_timeout_ms` | int | `30000` | 5000..60000 | Timeout por chamada OCR API. | não |
| `extraction.required_fields_minimum` | array<string> | `["amount_cents","due_date","barcode_or_pix"]` | nomes válidos | Campos mínimos pra early-exit a partir da pg 2. | não |
| `extraction.required_fields_complete` | array<string> | `["amount_cents","due_date","barcode","pix_payload"]` | nomes válidos | Captura completa → early-exit imediato pg 1. | não |
| `extraction.minimum_capture_min_pages` | int | `2` | 1..4 | Páginas mínimas antes de aceitar "minimum" early-exit. | não |
| `extraction.confidence_threshold` | float | `0.85` | 0.5..1.0 | ≥ threshold → status='extracted'. | não |
| `extraction.needs_review_threshold` | float | `0.50` | 0.0..confidence_threshold | ≥ → 'needs_review', < → 'failed'. | não |
| `extraction.confidence_extraction_weight` | float | `0.7` | 0.0..1.0 | Peso da camada de extração na fórmula final (vs OCR). Deve somar 1.0 com `_ocr_weight`. | não |
| `extraction.confidence_ocr_weight` | float | `0.3` | 0.0..1.0 | Peso do OCR confidence. | não |
| `extraction.invoice_prompt` | text | (template § 7.5) | string | Template do prompt enviado pro AI (Layer 4). Hot-swap permite ajustar estratégia sem deploy. | não |

**Categoria: `extraction.ocr_space` / `extraction.google_vision` (per-provider)**

| Key | Tipo | Default | Range | Impacto |
|---|---|---|---|---|
| `extraction.ocr_space.endpoint` | string | `"https://api.ocr.space/parse/image"` | URL válida | — |
| `extraction.ocr_space.api_key_secret_id` | uuid | (vault uuid) | — | Ref pra Vault secret. |
| `extraction.ocr_space.language` | string | `"por"` | OCR.space language codes | — |
| `extraction.ocr_space.daily_limit` | int | `800` | 1..25000 | Quota free é ~830/dia (25k/mês). | — |
| `extraction.ocr_space.engine` | int | `2` | 1, 2, 3 | Engine 2 recomendado pra PT. | — |
| `extraction.google_vision.endpoint` | string | `"https://vision.googleapis.com/v1/images:annotate"` | URL válida | — |
| `extraction.google_vision.api_key_secret_id` | uuid | (vault uuid) | — | — |
| `extraction.google_vision.language_hints` | array<string> | `["pt-BR"]` | BCP-47 codes | — |
| `extraction.google_vision.daily_limit` | int | `30` | 1..1000 | Quota free 1k/mês = ~33/dia. | — |
| `extraction.google_vision.feature` | string | `"DOCUMENT_TEXT_DETECTION"` | feature válida | — |

**Categoria: `ai` (LLM providers)**

| Key | Tipo | Default | Range | Impacto |
|---|---|---|---|---|
| `ai.providers.extraction.chain` | array<string> | `["gemini","groq"]` | nomes válidos | Ordem chain pra extração. Adicionar `"openrouter"` quando habilitado. |
| `ai.timeout_ms` | int | `30000` | 5000..60000 | Timeout por provider call. |
| `ai.gemini.model` | string | `"gemini-2.0-flash-001"` | model ID válido | Pinar versão. Hot-swap. |
| `ai.gemini.api_key_secret_id` | uuid | (vault uuid) | — | — |
| `ai.gemini.daily_limit` | int | `1000` | 1..1500 | Free tier ~1500/dia. |
| `ai.groq.model` | string | (a definir no deploy) | model ID atual | Verificar Groq console. |
| `ai.groq.api_key_secret_id` | uuid | (vault uuid) | — | — |
| `ai.groq.daily_limit` | int | `10000` | 1..14400 | Free tier ~14400/dia. |
| `ai.openrouter.enabled` | bool | `false` | true/false | Desligado MVP. |
| `ai.openrouter.api_key_secret_id` | uuid | (vault uuid) | — | — |

**Categoria: `ai.chain` (chain breaker)**

| Key | Tipo | Default | Range | Impacto |
|---|---|---|---|---|
| `ai.chain.auto_disable_enabled` | bool | `true` | true/false | Master do mecanismo. |
| `ai.chain.window_sec` | int | `600` | 60..3600 | Janela rolling de avaliação. |
| `ai.chain.min_samples` | int | `6` | 2..50 | Tentativas mínimas pra disparar. |
| `ai.chain.failure_ratio` | float | `1.0` | 0.5..1.0 | Threshold de falha (100% default). |
| `ai.chain.confirm_sec` | int | `60` | 30..300 | Debounce (precisa se manter). |
| `ai.chain.quota_exceeded_immediate` | bool | `true` | true/false | Quota → trip imediato (cost protection). |
| `ai.chain.invalid_response_counts` | bool | `true` | true/false | invalid_response como falha (silent quality). |
| `ai.chain.cooldown_sec` | int | `900` | 60..7200 | OPEN inicial (15min). |
| `ai.chain.cooldown_max_sec` | int | `21600` | 900..86400 | Cap exponencial (6h). |
| `ai.chain.probe_max_total` | int | `3` | 1..10 | Probes por half-open window. |
| `ai.chain.probe_success_required` | int | `2` | 1..5 | Sucessos consecutivos pra fechar. |
| `ai.chain.replay_batch_rate_per_minute` | int | `10` | 1..100 | Paced replay após fechar (evita re-trip). |
| `ai.chain.notify_on_open` | bool | `true` | true/false | Email sys admin no auto-disable. |
| `ai.chain.notify_on_recovered` | bool | `false` | true/false | Silencioso por default. |
| `ai.chain.scope_lock` | string | `"global"` | `"global"` | Apenas global aceito (rejeita scope=user/household no write). |
| `ocr.chain.*` | (idem `ai.chain.*`) | — | — | Mesmos defaults aplicados a OCR chain breaker (resource_type='ocr_provider'). |

**Categoria: `capacity` (capacity management)**

| Key | Tipo | Default | Range | Impacto |
|---|---|---|---|---|
| `capacity.measurement_interval_min` | int | `5` | 1..60 | Frequência do `capacity-monitor`. |
| `capacity.db_limit_bytes` | int | `524288000` | — | 500MB free tier. Ajustar ao migrar plano. |
| `capacity.storage_limit_bytes` | int | `1073741824` | — | 1GB free tier. |
| `capacity.target_pct` | float | `60` | 30..70 | Alvo após eviction. |
| `capacity.yellow_threshold_pct` | float | `70` | 50..80 | Entrada em yellow. |
| `capacity.orange_threshold_pct` | float | `80` | 70..90 | Entrada em orange (dispara eviction). |
| `capacity.red_threshold_pct` | float | `90` | 80..99 | Entrada em red (eviction agressiva + pausa ingestão). |
| `capacity.min_retention_days` | int | `30` | 7..90 | Piso absoluto pra qualquer eviction. |
| `capacity.pdf_min_retention_days` | int | `365` | 90..1825 | Piso pra PDFs. |
| `capacity.eviction_max_runtime_ms` | int | `45000` | 10000..55000 | Cap por execução. |

**Invariantes inter-key (validados em CI):**
```
capacity.target_pct < capacity.yellow_threshold_pct < capacity.orange_threshold_pct < capacity.red_threshold_pct
extraction.needs_review_threshold < extraction.confidence_threshold
extraction.confidence_extraction_weight + extraction.confidence_ocr_weight = 1.0
sync.fetch_max_runtime_ms < Edge Function wall_clock_ms (60000 free tier)
extraction.max_runtime_ms < 60000
capacity.eviction_max_runtime_ms < 60000
```

**Categoria: `retention` (por tabela)**

Ver §10.5 — 18 chaves no padrão `retention.<table>.{max_age_days, adaptive_floor_days, slim_after_days}`. Tipos: int em dias, range geralmente `1..3650`.

**Categoria: `security`**

| Key | Tipo | Default | Impacto |
|---|---|---|---|
| `security.cors_allowed_origins` | string (CSV) | `"unibill://*"` | Lista de origins CORS. |
| `security.rate_limits.<endpoint>` | int | varia | Rate limit per-user per-endpoint. |

**Categoria: `notifications`**

| Key | Tipo | Default | Impacto |
|---|---|---|---|
| `notifications.admin_email` | string | `""` (placeholder) | **Definir manualmente** após deploy. Recebe alertas críticos. |
| `notifications.email.capacity_red` | bool | `true` | Email em capacity=red. |
| `notifications.email.ai_chain_opened` | bool | `true` | Email no auto-disable AI chain. |
| `notifications.email.health_check_failed` | bool | `true` | Email em health check fail. |
| `notifications.email.weekly_summary` | bool | `false` | Opt-in summary semanal. |
| `notifications.email.ocr_chain_opened` | bool | `true` | Email no auto-disable OCR chain. |

**Categoria: `legal`**

| Key | Tipo | Default | Impacto |
|---|---|---|---|
| `legal.terms_version` | string | `"v1.0-2026-06"` | Versão atual dos termos. Mudança força re-consent. |
| `legal.privacy_version` | string | `"v1.0-2026-06"` | Versão da política. |
| `legal.privacy_notice_pt` | text | (markdown) | Texto da tela "O que coletamos" em PT. |
| `legal.privacy_notice_en` | text | (markdown) | EN. |
| `legal.terms_text_pt` | text | (markdown) | Termos de uso PT. |
| `legal.terms_text_en` | text | (markdown) | EN. |

**Total: ~120 chaves canônicas.** Implementação em `seeds/app_settings_defaults.sql`.

**Auditoria contínua:** CI test (`scripts/check_config_docs_sync.py`) cruza esta lista com:
1. Chaves citadas no código (`getConfig('foo.bar', ...)`) — toda chamada deve ter row aqui
2. Chaves em `seeds/app_settings_defaults.sql` — toda seed deve estar aqui
3. Falha build se houver drift

### C. State machines

**Capacity:**
```
green (0-69%) ─yellow trigger─► yellow (70-79%) ─orange trigger─► orange (80-89%) ─red trigger─► red (90%+)
   ▲                                  │                                  │                            │
   └──────────────────────────────────┴──────────────────────────────────┴────────────────────────────┘
                              após eviction bater target 60%
```

**AI chain breaker:**
```
                  ┌───────────┐
                  │  CLOSED   │ ←──────────────┐
                  └─────┬─────┘                │
                        │ trigger              │
                        ▼                      │
       ┌──────────►┌───────────┐               │
       │          │   OPEN    │                │
       │ probe    └─────┬─────┘                │
       │ fail           │ cooldown_sec         │
       │ (backoff×2)    ▼                      │
       │          ┌───────────┐                │
       └──────────│ HALF_OPEN │────────────────┘
                  │  (probe)   │ 2 probes succeed
                  └───────────┘
```

**Per-provider breaker:** mesma estrutura, sem o "tier" chain-level.

### E. API contracts — Edge Functions user-facing & admin

Endpoints orquestrados (workers internos) NÃO incluídos — apenas os chamados por cliente/admin.

#### `GET /config/resolve?key=<key>`
- **Auth**: JWT user válido
- **Output**: `{ value: jsonb, scope_resolved_from: 'user'|'household'|'global'|'default' }`
- **Errors**: 401 (sem auth), 404 (key inexistente)

#### `POST /emails/connect`
- **Auth**: JWT user
- **Body (Zod)**: `{ email_address: string.email().max(254), app_password: string.length(16).regex(/^[a-z\s]+$/), household_ids: uuid[] }`
- **Output**: `{ connected_email_id: uuid, household_bindings: [{household_id, is_default}] }`
- **Errors**: 422 (validação), 401 (auth IMAP falhou), 409 (email já cadastrado por outro user)
- **Side effects**: cria Vault secret, INSERT connected_emails, INSERT connected_email_households

#### `PATCH /emails/:id/rotate-password`
- **Auth**: JWT user (owner)
- **Body**: `{ new_app_password: string }`
- **Output**: `{ rotated_at: timestamptz }`

#### `DELETE /emails/:id`
- **Auth**: owner OR sys admin
- **Output**: `{ soft_deleted: true }`

#### `POST /invitations/redeem`
- **Auth**: JWT user
- **Body**: `{ code: string.length(8) }`
- **Output**: `{ household_id: uuid, role: 'member' }`
- **Errors**: 404 (código inválido/expirado), 403 (invited_email não bate), 429 (rate limit)

#### `POST /admin/promote-system-admin`
- **Auth**: sys admin
- **Body**: `{ target_user_id: uuid, grant: boolean, reason: string }`
- **Output**: `{ success: true, audit_id: uuid }`
- **Errors**: 403, 422 (último sys admin)

#### `POST /admin/invoices/:id/reextract`
- **Auth**: sys admin OR member da household
- **Body**: `{ force?: boolean }`
- **Output**: `{ queued: true, idempotency_key: string }`

#### `POST /privacy/export-my-data`
- **Auth**: JWT user
- **Output**: `{ download_url: string, expires_at: timestamptz }`
- **Rate limit**: 1/dia

#### `DELETE /privacy/my-account`
- **Auth**: JWT user
- **Body**: `{ confirmation_email: string, reason?: string }`
- **Output**: `{ deletion_initiated: true }`
- **Errors**: 422 (último admin de algum household), 400 (confirmation mismatch)

#### `POST /telemetry/ingest`
- **Auth**: JWT user
- **Body (Zod)**: `{ events: [{ event_type, severity, payload: jsonb, ... }] }` — max 50 events, 8KB cada
- **Output**: `{ ingested: int }`
- **Side effects**: verifica consent ativo; aplica redactSecrets; INSERT client_telemetry

#### `GET /health`
- **Auth**: opcional (Bearer service_role pra detalhes; sem auth retorna versão pública)
- **Output (público)**: `{ status: 'ok'|'degraded'|'down', timestamp: timestamptz }`
- **Output (autenticado)**: `+ { db_ok, queue_depths, ai_chain_state, capacity_status, last_sync_run_minutes_ago }`

**Headers comuns:**
- `x-correlation-id` (opcional pra cliente injetar; gerado se ausente)
- `x-client-version` (futuro, pro client-side compat checks)

### F. Business rules catalog

Catálogo de regras formalizadas extraídas do spec. Cada regra tem ID, trigger, condição precisa, efeito, configs.

| ID | Domínio | Trigger | Condição | Efeito | Configs | Eventos |
|---|---|---|---|---|---|---|
| BR-001 | Extraction | Após Layer 4 | `confidence_final >= 0.85` | `status='extracted'` | `extraction.confidence_threshold` | `invoice.extracted` |
| BR-002 | Extraction | Após Layer 4 | `0.50 <= confidence_final < 0.85` | `status='needs_review'`, `reason='low_confidence'` | `extraction.needs_review_threshold` | `invoice.needs_review` |
| BR-003 | Extraction | Após Layer 4 | `confidence_final < 0.50` | `status='failed'` | — | `invoice.extraction_failed` |
| BR-004 | Extraction | AI chain inteira falha | OPEN state ou todos providers errors | `status='needs_review'`, `reason='ai_chain_open'`; ACK pgmq | `ai.chain.*` | `invoice.routed_to_review` |
| BR-005 | OCR | OCR chain inteira falha | OPEN state | `status='needs_review'`, `reason='ocr_chain_open'` | `ocr.chain.*` | idem |
| BR-006 | AI chain breaker | 6+ tentativas chain em 10min com 0 successes E dura 60s | trigger A | `state='open'`, cooldown 15min inicial | `ai.chain.window_sec`, `min_samples`, `failure_ratio`, `confirm_sec`, `cooldown_sec` | `ai.chain.circuit_opened` |
| BR-007 | AI chain breaker | Provider retorna quota_exceeded | trigger B (imediato) | trip imediato | `ai.chain.quota_exceeded_immediate` | idem com `reason='quota'` |
| BR-008 | AI chain breaker | 2 probes consecutivos success em half_open | recovery | `state='closed'`, reset reopen_count | `ai.chain.probe_success_required` | `ai.chain.circuit_closed` + `replay_available` |
| BR-009 | AI chain breaker | Qualquer probe falha em half_open | re-open | `state='open'`, cooldown × 2^reopen_count (cap 6h) | `ai.chain.cooldown_max_sec` | `ai.chain.circuit_reopened` |
| BR-010 | Capacity | DB usage >= 80% | orange | Enfileira eviction | `capacity.orange_threshold_pct` | `capacity.threshold_crossed` |
| BR-011 | Capacity | DB usage >= 90% | red | Eviction agressiva + pausa ingestão (`features.ingestion_enabled=false`) + email admin | `capacity.red_threshold_pct` | `capacity.threshold_crossed` |
| BR-012 | Capacity | DB usage <= 85% após red | retoma | `features.ingestion_enabled=true` | implícito (vermelho-85%) | `capacity.ingestion.resumed` |
| BR-013 | Eviction | Adaptive não converge em Tier 1 | escalation | Tier 2 (floor/=2) | `retention.<table>.adaptive_floor_days` | `capacity.eviction.tier_escalated` |
| BR-014 | Households | Rebaixar/remover último admin | trigger trg_min_one_admin | `EXCEPTION`, operação bloqueada | — | — |
| BR-015 | Sync | 5+ erros IMAP consecutivos numa caixa | auto-pause | `connected_emails.status='error'` | `sync.consecutive_error_threshold` | `email.sync.auto_paused` |
| BR-016 | PDF storage | PDF em invoice > 365 dias (e Storage > 90%) | adaptive eviction | DELETE Storage, `invoices.pdf_archived_at=now()`, INSERT `pdf_archive_log` | `capacity.pdf_min_retention_days` | `pdf.archived` |
| BR-017 | LGPD | Mudança em `legal.terms_version` | re-consent | Login bloqueia até re-aceitar | — | `consent.required` |
| BR-018 | LGPD | Revogação de telemetry consent | gate | Cliente para POST; backend purga `client_telemetry` do user | — | `consent.revoked` |
| BR-019 | Privacy | Export | rate limit | 1 export/dia/user | `rate_limit_buckets:export_my_data` | — |
| BR-020 | Privacy | Export | scope | Apenas invoices touched (paid_by/created_by/updated_by = me) + PDFs de emails owned | — | — |
| BR-021 | Account deletion | Bloqueia se último admin | trigger Edge Function | 422 com lista de households | — | — |
| BR-022 | Invoices | Soft delete | Universal | `deleted_at=now()`, partial indexes excluem | — | — |
| BR-023 | OCR | Early-exit | TODOS required_fields_complete | Para no pg 1 | `extraction.required_fields_complete` | — |
| BR-024 | OCR | Early-exit minimum | TODOS required_fields_minimum + pg >= 2 | Para early | `extraction.required_fields_minimum`, `minimum_capture_min_pages` | — |
| BR-025 | Retention | Daily hard ceiling | Job cron 03:00 | DELETE WHERE age > max_age_days | `retention.<table>.max_age_days` | — |
| BR-026 | Invitations | Code expirado ou usado | redeem | 404 | `invitation.expires_at` | `invitation.redeem_failed` |
| BR-027 | Invitations | invited_email != auth.email() | redeem | 403 | — | `invitation.redeem_failed` |
| BR-028 | Sys admin | Bootstrap (1ª vez) | SQL no Studio | INSERT system_admin_grants + domain_event | — | `system_admin.bootstrapped` |

### G. Estratégia de COMMENTS em colunas

Tabela completa de comentários SQL pra **colunas business-meaningful** (não trivial). Aplica `COMMENT ON COLUMN` em migration final pós-criação:

```sql
-- invoices: campos com semântica não-óbvia
COMMENT ON COLUMN invoices.reference_period IS
  'Período de referência da fatura como aparece na nota — texto livre (ex: "05/2026", "Maio/2026", "04/2026 a 05/2026"). Não normalizar; UI exibe como veio.';
COMMENT ON COLUMN invoices.amount_cents IS
  'Valor a pagar em centavos. SEMPRE inteiro positivo. R$ 234,56 → 23456.';
COMMENT ON COLUMN invoices.barcode IS
  'Linha digitável do boleto (47 dígitos, sem espaços/pontos). NULL se fatura só PIX.';
COMMENT ON COLUMN invoices.pix_payload IS
  'BR code EMV string completa (começa com "00020126"). Mesmo conteúdo do QR Code; UI renderiza QR a partir disso.';
COMMENT ON COLUMN invoices.pix_key IS
  'Chave PIX explícita se vier separada do BR code (raro). Tipos: CPF/CNPJ/email/celular/aleatória.';
COMMENT ON COLUMN invoices.pix_txid IS
  'TX ID dentro do BR code, útil pra reconciliação se sistema futuro de pagamento usar.';
COMMENT ON COLUMN invoices.installation_id IS
  'Identificador único da unidade consumidora (UC Enel, hidrômetro Sabesp, etc.). Usado para agrupar invoices da mesma instalação.';
COMMENT ON COLUMN invoices.source_message_id IS
  'Header Message-ID do email original (RFC822). Chave de dedupe primária.';
COMMENT ON COLUMN invoices.idempotency_key IS
  'Chave determinística sha256(connected_email_id + message_id + file_hash) — dedupe na pgmq.';
COMMENT ON COLUMN invoices.extracted_payload IS
  'Payload completo da pipeline de extração (versionado {version, data}). Contém raw text excerpt, per-layer metadata, AI tokens, etc. Útil pra re-extração e debug.';
COMMENT ON COLUMN invoices.payment_confirmation_source IS
  'manual = user marcou; email_inference/invoice_inference = roadmap, futura detecção automática.';
COMMENT ON COLUMN invoices.pdf_archived_at IS
  'Quando NÃO NULL, PDF foi removido do Storage por capacity eviction. Dados extraídos ainda disponíveis; arquivo original perdido.';

-- connected_emails
COMMENT ON COLUMN connected_emails.last_processed_uid IS
  'Cursor IMAP — maior UID já processado nesta caixa. Incrementado dentro do loop por mensagem (não após batch completo) pra resiliência a crashes.';
COMMENT ON COLUMN connected_emails.consecutive_errors IS
  'Erros consecutivos no sync. Atinge sync.consecutive_error_threshold (default 5) → auto-pause (status=error).';

-- app_settings
COMMENT ON COLUMN app_settings.scope IS
  'global = uma row por key (scope_id=NULL); household = uma row por (key, scope_id=household_id); user = uma row por (key, scope_id=user_id). Resolução: user > household > global > default no código.';
COMMENT ON COLUMN app_settings.requires_restart IS
  'Se TRUE, mudança exige invalidação manual do cache de 30s. Sinaliza pra UI mostrar warning.';

-- utility_parsers
COMMENT ON COLUMN utility_parsers.version IS
  'Versionamento; só uma row active=true por utility_key (constraint via partial index).';
COMMENT ON COLUMN utility_parsers.body_must_contain IS
  'Substrings que DEVEM aparecer no texto pra parser fazer match. ALL devem bater (não any).';
```

Migration `xxx_add_business_comments.sql` é parte do deploy inicial.

### D. Tabela mestre de filas e workers

| Componente | Tipo | Frequência | Idempotência | Retry |
|---|---|---|---|---|
| `sync-dispatcher` | Edge Function | pg_cron 1min | sim (config_snapshot) | n/a (idempotente by design) |
| `sync-worker` | Edge Function + pgmq | pg_cron 1min | sim (idempotency_key em sync_runs) | 3, backoff exp |
| `extraction-worker` | Edge Function + pgmq | pg_cron 1min | sim (check extraction_runs) | 3, backoff exp |
| `capacity-monitor` | Edge Function | pg_cron 5min | sim (timestamp-based) | n/a |
| `capacity-evictor` | Edge Function + pgmq | pg_cron 1min | sim (eviction_runs) | 3 |
| `retention-hard-ceiling` | SQL cron inline | diário 03:00 | sim (idempotent DELETE) | n/a |
| `health-snapshots-aggregator` | SQL cron inline | diário 04:30 | sim | n/a |
| `archive-domain-events` | Edge Function | semanal | sim (path determinístico) | 3 |

---

**Fim do documento.**
