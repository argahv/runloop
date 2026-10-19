# Architecture overview

> Updated 2026-10-18 (the town: world simulation, agents as buildings, dispatch). Paths are relative to the repo root. The plan of record for the town is [world-simulation.md](world-simulation.md).

Runloop is a persistent town where simulated residents and real AI agents coexist (DL-009). Underneath, it records agent runs as an append-only event log on the local machine, derives a run diorama from that log, and keeps a second append-only log for the town itself. The Studio draws both in the browser. Everything runs on loopback and Runloop sends nothing off the machine; a task you dispatch is Claude Code itself talking to Anthropic, after you approve it.

## Three layers

| Layer | What it is | Where | Rule |
|---|---|---|---|
| 1. Execution truth | The event log and the state folded from it: runs, agents, tasks, tool calls, permissions, artifacts, incidents | `packages/events`, `packages/core` | Append-only. A tool result exists only if a tool ran (executed runs) or the source reported it (traced runs). |
| 2. World simulation | Where each character is, where it walks and what it is doing | `packages/world-engine` | A pure function of layer 1 and a world definition. Deterministic, with no clock reads. |
| 3. Presentation | The Studio: 3D scene, Network graph, timeline, inspector, metrics, run compare | `apps/studio` | Reads layers 1 and 2. Never writes back to them (pinning a baseline is run metadata, not an event). |

`packages/replay` combines layers 1 and 2. `ReplayIndex.stateAt(seq)` is identical to the live fold, so live view and replay cannot disagree.

## The world layer (the town)

The town sits beside the three layers, with its own log and the same discipline:

| Part | What it is | Where | Rule |
|---|---|---|---|
| Contracts | World commands, 15 world event types, provenance, snapshot, HTTP/SSE types | `packages/events/src/world.ts`, `world-protocol.ts` | Every event has a provenance: `simulation`, `user`, `external-agent`, `system` or `inferred`. |
| Town | The Commons' map: districts, roads, lots, 28 buildings with interiors, spots, agent lots; compiled to a raster with one BFS field per door | `packages/town`, `worlds/runloop-commons/` | Pure (no clock, no randomness); a content hash pins the town a world was created with. |
| Simulation | Residents with needs, schedules and traits deciding by integer scoring; `applyEvent` is the only mutator; `explain`, `WorldReplay` | `packages/sim` | Pure and deterministic: same seed and commands, same log hash, across processes and restarts. |
| Host | Ticks the sim (1 tick = 1 sim minute, speeds 0/1/4/16), applies commands, commits then publishes, checkpoints, resumes | `packages/runtime/src/world/` | The only clock reader. While Runloop is off, the town does not live; it resumes with `world.resumed_after_offline`. |
| Agents | Real Claude Code agents as buildings: registry, session binding, health, the projector from run events to world commands | `packages/runtime/src/agents/`, `world/projector.ts` | Agent events cite the run events behind them (`cause`); the world never runs or changes an agent. |
| Dispatch | Assign a task to a real agent: preview, approve, spawn `claude -p`, follow, cancel | `packages/runtime/src/dispatch/` | Nothing runs without the user's approval of the exact command (single-use nonce). |
| Studio | `/` is the town: 3D renderer, panels, Why, World Log, Add to World, Assign task | `apps/studio/src/{world,town,components/world,components/panels,components/agents}` | Folds the same events with the same `applyEvent`; commands are never optimistic. |

```
Claude Code hooks ─► tracer (unchanged) ─► run log ─► projector ─► world commands (external-agent / system)
Studio (you)     ─► POST /api/world/commands (always user) ──────────────────────┐
                                                                                  ▼
                              WorldHost: validate (ALLOWED_SOURCES) ─► sim step ─► commit (world_events) ─► SSE
                                                                                  ▼
                              Studio: snapshot + event batches ─► applyEvent ─► town, panels, World Log
```

Simulated residents are labelled ◇ Simulated, and their Why is built only from the recorded `resident.decided`. "Real" appears only on external-agent entities. The workspace folder's absolute path is stored once (`workspace_roots`) and never appears in the world, its events or any API response (P8). The truth rules P1–P11 of the plan are each a test.

## Packages

```
@runloop-world/events        zod schemas, parse (lenient/strict), redaction, SequenceBuffer, HTTP/SSE/ingest contract
        ▲
@runloop-world/core          reduceExecution / foldExecution (Layer 1), selectors, formatEvent, summarizeRun / diffRuns (compare)
        ▲
@runloop-world/world-engine  world definition, BFS grid paths, motion, deriveIntent, reduceWorld (Layer 2)
        ▲
@runloop-world/replay        reduceRun (L1 + L2), ReplayIndex (snapshots every 50 events)
        ▲
apps/studio                  Next.js static export, zustand store, React Three Fiber scene, SVG Network graph

@runloop-world/town          town schema, compile, raster, navigation fields, lots, decoration (pure)
@runloop-world/sim           needs, schedules, decisions, step, applyEvent, explain, WorldReplay (pure)
@runloop-world/runtime       Recorder (SQLite), RunManager, tool sandbox, Claude Code tracer, WorldHost, agents, dispatch, Hono HTTP + SSE, CLI
integrations/claude-code-plugin   self-contained Node script for Claude Code hooks (no workspace imports)
@runloop-world/testkit       canonical demo fixture and builders for tests
```

## Two kinds of run

| | Executed | Traced |
|---|---|---|
| Who ran the tools | Runloop's runtime (sandboxed tool invoker) | The external agent (Claude Code) |
| Who decides | An adapter (today: the scripted coding mission) | The external agent |
| How events arrive | `RunContext.emit` and `tools.invoke` in-process | Plugin hooks → `POST /api/ingest/claude-code` |
| `run.started.mode` | `executed` (or absent) | `traced`, with `source` and an `external` adapter |
| Provenance on events | absent (Runloop observed it) | `reported` or `inferred` on every event |
| Controls | stop, pause, resume | none (409: "controlled by Claude Code") |
| Concurrency | one active scripted run | any number of sessions, alongside a scripted run |

## Data flow

**Executed run (scripted demo)**
```
POST /api/runs ─► RunManager.start ─► copy examples/<mission>/repo → <data>/workspaces/<runId>
                                   ─► Recorder.createRun (run.started)
                                   ─► adapter.run(ctx)
                                        ctx.emit(agent.* / task.*) ──┐
                                        ctx.tools.invoke(...)  ──────┤─► Recorder.append ─► EventBus ─► SSE
                                   ─► run.completed                  │
```
Adapters may emit only `agent.*` and `task.*`. `run.*`, `tool.*` and `artifact.*` come from the runtime, so an adapter cannot fabricate a tool result (`packages/runtime/src/adapter.ts`).

**Traced run (Claude Code)**
```
Claude Code hook ─► node runloop-hook.mjs: slim + redact (secrets masked before any cut) → spool file → POST the spool oldest first (this event last), exit 0
                 ─► /api/ingest/claude-code: Host guard → no Origin → JSON → 1 MiB → token → zod → rate limit
                 ─► TraceSessionManager: dedupe (trace_ingest) → mapHook (pure) → Recorder.recordBatch (one transaction)
                 ─► EventBus ─► SSE
```
One run per session segment, created lazily on the first prompt, tool, permission or subagent event. The mapper is late-tolerant: a result without a start synthesises the start (inferred), and a late start is ignored. An idle sweep closes sessions that delivered nothing for 120 minutes of wall-clock time (a late spooled backlog counts as delivery). After a runtime restart, the next hook opens segment n+1. Details are in `docs/plans/claude-code-tracer.md` and `packages/runtime/README.md`.

**Studio**
```
GET /api/runs/:id ─► world definition       GET /api/runs/:id/events ─► backlog
GET /api/runs/:id/stream (SSE, resumable) ─► SequenceBuffer (orders by sequence) ─► ReplayIndex ─► store
store ─► playhead (live or replay) ─► RunState at the playhead ─► 3D scene / Network graph / timeline / inspector
```
One selection (run, event, agent) drives the world, timeline, inspector and URL (`?run=&view=&event=&agent=`). Polling `/api/health` and `/api/runs` keeps the run lists fresh. When nothing is open, the Studio opens the active demo run, else the newest live traced session, else the newest run.

**Compare (Experiments, DL-008)**
```
GET /api/runs (pinnedAt) ─► pair: ?a=<baseline>&b=<candidate>, defaulting to the newest pin and the newest other run of the same task
GET /api/runs/:id/events (paged, both runs) ─► foldExecution ─► summarizeRun ─► diffRuns ─► Experiments page
```
`summarizeRun` and `diffRuns` (`packages/core/src/compare.ts`) are pure. Every field carries `{a, b, delta, comparable, note}`. A value a side did not report is never compared and never shown as 0; the note says why (not reported, still recording, tokens reported for different agents, executed vs traced, demo pace). Test runs, failures, files, categories, usage reports and the divergence link to their events in Traces.

## Storage

SQLite through `node:sqlite` (`packages/runtime/src/store/`), with WAL, `synchronous = FULL` and foreign keys on.

| Table | Holds |
|---|---|
| `runs` | One row per run: status, title, mission, world. For traced runs also mode, source kind, session id, segment, project label and last event time (migration 1). `pinned_at` marks a baseline (migration 2). |
| `events` | The log: one row per event, unique by `(run_id, sequence)` |
| `artifacts` | Artifact metadata. Bytes live in `<data>/artifacts/<runId>/<artifactId>`, checked against their sha256 when served. |
| `trace_ingest` | Dedupe keys per Claude Code session (`pre:<id>`, `post:<id>`, `prompt:<id>`, `delivery:<id>`…), inserted in the same transaction as the events they produced |
| `worlds`, `world_events`, `world_checkpoints` | The town (migration 3): the world row (town JSON, seed, tick, speed), its event log (unique `cmd_id`, so a command applies once) and gzipped checkpoints (latest 24 plus one a day for 14 days; ambient events kept 3 sim days) |
| `agents`, `workspaces`, `workspace_roots`, `agent_connections`, `session_bindings`, `org_policies`, `audit_log`, `dispatches` | Real agents (migration 4). Absolute paths live only in `workspace_roots`, read only by `agents/local-roots.ts`. Every Add to World, binding and dispatch step is in `audit_log`. |

The recorder's order is redact → sequence → validate → persist → publish. Nothing is published before it is durable. Migrations are append-only (`MIGRATIONS[n]`).

## Runtime API

The contract is `packages/events/src/protocol.ts`, and the route table is in `packages/runtime/README.md`. In short:
- **Health:** `GET /api/health` returns `activeRunId` (scripted only), `tracedRunIds` and `ingest`.
- **Runs:** `GET /api/runs` and `GET /api/runs/:id`.
- **Events:** `GET /api/runs/:id/events` pages the log; `GET /api/runs/:id/stream` is SSE, resumable with `Last-Event-ID`.
- **Control:** `POST /api/runs` starts a scripted run. `POST /api/runs/:id/{stop,pause,resume}` controls it; traced runs answer 409.
- **Baselines:** `POST /api/runs/:id/baseline` pins a run (idempotent; it keeps its first `pinnedAt`), `DELETE` unpins it. Both need JSON and an allowed Origin, like every write. `RunSummary.pinnedAt` carries the pin.
- **Ingest:** `POST /api/ingest/claude-code` takes hook envelopes and needs the ingest token.
- **World:** `GET /api/world`, `/api/world/town`, `/api/world/snapshot`, `/api/world/events`, `/api/world/explain`; `GET /api/world/stream` (SSE: a snapshot, then event batches with `id` = world seq, a clock frame every second; a client more than 5 000 events behind gets a fresh snapshot); `POST /api/world/commands` (`{id, command}`, always `user`). `RUNLOOP_WORLD=off` answers 404 on every world, agent and dispatch route.
- **Agents:** `GET|POST /api/agents`, `GET /api/agents/:id`, `GET /api/agents/arrivals`, `POST /api/agents/:id/claim`.
- **Dispatch:** `GET /api/dispatches/policy`, `POST /api/agents/:id/dispatches/preview`, `POST /api/dispatches` (approve: needs an allowed Origin and the nonce), `GET /api/dispatches[/:id[/stream]]`, `POST /api/dispatches/:id/cancel`. `RUNLOOP_DISPATCH=off` turns them off.

## Adapters and integrations

There are two ways to get a run into Runloop:
1. **An in-process adapter** (`packages/runtime/src/adapter.ts`). It receives a `RunContext`, decides what to do, emits `agent.*` and `task.*`, and calls tools through `ctx.tools.invoke`. Runloop runs the tools and records their real results. The scripted coding mission is the only adapter today. An LLM adapter would need a real command sandbox first (task A5).
2. **A traced source.** The agent runs elsewhere and posts what it observed. The Claude Code plugin is the first one. A new source needs:
   - a transport (hooks, an SDK callback);
   - an ingest route with the same guards;
   - a pure mapper from its payloads to event drafts with `provenance`;
   - fixtures and golden tests.

   The event contract it must produce is in [event-model.md](event-model.md). Codex CLI hooks (task E2) are the next planned source.

## Trust boundaries

- **Network:** loopback only, with a Host header guard. Browser origins are allowlisted for reads, control and baselines (POST and DELETE need JSON and an allowed Origin). Ingest rejects any `Origin`.
- **Writes from other processes:** only through ingest, with the per-user token (`~/.config/runloop/ingest-token`, mode 0600), body and rate limits, and schema validation.
- **Reads:** unauthenticated for local processes (known limitation).
- **Secrets:** redacted before persistence. The plugin redacts first (well-known token shapes, credential `key=value` and headers, URL passwords, shell flags such as `-p`/`--password`, and the literal values of those secrets wherever else they appear), the trace manager again on arrival, the recorder again. A redacted event's visibility becomes `redacted`. Shell commands are stored as `sensitive`. Bare positional passwords (e.g. `tool login hunter2`) are not recognised.
- **Sandbox:** `run_command` in executed runs is not isolated (known limitation; see `packages/runtime/README.md`).
- **Dispatch:** a task runs only after the user approves the exact argv, cwd, executable and environment variable names (a single-use nonce, 5 minutes, bound to their hash), from an allowed Origin. `claude -p` runs with `--permission-mode dontAsk` and the preset's allowlist (Read-only: `Read Grep Glob`; Edit+test adds `Edit Write "Bash(pnpm test:*)"`), a budget Claude Code enforces, a timeout Runloop enforces, `shell: false`, its own process group, and only `PATH`, `HOME`, `ANTHROPIC_API_KEY`, `RUNLOOP_URL`, `RUNLOOP_INGEST_TOKEN_FILE` and names listed in `RUNLOOP_DISPATCH_ENV`. Edits land in your working tree; cost is billed to your Anthropic account.
