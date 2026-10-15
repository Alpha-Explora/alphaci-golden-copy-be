#!/usr/bin/env bash
# Run locally as root. Codes arrive through the terminal, never command arguments.
set -euo pipefail
umask 077
ROOT="${ALPHACI_HOME:-/opt/alphaci}"
API="${1:?Usage: enroll.sh https://api.example.com [ubuntu|windows]}"
PLATFORM="${2:-ubuntu}"
[[ "$API" =~ ^https://[^[:space:]]+$ ]] || { echo 'Use the public HTTPS API address.' >&2; exit 1; }
API="${API%/}"; API="${API%/api/v1}"
install -d -m 0700 "$ROOT/secrets"
if [ -s "$ROOT/secrets/machine-token" ] && [ -s "$ROOT/machine.json" ]; then
  jq -e --arg api "$API" '.apiUrl|rtrimstr("/")|rtrimstr("/api/v1")==$api' "$ROOT/machine.json" >/dev/null || { echo 'This machine is enrolled with a different API. Use explicit credential replacement before changing servers.' >&2; exit 1; }
  echo 'Existing machine enrollment retained.'
  exit 0
fi
WORK=$(mktemp -d "$ROOT/secrets/enroll.XXXXXX")
PENDING="$ROOT/secrets/enrollment-response.json"
trap 'unset CODE; rm -rf "$WORK"' EXIT
if [ ! -s "$PENDING" ]; then
# End the prompt with a newline so it shows even where output is line-buffered.
printf '\nPaste the one-time enrollment code from AlphaCI, then press Enter (input is hidden):\n' >&2
read -r -s CODE
CODE="${CODE//[[:space:]]/}"
printf 'Code received. Enrolling this machine...\n' >&2
[[ "$CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || { echo 'Invalid code format.' >&2; exit 1; }
printf '%s' "$CODE" | jq -Rs '{code:.,agentVersion:"0.1.0",checks:[]}' > "$WORK/request.json"
unset CODE
curl --fail --silent --show-error --max-time 30 -H 'Content-Type: application/json' \
  --data-binary "@$WORK/request.json" "$API/api/v1/onprem/enroll" -o "$WORK/response.json"
mv "$WORK/response.json" "$PENDING"
fi
cp "$PENDING" "$WORK/response.json"
jq -e '.credential|test("^onprem_machine_[A-Za-z0-9_-]{43}$")' "$WORK/response.json" >/dev/null
jq -e '.trustKeys|type=="object" and length>0' "$WORK/response.json" >/dev/null
jq -e --arg api "$API" '.apiUrl|rtrimstr("/")|rtrimstr("/api/v1")==$api' "$WORK/response.json" >/dev/null || { echo 'Pending enrollment belongs to a different API. Resolve it before changing servers.' >&2; exit 1; }
jq -er '.credential' "$WORK/response.json" > "$WORK/machine-token"
jq '.trustKeys' "$WORK/response.json" > "$WORK/trust.json"
jq --arg root "$ROOT" '. as $r | {id:$r.machine.id,apiUrl:$r.apiUrl,agentVersion:"0.1.0",tokenFile:($root+"/secrets/machine-token"),trustFile:($root+"/trust.json")}' "$WORK/response.json" > "$WORK/machine.json"
# Publish config last. An interrupted write never starts the timer.
install -m 0600 "$WORK/machine-token" "$ROOT/secrets/machine-token"
install -m 0600 "$WORK/trust.json" "$ROOT/trust.json"
mv "$WORK/machine.json" "$ROOT/machine.json"
rm -f "$PENDING"
echo 'Machine enrolled. No application has been deployed yet.'
