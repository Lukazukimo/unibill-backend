# Repository secrets

GitHub Actions secrets used by the `unibill-backend` workflows. Set them under
**Settings → Secrets and variables → Actions** (and per-environment where noted).
Never commit real values — this file documents *names and purpose only*.

## Supabase (deploy + monitoring)

Two schemes coexist: the deploy pipeline (`deploy-supabase.yml`) reads **GitHub
Environment secrets** (`dev` + `production`), unsuffixed; the monitor workflows
(`health-monitor`, `capacity-monthly-report`) read **repo-level** secrets suffixed
`..._DEV`. The operator must set both — the `..._DEV` values duplicate the
dev-Environment values.

### Deploy pipeline — GitHub Environment secrets (dev + production), unsuffixed

Set these under **Settings → Environments → `dev`** and again under
**Settings → Environments → `production`** (values differ per environment).
`deploy-supabase.yml` is a reusable workflow called with `secrets: inherit` by
`deploy-dev.yml` (push to `main`, `environment: dev`) and by `release-please.yml`
(`deploy-prod` job on a published Release, `environment: production`, gated by
required-reviewer approval); it reads them via its job's `environment:` block.

| Secret | Used by | Purpose |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | deploy-supabase (deploy-dev, release-please) | Supabase CLI auth (`supabase` PAT, `sbp_…`). |
| `SUPABASE_PROJECT_REF` | deploy-supabase (deploy-dev, release-please) | Target project ref (`supabase link`). |
| `SUPABASE_DB_PASSWORD` | deploy-supabase (deploy-dev, release-please) | DB password for `supabase db push`. |
| `SUPABASE_URL` | deploy-supabase (deploy-dev, release-please) | REST base `https://<ref>.supabase.co` for the post-deploy health check. |
| `SUPABASE_SERVICE_ROLE_KEY` | deploy-supabase (deploy-dev, release-please) | `service_role` key — **bypasses RLS**; used by the AI-provider smoke test and post-deploy health check. Rotate per [RUNBOOK §4](RUNBOOK.md). |
| `GEMINI_API_KEY` | deploy-supabase (deploy-dev, release-please) | 1-token smoke call gating the Edge Functions deploy. |
| `GROQ_API_KEY` | deploy-supabase (deploy-dev, release-please) | idem. |

### Monitor workflows — repo-level secrets, `..._DEV`-suffixed

| Secret | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL_DEV` | health-monitor, capacity-monthly-report | REST base `https://<ref>.supabase.co` for context/report queries. Duplicates the dev-Environment `SUPABASE_URL` value. |
| `SUPABASE_SERVICE_ROLE_KEY_DEV` | health-monitor, capacity-monthly-report | `service_role` key — **bypasses RLS**; read-only context for alerts/reports. Duplicates the dev-Environment `SUPABASE_SERVICE_ROLE_KEY` value. Rotate per [RUNBOOK §4](RUNBOOK.md). |

## Health monitoring (T-614)

| Secret | Used by | Purpose |
|---|---|---|
| `HEALTH_URL` | health-monitor | Full public URL of the deployed `/health` function. |
| `ADMIN_EMAIL` | health-monitor, capacity-monthly-report | Recipient of alert/report emails (`notifications.admin_email`). |
| `SMTP_HOST` | health-monitor, capacity-monthly-report | Outbound SMTP host. |
| `SMTP_PORT` | health-monitor, capacity-monthly-report | SMTP port (e.g. 465 / 587). |
| `SMTP_USERNAME` | health-monitor, capacity-monthly-report | SMTP user (also the `From:` address). |
| `SMTP_PASSWORD` | health-monitor, capacity-monthly-report | SMTP password / app token. |

## Backups → Backblaze B2 (T-620)

See [backup.md](backup.md) for bucket setup + lifecycle policy.

| Secret | Used by | Purpose |
|---|---|---|
| `SUPABASE_DB_URL` | backup-weekly, backup-storage-metadata | Postgres connection string (incl. password) for `pg_dump` / `psql`. |
| `B2_KEY_ID` | backup-* | Backblaze application key id → `AWS_ACCESS_KEY_ID`. |
| `B2_APPLICATION_KEY` | backup-* | Backblaze application key → `AWS_SECRET_ACCESS_KEY`. |
| `B2_BUCKET` | backup-* | Target bucket name (e.g. `unibill-backups`). |
| `B2_ENDPOINT` | backup-* | Optional S3 endpoint host; default `s3.us-west-002.backblazeb2.com`. |

## Project automation

| Secret | Used by | Purpose |
|---|---|---|
| `ADD_TO_PROJECT_PAT` | add-to-project | PAT with `project` scope to auto-add issues to the Unibill Project (the default `GITHUB_TOKEN` can't write user Projects). |

## Notes

- Workflows that need secrets are guarded with `if: github.repository == 'Lukazukimo/unibill-backend'` so forks don't fail on absent secrets.
- The monitoring workflows are no-ops until `HEALTH_URL` + SMTP_* are set; `workflow_dispatch` lets you test them on demand.
- For a security disclosure of a leaked secret, see [SECURITY.md](../SECURITY.md) and rotate via the [RUNBOOK](RUNBOOK.md).
