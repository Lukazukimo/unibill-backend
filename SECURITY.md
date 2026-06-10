# Security Policy

## Reportando vulnerabilidades

Se você encontrar uma vulnerabilidade de segurança, **por favor NÃO abra issue pública**. Em vez disso:

1. Envie email para: **lukazukimomr+security@gmail.com** (substituir email definitivo no deploy)
2. Inclua:
   - Descrição da vulnerabilidade
   - Passos para reproduzir
   - Impacto potencial
   - Sugestão de fix (se tiver)

Resposta esperada em até 7 dias (best effort; este é projeto pessoal).

## Versões suportadas

| Versão | Suportada |
|---|---|
| MVP (pré-1.0) | ⚠️ Apenas head da `main`; sem backports |
| 1.x | A definir após release inicial |

## Escopo

- Backend (`unibill-backend`): Edge Functions, migrations, RLS policies, Vault usage
- Mobile (`unibill-mobile`): app password handling, deep links, local storage
- Pipeline: extração, OCR, AI provider chain

**Out of scope:**
- Vulnerabilidades em dependências de terceiros (Supabase, Flutter, libs npm) — reporte upstream
- Erros de configuração específicos do user (ex: senha fraca do Gmail)

## Padrões aplicados

- LGPD compliance (consentimento, exportação, exclusão)
- Supabase Vault para credenciais (app passwords cifradas)
- RLS para tenancy isolation
- Rate limiting + circuit breakers para resiliência
- Redaction obrigatória de secrets em logs/payloads
- HIBP password check (Supabase Auth)

## Coordenação de disclosure

Após acordar fix + timeline:
1. Patch privado preparado
2. Notificação a users (se necessário)
3. Release com fix
4. Disclosure público (CVE se aplicável) após 30 dias do fix

## Hall of fame

Contribuidores de segurança serão creditados aqui (com permissão).
