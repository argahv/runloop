# Claude Code hook fixtures

Each `.jsonl` line is one hook invocation as the M0 probe logged it: `{ t, pid, ppid, argv: [eventName], input }`, where `input` is the hook's raw stdin JSON.

## Real sessions (sanitised)

Recorded on 2026-10-17 with Claude Code 2.1.302 (`claude -p`, Haiku) and a logging plugin; see `docs/plans/claude-code-tracer.md`, Appendix C.

| File | Session |
|---|---|
| `s1-basic.jsonl` | A failing `node --test` run (exit 1), a Read of a missing file, an Edit, a passing rerun, and a permission request that was denied (no hook follows it). Synchronous hooks. |
| `s2-subagents.jsonl` | Two parallel `Explore` subagents (`Agent` tool); their tool calls carry `agent_id`, and the `Agent` results carry `agentId` and usage. Synchronous hooks. |
| `s3-async.jsonl` | All hooks async except SessionEnd: out-of-order delivery (`PostToolBatch` before `PostToolUse`), and the async `Stop` never ran. |

Sanitising replaced absolute paths only; everything else is verbatim:
- the probe workspace `…/scratchpad/cc-probe/ws1` → `/home/dev/demo` (also inside prompts, commands and outputs);
- `/root/.claude/projects/<encoded workspace>` → `~/.claude/projects/-home-dev-demo`;
- the scratchpad directories → `/tmp/claude/-home-dev-demo/…` and `/tmp/claude/scratchpad`.

## Synthetic edge cases

Hand-written; every line has `"synthetic": true`. They exercise orderings and hooks the probe could not produce headless.

| File | Case |
|---|---|
| `synthetic-post-before-pre.jsonl` | `PostToolUse` / `PostToolUseFailure` before their `PreToolUse`; a failing vitest run |
| `synthetic-out-of-order.jsonl` | `SubagentStart` before the `Agent` call, a `PermissionRequest` before its `PreToolUse`, an Esc interrupt (`is_interrupt`), usage in the `Agent` result |
| `synthetic-permission-denied-then-stop.jsonl` | One permission approved (a result follows), one denied (nothing follows, closed at Stop), compaction and notifications |
| `synthetic-no-session-end.jsonl` | A `StopFailure` (API error), then a second turn whose call never finishes and no SessionEnd (closed by the idle sweep) |

`<name>.golden.txt` is the recorded run for each fixture (see `test/claude-code-mapper.test.ts`).
