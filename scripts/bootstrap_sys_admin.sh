#!/usr/bin/env bash
# =============================================================================
# scripts/bootstrap_sys_admin.sh                                     Task: T-117
# -----------------------------------------------------------------------------
# Promote a single existing GoTrue user to Unibill system admin by setting
# `app_metadata.is_system_admin = true` on their `auth.users` row via the
# Supabase GoTrue admin REST API. Idempotent: re-running for the same email
# is safe and leaves the claim set to `true` (no audit-record duplication is
# possible because the admin API PATCH is a `merge`).
#
# Spec refs:
#   * §9.2  — JWT claim `is_system_admin` and bootstrap procedure
#   * §11.5 — Deploy inicial checklist (step 10 — promote first sys admin)
#   * §5.10 — sentinel actors (why we DON'T touch auth.users from migrations)
#
# TODO(ci): the dev-deploy workflow (.github/workflows/deploy-dev.yml, owned
#           by T-104) should invoke this script (or its psql verification
#           counterpart) AFTER `supabase db push` so a fresh dev environment
#           never lands without a sys admin. Wire this in a follow-up PR — do
#           NOT modify ci.yml / deploy-dev.yml from this task.
#
# Usage:
#   scripts/bootstrap_sys_admin.sh --email user@example.com
#
# Required environment variables (read from process env; never logged):
#   SUPABASE_URL           — e.g. https://<ref>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY — service_role JWT (NEVER commit; load from
#                           your password manager or `.env.local`)
#
# Optional:
#   SUPABASE_DB_URL        — full Postgres URL used by the optional psql
#                           verification step (if `psql` is installed).
#
# Exit codes:
#   0 — success (claim was already true OR was set to true)
#   1 — bad arguments / missing dependency
#   2 — missing environment variable
#   3 — user not found in auth.users
#   4 — HTTP error from GoTrue admin API
#   5 — post-update verification failed
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# 0. Dependency + argument parsing
# -----------------------------------------------------------------------------
PROG="$(basename "$0")"

usage() {
  cat <<EOF
Usage: $PROG --email <addr>

Promote an existing Supabase user to Unibill sys admin by setting
\`app_metadata.is_system_admin = true\` via the GoTrue admin API.

Required env:
  SUPABASE_URL                e.g. https://<ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY   service_role JWT (sensitive — never log)

Optional env:
  SUPABASE_DB_URL             full Postgres URL for post-update verification
                              via \`SELECT app.assert_sys_admin_exists();\`

Examples:
  export SUPABASE_URL=https://abcxyz.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=eyJ...
  $PROG --email founder@example.com

See: docs/runbooks/bootstrap-sys-admin.md
EOF
}

# Required commands — fail fast with a clear message if missing.
for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' not found in PATH." >&2
    exit 1
  fi
done

EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --email=*)
      EMAIL="${1#--email=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$EMAIL" ]; then
  echo "ERROR: --email is required." >&2
  usage >&2
  exit 1
fi

# Trivial email shape check (NOT validation — GoTrue is the source of truth).
if ! printf '%s' "$EMAIL" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
  echo "ERROR: '$EMAIL' does not look like an email address." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Required env vars
# -----------------------------------------------------------------------------
: "${SUPABASE_URL:?ERROR: SUPABASE_URL is required (e.g. https://<ref>.supabase.co)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?ERROR: SUPABASE_SERVICE_ROLE_KEY is required (sensitive — never log)}"

# Strip trailing slash from SUPABASE_URL — defensive, GoTrue paths are appended.
SUPABASE_URL="${SUPABASE_URL%/}"

# -----------------------------------------------------------------------------
# 2. Helpers
# -----------------------------------------------------------------------------
# All curl calls go through this wrapper so headers are consistent and so we
# never accidentally print the service_role key (it stays in $auth_header
# inside the local scope of this function).
gotrue_curl() {
  # $1 = method, $2 = path (e.g. /auth/v1/admin/users), $3 = body or "-" for none
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local auth_header="Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
  local apikey_header="apikey: ${SUPABASE_SERVICE_ROLE_KEY}"

  if [ "$body" = "-" ] || [ -z "$body" ]; then
    curl -sS -X "$method" \
      -H "$auth_header" \
      -H "$apikey_header" \
      -H "Content-Type: application/json" \
      "${SUPABASE_URL}${path}"
  else
    curl -sS -X "$method" \
      -H "$auth_header" \
      -H "$apikey_header" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "${SUPABASE_URL}${path}"
  fi
}

# Redact: print env values truncated to first 6 chars + ellipsis. Used in
# diagnostics so logs never leak full secrets.
redact() {
  local v="${1:-}"
  if [ -z "$v" ]; then
    printf '<unset>'
  else
    printf '%.6s…' "$v"
  fi
}

# -----------------------------------------------------------------------------
# 3. Look up the user by email
# -----------------------------------------------------------------------------
# GoTrue admin API: GET /auth/v1/admin/users?email=<addr> returns an array of
# matching users (typically zero or one). We URL-encode the email via jq to
# avoid breaking when the address contains a '+' alias.
ENCODED_EMAIL="$(printf '%s' "$EMAIL" | jq -sRr @uri)"

echo "→ Looking up user '$EMAIL' at $SUPABASE_URL (service_role key prefix: $(redact "$SUPABASE_SERVICE_ROLE_KEY"))..."

LOOKUP_JSON="$(gotrue_curl GET "/auth/v1/admin/users?email=${ENCODED_EMAIL}" -)"

# The admin endpoint returns {"users":[...]} (newer GoTrue) OR a bare array
# (older GoTrue). Normalise to an array via jq.
USERS_JSON="$(printf '%s' "$LOOKUP_JSON" \
  | jq 'if type == "object" and has("users") then .users else . end')"

USER_COUNT="$(printf '%s' "$USERS_JSON" | jq 'length')"

if [ "$USER_COUNT" = "0" ]; then
  echo "ERROR: no user with email '$EMAIL' found in auth.users." >&2
  echo "       Sign the user up first via the mobile app, then re-run this script." >&2
  exit 3
fi

if [ "$USER_COUNT" != "1" ]; then
  echo "ERROR: expected exactly 1 user matching '$EMAIL', got $USER_COUNT." >&2
  echo "       Inspect via Supabase Studio → Authentication → Users." >&2
  exit 3
fi

USER_ID="$(printf '%s' "$USERS_JSON" | jq -r '.[0].id')"
CURRENT_CLAIM="$(printf '%s' "$USERS_JSON" \
  | jq -r '.[0].app_metadata.is_system_admin // false')"

echo "  user_id: $USER_ID"
echo "  current is_system_admin claim: $CURRENT_CLAIM"

# -----------------------------------------------------------------------------
# 4. Idempotency short-circuit
# -----------------------------------------------------------------------------
if [ "$CURRENT_CLAIM" = "true" ]; then
  echo "→ Claim already 'true' — nothing to do (idempotent no-op)."
else
  # ---------------------------------------------------------------------------
  # 5. PATCH the claim
  # ---------------------------------------------------------------------------
  echo "→ Setting app_metadata.is_system_admin = true via GoTrue admin API..."

  # The GoTrue PATCH semantics for `app_metadata` is MERGE (not replace) — any
  # other keys already in `app_metadata` are preserved.
  PATCH_BODY='{"app_metadata":{"is_system_admin":true}}'

  PATCH_RESPONSE="$(gotrue_curl PATCH "/auth/v1/admin/users/${USER_ID}" "$PATCH_BODY")"

  # Check for an error envelope in the response — GoTrue returns
  # {"code":"...","msg":"..."} or {"error":"..."} on failure.
  if printf '%s' "$PATCH_RESPONSE" | jq -e 'has("code") or has("error")' >/dev/null 2>&1; then
    echo "ERROR: GoTrue admin API returned an error envelope:" >&2
    printf '%s\n' "$PATCH_RESPONSE" | jq . >&2 || printf '%s\n' "$PATCH_RESPONSE" >&2
    exit 4
  fi

  NEW_CLAIM="$(printf '%s' "$PATCH_RESPONSE" \
    | jq -r '.app_metadata.is_system_admin // false')"

  if [ "$NEW_CLAIM" != "true" ]; then
    echo "ERROR: PATCH succeeded but is_system_admin is still '$NEW_CLAIM'." >&2
    echo "       Response payload:" >&2
    printf '%s\n' "$PATCH_RESPONSE" | jq . >&2 || printf '%s\n' "$PATCH_RESPONSE" >&2
    exit 4
  fi

  echo "  is_system_admin claim is now: $NEW_CLAIM"
fi

# -----------------------------------------------------------------------------
# 6. Optional post-update verification via psql
# -----------------------------------------------------------------------------
# When SUPABASE_DB_URL is set AND `psql` is available, run the SQL invariant
# `SELECT app.assert_sys_admin_exists();` to confirm the migration helper
# observes the new claim. This catches mismatches between the GoTrue admin
# API view of `auth.users` and what direct SQL sees (rare, but possible if
# the API endpoint hits a stale replica).
if [ -n "${SUPABASE_DB_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  echo "→ Running post-update verification: SELECT app.assert_sys_admin_exists();"
  if ! psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
        -c 'SELECT app.assert_sys_admin_exists();' >/dev/null; then
    echo "ERROR: app.assert_sys_admin_exists() raised — claim may not be visible to SQL yet." >&2
    echo "       Retry in a few seconds; if it persists, inspect auth.users directly." >&2
    exit 5
  fi
  echo "  verification ok."
else
  echo "→ Skipping post-update verification (SUPABASE_DB_URL unset or psql not installed)."
  echo "  Recommended: run \`SELECT app.assert_sys_admin_exists();\` in Supabase Studio."
fi

echo ""
echo "SUCCESS: $EMAIL is now a Unibill sys admin."
echo "Next steps:"
echo "  1. Ask the user to sign OUT and sign back IN — the new JWT claim is only"
echo "     issued on the next login."
echo "  2. Confirm the 'Sys admin' tab now appears in the mobile app."
echo "  3. For further promotions, use the in-app peer flow (POST /admin/promote-system-admin)."
echo "See docs/runbooks/bootstrap-sys-admin.md for the full runbook."
