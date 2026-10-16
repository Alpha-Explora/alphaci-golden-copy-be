#!/usr/bin/env bash
# Run locally as root. Codes arrive through the terminal or from a code file named
# by ALPHACI_ENROLL_CODE_FILE, never command arguments. --replace consumes a
# replacement code: the current credential is set aside and restored only if the
# new code is never accepted.
set -euo pipefail
umask 077
ROOT="${ALPHACI_HOME:-/opt/alphaci}"
REPLACE=0; ARGS=()
for arg in "$@"; do
  if [ "$arg" = --replace ]; then REPLACE=1; else ARGS+=("$arg"); fi
done
API="${ARGS[0]:?Usage: enroll.sh https://api.example.com [ubuntu|windows] [--replace]}"
PLATFORM="${ARGS[1]:-ubuntu}"
[[ "$API" =~ ^https://[^[:space:]]+$ ]] || { echo 'Use the public HTTPS API address.' >&2; exit 1; }
API="${API%/}"; API="${API%/api/v1}"
# An installer hands the code over in a file. Read it and delete the file before
# anything else can exit, so a run that fails here never leaves the code behind.
CODE=""; CODE_FROM_FILE=0
if [ -n "${ALPHACI_ENROLL_CODE_FILE:-}" ]; then
  CODE_FILE="$ALPHACI_ENROLL_CODE_FILE"
  unset ALPHACI_ENROLL_CODE_FILE
  [ -f "$CODE_FILE" ] && [ ! -L "$CODE_FILE" ] || { rm -f -- "$CODE_FILE"; echo 'The enrollment code file is missing.' >&2; exit 1; }
  CODE=$(<"$CODE_FILE")
  rm -f -- "$CODE_FILE"
  unset CODE_FILE
  CODE_FROM_FILE=1
fi
install -d -m 0700 "$ROOT/secrets"
PENDING="$ROOT/secrets/enrollment-response.json"
RETIRED=""
if [ -s "$ROOT/secrets/machine-token" ] && [ -s "$ROOT/machine.json" ]; then
  if [ "$REPLACE" = 1 ] && [ ! -s "$PENDING" ]; then
    RETIRED=$(mktemp -d "$ROOT/secrets/replaced.XXXXXX")
    mv "$ROOT/secrets/machine-token" "$ROOT/machine.json" "$RETIRED/"
  else
    jq -e --arg api "$API" '.apiUrl|rtrimstr("/")|rtrimstr("/api/v1")==$api' "$ROOT/machine.json" >/dev/null || { echo 'This machine is enrolled with a different API. Rerun with --replace and a replacement code before changing servers.' >&2; exit 1; }
    echo 'Existing machine enrollment retained. Rerun with --replace to use a replacement code.'
    exit 0
  fi
fi
WORK=$(mktemp -d "$ROOT/secrets/enroll.XXXXXX")
# The old credential stays valid until the server accepts the replacement code,
# so put it back whenever no response was received.
restore_retired() {
  [ -n "$RETIRED" ] && [ ! -s "$PENDING" ] && [ ! -e "$ROOT/machine.json" ] || return 0
  mv "$RETIRED/machine-token" "$ROOT/secrets/machine-token"
  mv "$RETIRED/machine.json" "$ROOT/machine.json"
  rmdir "$RETIRED"
  echo 'Replacement failed; the existing credential was restored.' >&2
}
trap 'unset CODE; rm -rf "$WORK"; restore_retired' EXIT
if [ ! -s "$PENDING" ]; then
if [ "$CODE_FROM_FILE" = 1 ]; then
  printf 'Code received from the install file. Enrolling this machine...\n' >&2
else
# End the prompt with a newline so it shows even where output is line-buffered.
printf '\nPaste the one-time enrollment code from AlphaCI, then press Enter (input is hidden):\n' >&2
read -r -s CODE
printf 'Code received. Enrolling this machine...\n' >&2
fi
CODE="${CODE//[[:space:]]/}"
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
# The server revoked any replaced credential when it accepted this code.
rm -rf "$ROOT"/secrets/replaced.*
echo 'Machine enrolled. No application has been deployed yet.'
