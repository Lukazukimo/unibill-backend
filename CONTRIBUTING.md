# Contributing to Unibill

Obrigado por considerar contribuir! Estes guidelines são curtos — refine quando o repo crescer.

## Antes de mexer

1. Veja o **plano de implementação** em `docs/superpowers/plans/2026-06-09-unibill-mvp-implementation-plan.md` (workspace pai) — 182 tasks com IDs `T-XYZ`, dependências, e acceptance criteria.
2. Confirme se a feature/bug que você quer atacar **já está coberto** por alguma task ou issue aberta.
3. Se for nova ideia: abra issue primeiro descrevendo o problema + proposta antes de mandar PR.

## Setup

Ver README do repo (`README.md`).

## Branch + commit

- **Branch naming**: `feature/t-XYZ-descricao`, `fix/t-XYZ-descricao`, `chore/<desc>`, `docs/<desc>`
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/)
  - `feat:` nova feature
  - `fix:` bug fix
  - `docs:` documentação
  - `chore:` build/deps/config
  - `refactor:` refactor sem mudança funcional
  - `test:` adição/correção de testes
  - `BREAKING CHANGE:` no rodapé ou `!` após tipo → bump major
- **Mensagem**: imperativa, curta no header (<72 chars), corpo explicando *por quê*

Exemplo:
```
feat(invoices): add PIX payload extraction from Layer 3 regex

Implements T-405. Adds pix_regex column extraction in utility_parsers
and updates the regex execution path to capture pix_payload when present.

Refs: §7.4, BR-002
```

## PR

- 1 task = 1 PR
- Descrição: incluir task ID + checklist dos `acceptance_criteria` da task
- CI verde antes do merge
- Squash merge (preserva histórico Conventional Commits)
- Pelo menos 1 review (CODEOWNERS triggers automático)

## Code review checklist

- [ ] Cobertura de testes mantida (ver thresholds em `coverage` no CI)
- [ ] Migrations: roll-forward, nunca editar mergeadas
- [ ] RLS: toda tabela com PII tem teste pgTAP cross-tenant
- [ ] Secrets: nunca em código nem em logs (`redactSecrets()` helper)
- [ ] Conventional Commits respeitados
- [ ] Docs atualizadas (se aplicável)

## Filosofia

- **Open source**: Apache 2.0; sem dependências proprietárias core
- **Design at scale**: padrões profissionais (pgmq, circuit breakers, idempotency) mesmo em projeto pequeno
- **LGPD-first**: consent gates, scrubbing, retention configurada
- **Self-healing**: capacity/breaker patterns auto-recuperam sem intervenção

## Reportar bug ou pedir feature

Issues no GitHub. Label apropriado (`bug`, `enhancement`, `docs`, `question`).
