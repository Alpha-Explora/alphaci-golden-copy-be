#!/usr/bin/env bash
# Install or update the AlphaCI release agent on an Ubuntu host (WSL or VM).
# Run as root from this directory. Safe to rerun; it keeps an existing config.
set -euo pipefail
cd "$(dirname "$0")"

install -d -m 0755 /opt/alphaci/bin /opt/alphaci/trust /opt/alphaci/compose /opt/alphaci/releases
install -d -m 0700 /opt/alphaci/secrets
install -m 0755 alphaci-agent.sh /opt/alphaci/bin/alphaci-agent
if [ ! -f /opt/alphaci/agent.env ]; then
  install -m 0600 agent.env.example /opt/alphaci/agent.env
  echo "Edit /opt/alphaci/agent.env, then place the host token and trusted public key."
fi
install -m 0644 alphaci-agent.service /etc/systemd/system/alphaci-agent.service
install -m 0644 alphaci-agent.timer /etc/systemd/system/alphaci-agent.timer
systemctl daemon-reload
systemctl enable --now alphaci-agent.timer
systemctl list-timers alphaci-agent.timer --no-pager
