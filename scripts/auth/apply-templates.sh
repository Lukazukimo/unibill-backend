#!/usr/bin/env bash
# =============================================================================
# scripts/auth/apply-templates.sh                                    Task: T-202
# -----------------------------------------------------------------------------
# Upload (or refresh) the Unibill pt-BR Supabase Auth email templates onto a
# linked Supabase Cloud project. The local stack (`supabase start`) reads
# templates straight from `supabase/auth/templates/` via the paths declared in
# `supabase/config.toml`, so this script is needed ONLY for cloud projects.
#
# Spec refs:
#   * §9.1 — Templates de email customizados pt-BR (confirmation, recovery,
#            magic_link, invite, email_change)
#   * §9.1 edge cases — desktop fallback w/ QR Code + APK link
#
# Why a script (instead of `supabase db push`):
#   The Supabase CLI does not yet have a `supabase auth templates push` command;
#   the official path is the GoTrue admin REST API at PATCH /admin/config (or,
#   for self-hosted, env variables). We use the admin API here because it is
#   the only programmatic surface available on Supabase Cloud.
#
# Idempotent: re-running with no template change is a no-op (the API accepts
# the same body without side effects).
#
# TODO(main loop): wire this script into a CI workflow (post-deploy step on
# `.github/workflows/deploy-dev.yml` and `deploy-prod.yml`) so any change to a
# template file under `supabase/auth/templates/` triggers a re-upload. Do NOT
# modify ci.yml from this task.
#
# Usage:
#   scripts/auth/apply-templates.sh
#   scripts/auth/apply-templates.sh --dry-run     # print which files would be uploaded
#   scripts/auth/apply-templates.sh --check       # exit 1 if any template file is missing
#
# Required environment variables:
#   SUPABASE_URL              — e.g. https://<project-ref>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY — service_role JWT (NEVER commit; load from
#                                your password manager or `.env.local`)
#
# Optional:
#   TEMPLATES_DIR             — override path to the templates directory.
#                               Defaults to <repo-root>/supabase/auth/templates.
#
# Exit codes:
#   0 — all templates uploaded (or already up to date in --check mode)
#   1 — missing dependency / bad arguments
#   2 — missing environment variable
#   3 — template file not found
#   4 — HTTP error from GoTrue admin API
# =============================================================================

set -euo pipefail

PROG="$(basename "$0")"

# -----------------------------------------------------------------------------
# 0. Dependency check helper. We DEFER the actual checks until after argument
#    parsing because `--check` and `--help` only need a POSIX shell (no jq,
#    no curl), and CI runners may legitimately call --check without those.
# -----------------------------------------------------------------------------
require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required binary '$1'." >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# 1. Argument parsing
# -----------------------------------------------------------------------------
MODE="apply"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --check)   MODE="check";   shift ;;
    -h|--help)
      sed -n '1,55p' "$0" | sed -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1' (try --help)." >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# 2. Locate the templates directory
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATES_DIR="${TEMPLATES_DIR:-${REPO_ROOT}/supabase/auth/templates}"

# Canonical mapping: GoTrue admin-API key  ->  file in templates dir.
# Keep this list in sync with `supabase/auth/templates/` and the README.
declare -a TEMPLATE_KEYS=(
  "mailer_templates_confirmation_content:confirmation.html"
  "mailer_templates_recovery_content:recovery.html"
  "mailer_templates_magic_link_content:magic_link.html"
  "mailer_templates_invite_content:invite.html"
  "mailer_templates_email_change_content:email_change.html"
)

# -----------------------------------------------------------------------------
# 3. --check mode: verify every expected file is present and exit
# -----------------------------------------------------------------------------
missing=0
for pair in "${TEMPLATE_KEYS[@]}"; do
  file="${pair#*:}"
  path="${TEMPLATES_DIR}/${file}"
  if [[ ! -f "${path}" ]]; then
    echo "MISSING: ${path}" >&2
    missing=$((missing + 1))
  fi
done
if [[ "${missing}" -gt 0 ]]; then
  echo "ERROR: ${missing} template file(s) missing under ${TEMPLATES_DIR}." >&2
  exit 3
fi
if [[ "${MODE}" == "check" ]]; then
  echo "OK: all ${#TEMPLATE_KEYS[@]} template files present."
  exit 0
fi

# -----------------------------------------------------------------------------
# 4. Env vars + remaining binaries (only needed for `apply` and `dry-run`).
# -----------------------------------------------------------------------------
require_bin jq
if [[ "${MODE}" == "apply" ]]; then
  require_bin curl
  : "${SUPABASE_URL:?ERROR: SUPABASE_URL is required (https://<ref>.supabase.co)}"
  : "${SUPABASE_SERVICE_ROLE_KEY:?ERROR: SUPABASE_SERVICE_ROLE_KEY is required}"
fi

# -----------------------------------------------------------------------------
# 5. Build the request body (single PATCH /admin/config payload — atomic apply)
# -----------------------------------------------------------------------------
# jq builds the JSON safely: each template body is fed via --rawfile so that
# all HTML quoting / backslashes / newlines are preserved.
JQ_ARGS=()
JQ_FILTER="{}"
i=0
for pair in "${TEMPLATE_KEYS[@]}"; do
  key="${pair%%:*}"
  file="${pair#*:}"
  path="${TEMPLATES_DIR}/${file}"
  JQ_ARGS+=("--rawfile" "tpl_${i}" "${path}")
  if [[ "${i}" -eq 0 ]]; then
    JQ_FILTER=". + {\"${key}\": \$tpl_${i}}"
  else
    JQ_FILTER="${JQ_FILTER} + {\"${key}\": \$tpl_${i}}"
  fi
  i=$((i + 1))
done

BODY="$(jq -n "${JQ_ARGS[@]}" "${JQ_FILTER}")"

# -----------------------------------------------------------------------------
# 6. --dry-run mode: list files and exit
# -----------------------------------------------------------------------------
if [[ "${MODE}" == "dry-run" ]]; then
  echo "DRY RUN: would PATCH ${SUPABASE_URL:-<no SUPABASE_URL set>}/auth/v1/admin/config with:"
  for pair in "${TEMPLATE_KEYS[@]}"; do
    key="${pair%%:*}"
    file="${pair#*:}"
    bytes=$(wc -c < "${TEMPLATES_DIR}/${file}" | tr -d ' ')
    printf "  %-40s  <- %s  (%s bytes)\n" "${key}" "${file}" "${bytes}"
  done
  exit 0
fi

# -----------------------------------------------------------------------------
# 7. Apply: PATCH /auth/v1/admin/config
# -----------------------------------------------------------------------------
URL="${SUPABASE_URL%/}/auth/v1/admin/config"
HTTP_STATUS="$(
  curl --silent --show-error --output /tmp/apply-templates.body \
       --write-out '%{http_code}' \
       --request PATCH "${URL}" \
       --header "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
       --header "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
       --header "Content-Type: application/json" \
       --data-binary "${BODY}"
)"

if [[ "${HTTP_STATUS}" != "200" && "${HTTP_STATUS}" != "204" ]]; then
  echo "ERROR: GoTrue admin API returned HTTP ${HTTP_STATUS}." >&2
  echo "Response body:" >&2
  cat /tmp/apply-templates.body >&2 || true
  exit 4
fi

echo "OK: uploaded ${#TEMPLATE_KEYS[@]} templates to ${URL} (HTTP ${HTTP_STATUS})."
