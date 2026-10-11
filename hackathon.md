# neatHack build log — Crashtest

## Project
**Crashtest** — a macOS app whose autonomous agent maps every user scenario an app can produce from its own code, then runs each one for real and reports what breaks.

Problem: most bugs users hit are not in untested code, they are in paths nobody walked (reject instead of approve, the empty account, the second tab, the expired session).

## Team
- Emre Ozyoruk ([@kurokotetsuyami](https://x.com/kurokotetsuyami)) — team Lovie, solo

## Stack
- Electron + React + TypeScript (electron-vite)
- Claude Agent SDK (Sonnet 5.5 for inventory / bootstrap / sweep), Anthropic SDK (Haiku 5.5 for scenario generation)
- neatlogs — tracing the agent (SDK) and our own build sessions (Claude Code plugin)
- Entire — checkpoints on every commit (git-branch backend), entire-graph, Entire Brain
- cfo.ai — business plan (pricing, costs, revenue, runway)

## Build log
### 2026-10-10 (Sat) — 00:05 PDT
- Hackathon started. Scaffolded the Electron + React + TS app; created public repo.
- Pre-start setup (config only, no code): neatlogs project + Claude Code plugin + MCP, Entire CLI with Claude Code hooks, entire-graph, Entire Brain, cfo.ai MCP, AWS allocation for the VDS demo.

### 2026-10-10 (Sat) — 00:15–01:00 PDT
- Agent backend: GitHub intake (public link or PAT), monorepo product grouping (Haiku), inventory agent (Sonnet, read-only tools, structured JSON), parallel scenario writer (Haiku, per journey, deduped), project chat with tools (store .env values / VDS credentials encrypted, start runs).
- Run pipeline: one MCP tool set (`shell`, `start_background`, `read_log`, `expose_port`, `http_get`) over two runtimes — this Mac, or the user's server over SSH with port tunnels — so the bootstrap and sweep agents don't care where the app runs. Sweep uses Playwright MCP; the app is restarted automatically if it stops answering.
- neatlogs: every phase is its own workflow (`repo-inventory`, `scenario-generation`, `app-bootstrap`, `scenario-sweep`, `app-recovery`, `project-chat`), grouped per project with `sessionId`; Claude Agent SDK and Anthropic SDK wrapped.
- UI: chat with live tool activity and choice buttons, scenarios grouped by journey with P1–P3 filters, finding panel with root cause + diff, settings with Keychain-backed secrets and a VDS connection test.
- Incident: an Entire checkpoint of this session captured AWS credentials pasted earlier in the chat. Caught locally before any push; rolled back, disabled automatic checkpoint pushes and added custom redaction rules. Checkpoints are now scanned before every push.

### 2026-10-10 (Sat) — 00:25 PDT — first end-to-end analysis
- Ran the built app (driven by Playwright's Electron runner) on `TonyMckes/conduit-realworld-example-app`: clone → product grouping (frontend + backend correctly treated as one product, no question asked) → inventory (38 surfaces, 5 journeys) → **188 scenarios** (78 P1 · 79 P2 · 31 P3, 5 not runnable locally) in 103 s total.
- neatlogs showed the inventory agent trying `Bash(cat package.json)` and getting denied (1 errored span, $0.46). Fix: the prompt now states the agent only has read tools, and the agent gets Entire Graph tools. Baseline kept in [docs/evidence/neatlogs-baselines.md](docs/evidence/neatlogs-baselines.md) for the before/after comparison.

### 2026-10-10 (Sat) — 00:30 PDT — first real run
- Selected 5 of the 188 scenarios, pressed Start, chose **Local**. The bootstrap agent booted Conduit from scratch (local Postgres, generated `.env`, API + Vite with strict ports) and noticed `DEV_DB_LOGGING="false"` crashes Sequelize.
- Result: **3 passed, 2 broken** in 151 s. Both bugs are real, with file:line root causes and diffs — see [docs/evidence/findings-conduit.md](docs/evidence/findings-conduit.md):
  - S-118: a comment can be deleted through any article's URL (`comments.js` ignores the slug).
  - S-125: users can follow themselves (`profiles.js` never compares ids).
- Failure noticed: the Postgres the agent started as a daemon outlived the run. Fix: the bootstrap contract now requires foreground services via `start_background` with data under `.crashtest/`, plus explicit `cleanup` commands that Crashtest always runs at the end.

### 2026-10-10 (Sat) — 00:35–00:51 PDT — neatlogs loop and VDS
- neatlogs before/after on the inventory agent (3 traces): a prompt instruction did not stop it reaching for a denied Bash tool; offering only the allowed built-in tools did — errored spans 1 → 0, surfaces 38 → 47, scenarios 188 → 245 (cost ~2×). Details: [docs/evidence/neatlogs-baselines.md](docs/evidence/neatlogs-baselines.md).
- Created two neatlogs detections in a "Crashtest agent" group: **Bug found by Crashtest** and **Unverified verdict**. The second flagged S-125, where the runner faked auth via localStorage and could not check the UI. After making the runner sign in through the app's form, the re-run checked UI and API separately and the detection no longer fires.
- Fixed by running it: services leaking after quit, projects stuck as busy after a restart.
- **VDS mode works end to end** on a t3.small EC2 (neatHack AWS credits, SSH only from our IP): Settings → Test connection ✅ → Start → VDS. Crashtest cloned Conduit on the server, booted Postgres + API there, tunnelled the app back to the browser on the Mac and ran S-001 ✅ and S-118 ❌ (same bug reproduced remotely). Nothing left running on the server afterwards.

### 2026-10-10 (Sat) — 01:00–01:10 PDT — Entire checkpoints live
- First clean checkpoint from a fresh session: [`97c75579b386`](https://entire.io/gh/emreozyoruk/crashtest/commit/74641efd901999e96d69fd85f69dde70f3aa0a62) on commit `74641ef`. Scanned against every known secret before pushing `entire/checkpoints/v1` (only harmless matches: a regex pattern and an env var name). Repo mirrored on Entire: https://entire.io/gh/emreozyoruk/crashtest
- Entire evidence in [docs/entire/](docs/entire/README.md): graph snapshot of Crashtest (70 files, 723 symbols, 1,837 relations) and `entire graph stats` over our build sessions.

### 2026-10-10 (Sat) — 01:05–01:25 PDT — cfo.ai business plan
- Built the plan in cfo.ai through its MCP server: [read-only link](https://app.cfo.ai/s/--rWFPOxuMvaL0nN). Pricing Pro $29 (bring your own key) / Cloud $299 (we run it). Unit costs come from our own neatlogs traces: **$0.117 per scenario run** (mean of 8 sweeps), **$0.815 per repo inventory**.
- Customers → revenue → P&L → cash, monthly to Dec 2028, with Upside and Downside scenarios. Gross margin ~79%. Base: cash bottoms at $7.7k in Mar 2028 and turns cash-flow positive in Apr 2028.
- The model changed a decision: in Downside, hiring the first engineer at month 6 runs out of cash in Nov 2027; hiring at month 18 keeps $51k. So the hire is gated on MRR, not the calendar. Details: [docs/cfoai/](docs/cfoai/README.md).
- Cleanup: fixed the two eslint errors (effect setState, non-component export) and formatted `src` with the repo's prettier config — eslint and typecheck are clean.

### 2026-10-10 (Sat) — 01:20–01:27 PDT — failure and recovery: one bad draft sank an analysis
- A fresh analysis of Conduit (new user data, latest build) wrote 250 scenarios and then failed: `Cannot read properties of undefined (reading 'replace')`.
- Root cause: the scenario model (Haiku) returned one draft without its `expected` field. The JSON schema asks for it, but the API does not enforce it, and `SCENARIOS.md` generation called `.replace` on it. The crash happened after the traced `scenario-generation` workflow returned, so neatlogs showed that trace (`8e3ab8e1…`) as a success — the failure lived in our own code, outside the span.
- Fix: every draft is validated. Drafts without a title or an expected result are dropped; the other fields get safe defaults. Re-run on the same repo: **294 scenarios across 9 journeys (114 P1 · 128 P2 · 52 P3) in 143 s**, no error.

### 2026-10-10 (Sat) — 01:26–02:18 PDT — every P1 scenario on Conduit
- All 114 P1 scenarios in one run, app booted from scratch by the agent: **✅ 80 · ❌ 33 · ⏭ 1 in 52 minutes.**
- Worst finding, checked by hand in the source: saving settings with a blank password replaces the user's password (`controllers/user.js:36`, `||` where `&&` was meant). Also: any bad or expired token → 500 instead of 401, tokens never expire or get revoked, duplicate usernames accepted.
- Many ❌ shared one defect (nine bad-token scenarios, one auth middleware). New feature from that: the run summary groups broken scenarios by the file their root cause names (33 → 12 files) and Crashtest writes a `FINDINGS.md` report with every diff. Verified with a 3-scenario run in the built app.

### 2026-10-10 (Sat) — 02:21–03:48 PDT — the rest of the scenarios, and two bugs in Crashtest
- Ran the 180 P2 and P3 scenarios too. **All 294 scenarios now have a verdict: ✅ 180 · ❌ 104 · ⏭ 10, tracing back to 34 files.** Report: [docs/evidence/findings-conduit-all.md](docs/evidence/findings-conduit-all.md).
- **Failure 1 — unsafe shell.** Scenario S-286 ("start the backend with the database unreachable") had the agent run `pkill -f "node index.js" -n` on the Mac. It only hit its own process, but a name-matched kill could hit anything. Fix: `shell` and `start_background` refuse `pkill`, `killall`, `kill -1`, `shutdown`/`reboot`/`halt`, `launchctl`, `osascript`; a new `stop_background` tool stops a process the agent started, by name, locally and over SSH.
- **Failure 2 — lost window.** 72 minutes in, the Crashtest window's renderer died ("Page crashed") and the run went with it. The window now reloads itself on `render-process-gone`; runs live in the main process and projects are re-read from the store. Verified by crashing the renderer on purpose: it came back with the project intact.
- **Recovery:** the 9 scenarios cut short were re-run on the fixed build. S-286 used `stop_background` this time — no `pkill`.
- neatlogs: added **Server error in app under test** and **Auth or account bug found** detections; with the existing two they now count 39 / 57 / 108 bugs and 21 unverified verdicts (~7%) across these runs.
- Second app: kutt (URL shortener) → 50 surfaces, **359 scenarios across 11 journeys** in 144 s on the same build.

### 2026-10-10 (Sat) — 03:48–05:35 PDT — a second app: kutt
- All 141 P1 scenarios on kutt (URL shortener, SQLite), app booted by the agent: **✅ 97 · ❌ 31 · ⏭ 13 → 15 files**, 104 minutes. Worst: deleting a domain "without its links" deletes them all (`"false"` is truthy after the checkbox sanitizer) — checked by hand. Also a race that creates two admins on a fresh install, and `data:`/`javascript:` link targets accepted. [docs/evidence/findings-kutt.md](docs/evidence/findings-kutt.md)
- **An overstated verdict, caught and fixed.** "Expired links still redirect" ignored kutt's 30 s cleanup cron. New runner rule: find the job behind time-based behavior and report a delay as a delay. Re-run: the verdict now cites `server/cron.js` and the real window (up to 30 s; 15 min with the Redis cache).
- Decided against shipping a `.dmg` this weekend: unsigned builds hit Gatekeeper, and the SDK and Playwright binaries would have to come out of the asar. README keeps "run from source".

### 2026-10-10 (Sat) — 08:30–11:40 PDT — neatlogs asked us to run it on neatroots
- neatlogs' head of product engineering replied to our day-1 post: *"run this on neatroots, & share your findings with me"*.
- Crashtest mapped [neatroots](https://github.com/neatlogs/neatroots) into **581 scenarios across 12 journeys** in under 5 minutes, booted it on the EC2 server (pnpm install, two builds, ~3 min) and ran the **78 core P1 scenarios: ✅ 56 · ❌ 16 · ⏭ 6** (after a second pass with neatroots' mock LLM). Every broken verdict was checked by hand: **5 real bugs and 1 gap**, each with repro, `file:line` and a suggested diff. [docs/evidence/findings-neatroots.md](docs/evidence/findings-neatroots.md)
- **What the run taught Crashtest** (each one a commit, each re-verified):
  - The Wi-Fi changed mid-run and the SSH link died. The SSH runtime now sends keepalives, reconnects on the next call, and retries the first connection on network errors (a bad key still fails at once). Tested by killing every SSH session on the server mid-run.
  - Remote commands were double-quoted, so the login shell expanded `$!` and `$PWD` first: pid files were empty and teardown could not stop anything. Single-quoted now; a real run then left zero processes behind.
  - The boot agent listed `pkill -f 'node index.js'` as cleanup, which teardown ran unchecked. Cleanup now passes the same shell guard.
  - False positives, each turned into a runner rule: a proxy that rewrote `Host` made a working DNS-rebinding guard look broken (the runner now gets the boot notes and tests workarounds directly); a findings page and a `spanId` field the app never had were called bugs (absent features and API shapes are now "skipped"); the runner curled the Mac-side tunnel from the server shell (the prompt now says which side each tool is on). Re-run: S-051 passes and S-084 is skipped, as they should be.
  - New: **setup notes from chat**. The user can tell the boot agent how to set the app up; we used it to start neatroots' mock LLM so Ask, Explain and Replay could be tested without keys.
  - A product choice made before a restart did nothing (pending questions live in memory). It now resumes the analysis.
- The EC2 instance was stopped from outside mid-run (API stop, not from inside the VM). Restarted it; new IP.

### 2026-10-10 (Sat) — 11:40–19:00 PDT — all 581 neatroots scenarios
- Ran the remaining 503 scenarios on Haiku, three at a time on the VDS, then the five that ran out of steps on Sonnet.
  **All 581: ✅ 316 · ❌ 158 · ⏭ 107, 0 left. 21 bugs verified by hand** — [docs/evidence/findings-neatroots.md](docs/evidence/findings-neatroots.md).
- Built during the run, each tested before it shipped: parallel workers; Auto parallelism (reads the server's free
  memory and says why it picked a number — "2 cores and 1.0 GB free… 2 at once" in the final run); a 15-minute limit
  per scenario; stopping leftovers from an earlier run (pid files, only inside the app folder) and from each
  scenario (an env tag, Linux); an isolated HOME for local runs; runner model choice (Sonnet/Haiku); setup notes;
  steps-exhausted counted as skipped.
- Kept the run alive through an outside stop of the EC2 instance (twice), a detached Elastic IP, a VPN that rotated our
  IP, and memory spikes from neatroots itself (a 1.3 GB app copy, two Laya servers from one double-click — bug 16).
- Live page for the run: http://34.238.91.131:8080.

## Building in public
- 2026-10-09 announcement: https://x.com/kurokotetsuyami/status/2108778646320390337
- 2026-10-10 full Conduit run (294 scenarios, 104 broken in 34 files): https://x.com/kurokotetsuyami/status/2108943094809071674
- 2026-10-10 neatlogs caught our agent running `pkill` (and hiding it in its cleanup list); both closed: https://x.com/kurokotetsuyami/status/2108967648575066113
- 2026-10-10 live page of Crashtest testing neatroots: http://34.238.91.131:8080
- 2026-10-10 cfo.ai business plan, unit costs from neatlogs traces: https://x.com/kurokotetsuyami/status/2109037159063953484

## Demo
Pending.

## Known limitations and next steps
Pending.

## Submission
- [x] Public repo with commits dated during the hackathon
- [ ] Demo video ≤ 3 min covering neatlogs, Entire and cfo.ai
- [x] neatlogs evidence (before/after traces, failure recovery run)
- [x] Entire checkpoint link + ID — [`97c75579b386`](https://entire.io/gh/emreozyoruk/crashtest/commit/74641efd901999e96d69fd85f69dde70f3aa0a62)
- [x] cfo.ai business plan — https://app.cfo.ai/s/--rWFPOxuMvaL0nN
- [ ] Quote post of the official neatlogs submission post (Mon Oct 12, 06:30–11:25 PDT)
