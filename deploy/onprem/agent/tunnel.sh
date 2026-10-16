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

# tunnel_address <environment>: the address the tunnel printed in its current
# run, if it is an AlphaCI quick-tunnel address. Anything else is not reported.
tunnel_address() {
  head -c 300 "$TUNNEL_ROOT/$1/address" 2> /dev/null | tr -d '\r' |
    grep -axE "$TUNNEL_ADDRESS_PATTERN" | head -n 1 || true
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
  local environment="$1" id="$2" port="$3" dir unit wanted previous problem url
  dir="$TUNNEL_ROOT/$environment"
  unit=$(tunnel_unit "$environment")
  mkdir -p "$dir"
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
    printf '%s\n' "$wanted" > "$dir/tunnel.env.new"
    chmod 0600 "$dir/tunnel.env.new"
    mv "$dir/tunnel.env.new" "$dir/tunnel.env"
    if systemctl is-active --quiet "$unit" < /dev/null; then
      systemctl stop "$unit" < /dev/null > /dev/null 2>&1 || true
    fi
  fi
  # An empty config file keeps ~/.cloudflared/config.yml from overriding --url.
  if [ ! -e "$dir/config.yml" ]; then
    : > "$dir/config.yml"
    chmod 0600 "$dir/config.yml"
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

# tunnel_stop <environment>: stops the environment's tunnel and forgets its report.
tunnel_stop() {
  systemctl stop "$(tunnel_unit "$1")" < /dev/null > /dev/null 2>&1 || true
  rm -f "$TUNNEL_ROOT/$1/tunnel.json" "$TUNNEL_ROOT/$1/address"
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
