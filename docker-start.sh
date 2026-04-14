#!/bin/sh
set -e

# Start the Qwen proxy in the background on 127.0.0.1:3939.
bun run scripts/qwen-proxy.ts &
PROXY_PID=$!

# Wait for proxy to bind.
for i in $(seq 1 20); do
  if wget -qO- http://127.0.0.1:3939/v1/models >/dev/null 2>&1; then
    echo "[docker-start] proxy ready"
    break
  fi
  sleep 0.5
done

# Agent connects to the proxy.
export OPENAI_BASE_URL="http://127.0.0.1:3939/v1"

# Forward signals and run the agent in the foreground.
trap "kill $PROXY_PID 2>/dev/null" TERM INT
exec pnpm start
