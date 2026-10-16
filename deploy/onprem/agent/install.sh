#!/usr/bin/env bash
# Install or update the AlphaCI release agent on an Ubuntu host (WSL or VM).
# Run as root from this directory. Safe to rerun; it keeps an existing config.
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = --enroll ]; then
  [ "$EUID" -eq 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
  echo 'Checking Ubuntu prerequisites...'
  . /etc/os-release
  [ "$ID" = ubuntu ] || { echo 'The machine installer requires Ubuntu.' >&2; exit 1; }
  for tool in curl jq openssl flock sha256sum docker systemctl ss; do
    command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
  done
  docker info >/dev/null || { echo 'Docker Engine must be running.' >&2; exit 1; }
  docker compose version >/dev/null || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
  [ -d /run/systemd/system ] || { echo 'Enable systemd and restart Ubuntu before installing.' >&2; exit 1; }
  [ -s /etc/ssl/certs/ca-certificates.crt ] || { echo 'Install ca-certificates first.' >&2; exit 1; }
  available=$(df -Pk /opt | awk 'NR==2 {print $4}')
  [ "$available" -ge 1048576 ] || { echo 'At least 1 GiB free disk space is required.' >&2; exit 1; }
  install -d -m 0755 /opt/alphaci/bin
  install -d -m 0700 /opt/alphaci/secrets /opt/alphaci/assignments
  install -m 0755 alphaci-agent.sh /opt/alphaci/bin/alphaci-agent
  install -m 0755 alphaci-supervisor.sh /opt/alphaci/bin/alphaci-supervisor
  install -m 0644 tunnel.sh /opt/alphaci/bin/tunnel.sh
  install -m 0755 tunnel-run.sh /opt/alphaci/bin/tunnel-run
  install -d -m 0700 /opt/alphaci/tunnels
  install -m 0644 alphaci-tunnel@.service /etc/systemd/system/alphaci-tunnel@.service
  [ ! -f render-assignment.sh ] || install -m 0755 render-assignment.sh /opt/alphaci/bin/render-assignment
  # API URL, optional platform and optional --replace pass through unchanged.
  [ -n "${2:-}" ] || { echo 'Public API URL is required.' >&2; exit 1; }
  bash ./enroll.sh "${@:2}"
  /opt/alphaci/bin/alphaci-supervisor --heartbeat-only
  install -m 0644 alphaci-machine.service /etc/systemd/system/alphaci-machine.service
  install -m 0644 alphaci-machine.timer /etc/systemd/system/alphaci-machine.timer
  systemctl daemon-reload
  systemctl enable --now alphaci-machine.timer
  echo 'Host connected. Assign an environment in AlphaCI to deploy a project.'
  exit 0
fi

install -d -m 0755 /opt/alphaci/bin /opt/alphaci/trust /opt/alphaci/compose /opt/alphaci/releases /opt/alphaci/tls
install -d -m 0700 /opt/alphaci/secrets /opt/alphaci/support
install -m 0755 alphaci-agent.sh /opt/alphaci/bin/alphaci-agent
# Examples only: the customer's compose.yaml and Caddyfile are never replaced.
install -m 0644 ../compose/compose.example.yaml /opt/alphaci/compose/compose.example.yaml
install -m 0644 ../compose/Caddyfile.example /opt/alphaci/compose/Caddyfile.example
if [ ! -f /opt/alphaci/agent.env ]; then
  install -m 0600 agent.env.example /opt/alphaci/agent.env
  echo "Edit /opt/alphaci/agent.env, then place the host token and trusted public key."
fi
install -m 0644 alphaci-agent.service /etc/systemd/system/alphaci-agent.service
install -m 0644 alphaci-agent.timer /etc/systemd/system/alphaci-agent.timer
systemctl daemon-reload
if bash -c '
  . /opt/alphaci/agent.env
  [[ "$ALPHACI_API_URL" = https://* && "$ALPHACI_API_URL" != *alphaci.example* ]] &&
  test -s "$ALPHACI_HOST_TOKEN_FILE" && test -s "$ALPHACI_COMPOSE_FILE" &&
  openssl pkey -pubin -in "$ALPHACI_TRUST_KEY" -noout >/dev/null 2>&1
'; then
  systemctl enable --now alphaci-agent.timer
else
  echo 'Legacy timer remains disabled until the host token, public trust key and agent.env are configured.'
fi
systemctl list-timers alphaci-agent.timer --no-pager
