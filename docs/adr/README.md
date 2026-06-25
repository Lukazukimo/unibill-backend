# Architecture Decision Records (ADRs)

This directory records the significant architectural decisions of Unibill — the
*why* behind choices that are expensive to reverse, so future contributors (and
future us) don't re-litigate settled trade-offs.

Format: [Nygard ADRs](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
(Status / Context / Decision / Consequences), extended with an explicit
**Alternatives considered** section in the spirit of [MADR](https://adr.github.io/madr/).

## How to add one

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-slug.md` with the
   next number.
2. Fill in Status, Context, Decision, Consequences, Alternatives considered.
3. Add a row to the index below.
4. ADRs are **immutable** once Accepted — don't rewrite them; supersede with a
   new ADR and flip the old one's Status to *Superseded by ADR-XXXX*.

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-supabase-cloud-over-self-hosted.md) | Supabase Cloud over self-hosted | Accepted | 2026-06-08 |
| [0002](0002-flutter-over-react-native.md) | Flutter over React Native for mobile | Accepted | 2026-06-08 |
| [0003](0003-pgmq-over-external-queue.md) | pgmq + pg_cron over an external queue | Accepted | 2026-06-08 |
| [0004](0004-sentinel-actors-table.md) | Sentinel actors in their own table over auth.users pollution | Accepted | 2026-06-25 |
| [0005](0005-apache-2-license.md) | Apache 2.0 over MIT / AGPL | Accepted | 2026-06-08 |
