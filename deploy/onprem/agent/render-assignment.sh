#!/usr/bin/env bash
# Materialize one authorized environment. Compose accepts the generated JSON.
set -euo pipefail
umask 077
ROOT="${ALPHACI_HOME:-/opt/alphaci}"
INPUT="${1:?Assignment JSON file is required}"
jq -e '.assignment as $a | $a.machine as $m |
  (.deploymentId | test("^[0-9a-f-]{36}$")) and
  ($a.projectId | test("^[0-9a-f-]{36}$")) and ($a.environmentId | test("^[0-9a-f-]{36}$")) and
  ($m.projectId==$a.projectId) and ($m.environmentId==$a.environmentId) and
  ($m.config.ports | length>0 and length<=2) and
  ($m.config.ports | all((.slot=="frontend" or .slot=="backend") and (.hostPort|type=="number") and .hostPort>=1 and .hostPort<=65535 and (.containerPort|type=="number") and .containerPort>=1 and .containerPort<=65535))' "$INPUT" >/dev/null
PROJECT_ID=$(jq -r '.assignment.projectId' "$INPUT")
ENV_ID=$(jq -r '.assignment.environmentId' "$INPUT")
DIR="$ROOT/assignments/$PROJECT_ID/$ENV_ID"
mkdir -p "$DIR"
exec 9>"$DIR/worker.lock"
flock -n 9 || exit 0
WORK=$(mktemp -d "$DIR/prepare.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
blocked() {
  local api token
  api=$(jq -er '.apiUrl' "$ROOT/machine.json"); api="${api%/}"; api="${api%/api/v1}"
  token=$(jq -er '.tokenFile' "$ROOT/machine.json")
  printf 'Authorization: Bearer %s\n' "$(cat "$token")" > "$WORK/auth.header"
  jq -n --arg detail "$1" '{status:"failed",detail:$detail}' > "$WORK/blocked.json"
  curl -fsS --max-time 30 -H "@$WORK/auth.header" -H 'Content-Type: application/json' --data-binary "@$WORK/blocked.json" "$api/api/v1/onprem/deployments/$(jq -r '.deploymentId' "$INPUT")/status" >/dev/null
  printf '%s\n' "$1" >&2
  exit 1
}
cp "$INPUT" "$WORK/assignment.json"
PROJECT="ac-${ENV_ID//-/}"
KEY_ID=$(jq -r '.envelope.signature.keyId' "$INPUT")
printf '%s' "$KEY_ID" | jq -Rs --slurpfile trust "$ROOT/trust.json" '$trust[0][.]' -r > "$WORK/key.pem"
openssl pkey -pubin -in "$WORK/key.pem" -noout >/dev/null 2>&1 || blocked 'Release key is not pinned on this host. Nothing was deployed.'
jq -e '.assignment.machine.config.health | length>0 and all(.path!=null)' "$INPUT" >/dev/null || blocked 'Application health is unverified because a health path is absent. Configure every target health path before retrying. Nothing was deployed.'
jq -r '.assignment.machine.config as $c | $c.health[] as $h | $c.ports[] | select(.slot==$h.slot) | "http://127.0.0.1:\(.hostPort)\($h.path)"' "$INPUT" > "$WORK/health-urls"
jq '.assignment.machine.config as $c | {
  services:($c.ports | map({key:.slot,value:{image:("${ALPHACI_IMAGE_"+(.slot|ascii_upcase)+"}"),restart:"unless-stopped",ports:[((.hostPort|tostring)+":"+(.containerPort|tostring))],volumes:[(.slot+"-data:/var/lib/alphaci-data")]}}) | from_entries),
  volumes:($c.ports|map({key:(.slot+"-data"),value:{}})|from_entries)
}' "$INPUT" > "$WORK/compose.json"
# An occupied port is safe only when this environment's current container owns it.
while IFS=$'\t' read -r slot host_port container_port; do
  if ss -H -ltn "sport = :$host_port" | grep -q .; then
    own=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$slot")
    [ -n "$own" ] && docker inspect "$own" | jq -e --arg key "$container_port/tcp" --arg port "$host_port" '.[0].NetworkSettings.Ports[$key] | any(.HostPort==$port)' >/dev/null || blocked "Port $host_port is occupied outside this assignment; no stack changed."
  fi
done < <(jq -r '.assignment.machine.config.ports[] | [.slot,.hostPort,.containerPort] | @tsv' "$INPUT")
mv "$WORK/compose.json" "$DIR/compose.json"
mv "$WORK/key.pem" "$DIR/release-key.pem"
mv "$WORK/health-urls" "$DIR/health-urls"
jq '[.]' "$INPUT" > "$DIR/pending.json.tmp"; mv "$DIR/pending.json.tmp" "$DIR/pending.json"
write_setting(){ printf '%s=%q\n' "$1" "$2"; }
{
  write_setting ALPHACI_API_URL "$(jq -r '.apiUrl' "$ROOT/machine.json")"
  write_setting ALPHACI_HOST_TOKEN_FILE "$(jq -r '.tokenFile' "$ROOT/machine.json")"
  write_setting ALPHACI_TRUST_KEY "$DIR/release-key.pem"
  write_setting ALPHACI_COMPOSE_FILE "$DIR/compose.json"
  write_setting ALPHACI_COMPOSE_PROJECT "$PROJECT"
  write_setting ALPHACI_STATE_DIR "$DIR/releases"
  write_setting ALPHACI_HEALTH_URLS_FILE "$DIR/health-urls"
  write_setting ALPHACI_ASSIGNMENTS_FILE "$DIR/pending.json"
} > "$DIR/agent.env.tmp"
mv "$DIR/agent.env.tmp" "$DIR/agent.env"
ALPHACI_AGENT_CONFIG="$DIR/agent.env" "$ROOT/bin/alphaci-agent" >> "$DIR/worker.log" 2>&1
