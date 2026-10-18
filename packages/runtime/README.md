# @runloop-world/runtime

The local runtime. It runs missions with real tools, records Claude Code sessions traced by the plugin, stores every event in SQLite, and serves the log over HTTP and SSE to Studio.

```sh
pnpm serve                    # API on http://127.0.0.1:4380
pnpm demo                     # run the coding mission headless and print the trace
pnpm demo -- --speed 0        # same, with no pacing delays
pnpm demo -- --keep           # keep serving the API after the run ends
```

Environment variables:
- **`RUNLOOP_DATA_DIR`** sets the data directory (default `<repo>/.runloop`). It holds `runloop.db`, `artifacts/<runId>/<artifactId>` and `workspaces/<runId>/`.
- **`RUNLOOP_ALLOWED_ORIGINS`** adds browser origins to the defaults (`http://localhost:3000` and `http://127.0.0.1:3000`).
- **`RUNLOOP_TRACE=off`** turns off Claude Code ingest (the route is not served).
- **`RUNLOOP_TRACE_IDLE_MINUTES`** closes a traced session after this long without events (default 120).
- **`RUNLOOP_INGEST_TOKEN_FILE`** overrides the ingest token file (default `$XDG_CONFIG_HOME/runloop/ingest-token`, else `~/.config/runloop/ingest-token`; `%APPDATA%\runloop\ingest-token` on Windows). The runtime creates it (32 random bytes, mode 0600) when it starts.

The port is 4380 (not 4317, the OTLP/gRPC port; DL-005). Override it with `--port`.

Only one runtime process may use a data dir at a time; `runtime.pid` acts as the lock.

## How a run flows

```
RunManager.start ─► copy examples/<mission>/repo → workspaces/<runId>
                 ─► Recorder.createRun (run.started)
                 ─► adapter.run(ctx, mission)            (background)
                        ctx.emit(agent.*/task.*)         ─┐
                        ctx.tools.invoke(...)            ─┤─► Recorder.append ─► EventBus ─► SSE / CLI trace
                        ctx.pace(ms)                      │
                 ─► run.completed {succeeded|failed|stopped}
boot             ─► Recorder.recoverInterrupted()        (runs left "running" → interrupted)
```

Recovery stamps its `tool.call_failed{runtime_restarted}` and `run.completed{interrupted}` events with the run's last recorded activity, not the restart time, so a replay of an interrupted run does not stretch over the downtime. The summary says when the run was recovered.

### Recorder (`src/recorder.ts`)

`append` is synchronous and runs these steps in order:
1. Redact secrets.
2. Assign the next sequence.
3. Validate with `parseKnownEvent`. An invalid event throws here and consumes no sequence.
4. In one transaction, insert the event and update the run row.
5. Publish to the bus.

Nothing is published before it is durable.

### Adapters (`src/adapter.ts`)

Adapters may only emit `agent.*` and `task.*` events:
- `run.*` comes from the run manager.
- `tool.*` and `artifact.*` come from the tool invoker.

So an adapter cannot fabricate a tool result or an artifact: those are produced by the runtime. Task and run outcomes are different: `task.completed`, `task.failed` and the final `run.completed` outcome and summary are the adapter's **claims**, recorded as made. The run manager only checks that a `task.completed` cites artifact ids this run actually recorded; it cannot tell whether "all tests pass" is true. Read claims against the tool results they rest on.

Every `tool.call_started` gets exactly one terminal event, linked by `parentEventId`:
- **`tool.call_completed`:** the tool ran. A failing test run is `status: error` with its real metrics.
- **`tool.call_failed`:** the tool could not run (denied, timeout, aborted, spawn_error, exception or runtime_restarted).

### Sandbox (`src/sandbox/`)

- Paths are resolved inside the workspace, and realpath catches symlink escapes.
- Reads and writes are capped at 256 KB; listings at 500 entries.
- `run_command` allows only the exact argv `node --test --test-reporter=tap`. It runs as `process.execPath` with `shell: false` and a minimal env, has a 30 s timeout, and its process group is SIGKILLed on timeout or abort.
- **This is not isolation.** `node --test` executes the workspace's JavaScript as your user. That code can read the runtime's environment through `/proc/<pid>/environ` and write anywhere you can, including the data dir. It is fine for the scripted demo, whose code is fixed. Run commands in a real sandbox (a container, bubblewrap or nsjail without access to the data dir) before connecting an adapter that writes code of its own.
- Artifact bytes are checked against the sha256 recorded in `artifact.created` whenever they are served; changed bytes get a 409 instead of being shown.

### Scripted coding mission (`src/adapters/scripted-coding-mission.ts`)

The decisions are scripted; the tool results are real. See `examples/coding-mission/README.md`.

## Traced runs (Claude Code)

The plugin in `integrations/claude-code-plugin` posts each Claude Code hook event to `POST /api/ingest/claude-code`. The plan is `docs/plans/claude-code-tracer.md`; the code is `src/tracers/claude-code/`.

```
envelope ─► dedupe (trace_ingest) ─► slimHook ─► mapHook (pure) ─► Recorder.recordBatch (one transaction) ─► EventBus ─► SSE
```

- **One run per session segment**, created lazily by the first prompt, tool, permission or subagent event. Run ids are UUIDv5 of `claude-code:<session_id>:<segment>`. Traced runs never use the scripted run slot, so they run alongside the demo.
- **Agents:** `user` (no character), `main` (preset `claude`) and `sa-<agent_id>` for subagents. Hooks fired inside a subagent carry `agent_id`, so its calls are attributed to it. At most 8 subagents get a character (presets `subagent-1`..`subagent-8`, by order of appearance); the rest are traced without one.
- **Provenance:** every traced event is `reported` (Claude Code said it) or `inferred` (Runloop reconstructed it, e.g. a permission that was never followed by a result is closed as denied at the next PostToolBatch, later PreToolUse of the same agent after its batch ended, Stop, prompt, SubagentStop, SessionEnd or idle sweep; a subagent linked to the `Agent` call that started it by matching description/type, and a delegated task's completion).
- **Usage:** a subagent's tokens come from the `Agent` tool result (`agent.usage_reported`, source `claude-code.agent_result`). Hooks do not report the main agent's usage, so it has none (never zero).
- **Out-of-order delivery** is tolerated: a result without a start synthesises the start (inferred); a late start is ignored; deliveries observed before the run closed are dropped.
- **Restart:** boot recovery closes open traced runs with `tool.call_failed{unobserved}` and `run.completed{interrupted}`, both inferred. The next hook opens segment n+1 (`source.continuesRunId`).
- **Idle sweep:** every 60 s, a session that delivered nothing for `RUNLOOP_TRACE_IDLE_MINUTES` of wall-clock time is closed as interrupted (inferred), stamped at its last observed event. Idleness counts from arrival, not from `observedAt`, so a spooled backlog flushed late is not swept as it arrives.
- **Recorder guards:** executed runs reject drafts with `provenance` or `timestamp`; traced runs need a provenance on `tool.*` events, and their timestamps (the hook's `observedAt`) are clamped to `[run.started, now]`.

## HTTP API

The contract is `packages/events/src/protocol.ts`. Every request needs a `localhost` or `127.0.0.1` Host header. POSTs and DELETEs need `Content-Type: application/json` and, when an `Origin` is sent, an allowed origin.

| Route | Result |
| --- | --- |
| `GET /api/health` | `{ ok, version, activeRunId, tracedRunIds, ingest }`. `activeRunId` is the scripted run only. |
| `GET /api/runs` | `{ runs }`, newest first |
| `POST /api/runs` `{ missionId, speed? }` | 202 `{ runId }`. 409 if a run is active, 404 for an unknown mission. The speed (default 1) is recorded in `run.started.speed`, so compare does not judge durations of runs at different paces. |
| `GET /api/runs/:id` | `{ run, world }`, where `world` is `worlds/<worldId>/world.json`, validated |
| `GET /api/runs/:id/events?after&limit` | `{ events, nextAfter, hasMore }` (limit ≤ 1000) |
| `GET /api/runs/:id/stream` | SSE. Resume with `Last-Event-ID` or `?after`. Sends `: ping` every 15 s and an `end` event when the run is terminal. |
| `POST /api/runs/:id/{stop,pause,resume}` | 202 `{ run }`, or 409 if the run is not active (always 409 for traced runs: Claude Code controls them) |
| `POST /api/runs/:id/baseline` `{}` | 200 `{ run }` with `pinnedAt` set: the run is a baseline (idempotent; any run, any state). 404 for an unknown run. Stored in `runs.pinned_at` (migration 2); the event log is untouched. |
| `DELETE /api/runs/:id/baseline` `{}` | 200 `{ run }` with `pinnedAt: null` |
| `POST /api/ingest/claude-code` `{ envelopes }` | 202 `{ accepted, duplicates, ignored }`. Needs `X-Runloop-Token`. 403 with any `Origin`, 413 over 1 MiB, 401 bad token, 400 invalid or unknown protocol version (`supported: [1]`), 429 over 100 events/s per session (burst 1000). |
| `GET /api/runs/:id/artifacts/:artifactId` | The stored bytes, with their media type. 409 if they no longer match the recorded sha256. |

## Tests

```sh
pnpm vitest run --project runtime
pnpm --filter @runloop-world/runtime typecheck
```

`test/coding-mission.int.test.ts` runs the real mission at speed 0 and checks the result against `@runloop-world/testkit`'s canonical fixture: the event types, envelope refs and payload fields must all match.

Tracer tests use the hook payloads in `test/fixtures/claude-code/` (real probe sessions, sanitised, plus `synthetic-*` edge cases):
- `claude-code-mapper.test.ts` folds each fixture into a run, compares it with `<fixture>.golden.txt`, and checks the invariants (no anomalies, one terminal event per call, subagent attribution, usage, no absolute paths, valid world placement). Update the goldens with `pnpm vitest run --project runtime -u` and review the diff.
- `claude-code-plugin.e2e.test.ts` pipes every fixture line through the real plugin script into a live runtime, including an offline spool and flush.
- `ingest.test.ts` covers the HTTP guards, dedupe, concurrent sessions, coexistence with the demo, restart and the idle sweep.
