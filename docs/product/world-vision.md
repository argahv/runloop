# Runloop: a world, not a dashboard

> Status: **committed product direction** (founder brief, 2026-10-18). It supersedes the "flight recorder first" framing in `strategy.md`. Tracing, replay and compare become supporting capabilities inside the world. Decisions are recorded in `docs/status/decision-log.md` (DL-009).

## Thesis

Runloop is a persistent, explorable world. Simulated residents and real AI agents coexist in it.
- The world has its own population, buildings, organisations, time and history, and it keeps living when no agent is connected.
- Connecting a real agent introduces a **new resident with a home in the world**. It does not attach a data source to a dashboard.
- Users can explore the world, understand it, change it, run experiments in it, and give real agents work.

**North star.** Opening Runloop should feel like entering a world that existed before you arrived. When you connect a real agent, it should enrich that world, not replace it. Everything in the world can be inspected, controlled and reproduced.

**Two acceptance questions:**
1. If every external agent is disconnected, does Runloop still have a functioning, populated world with ongoing activity?
2. When a real agent connects, does it become a participant in a world that already has its own life?

## Product identity (initial promise)

From the brief's three identities:
- **B, a spatial operating system for AI agents**, is the initial promise: operate, coordinate and understand real agents.
- **A, a living society**, is what makes it unique.
- **C, a simulation lab**, grows once the world and the integrations are solid.

This is a hypothesis to validate with users.

## Founder decisions (defaults taken from the brief's recommendations; reversible)

| Question | Default |
|---|---|
| First primary user | Developers operating real AI agents (Claude Code first) |
| Main reason to open Runloop | Operate and understand their agents' work inside a living world |
| A real agent disconnects | The world continues; only work that depends on that agent waits, and it is reconciled on reconnect |
| External work | Observe first, then submit tasks through supported integrations. For Claude Code that means a headless run in the agent's workspace, only with explicit user approval. No hosted runtimes for now. |
| First thing a new user sees | A populated world ready to explore, with "Add to World" one click away |

## Four inseparable parts

1. **The world:** districts, roads, buildings with interiors, places where things happen.
2. **The society:** residents with identity, role, needs, schedule, goals, memory, relationships and coherent behaviour.
3. **The integration layer:** real agents enter through buildings, organisations, workspaces and explicit capabilities (observe, inspect, submit task, message, cancel, control).
4. **The lab:** pause and resume, time speed, replay recorded history, fork from a checkpoint, compare outcomes.

## Non-negotiable truth rules

- **The simulation engine owns world truth.** AI models and integrations propose; validated commands change state.
- **Everything carries provenance:** `simulation` · `user` · `external-agent` (observed or executed) · `system` · `inferred`.
  - A simulated meeting never looks like a real one.
  - A resident's explanation is never presented as a real agent's hidden reasoning.
- **A building is a representation, a connection is a real integration**, and work happens wherever the agent actually runs. A building can exist while its agent is offline, unknown or awaiting approval, and the world shows that honestly.
- **Pausing the world does not pause a real agent.** Simulation speed never speeds up real execution.
- **Replay ≠ re-run ≠ fork:**
  - Replaying recorded external results treats them as inputs; nothing is re-executed.
  - Forks apply only to simulated state, never to external side effects.
- **Spatial proximity is not authorisation.** A resident entering an agent's building gains no access to its repository or history.

## Data model separation

| Concept | Meaning |
|---|---|
| **Agent identity** | Which logical agent this is |
| **Connection** | How Runloop talks to it, and its health |
| **Workspace** | The context it works in (a repo) |
| **Building** | Its place and presence in the world |
| **Organisation** | Projects, policies, shared resources |
| **Session** | One period of real execution (today's "run") |
| **Persona** | Optional fictional traits for its in-world representation |

## Layered behaviour

1. **Deterministic simulation:** movement, schedules, needs, state transitions, seeded randomness.
2. **Utility and goal-based decisions:** residents score options and pursue goals.
3. **Selective LLM reasoning:** later, budgeted, rare, and always validated by the engine.
4. **External agent execution:** real work through adapters and permissions.

## Experience architecture

- **Places, not pages.** The world is the home screen. Areas are modes and contextual layers over one persistent world:
  - **Explore:** the default.
  - **Build:** World Foundry.
  - **Agents:** the Agent District, plus "Add to World".
  - **Society:** organisations and relationships.
  - **Intelligence:** traces, events, explanations.
  - **Lab:** forks, experiments, compare.
- **Navigation:** spatial camera, world map and fast travel, command palette (⌘K), contextual transitions. Spatial navigation is never the only route.
- **You stay in the world (DL-014, 2026-10-18).** `/` is a game, not a web app: the town fills the screen and the land runs on to the horizon; a free camera (pan, zoom to the cursor, turn, tilt, follow, fly into a building); a HUD floats over it (clock, minimap, hotbar, cards anchored to what they describe, notifications, an Esc menu). Every page and action happens in place:
  - **Explore:** the town; click anyone or anything for its card.
  - **Agents:** the Agent District and its card; **Add to World** picks a lot in 3D and the building stands unpainted until the first real event; **Assign task** opens from the agent's card with the exact command, and a person approves it on the runtime's own page.
  - **Intelligence:** the World Log at the Commons Library, and any run's full trace in a sheet beside the live town.
  - **Lab:** compare at the Lattice Lab, in a sheet.
  - **An agent's building:** its run diorama and a session strip; scrubbing replays the recorded state inside.
  - **Settings, sound, controls, connections:** the Esc menu.

  The pages (Traces, Experiments, Live World, Overview, Integrations, Settings) stay as full pages for old links and long reading, each with "Open in the world".
- **Ambient decorative life** (cars, birds, clouds, a windmill) makes the place feel lived in and is labelled as decoration: never pickable or listed, never near an agent's building, still when the world is paused. Only the simulation's residents are "the society", and only agents are real.
- **Sound** follows the same truth rule as motion: a calm bed that follows the camera and the time of day, and event cues only for real agent events.
- **Three levels of interaction:**
  1. **World view:** explore.
  2. **Entity view:** a resident, building or agent.
  3. **Inspector:** exact state, events, causality, permissions.
- **Motion:**
  - ambient life (quiet), meaningful events, user-directed transitions;
  - quick navigation by default; cinematic only when earned;
  - always interruptible and skippable; reduced motion keeps all information.
- **Accessibility:** a structured entity list or tree, searchable events, keyboard operation, and panels for everything essential.
- **Performance:**
  - the simulation is decoupled from rendering;
  - level of detail, instancing, progressive loading, adaptive quality;
  - targets: 60 fps preferred, 30 fps minimum, measured on real hardware.

## Milestones (each with an executable acceptance test)

| # | Milestone | Acceptance |
|---|---|---|
| W1 | **A world that exists:** a persistent town, buildings, navigation, world clock, camera | Close and reopen; the same world, buildings and identities return |
| W2 | **A population that lives:** resident identity, schedules, needs, goals, movement, work and rest, simple interactions | Residents act without clicks, visit valid destinations, react to change; every transition can be inspected and explained from recorded state |
| W3 | **Functional buildings and organisations:** rooms, occupancy, capabilities, teams, tasks | Assign a resident to an organisation with a task; the resident performs valid work in its workspace |
| W4 | **A real agent joins:** "Add to World", connection, capabilities, workspace, building, real events, task dispatch with approval, disconnect and recovery | A real Claude Code agent's confirmed activity shows up in its building; simulated activity cannot be mistaken for real; the world keeps living while the agent is offline |
| W5 | **The world becomes a lab:** checkpoints, event history, replay, forks, compare | Fork, change a parameter, run both, compare; the original world is untouched |
| W6 | **Emergent behaviour and scale:** selective LLM residents, memory, richer social dynamics, more adapters | Richer behaviour emerges while cost and outcomes stay measurable |

## Deliberately postponed

Full economies, unbounded LLM conversations between residents, thousands of reasoning residents, universal adapters, multi-user real-time editing, simulated construction labour, a visual scripting language, marketplaces.

## How existing work maps

| Existing | Becomes |
|---|---|
| Event log, recorder, SSE, replay | The execution history of agent **sessions**, and the basis of the world event log |
| Claude Code tracer plugin | The first **connection** adapter (observe); headless launch adds **submit task** |
| Compare (Milestone C) | A **Lab** capability: compare sessions now, forks later |
| Studio shell and Signature design system | The contextual UI over the world (panels, inspector, palette, Intelligence) |
| Research-campus diorama | Becomes the interior of an agent building ("Engineering House"), inside a larger town |

## Strategic risk (recorded honestly)

Earlier research found spatial agent views and telemetry capture easy to copy, and retention driven by novelty is the main risk. The founder chose world-first. The mitigation is to keep the utility layers first-class inside the world:
- Intelligence (why did this fail?);
- Lab (did this change help?);
- real task dispatch.

Also measure whether users return and whether they act through the world.
