# Crashtest on neatroots

[neatroots](https://github.com/neatlogs/neatroots) at commit `4ce1faf` (2026-10-10), tested on request from
neatlogs' head of product engineering ([the ask](https://x.com/kurokotetsuyami/status/2108943094809071674)).

## What ran

- Crashtest read the repo, found two products (neatroots and its steering hook), and mapped **neatroots**:
  **581 scenarios** across 12 user journeys (219 P1 · 268 P2 · 94 P3), in under 5 minutes.
- It booted neatroots by itself on an Ubuntu server (pnpm install, builds `packages/ui` and
  `packages/neatroots`, starts `dist/cli.js start`) in about 3 minutes, and tunneled it back to a browser
  on the Mac.
- It ran the **78 P1 scenarios** of the five core journeys: send traces, browse runs and findings, manage
  checks, ask/explain/replay, and import. Result: **45 passed · 19 broken · 14 skipped**.
- Every "broken" verdict below was then checked by hand against the source, and reproduced where it could
  be. Verdicts that did not hold up are listed at the end, with what we changed in Crashtest because of them.

## Verified findings

### 1. A JSON OTLP body with a non-array `resourceSpans` is accepted and silently dropped (S-047)
- **Do:** `POST /v1/traces` with `Content-Type: application/json` and `{"resourceSpans": "oops"}`.
- **Expected:** `400` with `{"code": 3, ...}`, as the protobuf path already does for bad bytes.
- **Actual:** `200 {"partialSuccess":{}}`; nothing is stored, and the sender sees success.
- **Why:** `packages/neatroots/src/otlp/codec.ts:202` iterates `g(obj, "resourceSpans", "resource_spans") ?? []`
  without checking it is an array. A string iterates as characters, each normalises to nothing, and no error
  reaches `collector.ts`, which only returns 400 when decoding throws.
- **Fix:**
  ```diff
  -  for (const rs of g(obj, "resourceSpans", "resource_spans") ?? []) {
  +  const rss = g(obj, "resourceSpans", "resource_spans") ?? [];
  +  if (!Array.isArray(rss)) throw new Error("resourceSpans must be an array");
  +  for (const rs of rss) {
  ```

### 2. A typo in a check file only says "check: Invalid input" (S-158)
- **Do:** `neatroots checks validate typo.yaml` with a rule check whose `metric` is `total_token`
  (or `POST /api/checks` with the same body).
- **Expected:** an error that names the field, e.g. `rule.metric: Invalid enum value`.
- **Actual:** `✗ typo.yaml typo-check: check: Invalid input` (reproduced on the server).
- **Why:** `packages/neatroots/src/checks/types.ts:156` defines `AnyCheck` as a plain `z.union`. When every
  branch fails, zod reports one top-level `invalid_union` and the nested enum error is lost.
  `registry.ts:46` and `api-checks.ts:21` only print `path: message` of the top-level issues.
- **Fix:** every branch has a literal `kind`, so dispatch on it, as `QuestionCheck` two lines above already does:
  ```diff
  -export const AnyCheck = z.union([RuleCheck, YesNoQuestion, ChoiceQuestion, ScoreQuestion]);
  +export const AnyCheck = z.discriminatedUnion("kind", [RuleCheck, YesNoQuestion, ChoiceQuestion, ScoreQuestion]);
  ```

### 3. Unknown `/api/*` routes return the web app's HTML with 200 (S-301)
- **Do:** `GET /api/imports/abc` or `GET /api/anything-unknown`.
- **Expected:** `404` with a JSON error.
- **Actual:** `200 text/html` with `index.html`. Scripts, SDKs and coding agents calling the API get HTML
  and a success status instead of an error (reproduced on the server).
- **Why:** the SPA catch-all `app.get("*")` in `packages/neatroots/src/server/app.ts:86-94` serves
  `index.html` for every unmatched GET, including `/api/` and `/v1/` paths.
- **Fix:**
  ```diff
   app.get("*", (c) => {
  +  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/v1/")) return c.json({ error: "not found" }, 404);
  ```

### 4. Re-importing the same HTTP-trace file duplicates every run (S-298, S-308)
- **Do:** `neatroots import ./traces.jsonl` twice (or two at once) with Neatlogs HTTP-trace records.
- **Expected:** the second import recognises the runs it already has.
- **Actual:** each import adds new copies with new ids (20 → 22 → 24 runs). An OTLP file with fixed ids
  deduplicates correctly.
- **Why:** `packages/neatroots/src/ingest/http-trace.ts:69` and `:77` give every trace and span a fresh
  `crypto.randomBytes` id, so there is nothing to dedupe on.
- **Fix (one option):** for file imports, derive ids from the record with the existing deterministic
  `hexId` in `ingest/build.ts:60`, e.g. `hexId(JSON.stringify(record), 16)`, and keep random ids for live traffic.

### 5. With no LLM configured, Ask and Explain show a raw "fetch failed" (S-088, S-256)
- **Do:** with no reachable LLM, use Ask, or "Explain finding" on a run.
- **Actual:** `503 {"error":"fetch failed"}`; the UI toast reads "Couldn't explain this finding: fetch failed".
  Nothing says an LLM is missing or where to set one up.
- **Why:** `packages/neatroots/src/models/llm.ts:202` stores the network error text as the probe error, `:209`
  rethrows it as `LlmUnavailableError`, and `server/api.ts:239` and `:362` return `e.message` unchanged.
  (`api-models.ts:119` already distinguishes `LlmUnavailableError`.)
- **Fix:** map `LlmUnavailableError` to a message that names the cause and the fix, e.g.
  "No LLM is reachable. Set one up in Settings → Models or run `neatroots llm use <provider>`."

## Gap
- **Runs can be deleted only through the API (S-092).** `DELETE /api/runs/:traceId` exists
  (`server/api.ts:193`) and the UI has a `del()` helper, but no screen calls it; the run's More actions menu
  offers re-run checks, ask, send to cloud and download.

## What held up
Highlights from the 45 scenarios that passed:
- OTLP over HTTP JSON, gzipped protobuf and gRPC on 4317; a 70 MB body is refused with `413`.
- Loopback-only bind and the DNS-rebinding guard (403 for a foreign `Host`); no API path returns the stored
  cloud token, only `has_token`.
- `<script>` and `onerror` payloads in span names and attributes render as text; prompt-injection text in a
  span does not change findings.
- Check ids with path traversal are refused on save and delete; library checks cannot be deleted, only disabled.
- Unfinished checks resume after a `kill -9` restart; run status moves through its lifecycle live.
- Whole-run replay with a different input records the override, links the new run and leaves the original
  untouched.

## Verdicts that did not hold up, and what changed in Crashtest
| Scenario | Crashtest said | Actually | Change in Crashtest |
|---|---|---|---|
| S-051 | Host guard not enforced | Our boot agent's proxy rewrote `Host`; direct requests get 403 | The runner now gets the boot notes and tests anything a workaround changes directly against the app |
| S-084, S-092 | No findings page / no delete button is a bug | Findings live inside each run by design; delete is listed above as a gap | A feature the app never had is "skipped", not broken |
| S-261 | `spanId` ignored on replay | The API, UI and MCP tools all use `span_id` | The runner follows the app's own API contract |
| S-155, S-162, S-173, S-265, S-296, S-297, S-300 | Output or wording differs from the scenario | Expectations the scenario writer assumed | Covered by the same rules |
| S-262 | Replays readable across projects | neatroots is single-user and local; projects are not an access boundary | — |

The run also hardened Crashtest's remote runner: an SSH link that drops on a Wi-Fi change now reconnects,
remote commands are single-quoted so `$!` and `$PWD` expand on the right shell (pid files used to be empty,
so stop and teardown could not stop anything), and the runner is told which side of the tunnel each tool runs on.
