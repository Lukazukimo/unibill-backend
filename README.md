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

## License

Apache 2.0 — ver [LICENSE](LICENSE).
