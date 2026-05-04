# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

A single-process TypeScript REST server (Node ≥ 20, ESM, Express) that exposes one async endpoint — `POST /test_user_story` — with bearer-token auth. The handler is a thin façade: validate body → mint a `run_id` → respond **202 Accepted** → run the OpenClaw `qa-executor` agent in the background → POST the resulting observation JSON to a configured webhook (`CALLBACK_URL`). The agent itself drives the OpenClaw `browser` tool against an OutSystems app via OpenClaw's OpenAI-compatible `/v1/chat/completions` endpoint.

> **Earlier shape:** before 2026-05, this server exposed `test_user_story` as an MCP tool over Streamable HTTP (using `@modelcontextprotocol/sdk`). MCP has been removed entirely — there is no transport layer, no JSON-RPC, no session management. Don't reintroduce it.

**Canonical deployment is the Docker image** — see `Dockerfile`, `docker-compose.yml`, `scripts/entrypoint.sh`. The image runs three processes together: openclaw-gateway (loopback :18789), the REST server (:3100), and the OutSystems Cloud Connector (`outsystemscc`, reverse tunnel to ODC tenant). It is the backend for the **OutSystems ONE 2026 hands-on lab** on 2026-06-03; reproducibility on attendee laptops is the design constraint.

```
ODC app                                              ODC app's webhook endpoint
   │                                                              ▲
   │  POST /test_user_story  Bearer auth                          │  POST $CALLBACK_URL
   │  body: {app_url, jira_key, title, description, auth}         │  Bearer ${BEARER_TOKEN}
   ▼                                                              │  body: {status, run_id, results, screenshots, ...}
src/index.ts  (Express, port 3100)                                │
   │  202 { run_id, status:"accepted" } returned IMMEDIATELY      │
   │                                                              │
   │  background:                                                 │
   ▼                                                              │
prepareRun() → mint run_id (sortable ISO)                         │
executeRun() → queue onto single-flight mutex                     │
   │                                                              │
   │  POST /v1/chat/completions, model=openclaw/qa-executor       │
   ▼                                                              │
OpenClaw Gateway (127.0.0.1:18789)                                │
   │  user message includes run_id + absolute screenshot_dir      │
   ▼                                                              │
qa-executor agent → browser tool (navigate/snapshot/act/          │
                    screenshot/close/stop) → observation JSON     │
                                            + PNGs on disk at     │
                                              ${WORKSPACE_ROOT}/  │
                                              ${jira_key}/        │
                                              ${run_id}/          │
   │                                                              │
   ▼                                                              │
postCallback() ───────────────────────────────────────────────────┘

GET /artifacts/:jira/:run/:file.png    (Bearer + Host allowlist)
```

The HTTP-to-Gateway design (vs spawning `openclaw agent --json` per call) is deliberate — see README §"Why HTTP and not openclaw agent (subprocess)?". Don't reintroduce subprocess pairing.

## Commands

Docker (canonical):
```bash
docker compose up -d --build       # build + run all three processes
docker compose logs -f             # follow all logs
docker compose down                # stop + remove
docker compose exec mcp-qa bash    # shell into the running container
```

Source mode (development):
```bash
npm install
npm run build         # tsc -p . → dist/
npm start             # node dist/index.js   (reads .env)
npm run dev           # tsx watch src/index.ts (no rebuild loop)

# End-to-end smoke against a running server. The smoke test binds a callback
# receiver on 127.0.0.1:3101, so the server's CALLBACK_URL must point there
# BEFORE the server starts (see README §"Smoke test").
BEARER_TOKEN=$(grep ^BEARER_TOKEN= .env | cut -d= -f2) node dist/smoke.js
# Optional first arg overrides the test app URL:
BEARER_TOKEN=… node dist/smoke.js https://my-odc-app.outsystemscloud.com/MyApp/
```

Image build patches the globally-installed openclaw via `scripts/patch-openclaw.mjs` (see `Desktop/openclaw-screenshot-bug-fixes.md`). The script is idempotent and locates files by glob, but it is keyed against `openclaw@2026.4.15` exact strings — bumping the openclaw version in `Dockerfile` may require regenerating the patch anchors.

There are no unit tests, no linter, and no CI. `src/smoke.ts` is the only check — it exercises the full async flow end-to-end (POST + 202 + webhook receive + artifact GET).

## Architecture notes worth knowing

- **Async only.** The submit handler returns 202 immediately and runs the agent in a detached promise. There is no synchronous "wait for the result" path. Failures from the agent (timeout, gateway error, unparseable reply) are reported via the webhook with `status: "error"`, not via the HTTP submit response.
- **Webhook delivery is best-effort.** `src/webhook.ts:postCallback` makes one POST attempt with `CALLBACK_TIMEOUT_MS` (default 30 s). On any failure (network, non-2xx, abort) it logs the full payload at ERROR level so it can be recovered manually from logs. There is no retry queue and no in-memory polling fallback. Don't add one without a strong reason — for the lab, log-and-drop is sufficient and matches the user's stated preference.
- **Single bearer token in both directions.** `BEARER_TOKEN` gates inbound submit and artifact requests AND is sent on the outbound webhook as `Authorization: Bearer ${BEARER_TOKEN}`. The ODC endpoint must validate it. Don't split into two tokens unless asked.
- **Bearer auth is timing-safe.** `src/index.ts:bearerAuth` builds the expected string `Bearer ${BEARER_TOKEN}` and uses `crypto.timingSafeEqual` against the incoming `Authorization` header. `/healthz` is the only public endpoint.
- **Host-check asymmetry.** `POST /test_user_story` is **bearer-only** (no host check). `GET /artifacts/...` is bearer + host-allowlist (defense-in-depth against browser-driven DNS rebinding). Loopback (`127.0.0.1[:PORT]`, `localhost[:PORT]`) is always allowed; other hostnames must be added via `ALLOWED_HOSTS`. The Cloud Connector forwards the upstream `Host` header unchanged on `/artifacts` requests, so the lab `.env` needs `secure-gateway:<ODC_REMOTE_PORT>,secure-gateway`.
- **Single-flight invocation.** `src/invokeAgent.ts` keeps a module-scoped `pending: Promise<unknown>` chain so concurrent agent calls serialize. `qa-executor` drives a single shared `browser` tool session, so this is mandatory — don't remove the mutex.
- **prepareRun runs OUTSIDE the mutex; executeRun runs INSIDE.** This split exists so the 202 ack can return its `run_id` *before* the queue wait. `prepareRun()` is synchronous (validates jira_key, mints run_id, builds screenshot_dir). `executeRun()` queues the gateway call. The legacy `invokeAgent()` wrapper composes them for callers that want the all-in-one flow. If you remove the wrapper, audit nothing depends on it.
- **Monotonic run_id minting.** `mintRunId()` keeps a `lastMintedMs` so two `prepareRun()` calls within the same real-time millisecond still get distinct run_ids without changing the public `RUN_ID_RE` format. If you change the run-id format, update **all** of: `RUN_ID_RE` in `src/index.ts`, `RUN_ID_RE` and `PATH_RE` in `src/smoke.ts`, the public README contract, and `workspace-qa/SOUL.md`.
- **Per-call session reset.** Each request to the Gateway carries a fresh `user: randomUUID()`. This forces the Gateway to start a clean agent session and prevents context accumulation across calls (the model otherwise grows beyond its context window after a few invocations). Don't drop or stabilize the UUID.
- **Tolerant JSON parsing of agent replies.** `parseJsonLoose` in `invokeAgent.ts` strips ` ```json ` fences and falls back to outermost-`{...}` extraction. Models drift; trust the parser, don't add a stricter validation layer upstream.
- **Gateway token discovery order:** `GATEWAY_TOKEN` env → `GATEWAY_TOKEN_FILE` env → `~/.openclaw/gateway.token`. If none exist, the server starts but the first agent call fails with a 401 from the Gateway (which surfaces as `status: "error"` on the webhook).
- **Screenshots as paths, not bytes.** The agent saves PNGs to `${WORKSPACE_ROOT}/${jira_key}/${run_id}/`. After the agent returns, the server enumerates that folder, sorts by mtime ascending (capture order), and includes bare relative paths (`{jira_key}/{run_id}/{filename}.png`) in `screenshots: string[]` on the webhook payload. Inlining base64 was rejected — token cost on the consumer side blows up. Don't reintroduce it. The consumer concatenates each path against this server's base URL and fetches `GET <base>/artifacts/<path>` with the same `Authorization: Bearer …` header. Returning relative paths (vs absolute URLs) keeps the payload token-cheap and avoids hard-coding a public base URL on the server.
- **Per-run subfolder isolation.** Re-running the same `jira_key` writes to a fresh `run_id` subfolder. Old runs survive on disk so a delayed consumer can still fetch their URLs, until pruned by `ARTIFACT_TTL_DAYS` (default 14). Pruning runs at startup and after each agent run completes (deferred via `setImmediate` so the webhook delivery isn't blocked). Both the artifact route and the prune walker validate `jira_key`/`run_id`/`filename` against strict regexes before any filesystem access — keep them in sync if you ever change the run-id format.
- **SOUL.md depends on the per-call user message.** The agent receives `run_id` and an absolute `screenshot_dir` in its input JSON and is told (in SOUL.md) to save into that directory verbatim. The output JSON shape is unchanged — the agent does **not** report screenshot filenames; the server discovers them from disk. If you change the run-id format or the input keys, update both `src/invokeAgent.ts` and `~/.openclaw/workspace-qa/SOUL.md` together.

## REST contract

The submit body matches what the old MCP `TOOL_INPUT_SCHEMA` accepted. Validation lives in `src/index.ts:validateInput` (hand-rolled, no Ajv dependency). Required: `app_url`, `jira_key`, `title`, `description`, `auth`. When `auth.required === true`, `username` and `password` are also required. The agent reaches the login screen by navigating to `app_url` and following an in-page Login/Sign in link — the base URL of an OutSystems app is often anonymous-accessible and won't auto-redirect, so SOUL.md instructs the agent to find the affordance rather than assume a redirect. There is no `login_url` input.

The webhook payload is a discriminated union on `status`:

- `status: "ok"` — flattened `ObservationResult` plus `jira_key` for correlation:
  - `results[i]` — observation-only per AC, no pass/fail (consumers must evaluate in their own prompt).
  - `run_id` — sortable ISO-like timestamp string identifying this invocation; also the screenshot subfolder name on disk.
  - `jira_key` — echoed from the request for correlation.
  - `screenshots` — flat `string[]` of bare relative paths (`{jira_key}/{run_id}/{filename}.png`) for every PNG captured this run, ordered by mtime ascending. Empty if the agent failed before any capture.
  - `total_duration_ms`, `timestamp_start`, `timestamp_end` — agent-reported.
- `status: "error"` — `run_id`, `jira_key`, `error` (string), and optional `raw` (raw agent output if reply was unparseable).

## Operational dependencies

The server itself has no databases or queues. It assumes:

1. The OpenClaw Gateway is running on the same host (default `127.0.0.1:18789`). In Docker, this is loopback inside the container — gateway and REST server share the network namespace.
2. A readable Gateway token exists at one of the discovery paths above. In Docker, `entrypoint.sh` mints one on first start and writes both `~/.openclaw/openclaw.json` (with the token interpolated) and `~/.openclaw/gateway.token`.
3. The Gateway exposes the `browser` tool to the `qa-executor` agent (workspace at `/data/workspace-qa` in the container, `~/.openclaw/workspace-qa` in source mode, overridable via `WORKSPACE_ROOT`). The repo's `workspace-qa/` directory is the canonical template; `entrypoint.sh` seeds the bind-mounted volume from `/opt/workspace-qa` on first start. The agent only uses these `browser` operations: `navigate`, `snapshot`, `act` (with snapshot ref IDs), `screenshot`, `close`, `stop` — see `workspace-qa/SOUL.md` for the agent contract.
4. The same filesystem path is also read by `src/index.ts` to serve `/artifacts/...` and to prune old run folders. The REST server and the Gateway therefore must share `WORKSPACE_ROOT` — in Docker, both run in the same container so this is automatic; in source mode running the agent on a different host without a shared filesystem would break screenshot URLs.
5. **In Docker only:** the `outsystemscc` reverse tunnel is required for ODC apps to reach this server. It dials out from the container; the container does not need an inbound public address. `ODC_SERVER_URL`, `ODC_TOKEN`, and `ODC_REMOTE_PORT` come from the ODC Portal's Private Gateway page.
6. The ODC app exposes a public REST endpoint at `CALLBACK_URL` that accepts `POST` with `Bearer ${BEARER_TOKEN}`. The endpoint must respond 2xx to acknowledge; non-2xx is logged but not retried. It must be reachable from the container (`outsystemscc` is inbound only — outbound webhook traffic uses regular egress).

If `docker compose up` (or `npm start`) succeeds but the webhook arrives with `status: "error"` and message `ECONNREFUSED`, it's the Gateway, not this server. In Docker check `docker compose logs mcp-qa | grep gateway` for early-startup gateway errors. If the webhook never arrives at all, check `docker compose logs mcp-qa | grep '\[webhook\]'` — `delivery FAILED` lines include the full payload for manual recovery.

## Required env vars (Docker)

`ANTHROPIC_API_KEY`, `BEARER_TOKEN`, `CALLBACK_URL`, `ODC_SERVER_URL`, `ODC_TOKEN`, `ODC_REMOTE_PORT`. Optional with defaults: `PORT`, `ALLOWED_HOSTS`, `ARTIFACT_TTL_DAYS`, `AGENT_TIMEOUT_SECONDS`, `CALLBACK_TIMEOUT_MS`, `AGENT_ID`, `IMAGE_OWNER`, `IMAGE_TAG`. See `.env.example` and the README "Config" section.

## Active work / state for this repo

The most recent plan is at `/home/admin/.claude/plans/we-have-a-new-groovy-moth.md` — the MCP-to-REST conversion. Earlier plans (e.g. `the-smoke-test-works-lazy-avalanche.md`) describe the ODC Private Gateway integration and may still be useful for operational context, but are superseded by this plan for the request/response shape.

Project memory at `/home/admin/.claude/projects/-home-admin-Desktop-mcp-qa/memory/` records non-obvious facts gathered across sessions (e.g. OutSystems doc pages need Playwright not WebFetch, ODC Private Gateway URL scheme rules). Read `MEMORY.md` first.
