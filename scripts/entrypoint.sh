#!/usr/bin/env bash
# Container entrypoint: bring up openclaw-gateway, REST server, and outsystemscc
# in order. Exits if any of them dies so Docker's restart policy can kick in.
set -euo pipefail

require_env() {
	local name="$1"
	if [[ -z "${!name:-}" ]]; then
		echo "entrypoint: required env var $name is not set" >&2
		exit 1
	fi
}

require_env ANTHROPIC_API_KEY
require_env BEARER_TOKEN
require_env CALLBACK_URL
require_env ODC_SERVER_URL
require_env ODC_TOKEN
require_env ODC_REMOTE_PORT

OPENCLAW_HOME="${HOME}/.openclaw"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/data/workspace-qa}"
export WORKSPACE_ROOT

mkdir -p "$OPENCLAW_HOME" "$WORKSPACE_ROOT"

# Mint a per-container gateway token on first start; reuse on restarts inside
# the same container layer so the REST server's token discovery stays consistent.
if [[ ! -f "$OPENCLAW_HOME/gateway.token" ]]; then
	openssl rand -hex 24 > "$OPENCLAW_HOME/gateway.token"
	chmod 600 "$OPENCLAW_HOME/gateway.token"
	echo "entrypoint: minted new gateway token"
fi
token="$(cat "$OPENCLAW_HOME/gateway.token")"

# Render the openclaw config from the template every start so .env toggles
# (e.g. LIVE_BROWSER) take effect on `docker compose up -d` without a rebuild.
# token is hex so it has no sed-special chars.
case "${LIVE_BROWSER:-false}" in
	true|TRUE|True|1|yes|YES) browser_headless="false" ;;
	false|FALSE|False|0|no|NO) browser_headless="true" ;;
	*)
		echo "entrypoint: LIVE_BROWSER must be true or false (got: ${LIVE_BROWSER})" >&2
		exit 1
		;;
esac
sed -e "s/__GATEWAY_TOKEN__/$token/" \
    -e "s/__BROWSER_HEADLESS__/$browser_headless/" \
    /opt/openclaw.template.json > "$OPENCLAW_HOME/openclaw.json"
echo "entrypoint: rendered openclaw config (browser.headless=$browser_headless)"

# Seed the writable workspace volume from the read-only template when empty.
# Bind-mounted host folders start empty and need the SOUL.md / skills / .claude
# config copied in once.
if [[ ! -f "$WORKSPACE_ROOT/SOUL.md" ]]; then
	echo "entrypoint: seeding workspace from /opt/workspace-qa"
	cp -a /opt/workspace-qa/. "$WORKSPACE_ROOT/"
fi

# Track child PIDs so we can kill them on shutdown / failure.
GATEWAY_PID=""
SERVER_PID=""
CONNECTOR_PID=""

cleanup() {
	echo "entrypoint: shutting down"
	[[ -n "$CONNECTOR_PID" ]] && kill "$CONNECTOR_PID" 2>/dev/null || true
	[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
	[[ -n "$GATEWAY_PID" ]] && kill "$GATEWAY_PID" 2>/dev/null || true
	wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

# Poll a localhost TCP port until it accepts connections, with a timeout.
wait_for_port() {
	local port="$1"
	local timeout="${2:-30}"
	local elapsed=0
	while ! (echo > /dev/tcp/127.0.0.1/"$port") 2>/dev/null; do
		sleep 1
		elapsed=$((elapsed + 1))
		if (( elapsed >= timeout )); then
			echo "entrypoint: timed out waiting for :$port after ${timeout}s" >&2
			return 1
		fi
	done
}

# 1. OpenClaw Gateway (loopback :18789). `gateway run` is the foreground form;
#    `gateway start` is for systemd/launchd which isn't available in Docker.
echo "entrypoint: starting openclaw gateway run"
openclaw gateway run &
GATEWAY_PID=$!
wait_for_port 18789 60

# 2. REST server (:3100). Reads BEARER_TOKEN, CALLBACK_URL, GATEWAY_URL
#    (default http://127.0.0.1:18789/v1/chat/completions), and the gateway
#    token from ~/.openclaw/gateway.token via discoverGatewayToken().
echo "entrypoint: starting REST server"
node /opt/qa-agent-backend/dist/index.js &
SERVER_PID=$!
wait_for_port 3100 30

# 3. OutSystems cloud connector reverse tunnel. Runs in the background so we
#    can detect any of the three dying via `wait -n`.
echo "entrypoint: starting outsystemscc"
outsystemscc \
	--header "token: ${ODC_TOKEN}" \
	"${ODC_SERVER_URL}" \
	"R:${ODC_REMOTE_PORT}:127.0.0.1:3100" &
CONNECTOR_PID=$!

echo "entrypoint: all three processes up (gateway=$GATEWAY_PID server=$SERVER_PID connector=$CONNECTOR_PID)"

# Exit as soon as any one of them dies so Docker can restart the whole stack.
wait -n "$GATEWAY_PID" "$SERVER_PID" "$CONNECTOR_PID"
status=$?
echo "entrypoint: a child process exited with status $status; tearing down"
exit "$status"
