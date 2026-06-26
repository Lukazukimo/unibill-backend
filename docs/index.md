# Unibill backend — documentation

Open-source ([Apache 2.0](../LICENSE)) backend for Unibill: Supabase Postgres
(migrations + RLS) and Deno Edge Functions. This is the docs landing page —
when [Pages](../.github/workflows/docs-publish.yml) is enabled it renders these
as a site.

## Reference (auto-generated)

| Doc | What | Source of truth |
|---|---|---|
| [API — OpenAPI](openapi.yaml) | Edge Function HTTP contracts (OpenAPI 3.1) | spec §E → `scripts/gen_openapi.ts` |
| [Data dictionary](data-dictionary.md) | Every table/column + COMMENT | live DB → `scripts/gen_data_dictionary.ts` |
| [Configuration](configuration.md) | All `app_settings` keys by namespace | seed → `scripts/gen_configuration_doc.ts` |
| [Domain events & business rules](events.md) | Emitted events + §F rule catalog | functions + §F → `scripts/gen_events_doc.ts` |

> Generated docs are checked for drift in CI (`docs-drift` job). Regenerate with
> the scripts above; do not edit the generated regions by hand.

## Operations

- [Runbook](RUNBOOK.md) — incident & maintenance procedures (DR, breaker, capacity, leaks)
- [Backup & retention](backup.md) — weekly pg_dump → Backblaze B2 + lifecycle
- [Secrets](secrets.md) — the GitHub Actions secrets each workflow needs
- Area runbooks: [ingestion](runbooks/ingestion-ops.md) · [extraction](runbooks/extraction-pipeline.md) · [bootstrap sys-admin](runbooks/bootstrap-sys-admin.md)

## Architecture

- [ADRs](adr/) — architecture decision records (Supabase, Flutter, pgmq, sentinels, Apache 2.0)
- [ERD (P0)](erd-p0.md) — entity-relationship diagram
- Full design spec & implementation plan live under `docs/superpowers/`

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md), [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
and [SECURITY.md](../SECURITY.md).
