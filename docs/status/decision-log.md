# Decision log

Short records of consequential decisions. Newest first. Each entry gives the problem, the options, the choice, why it was chosen, the trade-off, and how to reverse it.

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
