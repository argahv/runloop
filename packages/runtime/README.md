# @runloop-world/runtime

The local runtime. It runs missions with real tools, records every event to SQLite, and serves the log over HTTP and SSE to Studio.

```sh
pnpm serve                    # API on http://127.0.0.1:4317
pnpm demo                     # run the coding mission headless and print the trace
pnpm demo -- --speed 0        # same, with no pacing delays
pnpm demo -- --keep           # keep serving the API after the run ends
```

Environment variables:
- **`RUNLOOP_DATA_DIR`** sets the data directory (default `<repo>/.runloop`). It holds `runloop.db`, `artifacts/<runId>/<artifactId>` and `workspaces/<runId>/`.
- **`RUNLOOP_ALLOWED_ORIGINS`** adds browser origins to the defaults (`http://localhost:3000` and `http://127.0.0.1:3000`).

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

So an adapter cannot fabricate a tool result or an outcome. Every `tool.call_started` gets exactly one terminal event, linked by `parentEventId`:
- **`tool.call_completed`:** the tool ran. A failing test run is `status: error` with its real metrics.
- **`tool.call_failed`:** the tool could not run (denied, timeout, aborted, spawn_error, exception or runtime_restarted).

### Sandbox (`src/sandbox/`)

- Paths are resolved inside the workspace, and realpath catches symlink escapes.
- Reads and writes are capped at 256 KB; listings at 500 entries.
- `run_command` allows only the exact argv `node --test --test-reporter=tap`. It runs as `process.execPath` with `shell: false` and a minimal env, has a 30 s timeout, and its process group is SIGKILLed on timeout or abort.

### Scripted coding mission (`src/adapters/scripted-coding-mission.ts`)

The decisions are scripted; the tool results are real. See `examples/coding-mission/README.md`.

## HTTP API

The contract is `packages/events/src/protocol.ts`. Every request needs a `localhost` or `127.0.0.1` Host header. POSTs need `Content-Type: application/json` and, when an `Origin` is sent, an allowed origin.

| Route | Result |
| --- | --- |
| `GET /api/health` | `{ ok, version, activeRunId }` |
| `GET /api/runs` | `{ runs }`, newest first |
| `POST /api/runs` `{ missionId, speed? }` | 202 `{ runId }`. 409 if a run is active, 404 for an unknown mission. |
| `GET /api/runs/:id` | `{ run, world }`, where `world` is `worlds/<worldId>/world.json`, validated |
| `GET /api/runs/:id/events?after&limit` | `{ events, nextAfter, hasMore }` (limit ≤ 1000) |
| `GET /api/runs/:id/stream` | SSE. Resume with `Last-Event-ID` or `?after`. Sends `: ping` every 15 s and an `end` event when the run is terminal. |
| `POST /api/runs/:id/{stop,pause,resume}` | 202 `{ run }`, or 409 if the run is not active |
| `GET /api/runs/:id/artifacts/:artifactId` | The stored bytes, with their media type |

## Tests

```sh
pnpm vitest run --project runtime
pnpm --filter @runloop-world/runtime typecheck
```

`test/coding-mission.int.test.ts` runs the real mission at speed 0 and checks the result against `@runloop-world/testkit`'s canonical fixture: the event types, envelope refs and payload fields must all match.
