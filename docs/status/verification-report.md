# Verification report: Claude Code tracer, Runloop Signature Studio and run compare

> 2026-10-17 (§1–§5) and 2026-10-18 (§6) · branch `claude/amazing-wright-rzio6c` · Node 22.22.0 · pnpm 10.28.0 · Claude Code 2.1.302 · Linux, headless Chromium (SwiftShader WebGL) for screenshots.
>
> Screenshots marked *(session)* were taken in this session's scratch directory and are not committed. The committed ones are in `docs/assets/`; on 2026-10-18 they were re-captured from the same recorded sessions in the current Studio (§6).

## 1. Repository checks

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK (lockfile up to date; adds `playwright@1.56.1` as a root devDependency for the screenshot script) |
| `pnpm -r typecheck` | 8/8 projects pass (events, testkit, core, world-engine, replay, runtime, claude-code-plugin, studio) |
| `pnpm test` | **50 files, 488 tests, all passed.** By project: events 47, core 36, world-engine 58, replay 11, runtime 156, testkit 3, claude-code-plugin 14, studio 163. |
| `pnpm build` | Static export: `/`, `/overview`, `/world`, `/traces`, `/integrations`, `/settings`, 404 |
| `claude plugin validate --strict integrations/claude-code-plugin` | Validation passed |
| `claude plugin validate --strict .` (marketplace) | Validation passed |
| `RUNLOOP_DATA_DIR=<tmp> pnpm demo -- --speed 0 --port 0` | 58 events. `run_command` 10 passed / 2 failed (seq 36), then 12/12 (seq 55). `run.completed succeeded`. Exit 0. |

These are the milestone results. The checks were run again after the review fixes; see §5 for the current numbers.

The fixture path of the tracer is covered automatically:
- `packages/runtime/test/claude-code-plugin.e2e.test.ts` pipes every line of the three sanitised probe sessions and four synthetic edge cases through the real hook script into a live runtime, including an offline spool and flush.
- `claude-code-mapper.test.ts` compares each fixture with its golden trace.

## 2. Real Claude Code end to end (task B6)

**Setup**
- **Runtime:** `RUNLOOP_DATA_DIR=<scratch>/data-e2e node --import tsx packages/runtime/src/bin.ts serve`, on the default port 4380. The ingest token is the default per-user file, `~/.config/runloop/ingest-token`.
- **Studio:** the static export (`apps/studio/out`) served with `python3 -m http.server 3000`, using the build default API `http://127.0.0.1:4380`.
- **Workspace:** a copy of `examples/coding-mission/repo`, with `examples/coding-mission/script/implement.buggy.js` copied over `src/task-store.js`. `node --test` there gives 10 passed, 2 failed.

**Command** (one new `--session-id` per session):
```sh
cd <scratch>/e2e-ws && env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION claude -p "<task>" \
  --model haiku --session-id <uuid> --plugin-dir <repo>/integrations/claude-code-plugin \
  --allowedTools "Read,Grep,Glob,Edit,Agent,Bash(node --test*)" --output-format json
```
The task told the agent to:
1. run `node --test`;
2. launch two Explore subagents in parallel with the Agent tool, one on `src/` and one on `test/`;
3. fix the failure with a minimal edit;
4. rerun the tests.

Session 2 added "exactly `node --test`, no pipes". Session 3 used a shorter task without subagents.

**Sessions** (cost, duration and turns are from Claude Code's JSON output; model `claude-haiku-5-5`):

| # | Session id | Runloop run | Events | Cost | Duration | Turns | What it verified |
|---|---|---|---|---|---|---|---|
| 1 | `e8f06145-b4bd-4d1d-9b6b-a48f73e467a7` | `680b3596-c0ce-54c4-b050-67c1f57f6b08` | 47 | $0.0181 | 21.4 s | 7 | Live run in Studio, main agent plus 2 Explore subagents, delegation, usage, auto-open of the live session |
| 2 | `13a17b94-f249-4691-a3b8-361c2f1b11bf` | `0d3a3dd9-b185-509f-a59e-b74c740aadf5` | 45 | $0.0095 | 16.4 s | 7 | The above, plus a real failing Bash test as an incident, the inspector, metrics, refresh, restart and replay |
| 3 | `39428e5f-ca57-4f02-8d88-3c4748e1e1bd` | `cff5c4e9-d2d1-584e-b6c9-b10264501875` | 19 | $0.0047 | 8.4 s | 5 | Runtime down at session start: spool, then flush on later hooks |
| | | | | **$0.0323 total** | | | |

**Acceptance criteria**

| Criterion | Evidence | Result |
|---|---|---|
| A real `claude -p` session produces a **live** run in Studio | `/world/` opened with no run in the URL. The Studio opened the live session by itself (`?run=0d3a3dd9…`), and the header showed **Live** and **Traced · Claude Code · Live**. 4–5 captures per session while it ran. *(session)* `e2e/s1/live-0[1-5].png`, `e2e/s2/live-0[1-4].png`; committed at the time as `docs/assets/claude-code-live.png` (in git history; replaced on 2026-10-18 by `claude-code-session.png`, a replay of the same session in the current Studio, see §6). | Pass |
| **Main agent plus subagent robots** | Session 2 recorded `agent.registered` for `main` ("Claude"), `sa-a694bca8d14490c32` ("Explore #1") and `sa-a9bcb8b405054a668` ("Explore #2"). Each subagent's tool calls carry its own `agentId`, so they are attributed by `agent_id`. Three robots are visible in the live captures. | Pass |
| **Stations by tool category** | Recorded categories: `test` (`node --test`), `delegate` (Agent), `execute` (subagent `ls`/`cat`), `read`, `edit`. In the world, the main agent walks to the Probe Bench (Test Chamber) for the test run, and the subagents work at the Workshop stations for their shell reads. This was checked with `ReplayIndex.stateAt` (intents: `test`, then `build` for `execute`). | Pass |
| **A failing Bash test shown as an incident**, with the real failure | Session 2, seq 9: `tool.call_completed {status: error, errorType: exit_nonzero, exitCode: 1, outputSummary: "Exit code 1 · 12 tests: 10 passed, 2 failed"}`. The failing tests are `listOpen returns only tasks that are not done` and `listOpen reflects complete()`. It was delivered by `PostToolUseFailure` and is shown as a red **Tool error** incident at the Test Chamber, with a failure marker on the scrubber. Committed `docs/assets/claude-code-failure.png`. | Pass |
| **The inspector on that tool call** | The inspector text at `?event=9`: "Bash error · 10 passed, 2 failed · Reported · Input `node --test` · Result Exit code 1 · Error type exit_nonzero · Exit code 1 · Provenance: Start reported by Claude Code, End reported by Claude Code · Test results 10 passed, 2 failed, 12 total". *(session)* `e2e/s2/post-world-incident.png`, `e2e/s2/post-traces-incident.png`. | Pass |
| **Metrics**: subagent tokens "reported by Claude Code", main agent "not reported" | Traces → Metrics, the "Tokens and model per agent" table: Claude, *not reported*. Explore #1, `claude-haiku-5-5`, 20.8k, Claude Code. Explore #2, `claude-haiku-5-5`, 21.6k, Claude Code. Footnote: "Claude Code reports usage for subagents only…". Tokens card: 42.5k, "reported for 2 of 3 agents". Cost: *not reported*. *(session)* `e2e/s2/post-metrics-tokens.png`. | Pass |
| **2D graph with delegation edges** | Network view: You → Claude ("Turn", 2 messages) and Claude → Explore #1 / Explore #2 ("Delegated", 1 message each). The subagent cards show reported tokens and model. It was captured live (*(session)* `e2e/s2/live-graph.png`) and after the run (committed `docs/assets/claude-code-network.png`). | Pass |
| **Refresh keeps history** | Reloading `/world/?run=0d3a3dd9…&event=9` restored the same run, event, agent (`&agent=main`) and inspector content, loaded from the runtime's log. *(session)* `e2e/s2/post-world-incident-after-refresh.png`. | Pass |
| **Runtime restart: run persists, replays without re-execution** | The runtime was stopped with SIGTERM and started again on the same data dir. `/api/runs` before and after: `680b3596…` stopped/47, `0d3a3dd9…` stopped/45, unchanged. Replay of session 2 from event 1: the Studio showed **Replaying** ("Replaying persisted events; nothing is re-executed"). The workspace's `src/task-store.js` sha256 was unchanged, no workspace file changed during the replay, and event counts were unchanged. *(session)* `e2e/restart/replay-start.png`, `e2e/restart/replay-mid.png`. | Pass |
| **Plugin with the runtime down (spool), then up (flush on the next hook)** | Session 3 started at 19:54:51.2Z with the runtime stopped. While it was down, the plugin spooled 6 envelopes in `~/.claude/plugins/data/runloop-tracer-inline/spool/39428e5f…/`, and `last-error.json` read "Runtime http://127.0.0.1:4380 answered fetch failed; events stay in the spool". The runtime restarted at 19:54:59.6Z. The `Stop` and `SessionEnd` hooks then flushed the spool. The run has all 19 events, in order, from `run.started` (observed 19:54:52.9) to `run.completed` (19:55:01.3), and the spool is empty. Claude Code exited 0, and its result was unaffected. | Pass |

**Findings from the real sessions**
- **A piped test command hides the failure from Claude Code.** In session 1 Haiku ran `node --test 2>&1 | tail -n 80`. The pipeline exits 0, so Claude Code reported `PostToolUse` (success), and Runloop recorded `status: success` with the summary "12 tests: 10 passed, 2 failed". Runloop does not override the reported status. The Metrics panel still shows the reported counts (10/12, failing), but no incident is created. This is honest, though a user may expect an incident. A possible follow-up is an *inferred* "tests failed" flag when the reported counts show failures.
- **`--doctor` looked in the wrong data dir.** With `--plugin-dir`, Claude Code sets `CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/runloop-tracer-inline`, but `--doctor` run from a shell defaulted to `…/runloop-tracer` and reported "never accepted". **Fixed:** the doctor now checks every `runloop-tracer*` data dir (`doctorDataDirs`, with a unit test).
- **A Studio health check that timed out once showed "Runtime offline".** This happened under heavy CPU load (two software-rendered pages). **Fixed:** once online, the Studio needs two consecutive failed polls before it reports offline.
- Explore subagents ran shell `ls`/`cat` commands, categorised as `execute`, so they work in the Workshop rather than the Observatory. This is correct for what was reported.
- Hook latency was not measured in these sessions. The tracer's fixture replay measured at most 303 ms per hook call.

## 3. Visual regression (task D9)

`scripts/screenshots.mjs` (`pnpm screenshots`) captured each state against the E2E runtime (3 traced runs and 1 executed demo run) and the static Studio:
- 19 states × {dark, light} × {1280, 1440, 1920};
- 17 states × {dark, light} at 390 (the Network graph is desktop-only).

That is 148 images in 8 min 23 s, with no uncaught page errors. The states:
- the Overview, Integrations, Settings and 404 pages;
- the command palette;
- offline, on the Overview and in the Live World;
- for each run kind: the world (latest, and at the first failure), the Network graph, and Traces at the failure, the Logs and the Metrics.

Contact sheets were reviewed for every width in both themes. Issues found and fixed:
1. **The selected incident label was covered by the selected agent's label** at 1280 px. A deep link to a failing event selects both, and both were "required", so the second was clamped on top. The fix (`scene/labels.tsx`, `scene/labelLayout.ts`, plus a test): the selected incident is placed first, and a required label tries its smaller forms in every slot before it may overlap.
2. **The 404 state** rendered the static server's own error page for an unknown path. The script now captures the exported `/404/` page, which works on any static host.

After both fixes, the full matrix was captured again: 148 images, exit 0, no page errors. In both themes and at every width, the failure states show the incident label in full with the agent's label clear of it.

No clipping, horizontal scroll or inconsistent components were found at the four widths. Known cosmetic items, not fixed:
- The Network cards truncate "Atrium · home" when a token count is shown.
- Crowded scenes collapse some robot labels to icons (by design; the roster lists every agent).

## 4. Not verified

- **Not exercised in a real session:**
  - interactive approvals and denials;
  - Esc interrupts;
  - compaction, `/clear` and resume;
  - notifications;
  - more than 8 subagents;
  - marketplace installation (`/plugin install runloop-tracer@runloop` from GitHub).

  The mapper handles them defensively, and synthetic fixtures cover several of them.
- **CI** (`.github/workflows/ci.yml`) has still never run on GitHub.
- **Keyboard-only and reduced-motion runs** were scripted by the design agents earlier in this milestone (see their reports). They were not repeated after the final integration.
- **Since the review fixes (§5):** the new permission outcomes (denial at `PostToolBatch`, an approval reconstructed from a late `PermissionRequest`), delegation linking by description and the "Delegation corrected" marker have synthetic and fixture coverage only. No new real Claude Code session was run for them.

## 5. Review fixes (27 findings)

> 2026-10-17. The tracer, design and state reviews found 27 issues. Each was re-checked before fixing. No real Claude Code session was run for this round. Large-trace numbers come from a **synthetic** 18.6k-event session (generated hook envelopes, labelled `Claude Code · synthetic`), on this container's headless Chromium with software WebGL.

**Checks after the fixes**

| Command | Result |
|---|---|
| `pnpm -r typecheck` | 8/8 projects pass |
| `pnpm test` | **50 files, 547 tests, all passed.** By project: events 70, core 41, world-engine 58, replay 13, runtime 167, testkit 3, claude-code-plugin 22, studio 173. |
| `pnpm build` | Static export: `/`, `/overview`, `/world`, `/traces`, `/integrations`, `/settings`, 404 |
| `claude plugin validate integrations/claude-code-plugin` (and `--strict`, and `--strict .` for the marketplace) | Validation passed |
| `RUNLOOP_DATA_DIR=<scratch> pnpm demo -- --speed 0 --port 0` | 58 events; `run_command` 10 passed / 2 failed (seq 36), then 12/12 (seq 55); `run.completed succeeded`; exit 0 |
| `pnpm vitest run --project runtime claude-code-plugin.e2e` | 10 tests passed (includes a spool backlog larger than one request, flushed oldest first and ending in `SessionEnd`) |
| `node scripts/screenshots.mjs --studio … --api … --traced 0d3a3dd9… --executed 6678ba4a…` | See "Screenshots" below |

**Findings**

| # | Finding | Status | Fix and evidence |
|---|---|---|---|
| T1 | A spool backlog over 20 envelopes was sent out of order | Fixed | The hook sends the spool oldest first in batches (≤ 100 envelopes, ≤ 512 KiB), its own event last, until its time budget runs out. A rejected batch is split so one bad envelope is dropped alone. Tests: 130-envelope backlog in order with `SessionEnd` last; out of time keeps the rest spooled; one rejected envelope; plugin E2E backlog. |
| T2 | Realistic credentials in commands, URLs and errors were stored verbatim | Fixed, with a stated gap | Shared patterns now cover Stripe, GitHub, GitLab, AWS, Slack webhooks, Google, npm, Docker, URL passwords, `Authorization`/`X-…-Key` headers, `key=value` in JSON/forms/queries, `curl -u`, `mysql -p`. Shell commands add `NAME=value`, `--password`-style flags, `login -p`/`sshpass -p`, and long values after credential words. Every matched value is also masked wherever else the hook repeats it. Shell `tool.call_started` events are `sensitive`. Parity-tested corpus of 17 real-world commands. **Gap:** bare positional passwords (`tool login hunter2`) are not recognised. |
| T3 | The idle sweep used the client's `observedAt`, so a late backlog was swept as it arrived; late results after a sweep were dropped | Fixed | Idleness counts from when envelopes arrive (wall clock). A result for a call closed by a sweep (not by `SessionEnd`) is still recorded. Tests in `ingest.test.ts` ("idle sweep and late results"). |
| T4 | A subagent was linked to an `Agent` call by arrival order, recorded as reported | Fixed, differently | The link matches description and type and is marked `inferred`. When the `Agent` result names a different subagent, a reported `run.marker` "Delegation corrected: …" is recorded. **Deviation:** no event retitles the earlier task; the marker carries the correction. |
| T5 | A permission denied with no hook stayed pending until the next Stop | Fixed | `PostToolBatch` is registered; a pending permission is closed as denied (inferred) at `PostToolBatch`, or at the same agent's next `PreToolUse` once its batch ended. Tests: permission outcomes in `claude-code-mapper-cases.test.ts`; goldens updated. |
| T6 | Async permission hook races made the record wrong | Fixed, with a stated gap | A `PermissionRequest` that arrives after the call's result matches the recently closed call and records the request plus an approval (inferred). A notification-sourced permission is replaced by the later `PermissionRequest`. **Gap:** a request that matches no call is still closed as denied (inferred) at the next boundary. |
| T7 | The synchronous Stop hook's latency was unbounded | Fixed, with a stated gap | Sync budget 1000 ms, POST timeout 500 ms, a self-timeout from process start. Measured: runtime up 126–160 ms; hung runtime 568–574 ms; hung with a 20k-file spool 730–761 ms; with 32–64 concurrent async hooks 537–645 ms. **Gap:** Node's own start-up is outside the budget. |
| T8 | A failed spool write silenced tracing | Fixed | The hook sends the event directly when the spool cannot be written, and records the error. Test: spool path is a file. |
| T9 | Strings were capped before redaction, splitting secrets | Fixed | Each kept window is redacted before the cut (4 KiB margin). Test: a key straddling the cap. |
| T10 | An existing token file's permissions were not fixed | Fixed | The runtime warns on a foreign owner and `chmod 0600`s a group/world-readable token file; `--doctor` warns too. Tests in `ingest.test.ts` and `hook.test.ts`. |
| D1 | Replay could not stop on an event that shares its millisecond with later events | Fixed | The replay cursor carries a sequence; step, seek and deep links move by event. `at=` keeps a paused playhead. Repro: a burst of 23 same-millisecond events: deep link to event 17 shows "event 17 of 23", ← gives 16, → gives 18. |
| D2 | The Network graph scaled its text down to 8.6 px | Fixed | No scaling. The graph tries full cards, then narrow cards, then a top-down layout, and uses the first that fits. At 1280 px narrow cards ellipsize the role and token line. Tests in `graph.test.ts`. |
| D3 | Rows after the playhead were dimmed below AA | Fixed | Future rows use muted token colours (AA) and the playhead is a dashed line. Contrast audit: 0 text pairs below AA on Traces (failure, logs), World and Network, both themes. |
| D4 | Chips on the selected row fell below AA | Fixed | Chips have an opaque base under their tint; the selected row uses `--rl-surface-2` with a lime bar. Same audit. |
| D5 | Every timeline row was a Tab stop | Fixed | Timeline and logs are one Tab stop each (roving tabindex; arrow keys, Home, End). The inspector is reached at Tab #44 instead of #68 on the same page. |
| D6 | Tab focus rings were clipped | Fixed | The ring is drawn inside the tab. Checked with keyboard focus captures. |
| D7 | The failure zone's sign was missing in failure states | Narrowed | The incident label now starts with the zone ("Test Chamber · Tool error · …"). **Deviation:** the zone sign itself still yields to the required incident and agent labels in a crowded view (visible in the 1280 px failure captures). |
| D8 | Status signals disagreed for a finished run ("Paused" in amber vs "Recorded") | Fixed | Header and world overlay share one status; "Paused" is an info state; a finished run opened by a deep link settles on its end ("Recorded"). |
| D9 | `--rl-text-2xs` was 11 px | Fixed | 12 px; inline code is at least 12 px. A font-size audit found nothing below 12 px. |
| S1 | Large traces froze the Studio (quadratic fold) | Fixed, with a stated gap | Batch folds mutate private copies (`transient`), tool calls live in a bucketed `IdMap`, open failures are indexed, replay snapshots fold in linear segments. On the synthetic 18.6k-event trace: `ReplayIndex` per-event appends 51.3 s → 1.1 s; one append 1.4 s → 0.43 s; Traces page loads in 2.3 s, steps take 1–102 ms. World page loads in 5.6 s, steps 100–729 ms (software WebGL dominates). **Gap:** each live event still costs 0.36–0.48 s of UI work at this size. A replay perf test guards the fold. |
| S2 | A traced failure was shown resolved at turn end | Fixed | Traced incidents resolve only on a later passing test run or the same call succeeding, labelled "Resolved (inferred)". Tests in `reduce-execution.test.ts`. |
| S3 | Late live events rewrote a paused replay | Fixed | A paused replay keeps its sequence; later events do not move it. Store tests. |
| S4 | Refresh after selecting an agent moved to a different event | Fixed | The URL names the agent card (`agent=` only) while the Agent tab is open. Repro: before and after refresh identical. |
| S5 | A filter that hid the selected row marked another row selected | Fixed | No row is marked; a hint "Selected event #N is hidden by the filters. [Show it]" appears. Tests in `timeline.test.ts`. |
| S6 | Interrupted subagents showed "working" | Fixed in the Studio | An agent still working when its run ended shows "unfinished" (graph, table, inspector). **Deviation:** Layer 1's `interruptRun` is unchanged; the mapping is presentation-only. |
| S7 | The inspector's Agent fact named the selected agent, not the event's | Fixed | It names the event's agent. Repro: event 9 with `agent=sa-…` shows "Agent: Claude". |
| S8 | `closeCall` copied every closed id (quadratic ingest) | Fixed | Closed ids are kept in frozen chunks plus a small recent list. A mapper cost test runs 10k calls. Recorder-mode ingest of the synthetic trace: 818–845 envelopes/s; over HTTP with the rate limit: 106 envelopes/s. |

**Screenshots**

`scripts/screenshots.mjs` against the scratch runtime (the 3 real traced runs, the demo run, and synthetic traced runs labelled `Claude Code · synthetic`) and the rebuilt static Studio: 148 images in 502 s, exit 0, no page errors. The 1280, 1920 and 390 px captures in both themes were reviewed. They showed three issues, which were fixed and re-captured (38 images, no page errors):
1. The Logs tab's agent column shifted on rows with a chip. Every row now reserves room for one chip.
2. On narrow Network cards, the token line was cut off without an ellipsis. It now ellipsizes.
3. A layer wrapped into sub-columns placed them 16 px apart, so message labels covered the next card. Sub-columns are now spaced like layers (`graph.test.ts` checks the gap).

Remaining cosmetic items:
- At 1280 px a message label can touch the left border of the next card. No text is covered.
- In crowded failure views, zone signs give way to the incident and agent labels (D7 above).
- The world's incident label is cut at its maximum width ("… 12 tests:").


## 6. Run compare, baselines and the world pass (2026-10-18)

> Integration review after the compare (C1–C3) and world (D10) builders finished. Same machine and tools as above. **No new real Claude Code session was run** (no spend): the real-data checks use a copy of the B6 database (`data-e2e`, three real sessions and one demo run), served by a runtime on port 4403 with its own token file, and a static Studio on port 3033.

**Checks**

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK; lockfile unchanged, no new dependencies |
| `pnpm -r typecheck` | 8/8 projects pass |
| `pnpm test` | **52 files, 632 tests, all passed.** By project: events 70, core 77, world-engine 58, replay 13, runtime 173, testkit 3, claude-code-plugin 22, studio 216. |
| `pnpm build` | Static export: `/`, `/overview`, `/world`, `/traces`, `/experiments`, `/integrations`, `/settings`, 404 |
| `claude plugin validate --strict integrations/claude-code-plugin` and `--strict .` | Validation passed |
| `RUNLOOP_DATA_DIR=<scratch> pnpm demo -- --speed 0 --port 0` | 58 events; `run_command` 10 passed / 2 failed (seq 36), then 12/12 (seq 55); `run.completed succeeded`; exit 0 |
| `pnpm screenshots --studio … --api …` | **212 images in 12 min, exit 0, no page errors**: 27 states × {dark, light} × {1280, 1440, 1920}, and 25 at 390 (the Network graph is desktop-only). The new states are the default Experiments pair, each run kind's pair and its lower half, an unknown run in the link, Experiments offline, and a pinned baseline's Traces header. After a last copy change, the 7 Experiments states were captured again: 56 images, no page errors. |

**Baselines (C1) on the real database**

| Check | Result |
|---|---|
| Start the runtime on the copied database (schema 2) | Migration 2 applied: `user_version` 2 → 3; every run kept its status and event count |
| `POST /api/runs/:id/baseline` without `Content-Type: application/json` | 415 |
| The same with `Origin: http://evil.example` | 403 |
| An unknown run | 404 |
| Pin session 1, then pin it again | 200 both times, the same `pinnedAt` |
| `DELETE` (the screenshot script's temporary pin, then a manual unpin) | 200, `pinnedAt: null` |
| SIGTERM the runtime, start it again on the same data dir | The pin kept the same `pinnedAt` (`2026-10-18T03:27:20.001Z`); runs and event counts unchanged |
| Pin through the Studio (run header of session 3), unpin, Undo, reload | 7/7: toast and `aria-pressed` follow the API's `pinnedAt`; Undo re-pins; the pin survives a reload; left unpinned |

**Every number on the Experiments page against the raw events (C2, C3)**

Method: a script (session scratch, `integ/check-compare.py`) reads `GET /api/runs/:id/events` and recomputes each value without `packages/core`:
- duration from `run.started` to `run.completed`;
- tool calls by category (as reported, or by Runloop's own tool for executed runs), and failed calls;
- failures (error results, failed calls, failed tasks);
- the latest test counts and the number of test runs;
- reported tokens per agent (`totalTokens`);
- turns and delegated tasks;
- permission counts;
- read and edit calls without a target;
- the first divergence: calls in start order by category, tool and target, then by status and test counts.

It then compares each value with the page's text, captured by Playwright.

| Pair | Checks | Result |
|---|---|---|
| Session 1 (pinned, 47 events) vs session 2 (45 events) | 25 | **25 pass** |
| Session 1 vs session 3 (the page's default pair: newest pin vs newest other run of the project) | 23 | **23 pass** |
| Two demo runs at speed 1, recorded with targets | 19 | **19 pass** |

For the record, session 1 → session 2:
- **Duration:** 21.3 s → 16.4 s ("4.9 s faster").
- **Tool calls:** 9 → 8. Command 3 → 2; Delegate 2, Test 2, Edit 1 and Read 1 in both.
- **Failures:** 0 → 1 (seq 9, exit code 1). Failed calls 0 → 1.
- **Tests:** latest run 12/12 in both, two test runs each.
- **Tokens:** 42,902 → 42,490. Explore #1 20,938 → 20,847; Explore #2 21,964 → 21,643; Claude *not reported*.
- **Delegation:** 1 turn and 2 subagents in both; no permission requests.
- **First divergence:** call 1, `node --test` in both. Session 1 reported success with 10/12 (its command was piped through `tail`); session 2 reported an error with 10/12.
- **Files:** not listed. The sessions predate `target`, and the page says so with the count of unnamed read and edit calls (2 and 2).

**Event links.** On the real pair, four links each opened Traces at the right run and event, with no page errors:
- the candidate's divergence result → `run=0d3a…&event=9`;
- the baseline's divergence call → `run=680b…&event=8`;
- the candidate's failures count → `run=0d3a…&event=9`;
- the baseline's usage report for Explore #2 → `run=680b…&event=37`.

**Found on real data, and fixed at the root**

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | "Failed along the way, candidate only: *listOpen returns only tasks that are not done*", although session 1's first test run (piped through `tail -n 80`) named only 1 of its 2 failures | Core claims a name for one side only when the other side named every failure of every test run. Otherwise the page says how many were named ("the baseline's test runs named 1 of 2 failures"). | Core test modelled on these sessions |
| 2 | An executed run recorded before `target` existed diverged from a newer one at call 1 (target missing vs `"."`) | A target only one side reported is unknown, not different | Core test; old vs new demo run: "No divergence: both runs made the same 9 calls" |
| 3 | A speed-1 demo run against a speed-0 one read "25.8 s faster" in green | `run.started.speed` (additive) records the pacing. Durations at different paces are not comparable (`pace_differs`); an unrecorded pace adds a caveat (`pace_unknown`). | Core and runtime tests. Pages: "not comparable · the demo ran at a different pace (speed) in each run"; "10 ms slower · the demo's pace was not recorded for one run" |
| 4 | "Compare" on a demo run's header (and in the palette) used the pinned Claude Code session as its baseline | `baselineFor` returns only pins of the same task | Studio test; demo-run headers show no "Compare" while only a session is pinned |
| 5 | The divergence lead said "The runs differ from their first tool call. The 1st call is the same, with a different result." | Separate wording per case ("Both runs began with the same call, with a different result.") | Screenshots |
| 6 | The sidebar's baseline mark was cut off on the pinned run | The pin comes before the text, which truncates instead | Screenshots; the mark's accessible name is "Baseline" |
| 7 | Run pickers repeated the project ("e2e-ws · e2e-ws") | The subtitle drops the project when the title already names it | Screenshots |
| 8 | Files said "Neither run read or edited a named file." for runs whose reads and edits had no target | "No file names to compare: 2 read or edit calls in the baseline and 2 in the candidate did not name their file." | Screenshots |
| 9 | At 1280 px a change chip ran past its half-width card; at 390 px the tables scrolled sideways | Container queries: under 500 px the column headers shrink to their A/B tags (the words stay for screen readers); under 400 px each row's label takes its own line | Screenshots at 1280 and 390, both themes |
| 10 | The Metrics panel said a demo run's "source does not categorise its tool calls", while Experiments showed Read, Edit, Test and Search for the same run | Metrics uses core's `callCategory` too: the categories of Runloop's own tools, labelled as such; a category bar filters an executed run's timeline by that category's tools | Studio test; screenshots |
| 11 | At 390 px the run header's actions (Pin, Compare, Switch run, the cross-link) ran off the screen | They wrap on phones | Screenshots |

**World pass (D10)**

Measured with the framing code at the stage sizes the framing tests use (canvas sizes of real windows with the inspector open):

| Window | Board width / stage width | Robot height (2.2 units) |
|---|---|---|
| 1280×800 | 96.2% | 35 px |
| 1440×900 | **97.0%** | **44 px** |
| 1600×1000 | 97.5% | 54 px |
| 1920×1080 | 80.7–82.3% | 60 px |

- **Criteria:** ≥ 80% and ≥ 28 px at 1440 both pass; the tests assert both.
- **Look:** the diorama with chibi robots was reviewed in both themes in the screenshot matrix. The light theme is the "architectural model" look recorded as DL-009.
- **Not built:** the collapsible timeline from the task's description (now D11).
- **Performance:** the world builder's figures were not re-measured here: draw calls 273 → 286 (high quality), and frame time 263 → about 329 ms under software WebGL, from the larger board.

**Not verified in this round**
- **No real Claude Code session with targets.** The three real sessions predate `target`, so real file lists and target-based divergence are covered only by fixture goldens and unit tests.
- **Cost:** not compared, because no source reports it.
- **Real-GPU frame rate.**
- **Keyboard and reduced-motion runs of Experiments were not repeated here.** The compare builder's Playwright script covered keyboard picking (11/11 before this round). This round re-checked pinning through the UI on the final build: pin from the run header (toast, `aria-pressed`, API `pinnedAt`), unpin, Undo, and a reload, 7/7 with no page errors; the run was left unpinned.
