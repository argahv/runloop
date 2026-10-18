# Current state

> Updated 2026-10-18. **Status label: prototype.** Runloop records real Claude Code sessions (traced through the plugin) and a scripted demo mission (executed), and compares any two runs against a pinned baseline (Milestone C). Studio uses the Runloop Signature design with the richer 3D world (D10).

## What works (verified)

Evidence is in [verification-report.md](verification-report.md): §1–§4 for the tracer milestone, §5 for the 27 review fixes of 2026-10-17, §6 for compare, baselines and the world pass (2026-10-18).

| Capability | Evidence |
|---|---|
| Event contract: versioned envelope, 21 event types, provenance (`reported` / `inferred`), lenient and strict parsing, redaction, sequence buffer; `target` on tool calls and `speed` on executed runs (additive) | `pnpm vitest run --project events`; [event model](../architecture/event-model.md) |
| Layer 1 execution reducer: pure and idempotent, records anomalies instead of throwing. Tracks traced-run fields, markers, reported usage and tool categories. Linear on long runs (batch folds in place, bucketed tool-call map). Traced failures resolve only on a later success (inferred). | `--project core`; replay perf test on a ~20k-event traced run |
| Layer 2 world engine: deterministic BFS, closed-form motion, station reservation. Stations come from tool categories. | `--project world-engine` |
| Replay: `stateAt(N)` equals the live fold; shuffled and duplicated delivery converge | `--project replay` |
| Runtime: SQLite recorder, boot recovery (mode-aware), sandboxed tools, Hono API, resumable SSE, loopback only, port **4380**; baselines (`runs.pinned_at`, migration 2, `POST`/`DELETE /api/runs/:id/baseline`) | `--project runtime`; a copy of the real B6 database upgraded 2 → 3 and kept its pin across a restart |
| **Run compare** (`summarizeRun`, `diffRuns` in core): outcome, duration, tests (fixed, newly failing, still failing), files, tool calls by category and tool, tokens and models per agent, permissions, turns, subagents, first divergence. A value one side did not report is never compared or shown as 0. | `--project core` (36 compare tests); every number on the page recomputed from raw events for two real Claude Code pairs and an executed pair (verification report §6) |
| **Claude Code tracer**: plugin with async hooks (Stop, StopFailure and SessionEnd synchronous, bounded to ~1 s), spool flushed oldest first, direct send when the spool cannot be written, `--doctor`; broader redaction; token-protected ingest (token file kept at 0600); pure mapper; dedupe; idle sweep by arrival time; permission outcomes at `PostToolBatch`; continuation segments | Real `claude -p` sessions (B6), fixture goldens, plugin end-to-end test, `claude plugin validate --strict`; the review fixes are covered by unit, fixture and synthetic tests |
| Scripted coding mission: real file edits and real `node --test` runs (10 passed / 2 failed, then 12/12) | `pnpm demo -- --speed 0` |
| **Studio (Runloop Signature)**: tokens (dark and light), `src/ui/` components, Overview, Live World, Traces, Experiments, Integrations, Settings; deep links (including a paused playhead, `at=`); one synchronised selection; event-exact replay stepping; search and filters; virtualised timeline and logs with one Tab stop each; metrics panel; 3D world with fit-to-viewport and collision-free labels; 2D Network graph without text scaling; traced badges, provenance, inferred chips, "not reported" values | `--project studio` (216 tests), `pnpm build`, `pnpm screenshots` |
| **Experiments page**: baseline and candidate pickers (default: newest pin vs the newest other run of the same task), summary tiles, first divergence, tests, files, tool activity, tokens, permissions; test runs, failures, files, categories, usage reports and the divergence link to their events in Traces. Pin toggle with Undo on the run header and Overview, baseline marks in the run lists, "Compare" on runs with a baseline, palette entries | Event links checked on real runs; `pnpm screenshots` |
| **3D world richness (D10)**: board spans 97% of the 1440×900 stage, robots 44 px tall, chibi robots with state-coloured eyes, key and rim light, tinted rooms, paths lit only by real walks and messages, light theme as an architectural model (DL-009) | `scene/framing.test.ts`; screenshots in both themes |
| Visual regression script: every page and key state (Experiments and a pinned baseline included), both themes, 1280, 1440, 1920 and 390 px | `scripts/screenshots.mjs` |
| CI workflow: install, typecheck, test, build | `.github/workflows/ci.yml` (not yet run on GitHub) |

**Baseline commands** (2026-10-18, after the compare and world integration, all passed):
```sh
pnpm install --frozen-lockfile
pnpm -r typecheck       # 8 projects
pnpm test               # 52 files, 632 tests
pnpm build              # studio static export, including /experiments
claude plugin validate --strict integrations/claude-code-plugin
RUNLOOP_DATA_DIR=$(mktemp -d) pnpm demo -- --speed 0 --port 0   # 10 passed / 2 failed, then 12/12
pnpm screenshots        # needs a runtime with runs and a Studio; see scripts/screenshots.mjs
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
- **Cost is not compared.** No source reports cost, and Claude Code hooks report only subagent tokens, so token totals cover subagents only (the page says so).
- **Compare on real Claude Code data is limited by its age:** the three real sessions were recorded before `target` existed, so their file lists are "not reported" and compare cannot list files touched. Targets are covered by fixture goldens and unit tests only; no new real session was run (no spend).
- **Compare matching is simple:** calls of all agents are compared in start order, so interleaved subagent calls can move the first divergence; agents are matched by name; shell commands that write files are not in the file lists. Both runs are fetched and folded in the browser.
- **The Live World timeline does not collapse** (D11), so the world's height is fixed by the layout. Frame time under software WebGL rose from 263 to ~329 ms (high quality) with the larger board; no real-GPU figure.
- **`run_command` is not isolated.** Executed-run tests run with the runtime user's rights. This is acceptable for the scripted demo; a real sandbox is needed before adapters run untrusted commands.
- **Read endpoints are unauthenticated** for local processes, and there is no retention or deletion API.
- **CI has never run on GitHub.**
- **Hook latency** has not been measured in a real session. Measured locally: the synchronous Stop hook takes 126–160 ms with the runtime up and ≤ 761 ms with a hung runtime and a 20k-file spool. Node's start-up time is outside the hook's own budget.
- **Large live traces:** at ~18.6k events (synthetic) each new live event costs 0.36–0.48 s of Studio work, and the 3D world steps in 0.1–0.7 s under software WebGL. Replay and the Traces page are fast (steps ≤ ~100 ms).
- **Inferred tracer outcomes:** a permission request that matches no tool call is closed as denied (inferred). Subagent-to-`Agent`-call links are inferred from description and type; a wrong guess is corrected by a marker, not by retitling the task. An interrupted subagent shows "unfinished" in the Studio only; Layer 1 keeps its last state.
- **Redaction** does not recognise bare positional passwords (`tool login hunter2`). Shell commands are marked sensitive for that reason.
- **World labels:** in a crowded failure view, the failure zone's sign can give way to the incident label (which names the zone).

## Next highest-value task

**A real A/B with Claude Code (a few cents with Haiku):** the same small task twice, with one setup change between the runs (for example a CLAUDE.md line), traced with the current plugin so calls carry targets. Pin the first, compare the second, and check the files, tests and divergence against the raw events as in verification report §6. This closes the one compare path that has only fixture coverage (real targets) and is the activation journey's last step.

After that: E2 (Codex CLI hooks) for cross-harness compare, and the B6 interactive checklist (approvals, Esc, `/compact`, resume).
