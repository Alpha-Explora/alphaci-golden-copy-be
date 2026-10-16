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
