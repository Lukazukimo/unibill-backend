# Runbook — Extraction Pipeline & Chain Breaker Operations

**Task:** T-429
**Spec refs:** [§7 Extraction pipeline](../superpowers/specs/2026-06-08-unibill-mvp-design.md) · §7.5 (provider chains + smoke) · §7.5.1 (failure→status) · §7.6 (chain breaker) · §7.7 (confidence) · §7.8 (extracted_payload) · §7.9 (re-extraction)
**Edge Functions:** [`admin-invoice-reextract`](../../supabase/functions/admin-invoice-reextract/index.ts) (T-420) · [`admin-replay-chain`](../../supabase/functions/admin-replay-chain/index.ts) (T-421) · [`extraction-worker`](../../supabase/functions/extraction-worker/index.ts) (T-418)
**Script:** [`scripts/smoke_test_ai_providers.ts`](../../scripts/smoke_test_ai_providers.ts) (T-419)
**Tables:** `invoices` · `extraction_runs` · `ai_calls` · `circuit_breakers` · pgmq `invoice_queue` / `invoice_dlq`

---

## How extraction works (one paragraph)

The `extraction-worker` (pg_cron, every minute) drains `invoice_queue` and runs four layers per invoice: **Layer 1** pdfjs native text → **Layer 2** OCR (when text is insufficient) → **Layer 3** regex per-utility → **Layer 4** AI fallback (only when regex confidence < `extraction.confidence_threshold` **and** the AI chain breaker is closed). The blended confidence (§7.7) maps to `invoices.status` ∈ `extracted` / `needs_review` / `failed`. Two circuit breakers protect it: the **per-provider** breaker (`circuit_breakers` `resource_type='ai_provider'|'ocr_provider'`) and the **chain** breaker (`resource_type='ai_chain'|'ocr_chain'`, `resource_key='extraction_default'`). When the AI chain is open, invoices land in `needs_review` with `needs_review_reason='ai_chain_open'`; when it recovers they are replayed (procedure 3).

> **Auth for the admin endpoints.** All `/admin/*` endpoints require a Bearer JWT whose `app_metadata.is_system_admin = true` (see [bootstrap-sys-admin runbook](./bootstrap-sys-admin.md)). Export one as `$ADMIN_JWT` and the project base as `$BASE` (e.g. `https://<ref>.supabase.co`) before the curl snippets below.

```bash
export BASE="https://<project-ref>.supabase.co"
export ADMIN_JWT="<a system-admin user's access token>"
```

> **SQL fallbacks** run in Supabase Studio → SQL editor (service-role context) or `psql` as `postgres`. They are the break-glass path when the admin endpoints / mobile are unavailable.

---

## Procedure 1 — Manually re-extract an invoice

**When:** an invoice extracted wrong (bad parser match, low confidence, stale data) and you want to re-run the pipeline. `force=true` makes the worker re-run even a terminal (`extracted`/`needs_review`/`failed`) invoice (§7.9).

### Endpoint (preferred)

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "content-type: application/json" \
  "$BASE/functions/v1/admin-invoice-reextract/<INVOICE_UUID>" \
  -d '{"force": true}'
# → 200 {"queued": true, "msg_id": 1234}
```

- Rate-limited **30/hour per admin** → `429` when exhausted (wait or use the SQL fallback).
- The worker picks the message up within ~1 minute (next cron tick). Emits `invoice.reextract_requested` (audit) then `invoice.<status>` on completion.
- **Mobile:** the "Re-extrair fatura" action on the invoice detail screen calls the same endpoint (Lukazukimo/unibill-mobile).

### Verify

```sql
-- the most recent extraction attempt for the invoice
SELECT status, method, confidence, started_at, finished_at, error_summary
FROM public.extraction_runs WHERE invoice_id = '<INVOICE_UUID>'
ORDER BY started_at DESC LIMIT 3;

SELECT status, extraction_method, extraction_confidence, needs_review_reason, extracted_at
FROM public.invoices WHERE id = '<INVOICE_UUID>';
```

### SQL fallback (endpoint/mobile down)

```sql
-- enqueue directly; force=true bypasses the worker's terminal-status guard
SELECT app.queue_send(
  'invoice_queue',
  jsonb_build_object(
    'invoice_id', '<INVOICE_UUID>',
    'correlation_id', gen_random_uuid()::text,
    'force', true
  )
);
```

---

## Procedure 2 — Force-open / force-close a chain breaker

**When:** you must manually disable a chain (e.g. a provider incident not yet auto-detected → force-open to stop burning quota) or re-enable one (e.g. after fixing config → force-close instead of waiting out the cooldown).

The chain rows live in `circuit_breakers` with `resource_type ∈ {ai_chain, ocr_chain}` and `resource_key='extraction_default'`. `state` is the enum `closed | open | half_open` (§7.6).

### Inspect current state

```sql
SELECT resource_type, resource_key, state, failure_count, opened_at,
       next_probe_at, probes_sent, probes_succeeded, reopen_count, reason
FROM public.circuit_breakers
WHERE resource_type IN ('ai_chain', 'ocr_chain', 'ai_provider', 'ocr_provider')
ORDER BY resource_type, resource_key;
```

### Force OPEN (disable the AI chain now)

```sql
INSERT INTO public.circuit_breakers
  (resource_type, resource_key, state, opened_at, next_probe_at, reason, updated_at)
VALUES
  ('ai_chain', 'extraction_default', 'open', now(),
   now() + interval '900 seconds', 'manual force-open (ops)', now())
ON CONFLICT (resource_type, resource_key) DO UPDATE
  SET state = 'open', opened_at = now(),
      next_probe_at = now() + interval '900 seconds',
      reason = 'manual force-open (ops)', updated_at = now();
```

While open, Layer 4 is skipped and invoices needing it land in `needs_review` / `ai_chain_open` — replay them once recovered (procedure 3). Use `ocr_chain` to disable the OCR chain instead.

### Force CLOSE (re-enable immediately)

```sql
UPDATE public.circuit_breakers
SET state = 'closed', failure_count = 0, probes_sent = 0, probes_succeeded = 0,
    opened_at = NULL, half_open_started_at = NULL, next_probe_at = NULL,
    closed_at = now(), reason = 'manual force-close (ops)', updated_at = now()
WHERE resource_type = 'ai_chain' AND resource_key = 'extraction_default';
```

> Forcing closed does **not** auto-replay the parked invoices (the OPEN→CLOSED edge that emits `ai.chain.replay_available` only fires through a real half-open probe). After a manual force-close, run procedure 3 explicitly.

---

## Procedure 3 — Post-chain-recovery replay

**When:** a chain breaker recovered (you saw an `ai.chain.replay_available` domain event, or you force-closed it) and invoices are parked in `needs_review` with `needs_review_reason='ai_chain_open'` (or `ocr_chain_open`).

### How many are eligible

```sql
SELECT needs_review_reason, count(*)
FROM public.invoices
WHERE needs_review_reason IN ('ai_chain_open', 'ocr_chain_open') AND deleted_at IS NULL
GROUP BY 1;
```

The recovery event payload also carries this: look for `event_type='ai.chain.replay_available'` in `domain_events` with `payload->'data'->>'eligible_count'`.

### Replay (preferred)

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "content-type: application/json" \
  "$BASE/functions/v1/admin-replay-chain" \
  -d '{"chain_name": "ai_chain"}'
# → 200 {"chain_name":"ai_chain","replayed":42,"rate_per_minute":10}
```

- Re-enqueues each parked invoice with `force=true`, **paced** at `ai.chain.replay_batch_rate_per_minute` (default **10/min**) using per-message visibility delays, and clears `needs_review_reason`.
- **Expected timing:** `ceil(replayed / rate)` minutes for the last batch to become visible — e.g. 42 invoices at 10/min → batches at 0, 1, 2, 3, 4 min; fully drained a few minutes after that (worker runs every minute). Tune the rate first if needed:

```sql
UPDATE public.app_settings
SET value = jsonb_build_object('v', 20), updated_at = now()
WHERE key = 'ai.chain.replay_batch_rate_per_minute' AND scope = 'global';
```

### SQL fallback

```sql
-- enqueue all parked AI-chain invoices, then clear the reason
WITH parked AS (
  SELECT id FROM public.invoices
  WHERE needs_review_reason = 'ai_chain_open' AND deleted_at IS NULL
)
SELECT app.queue_send('invoice_queue',
  jsonb_build_object('invoice_id', id, 'correlation_id', gen_random_uuid()::text, 'force', true))
FROM parked;

UPDATE public.invoices SET needs_review_reason = NULL
WHERE needs_review_reason = 'ai_chain_open' AND deleted_at IS NULL;
```

> The fallback enqueues with **no pacing** — only use it for small backlogs, or add a `pg_sleep` / batch the `WHERE` by `id` ranges for large ones.

---

## Procedure 4 — Provider model deprecation playbook (Gemini / Groq)

**When:** a provider deprecates a model (extraction starts failing with HTTP 404 — the deploy smoke test, T-419, also catches this). Models are pinned in `app_settings`: `ai.gemini.model`, `ai.groq.model` (the value `TBD_SET_AT_DEPLOY` is the sentinel meaning "not set — fail loudly").

### 1. Find the current + replacement model

```sql
SELECT key, value->>'v' AS model
FROM public.app_settings
WHERE key IN ('ai.gemini.model', 'ai.groq.model', 'ai.providers.extraction.chain');
```

Check the provider console for the current model id (Gemini: ai.google.dev; Groq: console.groq.com — Groq decommissions preview models often).

### 2. Smoke-test the NEW model locally BEFORE touching prod

Point the script at the prod project but with the candidate model. Quickest: temporarily set the key in a scratch/dev project, or export the candidate and dry-run against the provider. The script reads the chain + per-provider model from `app_settings` and pings each with a 1-token call:

```bash
SUPABASE_URL="$BASE" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
GEMINI_API_KEY="<key>" GROQ_API_KEY="<key>" \
  deno run --allow-env --allow-net scripts/smoke_test_ai_providers.ts
# exit 0 = all providers HTTP 200; exit 1 = a model is unavailable (prints the offending provider+model)
```

### 3. Apply to prod

```sql
UPDATE public.app_settings
SET value = jsonb_build_object('v', '<new-model-id>'), updated_at = now()
WHERE key = 'ai.groq.model' AND scope = 'global';
```

Config is read fresh per call (no restart needed). Re-run the smoke test against prod to confirm, then re-extract any invoices that failed during the outage (procedure 1) or replay the parked chain (procedure 3).

### 4. Rollback

```sql
-- revert to the previous known-good model id
UPDATE public.app_settings
SET value = jsonb_build_object('v', '<previous-model-id>'), updated_at = now()
WHERE key = 'ai.groq.model' AND scope = 'global';
```

---

## Procedure 5 — Diagnosing low-confidence / failing batches

**When:** a spike of `needs_review` / `failed` invoices, or you want to know which layer/provider is degrading.

### Outcome distribution (last 24h)

```sql
SELECT method, status, count(*) AS n, round(avg(confidence), 2) AS avg_conf
FROM public.extraction_runs
WHERE started_at > now() - interval '24 hours'
GROUP BY method, status
ORDER BY method, status;
```

### Provider health (last 24h, excluding synthetic smoke calls)

```sql
SELECT provider, model, status, count(*) AS n, round(avg(latency_ms)) AS avg_ms
FROM public.ai_calls
WHERE called_at > now() - interval '24 hours' AND synthetic = false
GROUP BY provider, model, status
ORDER BY provider, n DESC;
```

`status` values follow the §7.5.1 table (`success` / `rate_limited` / `quota_exceeded` / `timeout` / `error` / `invalid_response` / `circuit_open`). A burst of `invalid_response` = the model output drifted (prompt/model issue, not provider health); `quota_exceeded` = you hit a daily limit (Trigger B opens the chain immediately).

### The actual low-confidence invoices

```sql
SELECT id, extraction_method, extraction_confidence, needs_review_reason, extraction_error, extracted_at
FROM public.invoices
WHERE status IN ('needs_review', 'failed') AND extracted_at > now() - interval '24 hours'
ORDER BY extraction_confidence NULLS FIRST;
```

Inspect a single payload (the §7.8 telemetry envelope) to see which layers ran:

```sql
SELECT extracted_payload->'data'->>'method' AS method,
       extracted_payload->'data'->'layer1' AS layer1,
       extracted_payload->'data'->'layer3' AS layer3,
       extracted_payload->'data'->'layer4' AS layer4,
       extracted_payload->'data'->>'confidence_final' AS confidence_final
FROM public.invoices WHERE id = '<INVOICE_UUID>';
```

### Stuck / DLQ'd messages

```sql
SELECT count(*) FROM pgmq.q_invoice_queue;     -- backlog
SELECT * FROM pgmq.q_invoice_dlq ORDER BY enqueued_at DESC LIMIT 20;  -- dead-lettered
SELECT id, status FROM public.invoices WHERE status = 'extracting'
  AND extracted_at IS NULL ORDER BY created_at;  -- claimed but never finished
```

---

## Procedure 6 — Escalation thresholds & capacity cross-reference

### Chain breaker tuning (`app_settings`, category `ai`)

| Key | Default | Meaning |
|---|---|---|
| `ai.chain.window_sec` | 600 | rolling window for the failure-ratio trigger (§7.6 Trigger A) |
| `ai.chain.min_samples` | 6 | consecutive chain failures before it opens |
| `ai.chain.failure_ratio` | 1.0 | MVP: any success resets → consecutive ≈ 100% |
| `ai.chain.cooldown_sec` | 900 | base cooldown before the first half-open probe |
| `ai.chain.cooldown_max_sec` | 21600 | absolute backoff cap (6h) across re-opens |
| `ai.chain.probe_success_required` | 2 | half-open successes needed to close |
| `ai.chain.replay_batch_rate_per_minute` | 10 | post-recovery replay pacing (procedure 3) |

```sql
SELECT key, value->>'v' AS val FROM public.app_settings
WHERE key LIKE 'ai.chain.%' ORDER BY key;
```

### When to escalate

- **Chain breaker re-opens repeatedly** (`circuit_breakers.reopen_count` climbing, `cooldown` near `cooldown_max_sec`): a provider is down for a sustained period → work procedure 4 (is the model deprecated?) and/or add a provider to `ai.providers.extraction.chain`.
- **`quota_exceeded` across all providers**: daily limits hit → raise `ai.<provider>.daily_limit` (if the provider allows) or wait for the UTC reset; invoices are safely parked + replayable (procedure 3).
- **`invoice_queue` backlog growing minute over minute** while the worker is healthy: the per-tick `WORKER_READ_BATCH` (10) can't keep up → this is a **capacity** concern. Cross-reference the capacity-management runbook (P7, `unibill-capacity-monitor` / `-evictor` cron — not yet implemented at MVP) and consider raising the batch / cron frequency.
- **Many `extracting` invoices with no recent `extraction_runs`**: workers crashing mid-attempt → check Edge Function logs; the pgmq visibility timeout (90s) redelivers automatically, but a poison message hits the DLQ after `extraction.max_retries` (3) deliveries.

---

## Quick reference

| I need to… | Do |
|---|---|
| Re-run one invoice | `POST /functions/v1/admin-invoice-reextract/:id` `{force:true}` (proc 1) |
| Stop the AI chain now | force-open `circuit_breakers` ai_chain (proc 2) |
| Re-enable + drain backlog | force-close (proc 2) → `POST /admin/replay-chain` (proc 3) |
| Swap a deprecated model | smoke-test → `UPDATE app_settings ai.<p>.model` (proc 4) |
| Find what's failing | `extraction_runs` + `ai_calls` queries (proc 5) |
