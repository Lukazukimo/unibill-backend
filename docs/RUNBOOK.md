---
last_updated: 2026-06-25
version: 1.0
---

# Unibill Runbook

Operational procedures for the Unibill backend (Supabase Postgres + Edge
Functions). Each section is **Quando** (when you reach for it) + **Como** (the
steps/commands). Keep this current as incidents teach us new steps.

> Conventions: SQL runs as `postgres`/`service_role` (psql against the pooler or
> the Studio SQL editor). `/sys-admin/*` paths are the operator UI (mobile/web);
> every UI action below has an SQL/REST equivalent so the runbook works before
> the UI ships.

## Index

1. [Backup restore (DR)](#1-backup-restore-dr)
2. [Force chain breaker (AI / OCR)](#2-force-chain-breaker-ai--ocr)
3. [Re-extract invoice batch](#3-re-extract-invoice-batch)
4. [Rotate service_role key](#4-rotate-service_role-key)
5. [Capacity emergency](#5-capacity-emergency)
6. [User reports missing invoice](#6-user-reports-missing-invoice)
7. [Suspeita de vazamento de credencial](#7-suspeita-de-vazamento-de-credencial)
8. [Test restore (a cada 6 meses)](#8-test-restore-a-cada-6-meses)

**Area runbooks (deep dives):**
[ingestion-ops](runbooks/ingestion-ops.md) ·
[extraction-pipeline](runbooks/extraction-pipeline.md) ·
[bootstrap-sys-admin](runbooks/bootstrap-sys-admin.md)

---

## 1. Backup restore (DR)

**Quando:** perda de dados, corrupção, ou recriação do projeto Supabase do zero.
Backups: `pg_dump --format=custom` semanal → Backblaze B2 (§11.3).

### Pré-requisitos

- `psql`, `pg_restore`, `awscli` configurados
- Acesso ao bucket B2 com credenciais válidas
- Supabase project alvo provisionado (dev ou novo)

### Como

1. Listar backups:
   `aws s3 ls s3://unibill-backups/ --endpoint-url=https://s3.us-west-002.backblazeb2.com`
2. Baixar o último:
   `aws s3 cp s3://unibill-backups/unibill-YYYYMMDD.dump ./ --endpoint-url=https://s3.us-west-002.backblazeb2.com`
3. Configurar conn string:
   `export PGURL='postgres://...@aws-0-us-east-1.pooler.supabase.com:5432/postgres'`
4. Restaurar:
   `pg_restore --no-owner --no-acl --clean --if-exists -d "$PGURL" ./unibill-YYYYMMDD.dump`
5. Verificações pós-restore (smoke):
   - `SELECT count(*) FROM households;` → > 0
   - `SELECT count(*) FROM invoices WHERE status='extracted';` → comparar com o último monitor
   - `SELECT now() - max(checked_at) FROM capacity_snapshots;` → < 1h

---

## 2. Force chain breaker (AI / OCR)

**Quando:** provider rotacionando, debugging, ou false-positive deixou o breaker aberto.

### Como

1. UI: `/sys-admin/ai-chain` → "Force Close" ou "Force Open".
2. SQL direto:
   ```sql
   UPDATE circuit_breakers
      SET state = 'closed', reopen_count = 0
    WHERE resource_type = 'ai_chain';   -- ou 'ocr_chain'
   ```
   Fechar o breaker dispara o evento `ai.chain.replay_available` (chain_breaker.ts);
   re-enfileire os `needs_review` com `reason='ai_chain_open'` via §3.

---

## 3. Re-extract invoice batch

**Quando:** um parser quebrou e foi corrigido; há um lote preso em `needs_review`.

### Como

1. Identificar as invoices:
   ```sql
   SELECT id FROM invoices
    WHERE status = 'needs_review' AND utility_key = 'enel-sp'
      AND extracted_at < 'YYYY-MM-DD';
   ```
2. Para cada uma: `POST /admin/invoices/:id/reextract` com `{ "force": true }`
   (Edge Function `admin-invoice-reextract`).
3. Acompanhar via `/sys-admin/extraction-runs` ou
   `SELECT * FROM extraction_runs ORDER BY started_at DESC LIMIT 50;`.

Para um replay em massa após reabrir o breaker, ver
`POST /admin/replay-chain` (`admin-replay-chain`).

---

## 4. Rotate service_role key

**Quando:** vazamento suspeito, ou rotação rotineira (anual).

> `service_role` bypassa RLS — qualquer um com a key tem acesso total.

### Como

1. Supabase Dashboard → Project Settings → API → "Generate new service_role key".
2. `ALTER DATABASE postgres SET app.service_role_key = '<nova>';` (psql como `postgres`).
3. Recarregar: `SELECT pg_reload_conf();` (ou aguardar reconexões naturais).
4. Atualizar o secret `SUPABASE_SERVICE_ROLE_KEY` nas GitHub Actions.
5. Invalidar a key antiga no Dashboard assim que o deploy novo estiver de pé.

---

## 5. Capacity emergency

**Quando:** `capacity_snapshots` mostra `red` e a auto-eviction não consegue baixar.

### Como

1. Entender por que não convergiu:
   `SELECT * FROM eviction_runs ORDER BY started_at DESC LIMIT 20;`
2. Subir `capacity.target_pct` temporariamente (ex.: 75) via `app_settings`.
3. Trigger manual: UI `/sys-admin/dashboard` → "Force eviction now"
   (ou enfileirar em `capacity_eviction_queue`).
4. Ingestão pausa automaticamente em `red` (`features.ingestion_enabled=false`) e
   retoma sozinha em <85%. Se ainda não baixar → upgrade pra Pro tier.

---

## 6. User reports missing invoice

**Quando:** usuário diz que uma fatura não apareceu.

### Como

1. Identificar a caixa via `connected_emails.email_address`.
2. Checar `sync_runs` das últimas 24h: rodou? viu a mensagem? processou?
   `SELECT * FROM sync_runs WHERE connected_email_id = '<id>' ORDER BY started_at DESC;`
3. Foi soft-deletada? `SELECT id, deleted_at FROM invoices WHERE ...;`
4. Caiu na DLQ? `SELECT * FROM pgmq.q_invoice_dlq;` (e `q_email_sync_dlq`).
5. Se ficou em `needs_review`/`failed`, ver §3 pra re-extração.

---

## 7. Suspeita de vazamento de credencial

**Quando:** indício de que um app password / credencial IMAP vazou.

### Como

1. **Imediato:** revogar o app password no Gmail do usuário.
2. Revogar a conexão no Unibill (`emails-delete` → soft-delete + `delete_vault_secret`),
   o que apaga o secret do Vault.
3. Auditar:
   ```sql
   SELECT * FROM domain_events
    WHERE event_type LIKE 'email.%'
    ORDER BY occurred_at DESC LIMIT 50;
   ```
4. Notificar o usuário (template "credencial revogada").
5. Se a `service_role` key puder ter vazado, executar a §4 também.

---

## 8. Test restore (a cada 6 meses)

**Quando:** validação periódica do DR (o backup só vale se o restore funcionar).

### Como

1. Provisionar um Supabase project temporário (free tier, novo).
2. Rodar o restore do último backup conforme a §1.
3. Smoke tests + comparação de counts com produção.
4. Registrar data + resultado:
   ```sql
   -- app_settings key ops.last_backup_test_at
   UPDATE app_settings SET value = jsonb_build_object('v', now()::text)
    WHERE key = 'ops.last_backup_test_at' AND scope = 'global';
   ```
5. Destruir o project temporário.

> A execução documentada deste drill é a task **T-622**.
