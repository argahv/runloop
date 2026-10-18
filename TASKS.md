# Task ledger

**States:** Not started · In progress · Blocked · Implemented, unverified · Verified · Deferred.

A task is **Verified** only when its acceptance criteria were exercised and the evidence is recorded in `docs/status/current-state.md` or `docs/status/verification-report.md`.

## Milestone W: A world, not a dashboard (current)

Vision: `docs/product/world-vision.md` (DL-009). Plan of record: `docs/architecture/world-simulation.md` (DL-010–012). Slice S0–S4 built on 2026-10-18; evidence in `docs/status/verification-report.md` §7.

| ID | Task | Status | Acceptance criteria and evidence |
|---|---|---|---|
| W1 | **A world that exists** (S0 contracts, S1): the Commons town file, compile and navigation, `WorldHost` (clock, persistence, checkpoints, resume), `/api/world` and SSE, the Studio's town, clock, map and directory | Verified | Close and reopen: the same world, buildings and identities return. **Evidence:** automated S1 tests (compile, door reachability and BFS paths, 40 ticks in 10 s at 4×, pause and resume, restart and SIGKILL resume, SSE fold equals the server hash, legacy links). Real runtime: after a SIGTERM and restart the world id, content hash, seed, creation time and roster (sha `2653ce58edfeca18`, 80 residents) were identical and `world.resumed_after_offline` was appended. Screenshots: town, district and street, both themes, four widths. Not measured: frame rate on a real GPU. |
| W2 | **A population that lives** (S2): needs, schedules, decisions, interactions, closing hours, Why, World Log, ⌘K | Verified, with gaps | Residents act without clicks, visit valid destinations, react to change, and every transition can be explained from recorded state. **Evidence:** a sim day at 80 and 120 residents meets the action, sleep and eat targets, nobody awake goes 6 h without deciding, the liveliness floor holds, closing the café re-routes walkers in the same tick, replayed `explain` equals live. `scripts/e2e-world.mjs --fresh`: 62 of 80 residents walking within 3 s (needed ≥ 48), the clock advancing, ⌘K → Why with every factor citing a recorded `resident.decided`, Follow, the café interior (11/11). Three residents were followed through a recorded lunch: every Why named what they then did. **Gaps:** the lunch was followed in the log, not watched at 4× in the browser; event volume is over the plan's budget (~4.8k events, 1.6 MB per sim day at 120 residents vs ≤ 6k events and ≤ 1 MB at 300); the Commons houses 136, so the 300-resident budgets were measured on a bench-only 288-resident variant. |
| W3 | **Functional buildings and organisations** (teams, tasks, rooms with capabilities) | Not started | Cut from this slice (plan §11). |
| W4 | **A real agent joins** (S3 observe, S4 dispatch): Add to World, binding, health, capabilities, the agent building and interior, Arrivals and claim, Assign task with approval | Verified, with gaps | A real Claude Code agent's confirmed activity shows in its building; simulated activity cannot be mistaken for real; the world keeps living while the agent is offline. **Evidence:** a real `claude -p` session (haiku, $0.016) in a folder added through the UI went live 1.1 s after its first hook, showed tool counts by category and a subagent, read offline after SessionEnd while the town kept its clock; two real dispatches through the Assign task dialog ($0.0023 and $0.0015) and two more watched from inside the building ($0.0036 and $0.0033) completed, the interior showing Claude reading at the Observatory; after a restart the agent's building survived, read offline, and its sessions replayed. Automated: S3 and S4 acceptance tests (P4, P5, P7, P8, P11, nonce, Origin, cancel, audit) and a wiring test through `createRuntime`. **Gaps:** the real session piped `node --test` through `tail`, so no incident appeared live (the incident path is covered by ingesting a recorded real session over HTTP); subagent helpers inside the building were seen only in replay (the read-only dispatches use no subagent); a real cancel at the first tool call was not run (fake `claude` only); no interactive (non `-p`) session. |
| W5 | **The world becomes a lab** (forks, history scrubber, re-run) | Not started | The world log and `WorldReplay` exist; the UI is plan §11 (W5). |
| W6 | **Emergent behaviour and scale** (LLM residents) | Not started | Plan §11 (costs money). |

**Open follow-ups from the slice:** reduce `resident.decided` volume (or trips) to meet the event budget; a 300-resident town; measure frame time on a real GPU (plan §9); onboarding coachmarks, axe and keyboard-only passes; an agent offline after a normal session end counts as "needs you" in the ticker (per the UX draft; may be too loud).

## Milestone A: Foundation

| ID | Task | Status | Evidence / location |
|---|---|---|---|
| A1 | Event contract, Layer 1, Layer 2 and the replay engine | Verified | `packages/{events,core,world-engine,replay}`; 182 tests (2026-10-17, after the review fixes) |
| A2 | Runtime: recorder, sandboxed tools, API, SSE, recovery | Verified | `packages/runtime`; integration tests; manual SIGINT/SIGKILL |
| A3 | Studio with live view, replay and the 3D world | Verified (prototype quality) | `apps/studio`; Playwright screenshots |
| A4 | Move the runtime port 4317 → 4380 (DL-005) | Verified | `DEFAULT_RUNTIME_PORT = 4380` (events), Studio and plugin defaults; the B6 runtime ran on 4380 with no `--port` |
| A5 | Real command sandbox for `run_command` | Deferred | Only needed before untrusted adapters execute commands; documented in known limitations |

## Milestone B: Claude Code tracer (the first real integration)

Plan: `docs/plans/claude-code-tracer.md`. It depends on A4.

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| B0 | Probe real hook payloads (M0) | Verified | Two real `claude -p` sessions logged; findings in plan Appendix C |
| B1 | Schema: traced run mode, `external` adapter, provenance, `run.marker`, tool category, `turn`/`delegated` kinds, `unobserved` failure, usage events | Verified | Additive only; old logs parse; demo golden trace unchanged |
| B2 | Pure mapper (hook payload → event drafts) with golden tests from sanitised real fixtures | Verified | Every fixture folds with no unexpected anomalies; one terminal event per call; subagents attributed by `agent_id` |
| B3 | Ingest endpoint, token file, session manager, dedupe, idle sweep, mode-aware recovery, migration | Verified | 401 without token, 403 with an Origin, 413, idempotent retries, concurrent sessions in separate runs, scripted runs unaffected |
| B4 | Plugin (`integrations/claude-code-plugin`): async hooks, spool, `--doctor` | Verified | `claude plugin validate` passes; the script always exits 0 with empty stdout; offline spool then flush produces the same events |
| B5 | Studio: traced badge, provenance banner, inferred chips, live sessions, dynamic subagent robots, tool category → station | Verified | A traced session renders live; provenance is visible; every character is placed at a valid station |
| B6 | **End-to-end acceptance with real Claude Code** | Verified | A real `claude -p` session with the plugin produces a live run in Studio with the main agent plus subagent robots, a failing Bash test shown as an incident, survival across a page refresh, and replay without re-execution. An automated test covers the fixture path; the real path is recorded in the verification report |

Still unverified with real sessions (outside B6's criteria): interactive approvals and denials, Esc interrupts, `/compact`, `/clear`, resume and the marketplace install. See `docs/status/current-state.md`.

**Review fixes (2026-10-17).** 27 findings from the tracer, design and state reviews were fixed or narrowed; each is listed in `docs/status/verification-report.md` §5. They were verified with unit and fixture tests, synthetic hook runs and Studio screenshots, not with new real Claude Code sessions. B2–B4 stay Verified on that basis; the new permission and delegation inferences have only synthetic coverage.

## Milestone C: Compare (the retention feature)

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| C1 | Pin a run as a baseline; pick any two runs to compare | Verified | Survives a restart (persisted). **Evidence (2026-10-18):** `runs.pinned_at` (migration 2) and `POST`/`DELETE /api/runs/:id/baseline`; runtime tests for idempotence, guards, 404, upgrading an older database and a restart. On a copy of the real B6 database (schema 2 → 3): pin 200, no JSON 415, foreign Origin 403, unknown run 404; after SIGTERM and restart the pin kept the same `pinnedAt`. Through the Studio: pin, unpin, Undo and reload, 7/7. Pickers for any two runs, `?a=&b=` deep links. |
| C2 | Run diff: outcome, duration, tool calls by category, files touched, test results, tokens and cost where reported, permission waits, failures | Verified | Unit tests on the diff function; unknown values show as "not reported", never as zero. **Evidence:** `packages/core/src/compare.ts`, 36 unit tests (plus 13 for the Studio wording and folding). Every number on the Experiments page was recomputed from the raw events by an independent script for two real Claude Code pairs and one executed pair: 25/25, 23/23 and 19/19 checks pass (verification report §6). Cost is not shown: no source reports it yet (subagent tokens only). |
| C3 | Compare view in Studio (side by side, with links to the differing events) | Verified | Clicking a difference opens the event in that run. **Evidence:** Experiments page; on the real pair, the divergence call and result, the failures count and a usage report each opened Traces at the exact run and event (4/4); the builder's Playwright script passed 11/11; `pnpm screenshots` covers Experiments in both themes at four widths. |

**Integration review (2026-10-18).** Checking the Experiments page against the raw events of the real B6 sessions found four places where compare claimed more than the data shows. All four were fixed at the root, with tests:
1. A test was listed as "failed only in the candidate", although the baseline's piped test run had named only 1 of its 2 failures (core).
2. A run recorded before `target` existed diverged from a newer one at call 1, only because its targets were missing (core).
3. Two demo runs at different paces (speed 0 and 1) read "25.8 s faster". `run.started` now records `speed`, and compare does not judge durations across paces (events, runtime, core).
4. "Compare" on a demo run offered the pinned Claude Code session as its baseline (Studio `baselineFor`).

Seven presentation issues found in the screenshots were fixed too (verification report §6).

## Milestone D: Runloop Signature design system and core observability

Spec: `docs/design/design-system.md` (founder brief). This milestone runs in parallel with B; B5 is built on top of it.

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| D1 | Tokens (dark and light), Geist and Geist Mono self-hosted, tabular numerals, motion tokens, reduced motion | Verified | `tokens.css` is the only colour source; contrast checked at AA in both themes |
| D2 | Component library `src/ui/` (sidebar, tabs, split and resizable panels, command palette, chips, skeletons, empty, error, toast, confirm) | Verified | Keyboard reachable; used by every page; no colour-only state |
| D3 | IA: Overview · Live World · Traces · Experiments · Integrations · Settings (Evaluations hidden until it works); deep links | Verified | Each page has loading, empty and error states; deep link restores run, view, event or agent card, and a paused playhead (`at=`) |
| D4 | Synchronised selection across world, timeline and inspector; resizable inspector | Verified | Selecting in any view focuses the same entity in the others (tested in the store) |
| D5 | World refresh: Signature palette, named environments (Atrium, Observatory, Workshop, Test Chamber, Launch Bay), lime only for active execution, fit to viewport, no label collisions | Verified | No clipped rooms at 1280–1920 px; labels never overlap at default zoom; screenshots in both themes |
| D6 | 2D agent graph ("Network") view and a table fallback | Verified | Every world interaction has a 2D route |
| D7 | Search and filter in the timeline and logs (agent, tool, category, status, text) | Verified | Filters compose; URL-addressable; tested |
| D8 | Run metrics panel (duration, calls by category, failures, tokens and cost where reported) | Verified | Defined calculations; "not reported" never shown as zero |
| D9 | Visual regression screenshots of every page and state | Verified | Script in the repo; images checked on each milestone |
| D10 | World richness pass: the world fills its panel (tighter framing, collapsible timeline), robots read clearly at default zoom, warmer key/rim lighting and materials, restrained zone accent light; keep the Signature restraint | Verified (except the collapsible timeline, moved to D11) | At 1440×900 a robot is ≥ 28 px tall at default zoom; the board fills ≥ 80% of the world panel width; founder-reference look (diorama, chibi robots) recognisable in screenshots of both themes. **Evidence:** measured with the framing code at the stage sizes of real windows: at 1440×900 the board spans 97.0% of the stage and a robot projects to 44 px; at 1280, 96%; at 1920, 81–82%. Tests assert ≥ 80% and ≥ 28 px. Screenshots in both themes (verification report §6); light-theme look recorded as DL-013. |
| D11 | Collapsible timeline on Live World, so the world can take the full height | Not started | The world panel grows when the timeline collapses; state survives a reload; keyboard reachable |

## Milestone E: Generalisation

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| E1 | Documented adapter contract and event-model docs | In progress | A new integration can be written from the docs alone |
| E2 | Codex CLI hooks integration (DL-004) | Not started | Real Codex session traced end to end, or fixture-verified if Codex cannot run here |
| E3 | Minimal TypeScript SDK for custom agents | Not started | An example agent emits a traced run |

## Milestone F: Productisation

| ID | Task | Status |
|---|---|---|
| F1 | Threat model, data-flow and retention docs; delete-run API | Not started |
| F2 | Contribution guide, security policy, changelog | In progress |
| F3 | Reproducible demo script (real Claude Code + scripted fallback, clearly labelled) | Not started |
| F5 | Marketing landing page in the Signature system ("Execution, made visible.") with a real recorded run | Not started |
| F4 | Performance measurements: ingest throughput, event-to-UI latency, large traces | In progress: first numbers on a synthetic 18.6k-event trace (labelled synthetic) in `docs/status/verification-report.md` §5; no CI benchmark, no real large session |

## Deferred (with reason)

| Item | Reason |
|---|---|
| Headless A/B runner (`runloop ab`) | Compare (C) now exists; still costs real tokens per run, so it waits for evidence that people use compare |
| OTLP/HTTP ingest bridge | OTel GenAI conventions are still in development; build on demand |
| OpenAI Agents SDK / LangGraph adapters | Different user (agent builders); revisit when demand appears |
| Hosted sharing, teams, billing | No validated demand yet; see the monetisation hypothesis |
| Multi-agent simulation experiments | Keep simulation separate from captured traces; after compare |
