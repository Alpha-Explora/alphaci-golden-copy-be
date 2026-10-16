#!/usr/bin/env bash
# Install or update the AlphaCI release agent on an Ubuntu host (WSL or VM).
# Run as root from this directory. Safe to rerun; it keeps an existing config.
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = --enroll ]; then
  [ "$EUID" -eq 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
  . ./ubuntu-prerequisites.sh
  check_ubuntu_prerequisites
  install -d -m 0755 /opt/alphaci/bin
  install -d -m 0700 /opt/alphaci/secrets /opt/alphaci/assignments
  install -m 0755 alphaci-agent.sh /opt/alphaci/bin/alphaci-agent
  install -m 0755 alphaci-supervisor.sh /opt/alphaci/bin/alphaci-supervisor
  [ ! -f render-assignment.sh ] || install -m 0755 render-assignment.sh /opt/alphaci/bin/render-assignment
  # API URL, optional platform and optional --replace pass through unchanged. So does
  # ALPHACI_ENROLL_CODE_FILE, which enroll.sh reads the code from when it is set.
  [ -n "${2:-}" ] || { echo 'Public API URL is required.' >&2; exit 1; }
  bash ./enroll.sh "${@:2}"
  install -m 0644 alphaci-machine.service /etc/systemd/system/alphaci-machine.service
  install -m 0644 alphaci-machine.timer /etc/systemd/system/alphaci-machine.timer
  systemctl daemon-reload
  # The units go in before the first check-in, so an enrolled machine keeps polling even
  # when that check-in fails; the timer retries it every 30 seconds.
  checked_in=1
  /opt/alphaci/bin/alphaci-supervisor --heartbeat-only || checked_in=0
  systemctl enable --now alphaci-machine.timer
  if [ "$checked_in" = 1 ]; then
    echo 'Host connected. Assign an environment in AlphaCI to deploy a project.'
  else
    echo 'Host enrolled, but the first check-in failed. The timer will retry; check journalctl -u alphaci-machine.service if it stays offline.' >&2
  fi
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
