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
# An installer hands the code over in a file. The file is read here but kept until the
# server answers: a success or a 4xx rejection deletes it, while a network, timeout or
# 5xx failure keeps it so the next run (or the first-boot retry) can use it. Any other
# exit that never reached the server deletes it too, so the code is not left behind.
CODE=""; CODE_FROM_FILE=0; KEEP_CODE_FILE=0
CODE_FILE="${ALPHACI_ENROLL_CODE_FILE:-}"
unset ALPHACI_ENROLL_CODE_FILE
discard_code_file() { [ -n "$CODE_FILE" ] && [ "$KEEP_CODE_FILE" != 1 ] && rm -f -- "$CODE_FILE" || true; }
trap 'discard_code_file' EXIT
if [ -n "$CODE_FILE" ]; then
  [ -f "$CODE_FILE" ] && [ ! -L "$CODE_FILE" ] || { echo 'The enrollment code file is missing.' >&2; exit 1; }
  CODE=$(<"$CODE_FILE")
  CODE_FROM_FILE=1
  # Interrupted while the request is in flight: the outcome is unknown, so keep the file.
  trap 'KEEP_CODE_FILE=1; exit 130' INT TERM
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
trap 'unset CODE; rm -rf "$WORK"; restore_retired; discard_code_file' EXIT
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
printf '%s' "$CODE" | jq -Rs '{code:.,agentVersion:"0.4.0",checks:[]}' > "$WORK/request.json"
unset CODE
# -w reports 000 when no response arrived at all. Only an HTTP answer is judged below.
curl_status=0
http_status=$(curl --silent --show-error --max-time 30 -H 'Content-Type: application/json' \
  --data-binary "@$WORK/request.json" -o "$WORK/response.json" -w '%{http_code}' \
  "$API/api/v1/onprem/enroll") || curl_status=$?
# The server's own message, when its response has one. It never contains the code.
server_message() {
  jq -r '(.message // .error // empty) | if type == "array" then join("; ") else tostring end' "$WORK/response.json" 2>/dev/null | head -c 300 || true
}
# The file note appears only for a run that read the code from a file.
code_note() { if [ "$CODE_FROM_FILE" = 1 ]; then echo "$1"; fi; }
if [ "$curl_status" -ne 0 ] || [ "$http_status" = 000 ]; then
  KEEP_CODE_FILE=1
  echo "AlphaCI could not be reached (curl exit $curl_status).$(code_note ' The code file has been kept for a retry.')" >&2
  exit 1
fi
case "$http_status" in
  2??)
    # Accept only a complete response: a truncated body must never reach $PENDING.
    if ! jq -e '(.credential | type == "string" and test("^onprem_machine_[A-Za-z0-9_-]{43}$")) and (.trustKeys | type == "object" and length > 0) and (.machine.id | type == "string" and length > 0)' "$WORK/response.json" >/dev/null 2>&1; then
      KEEP_CODE_FILE=1
      echo "AlphaCI sent an incomplete enrollment response.$(code_note ' The code file has been kept for a retry.')" >&2
      exit 1
    fi ;;
  401|409)
    # The server refuses the code itself: invalid or expired (401), already used (409). The file goes.
    # A 400 is not a code verdict (the format is checked above), so it is kept like other refusals.
    echo "AlphaCI rejected the enrollment code (HTTP $http_status).$(code_note ' The code file has been deleted.') $(server_message)" >&2
    discard_code_file
    exit 1 ;;
  *)
    # Throttled, disabled or failing server: the code may still be valid, so the file stays.
    KEEP_CODE_FILE=1
    echo "AlphaCI did not accept the enrollment request (HTTP $http_status).$(code_note ' The code file has been kept for a retry.') $(server_message)" >&2
    exit 1 ;;
esac
mv "$WORK/response.json" "$PENDING"
# Accepted: the code is used up, so the file goes.
discard_code_file
fi
cp "$PENDING" "$WORK/response.json"
jq -e '.credential|test("^onprem_machine_[A-Za-z0-9_-]{43}$")' "$WORK/response.json" >/dev/null
jq -e '.trustKeys|type=="object" and length>0' "$WORK/response.json" >/dev/null
jq -e --arg api "$API" '.apiUrl|rtrimstr("/")|rtrimstr("/api/v1")==$api' "$WORK/response.json" >/dev/null || { echo 'Pending enrollment belongs to a different API. Resolve it before changing servers.' >&2; exit 1; }
jq -er '.credential' "$WORK/response.json" > "$WORK/machine-token"
jq '.trustKeys' "$WORK/response.json" > "$WORK/trust.json"
jq --arg root "$ROOT" '. as $r | {id:$r.machine.id,apiUrl:$r.apiUrl,agentVersion:"0.4.0",tokenFile:($root+"/secrets/machine-token"),trustFile:($root+"/trust.json")}' "$WORK/response.json" > "$WORK/machine.json"
# Publish config last. An interrupted write never starts the timer.
install -m 0600 "$WORK/machine-token" "$ROOT/secrets/machine-token"
install -m 0600 "$WORK/trust.json" "$ROOT/trust.json"
mv "$WORK/machine.json" "$ROOT/machine.json"
rm -f "$PENDING"
# The server revoked any replaced credential when it accepted this code.
rm -rf "$ROOT"/secrets/replaced.*
echo 'Machine enrolled. No application has been deployed yet.'
