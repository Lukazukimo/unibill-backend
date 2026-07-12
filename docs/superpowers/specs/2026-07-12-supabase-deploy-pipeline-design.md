# Supabase Deploy Pipeline — Design

**Date:** 2026-07-12
**Status:** Approved (design) — pending implementation plan
**Tracking:** part of #1 (Supabase provisioning). Follows PR #304 (RLS hardening) + PR #305 (import_map).

## 1. Context & motivation

The two Supabase projects are provisioned (dev `pciwwcsgsjbvwxdwdiwr`, prod `lvvzjthudhwggfmeiius`).
Today, promoting the backend to a project is **manual** (`supabase link` / `db push` /
`functions deploy` run by hand). A scaffold exists but is inert:

- `.github/workflows/deploy-dev.yml` — triggers via `workflow_run` after **CI** succeeds on
  `main`, uses `environment: dev`, wires the Supabase secrets, and has an AI-provider
  smoke-test gate. But the `link` / `db push` / `config push` / `functions deploy` steps are
  `echo "Would run..."` **placeholders**, and the functions step is **missing the
  `--import-map` flag** (which the zod bare import needs — see PR #305).
- `.github/workflows/release-please.yml` — runs release-please on push to `main`; a TODO
  comment marks the intended hook: "when `release_created == true` → Tag deploy to Supabase
  prod." No prod deploy exists.

**Goal:** a real CD pipeline —
- **dev**: auto-deploy on every merge to `main` (after CI passes);
- **prod**: deploy when release-please publishes a Release, behind a **manual approval gate**;
- **auth config as code** (no manual dashboard), including the settings that have no
  `config.toml` key.

### Goals
- Migrations + Edge Functions + auth config reach dev automatically and prod deliberately.
- One source of truth for the deploy steps (no dev/prod drift).
- Prod never changes without a human approving.
- Fail loudly and early; never ship code on top of a failed migration.

### Non-goals (YAGNI)
- SMTP provider setup (launch-time).
- Real vault secrets for prod (IMAP creds, prod AI keys) beyond what the smoke-test needs.
- DR / backup automation (#132).
- Migration rollback automation — migrations are **forward-only**; a "rollback" is a new
  migration.

## 2. Architecture

Three pieces, DRY via a **reusable workflow**:

| File | Role | Trigger |
|---|---|---|
| `deploy-supabase.yml` | **reusable** (`on: workflow_call`) — the whole deploy job | called by the two below |
| `deploy-dev.yml` | thin caller → reusable with `environment: dev` | `workflow_run` after **CI** on `main`, `if conclusion == success` |
| `release-please.yml` (extended) | adds a `deploy-prod` job → reusable with `environment: production` | same run, gated on `release_created == 'true'` |

### Why prod deploy lives *inside* `release-please.yml` (not a `on: release` file)

release-please creates the GitHub Release using the default `GITHUB_TOKEN`. **GitHub does not
fire workflow triggers (`release`, `push` of the tag, etc.) for events created by the default
`GITHUB_TOKEN`** (anti-recursion protection). A standalone `deploy-prod.yml` with
`on: release: [published]` would therefore **never run**. Putting the prod deploy as a job in
the same `release-please.yml` run — `needs: release-please`,
`if: needs.release-please.outputs.release_created == 'true'` — sidesteps the trap entirely and
matches the file's existing TODO.

### Reusable workflow interface

`deploy-supabase.yml`:
```yaml
on:
  workflow_call:
    inputs:
      environment: { required: true, type: string }   # dev | production
      ref:         { required: true, type: string }    # sha (dev) or tag (prod) to check out
```
The single job sets `environment: ${{ inputs.environment }}` — so the `production`
Environment's **required-reviewer** rule pauses that job for approval, and each Environment's
scoped secrets resolve for that run. Callers pass `secrets: inherit`.

- `deploy-dev.yml` passes `ref: ${{ github.event.workflow_run.head_sha }}`.
- `release-please.yml`'s `deploy-prod` passes `ref: ${{ needs.release-please.outputs.tag_name }}`.
  (The `release-please` job must expose `release_created` and `tag_name` as job `outputs`.)

Net flow:
```
merge PR → main ─► CI ─► deploy-dev.yml ─► deploy-supabase (env dev)          [auto]
                └─► release-please ─► (release PR) ─► merge release PR ─► main
                       └─► release-please creates tag/Release
                              └─► deploy-prod job ─► deploy-supabase (env production)
                                     └─► PAUSES for your approval ─► applies    [gated]
```

## 3. Deploy steps (in the reusable workflow, in order)

1. `actions/checkout` at `inputs.ref`.
2. `supabase/setup-cli@v1` (version `latest`).
3. **Link:** `supabase link --project-ref "$SUPABASE_PROJECT_REF"` (uses `SUPABASE_DB_PASSWORD`).
4. **Migrations:** `supabase db push` — forward-only, idempotent (applies only unapplied
   migrations).
5. **Config (config.toml-backed):** `supabase config push` — applies the `[auth]`/`[api]`
   settings that have a `config.toml` key (redirect allow-list, min password length, character
   classes, `jwt_expiry`, refresh-token rotation/reuse, exposed schemas). Non-interactive flag
   to confirm in plan.
6. **Auth hosted-only:** `curl -X PATCH https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth`
   with `Authorization: Bearer $SUPABASE_ACCESS_TOKEN`, body from a versioned
   `supabase/remote-auth-config.json` containing **only** the fields `config.toml` cannot
   express (HIBP / leaked-password check; refresh-token lifetime if applicable). Endpoint +
   auth mechanism are confirmed; exact field names confirmed in plan via a `GET` of the live
   config.
7. **AI smoke-test gate (reused):** ping every configured AI provider with a 1-token call
   (`scripts/smoke_test_ai_providers.ts`). Skips cleanly if the AI/service-role secrets are
   absent; fails loudly if a model is dead (404) or a sentinel key is unset. **Gates step 8.**
8. **Edge Functions:** `supabase functions deploy --import-map supabase/functions/import_map.json`
   (all functions). The `--import-map` flag is mandatory — without it the bare `import 'zod'`
   fails the deploy graph (PR #305).
9. **Post-deploy smoke check:** `curl -fsS` the public `health` function
   (`$SUPABASE_URL/functions/v1/health`) expecting `200`. Job fails red otherwise. Exact auth
   header (anon vs service-role via the functions gateway) confirmed in plan.

Ordering rationale: **schema → config → auth → (gate) → code**. A bad migration or a dead
provider blocks the function deploy rather than shipping half a release.

## 4. Secrets & Environments

Two **GitHub Environments**: `dev` and `production`. `production` carries a **required-reviewer**
rule = the approval gate. Secrets are **Environment-scoped** (same name, different value per env
— drop the `_DEV` repo-level suffix the placeholder currently uses):

| Secret | Used by |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | CLI auth + Management API |
| `SUPABASE_PROJECT_REF` | `link` (dev `pciwwcsgsjbvwxdwdiwr` / prod `lvvzjthudhwggfmeiius`) |
| `SUPABASE_DB_PASSWORD` | `db push` |
| `SUPABASE_URL` | smoke tests |
| `SUPABASE_SERVICE_ROLE_KEY` | AI smoke-test (+ possibly health check) |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | AI smoke-test (optional — gate skips if absent) |

**These are set by the human** in GitHub → Settings → Environments (secret values are not in
the repo, by design; see `docs/ENVIRONMENTS.md`). The assistant cannot set them.

## 5. Failure handling & safety

- **Fail-fast:** any step fails → job fails, later steps skip.
- **Forward-only migrations:** if `db push` succeeds but a later step fails, the schema is
  already applied (fine — functions/config are idempotent, re-run). If `db push` fails, nothing
  downstream runs.
- **Concurrency:** `group: deploy-${{ inputs.environment }}`, `cancel-in-progress: false` —
  never cancel an in-flight migration.
- **Gates:** dev only deploys if CI passed (`workflow_run.conclusion == 'success'`). Prod code
  is already on `main` (CI passed at merge); prod deploy additionally requires a published
  release **and** manual approval, and you review the release changelog before merging the
  release PR.
- **Idempotent + safe to re-run** at any point.

## 6. Validation

- `actionlint` on the workflow YAML (if available locally / as a CI step).
- **Dev is the de-facto staging**: the first merge after this lands exercises the full pipeline
  for real.
- The step-9 health check is the inline post-deploy assertion.
- Deep verification (advisors, migration list, functions ACTIVE) continues via the Supabase MCP
  after a deploy.

## 7. Open items to confirm during planning

1. Exact Management API field names for `remote-auth-config.json` (HIBP, refresh-token TTL) —
   confirm via `GET /v1/projects/{ref}/config/auth` against the live dev project.
2. Non-interactive flag/behaviour of `supabase config push` in CI.
3. Auth header the `health` function's gateway requires (anon key vs service-role) for step 9.
4. Reusable-workflow behaviour under the job's `environment:` — verify BOTH that the
   `production` required-reviewer **approval gate fires** for the called workflow's job, AND
   that Environment-scoped secrets resolve under `secrets: inherit` (fallback: declare
   `secrets:` on `workflow_call`). This is the load-bearing assumption of the whole design; if
   the reusable job cannot carry the environment gate, fall back to inlining the deploy job in
   each caller (approach B) rather than the reusable.
5. release-please-action v4 output names (`release_created`, `tag_name`) surfaced as job
   `outputs`.
