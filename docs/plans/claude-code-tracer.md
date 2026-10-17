# Claude Code tracer mode: implementation plan

> Status: proposed (2026-10-17) · Target: Runloop 0.1.x · File: `docs/plans/claude-code-tracer.md`
> Paths are relative to the repo root. Items marked **[unverified]** are not confirmed by the Claude Code docs or the repo, and milestone M0 settles them. Sources are in Appendix A.

## 1. Summary, goals, non-goals, v1 scope

**Summary.** Tracer mode records a normal Claude Code session in Runloop and shows it live, subagents included. A small plugin (`integrations/claude-code-plugin/`) registers command hooks for session, prompt, tool, permission, subagent, notification and compaction events. Each hook runs a dependency-free Node script that writes the event to a local spool and forwards it to the runtime on `127.0.0.1:4317`. The runtime maps each event to ordinary Runloop events and records them through the existing `Recorder`. Each session becomes one run, each embodied agent one robot, and each `tool_use_id` one tool call. Studio streams the run over SSE and can replay it like any other run.

### 1.1 Goals

- Keep using Claude Code unchanged. Hooks are async, never write to stdout, never return decisions, and always exit 0.
- Show the main agent and subagents as robots, tool calls at stations, permission waits at the gate, and prompts and replies as messages.
- Keep one durable, replayable log that uses the same store, SSE stream and `ReplayIndex` as executed runs.
- Label provenance honestly. Runloop recorded what Claude Code reported; it did not execute or verify anything.
- Survive a runtime that is down at start, a runtime restart, a missing SessionEnd, parallel tools, and out-of-order delivery (tolerated in v1, not reordered).

### 1.2 Non-goals

- No control. Runloop never runs, steers, approves or blocks Claude Code.
- No network. Data goes only to loopback.
- No re-execution, branching or "re-run from here" for traced runs.
- No transcript parsing and no token or cost accounting in v1.
- No tracing of `claude --bare` or `--safe-mode` sessions. Those modes skip plugins and hooks by design.

### 1.3 v1 scope

| Included in v1 | Deferred |
|---|---|
| Hook capture for the events in §8 | v1.1: reorder hold window, only if M3 measurements show frequent anomalies |
| Pure mapper, idempotent ingest, synchronous projection (no reorder queue) | v1.1: `openCallIds` for parallel calls |
| Per-event spool with flush | v1.1: rebuild run state from events after a restart |
| Restart policy: close as interrupted, then a continuation segment | v1.1: model-switch markers (`PreModelSwitch` / `PostModelSwitch`) |
| Idle sweep (120 min default) | v1.1: subagent `homes` and palette, follow toggle, `runloop token --rotate` |
| Summary capture only; client and server redaction; prompt text marked `sensitive` | v2: `capture=full` artifacts, subagent despawn, dwell and hysteresis, idle-gap compression, `RUNLOOP_READ_TOKEN`, run deletion, long-lived relay, usage and cost (no documented hook fields) |
| Studio: traced badge, Source panel, inferred chips, Live sessions, follow newest traced run, marker rows, tool categories and stations, cap of 8 embodied subagents | |
| `--doctor` check, marketplace packaging | |

## 2. User experience

**Install (local dev)**
```sh
pnpm dev                                                     # runtime :4317 + Studio :3000; runtime writes the ingest token on boot
claude --plugin-dir ~/code/runloop/integrations/claude-code-plugin
```
After editing the plugin, run `/reload-plugins` inside Claude Code.

**Install (marketplace)**
```
/plugin marketplace add <owner>/runloop
/plugin install runloop-tracer@runloop
```
Or from the shell: `claude plugin install runloop-tracer@runloop --scope user`.

**Check the setup:** `node <plugin>/scripts/runloop-hook.mjs --doctor`. It prints the runtime URL, whether the token file was found, whether the runtime answers, the spool size, the last error, and the time of the last accepted event. If no events have arrived, it suggests checking for managed-policy hook blocking (see §9).

**Using Claude Code normally**

| Claude Code | Studio |
|---|---|
| You submit your first prompt, or the first tool or subagent event happens | A run appears under **Live sessions**, titled "Claude Code · `<project>`", with a **Traced · Claude Code** badge. Studio opens it if no run is open. Opening and closing Claude Code without typing creates nothing. |
| You submit a prompt | "You → Claude" message; the main robot starts a *Turn N* task |
| Claude works without a prompt (a background task finishes, a scheduled task runs) | An implicit turn opens with an *inferred* title |
| Read / Grep / Glob / WebFetch / WebSearch | Robot walks to the Research room (library stations) |
| Edit / Write / NotebookEdit, and Bash / PowerShell / Monitor that are not tests or deploys | Build room |
| Bash or PowerShell running a test runner | Test room |
| Bash or PowerShell matching a deploy pattern, or an `mcp__*` tool | Ops room |
| `Agent` spawns a subagent | A robot "`<type>` #k" appears (up to 8 embodied per run), gets a *Delegated* task, works in parallel, and dims when it finishes |
| Permission dialog | Robot waits at the Approval Gate. Approved when the call completes; denied (inferred) otherwise |
| Tool error or API error | Red incident at the station; an API error fails the turn |
| Compaction, notifications | Marker rows in the timeline |
| You exit | Run ends as "Ended" (stored as outcome `stopped`) |
| Claude Code is killed | Run closes as "Interrupted" after 120 min idle (inferred). The next hook opens a continuation segment. |

**Replay.** Open the run at any time and scrub it in the ReplayBar. Nothing is re-executed.

## 3. Architecture

```
Claude Code (unchanged)
  │ fires hook: command, exec form, async (SessionEnd is synchronous)
  ▼
node scripts/runloop-hook.mjs
  │ read stdin (≤ 64 MiB) → parse → slim (drop tool_response, keep sizes)
  │   → redact (shared patterns + Claude Code's env secrets)
  │ envelope {v:1, deliveryId, observedAt, ppid, plugin, hook}
  │ write spool/<session>/<observedAt>-<deliveryId>.json   (before any network call)
  │ POST /api/ingest/claude-code  (X-Runloop-Token; 1 s, or 800 ms for SessionEnd)
  │   2xx → delete own spool entry, then flush up to 20 older entries (any session)
  │   network/5xx → keep entry;  400/413 → drop;  401/403 → keep
  │ always exit 0 · never write stdout
  ▼
Runloop runtime 127.0.0.1:4317
  POST /api/ingest/claude-code
    guards in order: Host (existing) → no Origin → JSON → bodyLimit 1 MiB → token → zod → rate cap
    per envelope, synchronously, one SQLite transaction:
      trace_ingest dedupe → mapHook() [pure] → Recorder.recordBatch (redact → sequence → validate → persist → publish)
  Idle sweep every 60 s
  ▼
GET /api/runs/:id/stream (SSE, existing)
  ▼
Studio: SequenceBuffer → ReplayIndex → reduceExecution (L1) → reduceWorld (L2) → R3F scene
```

**Decisions**

**D1. Command hooks with `async: true` in exec form. SessionEnd is synchronous.**
- Why not `http` hooks: the docs describe `async` as a command-hook field, and SessionStart accepts only `command` and `mcp_tool` handlers. An HTTP hook would make every tool call wait on the runtime, would fail on a refused connection, and could not redact on the client or spool. HTTP-hook async support is **[unverified]**.
- Async hooks should not be able to block. The docs say background responses are ignored for PostToolUse ("Synchronous responses only"), and `asyncRewake` is the only background form that acts on exit 2. The M0 probe confirms that an async PreToolUse exiting 2 does not stop the tool.
- Cost: one Node process per event, roughly 40–80 ms CPU, off the critical path. M3 measures it.
- SessionEnd: the docs give SessionEnd a 1.5 s budget, which a longer per-hook `timeout` in settings raises up to 60 s. Whether a plugin's `hooks.json` timeout counts is **[unverified]** (M0). The design assumes 1.5 s.
- `node` must be on the PATH that Claude Code sees. If it is not, hooks fail silently. The README documents the check.

**D2. Fail open.** The script exits 0 on every path and writes nothing to stdout. Plain stdout would be injected into Claude's context for SessionStart and UserPromptSubmit. Errors go to `${CLAUDE_PLUGIN_DATA}/last-error.json`, and to stderr only with `RUNLOOP_TRACE_DEBUG=1`. A self-timeout of 1.5 s bounds the run.

**D3. Spool first, then send.** Each event is written to its own file before any network call, so an event survives if Claude Code exits while the hook is still running. Any later hook flushes the spool, across sessions. There is no lock: duplicates are harmless because ingest is idempotent. Bounds: 50 MiB total, 7-day TTL, oldest dropped first.

**D4. Map in the runtime.** Hook processes are stateless and see one event each. Only the runtime sees the whole session. The mapper is a pure function, testable with golden files. Plugin updates need user action, so the script stays small and stable.

**D5. Ordering without a reorder window (v1).** Ingest projects each envelope synchronously in arrival order. No queue holds events, so a runtime crash cannot lose accepted events. The mapper is late-tolerant. A PostToolUse for an unknown call synthesizes the start (inferred), built from the PostToolUse's own `tool_input`, and the late PreToolUse is then ignored. Timestamps come from `observedAt`; `ReplayIndex` clamps them to be non-decreasing. A reorder hold is added in v1.1 only if M3 shows frequent anomalies.

**D6. Token location.** The default data dir is `<repo>/.runloop`, which the plugin cannot discover, so the token lives per user:
- `$XDG_CONFIG_HOME/runloop/ingest-token` (default `~/.config/runloop/ingest-token`), or `%APPDATA%\runloop\ingest-token` on Windows.
- Contents: 32 random bytes, base64url. The runtime creates it at boot if it is missing, with mode 0600. On Windows the file's user-profile ACL applies instead of mode bits.
- `RUNLOOP_INGEST_TOKEN_FILE` overrides the path on both sides.
- Rotation for v1: delete the file and restart the runtime. `runloop token --rotate` is v1.1. The `runloop` CLI today has only `serve` and `demo`.

**D7. Scope of tracing.** The plugin traces every session where it is enabled. That includes `claude -p` and Agent SDK sessions, which load plugins unless run with `--bare`. The docs name no hook field that separates interactive from headless sessions, so v1 cannot exclude them automatically. CI should disable the plugin or set `RUNLOOP_TRACE=0`.

## 4. Hook → Runloop event mapping

**Identifiers**
- `runId` = UUIDv5(fixed namespace, `claude-code:<session_id>:<segment>`). It is deterministic. `Recorder.createRun` throws on an existing id, so the manager checks first.
- Agents: `user` (not embodied), `main` (embodied, preset `claude`), and `sa-<agent_id>` for subagents, sanitised to `[A-Za-z0-9._-]` and at most 64 characters. An event's agent is `sa-<agent_id>` when `agent_id` is present, otherwise `main`.
- `callId` = `tool_use_id`. Task ids: `turn-<n>` and `delegate-<k>`. Permission ids: `perm-<n>`. Message ids: `msg-<n>`.
- Every draft carries `provenance: 'reported'` unless marked *(inferred)*.

**Lazy run creation.** The mapper holds SessionStart's fields (`model`, `cwd`, `permission_mode`, `source`) in a pending state. The first UserPromptSubmit, or the first tool, subagent or permission event, creates the run: `run.started` (mode `traced`, adapter kind `external`), `agent.registered user`, and `agent.registered main`.

| Hook | Input used | Runloop events | Notes |
|---|---|---|---|
| SessionStart | `session_id`, `source`, `model?`, `cwd`, `permission_mode` | None by itself; sets pending state. If a run is open and `source` is `resume` or `compact`: `run.marker` (`session_resumed` or `compaction`). | `resume` and `fork` are documented; `startup`, `clear`, `compact` are **[unverified]**. `projectLabel = basename(cwd)`; the absolute path is never stored. |
| UserPromptSubmit | `prompt`, `prompt_id` | Close any open turn (inferred summary). Then `task.created {turn-n, kind:'turn'}` → `task.started main` → `agent.message_sent user→main` → `agent.state_changed main working`. | Key `prompt:<prompt_id>`, falling back to `delivery:`. `prompt_id` is absent until the first input (documented). Text is redacted, capped at 2 KB, and `sensitive`. `RUNLOOP_TRACE_PROMPTS=0` stores a placeholder. |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id`, `agent_id?` | `tool.call_started {callId, agentId, taskId, tool, category, inputSummary}`. If main has no open task, open an implicit turn first. | Key `pre:<tool_use_id>`. A repeat is dropped. |
| PermissionRequest | `tool_name`, `tool_input`, `agent_id?` | `tool.permission_requested {perm-n, agentId, callId?, action, scope: permission_mode}` | No `tool_use_id` is documented **[unverified]**. Match to the newest open call with the same agent, `tool_name`, and sha256(`tool_input`) (inferred). |
| PostToolUse | `tool_use_id`, `tool_input`, `tool_response` (dropped), `duration_ms?` | If a permission is pending on this call: `tool.permission_resolved approved by 'user'` (inferred). If the call is unknown, synthesize its start (inferred). Then `tool.call_completed {status:'success', durationMs, outputSummary}`. | `tool_use_id` appears in the docs example; whether every PostToolUse carries it is **[unverified]**. Key `post:<tool_use_id>`. |
| PostToolUseFailure | `tool_use_id?`, `error`, `is_interrupt?`, `duration_ms?` | Interrupt → `tool.call_failed {errorType:'aborted'}`. Otherwise `tool.call_completed {status:'error', errorType:'tool_error', outputSummary: error}`. | `is_interrupt` is **[unverified]**. This hook does not fire for permission denials, so denials are handled separately (below). |
| PermissionDenied (auto mode only) | `tool_use_id?` | `permission_resolved denied by 'auto mode'`, then `tool.call_failed {errorType:'denied'}` | Auto mode only (documented). The only deterministic denial signal. |
| SubagentStart | `agent_id`, `agent_type` | `agent.registered {sa-…, name:'<type> #k', role:type, model:null, tools:[], embodied (within cap), characterPreset:'builder'}`, then `task.created {delegate-k, kind:'delegated', title}`, `task.assigned`, `task.started`, `state_changed working` | Link to the parent's newest `Agent` call that has no subagent yet. The `Agent` input field names (`subagent_type`, `description`) are **[unverified]**; the title falls back to the agent type. Subagents beyond the cap get no robot but are still traced. |
| SubagentStop | `agent_id`, `last_assistant_message` | Close its open calls as `tool.call_failed {errorType:'unobserved'}` (inferred). Close its pending permissions as denied (inferred). `agent.message_sent sa→main` (2 KB). `task.completed {delegate-k, summary, artifactIds:[]}`. `state_changed done`. | `last_assistant_message` is documented. A background subagent can outlive its parent's turn, so late events attach to the delegate task, not to the turn. |
| Stop | `last_assistant_message`, `stop_hook_active?` | Close main's pending permissions and their calls as denied (inferred). `agent.message_sent main→user`. `task.completed {turn-n, summary, artifactIds:[]}`. `state_changed main idle`. If `stop_hook_active` is true, do not close the turn. | Key is `deliveryId`, because Stop can repeat. `stop_hook_active` is **[unverified]**. Whether Stop fires on Esc is **[unverified]** (M0). |
| StopFailure | `error?`, `error_details?` | `task.failed {turn-n, reason, errorType:'api_error'}`, `state_changed main failed`, `run.marker api_error` | `error` fields are **[unverified]**. |
| Notification (matcher `idle_prompt\|permission_prompt`) | `notification_type`, `message` | `idle_prompt` → `state_changed main waiting`. `permission_prompt` with no pending permission → `tool.permission_requested` fallback (inferred). | The matcher stops other notification types from spawning processes. Notification type names are documented. |
| PreCompact / PostCompact | `trigger?` | `run.marker compaction` (start and end). Only the summary length is recorded. | `trigger` and `compact_summary` are **[unverified]**. |
| SessionEnd (synchronous) | `reason` | Close open calls (`unobserved`), pending permissions (denied), and open tasks (`task.completed`, "ended with session", inferred). Subagents → `done`. Then `run.completed {outcome:'stopped', summary:'Session ended (<reason>)'}`. | Reason values beyond `clear` and `resume` are **[unverified]**. |

**Not registered in v1:** PostToolBatch, Setup, UserPromptExpansion, TaskCreated, TaskCompleted, TeammateIdle, Pre/PostModelSwitch (v1.1), MessageDisplay, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, Worktree*, Elicitation*.

**Edge cases**
- **Parallel tool calls.** Each `tool_use_id` is its own call. Core keeps one `activeCallId` (the last started call), and `finishCall` clears it when that call finishes, even while an earlier sibling still runs. In v1 the robot then falls back to the turn's task rule until the siblings finish. This is cosmetic. `openCallIds` is v1.1.
- **Subagent attribution.** Documented: plugin hooks run inside subagents; `agent_type` is documented as present for hooks that fire inside a subagent; `agent_id` appears in the common fields. Whether every tool event in a subagent carries `agent_id` is **[unverified]** (M0). Fallback: if exactly one subagent is open, attribute the call to it (inferred). Otherwise attribute it to `main` and record a one-time marker: "subagent attribution unavailable".
- **Denied permission.** In default mode, a denial fires no hook: PostToolUseFailure does not cover denials, and PermissionDenied is auto-mode only. The denial is inferred at the agent's next Stop, UserPromptSubmit, SubagentStop, SessionEnd, or idle sweep, and the call closes as `denied`. Late results for an already-closed call are dropped and counted.
- **Esc interrupt.** `is_interrupt` maps to `aborted` **[unverified field]**. The open turn closes at the next prompt or at SessionEnd, with an inferred summary, and is not marked failed.
- **Work without a prompt.** A background task finishing or a scheduled task running can produce main-agent tool events with no open turn. The mapper opens an implicit turn with an inferred title.
- **No SessionEnd** (kill -9, terminal closed). The idle sweep closes the run as `interrupted` after `RUNLOOP_TRACE_IDLE_MINUTES` (default 120), inferred. If the recorded Claude Code pid is gone, close on the next sweep instead **[unverified]**: it depends on `ppid` being the Claude Code process. A later hook for the same session opens a continuation segment.
- **Resume.** The CLI reference says `--fork-session` is needed for a new session ID, so resume reuses the ID. If the run is open, record `run.marker session_resumed`. If it is closed, open segment `n+1` with `source.continuesRunId`.
- **/clear.** Documented: the previous conversation is saved and a fresh one starts. Expected: `SessionEnd(clear)` closes the run and SessionStart starts pending state for the new session. Whether the new conversation gets a new session ID is **[unverified]** (M0). `/branch` and `--fork-session` get new IDs (documented).
- **/compact.** Documented as a summary that replaces history. The session continues, so markers only.
- **Two processes on one session.** Resuming one session in two terminals without forking interleaves the transcript (documented). The envelope carries `ppid`. If it changes within a session, record `run.marker other: "second Claude Code process"`. The `ppid` semantics are **[unverified]**.
- **Runtime restart mid-session.** See §6.7.
- **Concurrent sessions.** Each `session_id` has its own state and run. They do not share the single scripted run slot.
- **Late events.** Spool entries flushed after SessionEnd are dropped for the closed run and counted in `--doctor`.

## 5. Event schema changes (`packages/events`)

**`src/payloads.ts`**
- `AdapterInfoSchema.kind`: `z.enum(['scripted','llm','external'])`. Today it is `['scripted','llm']`.
- New `RunModeSchema = z.enum(['executed','traced'])`.
- New `TraceSourceSchema`:
  ```ts
  z.object({
    kind: z.literal('claude-code'), sessionId: id, segment: z.int().min(1),
    projectLabel: z.string().max(200), model: z.string().nullable().optional(),
    permissionMode: z.string().optional(), startSource: z.string().optional(),
    pluginVersion: z.string().optional(), continuesRunId: z.uuid().optional(),
  })
  ```
- `run.started`: add `mode` (optional; absent means executed) and `source` (optional). `seed` and `workspace` become optional, because today both are required. A `superRefine` enforces: `mode==='traced'` if and only if `source` is present and `adapter.kind==='external'`. Traced runs use `missionId:'claude-code'` and `worldId` from config (default `research-campus`).
- `TaskKindSchema`: add `turn` and `delegated`.
- `ToolCategorySchema = z.enum(['read','search','web','edit','execute','test','deploy','mcp','delegate','plan','other'])`. `tool.call_started` gains `category` (optional).
- `ToolFailureTypeSchema`: add `unobserved`. Today it is `timeout | denied | aborted | spawn_error | exception | runtime_restarted`.
- New `run.marker`: `{ kind: z.enum(['compaction','notification','api_error','session_resumed','model_switch','other']), label: z.string(), detail: z.string().optional(), agentId: id.optional() }`.
- Required fields the mapper must fill (checked against `payloads.ts`):
  - `tool.call_failed` needs `message` and `durationMs`.
  - `tool.call_completed` needs `durationMs` and `outputSummary`.
  - `task.completed` needs `summary` and `artifactIds`.
  - `task.failed` needs `reason`.
  - `agent.registered` needs `model` (nullable) and `tools` (array).
  - `task.created` needs `dependsOn` (array).
- Deferred: `agent.usage_reported`. No documented hook fields carry token counts.

**`src/envelope.ts`**: add `ProvenanceSchema = z.enum(['reported','inferred'])` and `provenance` (optional). Absent means native. The envelope schema strips unknown keys, so older readers ignore the field.

**`src/event.ts`**: `EventDraft` gains `provenance?` and `timestamp?`. Traced runs only; the recorder enforces this (§6.5). `deriveRefs` maps `run.marker` to `actorId = agentId`.

**`src/redact.ts`**: export `REDACTION_PATTERN_SOURCES`. The pattern list is private today, so the plugin's copy cannot be checked against it.

**`src/protocol.ts`**
- `RunSummary` gains `mode`, `source: {kind:'claude-code', sessionId, segment, projectLabel} | null`, and `lastEventAt`.
- `HealthResponse.activeRunId` stays scripted-only. Studio's demo button disables itself whenever it is set (`Sidebar.tsx`), so traced runs must never set it. Add `tracedRunIds: string[]` and `ingest: {claudeCode:{protocol:1}} | null`.
- New DTOs: `ClaudeCodeHookEnvelope { v: 1; deliveryId; observedAt; ppid?; plugin: {name, version}; hook: Record<string, unknown>; derived?: {lines?, bytes?} }`, `ClaudeCodeIngestRequest { envelopes: ClaudeCodeHookEnvelope[] }` (1–100), and `ClaudeCodeIngestResponse { accepted, duplicates, ignored }`. Add `apiPaths.ingestClaudeCode = '/api/ingest/claude-code'`.

**Compatibility.** `SCHEMA_VERSION` stays 1. Every change is an optional field, a new enum member, or a new type. Old logs parse unchanged. Readers from before this change see new types as `UnknownEvent`, which the reducers record as an `unknown_event` anomaly and the trace printer shows as "Unrecognised". Rule for the package: v1 changes are additive only.

**Core follow-ups (`packages/core`)**
- `reduce-execution.ts`: `run.started` stores `mode` and `source`. A new `run.marker` handler appends to `ExecState.markers`. The `handlers` map is exhaustive by `EventType`, so the compiler forces the new handlers.
- `AgentExec.lastCategory`: set on `tool.call_started`. `deriveIntent` uses it to keep stations sticky (§7.1).
- `format.ts` `describe()`: category-aware tool labels and marker rows.
- `ExecState.run` gains `mode` and `source`.

## 6. Runtime changes (`packages/runtime`)

### 6.1 New modules

```
packages/runtime/src/tracers/claude-code/
  hook-input.ts        loose zod schemas; unknown keys pass; session_id and hook_event_name required
  summarize.ts         tool_input/tool_response → summaries and categories; cwd-relative paths; Bash and PowerShell classifier
  ids.ts               UUIDv5 (SHA-1, ~15 lines); agent, task and permission ids
  mapper.ts            pure state machine (§6.2)
  session-manager.ts   TraceSessionManager: dedupe, projection, idle sweep, restart policy
packages/runtime/src/http/ingest.ts     route, guards, limits
packages/runtime/src/ingest-token.ts    create and read the token file
```

Wire these into `createRuntime` (`runtime.ts`) beside `RunManager`. `Runtime.close()` also stops the sweep timer. Today `createRuntime` calls `recorder.recoverInterrupted()` before building the manager, so traced recovery has to be mode-aware (§6.7).

**Recorder additions.** `tx()` is not re-entrant (its comment says so), so the trace path cannot wrap several `Recorder.append` calls in one transaction. Add `Recorder.recordBatch({ runId, create?: RunManifest, drafts, ingest?: {sessionId, key} })`. It does run creation (optional), all drafts, and the `trace_ingest` row in one `tx()`. An envelope is atomic: if any draft fails validation, the whole envelope rolls back and is counted as ignored.

### 6.2 Mapper contract

```ts
export interface SessionState {
  sessionId: string; runId: string | null; segment: number; status: 'open' | 'closed';
  pending: { model: string | null; cwd: string; permissionMode: string; source: string } | null;
  agents: Record<string, { ccAgentId: string | null; type: string; ordinal: number; taskId: string | null; done: boolean; embodied: boolean }>;
  turn: { n: number; promptId: string | null; taskId: string; implicit: boolean } | null; turnCount: number;
  calls: Record<string, { agentId: string; tool: string; category: ToolCategory; startedAt: string;
                          inputHash: string; done: boolean; permissionId?: string; subagentId?: string }>;
  pendingPermissions: Record<string, { agentId: string; callId?: string }>;
  counters: { permission: number; delegate: number; message: number; embodied: number };
  lastObservedAt: string; ppid: number | null;
}
export type TraceOp =
  | { op: 'create_run'; runId: string; manifest: RunManifest; timestamp: string }
  | { op: 'append'; draft: EventDraft; parentRef?: `call:${string}` }   // manager resolves parentEventId
  | { op: 'artifact'; artifactId: string; content: string; draft: EventDraft<'artifact.created'> };
export function mapHook(s: SessionState, env: ClaudeCodeHookEnvelope, ctx: MapContext): { state: SessionState; ops: TraceOp[] };
export function sweep(s: SessionState, ctx: MapContext, reason: 'idle' | 'restart' | 'ended'): { state: SessionState; ops: TraceOp[] };
```

`summarize.ts` examples: `Read src/app.ts`, `Grep "useStore" in src/`, `Bash · pnpm test`, `Edit src/x.ts (+3 −1)` (line counts from `derived`), `Agent → Explore: "find auth code"`. Caps: 200 characters for inputs, 300 for outputs.

**Classifier** (Bash and PowerShell):
- test: `/\b(vitest|jest|pytest|mocha|rspec|phpunit|ctest|go test|cargo test|(npm|pnpm|yarn|bun)( run)? test)\b/`
- deploy: `/\b(git (push|tag)|gh (pr|release)|docker (build|push)|kubectl|terraform apply|npm publish|vercel|fly deploy)\b/`
- otherwise execute.

Test is checked before deploy, so `pnpm test && git push` counts as a test.

### 6.3 Ingest endpoint: `POST /api/ingest/claude-code`

The existing `/api/*` middleware applies CORS and the JSON check, and rejects a disallowed Origin with 403 (verified in `app.ts`). The ingest route adds the rules below. Checks run in this order:
1. The existing Host guard (`localhost` or `127.0.0.1`).
2. Any `Origin` header is rejected with 403, even an allowed one. The plugin is not a browser.
3. JSON content type (existing; 415 otherwise).
4. Body limit 1 MiB (413). Today there is no body limit.
5. `X-Runloop-Token`, compared in constant time on SHA-256 digests (401).
6. zod validation (400). `v !== 1` returns 400 with `{error, supported:[1]}`.
7. Per-session token bucket: 100 per second, burst 1000 (429).
8. `TraceSessionManager.ingest()`, then 202 with `{accepted, duplicates, ignored}`.

`RUNLOOP_TRACE=off` removes the route.

### 6.4 Idempotency

- Transport: `trace_ingest(session_id, ingest_key)` is the primary key. The row is inserted in the same transaction as the events it produced. The key is semantic when possible: `pre:`, `post:`, `prompt:`, `sa-start:`, `sa-stop:`. Otherwise `delivery:<deliveryId>`. Spool retries reuse the file's `deliveryId`, so retries are safe.
- Semantic: the mapper ignores repeat starts and ends for a call or an agent, so duplicate deliveries cannot create `duplicate_id` anomalies.
- Known gap: installing the plugin twice (for example `--plugin-dir` plus the marketplace copy) double-sends. Semantic keys stop most duplicates, but Stop, Notification and compaction markers would still repeat. v1 documents "install once".

### 6.5 Timestamps and mode guards

- `Recorder.build()` currently sets `timestamp` from the runtime clock and builds the envelope field by field. For traced runs it uses `draft.timestamp ?? now()`, clamped to at most now and at least `run.started`. It must also copy `provenance` explicitly, because it does not pass draft keys through.
- The recorder caches each run's mode and enforces the rule in both directions. Executed runs reject drafts that carry `timestamp` or `provenance`. Traced runs require `provenance` on `tool.*` events. This keeps the trust rule in `adapter.ts` (`run.*`, `tool.*`, `artifact.*` come only from the runtime) meaningful: in an executed run, `tool.*` still means "Runloop ran it".

### 6.6 Runs and concurrency

- `TraceSessionManager` keeps `Map<sessionId, {state, runId, segment}>`. It has no workspace, adapter, AbortController or PauseGate.
- `RunManager.active` remains the single scripted slot. Only `RunManager.start` raises `RunConflictError` today, so traced runs never conflict.
- Control routes (`stop`, `pause`, `resume`) on traced runs return 409 with "Traced runs are controlled by Claude Code". Today `requireActive` already returns 409 for known runs that are not active, so this is a message change.
- Migration `MIGRATIONS[1]` (append-only; only index 0 exists today):
  ```sql
  ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'executed';
  ALTER TABLE runs ADD COLUMN source_kind TEXT;
  ALTER TABLE runs ADD COLUMN external_session_id TEXT;
  ALTER TABLE runs ADD COLUMN segment INTEGER;
  ALTER TABLE runs ADD COLUMN project_label TEXT;
  ALTER TABLE runs ADD COLUMN last_event_at TEXT;
  CREATE INDEX runs_by_external_session ON runs (source_kind, external_session_id, segment);
  CREATE TABLE trace_ingest (
    session_id TEXT NOT NULL, ingest_key TEXT NOT NULL, run_id TEXT REFERENCES runs (run_id),
    hook_event TEXT NOT NULL, observed_at TEXT, received_at TEXT NOT NULL,
    PRIMARY KEY (session_id, ingest_key)
  ) WITHOUT ROWID;
  ```
  `persist()` updates `last_event_at`.
- A normal SessionEnd maps to the existing outcome `stopped`. There is no new status. The `runs.status` CHECK constraint would need a table rebuild, which is unsafe because `events` and `artifacts` reference `runs` with foreign keys on (`db.ts` sets `foreign_keys = ON`). Studio shows a traced `stopped` run as "Ended".

### 6.7 Restart and idle sweep

- **Boot (v1).** `Recorder.recoverInterrupted()` marks every `running` run interrupted, including traced runs, and adds `tool.call_failed{runtime_restarted}` for open calls. For traced calls that is false: they may well have finished. The change is mode-aware. Traced runs get `tool.call_failed{errorType:'unobserved', message:'Runloop was not running when this call finished (inferred)'}` and `run.completed{interrupted}`.
- **After a restart (v1).** The next hook for the same session finds the run closed and opens a continuation segment with `continuesRunId`. The turn counter continues from the closed run's count. Rebuilding in-memory state from events is v1.1.
- **Idle sweep (v1).** Runs every 60 s on an unref'd timer. A session with no envelope for `RUNLOOP_TRACE_IDLE_MINUTES` (default 120) gets its open items closed as inferred `unobserved`, then `run.completed{interrupted, "No events from Claude Code for N min"}`.

### 6.8 Limits, redaction and capture

- **Plugin side.** Read stdin up to 64 MiB. Drop `tool_response` and keep `derived.bytes` and `derived.lines`. Truncate each string field to 4 KB before sending. The server truncates again: prompts and messages to 2 KB, tool summaries to the caps in §6.2.
- **Secrets.**
  - Client side: the shared pattern list (a copy, parity-tested against `REDACTION_PATTERN_SOURCES`), plus a port of `collectEnvSecrets` applied to Claude Code's environment.
  - Bash and PowerShell only: `(KEY|TOKEN|SECRET|PASSWORD|PASS)\w*=\S+` and `--(password|token|secret|api-key)[= ]\S+`. Values are masked.
  - Recorder side: `Recorder.build()` redacts again with the runtime's own environment. `redactEvent` changes visibility to `redacted` when it masks something.
- **Visibility.** Prompts and messages are `sensitive`.
- **Paths.** Relative to `cwd`. Paths outside `cwd` appear as `~/…` or `…/<last two segments>`. No absolute path appears in any event.
- **Capture.** Summary only in v1. `capture=full` (artifacts) is v2.

## 7. World and Studio changes

### 7.1 Tool categories drive stations

| Category | Claude Code tools | Station (research-campus) |
|---|---|---|
| read, search, web | Read, Grep, Glob, WebFetch, WebSearch | library |
| edit | Edit, Write, NotebookEdit | build |
| execute | Bash, PowerShell, Monitor (not test or deploy) | build |
| test | Bash or PowerShell whose command matches the test pattern | test |
| deploy | Bash or PowerShell matching the deploy pattern | ops |
| mcp | `mcp__*` | ops |
| delegate | Agent | none (robot stays put) |
| plan | EnterPlanMode, ExitPlanMode | none |
| other | TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop, TodoWrite, and any unlisted name | none |

The tools reference does not list LS, MultiEdit, NotebookRead, BashOutput or KillShell, so they are not mapped.

**World rules (`definition.ts`, `intent.ts`, `reduce-world.ts`)**
- `ActivityRuleSchema.when.toolCategory?: ToolCategory[]`.
- `matchActivityRule` takes `{taskKind, toolCategory, permission}`.
- Category resolution order: the active call's category; then the agent's `lastCategory` while the task is still active (sticky, so short gaps between calls do not send the robot home); then the task-kind rules.
- Priority is unchanged except for the new category step: failed, then awaiting approval, then waiting, then working, then succeeded, then idle. The draft said permission ranks first; it ranks second, after failed (`intent.ts`).
- The "agent with an open call but no task counts as working" rule from the draft is dropped. Every traced agent has a task, because main gets an implicit turn.
- `Sim.updateIntents` must also compare `stationKind`. Today it compares only activity and `taskId`, on the stated assumption that station kind is a function of (activity, task). That no longer holds once categories exist (`reduce-world.ts`, lines 177–178).
- `worlds/research-campus/world.json`: insert the `toolCategory` rules after the permission rule and before the task-kind rules. Scripted demo calls carry no category, so the demo is unchanged. Add one preset `claude` on a free walkable home cell. `world.test.ts` checks reachability.
- Thrashing is controlled by the sticky category and the coarse categories. Measure in M5. Dwell and hysteresis are v2.

### 7.2 Robots for subagents

- At most 8 embodied subagents per run. Subagents beyond that are traced (tasks, calls, timeline) but get no robot. The cap is needed because overflow queues stack every waiting character on one cell (`reserve()` in `reduce-world.ts`).
- Embodied subagents use the existing `builder` preset in v1. Per-type colours, `homes` and `variantPalette` are v1.1.
- Finished subagents dim in place (state `done`). They are not despawned; despawn is v2.

### 7.3 Provenance labelling

- `RunHeader.tsx` and the `Sidebar.tsx` row show the **Traced · Claude Code** badge.
- The metadata panel (`MetadataPanel.tsx`) shows a **Source** block for traced runs: session id (short), segment, project, model, permission mode, plugin version. It also shows this banner: *"Recorded from Claude Code hooks. Runloop did not run, approve or verify these actions; results are shown as Claude Code reported them. Items marked inferred were reconstructed by Runloop."*
- `LogsPanel.tsx` and `TimelinePanel` show an *inferred* chip next to the visibility chip.
- `AgentDetails` shows the model from SessionStart.

### 7.4 Session list and following

- The Sidebar groups runs into **Live sessions**, **Demo runs** and **History**. Live rows show "idle 5m" from `lastEventAt`.
- The demo button keeps keying on `health.activeRunId`, which stays scripted-only (`Sidebar.tsx`, line 54).
- `useRuntimePolling` (`state/hooks.ts`, line 49) opens `health.activeRunId ?? runs[0]` when nothing is open. Change it to prefer the newest running traced run when no scripted run is active. A "Follow new sessions" toggle is v1.1.

### 7.5 Copy and labels

- `KIND_LABEL` (`state/view.ts`, a `Record<TaskKind, string>`) gains Turn and Delegated. The compiler forces this.
- `selectAgentFlow` (`packages/core/src/selectors.ts`) groups by kind and needs no change.
- `AgentFlow.tsx` says "as the coordinator creates them". Reword it so it is not coordinator-specific.
- `WorldView.tsx` empty state mentions "Run demo mission". Add a line about the plugin.

### 7.6 Long sessions

- `connect.ts` loads the whole backlog with `getAllEvents`, and `ReplayIndex` keeps every event in memory with a snapshot every 50 events (`SNAPSHOT_EVERY` in `replay-index.ts`). That is fine for thousands of events.
- Replay time is wall-clock, so idle hours leave the scrub bar mostly empty. Compressing idle gaps is v2. It has to stay consistent with `eventTick`, which uses raw timestamps.

### 7.7 Transcript-derived extras (deferred)

- Model: `SessionStart.model` (optional) only. Model switches are v1.1, using the documented `from_model` and `to_model` on `PreModelSwitch` and `PostModelSwitch`.
- Final text: `last_assistant_message` on Stop and SubagentStop.
- Tokens and cost: no documented hook fields. The transcript format is internal and may change between versions (documented). Deferred until a documented source exists.

## 8. Plugin package

```
.claude-plugin/marketplace.json          # repo root
integrations/claude-code-plugin/
  .claude-plugin/plugin.json
  hooks/hooks.json
  scripts/runloop-hook.mjs               # ~250 lines, Node built-ins only, // @ts-check
  test/                                  # unit tests, redaction parity test
  package.json                           # private; typecheck and test only
  README.md
```

**Self-contained plugin.** A component path must resolve inside the plugin root (documented), and a marketplace install may copy only the plugin directory. The script therefore cannot import from `packages/`. Redaction patterns are copied and checked by a parity test.

**Workspace wiring.** Add `integrations/*` to `pnpm-workspace.yaml` (today `apps/*` and `packages/*`) and to `projects` in `vitest.config.ts` (today `packages/*` and `apps/studio`).

**`plugin.json`**
```json
{
  "name": "runloop-tracer",
  "version": "0.1.0",
  "description": "Record and visualise Claude Code sessions in a local Runloop world. Observe-only.",
  "license": "Apache-2.0",
  "userConfig": {
    "runtime_url":  { "type": "string",  "title": "Runloop runtime URL", "description": "Loopback only", "default": "http://127.0.0.1:4317" },
    "enabled":      { "type": "boolean", "title": "Trace sessions", "description": "Turn tracing off without uninstalling", "default": true },
    "trace_prompts":{ "type": "boolean", "title": "Record prompt text", "description": "Stored as sensitive", "default": true }
  }
}
```
The `version` pins the installed plugin until it changes, so bump it on every release (documented). Option values reach hooks as `CLAUDE_PLUGIN_OPTION_RUNTIME_URL`, `CLAUDE_PLUGIN_OPTION_ENABLED` and so on (documented).

**`hooks/hooks.json`**: exec form, as documented. Every event uses the same handler shape, shown once here:
```json
{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/runloop-hook.mjs"], "async": true, "timeout": 5 }
```
- Async (one entry each): SessionStart, UserPromptSubmit, PreToolUse (`*`), PermissionRequest (`*`), PermissionDenied (`*`), PostToolUse (`*`), PostToolUseFailure (`*`), SubagentStart, SubagentStop, Stop, StopFailure, Notification (matcher `idle_prompt|permission_prompt`), PreCompact, PostCompact.
- SessionEnd, synchronous: `"args": ["${CLAUDE_PLUGIN_ROOT}/scripts/runloop-hook.mjs", "--sync"]`, `"timeout": 2`, no `async`.
- The hook takes its ppid and event name from its own input, so one script serves every event.

**Script steps**
1. Read stdin up to 64 MiB, then `JSON.parse`. On any failure, record the error and exit 0.
2. Exit 0 if tracing is disabled (`RUNLOOP_TRACE=0` or `enabled` false).
3. Slim the payload, compute `derived` sizes, and redact (§6.8).
4. Build the envelope with `deliveryId` (UUID), `observedAt`, and `ppid`.
5. Write the spool file (`${CLAUDE_PLUGIN_DATA}/spool/<session>/<observedAt>-<deliveryId>.json`) atomically with tmp-then-rename.
6. Read the token; refuse non-loopback URLs.
7. POST with `AbortSignal.timeout` (1 s; 800 ms with `--sync`).
8. On 2xx: delete the own spool file, then POST up to 20 older spool entries in one batch, oldest first, across all sessions. On network failure or 5xx: keep the file. On 400 or 413: drop it and record in `last-error.json`. On 401 or 403: keep it and record.
9. Exit 0. Never write stdout.

`--doctor` runs the same token and reachability checks and reads `last-error.json` and the spool. It also flushes the spool when the runtime is reachable.

**Configuration** (precedence: env, then plugin option, then default)

| Setting | Env | Plugin option | Default |
|---|---|---|---|
| Runtime URL | `RUNLOOP_URL` | `runtime_url` | `http://127.0.0.1:4317` (loopback only; anything else is refused) |
| Token file | `RUNLOOP_INGEST_TOKEN_FILE` | none | per-user path (D6) |
| Enabled | `RUNLOOP_TRACE=0` | `enabled` | on |
| Prompt text | `RUNLOOP_TRACE_PROMPTS=0` | `trace_prompts` | on (sensitive) |
| Debug | `RUNLOOP_TRACE_DEBUG=1` | none | off |
| Idle close (runtime) | `RUNLOOP_TRACE_IDLE_MINUTES` | none | 120 |
| Kill switch (runtime) | `RUNLOOP_TRACE=off` | none | on |

**Commands**
- `claude --plugin-dir <path>`; then `/reload-plugins`.
- `claude plugin validate <path>`; add `--strict` in CI.
- `claude plugin install runloop-tracer@runloop --scope user --config trace_prompts=true`.
- `claude plugin disable runloop-tracer` to turn it off.
- `${CLAUDE_PLUGIN_DATA}` is deleted when the plugin is uninstalled from its last scope unless `--keep-data` is passed (documented). The spool goes with it, which is acceptable.

## 9. Privacy and security

- **Local only.** The plugin refuses non-loopback URLs. The runtime binds `127.0.0.1` and keeps its Host guard.
- **Authentication.** The token file is per user (mode 0600), compared in constant time. Requests with an Origin header are rejected, so web pages cannot forge sessions. Body, field and rate limits bound what a misbehaving local process can write. Same-user processes can read the token, which is the same trust boundary as the existing database and GET routes.
- **Read exposure is unchanged.** GET routes and SSE are unauthenticated for local processes (`app.ts`). Traced runs contain prompts and commands, so the README must say so. `RUNLOOP_READ_TOKEN` is v2.
- **Minimisation.** Summaries only. No `tool_response` bodies, Write contents, or Edit strings. No absolute paths. `transcript_path` is never stored.
- **Two-sided redaction.** Parity-tested shared patterns, Bash-specific secret patterns, prompt text marked `sensitive`, and `RUNLOOP_TRACE_PROMPTS=0` to skip prompt text.
- **Managed policy.** `allowManagedHooksOnly` blocks user, project, local and plugin hooks (documented). In such an environment the plugin records nothing. `--doctor` reports "no events received" and names this cause. `disableAllHooks` is documented for settings-level hooks; whether it also silences plugin hooks is **[unverified]** (M0).
- **Trust.** Plugin hooks run as the user with the user's permissions. Install only trusted plugins. The plugin runs no commands; it only writes files and POSTs to loopback.
- **Opt-out.** `RUNLOOP_TRACE=0` per shell, `claude plugin disable runloop-tracer`, or uninstall.
- **Deletion.** No API in v1. Delete `runloop.db`, the artifacts directory, or the spool directory. A `runs rm` command is v2.
- **Honesty.** Provenance is stored on every traced event. The UI never presents traced results as verified.

## 10. Testing strategy

1. **Fixtures.** Raw payloads from the M0 probe, sanitised, in `packages/runtime/test/fixtures/claude-code/<scenario>.jsonl`. Scenarios:
   - basic turn;
   - parallel reads;
   - two parallel subagents of the same type;
   - permission approved;
   - permission denied (no hook in default mode);
   - auto-mode denial (PermissionDenied);
   - Esc interrupt;
   - Bash test failure;
   - compaction;
   - /clear;
   - resume with the same session id;
   - no SessionEnd;
   - PostToolUse arriving before PreToolUse;
   - background subagent finishing after Stop;
   - implicit turn from background work;
   - two processes on one session (ppid change).
2. **Mapper golden tests** (`mapper.test.ts`). Fold each fixture through `mapHook`, record into a `:memory:` Recorder, and render with `TracePrinter` to a golden file. Invariants: `foldExecution` gives no anomalies beyond the documented ones; every `tool.call_started` has exactly one terminal event after SessionEnd or the sweep; `reduceWorld` does not throw.
3. **Summarize and ids.** Table tests for categories, the classifier, path relativisation, truncation and redaction.
4. **Ingest tests** (`test/ingest.test.ts`, in the style of `http.test.ts`):
   - 401 without a valid token; 403 with an Origin; 413; 429; 400 for unknown `v`;
   - duplicate deliveries and keys counted, not recorded;
   - concurrent sessions in separate runs with contiguous sequences;
   - scripted and traced runs coexisting; control routes return 409 for traced runs;
   - restart closes traced runs with `unobserved`, not `runtime_restarted`;
   - the idle sweep closes runs;
   - the recorder rejects `timestamp` and `provenance` on executed runs;
   - `recordBatch` rolls back the whole envelope on an invalid draft.
5. **Layers.**
   - core: `lastCategory`, `run.marker`, traced `run.started` without seed;
   - world-engine: `toolCategory` rules, sticky category, station-kind change detection, demo presets unchanged;
   - studio: view labels and incident placement by category.
6. **End to end** (`packages/runtime/test/claude-code-plugin.e2e.test.ts`). Start `createRuntime` on port 0. For each fixture line, spawn `node integrations/claude-code-plugin/scripts/runloop-hook.mjs` with the line on stdin, `RUNLOOP_URL`, a temp token file, and a temp `CLAUDE_PLUGIN_DATA`. Assert:
   - the golden output matches;
   - exit 0 and empty stdout for every invocation, including garbage stdin, a bad token, and an unreachable URL;
   - each invocation finishes under 1.5 s;
   - offline, then spool written, then runtime up, then the next hook flushes, giving the same golden output.
7. **Parity.** The plugin's pattern list equals `REDACTION_PATTERN_SOURCES`.
8. **Manual checklist with real Claude Code** (M3 and M5):
   - install with `--plugin-dir`, then from the marketplace;
   - start a session before the runtime, start the runtime, then send a prompt;
   - parallel Read and Grep; two parallel Agent subagents;
   - approve one permission and deny another; confirm the denied call closes at Stop;
   - Esc mid-Bash and Esc mid-response (does Stop fire?);
   - /compact, /clear, `--resume` (same session id), `/branch` (new id);
   - a background subagent that finishes after the turn;
   - exit normally; kill -9 Claude Code;
   - two terminals on one session (marker);
   - restart the runtime mid-session (run splits, continuation opens);
   - `claude -p` is traced; `claude --bare` is not;
   - a managed-policy environment where `--doctor` reports no events;
   - no hook error notices in the transcript; check latency with the probe's timing logs;
   - Windows PowerShell smoke test: `node` on PATH, paths with spaces, token file location.

## 11. Milestones

| # | Scope | Acceptance | Effort |
|---|---|---|---|
| M0 | Probe plugin logs raw stdin and timing for every registered event; run the §10 scenarios; answer the M0 questions in an appendix to this doc | Fixtures committed (sanitised); every **[unverified]** item in §12 answered | 1 d |
| M1 | Schema and layers: events (§5), core (`lastCategory`, markers, run fields), world-engine (`toolCategory`, station-kind compare, preset), migration `[1]`, recorder guards and `recordBatch` | `pnpm test` and `pnpm typecheck` green; demo golden traces unchanged | 2 d |
| M2 | Mapper, summarize, ids, goldens | Fixtures give no unexpected anomalies; late-tolerant goldens pass | 2–3 d |
| M3 | Ingest route, token, `TraceSessionManager` (synchronous projection, dedupe), plugin script (no spool yet), `hooks.json` | A real session appears live in Studio; E2E green; no hook error notices; latency measured | 2 d |
| M4 | Spool and flush, restart policy, idle sweep, continuation segments | Offline-start and restart scenarios produce complete runs | 1.5 d |
| M5 | Studio: badge, Source panel, inferred chips, Live sessions, follow newest traced run, labels, incident placement, subagent cap | Manual checklist passes; view tests green | 2–3 d |
| M6 | Packaging: `marketplace.json`, README, `--doctor`, `claude plugin validate .`, root and runtime docs | Fresh-machine install from the marketplace works end to end | 1 d |
| M7 (v1.1+) | Reorder hold (if measured), `openCallIds`, rehydrate across restarts, model markers, subagent homes and palette, token rotate command | Each behind a flag, with tests | 2–4 d |

Core v1 (M0–M6): about 11–14 working days.

## 12. Risks and open questions

| Risk or question | Status | Mitigation |
|---|---|---|
| Hook payloads change between Claude Code versions | Ongoing | Loose schemas; unknown events and fields ignored and counted; envelope `v` and plugin version; re-run M0 after each major release |
| **[M0]** Do tool events inside subagents carry `agent_id` and `agent_type`? | Partly documented | Fallback attribution (§4). This decides whether subagents get their own robots |
| **[M0]** Do async command hooks finish for every event, including SessionStart, PermissionRequest and Stop, when Claude Code exits right after? | Unverified | Spool before send; any later hook flushes. M0 measures loss at exit |
| **[M0]** Can an async PreToolUse block a call (exit 2 or decision JSON)? Expected: no | Partly documented | Probe. The design assumes it cannot |
| **[M0]** SessionEnd budget with a `hooks.json` timeout of 2 | Unverified | Design for 1.5 s; spool before the POST |
| **[M0]** Does PostToolUse carry `tool_use_id` and `tool_input`? Does PermissionRequest carry no `tool_use_id`? | Unverified | Fallback match by agent, tool and input hash (inferred) |
| **[M0]** Does a user denial fire any hook in default mode? | Partly (PermissionDenied is auto-mode only) | Inferred close at the next Stop, prompt, SubagentStop, SessionEnd or sweep |
| **[M0]** Does Stop fire on Esc? Does `ppid` equal the Claude Code pid? | Unverified | If not, the idle sweep alone handles it |
| **[M0]** SessionStart source values `startup`, `clear`, `compact`; SessionEnd reasons | Partly | Markers for unknown values |
| **[M0]** Does the build in use print a hook duration line under `--debug`? | Unverified | Timing from the probe's own logs |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | Not in the env-vars reference | Not used |
| Node startup cost under heavy parallelism | Measure in M3 | Async keeps it off the critical path; a long-lived relay is v2 if needed |
| Windows: `node` not on the PATH that Claude Code sees; path handling | Open | Exec form; `--doctor` check; PowerShell smoke test; forward-slash paths documented |
| Robots thrash with many subagents or fast tool bursts | Open | Coarse categories, sticky category, cap of 8 subagents; dwell and hysteresis in v2 |
| SQLite growth in long sessions | Open | Summary capture; `trace_ingest` pruning and `runs rm` in v2 |
| Two runtimes or a non-default port | Open | `RUNLOOP_URL` plus the shared per-user token; `--doctor` reports reachability |
| Managed policy with `allowManagedHooksOnly` | Documented | `--doctor` explains "no events" |
| Other local processes can read traced data | Documented | README; `RUNLOOP_READ_TOKEN` in v2 |
| Plugin installed twice double-sends | Open | Semantic keys dedupe most events; document "install once" |
| Background subagents outlive their turn | Documented behaviour | Late events attach to the delegate task |
| `claude -p` and Agent SDK sessions are traced too | Inferred from `--bare` (documented) | v1 traces them; CI disables the plugin or sets `RUNLOOP_TRACE=0` |

## Appendix A: Verified facts and sources

**Hooks** (https://code.claude.com/docs/en/hooks)
- Verified: 33 events, including SubagentStart and SubagentStop, PermissionDenied (auto mode), and PreModelSwitch and PostModelSwitch.
- Verified: common fields are `session_id`, `prompt_id` (absent until the first input), `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, `hook_event_name`. `agent_type` is present when the hook fires inside a subagent or with `--agent`. `agent_id` is listed in a separate table.
- Verified: SessionStart fields are `source`, `model` (optional), `agent_type`, `session_title`. SessionStart supports only `command` and `mcp_tool` handlers.
- Verified: PreToolUse fields are `tool_name`, `tool_input`, `tool_use_id`. Stop and SubagentStop provide `last_assistant_message`, which the docs recommend over reading the transcript. PreModelSwitch and PostModelSwitch provide `from_model` and `to_model`.
- Verified: exit 2 blocks on PreToolUse, Stop, SubagentStop and others. It is not honoured for PostToolUse, PostToolUseFailure, PermissionRequest, SessionStart, SubagentStart and SessionEnd. Plain stdout reaches Claude only for UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch.
- Verified: `async: true` runs in the background without blocking. Its timeout is not enforced. Background responses are ignored for PostToolUse ("Synchronous responses only"). `asyncRewake` wakes Claude on exit 2.
- Verified: default timeouts are 600 s for command, http and mcp_tool; 30 s for prompt; 60 s for agent; UserPromptSubmit defaults to 30 s. SessionEnd has a 1.5 s budget that a longer per-hook `timeout` in settings raises up to 60 s.
- Verified: exec form takes `command` and `args`. `${CLAUDE_PLUGIN_ROOT}` is substituted in `command` and in each `args` element. `shell` defaults to bash, or powershell on Windows when Git Bash is absent, and is ignored when `args` is set.
- Verified: matcher rules. `*`, empty or omitted match all. Plain identifiers match exactly, lists separated by `|` or `,` match exactly, anything else is a regex. For SubagentStart and SubagentStop the matcher is the agent type.
- Verified: `onFailure` applies to command and http hooks, defaults to `continue`, and `block` requires v2.1.295 or later.
- Verified: Notification matcher values include `permission_prompt` and `idle_prompt`.
- Verified: `allowManagedHooksOnly` blocks user, project, local and plugin hooks. `disableAllHooks` semantics for plugin hooks are unverified.
- Unverified (research step only, not in the pages read): SessionEnd reason values; SubagentStop `agent_transcript_path`; PreCompact and PostCompact fields; PermissionRequest and PermissionDenied fields; Stop's `stop_hook_active`; PostToolUseFailure `is_interrupt`; UserPromptSubmit `prompt`; PostToolUse `tool_use_id`.

**Sub-agents** (https://code.claude.com/docs/en/sub-agents)
- Verified: hooks from settings, managed settings and plugins all apply inside subagents.
- Verified: plugin subagents ignore the `hooks` frontmatter field; put hooks in `hooks/hooks.json`.
- Verified: SubagentStart and SubagentStop matchers take the agent name, or a plugin-scoped name with a colon, which is treated as a regex.

**Plugins** (https://code.claude.com/docs/en/plugins/manifest-reference; https://code.claude.com/docs/en/plugins/cli-reference; https://code.claude.com/docs/en/plugins/marketplace-reference)
- Verified: only `name` is required in `plugin.json`. Hooks live in `hooks/hooks.json` under a top-level `"hooks"` key. `settings.json` applies only `agent` and `subagentStatusLine`.
- Verified: `CLAUDE_PLUGIN_ROOT` changes on update. `CLAUDE_PLUGIN_DATA` is `~/.claude/plugins/data/<id>/`, kept across updates, and deleted on uninstall from the last scope unless kept. `CLAUDE_PROJECT_DIR` is set. `CLAUDE_PLUGIN_OPTION_<KEY>` is exported to hook processes for each option.
- Verified: `userConfig` types are `string`, `number`, `boolean`, `directory` and `file`. `sensitive` and `options` (v2.1.271 or later) are supported. `${user_config.KEY}` is substituted in exec-form `args`.
- Verified: component paths must resolve inside the plugin root. A `version` pins the plugin until it changes.
- Verified: `claude plugin validate <path>` with `--strict`; `claude plugin install <plugin@marketplace> --scope user|project|local --config KEY=VALUE`; `claude plugin disable <plugin>`; `/reload-plugins`; `claude --plugin-dir <path>`.
- Verified: the marketplace file lives at `.claude-plugin/marketplace.json` in the marketplace root. A relative `./` source resolves when the marketplace comes from GitHub, git, file or directory. `owner/repo` is accepted by `marketplace add`. `runloop` is not a reserved name.

**Sessions and CLI** (https://code.claude.com/docs/en/sessions; https://code.claude.com/docs/en/cli-reference)
- Verified: transcripts are at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working directory with non-alphanumeric characters replaced by `-`. The entry format is internal and may change between versions.
- Verified: `--resume` restores history. A tool still running when the previous process ended is shown as cut off and is not re-run. Background subagents and Bash commands that ended show as notes.
- Verified: `--fork-session` creates a new session ID "instead of reusing the original", so resume reuses the ID by default.
- Verified: `/clear` saves the previous conversation and starts a fresh one. `/branch` and `--fork-session` get new IDs.
- Verified: resuming one session in two terminals without forking interleaves the transcript.
- Verified: `--bare` and `--safe-mode` skip plugins and hooks. `--include-hook-events` works with stream-json output. `--debug-file <path>` and `--debug[=filter]` exist. `--init-only` runs SessionStart hooks, then exits.
- Verified: `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`, `CLAUDE_CODE_PROJECT_DIR_NAME`.
- Not found: `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, `CLAUDE_EFFORT` (use the hook's `effort` field). Not used.
- Unverified: `~/.claude/debug/<session-id>.txt` as the debug log location; subagent transcript paths; `ppid` semantics.

**Tools** (https://code.claude.com/docs/en/tools-reference)
- Verified names: `Agent` (subagent), `Bash`, `PowerShell`, `Monitor`, `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `EnterPlanMode`, `ExitPlanMode`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskStop`, `TodoWrite` (off by default in favour of the Task tools).
- Not listed: `LS`, `MultiEdit`, `NotebookRead`, `BashOutput`, `KillShell`. `TaskOutput` was removed in v2.1.277.
- Unverified: the `Agent` input field names (`subagent_type`, `description`).

**Environment** (https://code.claude.com/docs/en/env-vars)
- Verified: `CLAUDE_CODE_DEBUG_LOG_LEVEL` (values verbose, debug, info, warn, error); `CLAUDE_CODE_EFFORT_LEVEL`. No documented variable disables hooks.

**Repo (checked 2026-10-17)**
- `packages/runtime/src/recorder.ts`: `build()` sets timestamp from the runtime clock and builds the envelope field by field; `createRun` throws on an existing id; `recoverInterrupted` has no mode filter and writes `runtime_restarted`.
- `packages/runtime/src/run-manager.ts`: one active slot; `RunConflictError` (409); `requireActive` returns 409 or 404.
- `packages/runtime/src/http/app.ts`: Host guard; `/api/*` CORS and JSON check; Origin check on POST; no body limit.
- `packages/runtime/src/cli.ts`: `runtime.pid` lock; commands are `serve` and `demo` only.
- `packages/runtime/src/store/migrations.ts`: one migration. `store/db.ts`: WAL, `synchronous = FULL`, foreign keys on, migrations in transactions, `tx()` not re-entrant.
- `packages/events/src/payloads.ts`: the required fields listed in §5; `AdapterInfo.kind` is `scripted | llm`.
- `packages/events/src/parse.ts`: `parseKnownEvent` rejects unknown types. `redact.ts`: pattern list is not exported. `protocol.ts`: port 4317, host 127.0.0.1.
- `packages/runtime/src/adapter.ts`: `run.*`, `tool.*`, `artifact.*` are runtime-only.
- `packages/core/src/reduce-execution.ts`: `finishCall` and the exhaustive handler map. `packages/world-engine/src/intent.ts`: priority order. `reduce-world.ts`: `updateIntents` compares activity and task only, `homeFor` BFS, `reserve` overflow queuing. `definition.ts`: `ActivityRuleSchema` has no category yet.
- `worlds/research-campus/world.json`: activity rules begin at about line 171 with the permission rule; `defaultPreset` is `operator`; stations are library×2, build×2, test×2, ops×1, gate×1.
- Studio: `components/Sidebar.tsx` (demo button disabled when `activeRunId` is set, line 54); `state/hooks.ts` (line 49); `state/view.ts` (`KIND_LABEL`); `scene/layout.ts` (`incidentStationId` uses task kind only, lines 240–255); `components/AgentFlow.tsx` (coordinator wording); `components/WorldView.tsx` (demo copy); `state/connect.ts` (`getAllEvents`); `scene/Character.tsx` (the draft's `components/Character.tsx` path is wrong); `state/timeline.ts`, `components/MetadataPanel.tsx`, `components/LogsPanel.tsx`, `components/ReplayBar.tsx`, `components/RunHeader.tsx` all exist.
- Root `package.json`: `engines.node` is `>=22.16`; `packageManager` is `pnpm@10.28.0`. `pnpm-workspace.yaml` lists `apps/*` and `packages/*`. `vitest.config.ts` lists `packages/*` and `apps/studio`.
