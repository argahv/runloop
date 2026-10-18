# Runloop Signature: design system v1

> Status: **committed direction** (founder brief, 2026-10-17). This spec is the source of truth for Studio, the 3D world and future marketing pages. Tokens live in `apps/studio/src/app/tokens.css`; components in `apps/studio/src/ui/`.

## Identity

A cinematic command centre for AI agents. Real execution becomes a living world, and every action stays precise and inspectable.

- **Mood:** cinematic, sophisticated, tactile, quietly futuristic.
- **Personality:** ambitious but not flashy; technical without feeling sterile.
- **Rule zero:** every animation communicates a real event, a state transition, or a clearly labelled simulation. No decorative particles or glow for its own sake.

## Colour tokens

### Dark theme (signature)

| Token | Value | Use |
|---|---|---|
| `--rl-obsidian` | `#101114` | App canvas |
| `--rl-graphite` | `#1B1D22` | Surfaces (panels, cards) |
| `--rl-slate` | `#292C33` | Elevated panels, hover, inputs |
| `--rl-line` | `rgba(232,235,240,0.08)` | Hairline dividers; prefer tonal contrast over outlines |
| `--rl-lime` | `#B8F36A` | **Primary accent.** Primary actions, the selected state, active execution. Use sparingly. |
| `--rl-ice` | `#E8EBF0` | Primary text |
| `--rl-muted` | `#9297A2` | Secondary text |
| `--rl-success` | `#48C78E` | Verified success only |
| `--rl-warning` | `#F5B84B` | Attention, waiting, blocked |
| `--rl-failure` | `#FF6B76` | Errors and failures |

### Light theme (trace-heavy work and reports)

Same semantic roles, re-derived for a light canvas. All text and icon pairs must reach WCAG AA (4.5:1 for body text, 3:1 for large text and UI glyphs). The lime accent darkens to a legible olive for text (around `#4F7A12`) and keeps `#B8F36A` only as a fill behind dark text.

### Agent identity hues

Characters, timeline actor dots and graph nodes use an 8-hue identity palette tuned for both themes.
- These hues must be distinguishable from the semantic colours. Identity colours never signal state.
- State is always icon plus text plus semantic colour.
- Lime is reserved; it is never an identity hue.

## Typography

| Role | Font | Size | Notes |
|---|---|---|---|
| Display | Geist | 36–56 px | Tight tracking (-0.02em); landing and empty states only |
| Heading | Geist | 20–28 px | Medium to semibold |
| Body | Geist | 14–16 px | Line height 1.5 |
| UI small | Geist | 12–13 px | Labels, chips |
| Mono | Geist Mono | 12–14 px | Event types, ids, paths, commands, code |

- **Tabular numerals** (`font-variant-numeric: tabular-nums`) for every cost, duration, token count, timestamp and sequence number.
- Fonts are self-hosted through the `geist` package (SIL Open Font License), with no network font fetches, because Runloop is local-first.

## Shape and spacing

| Token | Value |
|---|---|
| Radius: controls | 6–8 px |
| Radius: cards | 10–12 px |
| Radius: hero panels | 16–20 px |
| Spacing unit | 4 px; compact gap 8, standard gap 16, section gap 24–32, page padding 24–32 |

**Surfaces:**
- Use layered tonal surfaces (obsidian → graphite → slate) rather than outlines.
- Glass and blur are reserved for floating controls over the 3D world (camera toolbar, playback overlay, toasts).
- The engineering interface stays crisp and opaque.

## Motion tokens

| Token | Value | Use |
|---|---|---|
| `--rl-dur-instant` | 120 ms | Hover, focus |
| `--rl-dur-standard` | 200 ms | Menus, panels, tabs |
| `--rl-dur-emphasis` | 320 ms | Selection, view transitions |
| Camera move | 400–700 ms | Focusing a world entity |
| `--rl-ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Interface entrances |
| Reduced motion | ~0 ms | All of the above; nothing that carries information is lost |

### World motion
- Agents move only when a real task transition occurs.
- Idle characters stay restrained.
- Handoffs animate along real relationships (delegation, messages).

### Data motion
- Events arrive as restrained pulses.
- A failure is a clear state change with a path to investigation (incident marker → event), not an explosion.

### Interface motion
- The inspector slides in subtly.
- Selection preserves context.
- Scrubbing updates the world, timeline and inspector together.

### Replay invariants
- A paused replay shows exactly the recorded state at the playhead.
- Late live events never rewrite history that is already displayed.

## Information architecture

| Area | Primary job | Status |
|---|---|---|
| **Overview** | Runtime health, live sessions, recent runs, quick start | v1 |
| **Live World** | Watch and explore execution: 3D world, agent graph, timeline | v1 |
| **Traces** | Investigate one run: timeline, logs, inspector, search and filter | v1 |
| **Experiments** | Compare runs and baselines: pin a baseline, pick a candidate, see what differed with links to the events behind it | v1 (Milestone C, 2026-10-18) |
| **Evaluations** | Failure → test case; regression suites | Later (hidden until it works) |
| **Integrations** | Connect Claude Code (plugin status, install command, what is collected), the scripted demo | v1 |
| **Settings** | Theme, motion, render quality, runtime URL, privacy and retention | v1 |

**Navigation rules:**
- **Do not show placeholder sections.** An area appears in the sidebar only when it works.
- The **world, timeline and inspector are synchronised views** of one selection state (stable ids for runs, events, agents and stations). Selecting a tool call in the timeline focuses its agent or station in the world and opens the exact event in the inspector, and the other way round.
- **Deep links:** `?run=<id>&view=world|graph|trace&event=<seq>&agent=<id>`. Experiments: `/experiments?a=<baseline run>&b=<candidate run>`.

## The 3D world

The world is made of named environments that share one event model:

| Environment | Zone today | Work it hosts |
|---|---|---|
| **Atrium** | Hub | Overview of the running system; agents' home |
| **Observatory** | Research | Reading, searching, web retrieval |
| **Workshop** | Build | Editing, writing, executing commands |
| **Test Chamber** | Test | Test runs, evaluation, failure analysis |
| **Launch Bay** | Deploy | Deploy, publish, MCP and external actions |
| **Network** | *(2D agent-graph view)* | Delegation, messages, dependencies between agents |

**Rules:**
- An agent's visual identity is stable across the world, graph and timeline.
- Silhouettes or equipment never suggest capabilities the source data cannot establish.
- The world supports focusing an agent or task, following execution, jumping to the next error, freezing at an exact recorded event, inspecting a handoff, switching to the 2D agent graph or table, and lowering detail for performance.
- **With the world disabled, the product still works completely.**
- **Palette:** obsidian and graphite architecture. Zone floors are desaturated tints. Lime marks only the active execution (working agent, running station). Semantic colours mark outcomes. Emissive glow is limited to state-carrying elements.

## Components (`apps/studio/src/ui/`)

| Group | Components |
|---|---|
| Layout and navigation | Sidebar, breadcrumbs, command palette (⌘K / Ctrl-K), tabs, split panels, resizable inspector |
| Execution | Agent card, event row, trace timeline, tool inspector, delegation graph, playback controls |
| Feedback | Connection status, loading skeleton, empty state, error recovery, confirmation dialog, toast |

**Non-negotiable behaviour:**
- Every meaningful action gives visible feedback and has a recovery path.
- Search, filter and selection work by keyboard and pointer.
- Destructive actions need a confirmation that explains their impact.
- Empty states teach the next useful step.
- Errors say what failed, whether data was saved, and how to retry.
- Status is never shown by colour alone.
- Every 3D interaction has a 2D route.
- Reduced motion keeps all information.
- Mobile shows traces, summaries and inspectors, never a desktop-sized 3D scene.
- The system always says whether it is **connecting, live, paused, disconnected, replaying, or showing synthetic data.**

## Provenance labelling (trust)

| Label | Meaning |
|---|---|
| **Live** | Events are arriving now from a connected source |
| **Recorded** | Replay of persisted events; nothing is re-executed |
| **Traced · <source>** | Runloop recorded what the source reported; it did not execute or verify it |
| **Executed** | Runloop's runtime ran the tools itself (scripted demo) |
| **Inferred** | Reconstructed by Runloop (e.g. a denied permission); shown with a chip |
| **Synthetic** | Example or fixture data, never mixed with real runs |
| **Not reported** | The source does not expose this value; never shown as zero |

## Verification

- Visual regression screenshots of every page and key state, in both themes, at 1280, 1440 and 1920 px wide plus one mobile width.
- Contrast checked against WCAG AA.
- Reduced-motion run of the main journey.
- Keyboard-only run of the main journey.
