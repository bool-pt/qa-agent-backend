import { readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Managed `openclaw` browser profile's user-data-dir. The gateway gives a
// fresh agent conversation per call (`user: randomUUID()`) but the underlying
// Chromium profile persists on disk, so cookies/login leak across runs. We
// stop+wipe before each run. Default path is openclaw's convention for
// managed profiles: $HOME/.openclaw/browser/<profile>/user-data.
const BROWSER_PROFILE_NAME = "openclaw";
const BROWSER_USERDATA_DIR =
  process.env.BROWSER_USERDATA_DIR?.trim() ||
  join(homedir(), ".openclaw", "browser", BROWSER_PROFILE_NAME, "user-data");
const BROWSER_RESET_TIMEOUT_MS = 5_000;

export interface ObservationResult {
  results: Array<{
    ac: string;
    actions_taken: string[];
    observation: string;
  }>;
  total_duration_ms: number;
  timestamp_start: string;
  timestamp_end: string;
  // Added by the REST server (not the agent): bare relative paths
  // ("{jira_key}/{run_id}/{filename}.png") for every screenshot captured
  // during this run, ordered by mtime (capture order). The consumer
  // reconstructs the fetchable URL as `<base_url>/artifacts/<path>`
  // and fetches with the same Bearer token. Returning relative paths keeps
  // the response token-cheap and avoids hard-coding a public base URL.
  screenshots: string[];
  run_id: string;
}

export interface InvokeOptions {
  // Full URL of the OpenAI-compatible chat completions endpoint on the Gateway,
  // e.g. http://127.0.0.1:18789/v1/chat/completions
  gatewayUrl: string;
  // Agent id without the `openclaw/` model prefix.
  agentId: string;
  // Bearer token for the Gateway. Optional — if the Gateway is bound to
  // loopback with auth disabled, omit.
  token?: string;
  timeoutSeconds: number;
  // Filesystem root the agent saves screenshots under. Each call writes to
  // `{workspaceRoot}/{jira_key}/{run_id}/`.
  workspaceRoot: string;
}

export interface RunMeta {
  run_id: string;
  jira_key: string;
  screenshot_dir: string;
}

export class AgentInvocationError extends Error {
  constructor(message: string, public raw?: string) {
    super(message);
    this.name = "AgentInvocationError";
  }
}

// qa-executor drives a single browser — parallel calls would race. Serialize
// in-process so the contract is enforceable instead of relying on callers to
// queue. Concurrent POSTs each get their own run_id from `prepareRun()`
// (so the 202 returns immediately) but the actual gateway calls chain
// through this mutex.
let pending: Promise<unknown> = Promise.resolve();

// Monotonic millisecond clock so two prepareRun() calls within the same
// real-time millisecond still produce distinct run_ids — without changing
// the public RUN_ID_RE format.
let lastMintedMs = 0;
function mintRunId(): string {
  let ms = Date.now();
  if (ms <= lastMintedMs) ms = lastMintedMs + 1;
  lastMintedMs = ms;
  // Format must stay in sync with RUN_ID_RE in src/index.ts.
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

/**
 * Synchronous: validate jira_key, mint run_id, build the absolute screenshot
 * directory the agent will write into. Runs *outside* the single-flight
 * mutex so a 202 can be returned to the REST caller before the agent starts.
 */
export function prepareRun(
  input: unknown,
  opts: { workspaceRoot: string },
): RunMeta {
  const inputObj = (input ?? {}) as Record<string, unknown>;
  const jiraKey = typeof inputObj.jira_key === "string" ? inputObj.jira_key : "";
  if (!jiraKey) {
    throw new AgentInvocationError("input is missing jira_key");
  }
  const runId = mintRunId();
  const screenshotDir = join(opts.workspaceRoot, jiraKey, runId);
  return { run_id: runId, jira_key: jiraKey, screenshot_dir: screenshotDir };
}

/**
 * Queue the agent invocation onto the single-flight mutex and return its
 * ObservationResult. `meta` must come from a prior `prepareRun()` call so
 * the run_id and screenshot_dir match.
 */
export async function executeRun(
  input: unknown,
  meta: RunMeta,
  opts: InvokeOptions,
): Promise<ObservationResult> {
  const run = pending.catch(() => undefined).then(() => doExecute(input, meta, opts));
  pending = run;
  return run;
}

/**
 * Back-compat wrapper used by callers that want both phases in one call
 * (e.g. internal scripts). The new REST handler calls prepareRun + executeRun
 * separately so it can ack the request before queueing the gateway POST.
 */
export async function invokeAgent(
  input: unknown,
  opts: InvokeOptions,
): Promise<ObservationResult> {
  const meta = prepareRun(input, { workspaceRoot: opts.workspaceRoot });
  return executeRun(input, meta, opts);
}

async function doExecute(
  input: unknown,
  meta: RunMeta,
  opts: InvokeOptions,
): Promise<ObservationResult> {
  const inputObj = (input ?? {}) as Record<string, unknown>;
  const { run_id: runId, jira_key: jiraKey, screenshot_dir: screenshotDir } = meta;

  await resetBrowserProfile(runId);

  // Hand the agent both the run_id and the absolute directory it must write
  // into, so SOUL.md doesn't have to encode the workspace root.
  const messageBody = { ...inputObj, run_id: runId, screenshot_dir: screenshotDir };

  const body = JSON.stringify({
    model: `openclaw/${opts.agentId}`,
    messages: [{ role: "user", content: JSON.stringify(messageBody) }],
    user: randomUUID(), // fresh gateway session per invocation — prevents context accumulation
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const startedAt = Date.now();
  console.log(`[invokeAgent] POST ${opts.gatewayUrl} model=openclaw/${opts.agentId} run_id=${runId} (message ${body.length} bytes)`);
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[invokeAgent] still running — ${elapsed}s elapsed`);
  }, 30_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutSeconds * 1000);

  let res: Response;
  try {
    res = await fetch(opts.gatewayUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    clearInterval(heartbeat);
    if ((err as { name?: string }).name === "AbortError") {
      throw new AgentInvocationError(
        `agent timed out after ${opts.timeoutSeconds}s`,
      );
    }
    throw new AgentInvocationError(
      `gateway request failed: ${(err as Error).message}`,
    );
  }
  clearTimeout(timer);
  clearInterval(heartbeat);

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const text = await res.text();
  console.log(`[invokeAgent] gateway responded after ${elapsed}s: HTTP ${res.status} (${text.length}B)`);

  if (!res.ok) {
    throw new AgentInvocationError(
      `gateway returned HTTP ${res.status}: ${text.slice(0, 500)}`,
      text,
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new AgentInvocationError(
      `gateway returned non-JSON response: ${text.slice(0, 500)}`,
      text,
    );
  }

  const content = (envelope as {
    choices?: Array<{ message?: { content?: unknown } }>;
  })?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || content.length === 0) {
    throw new AgentInvocationError(
      "gateway response missing choices[0].message.content",
      text,
    );
  }

  const parsed = parseJsonLoose(content) as Omit<ObservationResult, "screenshots" | "run_id">;

  const filenames = await listScreenshots(screenshotDir);
  const screenshots = filenames.map(
    (filename) => `${jiraKey}/${runId}/${filename}`,
  );

  return { ...parsed, screenshots, run_id: runId };
}

// List *.png in the run folder ordered by mtime ascending (capture order).
// If the folder is missing (agent failed before any screenshot), returns [].
async function listScreenshots(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const pngNames = entries.filter((n) => n.toLowerCase().endsWith(".png"));
  const stats = await Promise.all(
    pngNames.map(async (name) => {
      try {
        const st = await stat(join(dir, name));
        return st.isFile() ? { name, mtimeMs: st.mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );
  const pngs = stats.filter((x): x is { name: string; mtimeMs: number } => x !== null);
  pngs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return pngs.map((p) => p.name);
}

// Stop the managed Chromium process and delete its user-data-dir so the next
// agent call starts with no cookies / storage / login. Best-effort: failures
// are logged but do not abort the run — the agent still works, just without
// the isolation guarantee, and the operator sees the warning in logs.
async function resetBrowserProfile(runId: string): Promise<void> {
  try {
    await execFileAsync(
      "openclaw",
      ["browser", "--browser-profile", BROWSER_PROFILE_NAME, "stop"],
      { timeout: BROWSER_RESET_TIMEOUT_MS },
    );
  } catch (err) {
    // Non-zero exit usually means "wasn't running" — expected on the first
    // call and after clean shutdowns. Only log if the failure looks atypical.
    const e = err as { code?: string | number; killed?: boolean };
    if (e.killed) {
      console.error(`[browser-reset] run_id=${runId} 'openclaw browser stop' timed out after ${BROWSER_RESET_TIMEOUT_MS}ms`);
    }
  }

  try {
    await rm(BROWSER_USERDATA_DIR, { recursive: true, force: true });
    console.log(`[browser-reset] run_id=${runId} wiped ${BROWSER_USERDATA_DIR}`);
  } catch (err) {
    console.error(
      `[browser-reset] run_id=${runId} failed to wipe ${BROWSER_USERDATA_DIR}: ${(err as Error).message} — proceeding with dirty state`,
    );
  }
}

/**
 * Auto-discover a Gateway bearer token from common locations:
 *   1. GATEWAY_TOKEN env var
 *   2. GATEWAY_TOKEN_FILE env var (path to a file containing the token)
 *   3. ~/.openclaw/gateway.token (default install location)
 * Returns undefined if none found — caller may then attempt unauthenticated.
 */
export function discoverGatewayToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const inline = env.GATEWAY_TOKEN?.trim();
  if (inline) return inline;
  const path = env.GATEWAY_TOKEN_FILE?.trim()
    || join(homedir(), ".openclaw", "gateway.token");
  try {
    const t = readFileSync(path, "utf8").trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The agent's reply often arrives wrapped in ```json code fences with
 * leading/trailing prose. Be tolerant: strip fences, then find the outermost
 * {...} if direct parse fails.
 */
function parseJsonLoose(text: string): unknown {
  const withoutFences = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    return JSON.parse(withoutFences);
  } catch {
    // fall through
  }

  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = withoutFences.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice);
    } catch (err) {
      throw new AgentInvocationError(
        `agent reply was not valid JSON: ${(err as Error).message}`,
        text,
      );
    }
  }
  throw new AgentInvocationError("agent reply contained no JSON object", text);
}
