# Verification report: Claude Code tracer, Runloop Signature Studio, run compare and the town

> 2026-10-17 (§1–§5) and 2026-10-18 (§6, §7) · branch `claude/amazing-wright-rzio6c` · Node 22.22.0 · pnpm 10.28.0 · Claude Code 2.1.302 · Linux, headless Chromium (SwiftShader WebGL) for screenshots.
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
| **A failing Bash test shown as an incident**, with the real failure | Session 2, seq 9: `tool.call_completed {status: error, errorType: exit_nonzero, exitCode: 1, outputSummary: "Exit code 1 · 12 tests: 10 passed, 2 failed"}`. The failing tests are `listOpen returns only tasks that are not done` and `listOpen reflects complete()`. It was delivered by `PostToolUseFailure` and is shown as a red **Tool error** incident at the Test Chamber, with a failure marker on the scrubber. Committed at the time as `docs/assets/claude-code-failure.png` (in git history; removed from `docs/assets` on 2026-10-18 when the README moved to town images, §7). | Pass |
| **The inspector on that tool call** | The inspector text at `?event=9`: "Bash error · 10 passed, 2 failed · Reported · Input `node --test` · Result Exit code 1 · Error type exit_nonzero · Exit code 1 · Provenance: Start reported by Claude Code, End reported by Claude Code · Test results 10 passed, 2 failed, 12 total". *(session)* `e2e/s2/post-world-incident.png`, `e2e/s2/post-traces-incident.png`. | Pass |
| **Metrics**: subagent tokens "reported by Claude Code", main agent "not reported" | Traces → Metrics, the "Tokens and model per agent" table: Claude, *not reported*. Explore #1, `claude-haiku-5-5`, 20.8k, Claude Code. Explore #2, `claude-haiku-5-5`, 21.6k, Claude Code. Footnote: "Claude Code reports usage for subagents only…". Tokens card: 42.5k, "reported for 2 of 3 agents". Cost: *not reported*. *(session)* `e2e/s2/post-metrics-tokens.png`. | Pass |
| **2D graph with delegation edges** | Network view: You → Claude ("Turn", 2 messages) and Claude → Explore #1 / Explore #2 ("Delegated", 1 message each). The subagent cards show reported tokens and model. It was captured live (*(session)* `e2e/s2/live-graph.png`) and after the run (committed at the time as `docs/assets/claude-code-network.png`, in git history; removed on 2026-10-18, §7). | Pass |
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
- **Look:** the diorama with chibi robots was reviewed in both themes in the screenshot matrix. The light theme is the "architectural model" look recorded as DL-013 (numbered DL-009 at the time).
- **Not built:** the collapsible timeline from the task's description (now D11).
- **Performance:** the world builder's figures were not re-measured here: draw calls 273 → 286 (high quality), and frame time 263 → about 329 ms under software WebGL, from the larger board.

**Not verified in this round**
- **No real Claude Code session with targets.** The three real sessions predate `target`, so real file lists and target-based divergence are covered only by fixture goldens and unit tests.
- **Cost:** not compared, because no source reports it.
- **Real-GPU frame rate.**
- **Keyboard and reduced-motion runs of Experiments were not repeated here.** The compare builder's Playwright script covered keyboard picking (11/11 before this round). This round re-checked pinning through the UI on the final build: pin from the run header (toast, `aria-pressed`, API `pinnedAt`), unpin, Undo, and a reload, 7/7 with no page errors; the run was left unpinned.

## 7. The town, real agents and dispatch (2026-10-18)

> Integration of the world-simulation slice (S0–S4 of `docs/architecture/world-simulation.md`) after the five builders finished. Same machine and tools as above (Node 22.22.0, Claude Code 2.1.302, SwiftShader). Runtime on port 4380 with `RUNLOOP_DATA_DIR=<scratch>/data-world-e2e` and its own token file; Studio static export on port 3000 (`python3 -m http.server`).

### Integration fixes

The builders' reports listed gaps between workstreams; these were closed at the root, each with a test:

| Problem | Fix | Test |
|---|---|---|
| `runtime.ts` did not wire the agent layer or dispatch: the shipped runtime answered 404 on `/api/agents` | `createRuntime` builds `AgentService` (the tracer's `onSessionSeen` feeds it) and the dispatch manager, mounts their routes, starts them after the world and stops them before it; `RUNLOOP_WORLD=off` answers 404 `world_disabled` on agent routes; exports and CLI help updated | `runtime-agents.int.test.ts` (Add to World, hooks over HTTP make the agent live in the real world host, a failing test shows as an incident, restart reads offline, the switches) |
| A cancelled or timed-out dispatch sends no SessionEnd, so its run stayed open and the agent read live for 5 minutes | `TraceSessionManager.closeStopped` closes the run as interrupted (inferred), wired to dispatch's `onStopped` | same file |
| **Found in the real run:** a dispatch in a workspace that had been traced with `--plugin-dir` got no `--plugin-dir` ("it already sent hooks"), so it ran untraced | The CLI probe also reads `claude plugin list --json`: `--plugin-dir` unless the tracer is installed and enabled; the old heuristic only when the CLI cannot say | `dispatch-units.test.ts`, `dispatch.int.test.ts` (fake CLI reporting the plugin installed) |
| **Found in the E2E:** keys typed right after ⌘K went to page shortcuts (Space pauses the world) while a busy 3D frame delayed the dialog's focus | The dialog focuses its first field at once, then once more on the next frame | `scripts/e2e-world.mjs` (⌘K → name → Enter) |
| A deep-linked `?focus=resident:` did not frame the resident (the request arrived before positions existed and was dropped) | The town camera keeps an unplaceable focus for up to 6 s and retries each frame | screenshots (`resident-why`) |
| **Found in the real run:** inside an agent's building, the interior kept showing the session opened on Enter; a session that started while watching (a dispatched task) did not appear | The interior follows the building's open session (`Town3D`: when the entered agent's `activeRunId` changes, the Studio opens that run) | a fourth real dispatch, watched from inside (below) |
| A grouped dispatch item in the feed showed "You" next to "completed" | A merged item takes the provenance of its latest event | `attention.test.ts` |
| Render quality offered only high or low, so adaptive quality never ran | An "Automatic" preference (now the default) is passed to the town | `prefs.test.ts` |
| `dispatch.int.test.ts` timed out on a loaded machine (a fake run replays a session through the real hook script) | 30 s per test, and a 1.5 s test "minute" for task timeouts | the file passes alone and next to three busy CPU loops |
| The fold comment in `events/src/world.ts` said every building starts empty | Homes start occupied | — |

### Deviations from the plan (all recorded by the builders, kept)

- **Contracts, additive:** `world.created` carries `worldId`; `resident.decided` adds `rates` and `until`; `resident.arrived` carries `place`, `slotId`, `needs`, `rates`; needs are milli-points (0–100 000), so replay equals live exactly. `AgentPresence` adds `lotId`, `openIncidents`, `dispatch`. The town file has more top-level fields (start time, population, crossings, areas, landmarks, schedules, needs, look, agent HQ) and a sixth district, Brookside.
- **Sim API:** `step` takes `{town, seed}` and `applyEvent` takes the town (the snapshot carries neither); `applyInputs` applies commands between ticks, so a paused world still answers commands. Walk paths are the BFS field descended from the target (same length as `bfs`, not always the same cells).
- **Agents:** "first event" means the first recorded event of a bound run (a SessionStart alone stays *awaiting first event*); activity is sent only when it changes; a claim binds and backfills but adds no folder.
- **Dispatch:** approval needs an Origin header (present and allowed); the nonce also binds the resolved `claude` executable; the environment allowlist adds `RUNLOOP_INGEST_TOKEN_FILE` and names listed in `RUNLOOP_DISPATCH_ENV`; dispatch is on by default; a task starting with `-` is refused; `lost` is reported by `system`; the "awaiting approval" attention is not emitted. **`--plugin-dir` follows `claude plugin list`** rather than "the workspace never sent a hook" (fixed above).
- **Renderer:** the static town is a few merged meshes (per-building state in a small texture) rather than instanced per archetype; shadows are variance shadow maps updated only when the sun moves; the JS budget is checked at p50 under SwiftShader.
- **Studio:** a resident's Why comes from `/api/world/explain` (built by the server from the recorded event; the panel still drops unsourced factors); the "while you were away" card exists although the plan defers catch-up.
- **Decision log:** the light-world entry was renumbered DL-013 so DL-009–012 match the plan.

### Checks

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK; lockfile unchanged by the integration (no new dependencies) |
| `pnpm -r typecheck` | 10/10 projects pass (events, testkit, core, world-engine, replay, town, sim, runtime, claude-code-plugin, studio) |
| `pnpm test` | **96 files, 1082 tests, all passed** (two consecutive runs). By project: events 149, core 77, world-engine 60, replay 13, town 79, sim 70, runtime 294, testkit 3, claude-code-plugin 22, studio 315. New in the integration: `runtime-agents.int.test.ts` (4), plugin-probe unit and integration tests (3), feed provenance (1), automatic quality (prefs). |
| `pnpm build` | Static export: `/` (the town), `/overview`, `/world`, `/traces`, `/experiments`, `/integrations`, `/settings`, 404 |
| `claude plugin validate --strict integrations/claude-code-plugin` and `--strict .` | Validation passed |
| `RUNLOOP_DATA_DIR=<fresh> pnpm demo -- --speed 0 --port 0` | 58 events; `run_command` 10 passed / 2 failed (seq 36), then 12/12 (seq 55); `run.completed succeeded`; exit 0; the database is at schema 5 with the world created |
| `node scripts/e2e-world.mjs --fresh` (fresh runtime, new world at 08:00) | **11/11 checks pass:** the town rendered in 2.7 s; **62 of 80 residents** walked within 3 s (needed ≥ 48); the clock went 08:05 → 08:07; ⌘K on "Otto Haddad" opened the panel; the Why's 4 factors cite `resident.decided` seq 2 (`simulation`); Follow pressed; the café interior opened; no page errors |
| `node scripts/e2e-world.mjs` (the e2e world, Day 5 04:00) | 10/11 before the day-only rule: 0 residents walked at 04:00, when nearly all sleep; the script now requires walking only by day (06:00–22:00) |
| `node scripts/perf-town.mjs --port 3000` | All 9 views within budget, exit 0 (below) |
| `pnpm --filter @runloop-world/sim bench` | Below |
| `pnpm screenshots` | 172 images, exit 0, no page errors (below) |

### Real end to end

**Setup.** `pnpm serve -- --port 4380` with `RUNLOOP_DISPATCH_ENV=NODE_EXTRA_CA_CERTS,HTTPS_PROXY,NO_PROXY` (this sandbox's proxy). New world: `runloop-commons`, seed 725890276, content hash `6d0c75459a19e7e2`, 80 residents, created 10:19:48Z. Workspace: a git copy of `examples/coding-mission/repo` with `implement.buggy.js` as `src/task-store.js` (`node --test`: 10 passed, 2 failed).

| Step | What happened | Result |
|---|---|---|
| (a) A living town | `scripts/e2e-world.mjs` (written for this check, plan S2 E2E) against the live world: the town rendered in 2.8–3.1 s; 5–16 residents walked in each 3 s window by day; the clock advanced ("Day 1 · 09:33" → "09:36"); ⌘K on a walking resident's name opened their panel; the Why was labelled "Simulated resident · rule-based decision" and its 4–5 factors all cited `resident.decided` events that exist (e.g. seq 377, prov `simulation`, actor = the resident); `?focus=building:bld_corner_cafe` → Enter showed the café interior. The first runs failed twice: ⌘K typing was lost while the 3D frame delayed the dialog's focus (fixed above), and the script's Follow check toggled a follow ⌘K had already set (fixed in the script). On a fresh world: see Checks (62 of 80 walking within 3 s, 11/11). | Pass |
| Follow through lunch | Instead of watching at 4× in the browser, three residents (`res_0005`, `res_0012`, `res_0040`) were followed through Day 2, 11:00–14:00, in the recorded world log (`/api/world/events?actor=`): 29 events, 15 decisions. For each decision, `explain(atSeq)` named the same action and place as the recorded event, and the resident's next arrival was at that place (e.g. `res_0012`: lunch at the Café patio at 11:49, arrived 12:08; back to work at Signal House at 12:49, arrived 13:08). | Pass |
| (b) Add to World | Through the dialog: "Claude", lot 1, the workspace path. `agt_abc0a41c-ac3b-40af-ac88-7339626e3f07` in `bld_agent_hq_1`, health `awaiting_first_event`, building dimmed with "Waiting for first event". | Pass |
| (c) One real session | `env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION claude -p "<run node --test; one subagent reads the test file; fix with Edit; rerun>" --model haiku --session-id e7659ec6-205b-429c-800a-02b7859cbe10 --plugin-dir <repo>/integrations/claude-code-plugin --allowedTools "Read,Grep,Glob,Edit,Agent,Bash(node --test*)" --max-budget-usd 0.09`. **$0.0163, 6 turns, 18.3 s**, exit 0, 12/12 tests afterwards (`listOpen` filter fixed). 23 hook deliveries → run `4e234825-0948-535f-9129-478f11094eee` (32 events), bound by path at SessionStart (10:31:52.498Z). **Live 1.08 s after the first hook** (SessionStart observed 10:31:52.293Z; `agent.connection_changed live` at 10:31:53.375Z, 0.02 s after the first prompt arrived). The building showed counts by category as they came (test 1 → delegate → read → edit → test 2) and 1 subagent; 9 `agent.activity_observed` (external-agent, observed) and 2 `agent.session_changed`; offline at 10:32:11.6Z after SessionEnd while the clock ran on. No incident: Haiku ran `node --test 2>&1 \| tail -n 60`, which exits 0, so Claude Code reported success and the trace says so (the same finding as §2). The incident path is covered by `runtime-agents.int.test.ts`, which sends a recorded real session's failing `node --test` through ingest and sees `openIncidents > 0` and attention `incident`. | Pass, except the live incident (not exercised by this session) |
| Interior | "Enter building" shows the research-campus diorama at 0.5 scale. For the real session it was captured after the session ended (under SwiftShader the page lags the runtime by seconds); Live World of the same session at event 17 shows Claude and "general-purpose #1" reading the test file. Watched from inside during dispatches 3 and 4 (below): dispatch 3 showed the old session (the bug above); after the fix, dispatch 4 showed Claude walking to and reading at the Observatory, the panel "Working · read 4 · from run events 1–14", the task "Running". | Pass |
| (d) Assign task | Through the dialog, haiku, Read-only, $0.05: preview → approve → done. Dispatch 1 `dsp_35b64d6c-8c07-4564-a3a3-3c6adbac9341` completed in 6.8 s, **$0.0023**, exit 0, correct answer — but untraced (no run): the bug above. After the fix and a restart, dispatch 2 `dsp_b8119b59-6dd3-426c-b830-9f8320722c6f` (session `9dd86987-16ab-4a0c-aae8-2fd61a04368f`) ran with `--plugin-dir`, completed in 7.0 s, **$0.0015**, 2 turns, and was traced as run `5466ef3c-e80d-5984-ac07-15871a29c0d0`, **bound by dispatch**. World events: approved (user) → running (system) → live → session started and activity (search 1, external-agent) → finished `completed` (system) → offline. Audit: previewed, approved, spawned, bound, exited. Dispatches 3 and 4 were approved through the API with the Studio's origin (the same requests the dialog sends) while a page watched from inside the building: `dsp_e8663dd7-f591-48d6-b33d-5406351c9030` ($0.0036, 6 turns, 11.4 s, run `58afc2d2-d2a2-5526-bf0d-5dba2175d7e9`) and `dsp_f342795d-9b93-4928-b994-aebf28a4a25a` ($0.0033, 7 turns, 13.0 s, run `d598d378-4272-506a-9c33-4cd7a9c121a9`), both completed, traced and bound by dispatch. | Pass |
| (e) Restart | SIGTERM (stopped in 1.3 s), restart on the same data dir. World id, content hash, seed, creation time, population and the roster (sha `2653ce58edfeca18`: ids, names, roles, homes, workplaces) identical; 28 buildings; `world.resumed_after_offline {offlineWallMs: 7534}` appended; the agent's building present, `housed`, **offline**; session `4e234825…` replays (32 events; Live World with the "Agent District › Claude › Session #1" crumb and Back to town). | Pass |
| P8 | The workspace's realpath appears in 0 rows of `worlds`, `world_events`, `agents`, `workspaces`, `agent_connections`, `session_bindings`, `audit_log`, `dispatches`, `runs` and `events`, and in no response of `/api/world`, `/snapshot`, `/events`, `/api/agents`, `/arrivals`, `/api/dispatches`, `/api/runs`; it is in `workspace_roots` once. | Pass |

**Spend:** session $0.0163 + dispatches $0.0023, $0.0015, $0.0036 and $0.0033 = **$0.027** (cap $0.15).

### Performance

`node scripts/perf-town.mjs` (SwiftShader, 1440×900, high quality; all 9 views pass, exit 0):

| View | Draw calls (+shadow pass) | Triangles | JS per frame p50 / p95 (ms) | Frame p50 (ms) | Actors |
|---|---|---|---|---|---|
| town | 46 (+73) | 132,605 | 1.3 / 13 | 74 | 84 |
| district (Market Street) | 46 (+73) | 163,645 | 1.3 / 19 | 33 | 84 |
| street (Market) | 12 (+39) | 143,801 | 1.1 / 4.9 | 33 | 84 |
| street (Atrium) | 14 (+41) | 144,189 | 1.4 / 5.3 | 27 | 84 |
| café interior | 13 (+41) | 145,959 | 1.1 / 10.7 | 82 | 84 |
| agent HQ interior | 218 (+236) | 178,975 | 1.9 / 18 | 86 | 84 |
| town at night | 47 (+32) | 132,653 | 1.2 / 10.7 | 64 | 84 |
| town, 504 actors | 46 (+73) | 147,725 | 1.7 / 5.7 | 72 | 504 |
| street, 504 actors | 15 (+42) | 323,387 | 2.2 / 10.4 | 38 | 504 |

Budgets (plan §9): draw calls ≤ 120 / 150 / 250 (town / street / interior), ≤ 400k triangles, JS ≤ 4 ms per frame with 500 actors (checked at p50; under SwiftShader the p95 measures pre-emption by the software rasteriser). Frame times here are SwiftShader's and are not a target; a real GPU was not available.

`pnpm --filter @runloop-world/sim bench` (Node 22.22.0), two runs each:

| Residents | Tick avg | p50 | p95 | p99 | max | One sim day | Events / day | Checkpoint (gz) |
|---|---|---|---|---|---|---|---|---|
| 120 | 0.19–0.27 ms | 0.16–0.23 | 0.44–0.59 | 0.89–1.02 | 3.5–4.2 ms | 275–390 ms | 4.8k, 1.6 MB | 11–12 KB |
| 288 (bench-only 4-floor Commons) | 0.49–0.50 ms | 0.40–0.46 | 0.95–1.10 | 1.56–2.24 | 7.3–7.9 ms | 707–718 ms | 11.3–11.4k, 3.8 MB | 27 KB |

Within budget: tick p99 ≤ 2 ms at 120; p99 ≤ 5 ms, max ≤ 15 ms and a day ≤ 2 s at 288; checkpoint ≤ 100 KB. **Over budget:** events per day (≤ 6k and ≤ 1 MB at 300).

### Screenshots

`pnpm screenshots --out <scratch>/matrix` against the e2e runtime and the static Studio: **172 images in ~65 min, exit 0, no page errors**: 22 states × {dark, light} × {1280, 1440, 1920, 390}, minus the two desktop-only states at 390. New states: `town`, `town-district`, `town-street`, `town-map`, `town-directory`, `cafe-interior`, `world-log`, `agents-mode`, `add-to-world-1/2/3`, `resident-why`, `agent-offline` (named after the agent's health), `agent-interior`, `dispatch-compose`, `dispatch-review`, `offline-town`, next to Overview, Integrations, Live World, Traces and Experiments. A night pass (`--suffix -night`) added town, district and street at night in both themes (1440).

Looked at every contact sheet and fixed what they showed:
- At 390 px the compact "Add" button had no "Add to World" name (Add to World states failed to open); it now carries the full accessible name.
- `?focus=resident:` did not frame the resident (fixed above); `?focus=district:dst_market_street` frames almost the whole town because Market Street spans it, so the district state now uses Civic Atrium.
- Dialogs were caught mid-fade under SwiftShader; the script waits for them.
The district, Add to World and Assign task states were captured again after these fixes (40 images, exit 0, no notes).

Earlier captures in the same session: the e2e steps (Add to World, the agent waiting, live, offline, its interior, the dispatch dialog and its result) and the night pass. Images in `docs/assets/` (town, town-night, resident-why, agent-live, agent-interior, add-to-world, assign-task) come from these runs; `claude-code-session.png` is kept from §6.

### Not verified

- A real cancel at the first tool call (plan S4 opt-in check): fake `claude` only.
- An incident on the building from a real session (see (c)); an interactive, non `-p` session with an approval.
- Watching one resident through lunch at 4× in the browser (the recorded log was followed instead, see above).
- Frame time on a real GPU; event-loop lag at 16× while ingesting 50 envelopes/s; memory after 7 wall-days; boot time (plan: ≤ 300 ms).
- Onboarding coachmarks, axe and keyboard-only passes (not built or not run).
