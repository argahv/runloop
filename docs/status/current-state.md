# Current state

> Updated 2026-10-17. **Status label: prototype.** Runloop records real Claude Code sessions (traced through the plugin) and a scripted demo mission (executed). Studio uses the Runloop Signature design. Run comparison is not built yet.

## What works (verified)

Evidence for the items added in this milestone is in [verification-report.md](verification-report.md). §5 there lists the 27 review findings fixed on 2026-10-17 and how each was checked.

| Capability | Evidence |
|---|---|
| Event contract: versioned envelope, 21 event types, provenance (`reported` / `inferred`), lenient and strict parsing, redaction, sequence buffer | `pnpm vitest run --project events`; [event model](../architecture/event-model.md) |
| Layer 1 execution reducer: pure and idempotent, records anomalies instead of throwing. Tracks traced-run fields, markers, reported usage and tool categories. Linear on long runs (batch folds in place, bucketed tool-call map). Traced failures resolve only on a later success (inferred). | `--project core`; replay perf test on a ~20k-event traced run |
| Layer 2 world engine: deterministic BFS, closed-form motion, station reservation. Stations come from tool categories. | `--project world-engine` |
| Replay: `stateAt(N)` equals the live fold; shuffled and duplicated delivery converge | `--project replay` |
| Runtime: SQLite recorder, boot recovery (mode-aware), sandboxed tools, Hono API, resumable SSE, loopback only, port **4380** | `--project runtime` |
| **Claude Code tracer**: plugin with async hooks (Stop, StopFailure and SessionEnd synchronous, bounded to ~1 s), spool flushed oldest first, direct send when the spool cannot be written, `--doctor`; broader redaction; token-protected ingest (token file kept at 0600); pure mapper; dedupe; idle sweep by arrival time; permission outcomes at `PostToolBatch`; continuation segments | Real `claude -p` sessions (B6), fixture goldens, plugin end-to-end test, `claude plugin validate --strict`; the review fixes are covered by unit, fixture and synthetic tests |
| Scripted coding mission: real file edits and real `node --test` runs (10 passed / 2 failed, then 12/12) | `pnpm demo -- --speed 0` |
| **Studio (Runloop Signature)**: tokens (dark and light), `src/ui/` components, Overview, Live World, Traces, Integrations, Settings; deep links (including a paused playhead, `at=`); one synchronised selection; event-exact replay stepping; search and filters; virtualised timeline and logs with one Tab stop each; metrics panel; 3D world with fit-to-viewport and collision-free labels; 2D Network graph without text scaling; traced badges, provenance, inferred chips, "not reported" values | `--project studio` (173 tests), `pnpm build`, `pnpm screenshots` |
| Visual regression script: every page and key state, both themes, 1280, 1440, 1920 and 390 px | `scripts/screenshots.mjs` |
| CI workflow: install, typecheck, test, build | `.github/workflows/ci.yml` (not yet run on GitHub) |

**Baseline commands** (2026-10-17, re-run after the review fixes, all passed):
```sh
pnpm install --frozen-lockfile
pnpm typecheck          # 8 projects
pnpm test               # 50 files, 547 tests
pnpm build              # studio static export
claude plugin validate --strict integrations/claude-code-plugin
RUNLOOP_DATA_DIR=$(mktemp -d) pnpm demo -- --speed 0 --port 0
```

## Claude Code facts verified with real sessions

Six real `claude -p` sessions so far (Haiku, Claude Code 2.1.302): three M0 probe sessions, then three end-to-end sessions with the plugin ($0.032 for the three end-to-end sessions). Details: tracer plan, Appendix C, and the verification report.
- Tool hooks inside a subagent carry `agent_id` and `agent_type`, so subagent calls are attributed exactly.
- A Bash command that exits non-zero arrives as `PostToolUseFailure`, with "Exit code N" and the output in `error`.
- A piped command (`node --test | tail`) exits 0, so Claude Code reports it as a success. Runloop records the reported status and the parsed test counts, and creates no incident.
- `PermissionRequest` has no `tool_use_id`. A denial in default mode fires no hook.
- `PostToolUse(Agent).tool_response` carries the subagent's `agentId`, `resolvedModel` and `usage`. No hook reports the main agent's tokens.
- Under `-p`, an async `Stop` hook does not run, so Stop, StopFailure and SessionEnd are registered as synchronous.
- With `--plugin-dir`, the plugin's data dir is `~/.claude/plugins/data/runloop-tracer-inline`.

## Known limitations

- **Interactive Claude Code behaviour is untested with real sessions:**
  - approving or denying a permission;
  - Esc interrupts;
  - compaction, `/clear` and resume;
  - notifications.

  The mapper handles them defensively; synthetic fixtures cover several.
- **The marketplace install has not been tried**, because the repo is not published yet. `--plugin-dir` is verified.
- **No run comparison yet** (Milestone C), so cost per run is incomplete: the main agent's tokens are not reported by hooks.
- **`run_command` is not isolated.** Executed-run tests run with the runtime user's rights. This is acceptable for the scripted demo; a real sandbox is needed before adapters run untrusted commands.
- **Read endpoints are unauthenticated** for local processes, and there is no retention or deletion API.
- **CI has never run on GitHub.**
- **Hook latency** has not been measured in a real session. Measured locally: the synchronous Stop hook takes 126–160 ms with the runtime up and ≤ 761 ms with a hung runtime and a 20k-file spool. Node's start-up time is outside the hook's own budget.
- **Large live traces:** at ~18.6k events (synthetic) each new live event costs 0.36–0.48 s of Studio work, and the 3D world steps in 0.1–0.7 s under software WebGL. Replay and the Traces page are fast (steps ≤ ~100 ms).
- **Inferred tracer outcomes:** a permission request that matches no tool call is closed as denied (inferred). Subagent-to-`Agent`-call links are inferred from description and type; a wrong guess is corrected by a marker, not by retitling the task. An interrupted subagent shows "unfinished" in the Studio only; Layer 1 keeps its last state.
- **Redaction** does not recognise bare positional passwords (`tool login hunter2`). Shell commands are marked sensitive for that reason.
- **World labels:** in a crowded failure view, the failure zone's sign can give way to the incident label (which names the zone).

## Next highest-value task

**Milestone C, Compare:**
- pin a run as a baseline;
- diff two runs (outcome, tool calls by category, files touched, tests, reported tokens, permission waits);
- show the diff side by side in Studio.

Before that, it is worth running the B6 manual checklist interactively (approvals, Esc, `/compact`, resume) to close the tracer's remaining unknowns.
