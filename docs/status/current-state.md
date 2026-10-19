# Current state

> Updated 2026-10-18 (the immersive town, DL-014). **Status label: prototype.** Runloop is now a town (Milestone W, DL-009) that you stay in like a game (Milestone I, DL-014): `/` is Runloop Commons edge to edge, with a free camera, land to the horizon, a game HUD and a synthesized soundscape; 80 simulated residents live on a sim clock and real Claude Code agents are buildings in the Agent District; Traces, compare, sessions, settings and Add to World open inside the town. Underneath, it still records real Claude Code sessions (traced through the plugin) and a scripted demo mission (executed), replays them, and compares any two runs against a pinned baseline (Milestone C). Studio uses the Runloop Signature design.

## What works (verified)

Evidence is in [verification-report.md](verification-report.md): §1–§4 for the tracer milestone, §5 for the 27 review fixes of 2026-10-17, §6 for compare, baselines and the world pass, §7 for the town, agents and dispatch, §8 for the second review pass in the packages, §9 for the immersive town (2026-10-18), §10 for the 17 game-feel and truth fixes from its review.

| Capability | Evidence |
|---|---|
| **The town (W1, W2):** Runloop Commons (96×72 cells, 6 districts, 28 buildings with interiors, 14 spots, 6 agent lots), 80 residents with needs, schedules, traits and friendships; a deterministic, pure simulation (`packages/town`, `packages/sim`); a world log with a provenance on every event; `WorldHost` with commit-then-publish, checkpoints, resume after a restart or SIGKILL; `/api/world` and its SSE stream | `--project town`, `--project sim` (S2 day tests at 80 and 120 residents, determinism across processes and restarts, purity scan), `--project runtime` (host, stream, restart); a real restart kept the world identical (§7) |
| **The immersive town (Milestone I):** `/` edge to edge with land to the horizon and a sim-time sky; a perspective game camera (pan with inertia, zoom to the cursor, rotate, tilt 10°–62°, keys, follow, fly-in); the HUD (chip, Find, bell, clock and speed, notifications, minimap, hotbar, anchored cards, Esc menu); Add to World on a lot in 3D; Intelligence, Lab, Sessions and Connections as sheets beside the live town; the session strip inside an agent's building; decorative ambient life; phones with a light 3D town; the 2D map without WebGL | `--project studio`; journeys on a real runtime (§9); `scripts/perf-town.mjs` (12 views within budget, the land ≤ 15 calls); `pnpm screenshots` day and night, both themes |
| **Sound:** Web Audio bed following the camera, UI sounds, cues only for live real agent events, no sound before a gesture, silent when hidden | `src/audio` tests; `render-check.mjs` 51/51; in the town a real agent's events played cues and minutes of simulated activity none (§9). Not listened to by a person. |
| **The town in Studio:** clock and speeds, resident card with a sourced Why, building and agent cards, World Log, ⌘K, deep links (`mode`, `focus`, `cam` with az/tilt, `overlay`) and legacy redirects; automatic render quality | `--project studio`; `scripts/e2e-world.mjs`; screenshots (§7, §9) |
| **Real agents (W4, S3):** Add to World, binding by dispatch id or folder, Arrivals and claim, six health states, capabilities with reasons, the projector (counts equal the cited tool calls), the agent's building and interior, P4/P5/P7/P8 | `agents*.test.ts`, `projector.test.ts`, `runtime-agents.int.test.ts`; a real `claude -p` session went live 1.1 s after its first hook (§7) |
| **Assign task (W4, S4):** preview the exact command, approval on the runtime's own page with a single-use nonce (the Studio opens it and follows the outcome; it never holds the nonce), `dontAsk` with an allowlist, budget and timeout, cancel by process group, orphan/lost after a restart, audit log | `dispatch*.test.ts` with a fake `claude`; real dispatches completed before the approval moved (§7); the new flow up to Decline on the approval page in the browser, nothing run (§9) |
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
| **3D world richness (D10)**: board spans 97% of the 1440×900 stage, robots 44 px tall, chibi robots with state-coloured eyes, key and rim light, tinted rooms, paths lit only by real walks and messages, light theme as an architectural model (DL-013) | `scene/framing.test.ts`; screenshots in both themes |
| Visual regression script: every page and key state (Experiments and a pinned baseline included), both themes, 1280, 1440, 1920 and 390 px | `scripts/screenshots.mjs` |
| CI workflow: install, typecheck, test, build | `.github/workflows/ci.yml` (not yet run on GitHub) |

**Baseline commands** (2026-10-18, after the world integration, all passed; counts in verification report §7):
```sh
pnpm install --frozen-lockfile
pnpm -r typecheck       # 10 projects
pnpm test               # see §7 for the file and test counts
pnpm build              # studio static export, including /experiments
claude plugin validate --strict integrations/claude-code-plugin
RUNLOOP_DATA_DIR=$(mktemp -d) pnpm demo -- --speed 0 --port 0   # 10 passed / 2 failed, then 12/12
pnpm screenshots        # needs a runtime (world on, an agent added) and a Studio; see scripts/screenshots.mjs
node scripts/e2e-world.mjs [--fresh]    # the town lives (needs a runtime and Studio)
node scripts/perf-town.mjs              # render budgets under SwiftShader (12 views, the land included)
node apps/studio/src/audio/check/render-check.mjs   # the soundscape in headless Chromium
pnpm --filter @runloop-world/sim bench  # tick cost and events per sim day
```

## Claude Code facts verified with real sessions

Six real `claude -p` sessions for the tracer (Haiku, Claude Code 2.1.302): three M0 probe sessions, then three end-to-end sessions with the plugin ($0.032 for the three end-to-end sessions). For the town (2026-10-18): one session in a folder added to the world and four dispatched tasks ($0.027 together), plus the S4 builder's dispatch check ($0.0018). Details: tracer plan, Appendix C, and the verification report (§2, §7).
- Tool hooks inside a subagent carry `agent_id` and `agent_type`, so subagent calls are attributed exactly.
- A Bash command that exits non-zero arrives as `PostToolUseFailure`, with "Exit code N" and the output in `error`.
- A piped command (`node --test | tail`) exits 0, so Claude Code reports it as a success. Runloop records the reported status and the parsed test counts, and creates no incident.
- `PermissionRequest` has no `tool_use_id`. A denial in default mode fires no hook.
- `PostToolUse(Agent).tool_response` carries the subagent's `agentId`, `resolvedModel` and `usage`. No hook reports the main agent's tokens.
- Under `-p`, an async `Stop` hook does not run, so Stop, StopFailure and SessionEnd are registered as synchronous.
- With `--plugin-dir`, the plugin's data dir is `~/.claude/plugins/data/runloop-tracer-inline`.
- A session binds on its `SessionStart` hook (the cwd is in every hook); the agent reads live from the first recorded event (the first prompt), about 1 s after `SessionStart`.
- `claude plugin list --json` lists installed plugins with `enabled` and `errors`; dispatch reads it to decide whether to pass `--plugin-dir` (here the tracer was not installed, so the first dispatch, which relied on "the workspace already sent hooks", ran untraced; fixed).
- A dispatched `claude -p` with `--permission-mode dontAsk --allowedTools Read Grep Glob` and `--output-format stream-json --verbose` reports `total_cost_usd`, `num_turns` and the result in its final `result` line.

## Known limitations

**The immersive town (2026-10-18)**
- **Measured only under SwiftShader.** Every render budget holds, but frames run at 1–2 fps there, so held keys, flights and the fly-in are as slow as the software renderer; no real-GPU or real-phone frame time.
- **Nobody has listened to the sound.** Levels are set by measurement (offline render); Safari and iOS (`webkitAudioContext`, no StereoPanner) are untested; with the 2D map there is no ambient bed (no listener).
- **Not measured:** glass contrast in the light theme over a bright sky; two WebGL canvases (the trace sheet's World tab over the paused town) on real hardware.
- **Layout edge:** with a wide sheet open and a card docked top-right, a notification can sit over the docked card (it stays on screen).
- A traced session ends as "stopped", so it never plays the task-done cue (only a dispatched or executed run that succeeded does).
- **Phones start on the whole town,** which is small at 390 px wide (about 2.5 px per cell); a pinch or a card brings you in. Free lots in Add to World are outlined (an ice frame that breathes), not glowing.

**The town (2026-10-18)**
- **Event volume is over the plan's budget:** about 4.8k events and 1.6 MB per sim day at 120 residents (plan: ≤ 6k and ≤ 1 MB per day at 300). Retention (3 sim days of ambient events) bounds storage; a leaner `resident.decided` would fix it.
- **300 residents do not fit the Commons** (it houses 136); the 300-resident budgets were measured on a bench-only 4-floor variant (288 residents).
- **No real-GPU numbers.** Draw calls, triangles and JS time per frame are within budget under SwiftShader; frame time on a real GPU (plan §9) has not been measured. Under SwiftShader the Studio's state can lag the runtime by seconds while the 3D town renders.
- **The town does not live while Runloop is off.** It resumes where it stopped and records how long it was away (`world.resumed_after_offline`).
- **Not built:** onboarding coachmarks, axe and keyboard-only passes, the robot model shared between the diorama and the town (the town copies its look), Build and Society modes, forks and a history scrubber (W3, W5).
- **Agents:** only Claude Code; no message or pause channel (shown as *unsupported*); a session whose folder moved becomes an Arrival; after a restart an Arrival can be claimed but no longer founds a new agent (its folder is not kept). A dispatched task's output and result text are kept in memory only.
- **A piped test command** (`node --test | tail`) exits 0, so Claude Code reports success and no incident appears; the real session of §7 did this.
- An agent going offline after its session closed is a notable in the bell's list (no popup, not "need you"); only a connection lost mid-task stays critical (fixed in the immersive review pass, verification report §10).

- **Interactive Claude Code behaviour is untested with real sessions:**
  - approving or denying a permission;
  - Esc interrupts;
  - compaction, `/clear` and resume;
  - notifications.

  The mapper handles them defensively; synthetic fixtures cover several.
- **The marketplace install has not been tried**, because the repo is not published yet. `--plugin-dir` is verified.
- **Cost is compared only for dispatched runs**, as Claude Code reported it in its final result (one run per session); other runs read "not reported". Claude Code hooks report only subagent tokens, so token totals cover subagents only (the page says so).
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

**Feel it on real hardware:** run the town on a real GPU and a real phone (frame time, flights, held keys), listen to the soundscape and tune its levels, and check light-theme glass contrast over a bright sky. These are the gaps the immersive milestone could not close in a headless sandbox.

Then (from the world slice):

**Make the town cheaper and truer at scale:** trim `resident.decided` (or the number of trips) to meet the event budget, add homes for 300 residents, and measure frame time on a real GPU (plan §9). Then the W4 checks still open: a real cancel at the first tool call, and an interactive (non `-p`) session with an approval, watched inside the agent's building.

Earlier plan (still valid):

**A real A/B with Claude Code (a few cents with Haiku):** the same small task twice, with one setup change between the runs (for example a CLAUDE.md line), traced with the current plugin so calls carry targets. Pin the first, compare the second, and check the files, tests and divergence against the raw events as in verification report §6. This closes the one compare path that has only fixture coverage (real targets) and is the activation journey's last step.

After that: E2 (Codex CLI hooks) for cross-harness compare, and the B6 interactive checklist (approvals, Esc, `/compact`, resume).
