# Contributing to Unibill (backend)

Obrigado por considerar contribuir!

## Antes de mexer

1. Veja o **plano de implementação** em [`docs/superpowers/plans/2026-06-09-unibill-mvp-implementation-plan.md`](docs/superpowers/plans/2026-06-09-unibill-mvp-implementation-plan.md) — 182 tasks `T-XYZ` com dependências e acceptance criteria.
2. Veja o **design spec** em [`docs/superpowers/specs/2026-06-08-unibill-mvp-design.md`](docs/superpowers/specs/2026-06-08-unibill-mvp-design.md) — arquitetura, schemas, RLS, ops.
3. Confirme se sua intenção **já está coberta** por uma issue/task aberta.
4. Se for nova ideia: abra **Feature request** issue antes de mandar PR.
5. **Tasks de mobile/Flutter** vivem em [`Lukazukimo/unibill-mobile`](https://github.com/Lukazukimo/unibill-mobile) — não neste repo.

## Setup

Ver [`README.md`](README.md).

## Branch + commit

**Branch naming:** `tipo/T-XYZ-descricao-curta` (1 task = 1 branch)

| Prefixo | Quando usar |
|---|---|
| `feat/` | Nova feature ou capability |
| `fix/` | Bug fix |
| `docs/` | Apenas docs/comentários |
| `chore/` | Build/deps/tooling/scaffolding |
| `refactor/` | Refactor sem mudança comportamental |
| `test/` | Adição/correção de testes |
| `ci/` | Workflows / CI scripts |
| `ops/` | Scripts ops, runbooks, bootstrap |

Exemplos:
- `feat/T-301-invoices-table-with-pix-fields`
- `fix/T-204-lockout-window-rollover-bug`
- `docs/T-126-erd-data-dictionary`
- `chore/T-619-pr-workflow-templates`

**Commits:** [Conventional Commits](https://www.conventionalcommits.org/)

- `feat:` nova feature
- `fix:` bug fix
- `docs:` documentação
- `chore:` build/deps/config/tooling
- `refactor:` refactor sem mudança funcional
- `test:` adição/correção de testes
- `ci:` workflows / scripts CI
- `ops:` runbooks, bootstrap, ops
- `BREAKING CHANGE:` no rodapé ou `!` após tipo → bump major

Header curto (<72 chars), corpo explica *por quê*. Inclua `Refs: §X.Y` ou `Closes #N` no rodapé.

Exemplo:
```
feat(invoices): add PIX payload extraction from Layer 3 regex

Implements T-411 layer-3 regex pipeline. Captures pix_payload, pix_qr_url,
and barcode_payload from utility_parsers regex set when match=true and
confidence >= 0.85.

Refs: §7.4, BR-002
Closes #58
```

## PR workflow

1. **Crie branch a partir de `main` atualizada** (`git pull origin main` antes).
2. Implemente + teste localmente (`make db-reset` + `deno test`).
3. **Push e abra PR** usando o [template](.github/PULL_REQUEST_TEMPLATE.md):
   - Title segue Conventional Commits
   - `Closes #N` no body pra auto-fechar issue ao merger
   - Marque o test plan checklist conforme avança
4. **CI verde antes do merge** (lint + migration-lint + pgTAP + Deno tests).
5. **Merge method:** `merge commit` para PRs com múltiplos commits (preserva histórico Conventional Commits); `squash` para PRs com 1 commit "trabalho-em-progresso" que não vale preservar.
6. **Delete branch após merge** (GitHub mostra botão; aceite a sugestão).

## Code review checklist

- [ ] Cobertura de testes mantida (thresholds em `coverage` no CI)
- [ ] Migrations: roll-forward only, nunca editar mergeadas
- [ ] RLS: toda tabela com PII tem teste pgTAP cross-tenant
- [ ] Secrets nunca em código nem em logs (`redactSecrets()` helper)
- [ ] Conventional Commits respeitados (commit message + PR title)
- [ ] Docs atualizadas (ERD, data dictionary, RUNBOOK se aplicável)
- [ ] Source link no body da issue ainda aponta pra plan corretamente

## Filosofia

- **Open source**: Apache 2.0; sem dependências proprietárias core
- **Design at scale**: padrões profissionais (pgmq, circuit breakers, idempotency) mesmo em projeto pequeno
- **LGPD-first**: consent gates, scrubbing, retention configurada
- **Self-healing**: capacity/breaker patterns auto-recuperam sem intervenção
- **Branch protection diferida**: repos private + conta Free não suporta branch protection. Disciplina via PR template + CODEOWNERS + revisão obrigatória por convenção. Ao migrar pra repo público (pós-MVP), ativar branch protection no settings.

## Reportar bug ou pedir feature

Use os templates de issue: **Bug report** (`🐛`) ou **Feature request** (`✨`). Templates configurados em [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).

## Releases

Releases são automatizadas via [release-please](https://github.com/googleapis/release-please): a cada merge em `main`, um PR de release é mantido aberto, agregando commits desde a última tag e gerando CHANGELOG.md. Merger esse PR cria a tag + GitHub Release.
