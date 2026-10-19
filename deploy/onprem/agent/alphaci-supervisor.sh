#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="${ALPHACI_HOME:-/opt/alphaci}"
# tunnel.sh sits beside this script, both installed and in the test fixture.
. "$(dirname "${BASH_SOURCE[0]}")/tunnel.sh"
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
  # Tunnel units log cloudflared's output to the journal, not to files.
  journalctl -u 'alphaci-tunnel@*' -n 200 --no-pager > "$bundle/tunnels.txt" 2>/dev/null || true
  archive="$ROOT/support/machine-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  tar -czf "$archive" -C "$bundle" .
  printf '%s\n' "$archive"
  exit 0
fi
# Ends every automatic-address tunnel. Uninstall runs this even without a config.
if [ "${1:-}" = --stop-tunnels ]; then
  tunnel_stop_all
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
# The tunnel reports are what this machine observed in its previous check.
tunnels=$(find "$TUNNEL_ROOT" -mindepth 2 -maxdepth 2 -name tunnel.json -type f -print0 2> /dev/null |
  xargs -0 -r cat | jq -sc '[.[] | {assignmentId, status, message, publicUrl}]') || tunnels='[]'
printf '%s' "$checks" | jq --argjson tunnels "$tunnels" '{agentVersion:"0.4.3",checks:.,tunnels:$tunnels}' > "$WORK/heartbeat.json"
# The reply lists the host ports AlphaCI reserved on this machine, and the
# tunnel-mode assignments whose tunnels must stay open.
code=$(curl -sS --max-time 30 -H "@$WORK/auth.header" -H 'Content-Type: application/json' --data-binary "@$WORK/heartbeat.json" -o "$WORK/heartbeat-reply.json" -w '%{http_code}' "$API/api/v1/onprem/heartbeat") || code=000
case "$code" in
  200|201) ;;
  401)
    # Only a rejected credential (revoked or replaced) stops tunnels. A 403 can come
    # from a proxy or the on-prem switch, and must not rotate every tunnel address.
    echo 'The machine credential was rejected; stopping this machine'\''s tunnels.' >&2
    tunnel_stop_all
    exit 1 ;;
  *)
    echo "The heartbeat failed with HTTP $code." >&2
    exit 1 ;;
esac
# Keeps one tunnel unit per tunnel-mode assignment and ends the tunnels of
# assignments that left this machine. The reply is the source of truth.
sync_tunnels() {
  local keep="" id project environment port dir
  while IFS=$'\t' read -r id project environment port; do
    [[ "$project" =~ ^[0-9a-f-]{36}$ && "$environment" =~ ^[0-9a-f-]{36}$ && "$port" =~ ^[0-9]+$ ]] || continue
    tunnel_sync "$environment" "$id" "$port"
    keep="$keep $environment "
  done < <(jq -r '.tunnels[]? | [.assignmentId, .projectId, .environmentId, .hostPort] | @tsv' "$WORK/heartbeat-reply.json")
  for dir in "$TUNNEL_ROOT"/*/; do
    [ -d "$dir" ] || continue
    environment=$(basename "$dir")
    case " $keep " in
      *" $environment "*) ;;
      *) tunnel_stop "$environment" ;;
    esac
  done
}
sync_tunnels
# A Windows host forwards exactly these ports from its network into WSL: every
# port AlphaCI reserved here, so forwards and firewall rules exist before the
# first deployment, and every materialized environment's, deployed or not, so
# forwards never flap.
publish_ports() {
  mkdir -p "$ROOT/assignments"
  { jq -c '[.ports[]?]' "$WORK/heartbeat-reply.json" 2>/dev/null || echo '[]'
    find "$ROOT/assignments" -mindepth 3 -maxdepth 3 -name compose.json -type f -print0 | xargs -0 -r cat |
      jq -c '[.services[]?.ports[]? | split(":")[0] | tonumber?]'
  } | jq -s '[.[][] | numbers | select(. >= 1 and . <= 65535 and . == floor)] | unique' > "$WORK/published-ports.json"
  chmod 0644 "$WORK/published-ports.json"
  mv "$WORK/published-ports.json" "$ROOT/published-ports.json"
}
if [ "${1:-}" = --heartbeat-only ]; then publish_ports; exit 0; fi
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
publish_ports
