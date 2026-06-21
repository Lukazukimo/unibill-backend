# Runbook — Ingestion ops (auto-pause, circuit breaker, DLQ)

**Task:** T-335
**Spec refs:** §4.3 (queues + DLQ), §5.8 (circuit breaker + auto-pause), §6.4 (sync-worker), §13 (DLQ semantics)
**Components:** `sync-dispatcher`, `sync-worker` Edge Functions; `app.*` SQL helpers
(`circuit_*`, `record_mailbox_error`, `ingest_invoice`, `queue_*`).

---

## Mental model

```
pg_cron (1min) → sync-dispatcher → email_sync_queue → sync-worker → invoice_queue → extraction-worker
                                         │                  │
                                         └─ email_sync_dlq ─┘ (after sync.max_retries REAL failures)
```

- A mailbox that fails IMAP **`sync.consecutive_error_threshold`** times in a row is
  **auto-paused**: `connected_emails.status` flips `active → error` and a
  `email.sync.auto_paused` domain event is emitted **once**. A paused mailbox is
  skipped by the dispatcher and its in-flight retries are dropped by the worker.
- The per-mailbox **circuit breaker** (`circuit_breakers`, `resource_type='imap'`,
  `resource_key=<email_address>`) opens on sustained IMAP failures and is probed
  automatically (`open → half_open → closed`). The dispatcher pre-filters `open`
  mailboxes; the worker probes `half_open`.
- A queue message that fails **`sync.max_retries`** real attempts (tracked in
  `sync_runs.errors_count`, NOT pgmq `read_ct`) is moved to **`email_sync_dlq`**
  with a `email.sync.dead_lettered` event. DLQ messages are NOT retried
  automatically — they need a manual decision.

All SQL below runs as a privileged role (Studio SQL editor / `psql` as `postgres`).
Replace the example `email_address` / ids.

---

## 1. Diagnose a stuck mailbox

```sql
-- Mailboxes not syncing + why.
SELECT id, email_address, status, consecutive_errors, last_error, last_error_at, last_sync_at
FROM public.connected_emails
WHERE deleted_at IS NULL AND status <> 'active'
ORDER BY last_error_at DESC NULLS LAST;

-- Recent runs for one mailbox (newest first).
SELECT started_at, finished_at, status, errors_count, messages_seen, invoices_created,
       duplicates_skipped, error_summary
FROM public.sync_runs
WHERE connected_email_id = '<connected_email_id>'
ORDER BY started_at DESC
LIMIT 20;

-- Circuit breaker state for the mailbox.
SELECT state, failure_count, opened_at, next_probe_at, reopen_count, reason
FROM public.circuit_breakers
WHERE resource_type = 'imap' AND resource_key = '<email_address>';
```

`error_summary` / `last_error` are already secret-redacted (`§6.5`).

## 2. Recover an auto-paused mailbox (`status='error'`)

After fixing the root cause (e.g. the user regenerated the Gmail app password via
`emails-rotate`), reactivate:

```sql
UPDATE public.connected_emails
SET status = 'active',
    consecutive_errors = 0,
    last_error = NULL,
    last_error_at = NULL
WHERE id = '<connected_email_id>' AND status = 'error';
```

The next dispatcher tick (≤1 min) re-selects it. **Do not** clear `last_processed_uid`
unless you intend a re-scan — duplicate captures are deduped by the invoice unique
indexes (`household+file_hash`, `email+message_id`) but a reset wastes IMAP work.

## 3. Manually reset / close the circuit breaker

The breaker recovers on its own (a `half_open` probe that succeeds closes it). Force
it closed only if you've confirmed the resource is healthy and don't want to wait
for `next_probe_at`:

```sql
UPDATE public.circuit_breakers
SET state = 'closed', failure_count = 0, reopen_count = 0,
    opened_at = NULL, next_probe_at = NULL, half_open_started_at = NULL,
    probes_sent = 0, probes_succeeded = 0, reason = NULL, updated_at = now()
WHERE resource_type = 'imap' AND resource_key = '<email_address>';
```

## 4. Inspect & replay the DLQ

```sql
-- What's dead-lettered.
SELECT msg_id, read_ct, enqueued_at, message
FROM pgmq.q_email_sync_dlq
ORDER BY enqueued_at DESC;
```

To **replay** a dead-lettered sync (after fixing the cause): clear the failed run's
counter so it isn't immediately re-DLQ'd, then re-enqueue onto the main queue and
delete from the DLQ. Do it atomically:

```sql
-- 1) Reset the real-failure counter for that (mailbox, idempotency_key) run.
UPDATE public.sync_runs
SET status = 'failed', errors_count = 0
WHERE connected_email_id = ((SELECT message->>'connected_email_id' FROM pgmq.q_email_sync_dlq WHERE msg_id = <dlq_msg_id>))::uuid
  AND idempotency_key  = (SELECT message->>'idempotency_key'  FROM pgmq.q_email_sync_dlq WHERE msg_id = <dlq_msg_id>);

-- 2) Move the message back to the main queue (send to main, delete from dlq) — atomic.
DO $$
DECLARE m jsonb;
BEGIN
  SELECT message INTO m FROM pgmq.q_email_sync_dlq WHERE msg_id = <dlq_msg_id>;
  PERFORM pgmq.send('email_sync_queue', m);
  PERFORM pgmq.delete('email_sync_dlq', <dlq_msg_id>);
END $$;
```

(Same shape for `invoice_dlq` → `invoice_queue` once extraction lands.)

To **discard** a dead-lettered message permanently:

```sql
SELECT pgmq.delete('email_sync_dlq', <dlq_msg_id>);
```

## 5. Global kill-switch

To stop ALL ingestion immediately (incident, capacity red):

```sql
UPDATE public.app_settings
SET value = jsonb_build_object('v', false)
WHERE key = 'features.ingestion_enabled' AND scope = 'global';
```

The dispatcher returns `{skipped:'ingestion_disabled'}` on its next tick. Re-enable by
setting `'v', true`.

---

## Notes

- `last_sync_at` is stamped at sync **attempt start** (it doubles as the dispatcher's
  in-flight lease); the authoritative "last successful run" is the latest
  `sync_runs` row with `status='success'`.
- Retry backoff is exponential: `sync.retry_base_s * 2^(attempt-1)` capped at
  `sync.retry_cap_s`, applied via the message's pgmq visibility timeout.
- Rate-limit / open-circuit back-offs do **not** count as mailbox errors and never
  auto-pause a mailbox — only real IMAP/processing failures do.
