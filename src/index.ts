import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  prepareRun,
  executeRun,
  AgentInvocationError,
  discoverGatewayToken,
  type RunMeta,
} from "./invokeAgent.js";
import { postCallback, type WebhookPayload } from "./webhook.js";

const PORT = Number(process.env.PORT ?? 3100);
const BEARER_TOKEN = requireEnv("BEARER_TOKEN");
const CALLBACK_URL = requireEnv("CALLBACK_URL");
const CALLBACK_TIMEOUT_MS = Number(process.env.CALLBACK_TIMEOUT_MS ?? 30_000);
const AGENT_ID = process.env.AGENT_ID ?? "qa-executor";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:18789/v1/chat/completions";
const GATEWAY_TOKEN = discoverGatewayToken();
const AGENT_TIMEOUT_SECONDS = Number(process.env.AGENT_TIMEOUT_SECONDS ?? 600);
const WORKSPACE_ROOT = resolve(
  process.env.WORKSPACE_ROOT ?? join(homedir(), ".openclaw", "workspace-qa"),
);
const ARTIFACT_TTL_DAYS = Number(process.env.ARTIFACT_TTL_DAYS ?? 14);
// Host allowlist still applies to /artifacts (defense-in-depth against DNS
// rebinding when an operator hits the route from a browser via a tunnel).
// `POST /test_user_story` is bearer-only — no host check — because there's no
// browser flow that submits jobs and the bearer token gates everything.
const DEFAULT_ALLOWED_HOSTS = [
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  "127.0.0.1",
  "localhost",
];
const ALLOWED_HOSTS = [
  ...DEFAULT_ALLOWED_HOSTS,
  ...(process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
];

// Path-segment validators. Strict by design — any deviation gets a 400, which
// also blocks `..` and other traversal attempts before path.join.
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const FILENAME_RE = /^[A-Za-z0-9_-]+\.png$/;

const TOP_LEVEL_FIELDS = new Set([
  "app_url", "jira_key", "title", "description", "auth", "client_ref",
]);
const AUTH_FIELDS = new Set(["required", "username", "password"]);

interface ValidatedInput {
  app_url: string;
  jira_key: string;
  title: string;
  description: string;
  auth:
    | { required: false }
    | { required: true; username: string; password: string };
  client_ref?: number | string;
}

function validateInput(
  body: unknown,
): { ok: true; value: ValidatedInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      return { ok: false, error: `unknown field "${key}"` };
    }
  }
  for (const key of ["app_url", "jira_key", "title", "description"] as const) {
    const v = b[key];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, error: `field "${key}" is required and must be a non-empty string` };
    }
  }
  if (!JIRA_KEY_RE.test(b.jira_key as string)) {
    return { ok: false, error: `field "jira_key" must match ${JIRA_KEY_RE} (e.g. AQA-37)` };
  }

  if (!b.auth || typeof b.auth !== "object" || Array.isArray(b.auth)) {
    return { ok: false, error: `field "auth" is required and must be an object` };
  }
  const auth = b.auth as Record<string, unknown>;
  for (const key of Object.keys(auth)) {
    if (!AUTH_FIELDS.has(key)) {
      return { ok: false, error: `unknown field "auth.${key}"` };
    }
  }
  if (typeof auth.required !== "boolean") {
    return { ok: false, error: `field "auth.required" must be a boolean` };
  }
  if (auth.required === true) {
    if (typeof auth.username !== "string" || (auth.username as string).length === 0) {
      return { ok: false, error: `field "auth.username" is required when auth.required is true` };
    }
    if (typeof auth.password !== "string" || (auth.password as string).length === 0) {
      return { ok: false, error: `field "auth.password" is required when auth.required is true` };
    }
  }

  if (b.client_ref !== undefined) {
    const c = b.client_ref;
    const valid =
      (typeof c === "number" && Number.isFinite(c)) ||
      (typeof c === "string" && c.length > 0);
    if (!valid) {
      return { ok: false, error: `field "client_ref" must be a finite number or a non-empty string` };
    }
  }

  return { ok: true, value: b as unknown as ValidatedInput };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: required env var ${name} is not set. See .env.example.`);
    process.exit(1);
  }
  return v;
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${BEARER_TOKEN}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// Defense-in-depth against browser-driven DNS rebinding on the artifact
// route. Bearer auth is the primary control.
function checkHost(req: Request, res: Response): boolean {
  const host = req.headers.host;
  if (typeof host !== "string" || !ALLOWED_HOSTS.includes(host)) {
    res.status(403).json({ error: "forbidden host" });
    return false;
  }
  return true;
}

function pruneOldRuns(): void {
  if (!Number.isFinite(ARTIFACT_TTL_DAYS) || ARTIFACT_TTL_DAYS <= 0) return;
  if (!existsSync(WORKSPACE_ROOT)) return;
  const cutoff = Date.now() - ARTIFACT_TTL_DAYS * 86_400_000;
  let removed = 0;
  let jiraKeys: string[];
  try {
    jiraKeys = readdirSync(WORKSPACE_ROOT);
  } catch {
    return;
  }
  for (const jiraKey of jiraKeys) {
    if (!JIRA_KEY_RE.test(jiraKey)) continue;
    const jiraDir = join(WORKSPACE_ROOT, jiraKey);
    let runs: string[];
    try {
      const st = statSync(jiraDir);
      if (!st.isDirectory()) continue;
      runs = readdirSync(jiraDir);
    } catch {
      continue;
    }
    for (const runId of runs) {
      if (!RUN_ID_RE.test(runId)) continue;
      const runDir = join(jiraDir, runId);
      try {
        const st = statSync(runDir);
        if (!st.isDirectory()) continue;
        if (st.mtimeMs < cutoff) {
          rmSync(runDir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // best-effort; ignore
      }
    }
  }
  if (removed > 0) {
    console.log(`[prune] removed ${removed} run folder(s) older than ${ARTIFACT_TTL_DAYS}d`);
  }
}

const agentOpts = {
  gatewayUrl: GATEWAY_URL,
  agentId: AGENT_ID,
  token: GATEWAY_TOKEN,
  timeoutSeconds: AGENT_TIMEOUT_SECONDS,
  workspaceRoot: WORKSPACE_ROOT,
};
const callbackOpts = {
  url: CALLBACK_URL,
  token: BEARER_TOKEN,
  timeoutMs: CALLBACK_TIMEOUT_MS,
};

// Detached background dispatch: the HTTP response is already 202'd by the
// time this is called. executeRun() waits on the single-flight mutex; on
// settle, we POST the result (or the error) to CALLBACK_URL. Errors from
// postCallback() are swallowed inside the helper — no need to .catch here.
function dispatchAgent(input: ValidatedInput, meta: RunMeta): void {
  const clientRef = input.client_ref !== undefined ? { client_ref: input.client_ref } : {};
  executeRun(input, meta, agentOpts)
    .then(async (result) => {
      const payload: WebhookPayload = {
        status: "ok",
        jira_key: meta.jira_key,
        ...clientRef,
        run_id: result.run_id,
        results: result.results,
        screenshots: result.screenshots,
        total_duration_ms: result.total_duration_ms,
        timestamp_start: result.timestamp_start,
        timestamp_end: result.timestamp_end,
      };
      await postCallback(payload, callbackOpts);
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const raw = err instanceof AgentInvocationError ? err.raw : undefined;
      console.error(
        `[agent] run_id=${meta.run_id} jira_key=${meta.jira_key} failed: ${message}`,
      );
      const payload: WebhookPayload = {
        status: "error",
        run_id: meta.run_id,
        jira_key: meta.jira_key,
        ...clientRef,
        error: message,
        ...(raw ? { raw } : {}),
      };
      await postCallback(payload, callbackOpts);
    })
    .finally(() => {
      setImmediate(() => {
        try { pruneOldRuns(); } catch (e) { console.error("[prune] failed:", e); }
      });
    });
}

async function main(): Promise<void> {
  const app = express();

  // Health endpoint is unauthenticated so ngrok/ODC can probe liveness cheaply.
  // Mount it BEFORE json parsing and auth so it stays cheap and public.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, agent: AGENT_ID });
  });

  app.use(express.json({ limit: "4mb" }));

  // Every route below is auth-gated.
  app.use(bearerAuth);

  // Async job submission. Returns 202 immediately with the run_id; the
  // ObservationResult is POSTed to CALLBACK_URL when the agent finishes.
  app.post("/test_user_story", (req, res) => {
    const validation = validateInput(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    let meta: RunMeta;
    try {
      meta = prepareRun(validation.value, { workspaceRoot: WORKSPACE_ROOT });
    } catch (err) {
      // Should never trigger after validateInput, but defense-in-depth.
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }
    res.status(202).json({ run_id: meta.run_id, status: "accepted" });
    console.log(
      `[submit] accepted run_id=${meta.run_id} jira_key=${meta.jira_key} → callback=${CALLBACK_URL}`,
    );
    const redacted = {
      ...validation.value,
      auth: validation.value.auth.required
        ? { ...validation.value.auth, password: "[REDACTED]" }
        : validation.value.auth,
    };
    console.log(
      `[submit] full payload (received from ODC):\n${JSON.stringify(redacted)}`,
    );
    dispatchAgent(validation.value, meta);
  });

  // Screenshot artifacts. Same Bearer auth as /test_user_story; strict
  // charset validation before any filesystem call; resolved-path containment
  // as defense-in-depth. Host allowlist applies here.
  app.get("/artifacts/:jira_key/:run_id/:filename", (req, res) => {
    if (!checkHost(req, res)) return;
    const { jira_key: jiraKey, run_id: runId, filename } = req.params;
    if (!JIRA_KEY_RE.test(jiraKey) || !RUN_ID_RE.test(runId) || !FILENAME_RE.test(filename)) {
      res.status(400).json({ error: "invalid artifact path" });
      return;
    }
    const target = resolve(join(WORKSPACE_ROOT, jiraKey, runId, filename));
    if (!target.startsWith(WORKSPACE_ROOT + "/") && target !== WORKSPACE_ROOT) {
      res.status(400).json({ error: "invalid artifact path" });
      return;
    }
    if (!existsSync(target)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.setHeader("Content-Type", "image/png");
    createReadStream(target).pipe(res);
  });

  // One-shot prune at startup so old runs don't outlive the TTL just because
  // the server was restarted before the next call landed.
  pruneOldRuns();

  app.listen(PORT, () => {
    console.log(`qa-agent-backend REST server listening on :${PORT}`);
    console.log(`  agent:         openclaw/${AGENT_ID}`);
    console.log(`  gateway:       ${GATEWAY_URL}`);
    console.log(`  gateway auth:  ${GATEWAY_TOKEN ? "bearer (discovered)" : "none"}`);
    console.log(`  submit:        POST http://127.0.0.1:${PORT}/test_user_story  (Bearer-auth, 202 ack)`);
    console.log(`  callback:      POST ${CALLBACK_URL}  (Bearer-auth, ${CALLBACK_TIMEOUT_MS}ms timeout)`);
    console.log(`  artifacts:     GET  /artifacts/:jira_key/:run_id/:filename  (Bearer-auth, host-checked)`);
    console.log(`  workspace:     ${WORKSPACE_ROOT}`);
    console.log(`  artifact TTL:  ${ARTIFACT_TTL_DAYS} day(s)`);
    console.log(`  health:        http://127.0.0.1:${PORT}/healthz`);
    console.log(`  allowed hosts: ${ALLOWED_HOSTS.join(", ")}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
