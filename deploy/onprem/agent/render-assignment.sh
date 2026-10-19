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
# Optional service link (agent 0.4.0): the backend and frontend of a two-repository
# pair on this machine share one Docker network, each aliased by its slot, and get
# runtime variables. Without a link the environment deploys exactly as before;
# older agents never read it.
jq -e '.assignment.link // null | . == null or (type=="object" and
  (.network|type=="string" and test("^alphaci-[a-f0-9]{12}-[a-z0-9][a-z0-9-]{0,23}$")) and
  ((.env // {})|type=="object" and (to_entries|all((.key=="frontend" or .key=="backend") and (.value|type=="object") and (.value|length<=32) and
    (.value|to_entries|all((.key|test("^[A-Z_][A-Z0-9_]*$")) and (.key|length<=128) and
      (.value|type=="string") and (.value|length<=2048) and (.value|test("[\\x00-\\x1f\\x7f]")|not)))))) and
  ((.peers // [])|type=="array" and length<=1 and all(type=="object" and (.environmentId|type=="string" and test("^[0-9a-f-]{36}$")) and (.slot=="frontend" or .slot=="backend"))))' "$INPUT" >/dev/null || blocked 'The service link in this assignment is invalid. Nothing was deployed.'
jq -e '((.assignment.link.env // {}) | keys) - [.assignment.machine.config.ports[].slot] == []' "$INPUT" >/dev/null || blocked 'The service link sets variables for a slot this environment does not run. Nothing was deployed.'
NETWORK=$(jq -r '.assignment.link.network // ""' "$INPUT")
# Values are JSON strings, so nothing can break out of them; Compose still
# interpolates ${...} inside values, so a literal dollar is written as $$.
jq '.assignment.machine.config as $c | (.assignment.link // null) as $l | {
  services:($c.ports | map(.slot as $s | {key:$s,value:({image:("${ALPHACI_IMAGE_"+($s|ascii_upcase)+"}"),restart:"unless-stopped",ports:[((.hostPort|tostring)+":"+(.containerPort|tostring))],volumes:[($s+"-data:/var/lib/alphaci-data")]}
    + (if $l == null then {} else {networks:{default:{},"alphaci-link":{aliases:[$s]}}} end)
    + ((($l.env // {})[$s] // {}) | if length == 0 then {} else {environment:map_values(gsub("\\$";"$$"))} end))}) | from_entries),
  volumes:($c.ports|map({key:(.slot+"-data"),value:{}})|from_entries)
} + (if $l == null then {} else {networks:{"alphaci-link":{name:$l.network,external:true}}} end)' "$INPUT" > "$WORK/compose.json"
# An occupied port is safe only when this environment's current container owns it.
while IFS=$'\t' read -r slot host_port container_port; do
  if ss -H -ltn "sport = :$host_port" | grep -q .; then
    own=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$slot")
    # The current container of this environment owns the port whatever container port it maps to: a
    # changed container port must not leave the old release blocking the new one.
    [ -n "$own" ] && docker inspect "$own" | jq -e --arg port "$host_port" '[.[0].NetworkSettings.Ports // {} | to_entries[] | .value // [] | .[] | .HostPort] | index($port) != null' >/dev/null || blocked "Port $host_port is occupied outside this assignment; no stack changed."
  fi
done < <(jq -r '.assignment.machine.config.ports[] | [.slot,.hostPort,.containerPort] | @tsv' "$INPUT")
if [ -n "$NETWORK" ]; then
  # Idempotent, and safe when the other half creates it at the same moment.
  docker network inspect "$NETWORK" >/dev/null 2>&1 ||
    docker network create --label com.alphaci.link=true "$NETWORK" >/dev/null 2>&1 ||
    docker network inspect "$NETWORK" >/dev/null 2>&1 ||
    blocked "The Docker network $NETWORK could not be created; no stack changed."
  # The other half may still run a deployment made before the link existed:
  # attach it now so this side reaches it without waiting for its next deployment.
  while IFS=$'\t' read -r peer_environment peer_slot; do
    peer=$(docker ps -q --filter "label=com.docker.compose.project=ac-${peer_environment//-/}" --filter "label=com.docker.compose.service=$peer_slot" | head -n 1)
    [ -z "$peer" ] || docker network connect --alias "$peer_slot" "$NETWORK" "$peer" >/dev/null 2>&1 || true
  done < <(jq -r '.assignment.link.peers // [] | .[] | [.environmentId, .slot] | @tsv' "$INPUT")
fi
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
