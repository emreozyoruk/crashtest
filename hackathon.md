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

## Building in public
- 2026-10-09 announcement: https://x.com/kurokotetsuyami/status/2108778646320390337

## Demo
Pending.

## Known limitations and next steps
Pending.

## Submission
- [ ] Public repo with commits dated during the hackathon
- [ ] Demo video ≤ 3 min covering neatlogs, Entire and cfo.ai
- [ ] neatlogs evidence (before/after traces, failure recovery run)
- [ ] Entire checkpoint link + ID
- [ ] cfo.ai business plan
- [ ] Quote post of the official neatlogs submission post (Mon Oct 12, 06:30–11:25 PDT)
