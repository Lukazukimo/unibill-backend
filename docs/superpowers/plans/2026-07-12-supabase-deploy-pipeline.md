# Supabase Deploy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate Supabase deploys — dev on every merge to `main` (after CI), prod on a release-please Release behind a manual approval gate — with migrations, Edge Functions, and auth config all shipped as code.

**Architecture:** One reusable workflow (`deploy-supabase.yml`) holds the entire deploy job, parameterized by `environment` + `ref`. `deploy-dev.yml` calls it after CI succeeds on `main`; a `deploy-prod` job inside `release-please.yml` calls it (same run, gated on `release_created`) so the `production` Environment's required-reviewer approval fires. Auth config is applied via `supabase config push` (config.toml-backed) plus a Management API PATCH for the hosted-only fields.

**Tech Stack:** GitHub Actions (reusable workflows, Environments), Supabase CLI v2, Supabase Management API, release-please-action v4, Deno (existing AI smoke-test).

**Spec:** `docs/superpowers/specs/2026-07-12-supabase-deploy-pipeline-design.md`

## Global Constraints

- Edge Functions deploy MUST pass `--import-map supabase/functions/import_map.json` (bare `zod` import fails the graph otherwise). Use `--use-api --yes` to bundle without Docker, non-interactively.
- `supabase config push` MUST use `--yes` (non-interactive CI).
- Migrations are **forward-only**; never author a "down" migration.
- Prod project ref `lvvzjthudhwggfmeiius`; dev project ref `pciwwcsgsjbvwxdwdiwr`. Refs/passwords are **Environment secrets**, never committed.
- Secrets are **Environment-scoped, unsuffixed** (`SUPABASE_PROJECT_REF`, not `..._DEV`); each Environment holds its own value.
- Conventional Commits; no `Co-Authored-By` trailer.
- Deploy step order is load-bearing: link → db push → config push → auth PATCH → AI smoke-test gate → functions deploy → health check.

## Testing approach (read first)

GitHub Actions YAML is not unit-testable. The "test" for each YAML task is **`actionlint`** (static validation of syntax, expressions, `uses:` refs, and reusable-workflow inputs/secrets). Run it via Docker (no install needed):

```bash
docker run --rm -v "$(pwd):/repo" --workdir /repo rhysd/actionlint:latest -color
```

Expected on success: no output, exit 0. The real end-to-end validation is the first `dev` deploy run after merge (dev is the de-facto staging). Where a task ships a JSON/script artifact, it has a concrete local check.

---

### Task 1: `remote-auth-config.json` — hosted-only auth config

**Files:**
- Create: `supabase/remote-auth-config.json`

**Interfaces:**
- Produces: a JSON body for `PATCH /v1/projects/{ref}/config/auth` containing ONLY fields that have no `config.toml` key. Consumed by Task 2's "Apply hosted-only auth config" step (`--data @supabase/remote-auth-config.json`).

- [ ] **Step 1: Discover the real field names from the live project**

Run (needs a valid access token in `$SUPABASE_ACCESS_TOKEN`):
```bash
curl -fsS "https://api.supabase.com/v1/projects/pciwwcsgsjbvwxdwdiwr/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | python3 -m json.tool
```
Expected: a JSON object of the project's current GoTrue config. Locate the leaked-password / HIBP toggle (expected key: `password_hibp_enabled`) and any refresh-token lifetime key. Note the exact key names printed — the file in Step 2 must use those exact keys.

- [ ] **Step 2: Write the file with the confirmed hosted-only keys**

Write `supabase/remote-auth-config.json`. Baseline content (adjust key names to match Step 1's output — do NOT include keys already covered by `config.toml`: rotation, reuse interval, jwt_expiry, password length/requirements, redirect URLs):
```json
{
  "password_hibp_enabled": true
}
```
If Step 1 revealed a refresh-token-lifetime key (spec: 1 week), add it (value in seconds, 604800). If no such key exists in the API, leave the file with just `password_hibp_enabled` and note in the commit body that refresh-token lifetime stays a dashboard setting.

- [ ] **Step 3: Validate it is well-formed JSON**

Run:
```bash
python3 -c "import json;json.load(open('supabase/remote-auth-config.json'));print('OK')"
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add supabase/remote-auth-config.json
git commit -m "feat(deploy): add remote-auth-config.json for hosted-only auth settings"
```

---

### Task 2: `deploy-supabase.yml` — reusable deploy workflow

**Files:**
- Create: `.github/workflows/deploy-supabase.yml`

**Interfaces:**
- Consumes: `supabase/remote-auth-config.json` (Task 1); `supabase/functions/import_map.json` (exists); `scripts/smoke_test_ai_providers.ts` (exists).
- Produces: a reusable workflow with `workflow_call` inputs `environment` (string) and `ref` (string), consumed by Tasks 3 and 4. Reads Environment secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`.

- [ ] **Step 1: Write the reusable workflow**

Create `.github/workflows/deploy-supabase.yml`:
```yaml
name: Deploy (reusable)

on:
  workflow_call:
    inputs:
      environment:
        description: Target GitHub Environment (dev | production)
        required: true
        type: string
      ref:
        description: Git ref (sha for dev, tag for prod) to check out and deploy
        required: true
        type: string

permissions:
  contents: read

concurrency:
  # Never cancel an in-flight migration; serialize per environment.
  group: deploy-${{ inputs.environment }}
  cancel-in-progress: false

jobs:
  deploy:
    name: deploy to ${{ inputs.environment }}
    runs-on: ubuntu-latest
    # The Environment carries the secrets AND (for production) the required-reviewer
    # approval gate. The run pauses here until approved when environment=production.
    environment:
      name: ${{ inputs.environment }}
    env:
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
      SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
      SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref }}

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Link project
        run: supabase link --project-ref "$SUPABASE_PROJECT_REF"

      - name: Push migrations
        run: supabase db push

      - name: Push config.toml (auth/api)
        run: supabase config push --yes

      - name: Apply hosted-only auth config (Management API)
        run: |
          curl -fsS -X PATCH \
            "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" \
            -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            --data @supabase/remote-auth-config.json

      # Gate: ping every configured AI provider with a 1-token call before promoting
      # functions, so a dead model (404) or an unset sentinel key fails loudly. Skips
      # cleanly until the AI + service-role secrets are configured for the env.
      - name: Setup Deno
        if: ${{ env.SUPABASE_SERVICE_ROLE_KEY != '' && env.GEMINI_API_KEY != '' }}
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Smoke-test AI providers
        if: ${{ env.SUPABASE_SERVICE_ROLE_KEY != '' && env.GEMINI_API_KEY != '' }}
        run: deno run --allow-env --allow-net scripts/smoke_test_ai_providers.ts

      - name: Deploy Edge Functions
        run: >-
          supabase functions deploy
          --import-map supabase/functions/import_map.json
          --use-api --yes

      - name: Post-deploy health check
        run: |
          curl -fsS -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
            "$SUPABASE_URL/functions/v1/health"
```

- [ ] **Step 2: Validate with actionlint**

Run:
```bash
docker run --rm -v "$(pwd):/repo" --workdir /repo rhysd/actionlint:latest -color .github/workflows/deploy-supabase.yml
```
Expected: no output, exit 0. (A reusable workflow with no caller is valid on its own.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-supabase.yml
git commit -m "feat(deploy): reusable deploy-supabase workflow (link/push/config/auth/functions)"
```

---

### Task 3: `deploy-dev.yml` — dev caller (replaces the placeholder)

**Files:**
- Modify (full rewrite): `.github/workflows/deploy-dev.yml`

**Interfaces:**
- Consumes: `deploy-supabase.yml` (Task 2) via `uses:` with `environment: dev`.

- [ ] **Step 1: Replace the file with the thin caller**

Overwrite `.github/workflows/deploy-dev.yml`:
```yaml
name: Deploy (dev)

# Runs after the CI workflow succeeds on a push to `main` (spec §11.1).
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]

permissions:
  contents: read

jobs:
  deploy:
    # Only deploy if the upstream CI run passed and was on main.
    if: >-
      ${{ github.event.workflow_run.conclusion == 'success' &&
          github.event.workflow_run.head_branch == 'main' }}
    uses: ./.github/workflows/deploy-supabase.yml
    with:
      environment: dev
      ref: ${{ github.event.workflow_run.head_sha }}
    secrets: inherit
```

- [ ] **Step 2: Validate with actionlint**

Run:
```bash
docker run --rm -v "$(pwd):/repo" --workdir /repo rhysd/actionlint:latest -color .github/workflows/deploy-dev.yml
```
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-dev.yml
git commit -m "feat(deploy): wire deploy-dev.yml to the reusable workflow"
```

---

### Task 4: `release-please.yml` — add prod deploy job

**Files:**
- Modify: `.github/workflows/release-please.yml`

**Interfaces:**
- Consumes: `deploy-supabase.yml` (Task 2) via `uses:` with `environment: production`.
- Note: prod deploy lives HERE (not a `on: release` file) because a Release created by the default `GITHUB_TOKEN` does not trigger other workflows.

- [ ] **Step 1: Rewrite the file to expose outputs and add the deploy-prod job**

Overwrite `.github/workflows/release-please.yml`:
```yaml
name: release-please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json

  # Prod deploy runs in THIS same workflow run (not via `on: release`) because a
  # Release created by the default GITHUB_TOKEN does not trigger other workflows.
  # The production Environment (set in Task 6) carries the required-reviewer gate,
  # so this job pauses for approval before it applies anything.
  deploy-prod:
    needs: release-please
    if: ${{ needs.release-please.outputs.release_created == 'true' }}
    uses: ./.github/workflows/deploy-supabase.yml
    with:
      environment: production
      ref: ${{ needs.release-please.outputs.tag_name }}
    secrets: inherit
```

- [ ] **Step 2: Validate with actionlint**

Run:
```bash
docker run --rm -v "$(pwd):/repo" --workdir /repo rhysd/actionlint:latest -color .github/workflows/release-please.yml
```
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-please.yml
git commit -m "feat(deploy): deploy prod on release-please release (gated by production env)"
```

---

### Task 5 (HUMAN): GitHub Environments + secrets + approval gate

This task is manual (GitHub UI / API) — the assistant cannot set secret values. Do it **before merging** the workflow PR so the first post-merge dev deploy is green.

- [ ] **Step 1: Create Environments**
Repo → Settings → Environments → New environment: create `dev` and `production`.

- [ ] **Step 2: Add the approval gate to production**
On `production` → "Required reviewers" → add yourself. (Optional: a wait timer.)

- [ ] **Step 3: Add Environment secrets (both environments)**
On EACH environment, add: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` (dev=`pciwwcsgsjbvwxdwdiwr` / prod=`lvvzjthudhwggfmeiius`), `SUPABASE_DB_PASSWORD`, `SUPABASE_URL` (`https://<ref>.supabase.co`), `SUPABASE_SERVICE_ROLE_KEY`, and (optional, for the AI gate) `GEMINI_API_KEY`, `GROQ_API_KEY`.

- [ ] **Step 4: Verify**
After merging the workflow PR, watch Actions → the "Deploy (dev)" run triggered after CI. Expected: green. Then via MCP confirm `get_advisors(security)` on dev is still clean and `list_migrations` is current. For prod: cut a release (merge the release-please PR), approve the paused `deploy-prod` job, and confirm the same on prod.

---

### Task 6: Document the pipeline

**Files:**
- Modify: `docs/ENVIRONMENTS.md`

- [ ] **Step 1: Add a "CI/CD" section to ENVIRONMENTS.md**
Add a short section stating: dev deploys automatically after CI on `main`; prod deploys on a release-please Release with manual approval in the `production` Environment; the manual `link/db push/functions deploy` recipe above is now only for bootstrap/break-glass. Reference the three workflow files.

- [ ] **Step 2: Commit**
```bash
git add docs/ENVIRONMENTS.md
git commit -m "docs(deploy): document the automated dev/prod pipeline in ENVIRONMENTS.md"
```

---

## Self-Review

**Spec coverage:** §2 architecture → Tasks 2/3/4 (reusable + dev caller + release-please prod job, incl. the GITHUB_TOKEN rationale). §3 steps (link→db push→config push→auth PATCH→AI gate→functions→health) → Task 2 verbatim. §4 secrets/Environments → Task 5. §5 failure/concurrency → Task 2 (`concurrency`, fail-fast is default). §6 validation (actionlint, health check) → per-task + Task 2 step. §7 open items: #1 field names → Task 1 Step 1 (discovery); #2 config push flag → resolved (`--yes`); #3 health header → Task 2 (service-role, verify on first run); #4 reusable+environment gate → Task 5 Step 4 verifies on first prod run, spec fallback to inlined jobs if it fails; #5 release-please outputs → Task 4 (`release_created`, `tag_name`). All covered.

**Placeholder scan:** No TBD/"handle errors"/"similar to". Task 1's field-name discovery is a real command producing real output, not a placeholder. All YAML is complete.

**Consistency:** Input names `environment`/`ref` identical across Tasks 2/3/4. Secret names identical across Task 2 (`env:`) and Task 5 (setup). `supabase/remote-auth-config.json` path identical in Tasks 1 and 2.

**Load-bearing risk:** If Task 5 Step 4 shows the reusable workflow cannot carry the `production` approval gate, fall back to inlining the deploy steps directly in a `deploy-prod` job (approach B) — same steps, no `uses:`.
