# Repository secrets

GitHub Actions secrets used by the `unibill-backend` workflows. Set them under
**Settings → Secrets and variables → Actions** (and per-environment where noted).
Never commit real values — this file documents *names and purpose only*.

## Supabase (deploy + monitoring)

| Secret | Used by | Purpose |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | deploy-dev | Supabase CLI auth (`supabase` PAT, `sbp_…`). |
| `SUPABASE_PROJECT_REF_DEV` | deploy-dev | Target project ref for the dev deploy. |
| `SUPABASE_DB_PASSWORD_DEV` | deploy-dev | DB password for `supabase db push`. |
| `SUPABASE_URL_DEV` | deploy-dev, health-monitor, capacity-monthly-report | REST base `https://<ref>.supabase.co` for context/report queries. |
| `SUPABASE_SERVICE_ROLE_KEY_DEV` | deploy-dev, health-monitor, capacity-monthly-report | `service_role` key — **bypasses RLS**; read-only context for alerts/reports. Rotate per [RUNBOOK §4](RUNBOOK.md). |

## AI providers (deploy smoke test, T-419)

| Secret | Used by | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | deploy-dev | 1-token smoke call gating the Edge Functions deploy. |
| `GROQ_API_KEY` | deploy-dev | idem. |

## Health monitoring (T-614)

| Secret | Used by | Purpose |
|---|---|---|
| `HEALTH_URL` | health-monitor | Full public URL of the deployed `/health` function. |
| `ADMIN_EMAIL` | health-monitor, capacity-monthly-report | Recipient of alert/report emails (`notifications.admin_email`). |
| `SMTP_HOST` | health-monitor, capacity-monthly-report | Outbound SMTP host. |
| `SMTP_PORT` | health-monitor, capacity-monthly-report | SMTP port (e.g. 465 / 587). |
| `SMTP_USERNAME` | health-monitor, capacity-monthly-report | SMTP user (also the `From:` address). |
| `SMTP_PASSWORD` | health-monitor, capacity-monthly-report | SMTP password / app token. |

## Project automation

| Secret | Used by | Purpose |
|---|---|---|
| `ADD_TO_PROJECT_PAT` | add-to-project | PAT with `project` scope to auto-add issues to the Unibill Project (the default `GITHUB_TOKEN` can't write user Projects). |

## Notes

- Workflows that need secrets are guarded with `if: github.repository == 'Lukazukimo/unibill-backend'` so forks don't fail on absent secrets.
- The monitoring workflows are no-ops until `HEALTH_URL` + SMTP_* are set; `workflow_dispatch` lets you test them on demand.
- For a security disclosure of a leaked secret, see [SECURITY.md](../SECURITY.md) and rotate via the [RUNBOOK](RUNBOOK.md).
