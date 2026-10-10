# neatlogs measurements

Each row is a real trace in the Crashtest neatlogs project (trace ids are the neatlogs ids).

## repo-inventory on TonyMckes/conduit-realworld-example-app

| Run | When (UTC) | Trace | Status | Duration | Cost | Spans | Errored | Surfaces → scenarios |
|---|---|---|---|---|---|---|---|---|
| 1. Baseline: Read/Grep/Glob allowed, everything else denied on use | 07:23 | `e3580b85b3fa43ef0d6f82bbe18bf8be` | error | 55.3 s | $0.461 | 42 | 1 | 38 → 188 |
| 2. Prompt says "there is no shell" | 07:31 | `8a0ec2026b9fdaa9746c992bac65e567` | error | 55.4 s | $0.414 | 42 | 1 | 36 → 237 |
| 3. Only the allowed built-in tools are offered (`tools:`), MCP tools load up front | 07:36 | `ba2cc6ee7172b0dbd17c6834a501940a` | success | 75.7 s | $0.815 | 72 | 0 | 47 → 245 |

What the traces showed:
- In run 1 the errored span is a `Bash` TOOL span: the agent tried `cat package.json` and the SDK denied it.
- Run 2 proves a prompt instruction is not enough: the agent still reached for Bash because the tool was still in its tool list.
- Run 3 removes non-allowed built-ins from the model's context. Errored spans went to 0, and the agent spent the extra turns reading routes, the error handler, auth context and pagination, mapping **47 surfaces instead of 38 (+24%)** and **245 scenarios instead of 188 (+30%)** — at roughly 2× the cost.
- Entire Graph tools were available in run 3 but the agent preferred direct reads on this small repo (141 files).

## Detections created in neatlogs (group "Crashtest agent")
- **Bug found by Crashtest** — regex on `scenario-sweep` output (`Status: broken`). Backfill flagged S-118 and S-125.
- **Unverified verdict** — regex on `scenario-sweep` output for admissions like "could not check" / "may have come from". It flagged S-125, where the runner wrote a token into localStorage, got a blank profile page and could not check the UI. Fix: the runner must sign in through the app's form and read console/network errors before judging a blank page.
