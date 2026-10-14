#!/usr/bin/env bash
# Install or update the AlphaCI release agent on an Ubuntu host (WSL or VM).
# Run as root from this directory. Safe to rerun; it keeps an existing config.
set -euo pipefail
cd "$(dirname "$0")"

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
systemctl enable --now alphaci-agent.timer
systemctl list-timers alphaci-agent.timer --no-pager
