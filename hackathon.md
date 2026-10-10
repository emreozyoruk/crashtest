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
