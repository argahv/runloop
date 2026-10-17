# Changelog

All notable changes to Runloop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Runloop has not had a release yet.

## [Unreleased]

### Added
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
- The runtime's default port moved from 4317 to **4380**, because 4317 is the OTLP/gRPC port (DL-005). The Studio and the plugin default to 4380.
- Boot recovery is mode-aware. Traced runs close open calls as `unobserved` (inferred) rather than `runtime_restarted`.
- Control routes (`stop`, `pause`, `resume`) answer 409 for traced runs.
- Studio URLs end in a slash (`/overview/`), so the static export works on plain static servers.

### Fixed
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
