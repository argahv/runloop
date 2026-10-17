# Architecture overview

> Updated 2026-10-17. Paths are relative to the repo root.

Runloop records agent runs as an append-only event log on the local machine. It derives a world simulation from that log and draws it in a browser Studio. Everything runs on loopback; nothing leaves the machine.

## Three layers

| Layer | What it is | Where | Rule |
|---|---|---|---|
| 1. Execution truth | The event log and the state folded from it: runs, agents, tasks, tool calls, permissions, artifacts, incidents | `packages/events`, `packages/core` | Append-only. A tool result exists only if a tool ran (executed runs) or the source reported it (traced runs). |
| 2. World simulation | Where each character is, where it walks and what it is doing | `packages/world-engine` | A pure function of layer 1 and a world definition. Deterministic, with no clock reads. |
| 3. Presentation | The Studio: 3D scene, Network graph, timeline, inspector, metrics | `apps/studio` | Reads layers 1 and 2. Never writes back. |

`packages/replay` combines layers 1 and 2. `ReplayIndex.stateAt(seq)` is identical to the live fold, so live view and replay cannot disagree.

## Packages

```
@runloop-world/events        zod schemas, parse (lenient/strict), redaction, SequenceBuffer, HTTP/SSE/ingest contract
        ▲
@runloop-world/core          reduceExecution / foldExecution (Layer 1), selectors, formatEvent
        ▲
@runloop-world/world-engine  world definition, BFS grid paths, motion, deriveIntent, reduceWorld (Layer 2)
        ▲
@runloop-world/replay        reduceRun (L1 + L2), ReplayIndex (snapshots every 50 events)
        ▲
apps/studio                  Next.js static export, zustand store, React Three Fiber scene, SVG Network graph

@runloop-world/runtime       Recorder (SQLite), RunManager, tool sandbox, Claude Code tracer, Hono HTTP + SSE, CLI
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

## Storage

SQLite through `node:sqlite` (`packages/runtime/src/store/`), with WAL, `synchronous = FULL` and foreign keys on.

| Table | Holds |
|---|---|
| `runs` | One row per run: status, title, mission, world. For traced runs also mode, source kind, session id, segment, project label and last event time (migration 1). |
| `events` | The log: one row per event, unique by `(run_id, sequence)` |
| `artifacts` | Artifact metadata. Bytes live in `<data>/artifacts/<runId>/<artifactId>`, checked against their sha256 when served. |
| `trace_ingest` | Dedupe keys per Claude Code session (`pre:<id>`, `post:<id>`, `prompt:<id>`, `delivery:<id>`…), inserted in the same transaction as the events they produced |

The recorder's order is redact → sequence → validate → persist → publish. Nothing is published before it is durable. Migrations are append-only (`MIGRATIONS[n]`).

## Runtime API

The contract is `packages/events/src/protocol.ts`, and the route table is in `packages/runtime/README.md`. In short:
- **Health:** `GET /api/health` returns `activeRunId` (scripted only), `tracedRunIds` and `ingest`.
- **Runs:** `GET /api/runs` and `GET /api/runs/:id`.
- **Events:** `GET /api/runs/:id/events` pages the log; `GET /api/runs/:id/stream` is SSE, resumable with `Last-Event-ID`.
- **Control:** `POST /api/runs` starts a scripted run. `POST /api/runs/:id/{stop,pause,resume}` controls it; traced runs answer 409.
- **Ingest:** `POST /api/ingest/claude-code` takes hook envelopes and needs the ingest token.

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

- **Network:** loopback only, with a Host header guard. Browser origins are allowlisted for reads and control. Ingest rejects any `Origin`.
- **Writes from other processes:** only through ingest, with the per-user token (`~/.config/runloop/ingest-token`, mode 0600), body and rate limits, and schema validation.
- **Reads:** unauthenticated for local processes (known limitation).
- **Secrets:** redacted before persistence. The plugin redacts first (well-known token shapes, credential `key=value` and headers, URL passwords, shell flags such as `-p`/`--password`, and the literal values of those secrets wherever else they appear), the trace manager again on arrival, the recorder again. A redacted event's visibility becomes `redacted`. Shell commands are stored as `sensitive`. Bare positional passwords (e.g. `tool login hunter2`) are not recognised.
- **Sandbox:** `run_command` in executed runs is not isolated (known limitation; see `packages/runtime/README.md`).
