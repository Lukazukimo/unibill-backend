# ADR-0004: Sentinel actors in their own table over auth.users pollution

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Unibill maintainers

> Spec refs: §5.10. Implemented in T-606 / T-607.

## Context

LGPD right-to-erasure requires hard-deleting a user's `auth.users` row. But many
tables carry **audit columns** — `households.created_by`, `invoices.created_by/
updated_by/paid_by`, `domain_events.actor_user_id`, `consent_log.user_id`,
`system_admin_grants.granted_by`, … — that point at the user. We must delete the
user without leaving dangling references, without destroying the audit/household
history that belongs to the family unit, and without keeping the deleted user's
PII.

## Decision

We will keep dedicated **sentinel actors** in an `app.system_actors` table —
fixed UUIDs for `deleted_user` (`…0001`), `system`, and `worker`. Audit columns
are plain `uuid` **without** a foreign key to `auth.users` ("Approach A": the
audit FKs are dropped), and `app.anonymize_user_references()` repoints a deleted
user's audit references to the `deleted_user` sentinel (scrubbing `consent_log`
PII, deleting `client_telemetry`, hard-deleting soft-deleted ownership rows). A
standing pgTAP coverage guard fails CI if a new public→`auth.users` FK appears
that the erasure flow does not handle.

## Consequences

- **Easier:** `auth.users` deletes cleanly; the audit trail survives in anonymized
  form (the "who" becomes "a deleted user", not NULL); the coverage guard makes
  the contract enforceable over time.
- **Harder / risks:** audit columns lose database-level referential integrity to
  `auth.users` — acceptable because they are audit, not ownership, and the CI
  guard + the dedicated delete flow (T-609) compensate with discipline.

## Alternatives considered

- **A fake `auth.users` sentinel row** — pollutes the real users table and risks
  auth/RLS logic treating the sentinel as a real, loginable user.
- **Nullable FKs with `ON DELETE SET NULL`** — loses the actor entirely, weakening
  the audit trail (can't distinguish "system" from "deleted user" from "unknown").
- **`ON DELETE CASCADE` on the audit FKs** — would destroy household/invoice and
  event history that legitimately outlives the individual member.
- **Keep the PII** — violates the LGPD erasure obligation.
