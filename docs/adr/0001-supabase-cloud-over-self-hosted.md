# ADR-0001: Supabase Cloud over self-hosted

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Unibill maintainers

> Spec refs: §2 (constraints firmados).

## Context

Unibill is a personal invoice-consolidation app built and maintained by a single
developer with no operations budget. The backend needs, at minimum: a relational
database (Postgres), authentication, object storage for invoice PDFs, serverless
compute for the sync/extraction pipeline, scheduled jobs, and a secrets vault.
Standing up and operating each of these separately — patching, backups, scaling,
monitoring — is more than a solo project can sustain.

## Decision

We will build on **Supabase Cloud** (free tier to start): managed Postgres with
Row-Level Security, GoTrue auth, Storage, Edge Functions (Deno), `pg_cron`, and
Supabase Vault. The whole backend is Postgres-centric, so tenancy, queues, and
scheduling live inside the database we already operate.

## Consequences

- **Easier:** zero infrastructure to run; an integrated, RLS-native multi-tenant
  stack; fast iteration; free at our scale.
- **Harder / risks:** vendor coupling — mitigated by the backend being standard
  Postgres + SQL migrations + Deno (portable to self-hosted Supabase or raw
  Postgres if needed); free-tier capacity limits — mitigated by the capacity
  management subsystem (two-layer retention + adaptive eviction, P10); Edge
  Function cold starts — acceptable for an async, cron-driven workload.

## Alternatives considered

- **Self-hosted Supabase / raw Postgres + custom backend** — full control, but
  re-introduces the exact ops burden we are avoiding (auth, storage, backups).
- **Firebase / Firestore** — managed, but NoSQL fits our relational, multi-tenant
  invoice model poorly and gives up SQL, RLS, and pgTAP-testable constraints.
- **PocketBase / other BaaS** — too limited for the queue + cron + RLS needs.
