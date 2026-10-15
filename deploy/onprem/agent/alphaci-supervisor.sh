#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="${ALPHACI_HOME:-/opt/alphaci}"
if [ "${1:-}" = support-bundle ]; then
  install -d -m 0700 "$ROOT/support"
  bundle=$(mktemp -d "$ROOT/support/export.XXXXXX")
  trap 'rm -rf "$bundle"' EXIT
  jq '{id,apiUrl,agentVersion}' "$ROOT/machine.json" > "$bundle/machine.json"
  journalctl -u alphaci-machine.service -n 200 --no-pager > "$bundle/agent.log" 2>/dev/null || true
  docker ps --format '{{.ID}} {{.Names}} {{.Status}}' > "$bundle/containers.txt" 2>/dev/null || true
  find "$ROOT/assignments" -name current.env -type f -print 2>/dev/null | while IFS= read -r state; do
    printf '%s\n' "${state#"$ROOT/assignments/"}" >> "$bundle/releases.txt"
    cat "$state" >> "$bundle/releases.txt"
  done
  archive="$ROOT/support/machine-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  tar -czf "$archive" -C "$bundle" .
  printf '%s\n' "$archive"
  exit 0
fi
CONFIG="$ROOT/machine.json"
[ -s "$CONFIG" ] && [ -s "$ROOT/trust.json" ] || { echo 'Complete machine enrollment and public trust configuration first.' >&2; exit 1; }
TOKEN_FILE=$(jq -er '.tokenFile' "$CONFIG")
[ -s "$TOKEN_FILE" ] || { echo 'Machine credential is missing.' >&2; exit 1; }
API=$(jq -er '.apiUrl' "$CONFIG"); API="${API%/}"; API="${API%/api/v1}"
[[ "$API" =~ ^https://[^[:space:]]+$ ]] || { echo 'HTTPS API configuration is required.' >&2; exit 1; }
WORK=$(mktemp -d "$ROOT/secrets/cycle.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
# Keep the bearer value out of process arguments and logs.
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$WORK/auth.header"
checks='[]'
if ! docker info >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  checks='[{"id":"docker","status":"failed","message":"Docker Engine and Compose must be running."}]'
else
  checks='[{"id":"docker","status":"passed","message":"Docker Engine and Compose are available."}]'
fi
printf '%s' "$checks" | jq '{agentVersion:"0.1.0",checks:.}' > "$WORK/heartbeat.json"
curl -fsS --max-time 30 -H "@$WORK/auth.header" -H 'Content-Type: application/json' --data-binary "@$WORK/heartbeat.json" "$API/api/v1/onprem/heartbeat" >/dev/null
[ "${1:-}" = --heartbeat-only ] && exit 0
curl -fsS --max-time 30 -H "@$WORK/auth.header" "$API/api/v1/onprem/assignments" -o "$WORK/assignments.json"
# Assignment execution is installed by the same controlled package.
if [ -x "$ROOT/bin/render-assignment" ]; then
  count=$(jq 'length' "$WORK/assignments.json")
  running=0
  for ((index=0; index<count; index++)); do
    jq ".[$index]" "$WORK/assignments.json" > "$WORK/assignment-$index.json"
    "$ROOT/bin/render-assignment" "$WORK/assignment-$index.json" &
    running=$((running+1))
    if (( running >= 4 )); then wait || true; running=0; fi
  done
  wait || true
fi
# A Windows host forwards exactly these ports from its network into WSL. Every
# materialized environment counts, deployed or not, so forwards never flap.
mkdir -p "$ROOT/assignments"
find "$ROOT/assignments" -mindepth 3 -maxdepth 3 -name compose.json -type f -print0 | xargs -0 -r cat |
  jq -s '[.[].services[]?.ports[]? | split(":")[0] | tonumber? | select(. >= 1 and . <= 65535)] | unique' > "$WORK/published-ports.json"
chmod 0644 "$WORK/published-ports.json"
mv "$WORK/published-ports.json" "$ROOT/published-ports.json"
