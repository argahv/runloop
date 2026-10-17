# Task ledger

**States:** Not started · In progress · Blocked · Implemented, unverified · Verified · Deferred.

A task is **Verified** only when its acceptance criteria were exercised and the evidence is recorded in `docs/status/current-state.md`.

## Milestone A: Foundation

| ID | Task | Status | Evidence / location |
|---|---|---|---|
| A1 | Event contract, Layer 1, Layer 2 and the replay engine | Verified | `packages/{events,core,world-engine,replay}`; 235 tests |
| A2 | Runtime: recorder, sandboxed tools, API, SSE, recovery | Verified | `packages/runtime`; integration tests; manual SIGINT/SIGKILL |
| A3 | Studio with live view, replay and the 3D world | Verified (prototype quality) | `apps/studio`; Playwright screenshots |
| A4 | Move the runtime port 4317 → 4380 (DL-005) | Not started | `packages/events/src/protocol.ts`, docs, studio config |
| A5 | Real command sandbox for `run_command` | Deferred | Only needed before untrusted adapters execute commands; documented in known limitations |

## Milestone B: Claude Code tracer (the first real integration)

Plan: `docs/plans/claude-code-tracer.md`. It depends on A4.

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| B0 | Probe real hook payloads (M0) | Verified | Two real `claude -p` sessions logged; findings in plan Appendix C |
| B1 | Schema: traced run mode, `external` adapter, provenance, `run.marker`, tool category, `turn`/`delegated` kinds, `unobserved` failure, usage events | Not started | Additive only; old logs parse; demo golden trace unchanged |
| B2 | Pure mapper (hook payload → event drafts) with golden tests from sanitised real fixtures | Not started | Every fixture folds with no unexpected anomalies; one terminal event per call; subagents attributed by `agent_id` |
| B3 | Ingest endpoint, token file, session manager, dedupe, idle sweep, mode-aware recovery, migration | Not started | 401 without token, 403 with an Origin, 413, idempotent retries, concurrent sessions in separate runs, scripted runs unaffected |
| B4 | Plugin (`integrations/claude-code-plugin`): async hooks, spool, `--doctor` | Not started | `claude plugin validate` passes; the script always exits 0 with empty stdout; offline spool then flush produces the same events |
| B5 | Studio: traced badge, provenance banner, inferred chips, live sessions, dynamic subagent robots, tool category → station | Not started | A traced session renders live; provenance is visible; every character is placed at a valid station |
| B6 | **End-to-end acceptance with real Claude Code** | Not started | A real `claude -p` session with the plugin produces a live run in Studio with the main agent plus subagent robots, a failing Bash test shown as an incident, survival across a page refresh, and replay without re-execution. An automated test covers the fixture path; the real path is recorded in the verification report |

## Milestone C: Compare (the retention feature)

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| C1 | Pin a run as a baseline; pick any two runs to compare | Not started | Survives a restart (persisted) |
| C2 | Run diff: outcome, duration, tool calls by category, files touched, test results, tokens and cost where reported, permission waits, failures | Not started | Unit tests on the diff function; unknown values show as "not reported", never as zero |
| C3 | Compare view in Studio (side by side, with links to the differing events) | Not started | Clicking a difference opens the event in that run |

## Milestone D: Runloop Signature design system and core observability

Spec: `docs/design/design-system.md` (founder brief). This milestone runs in parallel with B; B5 is built on top of it.

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| D1 | Tokens (dark and light), Geist and Geist Mono self-hosted, tabular numerals, motion tokens, reduced motion | Not started | `tokens.css` is the only colour source; contrast checked at AA in both themes |
| D2 | Component library `src/ui/` (sidebar, tabs, split and resizable panels, command palette, chips, skeletons, empty, error, toast, confirm) | Not started | Keyboard reachable; used by every page; no colour-only state |
| D3 | IA: Overview · Live World · Traces · Integrations · Settings (Experiments and Evaluations hidden until they work); deep links | Not started | Each page has loading, empty and error states; deep link restores run, view, event and agent |
| D4 | Synchronised selection across world, timeline and inspector; resizable inspector | Not started | Selecting in any view focuses the same entity in the others (tested in the store) |
| D5 | World refresh: Signature palette, named environments (Atrium, Observatory, Workshop, Test Chamber, Launch Bay), lime only for active execution, fit to viewport, no label collisions | Not started | No clipped rooms at 1280–1920 px; labels never overlap at default zoom; screenshots in both themes |
| D6 | 2D agent graph ("Network") view and a table fallback | Not started | Every world interaction has a 2D route |
| D7 | Search and filter in the timeline and logs (agent, tool, category, status, text) | Not started | Filters compose; URL-addressable; tested |
| D8 | Run metrics panel (duration, calls by category, failures, tokens and cost where reported) | Not started | Defined calculations; "not reported" never shown as zero |
| D9 | Visual regression screenshots of every page and state | Not started | Script in the repo; images checked on each milestone |

## Milestone E: Generalisation

| ID | Task | Status | Acceptance criteria |
|---|---|---|---|
| E1 | Documented adapter contract and event-model docs | Not started | A new integration can be written from the docs alone |
| E2 | Codex CLI hooks integration (DL-004) | Not started | Real Codex session traced end to end, or fixture-verified if Codex cannot run here |
| E3 | Minimal TypeScript SDK for custom agents | Not started | An example agent emits a traced run |

## Milestone F: Productisation

| ID | Task | Status |
|---|---|---|
| F1 | Threat model, data-flow and retention docs; delete-run API | Not started |
| F2 | Contribution guide, security policy, changelog | Not started |
| F3 | Reproducible demo script (real Claude Code + scripted fallback, clearly labelled) | Not started |
| F5 | Marketing landing page in the Signature system ("Execution, made visible.") with a real recorded run | Not started |
| F4 | Performance measurements: ingest throughput, event-to-UI latency, large traces | Not started |

## Deferred (with reason)

| Item | Reason |
|---|---|
| Headless A/B runner (`runloop ab`) | Needs compare (C) first; costs real tokens per run |
| OTLP/HTTP ingest bridge | OTel GenAI conventions are still in development; build on demand |
| OpenAI Agents SDK / LangGraph adapters | Different user (agent builders); revisit when demand appears |
| Hosted sharing, teams, billing | No validated demand yet; see the monetisation hypothesis |
| Multi-agent simulation experiments | Keep simulation separate from captured traces; after compare |
