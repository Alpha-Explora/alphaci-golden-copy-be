#!/usr/bin/env bash
# One automatic-address tunnel, run by alphaci-tunnel@<environment>.service.
# It runs cloudflared against the environment's host port and writes the
# AlphaCI quick-tunnel address it prints into the address file. Every start
# empties that file first, so it never holds an address from an earlier run.
# cloudflared's output goes to the journal; binary bytes in it are dropped.
# systemd restarts this script when it exits.
set -euo pipefail
ROOT="${ALPHACI_HOME:-/opt/alphaci}"
ENVIRONMENT="${1:?an environment id is required}"
[[ "$ENVIRONMENT" =~ ^[0-9a-f-]{36}$ ]] || { echo 'Invalid environment id.' >&2; exit 1; }
: "${ALPHACI_TUNNEL_PORT:?ALPHACI_TUNNEL_PORT is required}"
DIR="$ROOT/tunnels/$ENVIRONMENT"
BIN="${ALPHACI_CLOUDFLARED:-cloudflared}"
ADDRESS='https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com'
: > "$DIR/address"
child=""
trap 'if [ -n "$child" ]; then kill "$child" 2> /dev/null || true; fi' TERM INT
# --config names an empty file, so a ~/.cloudflared/config.yml cannot replace --url.
"$BIN" tunnel --config "$DIR/config.yml" --no-autoupdate --url "http://127.0.0.1:$ALPHACI_TUNNEL_PORT" \
  > >(tr -d '\000' | while IFS= read -r line; do
    printf '%s\n' "$line"
    url=$(printf '%s\n' "$line" | grep -aoE "$ADDRESS" | head -n 1 || true)
    if [ -n "$url" ]; then
      printf '%s\n' "$url" > "$DIR/address.new" && mv "$DIR/address.new" "$DIR/address"
    fi
  done) 2>&1 &
child=$!
wait "$child" || true
wait "$child" 2> /dev/null || true
