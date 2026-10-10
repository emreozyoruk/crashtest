# Demo video script (≤ 3:00)

Screen recording with voice-over. Every shot below already exists or is one click away.

| Time | Shot | Voice-over |
|---|---|---|
| 0:00–0:15 | X: our day-1 post, then the reply from neatlogs' head of product engineering, *"run this on neatroots, & share your findings with me"* | "Yesterday neatlogs' head of engineering asked us to run Crashtest on their own product, neatroots. So we did." |
| 0:15–0:40 | Crashtest window: paste `github.com/neatlogs/neatroots` → it finds two products and asks which one → Scenarios tab with 581 scenarios across 12 journeys, P1–P3 | "Crashtest is a Mac app with an agent that reads a repo, not its docs. It mapped neatroots into 581 scenarios across 12 user journeys in under five minutes: every way a user could use it, ranked by how much it matters." |
| 0:40–1:05 | Chat: "Getting the app running on ubuntu@…", the boot notes, then *"Your server has 2 cores and 1.4 GB free… Running 3 at once"* | "Press Start and it boots the app by itself on your Mac or your own server: installs, builds, starts it, even a mock LLM when you tell it to. Then it measures the machine and runs as many scenarios at once as it can hold." |
| 1:05–1:25 | Live page http://34.238.91.131:8080: three yellow sparks, dots turning green and red, "Being tested right now" with steps, the agent's browser screenshot | "Each scenario runs in a real browser or against the API. You can watch it live: every dot is a scenario, the sparks are the ones being tried right now." |
| 1:25–1:55 | `docs/evidence/findings-neatroots.md`: bug 12 (steering off still halts the agent), bug 8 (one regex freezes the server for 33 s), bug 6 (`retention.days: 0` deletes every run), each with `file:line` and a one-line fix | "It found thirteen real bugs in neatroots, each checked by hand against the source. Turning steering off doesn't stop a halt note from stopping your agent. One bad regex in a check freezes the whole server for 33 seconds. And `retention.days: 0` deletes every run on startup. Every one comes with the line and the fix." |
| 1:55–2:15 | **neatlogs**: `scenario-sweep` traces, a trace opened step by step, the four detections ("Bug found by Crashtest" tag on a row) | "Every scenario is traced in neatlogs, and our detections flag every bug and every verdict the agent couldn't fully check. The traces also caught our own agent running `pkill` on my Mac — now refused, with a safe tool instead." |
| 2:15–2:30 | **Entire**: entire.io repo page (commits from Claude Code sessions), a checkpoint, then `src/main/agent/graphTools.ts` | "Every commit carries an Entire checkpoint of the session that wrote it, and Entire Graph runs inside the product: the runner asks it for the handler, callers and blast radius before writing a fix." |
| 2:30–2:45 | **cfo.ai**: business plan, cash chart, Downside | "The business plan lives in cfo.ai, with costs from our neatlogs traces: 12 cents a scenario. Its verdict: hiring our first engineer decides our runway, not growth." |
| 2:45–3:00 | README: Conduit 294 scenarios → 104 broken in 34 files; kutt 141 → 31; neatroots 581 → 13 verified bugs | "Three apps, over a thousand scenarios. Crashtest: find the bugs your users would hit, before they hit them." |

Recording tips:
- Open the Crashtest app with the neatroots project data (Claude prepares a copy once the run is done), or the Conduit copy: `cd ~/Desktop/project/hackaton && npx electron . --user-data-dir=$HOME/crashtest-demo/conduit`.
- Have these tabs ready: the X thread, the live page, the neatroots report on GitHub, neatlogs Traces and Detections, entire.io/gh/emreozyoruk/crashtest, the cfo.ai plan.
- Record with Cmd+Shift+5, voice on. Trim to 3:00 in QuickTime (Cmd+T).

Links to show on screen:
- Repo: https://github.com/emreozyoruk/crashtest
- Live page: http://34.238.91.131:8080
- neatroots report: https://github.com/emreozyoruk/crashtest/blob/main/docs/evidence/findings-neatroots.md
- Entire: https://entire.io/gh/emreozyoruk/crashtest
- cfo.ai: https://app.cfo.ai/s/--rWFPOxuMvaL0nN
