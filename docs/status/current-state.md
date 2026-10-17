# Current state

> Updated 2026-10-17. **Status label: prototype.** One scripted demo runs end to end; there is no real agent integration yet.

## What works (verified)

| Capability | Evidence |
|---|---|
| Event contract: versioned envelope, 20 event types, lenient and strict parsing, redaction, sequence buffer | `pnpm vitest run --project events` |
| Layer 1 execution reducer: pure, idempotent, records anomalies instead of throwing | `--project core` |
| Layer 2 world engine: deterministic BFS, closed-form motion, station reservation, interruption | `--project world-engine` |
| Replay: `stateAt(N)` equals the live fold; shuffled and duplicated delivery converge | `--project replay` |
| Runtime: SQLite recorder (persist, then publish), boot recovery, sandboxed tools, Hono API, resumable SSE, loopback-only | `--project runtime`, manual SIGINT/SIGKILL checks |
| Scripted coding mission: real file edits and real `node --test` runs (10 passed / 2 failed, then 12/12) | `pnpm demo -- --speed 0` |
| Studio: live view, timeline, logs, state, artifact viewer, replay scrubber, 3D world, 2D toggle, keyboard controls | Playwright screenshots (see the verification report) |
| CI workflow: install, typecheck, test, build | `.github/workflows/ci.yml` (not yet run on GitHub) |

**Baseline commands** (2026-10-17, all passed):
```sh
pnpm install --frozen-lockfile
pnpm typecheck          # 7 projects
pnpm test               # 27 files, 235 tests
pnpm build              # studio static export
RUNLOOP_DATA_DIR=$(mktemp -d) pnpm demo -- --speed 0 --port 0
```

## Claude Code facts verified by the M0 probe

Two real `claude -p` sessions (Haiku, about $0.02 in total) with a logging plugin, Claude Code 2.1.302 (see `docs/plans/claude-code-tracer.md`, Appendix C):
- Tool hooks inside a subagent carry `agent_id` and `agent_type`.
- `PostToolUse` and `PostToolUseFailure` carry `tool_use_id`.
- A Bash command that exits non-zero arrives as `PostToolUseFailure` with the output in `error`.
- `PermissionRequest` has no `tool_use_id`. A denial in default mode fires no further hook.
- `PostToolUse(Agent).tool_response.agentId` links to `SubagentStart.agent_id` and includes `resolvedModel`, `usage` and `totalTokens`.
- `SessionStart` (source `startup`) carried no `model` field. `SessionEnd` reason was `other` for `-p`.

## Known limitations

- **No real agent integration yet.** The Claude Code tracer is the next milestone.
- **`run_command` is not isolated.** Tests run with the runtime user's rights and could rewrite `runloop.db`. This is acceptable for the scripted demo; a real sandbox is needed before adapters run untrusted commands.
- **The 3D view is off-centre at some window sizes** (the Build room is clipped on the right), and labels can overlap. The design pass is still pending.
- **No search or filter, no run comparison, no metrics view.**
- **Read endpoints are unauthenticated** for local processes; there is no retention or deletion API.
- **CI has never run on GitHub**, because nothing has been pushed to a PR yet.
- **The runtime port is still 4317**, which collides with OTLP/gRPC. It moves to 4380 per DL-005.

## Next highest-value task

**Milestone B, the Claude Code tracer:** the plugin, ingest endpoint and mapper, built from the real probe fixtures, with traced runs shown live in Studio. See `TASKS.md`.
