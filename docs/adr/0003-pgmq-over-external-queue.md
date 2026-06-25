# ADR-0003: pgmq + pg_cron over an external queue

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Unibill maintainers

> Spec refs: §4.3.

## Context

The pipeline needs durable asynchronous work — email sync, invoice extraction —
with retries, dead-lettering, idempotency, and scheduled triggers. We design these
to professional ("at scale") standards, but a personal project cannot justify
operating a separate queue/broker just for this.

## Decision

We will use **pgmq** (a Postgres-native message queue) plus **pg_cron**, both
running inside the Supabase Postgres instance. Queues carry a visibility timeout
and `max_retries` with a DLQ per queue; `pg_cron` triggers Edge Functions via
`private.invoke_edge_function`. Workers are idempotent (idempotency keys + run
tables) and emit domain events.

## Consequences

- **Easier:** no extra infrastructure to provision or monitor; enqueue/dequeue is
  transactional with the same database that holds the data; full observability via
  plain SQL; idempotency and DLQ inspection are just tables; free.
- **Harder / risks:** throughput is bounded by Postgres (more than enough at our
  scale); no native fan-out to non-Postgres consumers; cron/polling adds latency
  versus a push broker (acceptable for a batch-oriented workload).

## Alternatives considered

- **SQS / Google Cloud Tasks** — managed and scalable, but another cloud account,
  cost, and cross-system transactions (enqueue can't be atomic with the DB write).
- **Redis + BullMQ** — capable, but another stateful service to run, secure, and
  back up.
- **Supabase Realtime / LISTEN-NOTIFY** — a notification channel, not a durable,
  retryable queue with a DLQ.
