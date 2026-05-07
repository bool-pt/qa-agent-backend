import type { ObservationResult } from "./invokeAgent.js";

// Discriminated union: `status` tells the consumer how to read the rest.
// On success the shape is the existing ObservationResult flattened in;
// on error only `run_id` + `jira_key` + `error` (and optional `raw`) are set.
export type WebhookPayload =
  | ({ status: "ok"; jira_key: string; client_ref?: number | string } & ObservationResult)
  | {
      status: "error";
      run_id: string;
      jira_key: string;
      client_ref?: number | string;
      error: string;
      raw?: string;
    };

export interface PostCallbackOptions {
  url: string;
  token: string;
  timeoutMs: number;
}

const USER_AGENT = "qa-agent-backend/0.1.0";

/**
 * Best-effort webhook delivery. One POST attempt with an AbortController
 * timeout. On any failure (network error, non-2xx, timeout) the full payload
 * is logged at ERROR level so it can be recovered manually from the server
 * logs. Never throws — callers don't need to handle delivery failure
 * (the run already finished, the only thing left is telling someone).
 */
export async function postCallback(
  payload: WebhookPayload,
  opts: PostCallbackOptions,
): Promise<void> {
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.token}`,
        "User-Agent": USER_AGENT,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = (err as { name?: string }).name === "AbortError"
      ? `timed out after ${opts.timeoutMs}ms`
      : (err as Error).message;
    logFailure(payload, opts.url, reason, body);
    return;
  }
  clearTimeout(timer);

  if (res.ok) {
    console.log(
      `[webhook] delivered run_id=${payload.run_id} status=${payload.status} → HTTP ${res.status}`,
    );
    console.log(`[webhook] full payload (sent to ODC):\n${body}`);
    return;
  }

  // Non-2xx: try to read the body for context (best-effort, tiny preview).
  let text = "";
  try { text = await res.text(); } catch { /* ignore */ }
  logFailure(payload, opts.url, `HTTP ${res.status}: ${text.slice(0, 300)}`, body);
}

function logFailure(
  payload: WebhookPayload,
  url: string,
  reason: string,
  body: string,
): void {
  console.error(
    `[webhook] delivery FAILED to ${url}: ${reason}`,
  );
  console.error(
    `[webhook] payload run_id=${payload.run_id} status=${payload.status} jira_key=${payload.jira_key}`,
  );
  // Full payload last so it's the line you grep for to recover.
  console.error(`[webhook] full payload (recover from logs):\n${body}`);
}
