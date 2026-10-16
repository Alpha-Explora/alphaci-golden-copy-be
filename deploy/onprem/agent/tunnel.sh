#!/usr/bin/env bash
# Automatic HTTPS address for an assignment in tunnel mode: a Cloudflare quick
# tunnel from this machine to the environment's host port. Each tunnel is its
# own systemd unit, alphaci-tunnel@<environment>.service, so systemd keeps it
# running, restarts it, and stops it when this machine stops or is revoked.
# cloudflared makes outbound connections only. Sourced by alphaci-supervisor.

TUNNEL_CLOUDFLARED="${ALPHACI_CLOUDFLARED:-cloudflared}"
TUNNEL_ROOT="${ALPHACI_HOME:-/opt/alphaci}/tunnels"
# The release this agent was tested with. Older cloudflared releases are refused
# rather than trusted; raise this when a newer release is tested.
TUNNEL_MIN_VERSION="2026.10.0"
TUNNEL_ADDRESS_PATTERN='https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com'

# tunnel_unit <environment>: the systemd unit that runs the environment's tunnel.
tunnel_unit() { printf 'alphaci-tunnel@%s.service' "$1"; }

# tunnel_problem: prints why no tunnel can run here, or nothing when one can.
tunnel_problem() {
  if ! command -v "$TUNNEL_CLOUDFLARED" > /dev/null 2>&1; then
    echo 'cloudflared is not installed on this machine, so no automatic HTTPS address can be created. Install cloudflared to use it.'
    return 0
  fi
  local version
  version=$("$TUNNEL_CLOUDFLARED" --version < /dev/null 2> /dev/null | grep -aoE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -n 1 || true)
  if [ -z "$version" ]; then
    echo 'cloudflared did not report its version, so its tunnels cannot be trusted. Reinstall cloudflared.'
    return 0
  fi
  if [ "$(printf '%s\n%s\n' "$TUNNEL_MIN_VERSION" "$version" | sort -V | head -n 1)" != "$TUNNEL_MIN_VERSION" ]; then
    echo "cloudflared $version is older than $TUNNEL_MIN_VERSION, the release AlphaCI was tested with. Upgrade cloudflared to use the automatic HTTPS address."
  fi
}

# tunnel_address <environment>: the address the tunnel printed in its current run,
# if it is an AlphaCI quick-tunnel address. The tunnel user writes run/, so root opens
# the file with dd's nofollow and nonblock flags: the open itself never follows a link
# and never blocks on a FIFO, so no check is needed before it. Only text that matches
# the pattern is used. Root removes run/address when a tunnel stops and writes nothing
# else into run/.
tunnel_address() {
  dd if="$TUNNEL_ROOT/$1/run/address" iflag=nofollow,nonblock bs=300 count=1 status=none 2> /dev/null |
    tr -d '\r' | grep -axE "$TUNNEL_ADDRESS_PATTERN" | head -n 1 || true
}

# tunnel_record <environment> <assignment-id> <port> <status> <publicUrl> <message>
# Writes tunnel.json atomically; the supervisor sends these fields upstream.
tunnel_record() {
  local dir="$TUNNEL_ROOT/$1" tmp
  tmp=$(mktemp "$dir/tunnel.XXXXXX")
  jq -n --arg assignmentId "$2" --argjson port "$3" --arg status "$4" \
    --arg publicUrl "$5" --arg message "$6" \
    '{assignmentId: $assignmentId, port: $port, status: $status,
      publicUrl: (if $publicUrl == "" then null else $publicUrl end),
      message: $message}' > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$dir/tunnel.json"
}

# tunnel_sync <environment> <assignment-id> <host-port>: keeps the environment's
# tunnel unit running for its port and records what it observed.
tunnel_sync() {
  local environment="$1" id="$2" port="$3" dir unit wanted previous problem url tmp
  dir="$TUNNEL_ROOT/$environment"
  unit=$(tunnel_unit "$environment")
  # The environment directory is root-owned: it holds this machine's settings,
  # which only root writes. The tunnel user writes only run/, where the address is.
  install -d -m 0755 "$dir"
  chown root:root "$dir"
  install -d -m 0750 "$dir/run"
  if id -u alphaci-tunnel > /dev/null 2>&1; then
    chown alphaci-tunnel:alphaci-tunnel "$dir/run"
  fi
  previous=$(jq -r '.status // empty' "$dir/tunnel.json" 2> /dev/null || true)
  problem=$(tunnel_problem)
  if [ -n "$problem" ]; then
    systemctl stop "$unit" < /dev/null > /dev/null 2>&1 || true
    tunnel_record "$environment" "$id" "$port" unavailable "" "$problem"
    return 0
  fi
  # The unit reads its port when it starts, so a changed port restarts it.
  wanted="ALPHACI_TUNNEL_PORT=$port"
  if [ "$(cat "$dir/tunnel.env" 2> /dev/null || true)" != "$wanted" ]; then
    # Written under a fresh name and renamed into place: a link is replaced, never followed.
    tmp=$(mktemp "$dir/tunnel.env.XXXXXX")
    printf '%s\n' "$wanted" > "$tmp"
    chmod 0600 "$tmp"
    mv "$tmp" "$dir/tunnel.env"
    if systemctl is-active --quiet "$unit" < /dev/null; then
      systemctl stop "$unit" < /dev/null > /dev/null 2>&1 || true
    fi
  fi
  # An empty config file keeps ~/.cloudflared/config.yml from overriding --url.
  if [ ! -e "$dir/config.yml" ]; then
    tmp=$(mktemp "$dir/config.XXXXXX")
    chmod 0644 "$tmp"
    mv "$tmp" "$dir/config.yml"
  fi
  if ! systemctl is-active --quiet "$unit" < /dev/null; then
    if systemctl start "$unit" < /dev/null > /dev/null 2>&1; then
      if [ "$previous" = running ] || [ "$previous" = starting ]; then
        tunnel_record "$environment" "$id" "$port" failed "" \
          'The Cloudflare tunnel stopped. Starting it again.'
      else
        tunnel_record "$environment" "$id" "$port" starting "" 'Starting the Cloudflare tunnel.'
      fi
    else
      tunnel_record "$environment" "$id" "$port" failed "" \
        "The Cloudflare tunnel service could not start. See journalctl -u $unit."
    fi
    return 0
  fi
  url=$(tunnel_address "$environment")
  if [ -n "$url" ]; then
    tunnel_record "$environment" "$id" "$port" running "$url" \
      'The automatic HTTPS address is ready. It changes if the tunnel restarts.'
  else
    tunnel_record "$environment" "$id" "$port" starting "" \
      'Waiting for Cloudflare to assign the automatic HTTPS address.'
  fi
}

# tunnel_stop <environment>: stops the environment's tunnel and removes its folder, so
# later check-ins do not stop it again. Only a folder named by an environment UUID is
# ever removed.
tunnel_stop() {
  systemctl stop "$(tunnel_unit "$1")" < /dev/null > /dev/null 2>&1 || true
  if [[ "$1" =~ ^[0-9a-f-]{36}$ ]]; then
    rm -rf "$TUNNEL_ROOT/$1"
  fi
}

# tunnel_stop_all: stops every tunnel this machine runs. Used when the machine
# is revoked, uninstalled, or cannot authenticate.
tunnel_stop_all() {
  local dir
  for dir in "$TUNNEL_ROOT"/*/; do
    [ -d "$dir" ] || continue
    tunnel_stop "$(basename "$dir")"
  done
}
