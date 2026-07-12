# unibill-backend

Backend Supabase do **Unibill** — app personal-scale de consolidação de faturas.

## O que é

App open source pra famílias consolidarem faturas (luz, água, gás, internet, telefone) automaticamente via email. Cobre 3 famílias × ~5 pessoas no escopo MVP.

Este repo contém:

- **Migrations** Postgres (`supabase/migrations/`)
- **Edge Functions** Deno (`supabase/functions/`)
- **Seeds** (`supabase/seeds/`)
- **pgTAP tests** (`supabase/tests/`)
- **Docs** operacionais (`docs/`)

## Stack

- Supabase Cloud (free tier): Postgres 15+, Auth, Storage, Edge Functions (Deno), pgmq, Vault, pg_cron, pg_net
- TypeScript / Deno
- Zod (validação)
- Apache 2.0

## Design

A spec consolidada (≈3500 linhas) vive em [`docs/superpowers/specs/2026-06-08-unibill-mvp-design.md`](https://github.com/Lukazukimo/unibill/blob/main/docs/superpowers/specs/2026-06-08-unibill-mvp-design.md) no workspace pai (`unibill/`).

O plano de implementação (182 tasks) está em [`docs/superpowers/plans/2026-06-09-unibill-mvp-implementation-plan.md`](https://github.com/Lukazukimo/unibill/blob/main/docs/superpowers/plans/2026-06-09-unibill-mvp-implementation-plan.md).

As decisões arquiteturais (o *porquê*) ficam em [`docs/adr/`](docs/adr/).

## Operações

Procedimentos de incidente e manutenção (backup/restore DR, force breaker, re-extração, rotação de `service_role`, capacity, vazamento de credencial) estão no [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Setup local

```bash
# Pré-requisitos
brew install supabase/tap/supabase    # ou equivalente Linux
brew install deno

# Clonar
git clone git@github.com-unibill:Lukazukimo/unibill-backend.git
cd unibill-backend

# Configurar identidade local (single-shot, sem --global)
git config user.name "Lukazukimo"
git config user.email "lukazukimomr@gmail.com"

# Inicializar Supabase local stack
supabase start
supabase db reset       # aplica migrations
make test-db            # pgTAP
deno test --allow-all   # Edge Function tests
```

## CI

GitHub Actions roda em todo PR e em push pra `main` (ver [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Jobs:

- **`lint`** — `deno fmt --check` + `deno lint` em `supabase/functions/`. Usa `denoland/setup-deno@v2`.
- **`migration-lint`** — roda `scripts/lint_migrations.sh`, que rejeita arquivos em `supabase/migrations/` que não casem com `^[0-9]{14}_[a-z0-9_]+\.sql$` (timestamp UTC de 14 dígitos + snake_case).
- **`test-db`** — sobe um service container `postgres:15` e (em tasks futuras, T-105+) aplica migrations + roda pgTAP. Hoje é esqueleto nomeado pra branch protection já casar.
- **`test-deno`** — roda `deno test --allow-all --coverage=coverage` em Edge Functions. Esqueleto até T-125 trazer os primeiros testes em `supabase/functions/_shared/`.

Push pra `main` com CI verde dispara [`.github/workflows/deploy-dev.yml`](.github/workflows/deploy-dev.yml) via `workflow_run`, que chama o workflow reusável [`.github/workflows/deploy-supabase.yml`](.github/workflows/deploy-supabase.yml) sob o GitHub Environment `dev` (histórico de deploy fica registrado) e roda os steps reais: `supabase link`, `supabase db push`, `supabase config push`, aplicação da config de auth hosted-only via Management API e `supabase functions deploy --import-map … --use-api`. O deploy de produção acontece separado: quando o release-please publica uma Release, o job `deploy-prod` chama o mesmo workflow reusável sob o Environment `production`, que é gateado por aprovação obrigatória de reviewer.

Estratégia de branches detalhada na spec §11.1.

## Estrutura de pastas

```
unibill-backend/
├── supabase/
│   ├── config.toml
│   ├── migrations/    # timestamp_descricao.sql
│   ├── functions/     # 1 pasta por Edge Function
│   ├── seeds/         # seeds estáticos (utility_parsers, app_settings defaults)
│   └── tests/         # .test.sql (pgTAP)
├── docs/
│   ├── ENVIRONMENTS.md    # project refs Supabase dev/prod
│   ├── RUNBOOK.md         # procedimentos ops
│   ├── data-dictionary.md # COMMENT ON COLUMN exportado
│   ├── configuration.md   # app_settings completo
│   ├── events.md          # domain_events catalog
│   └── adr/               # decisões arquiteturais
├── scripts/           # helpers (lint, seed generation, etc.)
├── .github/workflows/
└── Makefile
```

## Convenções

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. release-please depende disso.
- **Branches**: `feature/<task-id>-<desc>` (ex: `feature/t-105-create-app-schema`).
- **PRs**: 1 task do plano = 1 PR. Referenciar task ID na descrição.
- **Migrations**: nunca editar uma migration mergeada — sempre nova migration roll-forward. Naming: `YYYYMMDDHHMMSS_descricao.sql`.

## Workflow

1. Abrir issue por task (`gh issue create` em batch — script em `scripts/`).
2. Criar branch `feature/t-XYZ-descricao`.
3. Implementar, com testes.
4. PR contra `main` — CI roda lint + test-db (pgTAP) + deno test + migration lint.
5. Merge squash → release-please bot abre PR de release automático.
6. Tag `v*.*.*` → deploy prod com manual approval no GitHub Environment.

## TODOs

- **Deep-link redirect** (spec §9.1, T-203): hoje só registramos o custom URL
  scheme `unibill://` (`unibill://auth/callback`, `unibill://auth/recovery`,
  `unibill://auth/magic-link`) em `supabase/config.toml`. Quando o domínio
  `unibill.dev` for provisionado, adicionar `https://app.unibill.dev/auth/callback`
  a `[auth].additional_redirect_urls` e hospedar `assetlinks.json` em
  `https://unibill.dev/.well-known/` para habilitar Android App Links sem o
  prompt "abrir com" (também elimina o fallback HTML "Abra este link no
  celular com o app instalado").

## License

Apache 2.0 — ver [LICENSE](LICENSE).
