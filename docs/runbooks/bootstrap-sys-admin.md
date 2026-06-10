# Runbook — Bootstrap Sys Admin

**Task:** T-117
**Spec refs:** §9.2 (JWT claim `is_system_admin`), §11.5 (Deploy inicial checklist step 10), §5.10 (sentinel actors)
**Script:** [`scripts/bootstrap_sys_admin.sh`](../../scripts/bootstrap_sys_admin.sh)
**SQL invariant:** `app.assert_sys_admin_exists()` (migration `20260615120900_create_sys_admin_helpers.sql`)

---

## When to use this runbook

Run this procedure in **exactly one** situation:

> **A Supabase project (dev or prod) has zero users with the `app_metadata.is_system_admin = true` claim, and you need to promote the very first one.**

Concretely, that maps to:

1. **Initial deploy of a fresh project** — replaces step 10 of the §11.5 Deploy inicial checklist ("Promover primeiro sys admin via SQL no Studio"). The script is the supported path; the inline SQL in the spec is the manual fallback.
2. **Recovery after an accidental revocation of the last sys admin** — see [Risk: leaving zero sys admins](#risk-leaving-zero-sys-admins) below.
3. **DR restore into a new project** — once `supabase db push` and the seed have run, the new project has zero sys admins and needs a fresh bootstrap.

**Do NOT use this runbook for normal promotions.** Subsequent sys admins are promoted by an existing sys admin via the in-app peer flow (`POST /admin/promote-system-admin`, Edge Function — spec §9.2). That flow writes an audit row to `system_admin_grants`; this script does NOT, because by definition the bootstrap event has no other sys admin to attribute it to.

---

## Pre-conditions

| # | Check | How to verify |
|---|---|---|
| 1 | Target user exists in `auth.users` | Have them sign up via the mobile app first; confirm in Supabase Studio → Authentication → Users. |
| 2 | Migration `20260615120900_create_sys_admin_helpers.sql` is applied | `supabase db push` was run; check `app.migration_metadata`. |
| 3 | Service-role key for the target project is available locally | Stored in your password manager — **never** committed to git. |
| 4 | `curl` and `jq` are installed | `command -v curl && command -v jq`. Optional but recommended: `psql` for the post-update verification step. |
| 5 | You know the **target project URL** (not the wrong project!) | Dev: `https://<dev-ref>.supabase.co`; Prod: `https://<prod-ref>.supabase.co`. **Triple-check before running against prod.** |

---

## Procedure

### Step 1 — Load environment from your password manager

```bash
# Open your password manager, locate the entry for the *target* project,
# and export the two required values into your current shell:
export SUPABASE_URL='https://<project-ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='eyJ...'        # service_role JWT

# Optional but recommended — enables the post-update SQL invariant check:
export SUPABASE_DB_URL='postgresql://postgres:<pwd>@<host>:5432/postgres'
```

> **Security:** the service_role key gives **full unrestricted access** to the database and bypasses every RLS policy. Keep it in memory only for the duration of this command, and clear your shell history afterwards (`history -d $(history 1)` for the export lines, or use a sub-shell: `bash -c '...'`).

### Step 2 — Run the bootstrap script

```bash
./scripts/bootstrap_sys_admin.sh --email founder@example.com
```

Expected output (success path):

```
→ Looking up user 'founder@example.com' at https://<ref>.supabase.co (service_role key prefix: eyJhbG…)...
  user_id: 7f3c…
  current is_system_admin claim: false
→ Setting app_metadata.is_system_admin = true via GoTrue admin API...
  is_system_admin claim is now: true
→ Running post-update verification: SELECT app.assert_sys_admin_exists();
  verification ok.

SUCCESS: founder@example.com is now a Unibill sys admin.
```

If the user is already a sys admin (re-run idempotency):

```
  current is_system_admin claim: true
→ Claim already 'true' — nothing to do (idempotent no-op).
```

### Step 3 — Ask the promoted user to re-login

JWT claims are only **issued** at login time. The new `is_system_admin: true` claim will NOT appear in the active session — the user must sign OUT and sign back IN before the sys-admin UI surfaces.

### Step 4 — Verify in the mobile app

The user should now see the **Sys admin** tab in the app (capacity dashboard, AI chain health, event log, etc.). If not:

1. Confirm they actually re-logged in (kill the app, re-open).
2. Run the post-update SQL check again: `psql "$SUPABASE_DB_URL" -c 'SELECT app.count_sys_admins();'` — expect `1` (or more).
3. Inspect the user row directly: `select id, email, raw_app_meta_data from auth.users where email = '...';`

---

## Risk: leaving zero sys admins

`is_system_admin` is the only mechanism that exposes admin-only UI, admin-only Edge Functions (`/admin/*`), and admin-only RLS branches (e.g. `domain_events`, `eviction_runs`, global `app_settings`). **If the project ends up with zero sys admins, the only path back is this script** — none of the in-app flows can be reached without an existing admin.

Failure modes that lead to zero sys admins:

| Mode | How it happens | Recovery |
|---|---|---|
| **First boot** | Brand-new project, nobody promoted yet | Run this runbook (intended path). |
| **Last-admin self-revoke** | Sole sys admin demotes themselves via the in-app flow | The peer-promotion Edge Function MUST block this (spec §9.2 — "bloqueia remover último"). If the block is bypassed (bug), run this runbook to recover. |
| **Manual SQL mistake** | Direct `UPDATE auth.users SET raw_app_meta_data = '{}'::jsonb` in Studio | Run this runbook to recover. |
| **DR restore** | Restored snapshot did not include any sys-admin row | Run this runbook to recover. |

**Monitoring:** the helper `app.assert_sys_admin_exists()` raises SQLSTATE `UB001` when the count is zero. Wire this into a periodic health check (suggested: pg_cron job every 15 min that calls it; on error, emit an alert). T-104's CI for the dev environment runs it as a post-deploy smoke step.

---

## Why a script (not SQL in Studio)?

The spec §9.2 shows an inline `UPDATE auth.users SET raw_app_meta_data = ...` snippet. That works, but:

- Editing `auth.users` directly bypasses the GoTrue admin API — meaning any future GoTrue invariants (e.g. event-emission on metadata change) are skipped.
- The script is **idempotent** and **scriptable** — it can be invoked from CI smoke tests, runbooks, or DR procedures without re-typing SQL.
- The script applies a uniform redaction policy for logs (never prints the service_role key in full).
- The script verifies the post-state via `app.assert_sys_admin_exists()`, catching split-brain situations where the API write succeeded but SQL doesn't see the row yet.

Use the inline SQL only as a **last-resort fallback** when the script (or its dependencies — curl/jq) is unavailable.

---

## What this runbook does NOT cover

- **Revoking sys-admin status** — use the in-app `POST /admin/promote-system-admin` peer flow with `action=revoke`. The flow writes a `system_admin_grants` audit row and is the only supported revocation path.
- **Promoting additional sys admins** — same: in-app peer flow.
- **Rotating the service_role key** — see [`docs/runbooks/rotate-service-role-key.md`](rotate-service-role-key.md) (T-XXX, not yet authored — see §11.4 step 4).
- **Investigating a leaked service_role key** — see §11.4 step 7 ("Suspeita de vazamento de credencial").

---

## Change history

| Date | Author | Change |
|---|---|---|
| 2026-06-10 | T-117 | Initial runbook. |
