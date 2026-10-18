# Decision log

Short records of consequential decisions. Newest first. Each entry gives the problem, the options, the choice, why it was chosen, the trade-off, and how to reverse it.

---

## DL-009 · The light theme keeps a light world, styled as an architectural model (2026-10-18)

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
