#!/usr/bin/env bash
# format_health_alert.sh — builds the plaintext body for the /health alert email
# (T-614, §11.4). Reads the probe result + the service_role-fetched context from
# env + temp files written by the health-monitor workflow:
#   HEALTH_URL, HTTP_CODE, HEALTH_STATUS  (env)
#   ${HEALTH_BODY_FILE:-/tmp/health.json} ${CAPACITY_FILE:-/tmp/cap.json} ${AICALLS_FILE:-/tmp/ai.json}
# Pure formatting (no network) so it can be unit-tested with fixtures.
set -euo pipefail

URL="${HEALTH_URL:-?}"
CODE="${HTTP_CODE:-?}"
STATUS="${HEALTH_STATUS:-?}"
HEALTH_BODY_FILE="${HEALTH_BODY_FILE:-/tmp/health.json}"
CAPACITY_FILE="${CAPACITY_FILE:-/tmp/cap.json}"
AICALLS_FILE="${AICALLS_FILE:-/tmp/ai.json}"

resp_excerpt="$(head -c 600 "$HEALTH_BODY_FILE" 2>/dev/null || true)"
[ -n "$resp_excerpt" ] || resp_excerpt="(no response body)"

cap="$(jq -r '.[] | "  \(.checked_at)  db=\(.db_pct)% (\(.db_status))  storage=\(.storage_pct)% (\(.storage_status))"' \
  "$CAPACITY_FILE" 2>/dev/null || true)"
[ -n "$cap" ] || cap="  (unavailable)"

ai="$(jq -r '.[] | "  \(.started_at)  \(.provider)  \(.status)  \(.error_summary // "")"' \
  "$AICALLS_FILE" 2>/dev/null || true)"
[ -n "$ai" ] || ai="  (unavailable)"

cat <<EOF
Unibill /health alert
=====================
URL:        $URL
HTTP code:  $CODE
status:     $STATUS

Response excerpt:
$resp_excerpt

Last 5 capacity_snapshots:
$cap

Last 5 ai_calls:
$ai

— Unibill Health Monitor (.github/workflows/health-monitor.yml)
EOF
