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

# The automatic HTTPS address (tunnel) runs cloudflared, and AlphaCI gives every
# environment with a frontend that address by default, so install it when it is
# missing. Not fatal: without it the machine still deploys, and Hosting reports
# that the address is unavailable.
install_cloudflared() {
  command -v cloudflared >/dev/null 2>&1 && return 0
  local arch deb
  arch=$(dpkg --print-architecture)
  case "$arch" in
    amd64 | arm64) ;;
    *) echo "cloudflared is not available for $arch; the automatic HTTPS address will be unavailable." >&2; return 0 ;;
  esac
  echo 'Installing cloudflared for the automatic HTTPS address...'
  deb=$(mktemp --suffix=.deb)
  if curl -fsSL --retry 3 -o "$deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch.deb" &&
    dpkg -i "$deb" >/dev/null; then
    echo "Installed $(cloudflared --version 2>/dev/null | head -n 1)."
  else
    echo 'cloudflared could not be installed; the automatic HTTPS address stays unavailable until it is.' >&2
  fi
  rm -f "$deb"
}
