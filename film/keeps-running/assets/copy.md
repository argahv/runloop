# Runloop: the brand's own words

Collected by hand from `README.md`, `docs/product/world-vision.md`, `docs/design/design-system.md` and the
Studio's own UI strings (gather.mjs was not run: there is no public site and the Studio is being reworked).
Use these verbatim; anything not here is not the brand's copy.

## Titles

- **A world, not a dashboard.** (README, first line; also the world-vision title)
- **A world for AI agents.** (the founder brief's final title, 2026-10-18; not yet in the product docs)
- Creative direction (brief, internal): *A World That Keeps Running*

## The promise (README)

- Runloop is a small town that lives on your machine, and you step into it like a game.
- Simulated residents keep its streets busy; your real AI agents move in as buildings in the Agent District.
- When Claude Code works in a project you added, its building lights up, its robots go to work by kind of tool, a failing test shows as an incident, and every session can be replayed, traced and compared without leaving the town.
- 80 simulated residents with needs, schedules and friendships, 28 buildings, a day and night that follow the simulated clock.
- It is deterministic and persistent: it pauses while Runloop is off and says so when it resumes.
- Runloop records what Claude Code reports and never runs or approves anything by itself.

## The vision (world-vision.md)

- Runloop is a persistent, explorable world. Simulated residents and real AI agents coexist in it.
- Opening Runloop should feel like entering a world that existed before you arrived.
- When you connect a real agent, it should enrich that world, not replace it.
- Everything in the world can be inspected, controlled and reproduced.
- A building is a representation, a connection is a real integration.
- Pausing the world does not pause a real agent.
- Replay ≠ re-run ≠ fork. Replaying recorded external results treats them as inputs; nothing is re-executed.

## Truth labels and UI strings (Studio, design system)

- ◇ Simulated · Simulated resident · rule-based decision · No language model invents a reason.
- Real · Claude Code · observed · Agent · Claude Code
- Waiting for first event · The building stands unpainted until Claude Code really sends a hook.
- Live · working · Live · waiting · Needs approval · Incident · Idle · Offline
- Recorded (replay of persisted events; nothing is re-executed) · Traced · Claude Code · Inferred · Not reported
- Simulated time ×1. Real agents run at real speed.
- The town keeps living. (Esc menu) · When the session ends the agent reads offline; the town keeps living.
- Replay · recorded state · Pin as baseline · Compare · First divergence
- Hotbar: Explore · Agents · Add to World · Intelligence · Lab · Menu

## Places (worlds/runloop-commons)

Runloop Commons. Districts: Hearth Row, Agent District, Civic Atrium, Market Street, Research Park, Brookside.
Roads: Ridge Road, Eastway, Brook Road, Westway (the ring), Commons Avenue, Hearth Lane, Foundry Road, Market Street.
Landmarks: Commons Clock, Signal Board, Commons Fountain, First Commit (statue).
Inside an agent's headquarters: Atrium, Observatory, Workshop, Test Chamber, Launch Bay (and the Approval Gate).

## Words to avoid (truth rules)

- "AI residents", "agents living in the town": residents are simulated and rule-based; agents are real and are buildings.
- "runs 24/7", "while you sleep": the prototype pauses while Runloop is off and resumes.
- "re-run", "replays the agent": replay inspects recorded events.
- Any metric the session did not report (cost, the main agent's tokens): "not reported".
