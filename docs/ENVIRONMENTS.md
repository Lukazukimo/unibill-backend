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

## Receita de provisionamento (CLI)

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

## Config de Auth no Dashboard (manual — `db push` NÃO empurra isto)

`supabase db push` aplica só migrations. O bloco `[auth]` do `config.toml` vale para o
stack local; no projeto hosted os mesmos valores têm que ser setados no **Dashboard →
Authentication** (ou via `supabase config push`, experimental). Espelhar de
`supabase/config.toml` (fonte da verdade, spec §9.1):

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
