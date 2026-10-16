# Sourced by install.sh --enroll and by the alphaci-agent package's alphaci-enroll,
# before any enrollment. Each failed check names the fix and stops the run.
check_ubuntu_prerequisites() {
  echo 'Checking Ubuntu prerequisites...'
  . /etc/os-release
  [ "$ID" = ubuntu ] || { echo 'The machine installer requires Ubuntu.' >&2; exit 1; }
  local tool available
  for tool in curl jq openssl flock sha256sum docker systemctl ss; do
    command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
  done
  docker info >/dev/null || { echo 'Docker Engine must be running.' >&2; exit 1; }
  docker compose version >/dev/null || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
  [ -d /run/systemd/system ] || { echo 'Enable systemd and restart Ubuntu before installing.' >&2; exit 1; }
  [ -s /etc/ssl/certs/ca-certificates.crt ] || { echo 'Install ca-certificates first.' >&2; exit 1; }
  available=$(df -Pk /opt | awk 'NR==2 {print $4}')
  [ "$available" -ge 1048576 ] || { echo 'At least 1 GiB free disk space is required.' >&2; exit 1; }
}
