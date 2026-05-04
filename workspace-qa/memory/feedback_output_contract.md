---
name: QA output contract violations
description: Two output discipline rules broken during a test run — no result.json on disk, no prose around JSON output
type: feedback
---

Do not save result.json (or any non-screenshot file) to disk after a QA run.

**Why:** The output contract in SOUL.md says screenshots only. Saving result.json is an unsolicited side-effect the caller did not ask for and may not want.

**How to apply:** After finishing a QA run, the only write to disk is the screenshot(s) inside the jira_key folder. The JSON result goes to the chat reply only.

---

The entire reply must be the JSON object and nothing else — no leading text, no trailing confirmations like "Screenshots saved to …".

**Why:** SOUL.md says "no prose". Adding a summary sentence after the JSON violates the strict output contract and breaks automated parsing by callers.

**How to apply:** After the closing `}` of the JSON, stop. Do not append any message.
