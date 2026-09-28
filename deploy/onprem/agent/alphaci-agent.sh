#!/usr/bin/env bash
# AlphaCI on-prem release agent: one poll cycle. systemd runs it on a timer.
#
# It only makes outbound calls. It asks AlphaCI for this host's environment
# assignments, verifies each signed release manifest with the pinned public
# key BEFORE pulling anything, pulls every image by digest, applies Compose,
# checks health, and reports the outcome. A release that fails its health
# check is replaced by the previous one.
set -euo pipefail

CONFIG="${ALPHACI_AGENT_CONFIG:-/opt/alphaci/agent.env}"
if [ -f "$CONFIG" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
fi

: "${ALPHACI_API_URL:?ALPHACI_API_URL is required}"
: "${ALPHACI_HOST_TOKEN_FILE:?ALPHACI_HOST_TOKEN_FILE is required}"
: "${ALPHACI_TRUST_KEY:?ALPHACI_TRUST_KEY is required}"
: "${ALPHACI_COMPOSE_FILE:?ALPHACI_COMPOSE_FILE is required}"
STATE_DIR="${ALPHACI_STATE_DIR:-/opt/alphaci/releases}"
PROJECT="${ALPHACI_COMPOSE_PROJECT:-alphaci}"
DOCKER="${ALPHACI_DOCKER:-docker}"
HEALTH_TIMEOUT="${ALPHACI_HEALTH_TIMEOUT:-120}"
API="${ALPHACI_API_URL%/}"
API="${API%/api/v1}"
TOKEN="$(tr -d '[:space:]' < "$ALPHACI_HOST_TOKEN_FILE")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# report <deployment-id> <status> [detail]
report() {
  local body
  body=$(jq -n --arg status "$2" --arg detail "${3:-}" \
    '{status: $status} + (if $detail == "" then {} else {detail: $detail} end)')
  curl -fsS --max-time 30 -X POST "$API/api/v1/onprem/deployments/$1/status" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$body" > /dev/null
}

# compose <env-file> <compose arguments...>
compose() {
  "$DOCKER" compose -p "$PROJECT" -f "$ALPHACI_COMPOSE_FILE" --env-file "$1" "${@:2}"
}

# verify <assignment.json>: the manifest hash matches, and AlphaCI signed it
# with the key this host trusts.
verify() {
  jq -cSj '.envelope.manifest' "$1" > "$WORK/canonical.json"
  [ "$(sha256sum "$WORK/canonical.json" | cut -d' ' -f1)" = "$(jq -r '.envelope.manifestSha256' "$1")" ] || return 1
  [ "$(jq -r '.envelope.signature.algorithm' "$1")" = ecdsa-p256-sha256 ] || return 1
  jq -r '.envelope.signature.value' "$1" | base64 -d > "$WORK/signature.der" 2> /dev/null || return 1
  openssl dgst -sha256 -verify "$ALPHACI_TRUST_KEY" -signature "$WORK/signature.der" "$WORK/canonical.json" > /dev/null 2>&1
}

# release_env <assignment.json>: the Compose variables of a release, refusing
# any artifact that is not pinned by digest.
release_env() {
  jq -r '.envelope.manifest as $m
    | if ($m.commitSha | test("^[0-9a-f]{40}$"))
         and ($m.artifacts | all(.digest | test("^sha256:[0-9a-f]{64}$")))
      then
        "ALPHACI_RELEASE_ID=\($m.releaseId)",
        "ALPHACI_COMMIT_SHA=\($m.commitSha)",
        ($m.artifacts[] | "ALPHACI_IMAGE_\(.slot | ascii_upcase)=\(.image)@\(.digest)")
      else error("unpinned artifact") end' "$1"
}

healthy() {
  [ -z "${ALPHACI_HEALTH_URL:-}" ] ||
    curl -fsS --max-time 10 --retry 12 --retry-delay 5 --retry-all-errors "$ALPHACI_HEALTH_URL" > /dev/null
}

# deploy <assignment.json>
deploy() {
  local id next ok=1
  id=$(jq -r '.deploymentId' "$1")
  if ! verify "$1"; then
    log "deployment $id: signature or manifest hash rejected; nothing pulled"
    report "$id" failed "The host rejected the release signature or manifest hash, so nothing was pulled."
    return 0
  fi
  next="$STATE_DIR/$id.env"
  if ! release_env "$1" > "$next"; then
    rm -f "$next"
    report "$id" failed "The release names an artifact that is not pinned by digest."
    return 0
  fi

  report "$id" deploying
  while IFS='=' read -r key reference; do
    case "$key" in
      ALPHACI_IMAGE_*) "$DOCKER" pull "$reference" > /dev/null || ok=0 ;;
    esac
  done < "$next"

  if [ "$ok" = 1 ] && compose "$next" up -d --wait --wait-timeout "$HEALTH_TIMEOUT" && healthy; then
    cp "$next" "$STATE_DIR/current.env"
    report "$id" healthy
    log "deployment $id healthy"
    return 0
  fi

  if [ -f "$STATE_DIR/current.env" ] &&
    compose "$STATE_DIR/current.env" up -d --wait --wait-timeout "$HEALTH_TIMEOUT"; then
    report "$id" rolled_back "The new release failed its health check; the previous release is running again."
    log "deployment $id rolled back"
  else
    report "$id" failed "The new release failed its health check and no previous release could be restored."
    log "deployment $id failed"
  fi
}

curl -fsS --max-time 30 "$API/api/v1/onprem/assignments" \
  -H "Authorization: Bearer $TOKEN" -o "$WORK/assignments.json"
count=$(jq 'length' "$WORK/assignments.json")
for index in $(seq 0 $((count - 1))); do
  jq ".[$index]" "$WORK/assignments.json" > "$WORK/assignment.json"
  deploy "$WORK/assignment.json"
done
