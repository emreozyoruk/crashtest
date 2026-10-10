# Crashtest on neatroots

[neatroots](https://github.com/neatlogs/neatroots) at commit `4ce1faf` (2026-10-10), tested on request from
neatlogs' head of product engineering ([the ask](https://x.com/kurokotetsuyami/status/2108943094809071674)).

![Summary](neatroots-findings.png)

## What ran

- Crashtest read the repo, found two products (neatroots and its steering hook), and mapped **neatroots**:
  **581 scenarios** across 12 user journeys (219 P1 · 268 P2 · 94 P3), in under 5 minutes.
- It booted neatroots by itself on an Ubuntu server (pnpm install, builds `packages/ui` and
  `packages/neatroots`, starts `dist/cli.js start`) in about 3 minutes, and tunneled it back to a browser
  on the Mac.
- It ran the **78 P1 scenarios** of the five core journeys: send traces, browse runs and findings, manage
  checks, ask/explain/replay, and import. First pass: 45 passed · 19 broken · 14 skipped.
- Most skips needed an LLM. A second pass of 16 scenarios started neatroots' own mock LLM (given to Crashtest
  as a setup note in chat) and ran on the fixed runner below: 11 passed · 0 broken · 5 skipped.
  **Final: 56 passed · 16 broken · 6 skipped.** Of the 16 broken, 7 are bugs 1–5 below, 1 is the gap, and
  8 are expectations the scenario writer assumed (listed at the end).
- Every "broken" verdict below was then checked by hand against the source, and reproduced where it could
  be. Verdicts that did not hold up are listed at the end, with what we changed in Crashtest because of them.

## Verified findings

Bugs 1–5 come from the 78 core scenarios; bugs 6–11 from the run of the remaining scenarios, which is still going.

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

### 5. With no LLM configured, Ask, Explain and Draft check show a raw "fetch failed" (S-088, S-256, S-115, S-195)
- **Do:** with no reachable LLM, use Ask, or "Explain finding" on a run.
- **Actual:** `503 {"error":"fetch failed"}`; the UI toast reads "Couldn't explain this finding: fetch failed".
  Nothing says an LLM is missing or where to set one up.
- **Why:** `packages/neatroots/src/models/llm.ts:202` stores the network error text as the probe error, `:209`
  rethrows it as `LlmUnavailableError`, and `server/api.ts:239` and `:362` return `e.message` unchanged.
  (`api-models.ts:119` already distinguishes `LlmUnavailableError`.)
- **Fix:** map `LlmUnavailableError` to a message that names the cause and the fix, e.g.
  "No LLM is reachable. Set one up in Settings → Models or run `neatroots llm use <provider>`."

### 6. `retention.days: 0` in `config.yaml` deletes every unpinned run on start (S-014)
- **Do:** set `retention: { days: 0 }` in `config.yaml` and run `neatroots start`.
- **Expected:** 0 is refused (or treated as "keep forever"), as the settings API already does.
- **Actual:** the startup sweep deleted all 8 unpinned runs, including ones from hours ago, and repeats every hour.
- **Why:** `PATCH /api/settings` only accepts `retention_days` between 1 and 3650 (`server/api.ts:281`), but values
  from `config.yaml` are deep-merged with no range check (`config.ts`), and `store/db.ts:1151` turns 0 days into a
  cutoff of *now*. `core.ts:90-94` runs the sweep at startup and hourly.
- **Fix:** apply the same 1–3650 check when the config is loaded, and skip the age sweep when `days < 1`.

### 7. `neatroots init` with a bad `--steering` writes files, then fails (S-006, S-024)
- **Do:** `neatroots init --steering gate` (no `--project`), or `neatroots init --project demo --steering turbo`.
- **Expected:** refused before anything is written.
- **Actual:** exits 1, but has already created `.neatroots/checks/` and `.neatroots/README.md`, rewritten `.env`
  when `--write-env` is passed, and printed `✓ checks folder … (registered with neatroots)`, which is not true:
  the config is never saved.
- **Why:** `packages/neatroots/src/cli.ts:119-145` writes the folder, README and `.env` before the steering checks
  at `cli.ts:146-155`.
- **Fix:** validate `--steering` and `--project` at the top of the `init` action, before any write.

### 8. A `match` check's regex can freeze the whole server, and a bad one fails silently (S-194, S-193)
- **Do:** save a `match` check with a catastrophic pattern such as `(a+)+$`, then preview it or send a span with a
  long run of `a`s followed by `!`. Separately, save one with an invalid pattern such as `(`.
- **Actual:** the first evaluation took 33 s on a 30-character input and blocked every request meanwhile (the health
  check timed out), including the collector. The invalid pattern is saved, previews as "0 hits, no warnings", and
  never fires.
- **Why:** `packages/neatroots/src/checks/rules.ts:107-114` compiles the user's pattern and calls `re.test()`
  synchronously for every span with no time limit; `previewCheck` (`engine/engine.ts:1041-1052`) only checks its
  deadline between runs. An invalid pattern hits the `catch { return null }` at `rules.ts:108-110`, and
  `checks/types.ts:88` accepts any string as `pattern`.
- **Fix:** validate patterns when a check is saved (compile them, and reject nested quantifiers or use a linear-time
  engine such as RE2), and run rule evaluation off the request path with a time budget.

### 9. `GET /api/runs?limit=abc` answers 500; `limit=-5` returns every run (S-106)
- **Why:** `server/api.ts:171` passes `Number(q.limit)` straight through; `Number("abc")` is `NaN`, and
  `Math.min(NaN, 500)` in `store/db.ts:689` stays `NaN`, so SQLite throws. A negative limit reaches `LIMIT` and SQLite
  treats it as no limit.
- **Fix:** parse `limit`/`offset` as integers, clamp to 1–500 and ≥ 0, and answer 400 for anything else.

### 10. The runs list shows the newest 150 runs and no way to reach the rest (S-108)
- **Do:** ingest more than 150 runs and open Runs.
- **Actual:** the header reads "of 320 runs", but only 150 rows render and there is no pager or "load more"; the older
  170 runs cannot be opened from the list.
- **Why:** `packages/ui/src/features/runs/_services/run-queries.ts:9` always requests `limit=150` and never sends
  `offset`. The API already pages correctly.
- **Fix:** page with `offset` (or infinite scroll) in `useRuns` and the runs page.

### 11. A choice check can flag an option that does not exist (S-202)
- **Do:** save a `choice` check whose `flag_on` lists a key that is not in `options`.
- **Actual:** saved with `200` and no warning; it can never fire.
- **Why:** `checks/types.ts:132-141` types `flag_on` as any non-empty string array, with no check against `options`.
- **Fix:** a `superRefine` that every `flag_on` entry is a key of `options`.

## Gap
- **Runs can be deleted only through the API (S-092).** `DELETE /api/runs/:traceId` exists
  (`server/api.ts:193`) and the UI has a `del()` helper, but no screen calls it; the run's More actions menu
  offers re-run checks, ask, send to cloud and download.

## What held up
Highlights from the 56 scenarios that passed:
- OTLP over HTTP JSON, gzipped protobuf and gRPC on 4317; a 70 MB body is refused with `413`.
- Loopback-only bind and the DNS-rebinding guard (403 for a foreign `Host`); no API path returns the stored
  cloud token, only `has_token`.
- `<script>` and `onerror` payloads in span names and attributes render as text; prompt-injection text in a
  span does not change findings.
- Check ids with path traversal are refused on save and delete; library checks cannot be deleted, only disabled.
- Unfinished checks resume after a `kill -9` restart; run status moves through its lifecycle live.
- Whole-run replay with a different input records the override, links the new run and leaves the original
  untouched; replaying one LLM span (`span_id`) creates a linked replay of just that call.
- 50 parallel OTLP exports, all stored with the right span counts.
- With the mock LLM: Explain finding and Explain run return a cause, a fix and evidence spans; prompt-injection
  text in tool outputs does not leak into Ask answers or check drafts. Dismissing a finding expires its pending note.
- Not reachable from another host on the network (no answer on the LAN IP), so checks cannot be saved or deleted remotely.

## Verdicts that did not hold up, and what changed in Crashtest
| Scenario | Crashtest said | Actually | Change in Crashtest |
|---|---|---|---|
| S-051 | Host guard not enforced | Our boot agent's proxy rewrote `Host`; direct requests get 403 | The runner now gets the boot notes and tests anything a workaround changes directly against the app. **Re-run: passed** (curl straight to 4100) |
| S-084, S-092 | No findings page / no delete button is a bug | Findings live inside each run by design; delete is listed above as a gap | A feature the app never had is "skipped", not broken. **Re-run of S-084: skipped** ("the app has no findings view") |
| S-261 | `spanId` ignored on replay | The API, UI and MCP tools all use `span_id` | The runner follows the app's own API contract. **Re-run: passed** with `span_id` |
| S-155, S-162, S-173, S-265, S-296, S-297, S-300 | Output or wording differs from the scenario | Expectations the scenario writer assumed | Covered by the same rules |
| S-262 | Replays readable across projects | neatroots is single-user and local; projects are not an access boundary | — |

The run also hardened Crashtest's remote runner: an SSH link that drops on a Wi-Fi change now reconnects,
remote commands are single-quoted so `$!` and `$PWD` expand on the right shell (pid files used to be empty,
so stop and teardown could not stop anything), and the runner is told which side of the tunnel each tool runs on.
