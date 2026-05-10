/**
 * Smoke test: POSTs a minimal payload to the local qa-agent-backend REST server,
 * waits for the async webhook callback, and verifies the artifact route.
 * Run AFTER `npm start` (or `docker compose up`) is up.
 *
 *   BEARER_TOKEN=... node dist/smoke.js [app_url]
 *
 * The server must have CALLBACK_URL set to point at this smoke listener
 * BEFORE it starts, e.g. CALLBACK_URL=http://127.0.0.1:3101/callback for
 * source mode, or http://host.docker.internal:3101/callback for Docker.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = process.env.PORT ?? "3100";
const SMOKE_PORT = Number(process.env.SMOKE_PORT ?? 3101);
const BEARER_TOKEN = process.env.BEARER_TOKEN;
if (!BEARER_TOKEN) {
  console.error("set BEARER_TOKEN in your env");
  process.exit(1);
}

const appUrl = process.argv[2] ?? "https://personal-XXXXXXX-dev.outsystems.app/MyApp/";

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const PATH_RE = /^[A-Z][A-Z0-9]*-\d+\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\/[A-Za-z0-9_-]+\.png$/;

interface CallbackPayload {
  status?: unknown;
  run_id?: unknown;
  jira_key?: unknown;
  client_ref?: unknown;
  results?: unknown;
  screenshots?: unknown;
  error?: unknown;
  raw?: unknown;
  total_duration_ms?: unknown;
  timestamp_start?: unknown;
  timestamp_end?: unknown;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

interface CallbackReceiver {
  waitForCallback: (timeoutMs: number) => Promise<CallbackPayload>;
  close: () => Promise<void>;
}

async function startCallbackReceiver(port: number): Promise<CallbackReceiver> {
  let resolveOnPayload: ((p: CallbackPayload) => void) | undefined;
  let rejectOnError: ((err: Error) => void) | undefined;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${BEARER_TOKEN}`) {
      res.writeHead(401).end();
      rejectOnError?.(new Error(`smoke: callback arrived without Bearer auth (got "${auth.slice(0, 16)}…")`));
      return;
    }
    const body = await readBody(req);
    res.writeHead(200, { "Content-Type": "application/json" }).end(`{"ok":true}`);
    try {
      const parsed = JSON.parse(body) as CallbackPayload;
      resolveOnPayload?.(parsed);
    } catch (err) {
      rejectOnError?.(new Error(`smoke: callback body was not JSON: ${(err as Error).message}`));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`smoke: callback receiver listening on http://127.0.0.1:${port}/callback`);

  return {
    waitForCallback: (timeoutMs) => new Promise<CallbackPayload>((resolve, reject) => {
      resolveOnPayload = resolve;
      rejectOnError = reject;
      setTimeout(
        () => reject(new Error(`smoke: callback not received within ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

async function main(): Promise<void> {
  const receiver = await startCallbackReceiver(SMOKE_PORT);

  const description = [
    "*As a* visitor, *I want* the main menu to have entries for \"Movies\" and \"People\", *so that* I can navigate between the two main sections of the app.",
    "",
    "*Acceptance Criteria:*",
    "",
    "* AC1: Given the app is loaded, When I look at the top navigation menu, Then I see menu entries labeled \"Movies\" and \"People\".",
    "* AC2: Given I am on any screen, When I click the \"Movies\" menu entry, Then I am navigated to the Movies list screen.",
    "* AC3: Given I am on any screen, When I click the \"People\" menu entry, Then I am navigated to the People list screen.",
  ].join("\n");

  const submitRes = await fetch(`http://127.0.0.1:${PORT}/test_user_story`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${BEARER_TOKEN}`,
    },
    body: JSON.stringify({
      app_url: appUrl,
      jira_key: "AQA-12",
      title: "OSMDB-002: Main menu navigates to Movies and People screens",
      description,
      auth: { required: false },
    }),
  });
  if (submitRes.status !== 202) {
    const text = await submitRes.text();
    throw new Error(`smoke: submit returned HTTP ${submitRes.status} (expected 202): ${text}`);
  }
  const submitJson = (await submitRes.json()) as { run_id?: unknown; status?: unknown };
  if (submitJson.status !== "accepted") {
    throw new Error(`smoke: submit response status was ${String(submitJson.status)}, expected "accepted"`);
  }
  if (typeof submitJson.run_id !== "string" || !RUN_ID_RE.test(submitJson.run_id)) {
    throw new Error(`smoke: submit response run_id missing or malformed: ${String(submitJson.run_id)}`);
  }
  console.log(`smoke: submit accepted, run_id=${submitJson.run_id}`);

  // Wait a bit longer than the server's AGENT_TIMEOUT_SECONDS (default 600s)
  // so we get a clear smoke-side timeout if the server itself is wedged.
  const payload = await receiver.waitForCallback(700_000);
  console.log(`smoke: callback received status=${String(payload.status)} run_id=${String(payload.run_id)}`);

  if (payload.status !== "ok") {
    throw new Error(
      `smoke: callback status=${String(payload.status)}, error=${String(payload.error)}\nraw: ${String(payload.raw ?? "")}`,
    );
  }
  if (payload.run_id !== submitJson.run_id) {
    throw new Error(`smoke: run_id mismatch: submit=${submitJson.run_id} callback=${String(payload.run_id)}`);
  }
  if (!Array.isArray(payload.screenshots) || payload.screenshots.length === 0) {
    throw new Error(`smoke: screenshots[] missing or empty`);
  }
  for (const p of payload.screenshots) {
    if (typeof p !== "string" || !PATH_RE.test(p)) {
      throw new Error(`smoke: bad screenshot path: ${String(p)}`);
    }
  }
  console.log(`smoke: screenshots=${payload.screenshots.length}`);

  // Authenticated GET against the first screenshot — proves the artifact
  // route streams real PNG bytes through the same Bearer auth.
  const firstPath = payload.screenshots[0] as string;
  const firstUrl = `http://127.0.0.1:${PORT}/artifacts/${firstPath}`;
  const fetched = await fetch(firstUrl, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  if (!fetched.ok) {
    throw new Error(`smoke: GET ${firstUrl} returned HTTP ${fetched.status}`);
  }
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
  ) {
    throw new Error(`smoke: ${firstUrl} did not return a PNG (got ${bytes.length}B, magic ${bytes.slice(0, 8).join(",")})`);
  }
  console.log(`smoke: fetched ${bytes.length}B from ${firstUrl} — PNG magic OK`);

  // Spot-check that the Bearer header is actually required.
  const noAuth = await fetch(firstUrl);
  if (noAuth.status !== 401) {
    throw new Error(`smoke: artifact route returned ${noAuth.status} without auth (expected 401)`);
  }
  console.log(`smoke: artifact route correctly returned 401 without Bearer`);

  await receiver.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
