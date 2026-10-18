# Event model

> Updated 2026-10-18 (`target` on `tool.call_started`, `speed` on `run.started`). Source of truth: `packages/events/src/{envelope,payloads,event,parse,redact}.ts`. Schema version **1**, 21 event types.

A run is an ordered list of events. Every view in Runloop is a fold over that list: execution state (`packages/core`), the world (`packages/world-engine`), and replay at any sequence (`packages/replay`).

## Envelope

| Field | Type | Meaning |
|---|---|---|
| `eventId` | UUID | Unique id of this event |
| `runId` | UUID | The run it belongs to |
| `sequence` | int ≥ 1 | **The only ordering key.** Contiguous per run, assigned by the recorder. |
| `timestamp` | ISO 8601 | When it happened. Informational and may be non-monotonic; replay clamps it to be non-decreasing. Executed runs use the runtime clock. Traced runs use the hook's `observedAt`, clamped to `[run.started, now]`. |
| `type` | string | One of the types below |
| `schemaVersion` | int | `1` |
| `actorId` | string? | Index copy of the responsible agent (or `system`), derived from the payload when possible |
| `taskId` | string? | Index copy of the related task |
| `parentEventId` | UUID? | Causal link, e.g. a call's terminal event → its `tool.call_started` |
| `visibility` | `public` · `redacted` · `sensitive` | See below |
| `provenance` | `reported` · `inferred` · absent | See below |
| `payload` | object | Type-specific; validated by the type's zod schema |

**Drafts.** Emitters write an `EventDraft` (type, payload, optional actor, task, parent and visibility). The recorder fills in `eventId`, `sequence`, `timestamp` and `schemaVersion`. Only traced runs may set `provenance` and `timestamp` on a draft. The recorder rejects both on executed runs, and requires `provenance` on `tool.*` events in traced runs.

## Provenance (trust)

| Value | Meaning | Studio label |
|---|---|---|
| absent | Runloop's runtime observed it itself (executed runs: it ran the tool) | **Executed** |
| `reported` | The external source said so (e.g. Claude Code's hook payload). Runloop did not run or verify it. | **Traced · Claude Code** / Reported |
| `inferred` | Runloop reconstructed it because the source never reported it. Examples: a permission denial (no hook fires), a call closed when its session ended or went idle, a call start synthesised from a result that arrived first. | **Inferred** chip |

"Not reported" is not a provenance. It means a value is missing (for example the main agent's tokens), and the UI shows it as *not reported*, never as zero.

## Visibility

| Value | Meaning |
|---|---|
| `public` | Safe to show |
| `redacted` | A secret was masked in the payload (`[REDACTED]`). Set automatically by `redactEvent`. |
| `sensitive` | User content such as prompt text and agent replies. Shown locally with a chip; meant to stay out of anything shared. |

The recorder redacts every draft before it is sequenced: well-known token shapes plus the values of credential-like environment variables. The Claude Code plugin redacts before sending as well, with a parity-tested copy of the patterns (`REDACTION_PATTERNS`), and masks each matched secret's literal value everywhere else in the hook (for example a password echoed back in an error). Long strings are redacted before they are cut, so a cap cannot split a secret past the patterns.

## Event types

Required fields are plain; optional fields end in `?`.

### Run lifecycle

| Type | Payload | Notes |
|---|---|---|
| `run.started` | `title`, `missionId`, `worldId`, `adapter {id, kind: scripted\|llm\|external, label}`, `seed?`, `workspace?`, `speed?`, `mode?: executed\|traced`, `source?` | Always sequence 1. `mode: traced` ⇔ `source` present ⇔ `adapter.kind: external`. Executed runs need `seed` and `workspace` (relative to the data dir). `speed` (executed runs, added 2026-10-18) is the scripted adapter's pacing multiplier (1 normal, 0 no delays); compare does not judge durations of runs at different paces. |
| `run.paused` | `reason?` | Executed runs only |
| `run.resumed` | — | Executed runs only |
| `run.completed` | `outcome: succeeded\|failed\|stopped\|interrupted`, `summary?` | Terminal. A Claude Code session that ends normally is `stopped` (shown as "ended"). Boot recovery and the idle sweep give `interrupted`. |
| `run.marker` | `kind: compaction\|notification\|api_error\|session_resumed\|model_switch\|other`, `label`, `detail?`, `agentId?` | A notable moment that is neither a task nor a call |

`source` (traced runs): `{kind: 'claude-code', sessionId, segment ≥ 1, projectLabel (base name only), model?: string|null, permissionMode?, startSource?, pluginVersion?, continuesRunId?}`.

### Agents

| Type | Payload | Notes |
|---|---|---|
| `agent.registered` | `agentId`, `name`, `role`, `model: string\|null`, `tools[]`, `embodied`, `characterPreset?` | `embodied: false` means no robot (the user, the demo coordinator, subagents beyond 8) |
| `agent.state_changed` | `agentId`, `state: idle\|working\|waiting\|blocked\|failed\|done`, `reason?` | |
| `agent.message_sent` | `messageId`, `fromAgentId`, `to` (an agentId or `all`), `text` | Traced prompts and replies are capped at 2 KB and marked `sensitive` |
| `agent.usage_reported` | `agentId`, `model: string\|null`, `inputTokens`, `outputTokens`, `cacheReadTokens?`, `cacheCreationTokens?`, `totalTokens?`, `durationMs?`, `toolUseCount?`, `callId?`, `source` | Only as reported, never estimated. For Claude Code, `source: 'claude-code.agent_result'` comes from the `Agent` tool's result, so subagents only. An agent without this event has *no reported usage*. |

### Tasks

| Type | Payload | Notes |
|---|---|---|
| `task.created` | `taskId`, `title`, `kind`, `dependsOn[]`, `acceptance?`, `plannedSteps?` | `kind`: `research`, `code`, `test`, `fix`, `approval`, `deploy`, plus `turn` (a user turn) and `delegated` (work handed to a subagent) for traced runs |
| `task.assigned` | `taskId`, `agentId` | |
| `task.started` | `taskId`, `agentId` | Each start is one attempt |
| `task.blocked` | `taskId`, `reason`, `blockedBy?[]` | |
| `task.completed` | `taskId`, `summary`, `artifactIds[]` | A **claim** by whoever completed it. Read it against the tool results. |
| `task.failed` | `taskId`, `reason`, `errorType?` | |

### Tools

| Type | Payload | Notes |
|---|---|---|
| `tool.call_started` | `callId`, `agentId`, `taskId?`, `tool`, `category?`, `inputSummary`, `target?` | `category`: `read`, `search`, `web`, `edit`, `execute`, `test`, `deploy`, `mcp`, `delegate`, `plan`, `other`. The world places robots by category. `target` (1–300 chars) is what the call acts on, when the source names it; see below. |
| `tool.call_completed` | `callId`, `status: success\|error`, `durationMs`, `exitCode?`, `outputSummary`, `metrics? {tests, passed, failed}`, `failingTests?[]`, `outputArtifactIds?[]`, `errorType?` | **The tool ran.** A failing test run is `status: error` with its real counts. Traced failures carry `errorType: exit_nonzero` (with `exitCode`) or `tool_error`. |
| `tool.call_failed` | `callId`, `errorType`, `message`, `durationMs` | **The tool could not run, or its end was never observed.** `errorType`: `timeout`, `denied`, `aborted`, `spawn_error`, `exception`, `runtime_restarted`, `unobserved` (traced: Runloop closed it, inferred). |
| `tool.permission_requested` | `permissionId`, `agentId`, `callId?`, `action`, `scope` | |
| `tool.permission_resolved` | `permissionId`, `decision: approved\|denied`, `by` | Claude Code reports no denial in default mode, so denials are inferred with `by: 'unknown'` |

**`target`** (added 2026-10-18, additive; DL-008). Run compare reads it for "files touched" and the first divergence. It is never guessed from free text, and absent means *not reported*.

| Source | Tools | `target` |
|---|---|---|
| Claude Code | `Read`, `Edit`, `Write` | `file_path`, made relative to the project like the input summary |
| Claude Code | `NotebookEdit` | `notebook_path` |
| Claude Code | `Grep`, `Glob` | `path` (the directory searched), when given |
| Claude Code | `Bash`, `PowerShell`, `Monitor` | The command's first word as a base name, after `NAME=value` assignments and wrappers such as `sudo`, `env` or `time` (`./node_modules/.bin/vitest run` → `vitest`). Never the arguments, so no secret can reach it. |
| Scripted demo (executed) | `read_file`, `write_file`, `list_files` | The workspace-relative path |
| Scripted demo (executed) | `run_command` | The program's base name (`node`) |

Logs recorded before 2026-10-18 have no `target`. Compare treats a missing target as unknown, never as different, and says the file lists are incomplete.

### Artifacts

| Type | Payload | Notes |
|---|---|---|
| `artifact.created` | `artifactId`, `kind: file\|diff\|log\|test_report`, `name`, `mediaType`, `bytes`, `sha256`, `path?`, `producedByCallId?`, `summary` | Executed runs only today. The bytes are stored by the runtime and checked against `sha256` when served. |

## Invariants

- Sequences are contiguous from 1. Readers buffer out-of-order delivery (`SequenceBuffer`) and fold strictly in order.
- Every `tool.call_started` gets exactly one terminal event: `tool.call_completed` or `tool.call_failed`, linked by `parentEventId`. Calls still open when a run ends are closed: `aborted` when a scripted run is stopped, `runtime_restarted` by boot recovery, and `unobserved` (inferred) for traced runs.
- `run.completed` is the last event of a run.
- In executed runs, `run.*`, `tool.*` and `artifact.*` come only from the runtime, never from an adapter.
- Reducers never throw on bad input. They record an anomaly (duplicate id, unknown reference, unknown event) and continue, so one bad event cannot break replay.

## Parsing and versioning

- `parseEvent` (readers) never throws. An invalid envelope is rejected. An unknown type, an unsupported `schemaVersion` or an invalid payload becomes an `UnknownEvent`, which reducers skip (with an anomaly) and the trace shows as "Unrecognised".
- `parseKnownEvent` (the recorder) accepts only valid, known, current-version events.
- **Rules for schema version 1: additive changes only.** That means new event types, new optional fields and new enum members. Logs written before a change must keep parsing (`parse.test.ts` parses the canonical demo fixture as known events). Older readers see new types as `UnknownEvent`, and the envelope strips unknown keys.
- A breaking change needs `schemaVersion: 2` for the affected types and a reader that handles both.
- The Claude Code ingest protocol is versioned separately (`v: 1` on each hook envelope; the runtime answers 400 with `supported: [1]` otherwise). The hook payload schema is loose on purpose: only `session_id` and `hook_event_name` are required, because Claude Code adds fields between versions.

## Claude Code hooks → events (summary)

| Hook | Events (provenance `reported` unless noted) |
|---|---|
| SessionStart | None (pending state). A later start on an open run gives `run.marker` (`session_resumed`, `compaction` or `other`). |
| UserPromptSubmit | First event of a run: `run.started`, `agent.registered` for `user` and `main`. Then `task.created {turn-n, kind: turn}`, `task.started`, `agent.message_sent user→main`, `agent.state_changed working`. |
| PreToolUse | `tool.call_started` with `category` and, when the input names it, `target`. Main with no open turn gets an implicit turn (inferred). |
| PostToolUse / PostToolUseFailure | `tool.call_completed`, `success` or `error`, with exit code and test counts parsed from the output tail. A result without a start first synthesises the start (inferred). `Agent` results also give `agent.usage_reported` for the subagent. |
| PermissionRequest | `tool.permission_requested`, matched to the open call by agent, tool and input hash (inferred link) |
| PermissionDenied (auto mode) | `tool.permission_resolved denied`, then `tool.call_failed denied` |
| SubagentStart / SubagentStop | `agent.registered sa-<agent_id>` with `task.created {delegate-k, kind: delegated}`, then assign, start and working. At the stop: the reply message, `task.completed` and `state_changed done`. |
| Stop | `agent.message_sent main→user`, `task.completed turn-n`, `state_changed idle`. Pending permissions close as denied (inferred). |
| StopFailure | `task.failed {errorType: api_error}`, `run.marker api_error` |
| Notification, PreCompact, PostCompact | `run.marker` (`notification`, `compaction`) |
| SessionEnd | Open calls close as `tool.call_failed unobserved` and open tasks complete ("ended with session"), both inferred. Then `run.completed {outcome: stopped}`. |

The full table, the edge cases and the probe findings are in `docs/plans/claude-code-tracer.md` (§4 and Appendix C).
