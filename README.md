# qa-agent-backend

The backend for the **OutSystems ONE 2026 hands-on lab** *"The Autonomous QA Agent."*
A thin TypeScript REST server that exposes your OpenClaw `qa-executor` agent as a single
async endpoint, `POST /test_user_story`, with bearer-token auth. The server accepts the
job, returns **202 Accepted** immediately with a `run_id`, and POSTs the
`ObservationResult` to a configured webhook URL when the agent finishes. The Docker
image bundles the gateway, this server, and the OutSystems Cloud Connector reverse
tunnel into one container so attendees only run `docker compose up -d`.

> **Note:** earlier versions of this server exposed `test_user_story` as an MCP tool
> over Streamable HTTP. That's been replaced by the plain REST + webhook contract
> documented here. There is no MCP transport anymore.

## How it works

```
ODC app ──► ODC Private Gateway ──► outsystemscc (in container)
                                          │
                                          ▼
                                 this REST server (:3100)
                                          │   POST /test_user_story  → 202 { run_id, status:"accepted" }
                                          │   GET  /artifacts/...    → PNG bytes
                                          │   GET  /healthz          → liveness
                                          │
                                          │  POST /v1/chat/completions
                                          ▼
                                 OpenClaw Gateway (loopback :18789, in container)
                                   model: openclaw/qa-executor
                                          │
                                          ▼
                                 qa-executor (Anthropic API + Chromium)
                                          │
                                          ▼
                                 ObservationResult JSON
                                          │
                                          ▼  POST $CALLBACK_URL  (Bearer ${BEARER_TOKEN})
                                  ODC app's webhook endpoint
```

The submit contract: body is `{app_url, jira_key, title, description, auth}` (same fields
as the previous MCP tool). The server validates, mints a `run_id`, replies 202, then
runs the agent in the background. When the agent returns the same observation JSON it
returned before, the server flattens it into a webhook payload, adds a `status`
discriminator, and POSTs it to `CALLBACK_URL` with `Authorization: Bearer ${BEARER_TOKEN}`.

The agent runs strictly **one at a time**: concurrent POSTs each get their own
`run_id` and a 202 immediately, but the actual gateway calls serialize through an
in-process mutex (qa-executor drives a single shared browser, so parallel runs
would race). If you POST N jobs back-to-back, webhook #N arrives roughly N ×
run_duration after submission. The lab consumer is sequential anyway.

## REST contract

### `POST /test_user_story`

Request:

```http
POST /test_user_story HTTP/1.1
Authorization: Bearer <BEARER_TOKEN>
Content-Type: application/json

{
  "app_url": "https://personal-XXX-dev.outsystems.app/MyApp/",
  "jira_key": "AQA-37",
  "title": "View dashboard after login",
  "description": "...\n\nAcceptance Criteria:\n* AC1: ...",
  "auth": { "required": false }
}
```

When `auth.required` is `true`, both `username` and `password` must also be present.

Successful response:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "run_id": "2026-05-04T14-22-33-123Z", "status": "accepted" }
```

Error responses:

| Status | When |
|---|---|
| `400 Bad Request` | Body is not JSON, or fails schema validation. The response body is `{"error": "..."}`. |
| `401 Unauthorized` | Missing or wrong `Authorization` header. |

The server **does not** report agent failures via the HTTP response — by the time
the test runs, the response has long since flushed. Failures are reported on the
webhook (see below).

### Webhook (POST to `CALLBACK_URL`)

When the agent finishes, the server POSTs to `CALLBACK_URL` with:

```http
POST <CALLBACK_URL> HTTP/1.1
Authorization: Bearer <BEARER_TOKEN>
Content-Type: application/json
User-Agent: qa-agent-backend/<version>
```

Successful run — body shape:

```jsonc
{
  "status": "ok",
  "run_id": "2026-05-04T14-22-33-123Z",
  "jira_key": "AQA-37",
  "results": [
    { "ac": "AC1", "actions_taken": ["..."], "observation": "..." }
  ],
  "screenshots": [
    "AQA-37/2026-05-04T14-22-33-123Z/ac1-login.png",
    "AQA-37/2026-05-04T14-22-33-123Z/ac2-dashboard.png"
  ],
  "total_duration_ms": 132040,
  "timestamp_start": "2026-05-04T14:22:33.123Z",
  "timestamp_end":   "2026-05-04T14:24:45.163Z"
}
```

Failed run — body shape:

```jsonc
{
  "status": "error",
  "run_id": "2026-05-04T14-22-33-123Z",
  "jira_key": "AQA-37",
  "error": "agent timed out after 600s",
  "raw": "..."   // optional: raw agent output if the reply was unparseable
}
```

The ODC endpoint should respond with **2xx** to acknowledge receipt. Delivery is
**best-effort**: one POST attempt with a 30 s timeout (configurable via
`CALLBACK_TIMEOUT_MS`). On any failure (network error, non-2xx, timeout) the full
payload is logged at `ERROR` level so you can recover it manually from the server
logs (`docker compose logs qa-agent-backend | grep '\[webhook\]'`). There is no retry queue.

### `GET /artifacts/:jira_key/:run_id/:filename`

Streams a PNG saved by the agent during the run. Same Bearer auth as the submit
endpoint. Each `screenshots[i]` value in the webhook payload is a bare relative
path (`{jira_key}/{run_id}/{filename}.png`); the consumer concatenates against the
server's base URL to reach it. Bytes never enter the LLM's token budget.

```http
GET /artifacts/AQA-37/2026-05-04T14-22-33-123Z/ac1-login.png
Authorization: Bearer <BEARER_TOKEN>
```

A typical ODC AI agent flow: receive the webhook, iterate `screenshots[]`, fetch
each binary, then attach it via Jira's REST attachment endpoint.

### `GET /healthz`

Unauthenticated liveness probe: `{"ok": true, "agent": "qa-executor"}`.

## Quickstart (Docker, recommended)

This is the lab path. You'll need:

- Docker (Docker Desktop on Mac/Windows, or `docker` + `docker compose` on Linux). Bump Docker Desktop's RAM to **at least 4 GB** under Settings → Resources — Chromium plus the gateway is hungry.
- An **Anthropic API key** (`sk-ant-...`).
- An ODC tenant with **Private Gateway** enabled. From the ODC Portal's Private Gateway page, copy the **Address**, the **Token**, and the **remote port** assigned to your connector.
- A REST endpoint exposed by your ODC app to receive webhook callbacks.

```bash
# 1. Clone the repo and copy the env template.
git clone https://github.com/<owner>/qa-agent-backend.git
cd qa-agent-backend
cp .env.example .env

# 2. Edit .env and fill in six values:
#      ANTHROPIC_API_KEY, BEARER_TOKEN, CALLBACK_URL,
#      ODC_SERVER_URL, ODC_TOKEN, ODC_REMOTE_PORT
#    BEARER_TOKEN is your choice; generate one with: openssl rand -hex 32

# 3. Allow the container to draw on your X display, so attendees can watch
#    the agent drive Chromium live. Linux/VM only. Re-run this after every
#    logout/reboot — xhost permissions live with the X session and reset
#    when it ends. Skip this step entirely if you set LIVE_BROWSER=false in
#    .env (headless mode).
xhost +local:

# 4. Start the stack. This pulls the pre-built image from GHCR.
docker compose up -d

# 5. Watch the three processes come up:
docker compose logs -f
#    [entrypoint] starting openclaw-gateway
#    [entrypoint] starting REST server
#    [entrypoint] starting outsystemscc
#    [entrypoint] all three processes up (...)
```

That's it. From the ODC app, POST to the Private Gateway URL on `ODC_REMOTE_PORT`
(see *Wire up OutSystems ODC* below) and listen for the webhook on `CALLBACK_URL`.

To stop the stack: `docker compose down`. To rebuild locally instead of pulling
the published image: `docker compose up -d --build`.

Screenshots written by the agent appear under `./artifacts/<jira_key>/<run_id>/`
on the host so you can browse them while debugging.

## Why HTTP and not `openclaw agent` (subprocess)?

Earlier versions of this wrapper spawned `openclaw agent --json` per call. That worked,
but: stdout/stderr routing is inconsistent, the subprocess doesn't always exit cleanly
when Gateway pairing isn't set up, and it's slower (~3× the latency of the HTTP path on
our test). The Gateway's OpenAI-compatible endpoint is already running, is stateless per
request, and gives us a clean HTTP error model.

## Run from source (development / advanced)

For developing on the REST server itself, or if Docker isn't an option, you can
run the three processes by hand. This was the original deployment path; the
Docker image just bundles all of it.

```bash
# 1. Install OpenClaw, plus a system Chrome/Chromium so OpenClaw's browser
#    tool can find it (it scans /usr/bin for chromium / google-chrome / etc.).
# 2. Apply the screenshot patches (one-time):
node scripts/patch-openclaw.mjs

# 3. Build and run the REST server:
cd qa-agent-backend
npm install
npm run build
cp .env.example .env
# Edit .env. For source mode, BEARER_TOKEN and CALLBACK_URL are required and
# most other vars can stay defaulted. ODC_* vars only matter if you also run
# outsystemscc.

# 4. Sanity check the OpenClaw Gateway:
curl -s -H "Authorization: Bearer $(cat ~/.openclaw/gateway.token)" \
     -H "Content-Type: application/json" \
     -X POST http://127.0.0.1:18789/v1/chat/completions \
     -d '{"model":"openclaw/qa-executor","messages":[{"role":"user","content":"ping"}]}'

# 5. Start the REST server:
npm start
# => qa-agent-backend REST server listening on :3100

# 6. In a second terminal — start the smoke listener (see "Smoke test" below).
```

### Smoke test

`src/smoke.ts` exercises the full async flow end-to-end: it binds a tiny HTTP
server on `127.0.0.1:3101` to receive the callback, POSTs a story to
`/test_user_story`, asserts the 202, then waits for the webhook and verifies
the artifact route.

For this to work the **server must already have `CALLBACK_URL` pointing at the
smoke listener** before it starts:

```bash
# In .env, set:
#   CALLBACK_URL=http://127.0.0.1:3101/callback           (source mode)
# or
#   CALLBACK_URL=http://host.docker.internal:3101/callback (Docker)

# Start the server (npm start or docker compose up -d), then:
BEARER_TOKEN=$(grep ^BEARER_TOKEN= .env | cut -d= -f2) node dist/smoke.js
# Optional first arg overrides the test app URL:
BEARER_TOKEN=… node dist/smoke.js https://my-odc-app.outsystemscloud.com/MyApp/
```

## Wire up OutSystems ODC

In your ODC app:

1. **Outbound** (calling this server):

   | Field | Value |
   |---|---|
   | Method | `POST` |
   | URL | `https://<your-private-gateway-host>/<gateway-id>:<ODC_REMOTE_PORT>/test_user_story` |
   | Header `Authorization` | `Bearer <BEARER_TOKEN from .env>` |
   | Body | `{ app_url, jira_key, title, description, auth }` (see contract above) |

2. **Inbound** (receiving the webhook): expose a REST endpoint reachable from the
   server (typically a public ODC URL, since the Private Gateway is one-way
   inbound to the gateway, not outbound). The endpoint must:
   - Accept `POST` with `Content-Type: application/json`.
   - Validate `Authorization: Bearer <BEARER_TOKEN>` (same token as outbound).
   - Return `2xx` to acknowledge receipt.
   - Body shape per the contract above (success or error variant).

   Set `CALLBACK_URL` in `.env` to the public URL of this endpoint.

## Config (`.env`)

Required when running with Docker:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key OpenClaw uses to drive the qa-executor agent. |
| `BEARER_TOKEN` | Token your ODC app must send on every call here, AND the token this server sends on the outbound webhook. Generate with `openssl rand -hex 32`. |
| `CALLBACK_URL` | Where to POST the `ObservationResult` when the agent finishes. Your ODC app should expose this endpoint and validate the bearer header. |
| `ODC_SERVER_URL` | OutSystems Private Gateway address (from ODC Portal). |
| `ODC_TOKEN` | OutSystems Private Gateway token (from ODC Portal). |
| `ODC_REMOTE_PORT` | Remote port assigned to your connector (from ODC Portal). |

Optional (defaults are sensible):

| Var | Default | Purpose |
|---|---|---|
| `LIVE_BROWSER` | `true` | Show the agent's Chromium window on the host display while it runs (lab demo). Needs a Linux host/VM with an X server and `xhost +local:` (re-run after every logout/reboot — xhost permissions reset with the X session). Set to `false` to run headless — useful in CI, on Mac/Windows, or when the host has no display. |
| `PORT` | `3100` | Host port the REST server is published on. |
| `AGENT_ID` | `qa-executor` | OpenClaw agent id; the wrapper sends `model: "openclaw/${AGENT_ID}"`. |
| `GATEWAY_URL` | `http://127.0.0.1:18789/v1/chat/completions` | OpenClaw Gateway endpoint. Inside the Docker image this is loopback; only override for source-mode setups. |
| `GATEWAY_TOKEN` / `GATEWAY_TOKEN_FILE` | *(auto-discovered)* | Bearer for the Gateway. The container mints a token and writes it to `~/.openclaw/gateway.token`; both processes read from there. |
| `AGENT_TIMEOUT_SECONDS` | `600` | Max wait for the Gateway to return a reply. |
| `CALLBACK_TIMEOUT_MS` | `30000` | Max wait for the outbound webhook POST before aborting. |
| `ALLOWED_HOSTS` | *(empty)* | Extra `Host` header values allowed on `/artifacts`. Loopback is always allowed. Add the upstream `secure-gateway:<port>` value (with and without port) when fetching screenshots through the Private Gateway, since outsystemscc forwards the upstream Host header unchanged. |
| `ARTIFACT_TTL_DAYS` | `14` | How long per-run screenshot folders are kept before pruning. Set `0` to disable. |
| `WORKSPACE_ROOT` | `/data/workspace-qa` (container) / `~/.openclaw/workspace-qa` (source) | Filesystem root under which the agent writes screenshots. |
| `IMAGE_OWNER` / `IMAGE_TAG` | `outsystems-one-2026-lab` / `latest` | Override only if you've forked the repo and pushed your own image to a different GHCR namespace. |

## Verifying end to end

1. Container health: `docker compose ps` shows the `qa-agent-backend` service `Up`. `docker compose logs` shows all three "[entrypoint] starting …" lines.
2. Local health check: `curl http://localhost:3100/healthz` → `{"ok":true,"agent":"qa-executor"}` (no auth required).
3. Submit a job:
   ```bash
   curl -i -X POST http://localhost:3100/test_user_story \
     -H "Authorization: Bearer $BEARER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "app_url": "https://…outsystemscloud.com/MyApp/",
       "jira_key": "AQA-12",
       "title": "View dashboard",
       "description": "...\n\nAcceptance Criteria:\n* AC1: ...",
       "auth": { "required": false }
     }'
   # → HTTP/1.1 202 Accepted
   #   { "run_id": "2026-…", "status": "accepted" }
   ```
4. Watch `docker compose logs -f` for the `[webhook] delivered run_id=… status=ok` line (or `delivery FAILED` with the full payload, which means your `CALLBACK_URL` is wrong or unreachable).
5. PNGs appear under `./artifacts/<jira_key>/<run_id>/` on the host.

## Troubleshooting

### Docker-specific

- **Container restart-loops with `entrypoint: required env var X is not set`** — your `.env` is missing one of the six required values. `docker compose config` to see what compose loaded.
- **`outsystemscc` log says `connection refused` / `404`** — `ODC_SERVER_URL`, `ODC_TOKEN`, or `ODC_REMOTE_PORT` is wrong. Re-copy them from the ODC Portal.
- **OOM-killed Chromium** — bump Docker Desktop's RAM allocation to ≥4 GB (Settings → Resources). The compose file already sets the container limit to 4 GB.
- **Live browser doesn't appear / window opens blank** — almost always missing `xhost +local:` for the current X session. xhost permissions reset at every logout/reboot, so re-run it whenever you hit this. If it still doesn't appear, your host may not have an X server (Mac/Windows without XQuartz/VcXsrv); set `LIVE_BROWSER=false` in `.env` to run headless.
- **`exec format error` on Apple Silicon** — you pulled the amd64 image. Run `docker compose pull` again to refresh; the workflow publishes both `linux/amd64` and `linux/arm64` under the same tag.
- **Behind a corporate proxy** — pass `--proxy http://user:pass@host:port` to outsystemscc. Today the entrypoint hardcodes the connector args; if you need this, edit `scripts/entrypoint.sh` or open an issue.

### Both Docker and source mode

- **`gateway request failed: ...ECONNREFUSED`**
  The OpenClaw Gateway isn't running. In Docker, this means the gateway crashed inside the container — `docker compose logs qa-agent-backend | grep gateway`. In source mode, start it manually.
- **`gateway returned HTTP 401`**
  The Gateway requires auth and the wrapper didn't find a token. Either set
  `GATEWAY_TOKEN` in `.env`, point `GATEWAY_TOKEN_FILE` at the right file, or
  ensure `~/.openclaw/gateway.token` is readable by the user running this server.
- **`gateway returned HTTP 404` on `/v1/chat/completions`**
  Older OpenClaw builds may host the OpenAI endpoint elsewhere or behind a flag.
  Check `openclaw gateway status` and adjust `GATEWAY_URL`.
- **Agent reports `No supported browser found`**
  OpenClaw's browser tool scans `/usr/bin/google-chrome`, `/usr/bin/chromium`, etc. for a system browser; it doesn't bundle one. In Docker the image installs `chromium` from apt, so seeing this means the image build is broken — check `docker exec qa-agent-backend ls /usr/bin/chromium`. In source mode, install one yourself (`apt install chromium` on Debian/Ubuntu, `brew install chromium` on macOS).
- **`401 unauthorized` on submit or artifact fetch**
  The `Authorization` header must be exactly `Bearer <BEARER_TOKEN>`. Compare with `.env`.
- **`[webhook] delivery FAILED`**
  Your `CALLBACK_URL` is wrong, the ODC endpoint is down, or it's rejecting the bearer token. The full payload is in the same log line — recover by hand if needed. There is no automatic retry.
- **403 / forbidden host on `/artifacts` requests**
  The Host header sent by the upstream isn't in `ALLOWED_HOSTS`. For the Private Gateway path that's typically `secure-gateway:<ODC_REMOTE_PORT>` and `secure-gateway`; add both. (Submission isn't host-checked.)
- **Agent reply was not valid JSON**
  Your SOUL.md is strict, but models drift. The wrapper tolerates ```json fences and
  leading prose. If parsing still fails, the raw `choices[0].message.content` is included
  as `raw` in the error webhook payload.
- **Timeouts**
  Default `AGENT_TIMEOUT_SECONDS=600`. Long flows (many ACs with screenshots) may need
  more — increase here. The submit response is unaffected (it's already 202'd); a
  timeout shows up as `status: "error"` on the webhook.
- **Concurrency**
  qa-executor runs one browser session at a time. The wrapper serializes invocations
  in-process. Concurrent POSTs each get an immediate 202 with their own `run_id`, but
  the agent invocations queue and run sequentially.

## Files

- `src/index.ts` — Express server: bearer auth, host check, `/healthz`, `POST /test_user_story`, `GET /artifacts/...`, prune.
- `src/invokeAgent.ts` — Posts to the Gateway's OpenAI-compatible endpoint. Splits into `prepareRun()` (sync, mints `run_id`) and `executeRun()` (queues onto the single-flight mutex). Tolerant JSON parsing.
- `src/webhook.ts` — Best-effort outbound webhook delivery; logs full payload on failure.
- `src/smoke.ts` — Local end-to-end check (REST submit + webhook receiver + artifact fetch).
- `.env.example` — All config knobs.
