#!/usr/bin/env bash
# Automatic HTTPS address for an assignment in tunnel mode: a Cloudflare quick
# tunnel from this machine to the environment's host port. cloudflared makes
# outbound connections only, so no inbound port opens. The supervisor sources
# this file, keeps one tunnel per tunnel-mode assignment, and reports what each
# tunnel observed with the next heartbeat. Quick-tunnel addresses change when
# the tunnel restarts; a named tunnel on the customer's domain is the production
# path (docs/runbooks/runbook-onprem-host-setup.md).

TUNNEL_CLOUDFLARED="${ALPHACI_CLOUDFLARED:-cloudflared}"

# tunnel_alive <pid>: the process runs and is still a tunnel. tunnel.json
# survives reboots, and a reused PID must never be taken for a live tunnel or
# signalled.
tunnel_alive() {
  [ -n "$1" ] && kill -0 "$1" 2> /dev/null && grep -qa cloudflared "/proc/$1/cmdline" 2> /dev/null
}

# tunnel_record <dir> <assignment-id> <port> <pid> <status> <publicUrl> <message>
# Writes tunnel.json atomically. Empty pid or publicUrl means null.
tunnel_record() {
  local tmp
  tmp=$(mktemp "$1/tunnel.XXXXXX")
  jq -n --arg assignmentId "$2" --argjson port "$3" --arg pid "$4" \
    --arg status "$5" --arg publicUrl "$6" --arg message "$7" \
    '{assignmentId: $assignmentId, port: $port,
      pid: (if $pid == "" then null else ($pid | tonumber) end),
      status: $status,
      publicUrl: (if $publicUrl == "" then null else $publicUrl end),
      message: $message}' > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$1/tunnel.json"
}

# tunnel_stop <dir>: ends the tunnel recorded in <dir> and forgets it.
tunnel_stop() {
  local pid
  pid=$(jq -r '.pid // empty' "$1/tunnel.json" 2> /dev/null || true)
  if tunnel_alive "$pid"; then kill "$pid" 2> /dev/null || true; fi
  rm -f "$1/tunnel.json" "$1/tunnel.log"
}

# tunnel_sync <dir> <assignment-id> <host-port>: keeps one tunnel open to the
# host port and records its state. A missing cloudflared is a reported state,
# never an error: the rest of the machine keeps working.
tunnel_sync() {
  local dir="$1" id="$2" port="$3" pid="" recorded_port="" url=""
  mkdir -p "$dir"
  if [ -s "$dir/tunnel.json" ]; then
    pid=$(jq -r '.pid // empty' "$dir/tunnel.json" 2> /dev/null || true)
    recorded_port=$(jq -r '.port // empty' "$dir/tunnel.json" 2> /dev/null || true)
  fi
  if [ "$recorded_port" = "$port" ] && tunnel_alive "$pid"; then
    url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$dir/tunnel.log" 2> /dev/null | tail -n 1 || true)
    if [ -n "$url" ]; then
      tunnel_record "$dir" "$id" "$port" "$pid" running "$url" \
        'The automatic HTTPS address is ready. It changes if the tunnel restarts.'
    else
      tunnel_record "$dir" "$id" "$port" "$pid" starting "" \
        'Waiting for Cloudflare to assign the automatic HTTPS address.'
    fi
    return 0
  fi
  # Not running, or serving another port: end what is left, then start again.
  if tunnel_alive "$pid"; then kill "$pid" 2> /dev/null || true; fi
  if ! command -v "$TUNNEL_CLOUDFLARED" > /dev/null 2>&1; then
    tunnel_record "$dir" "$id" "$port" "" unavailable "" \
      'cloudflared is not installed on this machine, so no automatic HTTPS address can be created. Install cloudflared to use it.'
    return 0
  fi
  local status=starting message='Starting the Cloudflare tunnel.'
  if [ -n "$pid" ] && [ "$recorded_port" = "$port" ]; then
    status=failed
    message='The Cloudflare tunnel stopped. Starting it again.'
  fi
  : > "$dir/tunnel.log"
  # A subshell that execs cloudflared makes $! the tunnel's own PID. Output
  # goes to tunnel.log, not to the caller, so the supervisor can exit.
  (
    exec "$TUNNEL_CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$port"
  ) > "$dir/tunnel.log" 2>&1 < /dev/null &
  tunnel_record "$dir" "$id" "$port" "$!" "$status" "" "$message"
}
