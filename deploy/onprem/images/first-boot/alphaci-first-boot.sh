#!/usr/bin/env bash
# First boot of an AlphaCI on-prem image. Enrolls this machine with the one-time code
# in /etc/alphaci/enrollment-code, then disables its own unit. enroll.sh deletes the
# code file when it reads it; a run that fails before that leaves the file, so the
# next boot retries. The code expires after 10 minutes.
set -euo pipefail
ETC="${ALPHACI_IMAGE_ETC:-/etc/alphaci}"
UNIT=alphaci-first-boot.service
. "$ETC/first-boot.env"
: "${ALPHACI_API_URL:?first-boot.env must set ALPHACI_API_URL}"
: "${ALPHACI_ARCHIVE_SHA256:?first-boot.env must set ALPHACI_ARCHIVE_SHA256}"
[ -s "$ETC/enrollment-code" ] || { echo "No enrollment code is waiting in $ETC/enrollment-code." >&2; exit 1; }

# A boot can come before the network does. enroll.sh deletes the code as soon as it
# reads it, so wait here for the API to answer. Only connection and DNS failures retry;
# any other curl failure stops with the code still in place.
wait_for_api() {
  local attempts="${ALPHACI_REACH_ATTEMPTS:-40}" delay="${ALPHACI_REACH_DELAY:-15}" attempt status
  for attempt in $(seq 1 "$attempts"); do
    status=0
    curl --silent --show-error --max-time 15 --output /dev/null "$ALPHACI_API_URL" || status=$?
    [ "$status" -eq 0 ] && return 0
    case "$status" in
      6 | 7 | 28)
        echo "Waiting for $ALPHACI_API_URL (attempt $attempt of $attempts)." >&2
        sleep "$delay"
        ;;
      *)
        echo "Cannot use $ALPHACI_API_URL (curl exit $status). The code was not used." >&2
        return 1
        ;;
    esac
  done
  echo "$ALPHACI_API_URL did not answer. The code was not used." >&2
  return 1
}
wait_for_api

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# The image may carry the installer archive itself, so enrollment needs no download.
if [ -n "${ALPHACI_ARCHIVE_PATH:-}" ]; then
  cp "$ALPHACI_ARCHIVE_PATH" "$work/agent.tar.gz"
else
  curl --fail --location --proto '=https' --retry 5 --retry-delay 15 --silent --show-error \
    "${ALPHACI_ARCHIVE_URL:?first-boot.env must set ALPHACI_ARCHIVE_URL or ALPHACI_ARCHIVE_PATH}" -o "$work/agent.tar.gz"
fi
printf '%s  %s\n' "$ALPHACI_ARCHIVE_SHA256" "$work/agent.tar.gz" | sha256sum --check --status ||
  { echo 'Installer checksum mismatch. Nothing was installed.' >&2; exit 1; }
tar -xzf "$work/agent.tar.gz" -C "$work"
ALPHACI_ENROLL_CODE_FILE="$ETC/enrollment-code" bash "$work/agent/install.sh" --enroll "$ALPHACI_API_URL"
systemctl disable "$UNIT"
echo 'Enrolled on first boot. The first-boot unit is disabled.'
