#!/usr/bin/env bash
# Stops AlphaCI polling and the automatic-address tunnels on an Ubuntu host.
# Credentials, releases, containers, and application data stay until removed.
set -euo pipefail
[ "$EUID" -eq 0 ] || { echo 'Run this with sudo.' >&2; exit 1; }
# Disable polling first, so the timer cannot start a tunnel again.
systemctl disable --now alphaci-machine.timer alphaci-agent.timer 2> /dev/null || true
if [ -x /opt/alphaci/bin/alphaci-supervisor ]; then
  /opt/alphaci/bin/alphaci-supervisor --stop-tunnels
fi
echo 'AlphaCI polling and automatic-address tunnels are stopped. Containers, credentials, and data remain until removed.'
