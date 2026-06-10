-- ============================================================================
-- Migration: 20260616120200_vault_grants.sql
-- Date:      2026-06-10
-- Task:      T-209
-- Purpose:   Defense-in-depth GRANT/REVOKE matrix for the `vault` schema
--            (supabase_vault extension). Even though the end-user roles
--            (`anon`, `authenticated`) never *should* touch `vault.*` directly
--            — every legitimate access goes through the SECURITY DEFINER
--            wrappers `app.create_vault_secret` and `app.decrypt_app_password`
--            installed by T-208 — we explicitly REVOKE all privileges on
--            every relation and routine in the `vault` schema from those
--            two roles. Belt-and-braces against:
--
--              (a) A future Supabase platform change that flips a default
--                  GRANT on `vault.*` (the extension is owned by `postgres`
--                  and Supabase manages it; a vendor patch could regrant).
--              (b) A new migration accidentally `GRANT EXECUTE … TO PUBLIC`
--                  on a vault function (PUBLIC inherits to authenticated/anon
--                  in our role hierarchy — silent regression vector).
--              (c) A REPLACE-style installation of supabase_vault re-running
--                  the extension's own grants on existing objects.
--
--            We also re-affirm `GRANT USAGE ON SCHEMA vault TO service_role`
--            (Supabase default already includes it, but being explicit makes
--            the contract auditable from this single migration without
--            depending on platform defaults).
--
-- Spec refs: §9.3.1 ("GRANT/REVOKE matrix (defesa em profundidade)") —
--                   verbatim REVOKE/GRANT statements. The spec also names
--                   this as belt-and-braces on top of the SECURITY DEFINER
--                   wrappers from §9.3.1 (installed by T-208).
--            §9.3   ("Supabase Vault para app passwords") — overall threat
--                   model: end-user JS has zero direct path to `vault.*`.
--
-- Design notes:
--
--   * `REVOKE ALL ON ALL TABLES IN SCHEMA vault` covers the two relations
--     supabase_vault exposes today: `vault.secrets` (storage table, ciphertext)
--     and `vault.decrypted_secrets` (decryption view). Future relations added
--     by the extension are NOT auto-revoked — but ALTER DEFAULT PRIVILEGES
--     below pins the contract going forward.
--
--   * `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault` covers `vault.create_secret`,
--     `vault.update_secret`, plus any internal helpers. Same caveat: future
--     functions get protected by the ALTER DEFAULT PRIVILEGES guard.
--
--   * `ALTER DEFAULT PRIVILEGES IN SCHEMA vault REVOKE …`: this is the key
--     forward-looking guard. Any future relation/function created in `vault`
--     by any role will be born without privileges for anon/authenticated.
--     We scope it `FOR ROLE postgres` because Supabase migrations and
--     extension installations run as the postgres superuser — that's whose
--     default privileges we need to neuter.
--
--   * `REVOKE USAGE ON SCHEMA vault FROM anon, authenticated`: without USAGE
--     on the schema, the role cannot even *reference* objects inside it, no
--     matter what per-object grants exist. This is the cheapest, broadest
--     belt — but on its own it's not enough because USAGE could be regranted
--     in the future; the per-object REVOKEs above are the braces.
--
--   * `GRANT USAGE ON SCHEMA vault TO service_role`: explicit, idempotent
--     re-affirmation. service_role MUST retain access because (a) the
--     SECURITY DEFINER wrappers from T-208 are owned by `postgres` and run
--     with postgres privileges (so they don't actually need a service_role
--     grant), but (b) other operational paths — pg_dump from a service_role
--     equivalent connection, the rotate-password endpoint that may call
--     vault.update_secret via a forthcoming wrapper — rely on this being
--     present. Keeping the GRANT explicit prevents a future REVOKE-cascade
--     from silently disabling rotation.
--
--   * Idempotency: REVOKE is set-difference and a no-op on absent grants.
--     GRANT is set-union and a no-op when already present. ALTER DEFAULT
--     PRIVILEGES updates an internal catalog row (upsert semantics). Safe
--     to re-apply.
--
--   * We do NOT REVOKE from `postgres`, `supabase_admin`, or `supabase_auth_admin`
--     — those are platform-owned superuser-equivalent roles that need full
--     access for backups, replication, and extension management.
--
-- Caller contract (enforced by code review):
--   * Edge Functions: NEVER reference `vault.*` directly. Use the wrappers
--     `app.create_vault_secret(…)` and `app.decrypt_app_password(…)`.
--   * Workers: same.
--   * If you need a new vault operation (e.g. `vault.update_secret` for
--     rotation in T-216), add a SECURITY DEFINER wrapper in schema `app`
--     and grant EXECUTE on the wrapper to service_role — do NOT grant
--     EXECUTE on the raw vault function.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FORBIDDEN PATTERNS (enforced by review)
-- ----------------------------------------------------------------------------
--   * DO NOT `GRANT … ON SCHEMA vault TO anon` — breaks the entire threat
--     model. End-user roles have zero direct path to vault, period.
--   * DO NOT `GRANT … ON SCHEMA vault TO authenticated` — same.
--   * DO NOT `GRANT … ON ALL TABLES IN SCHEMA vault TO PUBLIC` — PUBLIC
--     inherits to anon/authenticated.
--   * DO NOT remove the ALTER DEFAULT PRIVILEGES guards — they're the only
--     thing protecting future vault objects from regaining the default
--     GRANT-EXECUTE-TO-PUBLIC behavior.
--   * DO NOT REVOKE from service_role — workers and the SECURITY DEFINER
--     wrappers (transitively) rely on service_role having access.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. REVOKE all current privileges on vault.* from end-user roles
-- ============================================================================
-- Covers `vault.secrets` (ciphertext table) and `vault.decrypted_secrets`
-- (decryption view) as they exist today. Also covers any other relations
-- the extension may have created at install time (sequences, etc — `ALL
-- TABLES` in PG covers tables AND views AND sequences in modern versions
-- when used with REVOKE).
REVOKE ALL ON ALL TABLES    IN SCHEMA vault FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA vault FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA vault FROM anon, authenticated;


-- ============================================================================
-- 2. Pin DEFAULT privileges so future vault objects are born locked-down
-- ============================================================================
-- ALTER DEFAULT PRIVILEGES applies to objects created AFTER this statement
-- by the role specified in FOR ROLE. supabase_vault installs/upgrades run
-- as `postgres` (the migration superuser), so we scope the default to that
-- role. Any future table/sequence/function added to schema `vault` will
-- inherit these revoked defaults — closing the regression vector where a
-- vendor patch adds a new vault object and forgets to lock it down.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA vault
  REVOKE ALL ON TABLES    FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA vault
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA vault
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA vault
  REVOKE ALL ON ROUTINES  FROM anon, authenticated;


-- ============================================================================
-- 3. Strip USAGE on the schema itself from end-user roles
-- ============================================================================
-- Without USAGE on a schema, a role cannot even reference its objects, no
-- matter what per-object grants exist. This is the cheapest broadest belt.
-- The per-object REVOKEs above are the braces in case USAGE gets re-granted.
REVOKE USAGE  ON SCHEMA vault FROM anon, authenticated;
REVOKE CREATE ON SCHEMA vault FROM anon, authenticated;


-- ============================================================================
-- 4. Explicitly re-affirm service_role has USAGE on schema vault
-- ============================================================================
-- Supabase default already includes this, but spelling it out:
--   (a) makes the contract self-documenting (one migration to read),
--   (b) survives a future REVOKE-cascade or platform reset.
-- Idempotent (GRANT is set-union).
GRANT USAGE ON SCHEMA vault TO service_role;


-- ============================================================================
-- 5. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616120200_vault_grants',
  'Vault GRANT/REVOKE matrix: REVOKE ALL on vault.* relations + functions '
  'from anon/authenticated; ALTER DEFAULT PRIVILEGES to lock future objects; '
  'REVOKE USAGE on schema vault from anon/authenticated; GRANT USAGE on '
  'schema vault to service_role explicitly. Defense-in-depth on top of '
  'T-208 SECURITY DEFINER wrappers. Spec §9.3.1.'
)
ON CONFLICT (migration_name) DO NOTHING;
