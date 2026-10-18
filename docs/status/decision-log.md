# Decision log

Short records of consequential decisions. Newest first. Each entry gives the problem, the options, the choice, why it was chosen, the trade-off, and how to reverse it.

---

## DL-012 · Real agents in the town: observe by default, dispatch only with approval (2026-10-18)

**Problem.** The town must show real Claude Code agents next to simulated residents without blurring the two, and may let the user hand an agent a task without giving Runloop a way to run code silently.

**Options.**
- Bind sessions to agents with pairing codes, or by the session's working directory.
- Dispatch with `--permission-mode bypassPermissions`, or with `dontAsk` and an allowlist of tools.
- Dispatch on request, or only after the user approves the exact command.

**Choice.**
- An agent is a building in the Agent District, added by the user ("Add to World") with one workspace folder. A session binds to it by dispatch session id, else by the longest `realpath(cwd)` prefix, else it waits in **Arrivals** for a manual claim (which backfills its earlier runs). The folder's absolute path is stored once (`workspace_roots`) and never returned, logged or put in the world.
- The world shows only what the hooks reported: `external-agent` events (observed) or `inferred` ones, each citing the run events behind it. Health has six states (`not_connected`, `awaiting_first_event`, `live`, `idle`, `offline`, `unknown`); an agent with no events is never live and a restart reads offline.
- **Dispatch** previews the exact `claude -p` argv, environment variable names and budget; nothing runs until the user approves with a single-use nonce bound to that argv, cwd and executable. `dontAsk` with the preset's tool allowlist, haiku by default, a budget Claude Code enforces, a timeout Runloop enforces, its own process group, an audit row per step. `--plugin-dir` is added unless `claude plugin list` reports the tracer installed.

**Why.** The working directory is already in every hook, so binding needs no setup; Arrivals cover the rest. Dispatch spends the user's money and edits their working tree, so the user sees and approves the exact command; `bypassPermissions` would let a task do anything.

**Trade-off.** Two folders that nest bind to the deeper one; a session from a moved folder becomes an Arrival. Claude Code offers no message or pause channel, so "message" and "control" read *unsupported*, with the reason. A cancelled or timed-out dispatch sends no SessionEnd; the tracer closes its run as interrupted (inferred).

**Reverse.** `RUNLOOP_DISPATCH=off` removes dispatch; `RUNLOOP_WORLD=off` removes agents and the town. Bindings live in `session_bindings` and can be recomputed.

## DL-011 · Town lighting follows the simulated clock (2026-10-18)

**Problem.** The town has a day. It needs light that reads in both themes, lit windows at night, and no lime (lime marks active execution only).

**Options.** A fixed studio light for both themes; light from the viewer's wall clock; light from the world's sim time.

**Choice.** Sim time drives the sun or moon, the hemisphere and ambient light (`apps/studio/src/town/sky.ts`, pure). Windows light up when a building is occupied, signs and street lamps glow at night, shadows are variance shadow maps updated only when the sun moves. Bloom is not used town-wide. A colour-distance test keeps the renderer's own materials away from lime.

**Why.** The clock is the world's most visible fact; if the sky disagreed with "Day 2 · 22:40" the town would be lying. Occupancy-driven windows make the simulation visible from the town view.

**Trade-off.** At night the town is darker; labels and chips carry the information. Some `town.json` palette colours sit near the warning and failure colours; only the renderer's materials are checked.

**Reverse.** `sky.ts` is the single input; a fixed light is a constant there.

## DL-010 · World simulation architecture (2026-10-18)

**Problem.** Build a persistent town (residents with needs and schedules, buildings, a clock) that is deterministic, replayable and honest, next to the existing run log and diorama.

**Options.**
- One merged world package, or new pure packages beside `world-engine`.
- Delta frames over SSE, or raw events folded by one `applyEvent` on both sides.
- Navigation by Dijkstra over anchor nodes, or one BFS field per door on a raster.

**Choice.** The plan of record, `docs/architecture/world-simulation.md`: contracts in `packages/events/src/world.ts`; `packages/town` (schema, compile, raster, nav) and `packages/sim` (needs, schedules, decisions, `applyEvent`, `explain`, `WorldReplay`) are pure, with no `Date`, `Math.random` or timers (a purity test enforces it); one tick is one sim minute, speeds `0|1|4|16`; `WorldHost` in the runtime is the only clock reader, commits batches before publishing, checkpoints and resumes; the Studio folds the same events with the same `applyEvent`. Every world event carries a provenance (`simulation`, `user`, `external-agent`, `system`, `inferred`); commands are checked against `ALLOWED_SOURCES`; HTTP commands are always `user`.

**Why.** The run log, recorder and replay already prove the pattern (one fold for live and replay). Keeping `world-engine` as the per-session diorama keeps `ReplayIndex.stateAt == live` for runs.

**Trade-off.** Event volume is above the plan's budget (~4.8k events and 1.6 MB per sim day at 120 residents); retention bounds what is stored. While Runloop is off the town does not live; it resumes and says so (`world.resumed_after_offline`).

**Reverse.** `RUNLOOP_WORLD=off` restores the previous runtime; migrations 3 and 4 only add tables.

## DL-009 · A world, not a dashboard (2026-10-18)

**Problem.** Runloop recorded and compared runs well, but as a set of pages. The founder brief (`docs/product/world-vision.md`) asks for a place: a persistent, populated town where real agents live and work, so the product is something people return to.

**Options.**
- Keep the run pages as the product and add the town as a view.
- Make the town the home (`/`), with the run pages one step away.

**Choice.** The town is the home. Simulated residents give it life; real agents are buildings in the Agent District; tracing, replay, Traces and Experiments stay and open from a building. "Real" appears only on external-agent entities, and a simulated resident's reasons come only from recorded decision events.

**Why.** A living place makes agent activity legible at a glance and gives a reason to come back; the existing capabilities lose nothing.

**Trade-off.** More to build and render before it pays off; novelty must not replace utility (buildings are one step from Traces and Compare).

**Reverse.** The run pages still work on their own (`/overview`, `/world?run=`, `/traces`, `/experiments`); `/` could point back to Overview.

## DL-013 · The light theme keeps a light world, styled as an architectural model (2026-10-18)

> Numbered DL-009 until the world-simulation integration (2026-10-18); renumbered so that the plan of record's DL-009–012 stay valid. Older notes that cite "DL-009" for the light theme mean this entry.


**Problem.** Task D10 made the world richer (key and rim light, tinted rooms, chibi robots). In the light theme the world had to stay readable without breaking the light interface around it.

**Options.**
- A dark stage inside the light UI (one world look for both themes).
- A light world: a white architectural model on a pale plinth.

**Choice.** A light world. Floors, walls and the slab use light tints of each environment; the board casts a soft drop shadow (light theme only); robots keep dark glass visors with state-coloured eyes, so they read on any floor. Lime still marks only active execution, and bloom stays dark-theme only.

**Why.** The light interface's layered surfaces, the DOM labels, the glass toolbars and the agent list are already styled for the light theme. A dark stage would be the one dark block in a light page.

**Trade-off.** The two themes look like two materials of the same model rather than one image; marketing captures should name the theme.

**Reverse.** The scene palette (`apps/studio/src/scene/palette.ts`) is derived per theme from tokens; a dark stage for light mode is a palette change.

## DL-008 · Run compare: baselines in the runtime, a pure diff in core (2026-10-18)

**Problem.** Milestone C: pin a run as a baseline, compare any two runs, and show exactly what differed without inventing data.

**Options.**
- Diff on the server (a `/compare` endpoint) or in the browser from the existing event pages.
- Store pins in browser storage, a `baselines` table, or a column on `runs`.
- Derive "files touched" from free-text input summaries, or add a structured field.

**Choice.**
- **Targets.** `tool.call_started` gains an optional `target`: the file for Read/Edit/Write/NotebookEdit, the directory for Grep/Glob, the command's first word for shell tools (never its arguments), and the workspace path or program for the scripted adapter's tools. Additive; provenance unchanged. Older logs have none, and compare says their file lists are incomplete.
- **Diff in `packages/core`** (`summarizeRun`, `diffRuns`), pure and unit-tested. The Studio folds both runs from the paged events API. Each field carries `{a, b, delta, comparable, note}`; a value one side did not report is never compared and never shown as 0. Notes say why: not reported, still recording, tokens reported for different agents, or executed vs traced.
- **First divergence**: the first index where the call sequences differ by category, tool and target, then by result (status and test counts), or where one run made more calls. Calls are compared in start order, all agents together. A target only one side reported is unknown, not different (so a log recorded before targets existed does not diverge at its first call).
- **Test names**: fixed and newly failing tests need the other side's failing names in full. "Failed along the way in one run only" needs every failing test of every test run on the other side to be named; otherwise it is not claimed and the page says how many failures were unnamed. (Found on real data: a piped `node --test | tail` named 1 of its 2 failures.)
- **Demo pacing**: `run.started.speed` records the scripted adapter's pacing. Durations of two executed runs at different speeds are not compared (`pace_differs`); when a speed was not recorded (older logs) the difference stands with a caveat (`pace_unknown`). (Found on real data: a speed-1 Studio run against a speed-0 CLI run read "25.8 s faster".)
- **Executed runs carry no category on the wire**, so compare uses the categories of Runloop's own tools (`read_file` → read, `write_file` → edit, `list_files` → search, `run_command` → execute, or test when it reported test counts). The Metrics panel uses the same mapping, so both pages agree. The world is unchanged.
- **Baselines**: `runs.pinned_at` (migration 2), `POST`/`DELETE /api/runs/:id/baseline` with the same JSON and Origin guards as other writes, `RunSummary.pinnedAt`. Several runs may be pinned; Experiments defaults to the newest pin against the newest other run of the same task. A run's "Compare" button uses only a pin of the same task.

**Why.** The event API already serves everything the diff needs, and a pure function is the easiest place to make the honesty rules testable. A column keeps pins next to the run and survives restarts, with no new join.

**Trade-off.**
- Two large runs are fetched and folded in the browser.
- Interleaved subagent calls can move the divergence point between runs that did the same work.
- Agents are matched by name.
- Shell commands that write files are not in the file lists.

**Reverse.** `diffRuns` is a pure function, so a server endpoint can call it. Pins can move to a table (with labels) through a new migration that copies `pinned_at`.

---

## DL-007 · Never override a status the source reported (2026-10-17)

**Problem.** In a real session, Haiku ran `node --test 2>&1 | tail -n 80`. The pipeline exits 0, so Claude Code reported the call as a success, while its output said "12 tests: 10 passed, 2 failed".

**Options.**
- Mark the call failed from the parsed counts.
- Keep the reported status and surface the counts.
- Add a separate *inferred* "tests failed" signal.

**Choice.** Keep `status: success` as reported and record the parsed counts in the call's metrics. The Metrics panel and timeline show 10/12 failing. No incident is created.

**Why.** Rewriting a reported fact would make provenance meaningless, and compare (Milestone C) needs to diff what really happened.

**Trade-off.** A failing suite behind a pipe shows no incident in the world.

**Reverse.** Add an inferred marker or incident derived from reported test counts, labelled *inferred*. The original event stays unchanged.

## DL-006 · Claude Code subagent usage comes from the `Agent` tool result (2026-10-17)

**Problem.** Show tokens, model and cost per agent without guessing.

**Evidence from the M0 probe** (real `claude -p` sessions, Claude Code 2.1.302):
- `PostToolUse` for the `Agent` tool includes `tool_response` with `agentId`, `resolvedModel`, `usage`, `totalTokens` and `totalDurationMs`.
- That `agentId` equals `agent_id` on `SubagentStart` and `SubagentStop`.
- No hook reports main-agent tokens.

**Choice.** Record subagent usage as source-reported. Show the main agent's usage as "not reported by hooks". Transcript import may enrich it later, labelled as such.

**Trade-off.** Cost per run is incomplete until the transcript importer exists.

**Reverse.** Add an enrichment source; the event model keeps provenance per field.

## DL-005 · Move the runtime port off 4317 to 4380 (2026-10-17)

**Problem.** 4317 is the default OTLP/gRPC port. A user running an OTel collector would clash with Runloop, and Runloop plans an OTLP bridge itself.

**Options.**
- Keep 4317.
- 4318 (OTLP/HTTP, also taken).
- An unassigned port: 4380.

**Choice.** 4380. Override it with `--port` or `NEXT_PUBLIC_RUNLOOP_API`.

**Trade-off.** It is a breaking change for anyone already running the scaffold, which is acceptable before any release.

**Reverse.** It is one constant in `packages/events/src/protocol.ts`.

## DL-004 · Second integration: Codex CLI hooks, not the OpenAI Agents SDK (2026-10-17)

**Problem.** Pick the integration after Claude Code.

**Options.**
- OpenAI Agents SDK: clean tracing processor, and it can be tested in CI with a scripted model.
- Codex CLI hooks: near-identical event names to Claude Code (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart/Stop`, `Stop`, `SessionEnd`).
- LangGraph.
- An OTLP bridge.

**Choice.** Codex CLI hooks. It serves the same user (heavy coding-agent users), reuses most of the Claude Code mapper, and enables cross-harness comparison, which hedges against platform absorption.

**Trade-off.** It does not reach agent-app builders. The OpenAI Agents SDK stays on the roadmap for when that demand appears.

**Reverse.** The adapter contract is source-agnostic, so either can be built next.

## DL-003 · Wedge: coding-agent flight recorder, then run compare, then A/B runner (2026-10-17)

**Problem.** Choose the first market. Candidates were general agent observability, Claude Code tracing, eval/regression, multi-agent experiments, or a combination.

**Evidence.** Telemetry capture, spatial views and replay are each already available for free [V]. "Did my setup change help?" is a real, recurring question [V/H]. Run diffs tied to outcomes are not offered by the tools found [H].

**Choice.** Tracer first (activation), compare and baselines next (retention), headless A/B later. Details and reversal triggers are in `docs/product/strategy.md`.

**Trade-off.** It ignores agent-app builders for now.

**Reverse.** The event model and adapters stay general; only the order of work changes.

## DL-002 · Tracer mode uses async command hooks with a local spool (2026-10-17)

**Problem.** Capture Claude Code activity without ever slowing or breaking it.

**Options.**
- HTTP hooks: synchronous, and they fail when the runtime is down.
- Async command hooks running a tiny Node script.
- Reading OTel exports: batched, and traces are in beta.
- Reading transcripts: the format is internal.

**Choice.** Async command hooks. The script writes the event to a spool file first, then POSTs it to loopback, and always exits 0. The full design is in `docs/plans/claude-code-tracer.md`.

**Trade-off.** One Node process per event, off the critical path.

**Reverse.** The mapper is a pure function, so the transport can be swapped.

## DL-001 · Local-first TypeScript monorepo with SQLite and an append-only event log (2026-10-17)

**Problem.** Pick a foundation a small team can maintain that still supports replay.

**Choice.**
- pnpm workspaces, TypeScript, zod-validated versioned events.
- `node:sqlite` behind a one-file wrapper.
- Hono with resumable SSE.
- Next.js static export with React Three Fiber.
- Three layers kept separate: execution truth, world simulation, presentation.

**Trade-off.** `node:sqlite` is experimental in Node 22. Runs live on a single machine.

**Reverse.** The store is wrapped (`packages/runtime/src/store/db.ts`), and the protocol is HTTP + SSE.
