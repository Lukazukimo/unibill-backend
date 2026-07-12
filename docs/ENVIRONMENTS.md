# Environments — Supabase (dev / prod)

Coordenadas dos projetos Supabase do Unibill e a receita de provisionamento. **Este
arquivo contém apenas refs e URLs públicas.** Segredos (DB password, `service_role`
key, chaves de vault) **nunca** entram no repo — ficam no gerenciador de senhas. A
`anon`/publishable key é pública (vai no app mobile), mas por convenção também não é
commitada aqui: pegue no Dashboard → *Project Settings → API*.

Contexto: provisionamento rastreado em [#1]. Origem cloud: org `hxsdyolvhihnhwnxazgf`
(plano Free, 2 projetos).

## Projetos

| Ambiente | Ref | API URL | Região | Plano |
|---|---|---|---|---|
| **dev** | `pciwwcsgsjbvwxdwdiwr` | `https://pciwwcsgsjbvwxdwdiwr.supabase.co` | us-east-1 | Free |
| **prod** | `lvvzjthudhwggfmeiius` | `https://lvvzjthudhwggfmeiius.supabase.co` | us-east-1 | Free |

> Snapshot de estado em 2026-07-11: **dev** = 58 migrations + 32 Edge Functions;
> **prod** = pendente de provisionamento (0 migrations). Atualize ao promover prod.

## Receita de provisionamento (CLI, bootstrap / break-glass)

> No dia a dia o deploy é **automatizado** — ver [CI/CD](#cicd--deploy-automatizado-t-638).
> Esta receita manual serve para o bootstrap inicial de um projeto novo ou break-glass.

Rodar da raiz de `unibill-backend`, com o `SUPABASE_ACCESS_TOKEN` (PAT) exportado ou
após `supabase login`. Todos os comandos via `mise exec --` (toolchain pinada).

```bash
# 1. Linkar ao projeto (pede a DB password — está no gerenciador de senhas).
mise exec -- supabase link --project-ref <REF>       # dev=pciwwcsgsjbvwxdwdiwr | prod=lvvzjthudhwggfmeiius

# 2. Aplicar migrations (idempotente — aplica só as que faltam).
mise exec -- supabase db push

# 3. Deploy das Edge Functions. O import map fica em supabase/functions/import_map.json
#    (o deploy não enxerga o deno.jsonc raiz — ver PR #305). SEM a flag, o bare
#    `import { z } from 'zod'` quebra o graph.
mise exec -- supabase functions deploy --import-map supabase/functions/import_map.json
```

## CI/CD — deploy automatizado (T-638)

No dia a dia **não é preciso rodar a receita manual acima**. O deploy é automatizado por
três workflows (design em `docs/superpowers/specs/2026-07-12-supabase-deploy-pipeline-design.md`):

- **`.github/workflows/deploy-supabase.yml`** — workflow reutilizável com o job de deploy
  inteiro: `link` → `db push` → `config push` → config de auth hosted-only via Management API
  → smoke-test de IA → `functions deploy --import-map … --use-api` → health check.
- **`.github/workflows/deploy-dev.yml`** — dispara via `workflow_run` após o **CI** passar no
  `main` e chama o reutilizável sob o Environment **`dev`** (deploy automático a cada merge).
- **`.github/workflows/release-please.yml`** (job `deploy-prod`) — quando o release-please
  publica uma Release, chama o reutilizável sob o Environment **`production`**, **gateado por
  aprovação obrigatória de reviewer**. (Vive aqui, e não num `on: release`, porque Releases
  criadas pelo `GITHUB_TOKEN` padrão não disparam outros workflows.)

Fluxo: `merge no main → CI → deploy dev` · `Release publicada → aprovação → deploy prod`.

Os secrets são **por GitHub Environment** (`dev` + `production`, sem sufixo) — ver
[`secrets.md`](secrets.md). O gate de prod É a regra *required reviewer* no Environment
`production`.

## Config de Auth (automatizada pelo pipeline; checklist = valores)

O pipeline aplica a config de auth automaticamente: `supabase config push` (o que tem chave no
`config.toml`) + um `PATCH` na Management API para os itens hosted-only (HIBP). Este checklist
é a **referência dos valores** (fonte: `supabase/config.toml`, spec §9.1) e o fallback manual
no **Dashboard → Authentication** caso precise ajustar à mão:

**Sessão / tokens**
- [ ] JWT (access token) expiry = **3600s (1h)** (`jwt_expiry`)
- [ ] Refresh token rotation = **ON** (`enable_refresh_token_rotation`)
- [ ] Refresh token reuse interval = **0** (single-use)
- [ ] **Refresh token lifetime = 1 semana** ⚠️ *hosted-only* (sem chave no config.toml, spec §9.1)

**Senha**
- [ ] Minimum password length = **10** (`minimum_password_length`)
- [ ] Password requirements = **lower + upper + digit + symbol** (`password_requirements`)
- [ ] **Leaked-password protection (HIBP) = ON** ⚠️ *hosted-only* (sem chave no config.toml, spec §9.1; ver #213)

**Email / signup**
- [ ] Enable signup = ON (`enable_signup`)
- [ ] Confirm email on signup = ON (`enable_confirmations`)
- [ ] Confirm email change (double confirm) = ON (`double_confirm_changes`)
- [ ] OTP / recovery link expiry = **3600s** (`otp_expiry`) · OTP length = **6**
- [ ] Templates de email em **pt-BR** (ex.: magic link → `"Seu link de acesso ao Unibill"`)

**URLs**
- [ ] Site URL = `unibill://` (`site_url`)
- [ ] Redirect URLs: `unibill://auth/callback`, `unibill://auth/recovery`, `unibill://auth/magic-link`

**Rate limits (GoTrue)**
- [ ] Sign-in/sign-up = **5/h por IP** (`sign_in_sign_ups`)
- [ ] Email sent (OTP/magic-link) = **5/h por email** (`email_sent`)

## Verificação pós-provisionamento (via MCP / Dashboard)

- [ ] `get_advisors(security)` sem ERROR de `rls_disabled_in_public` (fix em PR #304 / migration `20260711130000`).
- [ ] `list_migrations` termina em `20260711130000_harden_service_role_rls`.
- [ ] `list_edge_functions` = 32 funções `ACTIVE`.
- [ ] Extensões: pgmq, pg_cron, pg_net, pgtap, pgsodium habilitadas (via bootstrap migration).

## Segredos (fora do repo)

| Segredo | Onde | Uso |
|---|---|---|
| DB password (por projeto) | gerenciador de senhas | `supabase link` |
| `service_role` key | gerenciador de senhas / Edge Function env | workers, reads privilegiados |
| Vault keys (IMAP, AI providers) | Supabase Vault (`vault_setup_*` migrations) + gerenciador | extração/sync |
| `anon`/publishable key | Dashboard → API (pública, vai no app mobile) | cliente Flutter |

[#1]: https://github.com/Lukazukimo/unibill-backend/issues/1
