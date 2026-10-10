# Entire evidence

How Crashtest uses [Entire](https://entire.io), with raw command output next to this file.

## 1. Entire Graph inside the product

The inventory and sweep agents get four MCP tools backed by `entire graph`
(`src/main/agent/graphTools.ts`): `search`, `definition`, `neighbors` (callers/callees)
and `impact` (blast radius). The graph indexes any git repo locally, so it works on the
repo under test even when that repo never used Entire. When the CLI is missing the tools
are simply not offered.

## 2. Entire Graph on Crashtest itself

`entire graph snapshot --repo .` at commit `60a3b49`:

| Records | Count |
|---|---|
| files | 70 |
| symbols | 723 (126 functions, 116 fields, 22 interfaces, 14 types, 9 methods, 5 MCP tools) |
| relations | 1,837 (282 CALLS, 156 IMPORTS, 87 USES_TYPE, 74 DATA_FLOWS, 58 FILE_CHANGES_WITH) |
| external symbols | 160 |

`graph-stats.txt` is `entire graph stats` over the build sessions. It is honest about
our own coding sessions: we used the graph rarely while writing Crashtest (6 graph calls
vs 193 grep/read calls), and put it to work where it matters more, inside the agents that
explore unfamiliar repos.

## 3. Checkpoints

Every commit made from a Claude Code session gets an Entire checkpoint (session
transcript, prompts, file changes) on the `entire/checkpoints/v1` branch. Automatic push
is off on purpose: each checkpoint is scanned for secrets before it is pushed by hand,
because a checkpoint holds the full transcript.

Mirror: https://entire.io/gh/emreozyoruk/crashtest

| Checkpoint | Commit | Session |
|---|---|---|
| [`97c75579b386`](https://entire.io/gh/emreozyoruk/crashtest/commit/74641efd901999e96d69fd85f69dde70f3aa0a62) | `74641ef` Add Entire evidence | [`0980f640`](https://entire.io/gh/emreozyoruk/crashtest/session/0980f640-3a33-4eb8-9f12-89accc563cc3) |

![Checkpoint 97c75579b386 on entire.io](../evidence/entire-checkpoint-97c75579b386.png)
