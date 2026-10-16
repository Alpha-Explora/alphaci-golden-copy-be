#!/usr/bin/env bash
# Stops AlphaCI polling and the automatic-address tunnels on an Ubuntu host.
# Credentials, releases, containers, and application data stay until removed.
set -euo pipefail
[ "$EUID" -eq 0 ] || { echo 'Run this with sudo.' >&2; exit 1; }
# Stop polling first, so the timer cannot start a run or a tunnel again. A
# timer that is not installed is not an error.
systemctl disable --now alphaci-machine.timer 2> /dev/null || true
systemctl disable --now alphaci-agent.timer 2> /dev/null || true
# A run already in progress must not start a tunnel after the tunnels stop.
systemctl stop alphaci-machine.service 2> /dev/null || true
# Older supervisors do not know --stop-tunnels and would run a full poll instead.
if [ -x /opt/alphaci/bin/alphaci-supervisor ] && [ -f /opt/alphaci/bin/tunnel.sh ]; then
  /opt/alphaci/bin/alphaci-supervisor --stop-tunnels
fi
echo 'AlphaCI polling and automatic-address tunnels are stopped. Containers, credentials, and data remain until removed.'
