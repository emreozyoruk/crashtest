# Demo video script (≤ 3:00)

Screen recording with voice-over. Every shot below already exists or is one click away.

| Time | Shot | Voice-over |
|---|---|---|
| 0:00–0:15 | Crashtest window, empty chat | "Most bugs that reach users live in paths nobody walked. Crashtest is a Mac app with an agent that walks all of them for you." |
| 0:15–0:40 | Paste `github.com/TonyMckes/conduit-realworld-example-app`, agent clones, groups frontend + backend as one product, maps the code | "Give it a repo. It reads the code, not the docs: 39 surfaces across 9 user journeys, then writes every scenario a user could live through — 294 here, ranked P1 to P3, in under two and a half minutes." |
| 0:40–1:10 | Scenarios tab → select P1 → Start → "Local or your server?" → Local. Chat shows the bootstrap agent booting Postgres, the API and the frontend | "Press Start and it boots the app itself — database, env file, API and frontend — on this Mac or on your own server over SSH." |
| 1:10–1:40 | Sweep running, then the Scenarios tab (180 ✅ / 104 ❌), open S-239 → finding panel: root cause `controllers/user.js:36`, suggested diff; then FINDINGS.md grouped by file | "Each scenario runs in a real browser or against the API. All 294 ran: 104 broke, and they trace back to 34 files. The worst: saving your settings with a blank password silently replaces your password — one `||` that should be `&&`. You get the screenshot, the line and the fix." |
| 1:40–2:10 | **neatlogs**: the `repo-inventory` traces before/after, then the four detections in the "Crashtest agent" group with their counts | "Every phase is traced in neatlogs. The traces showed our inventory agent reaching for a tool it was denied; scoping its tools took errored spans from 1 to 0 and found 24% more surfaces. Four detections now flag every bug, every auth bug, every server error in the app under test, and every verdict the agent could not fully verify." |
| 2:10–2:30 | **Entire**: entire.io commit page with checkpoint `97c75579b386`, then `src/main/agent/graphTools.ts` | "Every commit carries an Entire checkpoint of the session that wrote it. And Entire Graph runs inside the product: the agents get search, callers and blast radius over the repo under test." |
| 2:30–2:50 | **cfo.ai**: the business plan page, cash chart, Downside scenario | "The business plan lives in cfo.ai, with unit costs taken straight from our neatlogs traces: 12 cents a scenario run. It told us the first engineer hire decides our runway." |
| 2:50–3:00 | README hero line | "Crashtest. Find the bugs your users would hit, before they hit them." |

Links to show on screen:
- Repo: https://github.com/emreozyoruk/crashtest
- Entire: https://entire.io/gh/emreozyoruk/crashtest
- cfo.ai: https://app.cfo.ai/s/--rWFPOxuMvaL0nN
