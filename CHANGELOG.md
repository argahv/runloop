# Changelog

All notable changes to Runloop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Runloop has not had a release yet.

## [Unreleased]

### Added
- **The town (Runloop Commons), now the Studio's home (`/`).** A persistent, deterministic world beside the run log (DL-009, DL-010; plan `docs/architecture/world-simulation.md`).
  - **Simulation** (`packages/town`, `packages/sim`, pure): 80 residents with needs, schedules, traits and friendships deciding by integer scoring; 28 buildings with interiors and opening hours; 14 outdoor spots; one tick per sim minute at 0/1/4/16×. `applyEvent` is the only mutator, shared by the runtime, replay and the Studio; `explain` builds a resident's Why only from its recorded decision.
  - **World log** with a provenance on every event (`simulation`, `user`, `external-agent`, `system`, `inferred`), 15 event types, commands checked against `ALLOWED_SOURCES`; `WorldHost` commits before publishing, checkpoints, resumes after a restart (`world.resumed_after_offline`); migrations 3 and 4.
  - **API:** `/api/world` (info, town, snapshot, events, explain, SSE stream, commands); `RUNLOOP_WORLD=off` turns the town off.
  - **Studio:** a 3D town (merged static scene, instanced residents with a shader rig and level of detail, sky and lit windows from sim time (DL-011), cutaway interiors, labels), the clock and speed controls, a mode rail (Explore, Agents, Intelligence, Lab), context panels (resident with Why, building, place, district, agent), the World Log, an attention ticker, a map and a keyboard directory, ⌘K for residents and buildings, deep links (`?mode&focus&cam`) and redirects from old `/?run=` links. Automatic render quality (the new default) steps down when frames run slow.
- **Real agents in the town** (DL-012). **Add to World** gives a Claude Code agent a building in the Agent District for one project folder; sessions bind by dispatch id, then by folder, else wait in **Arrivals** to be claimed (claiming replays earlier runs). Health (`not_connected`, `awaiting_first_event`, `live`, `idle`, `offline`, `unknown`), attention, tool counts, subagents and incidents come only from the hooks, each citing its run events. The building's interior shows the session's robots. API: `/api/agents`, `/api/agents/arrivals`, `/api/agents/:id/claim`.
- **Assign task (dispatch).** Preview the exact `claude -p` command (preset, model, budget, timeout, environment variable names), approve it with a single-use nonce, follow its output, cancel it. `dontAsk` with an allowlist, haiku by default, a budget Claude Code enforces, its own process group, an audit log. `--plugin-dir` is added unless `claude plugin list` reports the tracer installed. `RUNLOOP_DISPATCH=off` turns it off; `RUNLOOP_DISPATCH_ENV` passes extra variable names.
- **Scripts:** `scripts/e2e-world.mjs` (the town renders, residents move, the clock advances, ⌘K opens a resident's Why with linked factors, Follow, the café interior); `scripts/perf-town.mjs` (render budgets under SwiftShader); `pnpm --filter @runloop-world/sim bench`. `pnpm screenshots` now captures the town, its panels, Add to World, an agent, its interior, Assign task and the World Log (`--suffix` for a second pass, e.g. at night).
- **Run compare (Experiments).** Pin a run as a baseline, run the agent again, compare.
  - **Experiments page** (`/experiments?a=&b=`): the baseline defaults to the newest pinned run and the candidate to the newest other run of the same task. Six summary tiles (outcome, tests passing, failures, duration, tool calls, tokens), the first divergence, outcome and tests (fixed, newly failing, still failing), files only in A, only in B or in both, tool activity by category, tokens and models per agent, and permissions and delegation. Test runs, failures, files, categories, usage reports and the divergence link to their events in Traces.
  - **Honesty rules:** a value a side did not report shows "not reported" and is never compared or shown as 0; executed-vs-traced pairs, runs still recording and token totals that cover different agents are flagged; a target or test name one side did not report is unknown, never a difference.
  - **Baselines:** `POST` / `DELETE /api/runs/:id/baseline` (JSON and Origin guards), stored in `runs.pinned_at` (migration 2), `RunSummary.pinnedAt`. A pin toggle with Undo on the run header and the Overview history; a baseline mark in the sidebar, the history and the run switcher; a "Compare" button on runs that have a baseline; command palette entries.
  - **Core:** `summarizeRun` and `diffRuns` in `packages/core/src/compare.ts`, pure and unit-tested.
- **`run.started.speed`** (optional, additive): the scripted demo's pacing, so compare does not call a run at speed 0 "faster" than one at speed 1.
- **`tool.call_started.target`** (optional, additive): the file of Read/Edit/Write/NotebookEdit, the directory of Grep/Glob, the first word of a shell command (never its arguments); the workspace path or program for the scripted demo's tools.
- **3D world richness pass (D10):** tighter framing (at 1440×900 the board spans 97% of the stage width and a robot projects to 44 px; at 1920×1080, 81–82%), chibi robots with a dark glass visor and state-coloured eyes, warm key and cool rim light, tinted rooms with shaded floors, paths that light up only while a robot walks them or a recorded message crosses them, and a light-theme "architectural model" look (DL-013).
- **Screenshots:** `scripts/screenshots.mjs` also captures Experiments (default pair, each run kind's pair and its lower half, an unknown run, offline) and a pinned baseline's Traces header. It pins a baseline for the capture only when none exists, and unpins it afterwards (`--no-pin` to skip).
- **Claude Code tracer.** The plugin is in `integrations/claude-code-plugin` and the marketplace manifest in `.claude-plugin/marketplace.json`.
  - Hooks are observe-only: async, with Stop, StopFailure and SessionEnd synchronous. They always exit 0 and print nothing.
  - Events are spooled locally before sending, and flushed by later hooks.
  - Client-side redaction, and a `--doctor` setup check.
- **Ingest.** `POST /api/ingest/claude-code`:
  - guards: per-user token file, no browser `Origin`, 1 MiB body limit, per-session rate limit;
  - dedupe by semantic keys;
  - a pure, late-tolerant mapper;
  - an idle sweep;
  - continuation segments after a restart.
- **Event model** (schema v1, additive):
  - traced runs (`mode`, `source`, an `external` adapter);
  - `provenance` (`reported` / `inferred`) on the envelope;
  - the `run.marker` and `agent.usage_reported` events;
  - tool `category`;
  - the `turn` and `delegated` task kinds;
  - the `unobserved` failure type.
- **World.** Tool categories choose stations. Environments are named Atrium, Observatory, Workshop, Test Chamber and Launch Bay. There are presets for Claude and up to 8 subagent robots.
- **Studio: the Runloop Signature design system.**
  - **Design:** dark and light tokens, self-hosted Geist fonts, a `src/ui/` component library and a command palette (⌘K / Ctrl-K).
  - **Pages:** Overview, Live World, Traces, Integrations and Settings, with deep links (`?run=&view=&event=&agent=`).
  - **Selection and search:** one selection shared by the world, timeline, inspector and URL; search and composable filters.
  - **Run views:** a run metrics panel; a 2D Network graph and an agents table.
  - **Traced runs:** traced badges, a provenance banner, inferred chips, and "not reported" values (never zero); live sessions open automatically.
- **3D world refresh:**
  - all colours from tokens, so the world follows the theme;
  - lime only for active execution;
  - fit to viewport, with camera presets (overview, focus, next error);
  - collision-free labels.
- **Tooling:**
  - `scripts/screenshots.mjs` (`pnpm screenshots`) captures every page and key state in both themes at 1280, 1440, 1920 and 390 px. It adds `playwright@1.56.1` as a root devDependency.
- **Docs:** `docs/architecture/overview.md`, `docs/architecture/event-model.md` and `docs/status/verification-report.md`.

### Changed
- **`/` is the town.** Overview, Live World, Traces, Experiments, Integrations and Settings stay; the mode rail replaces the run sidebar except on `/world` and `/traces`, and `/world?run=` shows "Agent District › {building} › Session #n" with **Back to town**. Old `/?run=` links redirect to `/world?run=`.
- The light-theme world decision is now numbered DL-013 (it was DL-009), so the plan of record's DL-009–012 stay valid.
- The tracer's `TraceSessionManager` takes an `onSessionSeen` hook and can close a session Runloop stopped (`closeStopped`, inferred); the recorder has `subscribeAll`.
- Write guards (JSON content type, allowed Origin) apply to `DELETE` as well as `POST`.
- Experiments is in the sidebar; the design system lists it as shipped.
- The Metrics panel shows an executed run's tool calls by category, from Runloop's own tools (the mapping compare uses), instead of "not categorised".
- The runtime's default port moved from 4317 to **4380**, because 4317 is the OTLP/gRPC port (DL-005). The Studio and the plugin default to 4380.
- Boot recovery is mode-aware. Traced runs close open calls as `unobserved` (inferred) rather than `runtime_restarted`.
- Control routes (`stop`, `pause`, `resume`) answer 409 for traced runs.
- Studio URLs end in a slash (`/overview/`), so the static export works on plain static servers.

### Fixed
- **World integration (2026-10-18):** the runtime now wires the agent layer and dispatch (they existed but were not mounted, so `/api/agents` answered 404); a cancelled or timed-out dispatch closes its traced run as interrupted (inferred) instead of reading live for 5 minutes; a dispatched session in a workspace that was traced with `--plugin-dir` is traced again (the plugin is passed unless `claude plugin list` reports it installed); keys typed right after ⌘K reach the palette instead of page shortcuts (focus no longer waits for an animation frame); a deep-linked `?focus=resident:` frames the resident once its position exists; at phone width the compact "Add" button is named "Add to World" for assistive technology; inside an agent's building the interior follows a session that starts while you watch; a grouped dispatch item in the feed shows the provenance of its latest event (the system finishing it, not you approving it).
- `--doctor` now finds the plugin data dirs Claude Code actually uses (`runloop-tracer-inline` for `--plugin-dir`, and any other `runloop-tracer*` directory) when run from a shell.
- The Studio no longer shows "Runtime offline" after a single slow health check. It needs two consecutive failures once it has been online.
- In the 3D world, a selected incident label is no longer covered by the selected agent's label. A second required label shrinks before it may overlap.
- **Tracer delivery:** the hook sends the spool oldest first in size-bounded batches, its own event last, and stops at its time budget; a rejected batch is split so one bad envelope cannot block the rest. If the spool cannot be written, the event is sent directly.
- **Redaction:** more token shapes, credential headers and `key=value` pairs, URL passwords and shell password flags are masked, and each secret's literal value is masked wherever else it appears. Long strings are redacted before they are capped. Shell commands are stored as `sensitive`.
- **Tracer state:** the idle sweep measures silence by arrival time; a result arriving after its call was closed by a sweep is still recorded; permissions are closed as denied (inferred) at `PostToolBatch` or the agent's next batch rather than the next tool call; a late `PermissionRequest` after the result records the approval; subagents are linked to the delegating call by description and type (inferred), with a "Delegation corrected" marker if the guess was wrong. The ingest token file is checked for 0600.
- **Layer 1 performance:** the reducer folds batches in place (`transient`), tool calls live in a bucketed `IdMap`, and closing a call no longer scans every call; replay builds snapshots in linear time.
- **Incidents:** a traced failure is no longer resolved by the end of a turn. It resolves on a later successful test run or the same tool call succeeding again, labelled "Resolved (inferred)".
- **Studio replay:** stepping, seeking and deep links move by event, not by time, so events in the same millisecond can each be selected; `at=` keeps a paused playhead in the link. Late live events no longer move a paused replay. Refresh keeps the selected agent card.
- **Studio lists:** the timeline and logs are virtualised above 150 rows and are one Tab stop (arrow keys move between rows). A selected event hidden by a filter shows a "Show it" hint. Chips on a selected row keep AA contrast; tab focus rings are no longer clipped; the smallest text is 12 px.
- **Studio status:** an unfinished (interrupted) subagent shows "unfinished", not "working"; the inspector names the agent of the selected event; "Paused" is an info state; a finished run settles on its end without a spurious replay.
- **Network graph:** at narrow widths the graph uses smaller cards or a top-down layout instead of scaling the text down; a wrapped layer's sub-columns leave room for message labels.
- **Logs:** the agent column lines up on rows with and without chips.
