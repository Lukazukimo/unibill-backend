# Runbook — Bootstrap Sys Admin (SQL path)

**Task:** T-217
**Spec refs:** §9.2 (JWT claim `is_system_admin` — audit trail completo + bootstrap inclui INSERT audit), §5.6 (domain_events DDL), §11.5 (Deploy inicial checklist step 10), BR-028
**Script:** [`scripts/admin/bootstrap-sys-admin.sql`](../../scripts/admin/bootstrap-sys-admin.sql)
**Companion runbook (shell path):** [`docs/runbooks/bootstrap-sys-admin.md`](../runbooks/bootstrap-sys-admin.md) (T-117)
**SQL invariant:** `app.assert_sys_admin_exists()` (migration `20260615120900_create_sys_admin_helpers.sql`)
**Audit table:** `public.system_admin_grants` (migration `20260616122000_create_system_admin_grants.sql`, T-216)
**Event:** `system_admin.bootstrapped` (in `public.domain_events`, written here)

---

## When to use THIS file vs the shell wrapper

Unibill ships **two** bootstrap paths. They produce the same end state — pick
based on environment and audit requirements:

| Path | File | When to use |
|---|---|---|
| **Shell (default)** | `scripts/bootstrap_sys_admin.sh` (T-117) | Fresh deploys, CI smoke tests, DR. Hits the GoTrue admin API → mutates `auth.users` only. Idempotent, scriptable, redacts secrets. Does **not** write the audit row or domain event because the GoTrue API call cannot share a Postgres transaction with subsequent INSERTs. |
| **SQL (this file)** | `scripts/admin/bootstrap-sys-admin.sql` (T-217) | (a) curl/jq unavailable, (b) you want the claim flip + audit row + domain event to land **atomically** in one transaction (forensically canonical), or (c) you need to backfill the `system_admin.bootstrapped` event after T-305 ships. |

> **Recommended runbook for first-boot:** run the **shell** script to flip the claim, then run **this** SQL block to retro-attach the audit row + domain event. Both are idempotent, so this is safe (the SQL block skips the UPDATE when the claim is already `'true'` and only writes the missing audit rows). The order doesn't matter — each step independently converges to the correct end state.

---

## Pre-conditions

| # | Check | How to verify |
|---|---|---|
| 1 | Target user exists in `auth.users` | Have them sign up via the mobile app first; confirm in Supabase Studio → Authentication → Users. |
| 2 | Migration `20260616122000_create_system_admin_grants.sql` (T-216) is applied | `select to_regclass('public.system_admin_grants') is not null;` returns `true`. |
| 3 | Migration `20260615120900_create_sys_admin_helpers.sql` (T-117) is applied | `select to_regprocedure('app.assert_sys_admin_exists()') is not null;` returns `true`. |
| 4 | (Optional) `public.domain_events` (T-305) is applied | If not yet applied the script SKIPS the event INSERT with a `NOTICE`; re-run after T-305 to backfill. |
| 5 | You are signed in to Supabase Studio for the **correct project** | Triple-check: `select current_database();` + cross-reference the project ref in the URL. |

---

## Procedure

### Step 1 — Open `scripts/admin/bootstrap-sys-admin.sql` in your editor

Locate the marked line:

```sql
-- ⇩⇩⇩  EDIT THIS  ⇩⇩⇩
bootstrap_email      text := 'CHANGE_ME@example.com';
-- ⇧⇧⇧  EDIT THIS  ⇧⇧⇧
```

Replace `'CHANGE_ME@example.com'` with the email of the user to promote.

> **Safety net:** if you forget this step the script raises `SQLSTATE UB002` and refuses to run. The literal `'CHANGE_ME@example.com'` is a tripwire on purpose.

### Step 2 — Paste into Supabase Studio → SQL editor and run

Expected output (NOTICE stream — Studio shows these in the **Messages** tab):

```
NOTICE:  Bootstrap target: founder@example.com (user_id=7f3c…, current is_system_admin=false)
NOTICE:  Promoted founder@example.com to is_system_admin=true.
NOTICE:  Inserted audit row into public.system_admin_grants (action=granted, granted_by=NULL, reason=bootstrap).
NOTICE:  Inserted domain_event system_admin.bootstrapped for user 7f3c….
NOTICE:  Bootstrap complete. Ask founder@example.com to sign OUT / sign IN to pick up the new JWT claim. Next promotions use the in-app peer flow (POST /admin/promote-system-admin).
```

Re-running on a healthy bootstrap (idempotent no-op):

```
NOTICE:  Bootstrap target: founder@example.com (user_id=7f3c…, current is_system_admin=true)
NOTICE:  Claim already true — skipping UPDATE auth.users (idempotent).
NOTICE:  Audit row already present in system_admin_grants — skipping INSERT (idempotent).
NOTICE:  Event system_admin.bootstrapped already present in domain_events — skipping (idempotent).
NOTICE:  Bootstrap complete. …
```

If `public.domain_events` is not yet present (T-305 not applied):

```
NOTICE:  public.domain_events not present yet (T-305 not applied). Skipping domain_event INSERT. Re-run this script after T-305 to backfill the system_admin.bootstrapped event.
```

→ Apply T-305 (P4 batch), then re-run this script. The claim flip + audit row are already in place; the second run only writes the missing event.

### Step 3 — Verify

```sql
-- 3a. Invariant: at least one sys admin exists.
SELECT app.assert_sys_admin_exists();   -- raises UB001 if zero, ok otherwise.

-- 3b. Audit row landed with the canonical bootstrap shape.
SELECT id, user_id, action, granted_by, reason, granted_at, correlation_id
  FROM public.system_admin_grants
 WHERE reason = 'bootstrap'
   AND action = 'granted'
   AND granted_by IS NULL;

-- 3c. Domain event landed (if T-305 is applied).
SELECT id, event_type, aggregate_type, aggregate_id, actor_type, payload, occurred_at
  FROM public.domain_events
 WHERE event_type = 'system_admin.bootstrapped';
```

### Step 4 — Ask the promoted user to re-login

JWT claims are only **issued** at login time. The new `is_system_admin: true` claim will NOT appear in the active session — the user must sign OUT and sign back IN before the sys-admin UI surfaces.

---

## Idempotency contract

Every side-effect of this script is guarded by an existence check **before** writing. Re-running is safe in every state:

| State on re-run | Behaviour |
|---|---|
| Claim already `true`, audit row present, event present | Three NOTICEs, zero writes. |
| Claim already `true`, audit row missing | UPDATE skipped; audit row INSERTed; event evaluated against domain_events. |
| Claim already `true`, audit row present, event missing (e.g. T-305 landed AFTER first run) | UPDATE skipped; audit row skipped; event INSERTed. |
| Claim is `false` for any reason (revoked / never set) | All three side-effects run. |

The whole DO block runs in an implicit transaction — if any step fails, the entire block rolls back, so the database never ends up in a half-applied state.

---

## Forensic guarantees

After a successful bootstrap, the following invariants hold (asserted by `supabase/tests/pgtap/bootstrap.test.sql`):

1. `auth.users.raw_app_meta_data ->> 'is_system_admin' = 'true'` for the target user.
2. Exactly one row exists in `public.system_admin_grants` for the target user with `action='granted', granted_by IS NULL, reason='bootstrap'`.
3. Exactly one row exists in `public.domain_events` with `event_type='system_admin.bootstrapped', aggregate_type='user', aggregate_id=<target_user_id>, actor_type='system'` (skipped iff T-305 not yet applied).
4. `app.assert_sys_admin_exists()` returns void without raising.

These four invariants together satisfy BR-028 ("Sys admin Bootstrap (1ª vez): INSERT system_admin_grants + domain_event system_admin.bootstrapped").

---

## Risks and recovery

| Mode | Likelihood | Recovery |
|---|---|---|
| Operator forgets to edit the placeholder email | High | Script raises `UB002` and aborts. Edit the literal and re-run. |
| Target email does not exist in `auth.users` | Medium | Script raises `UB003`. Have the user sign up via the mobile app, then re-run. |
| T-216 (`system_admin_grants`) not applied | Low | INSERT fails with `relation "public.system_admin_grants" does not exist`. Apply T-216 (`supabase db push`) and re-run. |
| T-305 (`domain_events`) not applied | Medium during early P0-P3 deploys | Script logs NOTICE and skips the event INSERT only. Audit row + claim flip still land. Re-run after T-305. |
| Service / pooler stale read of `auth.users` post-UPDATE | Very low | `app.assert_sys_admin_exists()` at end of block runs in same TX, so always sees the UPDATE. If somehow it raises `UB001` the entire block rolls back. |

---

## What this runbook does NOT cover

- **Revoking sys-admin status** — use the in-app `POST /admin/promote-system-admin` peer flow with `action=revoke`. That flow writes a `system_admin_grants` audit row (with `granted_by NOT NULL`) and emits `system_admin.revoked` to `domain_events`. It is the only supported revocation path.
- **Promoting additional sys admins** — same: in-app peer flow.
- **The shell-API bootstrap path** — see [`docs/runbooks/bootstrap-sys-admin.md`](../runbooks/bootstrap-sys-admin.md) (T-117).

---

## Change history

| Date | Author | Change |
|---|---|---|
| 2026-06-10 | T-217 | Initial runbook for the SQL bootstrap path (audit row + domain event). |
