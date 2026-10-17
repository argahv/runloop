# Runloop

A 3D living world for AI agents. Runloop runs agent work locally with real tools, records every event, and shows that work as characters moving between stations in a small diorama. You can inspect the trace and replay any run without executing anything again.

Three layers stay strictly apart:

1. **Execution truth.** The append-only event log. Tool results only come from tools that really ran.
2. **World simulation.** A pure function of the log and a world definition: where each character is and what it is doing.
3. **Presentation.** The Studio draws layer 2 and never writes back to it.

Live view and replay fold the same events through the same reducers, so they always agree.

## Quickstart

You need Node 22.16 or newer and pnpm 10.

```sh
pnpm install
pnpm dev     # runtime API on http://127.0.0.1:4317, Studio on http://localhost:3000
```

Open http://localhost:3000 and click **Run demo mission**. Three agents survey a small repo, implement a task store and run its test suite. The first test run really fails (10 passed, 2 failed), the Builder patches the bug, and the rerun passes 12/12. Click a timeline row or a character to see its events and artifacts. Runs are kept across runtime restarts and replay from the log.

Other commands:

```sh
pnpm demo        # run the mission headless and print one trace line per event
pnpm test        # unit and integration tests (vitest)
pnpm typecheck
pnpm build       # static export of the Studio
```

Runs are stored in `.runloop/` at the repo root; set `RUNLOOP_DATA_DIR` to use another directory.

The demo uses a scripted adapter. Its decisions are fixed in code, but every tool call (listing and reading files, writing code, running `node --test`) really executes in a per-run copy of the example repo, and the recorded results come from that execution. There is no LLM adapter yet; the adapter interface is in `packages/runtime/src/adapter.ts`.

The runtime API has no authentication, so it only listens on loopback. `run_command` executes the workspace's tests as your user without OS-level isolation; that is safe for the fixed demo code, but read the sandbox notes in [packages/runtime/README.md](packages/runtime/README.md) before plugging in an adapter that writes its own code.

## Repository layout

```
apps/studio              Next.js Studio: runs, timeline, logs, replay bar and the 3D world (React Three Fiber)
packages/events          event schema, parsing, redaction, SequenceBuffer, HTTP/SSE contract
packages/core            layer 1: execution reducer, selectors, text formatting
packages/world-engine    layer 2: world definition, grid paths, motion, character intents
packages/replay          combined reducer and ReplayIndex (state at any sequence or time)
packages/runtime         local runtime: SQLite recorder, tool sandbox, run manager, HTTP + SSE API, CLI
packages/testkit         fixtures and helpers for tests
worlds/research-campus   the default world (grid, rooms, stations)
examples/coding-mission  the demo mission and its example repo
```

## License

Apache-2.0. See [LICENSE](LICENSE).
